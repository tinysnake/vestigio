/**
 * The PR-07 write path behind `memory.resolve`: forced medium summary, one
 * memory revision, one pending nav job, one delivery access — all idempotent.
 *
 * The trigger is evidence, not success: a resolve whose answer came only from
 * already-stored memory is reuse and writes nothing. Only a `resolved` walk that
 * actually read raw history (`provider: "obelisk"`) forces a summary.
 *
 * Idempotency has two layers. The evidence version (sorted source identities)
 * maps to one memory revision through `resolve_versions`; a repeat of the same
 * version returns the stored body from the same revision without a model call.
 * The job queue and the delivery access event each have their own unique key, so
 * a crash between save and return is repaired by the next attempt, not repeated.
 */

import { createHash } from "node:crypto";
import {
  MEDIUM_BODY_MIN,
  nonWhitespaceCodePointCount,
  parseMemoryUri,
  usageEventId,
  type Memory,
  type MemoryCard,
  type MemoryId,
  type MemoryUri,
  type NavigationStatus,
  type PersistenceStatus,
  type Revision,
  type Scope,
  type SourceRef,
  type UsageEvent,
} from "../contracts/index.js";
import { subjectKey, subjectsCollide, type HistoryExcerpt } from "../retrieval/index.js";
import { extractMediumSummary } from "../extraction/index.js";
import type { MediumCall, MediumEvidence } from "../extraction/index.js";
import { enqueueSummaryJob } from "../jobs/index.js";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { ModelPort, PersistenceOutcome, PersistenceStage, ResolveCallRecord } from "./types.js";
import type { ResolveBudgetLedger } from "./budget.js";
import type { MemoryStore } from "../storage/store.js";

/** A version row older than its memory is stale; the next run rebuilds it. */
export type EvidenceVersion = {
  version_key: string;
  memory_id: MemoryId;
  revision: Revision;
  stage: "saved" | "returned";
  request_key: string;
  /** The model's answer for this version, replayed verbatim on a repeat. */
  answer: string;
  created_at: string;
  updated_at: string;
};

/**
 * How long a question keyed only by its own wording may replay. A crash, a
 * retried CLI call and a repeated tool call all land inside this window; a
 * fresh question asked an hour later walks the layers again, so a short
 * question like 端口 never becomes a permanently stale cache entry.
 */
export const RESOLVE_REPLAY_MAX_AGE_MS = 10 * 60_000;

/**
 * How much longer than its evidence a body may be before it counts as invented
 * rather than summarized. Measured on real runs: a faithful Chinese body runs
 * about 1.3x its source, so the margin allows compression loss and connective
 * phrasing but not invention; past it the model is filling gaps it never read.
 */
const MEDIUM_BODY_EVIDENCE_RATIO = 1.5;

export type PersistResolveInput = {
  store: MemoryStore;
  question: string;
  scope: Scope;
  /** The model's answer for this request, stored so a replay returns it verbatim. */
  answer: string;
  /** The bounded sources the walk actually used, in order. */
  evidence: readonly SourceRef[];
  excerpts: readonly HistoryExcerpt[];
  cards: readonly MemoryCard[];
  model: ModelPort;
  model_id: string | undefined;
  ledger: ResolveBudgetLedger;
  /** The request's deadline signal, already combined with the caller's. */
  signal: AbortSignal;
  remaining_ms: () => number;
  request_id: string | undefined;
  session_id: string | undefined;
  wall_now: () => number;
  mono_now: () => number;
  /** Index the summary call gets in `ResolveOutcome.calls`. */
  call_index: number;
};

export type PersistResolveOutcome = {
  persistence: PersistenceOutcome;
  patch: {
    memory_summary: string | null;
    memory_uri: MemoryUri | null;
    revision: Revision | null;
    persistence_status: PersistenceStatus;
    navigation_status: NavigationStatus;
  };
  /** Reasons appended to `RetrievalResult.missing`. */
  missing: string[];
  call: ResolveCallRecord | null;
};

const NOTHING_SAVED: PersistResolveOutcome["patch"] = {
  memory_summary: null,
  memory_uri: null,
  revision: null,
  navigation_status: "pending",
  persistence_status: "not_attempted",
};

export function evidenceVersionKey(evidence: readonly SourceRef[]): string {
  const keys = evidence
    .map((ref) =>
      [ref.provider, ref.source_instance, ref.session_id, ref.message_id, ref.content_hash].join("\u0000"),
    )
    .sort();
  return createHash("sha256").update(JSON.stringify(keys), "utf8").digest("hex");
}

/**
 * Raw history is identified by the excerpt anchors the walk actually read, not
 * by a provider label: the transcript source reports its producer (`pi`), which
 * is the same label a memory-sourced ref carries. Only an excerpt proves that
 * this request read the transcript.
 */
export function hasRawHistoryEvidence(
  evidence: readonly SourceRef[],
  excerpts: readonly HistoryExcerpt[],
): boolean {
  const anchors = new Set(excerpts.map((excerpt) => excerpt.source_ref.message_id));
  return evidence.some((ref) => anchors.has(ref.message_id));
}

/** Stable across retries of one logical request; a caller may supply its own. */
export function requestKeyOf(input: { scope: Scope; question: string; request_id?: string | undefined }): string {
  const scope = input.scope.kind === "project" ? `project:${input.scope.project_id}` : "global";
  const explicit = input.request_id?.trim() ?? "";
  if (explicit.length > 0) {
    // The wording is part of the key even for an explicit id: two questions in
    // one turn share an input id, and one must never replay the other's answer.
    const digest = createHash("sha256").update(`${explicit}\u0000${scope}\u0000${input.question}`, "utf8");
    return `req-${digest.digest("hex").slice(0, 16)}`;
  }
  return `resolve-${createHash("sha256").update(`${scope}\n${input.question}`, "utf8").digest("hex").slice(0, 16)}`;
}

export function deliveryDedupKey(requestKey: string, memoryId: MemoryId, revision: Revision): string {
  return `resolve-delivery:${requestKey}:${memoryId}:${revision}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function clip(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, Math.max(1, max - 1)).join("")}…`;
}

export function buildTitle(question: string): string {
  const cleaned = question.replace(/\s+/gu, " ").trim();
  return `关于「${clip(cleaned, 48)}」的记忆`;
}

export function buildKeywords(question: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const token of question.split(/[\s,，。;；:：、/\\|()（）[\]{}<>"'`~!?！？#*+=]+/u)) {
    const trimmed = token.trim();
    if (trimmed.length < 2) continue;
    const clipped = clip(trimmed, 24);
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    keywords.push(clipped);
    if (keywords.length >= 8) break;
  }
  return keywords.length > 0 ? keywords : [clip(question.trim(), 24) || "memory"];
}

function scopeLabel(scope: Scope): string | null {
  return scope.kind === "project" ? scope.project_id : null;
}

// --- resolve_versions -------------------------------------------------------

type Row = Record<string, SQLOutputValue>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`resolve_versions.${key} is not text`);
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`resolve_versions.${key} is not an integer`);
  }
  return value;
}

export function readEvidenceVersion(db: DatabaseSync, versionKey: string): EvidenceVersion | null {
  const row = db.prepare("SELECT * FROM resolve_versions WHERE version_key = ?").get(versionKey);
  if (row === undefined) return null;
  const stage = text(row, "stage");
  if (stage !== "saved" && stage !== "returned") {
    throw new Error(`resolve_versions.stage has unknown value ${stage}`);
  }
  return {
    version_key: text(row, "version_key"),
    memory_id: text(row, "memory_id"),
    revision: integer(row, "revision"),
    stage,
    request_key: text(row, "request_key"),
    answer: text(row, "answer"),
    created_at: text(row, "created_at"),
    updated_at: text(row, "updated_at"),
  };
}

function writeEvidenceVersion(
  db: DatabaseSync,
  input: {
    version_key: string;
    memory_id: MemoryId;
    revision: Revision;
    request_key: string;
    answer: string;
    at: string;
  },
): void {
  db.prepare(
    `INSERT INTO resolve_versions
       (version_key, memory_id, revision, stage, request_key, answer, created_at, updated_at)
     VALUES (?, ?, ?, 'saved', ?, ?, ?, ?)
     ON CONFLICT(version_key) DO UPDATE SET
       memory_id = excluded.memory_id,
       revision = excluded.revision,
       stage = 'saved',
       request_key = excluded.request_key,
       answer = excluded.answer,
       updated_at = excluded.updated_at`,
  ).run(
    input.version_key,
    input.memory_id,
    input.revision,
    input.request_key,
    input.answer,
    input.at,
    input.at,
  );
}

function advanceEvidenceStage(db: DatabaseSync, versionKey: string, stage: "returned", at: string): void {
  db.prepare("UPDATE resolve_versions SET stage = ?, updated_at = ? WHERE version_key = ?").run(stage, at, versionKey);
}

export type ReplayOutcome = {
  memory: Memory;
  persistence: PersistenceOutcome;
  /** The answer stored with this version, returned verbatim. */
  answer: string;
};

/**
 * Before any search: the same scope + question (and explicit request id, when
 * given) already maps to a stored revision, so that revision is the answer.
 * This is the repeat and crash-recovery path, and it makes no model call.
 *
 * An explicit request id replays at any age, because it names one logical
 * request. A key derived from the question alone ages out, so re-asking a
 * short question much later searches again instead of returning a stale body.
 *
 * `require_current` makes the cache punt when the stored revision is stale or
 * behind the head, so the caller runs the repair path instead of replaying a
 * body that later evidence has outgrown. The check happens before any delivery
 * or stage write, so a punt records nothing.
 */
export function replaySavedRequest(input: {
  store: MemoryStore;
  scope: Scope;
  question: string;
  request_id?: string | undefined;
  session_id?: string | undefined;
  mono_now: () => number;
  wall_now: () => number;
  max_age_ms?: number | undefined;
  require_current?: boolean | undefined;
}): ReplayOutcome | null {
  const started = input.mono_now();
  const explicit = (input.request_id ?? "").trim().length > 0;
  const requestKey = requestKeyOf({
    scope: input.scope,
    question: input.question,
    request_id: input.request_id,
  });
  const db = input.store.database();
  const row = db
    .prepare(
      "SELECT memory_id, revision, answer, created_at FROM resolve_versions WHERE request_key = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1",
    )
    .get(requestKey);
  if (row === undefined) return null;
  if (!explicit) {
    const savedAt = Date.parse(text(row, "created_at"));
    const maxAge = input.max_age_ms ?? RESOLVE_REPLAY_MAX_AGE_MS;
    if (!Number.isFinite(savedAt) || input.wall_now() - savedAt > maxAge) return null;
  }
  const located = db
    .prepare("SELECT uri FROM memories WHERE memory_id = ? AND revision = ?")
    .get(text(row, "memory_id"), integer(row, "revision"));
  if (located === undefined) return null;
  const memory = input.store.readMemory(parseMemoryUri(text(located, "uri")), integer(row, "revision"));
  if (memory === null) return null;
  if (input.require_current === true) {
    const freshness = input.store.readFreshness(memory.uri, memory.revision);
    if (freshness !== null && (freshness.is_stale || freshness.revision_mismatch)) return null;
  }
  const sessionId = input.session_id ?? `resolve:${requestKey}`;
  const delivered = recordDelivery(input.store, { memory, requestKey, sessionId });
  db.prepare("UPDATE resolve_versions SET stage = 'returned', updated_at = ? WHERE request_key = ?").run(
    iso(input.wall_now()),
    requestKey,
  );
  return {
    memory,
    answer: text(row, "answer"),
    persistence: {
      status: "saved",
      stage: "returned",
      target: { memory_id: memory.memory_id, memory_uri: memory.uri, revision: memory.revision },
      dedup_key: deliveryDedupKey(requestKey, memory.memory_id, memory.revision),
      reused: true,
      navigation_status: memory.nav === null ? "pending" : "ready",
      summary_ms: 0,
      persist_ms: input.mono_now() - started,
      delivery_recorded: delivered.recorded,
      missing: [],
      call: null,
    },
  };
}

/**
 * Source identity for "the same memory": one discussion, one provider. A new
 * conclusion from the same session updates that memory instead of minting a
 * second one. The title's question wording is presentation, not identity.
 */
function sessionIdentity(source: SourceRef): string {
  return `${source.provider}\u0000${source.source_instance}\u0000${source.session_id}`;
}

function findHeadBySource(
  store: MemoryStore,
  scope: Scope,
  evidence: readonly SourceRef[],
): { memory_id: MemoryId; revision: Revision; created_at: string } | null {
  const keys = new Set(evidence.map(sessionIdentity));
  if (keys.size === 0) return null;
  let best: { head: Memory; overlap: number } | null = null;
  for (const head of store.listHeads(scope)) {
    const memory = store.readMemory(head.uri);
    if (memory === null) continue;
    const overlap = memory.medium.sources.filter((source) => keys.has(sessionIdentity(source))).length;
    if (overlap === 0) continue;
    if (best === null || overlap > best.overlap) best = { head: memory, overlap };
  }
  return best === null ? null : best.head;
}

// --- evidence to prompt -----------------------------------------------------

function buildEvidenceItems(
  evidence: readonly SourceRef[],
  excerpts: readonly HistoryExcerpt[],
): MediumEvidence[] {
  const excerptByAnchor = new Map(excerpts.map((excerpt) => [excerpt.source_ref.message_id, excerpt]));
  return evidence.map((ref, index) => {
    const excerpt = excerptByAnchor.get(ref.message_id);
    // Short aliases: history adapters mint long opaque message ids, and a model
    // that has to copy one of those verbatim eventually copies it wrong. The
    // alias is presentation only; the stored sources stay the real refs.
    return {
      id: `e${index + 1}`,
      kind: excerpt === undefined ? "memory" : "history",
      provider: ref.provider,
      source_instance: ref.source_instance,
      session_id: ref.session_id,
      timestamp: ref.timestamp,
      text: excerpt?.excerpt ?? "",
    };
  });
}

// --- delivery ---------------------------------------------------------------

/**
 * Record exactly one `access` for the first delivery of this revision to this
 * request. The event id is derived from the event fields and therefore stable
 * across a retried delivery; `at` is the revision's creation time so that the id
 * stays stable, and `dedup_key` names the logical delivery for inspection.
 */
function recordDelivery(
  store: MemoryStore,
  input: {
    memory: Memory;
    requestKey: string;
    sessionId: string;
  },
): { recorded: boolean; eventId: string } {
  const memoryId = input.memory.memory_id;
  const revision = input.memory.revision;
  const dedupKey = deliveryDedupKey(input.requestKey, memoryId, revision);
  const fields = {
    memory_id: memoryId,
    revision,
    kind: "access" as const,
    channel: "read" as const,
    session_id: input.sessionId,
    input_id: input.requestKey,
    at: input.memory.created_at,
    dedup_key: dedupKey,
  };
  const event: UsageEvent = { event_id: usageEventId(fields), ...fields };
  if (store.hasUsageEvent(event.event_id)) {
    return { recorded: false, eventId: event.event_id };
  }
  const inserted = store.recordUsageEvent(event);
  return { recorded: inserted, eventId: event.event_id };
}

// --- main -------------------------------------------------------------------

function callRecord(
  index: number,
  call: MediumCall,
  tokens: { tokens_in: number; tokens_out: number; cost_usd: number | null },
): ResolveCallRecord {
  return {
    index,
    layer: "history",
    purpose: "medium_summary",
    model: call.model,
    tokens_in: tokens.tokens_in,
    tokens_out: tokens.tokens_out,
    cost_usd: tokens.cost_usd,
    elapsed_ms: call.elapsed_ms,
    outcome: call.outcome,
  };
}

/**
 * Everything after a `resolved` walk: dedup, the forced summary, the memory
 * revision, its pending job, and the delivery access.
 *
 * Never throws for an environment problem. A store failure is reported as
 * `failed` with the revision absent, because claiming `saved` without a readable
 * body would be a lie the caller cannot check.
 */
export async function persistResolvedMemory(input: PersistResolveInput): Promise<PersistResolveOutcome> {
  const persistenceStarted = input.mono_now();
  const db = input.store.database();
  const requestKey = requestKeyOf({
    scope: input.scope,
    question: input.question,
    request_id: input.request_id,
  });
  const sessionId = input.session_id?.trim() || `resolve:${requestKey}`;
  const versionKey = evidenceVersionKey(input.evidence);
  const projectId = scopeLabel(input.scope);

  const unsaved = (
    status: PersistenceStatus,
    stage: PersistenceStage,
    reason: string,
    call: ResolveCallRecord | null,
    summary: string | null = null,
  ): PersistResolveOutcome => ({
    persistence: {
      status,
      stage,
      target: null,
      dedup_key: null,
      reused: false,
      navigation_status: "pending",
      summary_ms: input.mono_now() - persistenceStarted,
      persist_ms: 0,
      delivery_recorded: false,
      missing: [reason],
      call,
    },
    patch: { ...NOTHING_SAVED, persistence_status: status, memory_summary: summary },
    missing: [reason],
    call,
  });

  // Same evidence version: reuse the stored body and revision. No model call,
  // no memory, no job; the delivery access is still accounted once.
  const version = readEvidenceVersion(db, versionKey);
  if (version !== null) {
    const existing = input.store.readMemory(
      parseMemoryUri(`memory://${input.store.storeId}/${version.memory_id}`),
      version.revision,
    );
    if (existing !== null) {
      const delivered = recordDelivery(input.store, {
        memory: existing,
        requestKey,
        sessionId,
      });
      advanceEvidenceStage(db, versionKey, "returned", iso(input.wall_now()));
      const persistence: PersistenceOutcome = {
        status: "saved",
        stage: "returned",
        target: {
          memory_id: existing.memory_id,
          memory_uri: existing.uri,
          revision: existing.revision,
        },
        dedup_key: deliveryDedupKey(requestKey, existing.memory_id, existing.revision),
        reused: true,
        navigation_status: existing.nav === null ? "pending" : "ready",
        summary_ms: input.mono_now() - persistenceStarted,
        persist_ms: 0,
        delivery_recorded: delivered.recorded,
        missing: [],
        call: null,
      };
      return {
        persistence,
        patch: {
          memory_summary: existing.medium.body,
          memory_uri: existing.uri,
          revision: existing.revision,
          persistence_status: "saved",
          navigation_status: persistence.navigation_status,
        },
        missing: [],
        call: null,
      };
    }
    // The version row outlived its memory: rebuild rather than claim a body
    // that cannot be read.
    db.prepare("DELETE FROM resolve_versions WHERE version_key = ?").run(versionKey);
  }

  const evidenceItems = buildEvidenceItems(input.evidence, input.excerpts);
  const allowedIds = evidenceItems.map((item) => item.id);
  const estimateInputTokens = Math.ceil(
    Buffer.byteLength([input.question, ...evidenceItems.map((item) => item.text)].join("\n"), "utf8") / 4,
  );

  if (input.remaining_ms() <= 0) {
    return unsaved(
      "budget_exhausted",
      "searched",
      `budget:deadline_exceeded:remaining_ms=${Math.trunc(input.remaining_ms())}`,
      null,
    );
  }
  const summaryStop = input.ledger.summaryStopReason(estimateInputTokens);
  if (summaryStop !== null) {
    return unsaved("budget_exhausted", "searched", `budget:${summaryStop}`, null);
  }

  // A summary can only restate what it read. Fewer than the minimum body's
  // worth of readable evidence cannot honestly fill a body, and asking the
  // model anyway is how a 500-character fabrication gets written from two
  // sentences. Refuse before spending the call.
  const evidenceChars = evidenceItems.reduce((total, item) => total + nonWhitespaceCodePointCount(item.text), 0);
  if (evidenceChars < MEDIUM_BODY_MIN) {
    return unsaved(
      "insufficient_evidence",
      "searched",
      `medium_evidence_too_short:${evidenceChars}<${MEDIUM_BODY_MIN}`,
      null,
    );
  }

  const extraction = await extractMediumSummary({
    model: input.model,
    model_id: input.model_id,
    evidence: {
      question: input.question,
      project: projectId,
      evidence: evidenceItems,
    },
    allowed_ids: allowedIds,
    max_output_tokens: input.ledger.nextSummaryOutputCap(),
    signal: input.signal,
  });
  input.ledger.recordModelCall(extraction.usage, "summary");
  const call = callRecord(input.call_index, extraction.call, {
    tokens_in: extraction.usage.tokens_in,
    tokens_out: extraction.usage.tokens_out,
    cost_usd: extraction.usage.cost_usd,
  });

  if (extraction.status === "insufficient_evidence") {
    return unsaved(
      "insufficient_evidence",
      "summarized",
      `medium_insufficient_evidence:${extraction.reason ?? "unknown"}`,
      call,
      extraction.body,
    );
  }
  if (extraction.status !== "ok" || extraction.body === null) {
    return unsaved(
      "failed",
      "summarized",
      `medium_${extraction.status}:${extraction.reason ?? "unknown"}`,
      call,
    );
  }

  const body = extraction.body;
  // A body cannot be longer than the material it summarizes; past that point
  // the model is filling gaps it never read. The margin covers the citation
  // markers and phrasing the body adds.
  const bodyChars = nonWhitespaceCodePointCount(body);
  if (bodyChars > Math.ceil(evidenceChars * MEDIUM_BODY_EVIDENCE_RATIO)) {
    return unsaved(
      "failed",
      "summarized",
      `medium_longer_than_evidence:${bodyChars}>${Math.ceil(evidenceChars * MEDIUM_BODY_EVIDENCE_RATIO)}`,
      call,
      body,
    );
  }
  const title = buildTitle(input.question);
  const subject = subjectKey(title);
  const at = iso(input.wall_now());
  const memoryId = `mem-${createHash("sha256").update(versionKey, "utf8").digest("hex").slice(0, 16)}`;

  // A different evidence set with the same subject is a new revision of that
  // memory, never an overwrite; the new revision starts with nav null, which
  // suspends the previous nav until the job publishes this body.
  let targetId: MemoryId = memoryId;
  let revision: Revision = 1;
  let createdAt = at;
  const sameSource = findHeadBySource(input.store, input.scope, input.evidence);
  if (sameSource !== null) {
    targetId = sameSource.memory_id;
    revision = sameSource.revision + 1;
    createdAt = sameSource.created_at;
  } else {
    for (const head of input.store.listHeads(input.scope)) {
      if (subjectsCollide(subjectKey(head.title), subject)) {
        targetId = head.memory_id;
        revision = head.revision + 1;
        createdAt = head.created_at;
        break;
      }
    }
  }
  const uri = parseMemoryUri(`memory://${input.store.storeId}/${targetId}`);

  const memory: Memory = {
    memory_id: targetId,
    uri,
    scope: input.scope,
    title,
    keywords: buildKeywords(input.question),
    revision,
    state: "medium_ready",
    medium: {
      body,
      body_char_count: nonWhitespaceCodePointCount(body),
      sources: input.evidence.map((ref) => ({ ...ref })),
    },
    nav: null,
    hit_count: 0,
    access_count: 0,
    last_access_at: null,
    created_at: createdAt,
    updated_at: at,
  };

  try {
    input.store.saveMemory(memory, {
      beforeCommit: () => {
        const connection = input.store.database();
        enqueueSummaryJob(connection, { memory_id: targetId, revision, at });
        writeEvidenceVersion(connection, {
          version_key: versionKey,
          memory_id: targetId,
          revision,
          request_key: requestKey,
          answer: input.answer,
          at,
        });
      },
    });
  } catch (error) {
    const reason = `persist_failed:${error instanceof Error ? error.message : String(error)}`;
    return unsaved("failed", "summarized", reason, call, body);
  }

  const stored = input.store.readMemory(uri, revision);
  if (stored === null || stored.medium.body !== body) {
    return unsaved("failed", "saved", "persist_failed:body_identity_mismatch", call, body);
  }

  const delivered = recordDelivery(input.store, { memory: stored, requestKey, sessionId });
  advanceEvidenceStage(db, versionKey, "returned", iso(input.wall_now()));

  const persistence: PersistenceOutcome = {
    status: "saved",
    stage: "returned",
    target: { memory_id: stored.memory_id, memory_uri: stored.uri, revision: stored.revision },
    dedup_key: deliveryDedupKey(requestKey, stored.memory_id, stored.revision),
    reused: false,
    navigation_status: "pending",
    summary_ms: extraction.call.elapsed_ms,
    persist_ms: input.mono_now() - persistenceStarted - extraction.call.elapsed_ms,
    delivery_recorded: delivered.recorded,
    missing: [],
    call,
  };
  return {
    persistence,
    patch: {
      memory_summary: stored.medium.body,
      memory_uri: stored.uri,
      revision: stored.revision,
      persistence_status: "saved",
      navigation_status: "pending",
    },
    missing: [],
    call,
  };
}
