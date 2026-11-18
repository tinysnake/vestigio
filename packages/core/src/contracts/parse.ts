import type {
  BudgetUsed,
  Freshness,
  FreshnessBrief,
  HotspotMembership,
  InjectionReceipt,
  MediumSummary,
  Memory,
  MemoryCard,
  MemoryState,
  NavSummary,
  NavigationStatus,
  PersistenceStatus,
  ProjectActivity,
  RetrievalResult,
  RetrievalStatus,
  Scope,
  SourceRef,
  StaleEventSummary,
  StaleProducer,
  UsageChannel,
  UsageEvent,
  UsageEventKind,
} from "./types.js";
import {
  codePointCount,
  fail,
  nonWhitespaceCodePointCount,
  parseMemoryId,
  parseMemoryUri,
  parseRevision,
  parseStoreId,
  parseTimestamp,
  readArray,
  readField,
  readInteger,
  readNonEmptyString,
  readNullable,
  readNullableString,
  readNumber,
  readNumberOrNull,
  readRecord,
  readString,
  readUnion,
  splitMemoryUri,
} from "./primitives.js";
import { usageEventId } from "./usage-event-id.js";

export const MEDIUM_BODY_MIN = 500;
export const MEDIUM_BODY_MAX = 1000;
export const NAV_TEXT_MAX = 200;

export const MEMORY_STATES = ["medium_ready", "published", "archived"] as const;
export const USAGE_EVENT_KINDS = ["hit", "access"] as const;
export const USAGE_CHANNELS = ["hotspot", "search", "read"] as const;
export const RETRIEVAL_STATUSES = ["resolved", "partial", "conflicted", "not_found"] as const;
export const PERSISTENCE_STATUSES = [
  "saved",
  "failed",
  "not_attempted",
  "insufficient_evidence",
  "budget_exhausted",
] as const;
export const NAVIGATION_STATUSES = ["pending", "ready", "failed"] as const;
export const STALE_PRODUCERS = ["agent", "detector"] as const;

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(path, "invalid_type", "expected a boolean");
  }
  return value;
}

function readOptionalField<T>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  parse: (value: unknown, path: string) => T,
): T | undefined {
  if (!Object.hasOwn(record, key) || record[key] === undefined) {
    return undefined;
  }
  return parse(record[key], `${path}.${key}`);
}

function withOptional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function parseBooleanField(record: Record<string, unknown>, key: string, path: string): boolean {
  return readBoolean(readField(record, key, path), `${path}.${key}`);
}

export function parseMemoryState(value: unknown, path = "$"): MemoryState {
  return readUnion(value, path, MEMORY_STATES);
}

export function parseUsageEventKind(value: unknown, path = "$"): UsageEventKind {
  return readUnion(value, path, USAGE_EVENT_KINDS);
}

export function parseUsageChannel(value: unknown, path = "$"): UsageChannel {
  return readUnion(value, path, USAGE_CHANNELS);
}

export function parseRetrievalStatus(value: unknown, path = "$"): RetrievalStatus {
  return readUnion(value, path, RETRIEVAL_STATUSES);
}

export function parsePersistenceStatus(value: unknown, path = "$"): PersistenceStatus {
  return readUnion(value, path, PERSISTENCE_STATUSES);
}

export function parseNavigationStatus(value: unknown, path = "$"): NavigationStatus {
  return readUnion(value, path, NAVIGATION_STATUSES);
}

export function parseScope(value: unknown, path = "$"): Scope {
  const record = readRecord(value, path);
  const kind = readUnion(readField(record, "kind", path), `${path}.kind`, ["project", "global"] as const);
  if (kind === "global") {
    return { kind: "global" };
  }
  const project_id = readNonEmptyString(readField(record, "project_id", path), `${path}.project_id`);
  return { kind: "project", project_id };
}

export function parseSourceRef(value: unknown, path = "$"): SourceRef {
  const record = readRecord(value, path);
  const message_id = readNonEmptyString(readField(record, "message_id", path), `${path}.message_id`);
  const parent_message_id = readNullableString(
    readField(record, "parent_message_id", path),
    `${path}.parent_message_id`,
  );
  if (parent_message_id !== null && parent_message_id === message_id) {
    fail(
      `${path}.parent_message_id`,
      "invariant_violation",
      "parent_message_id is the causal parent and can never be the message itself",
    );
  }
  return {
    provider: readNonEmptyString(readField(record, "provider", path), `${path}.provider`),
    source_instance: readNonEmptyString(
      readField(record, "source_instance", path),
      `${path}.source_instance`,
    ),
    session_id: readNonEmptyString(readField(record, "session_id", path), `${path}.session_id`),
    message_id,
    parent_message_id,
    project_id: readNonEmptyString(readField(record, "project_id", path), `${path}.project_id`),
    timestamp: parseTimestamp(readField(record, "timestamp", path), `${path}.timestamp`),
    content_hash: readNonEmptyString(readField(record, "content_hash", path), `${path}.content_hash`),
    locator: readNullableString(readField(record, "locator", path), `${path}.locator`),
  };
}

export function parseMediumSummary(value: unknown, path = "$"): MediumSummary {
  const record = readRecord(value, path);
  const body = readString(readField(record, "body", path), `${path}.body`);
  const measured = nonWhitespaceCodePointCount(body);
  if (measured < MEDIUM_BODY_MIN || measured > MEDIUM_BODY_MAX) {
    fail(
      `${path}.body`,
      "out_of_range",
      `medium body must be ${MEDIUM_BODY_MIN}-${MEDIUM_BODY_MAX} non-whitespace Unicode code points; got ${measured}`,
    );
  }
  const body_char_count = readInteger(
    readField(record, "body_char_count", path),
    `${path}.body_char_count`,
    0,
  );
  if (body_char_count !== measured) {
    fail(
      `${path}.body_char_count`,
      "invariant_violation",
      `body_char_count must equal the non-whitespace code point count ${measured}; got ${body_char_count}`,
    );
  }
  const sources = readArray(readField(record, "sources", path), `${path}.sources`).map(
    (source, index) => parseSourceRef(source, `${path}.sources[${index}]`),
  );
  return { body, body_char_count, sources };
}

export function parseNavSummary(value: unknown, path = "$"): NavSummary {
  const record = readRecord(value, path);
  const text = readString(readField(record, "text", path), `${path}.text`);
  const measured = codePointCount(text);
  if (measured < 1 || measured > NAV_TEXT_MAX) {
    fail(
      `${path}.text`,
      "out_of_range",
      `nav text must be 1-${NAV_TEXT_MAX} Unicode code points, punctuation and spaces included; got ${measured}`,
    );
  }
  const char_count = readInteger(readField(record, "char_count", path), `${path}.char_count`, 0);
  if (char_count !== measured) {
    fail(
      `${path}.char_count`,
      "invariant_violation",
      `char_count must equal the code point count ${measured}; got ${char_count}`,
    );
  }
  const source_revision = parseRevision(
    readField(record, "source_revision", path),
    `${path}.source_revision`,
  );
  return { text, char_count, source_revision };
}

export function parseMemory(value: unknown, path = "$"): Memory {
  const record = readRecord(value, path);
  const memory_id = parseMemoryId(readField(record, "memory_id", path), `${path}.memory_id`);
  const uri = parseMemoryUri(readField(record, "uri", path), `${path}.uri`);
  if (splitMemoryUri(uri, `${path}.uri`).memoryId !== memory_id) {
    fail(`${path}.uri`, "invariant_violation", "the memory id in the URI must equal memory_id");
  }
  const scope = parseScope(readField(record, "scope", path), `${path}.scope`);
  const title = readNonEmptyString(readField(record, "title", path), `${path}.title`);
  const keywords = readArray(readField(record, "keywords", path), `${path}.keywords`).map(
    (keyword, index) => readNonEmptyString(keyword, `${path}.keywords[${index}]`),
  );
  const revision = parseRevision(readField(record, "revision", path), `${path}.revision`);
  const state = parseMemoryState(readField(record, "state", path), `${path}.state`);
  const medium = parseMediumSummary(readField(record, "medium", path), `${path}.medium`);
  const nav = readNullable(readField(record, "nav", path), `${path}.nav`, parseNavSummary);
  if (nav !== null && nav.source_revision !== revision) {
    fail(
      `${path}.nav.source_revision`,
      "invariant_violation",
      `nav.source_revision ${nav.source_revision} must equal the memory revision ${revision}`,
    );
  }
  if (state === "medium_ready" && nav !== null) {
    fail(`${path}.nav`, "invariant_violation", "a medium_ready memory has no navigation summary yet");
  }
  if (state === "published" && nav === null) {
    fail(`${path}.nav`, "invariant_violation", "a published memory must carry a navigation summary");
  }
  const hit_count = readInteger(readField(record, "hit_count", path), `${path}.hit_count`, 0);
  const access_count = readInteger(readField(record, "access_count", path), `${path}.access_count`, 0);
  const last_access_at = readNullable(
    readField(record, "last_access_at", path),
    `${path}.last_access_at`,
    parseTimestamp,
  );
  const created_at = parseTimestamp(readField(record, "created_at", path), `${path}.created_at`);
  const updated_at = parseTimestamp(readField(record, "updated_at", path), `${path}.updated_at`);
  if (Date.parse(updated_at) < Date.parse(created_at)) {
    fail(`${path}.updated_at`, "invariant_violation", "updated_at must not precede created_at");
  }
  return {
    memory_id,
    uri,
    scope,
    title,
    keywords,
    revision,
    state,
    medium,
    nav,
    hit_count,
    access_count,
    last_access_at,
    created_at,
    updated_at,
  };
}

export function parseUsageEvent(value: unknown, path = "$"): UsageEvent {
  const record = readRecord(value, path);
  const memory_id = parseMemoryId(readField(record, "memory_id", path), `${path}.memory_id`);
  const revision = parseRevision(readField(record, "revision", path), `${path}.revision`);
  const kind = parseUsageEventKind(readField(record, "kind", path), `${path}.kind`);
  const channel = parseUsageChannel(readField(record, "channel", path), `${path}.channel`);
  const session_id = readNonEmptyString(readField(record, "session_id", path), `${path}.session_id`);
  const input_id = readNonEmptyString(readField(record, "input_id", path), `${path}.input_id`);
  const at = parseTimestamp(readField(record, "at", path), `${path}.at`);
  const dedup_key = readNonEmptyString(readField(record, "dedup_key", path), `${path}.dedup_key`);
  const event_id = readNonEmptyString(readField(record, "event_id", path), `${path}.event_id`);
  const expected = usageEventId({ memory_id, revision, kind, channel, session_id, input_id, at, dedup_key });
  if (event_id !== expected) {
    fail(
      `${path}.event_id`,
      "invariant_violation",
      `event_id must be deterministic from the event fields; expected ${expected}`,
    );
  }
  return { event_id, memory_id, revision, kind, channel, session_id, input_id, at, dedup_key };
}

export function parseInjectionReceipt(value: unknown, path = "$"): InjectionReceipt {
  const record = readRecord(value, path);
  return {
    store_id: parseStoreId(readField(record, "store_id", path), `${path}.store_id`),
    session_id: readNonEmptyString(readField(record, "session_id", path), `${path}.session_id`),
    branch_ref: readNonEmptyString(readField(record, "branch_ref", path), `${path}.branch_ref`),
    input_id: readNonEmptyString(readField(record, "input_id", path), `${path}.input_id`),
    memory_id: parseMemoryId(readField(record, "memory_id", path), `${path}.memory_id`),
    revision: parseRevision(readField(record, "revision", path), `${path}.revision`),
    committed_at: parseTimestamp(readField(record, "committed_at", path), `${path}.committed_at`),
  };
}

export function parseProjectActivity(value: unknown, path = "$"): ProjectActivity {
  const record = readRecord(value, path);
  return {
    project_id: readNonEmptyString(readField(record, "project_id", path), `${path}.project_id`),
    activity_seq: readInteger(readField(record, "activity_seq", path), `${path}.activity_seq`, 0),
    last_input_at: parseTimestamp(readField(record, "last_input_at", path), `${path}.last_input_at`),
  };
}

export function parseHotspotMembership(value: unknown, path = "$"): HotspotMembership {
  const record = readRecord(value, path);
  return {
    project_id: readNonEmptyString(readField(record, "project_id", path), `${path}.project_id`),
    memory_id: parseMemoryId(readField(record, "memory_id", path), `${path}.memory_id`),
    admitted_seq: readInteger(readField(record, "admitted_seq", path), `${path}.admitted_seq`, 0),
    last_hit_seq: readInteger(readField(record, "last_hit_seq", path), `${path}.last_hit_seq`, 0),
    last_access_seq: readInteger(readField(record, "last_access_seq", path), `${path}.last_access_seq`, 0),
    recent_hit_weight: readNumber(
      readField(record, "recent_hit_weight", path),
      `${path}.recent_hit_weight`,
      0,
    ),
    recent_access_weight: readNumber(
      readField(record, "recent_access_weight", path),
      `${path}.recent_access_weight`,
      0,
    ),
  };
}

export function parseStaleProducer(value: unknown, path = "$"): StaleProducer {
  return readUnion(value, path, STALE_PRODUCERS);
}

export function parseFreshnessBrief(value: unknown, path = "$"): FreshnessBrief {
  const record = readRecord(value, path);
  const pending_count = readInteger(
    readField(record, "pending_count", path),
    `${path}.pending_count`,
    0,
  );
  const freshness_sig = readString(readField(record, "freshness_sig", path), `${path}.freshness_sig`);
  const is_stale = parseBooleanField(record, "is_stale", path);
  if (is_stale !== pending_count > 0) {
    fail(`${path}.is_stale`, "invariant_violation", "is_stale must match pending_count > 0");
  }
  if (freshness_sig.length === 0 && pending_count > 0) {
    fail(
      `${path}.freshness_sig`,
      "invariant_violation",
      "pending events require a freshness fingerprint",
    );
  }
  return {
    is_stale,
    head_revision: parseRevision(readField(record, "head_revision", path), `${path}.head_revision`),
    pending_count,
    freshness_sig,
  };
}

export function parseStaleEventSummary(value: unknown, path = "$"): StaleEventSummary {
  const record = readRecord(value, path);
  const excerpt = readString(readField(record, "excerpt", path), `${path}.excerpt`);
  const excerpt_char_count = readInteger(
    readField(record, "excerpt_char_count", path),
    `${path}.excerpt_char_count`,
    0,
  );
  if (codePointCount(excerpt) !== excerpt_char_count) {
    fail(
      `${path}.excerpt_char_count`,
      "invariant_violation",
      "excerpt_char_count must be the excerpt's code point count",
    );
  }
  const sources = readArray(readField(record, "sources", path), `${path}.sources`).map((source, index) =>
    parseSourceRef(source, `${path}.sources[${index}]`),
  );
  const source_count = readInteger(readField(record, "source_count", path), `${path}.source_count`, 0);
  if (source_count < sources.length) {
    fail(`${path}.source_count`, "invariant_violation", "source_count cannot be below the listed count");
  }
  const sources_truncated = parseBooleanField(record, "sources_truncated", path);
  if (sources_truncated !== source_count > sources.length) {
    fail(
      `${path}.sources_truncated`,
      "invariant_violation",
      "sources_truncated must match whether sources were cut",
    );
  }
  return {
    event_id: readNonEmptyString(readField(record, "event_id", path), `${path}.event_id`),
    memory_id: parseMemoryId(readField(record, "memory_id", path), `${path}.memory_id`),
    observed_revision: parseRevision(
      readField(record, "observed_revision", path),
      `${path}.observed_revision`,
    ),
    reason: readNonEmptyString(readField(record, "reason", path), `${path}.reason`),
    excerpt,
    excerpt_truncated: parseBooleanField(record, "excerpt_truncated", path),
    excerpt_char_count,
    sources,
    source_count,
    sources_truncated,
    branch_ref: readNullableString(readField(record, "branch_ref", path), `${path}.branch_ref`),
    producer: parseStaleProducer(readField(record, "producer", path), `${path}.producer`),
    created_at: parseTimestamp(readField(record, "created_at", path), `${path}.created_at`),
  };
}

export function parseFreshness(value: unknown, path = "$"): Freshness {
  const record = readRecord(value, path);
  const brief = parseFreshnessBrief(value, path);
  const memory_id = parseMemoryId(readField(record, "memory_id", path), `${path}.memory_id`);
  const delivered_revision = parseRevision(
    readField(record, "delivered_revision", path),
    `${path}.delivered_revision`,
  );
  if (delivered_revision > brief.head_revision) {
    fail(
      `${path}.delivered_revision`,
      "invariant_violation",
      "delivered_revision cannot be ahead of head_revision",
    );
  }
  const revision_mismatch = parseBooleanField(record, "revision_mismatch", path);
  if (revision_mismatch !== delivered_revision < brief.head_revision) {
    fail(
      `${path}.revision_mismatch`,
      "invariant_violation",
      "revision_mismatch must match delivered_revision < head_revision",
    );
  }
  const pending = readArray(readField(record, "pending", path), `${path}.pending`).map((event, index) =>
    parseStaleEventSummary(event, `${path}.pending[${index}]`),
  );
  for (const event of pending) {
    if (event.memory_id !== memory_id) {
      fail(`${path}.pending`, "invariant_violation", "every pending event must belong to memory_id");
    }
  }
  const pending_truncated = parseBooleanField(record, "pending_truncated", path);
  if (pending_truncated !== brief.pending_count > pending.length) {
    fail(
      `${path}.pending_truncated`,
      "invariant_violation",
      "pending_truncated must match whether pending events were cut",
    );
  }
  if (pending.length > brief.pending_count) {
    fail(`${path}.pending`, "invariant_violation", "pending cannot exceed pending_count");
  }
  return {
    ...brief,
    memory_id,
    delivered_revision,
    revision_mismatch,
    pending,
    pending_truncated,
  };
}

export function parseMemoryCard(value: unknown, path = "$"): MemoryCard {
  const record = readRecord(value, path);
  const memory_id = parseMemoryId(readField(record, "memory_id", path), `${path}.memory_id`);
  const uri = parseMemoryUri(readField(record, "uri", path), `${path}.uri`);
  if (splitMemoryUri(uri, `${path}.uri`).memoryId !== memory_id) {
    fail(`${path}.uri`, "invariant_violation", "the memory id in the URI must equal memory_id");
  }
  const nav_text = readString(readField(record, "nav_text", path), `${path}.nav_text`);
  const navLength = codePointCount(nav_text);
  if (navLength < 1 || navLength > NAV_TEXT_MAX) {
    fail(
      `${path}.nav_text`,
      "out_of_range",
      `nav text must be 1-${NAV_TEXT_MAX} Unicode code points; got ${navLength}`,
    );
  }
  return {
    memory_id,
    uri,
    scope: parseScope(readField(record, "scope", path), `${path}.scope`),
    title: readNonEmptyString(readField(record, "title", path), `${path}.title`),
    nav_text,
    revision: parseRevision(readField(record, "revision", path), `${path}.revision`),
    state: parseMemoryState(readField(record, "state", path), `${path}.state`),
    score: readNumber(readField(record, "score", path), `${path}.score`, Number.NEGATIVE_INFINITY),
    hit_count: readInteger(readField(record, "hit_count", path), `${path}.hit_count`, 0),
    access_count: readInteger(readField(record, "access_count", path), `${path}.access_count`, 0),
    last_access_at: readNullable(
      readField(record, "last_access_at", path),
      `${path}.last_access_at`,
      parseTimestamp,
    ),
    ...withOptional("freshness", readOptionalField(record, "freshness", path, parseFreshnessBrief)),
  };
}

export function parseBudgetUsed(value: unknown, path = "$"): BudgetUsed {
  const record = readRecord(value, path);
  return {
    elapsed_ms: readNumber(readField(record, "elapsed_ms", path), `${path}.elapsed_ms`, 0),
    model_calls: readInteger(readField(record, "model_calls", path), `${path}.model_calls`, 0),
    tokens_in: readInteger(readField(record, "tokens_in", path), `${path}.tokens_in`, 0),
    tokens_out: readInteger(readField(record, "tokens_out", path), `${path}.tokens_out`, 0),
    cost_usd: readNumberOrNull(readField(record, "cost_usd", path), `${path}.cost_usd`, 0),
  };
}

export function parseRetrievalResult(value: unknown, path = "$"): RetrievalResult {
  const record = readRecord(value, path);
  const status = parseRetrievalStatus(readField(record, "status", path), `${path}.status`);
  const cards = readArray(readField(record, "cards", path), `${path}.cards`).map((card, index) =>
    parseMemoryCard(card, `${path}.cards[${index}]`),
  );
  const answer = readNullableString(readField(record, "answer", path), `${path}.answer`);
  const memory_summary = readNullableString(
    readField(record, "memory_summary", path),
    `${path}.memory_summary`,
  );
  const memory_uri = readNullable(
    readField(record, "memory_uri", path),
    `${path}.memory_uri`,
    parseMemoryUri,
  );
  const revision = readNullable(readField(record, "revision", path), `${path}.revision`, parseRevision);
  if ((memory_uri === null) !== (revision === null)) {
    fail(
      `${path}.memory_uri`,
      "invariant_violation",
      "memory_uri and revision must be present or absent together",
    );
  }
  const persistence_status = parsePersistenceStatus(
    readField(record, "persistence_status", path),
    `${path}.persistence_status`,
  );
  if (persistence_status === "saved" && (memory_uri === null || revision === null || memory_summary === null)) {
    fail(
      `${path}.persistence_status`,
      "invariant_violation",
      "a saved result must report memory_uri, revision and memory_summary",
    );
  }
  const navigation_status = parseNavigationStatus(
    readField(record, "navigation_status", path),
    `${path}.navigation_status`,
  );
  const evidence = readArray(readField(record, "evidence", path), `${path}.evidence`).map(
    (source, index) => parseSourceRef(source, `${path}.evidence[${index}]`),
  );
  const missing = readArray(readField(record, "missing", path), `${path}.missing`).map((item, index) =>
    readNonEmptyString(item, `${path}.missing[${index}]`),
  );
  const conflicts = readArray(readField(record, "conflicts", path), `${path}.conflicts`).map(
    (item, index) => readNonEmptyString(item, `${path}.conflicts[${index}]`),
  );
  const next_action = readNullableString(readField(record, "next_action", path), `${path}.next_action`);
  const continuation_id = readNullableString(
    readField(record, "continuation_id", path),
    `${path}.continuation_id`,
  );
  const budget_used = parseBudgetUsed(readField(record, "budget_used", path), `${path}.budget_used`);
  const freshness = readOptionalField(record, "freshness", path, parseFreshness);
  if (freshness !== undefined && memory_uri !== null) {
    const { memoryId } = splitMemoryUri(memory_uri);
    if (freshness.memory_id !== memoryId) {
      fail(
        `${path}.freshness.memory_id`,
        "invariant_violation",
        "freshness must describe the result's memory_uri",
      );
    }
  }
  if (freshness !== undefined && revision !== null && freshness.delivered_revision !== revision) {
    fail(
      `${path}.freshness.delivered_revision`,
      "invariant_violation",
      "freshness must describe the result's revision",
    );
  }
  if (status === "not_found" && (cards.length > 0 || memory_summary !== null)) {
    fail(
      `${path}.status`,
      "invariant_violation",
      "a not_found result must carry no cards and no memory_summary",
    );
  }
  return {
    status,
    cards,
    answer,
    memory_summary,
    memory_uri,
    revision,
    persistence_status,
    navigation_status,
    evidence,
    missing,
    conflicts,
    next_action,
    continuation_id,
    budget_used,
    ...withOptional("freshness", freshness),
  };
}
