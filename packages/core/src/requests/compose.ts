/**
 * Compose one approved request into one memory revision.
 *
 * The evidence is the fixed snapshot captured when the operator confirmed the
 * request, never a fresh read of the session. A request that overlaps an
 * existing topic is folded into that topic: one model call, one revision. When
 * that topic also has pending stale events, the same revision absorbs the cited
 * ones, so an overlapping request and a stale repair never mint two revisions.
 *
 * Nothing is written unless the validated body cites evidence the request was
 * approved against. A failure returns a status and leaves the old revision and
 * every pending event untouched; the request queue decides whether to retry.
 */

import {
  MEDIUM_BODY_MAX,
  MEDIUM_BODY_MIN,
  MEDIUM_BODY_TARGET_MAX,
  MEDIUM_BODY_TARGET_MIN,
  nonWhitespaceCodePointCount,
  parseMemory,
  parseMemoryUri,
  parseTimestamp,
  serializeSourceRef,
  type Memory,
  type MemoryId,
  type NavigationStatus,
  type Scope,
  type SourceRef,
} from "../contracts/index.js";
import { extractMediumSummary } from "../extraction/index.js";
import type { MediumCall, MediumEvidence, MediumExtraction } from "../extraction/index.js";
import { enqueueSummaryJob } from "../jobs/index.js";
import { subjectKey, subjectsCollide } from "../retrieval/index.js";
import { MAX_FRESHNESS_PENDING, type MemoryStore } from "../storage/store.js";
import type { ModelPort } from "../resolver/types.js";
import { buildTitle, formationKeywords } from "../resolver/persist.js";
import type { MemoryRequest, MemoryRequestEvidence } from "./queue.js";

/** The prompt and JSON envelope need room beyond the body itself. */
export const REQUEST_MAX_OUTPUT_TOKENS = 4096;
export const REQUEST_MAX_CORRECTIONS = 1;
export const REQUEST_MAX_SOURCES = 32;

export type RequestComposeStatus =
  | "saved"
  | "merged"
  /** A crash left a saved revision behind; the target is reused, not rewritten. */
  | "reused"
  /** Nothing was written; the same request may be attempted again. */
  | "retry"
  /** The evidence cannot honestly fill a medium body; nothing is written. */
  | "insufficient_evidence"
  /** A permanent, human-readable refusal; nothing is written. */
  | "rejected";

export type RequestComposeOutcome = {
  status: RequestComposeStatus;
  reason: string | null;
  memory: Memory | null;
  navigation_status: NavigationStatus;
  call: MediumCall | null;
  calls: MediumCall[];
};

export type ComposeMemoryRequestInput = {
  store: MemoryStore;
  request: MemoryRequest;
  model: ModelPort | null;
  model_id: string | undefined;
  signal: AbortSignal;
  at: string;
  project: string | null;
  max_output_tokens?: number | undefined;
};

function sourceIdentity(source: SourceRef): string {
  return [source.provider, source.source_instance, source.session_id, source.message_id].join("\u0000");
}

function sourceDefault(source: SourceRef | undefined): Pick<SourceRef, "provider" | "source_instance" | "session_id" | "timestamp"> {
  return {
    provider: source?.provider ?? "unknown",
    source_instance: source?.source_instance ?? "unknown",
    session_id: source?.session_id ?? "",
    timestamp: source?.timestamp ?? "",
  };
}

function dedupeSources(sources: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const source of sources) {
    const key = serializeSourceRef(source);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

/**
 * Pick the topic this request belongs to. An evidence overlap wins over a
 * subject overlap; both reuse the same memory id so a request cannot create a
 * twin topic next to the one it is about.
 */
function findTarget(store: MemoryStore, scope: Scope, title: string, evidence: readonly MemoryRequestEvidence[]): Memory | null {
  const heads = store.listHeads(scope);
  const keys = new Set(evidence.map((entry) => sourceIdentity(entry.source)));
  let best: { memory: Memory; overlap: number } | null = null;
  for (const head of heads) {
    const overlap = head.medium.sources.filter((source) => keys.has(sourceIdentity(source))).length;
    if (overlap > 0 && (best === null || overlap > best.overlap)) best = { memory: head, overlap };
  }
  if (best !== null) return best.memory;
  const subject = subjectKey(title);
  for (const head of heads) {
    if (subjectsCollide(subjectKey(head.title), subject)) return head;
  }
  return null;
}

function outcome(
  status: RequestComposeStatus,
  reason: string | null,
  memory: Memory | null,
  calls: MediumCall[],
): RequestComposeOutcome {
  return {
    status,
    reason,
    memory,
    navigation_status: "pending",
    call: calls.at(-1) ?? null,
    calls: [...calls],
  };
}

function retryable(extraction: MediumExtraction): boolean {
  if (extraction.status === "invalid") return true;
  if (extraction.status !== "failed") return false;
  const reason = extraction.reason ?? "";
  if (reason.startsWith("model_invalid_response:")) return true;
  return /http (?:5\d\d)\b/iu.test(reason);
}

function overrun(extraction: MediumExtraction): number | null {
  if (extraction.status !== "ok" || extraction.body === null) return null;
  const measured = nonWhitespaceCodePointCount(extraction.body);
  return measured > MEDIUM_BODY_MAX ? measured : null;
}

/** A too-short body is rejected before its text is accepted; the count is in the reason. */
function underrun(extraction: MediumExtraction): number | null {
  if (extraction.status !== "failed" && extraction.status !== "insufficient_evidence") return null;
  const match = /^medium_below_min:(\d+)$/u.exec(extraction.reason ?? "");
  return match === null ? null : Number(match[1]);
}

function correctionMessage(input: {
  mustCite: readonly string[];
  reason: string | null;
  over: number | null;
  under: number | null;
}): string {
  const band = `${MEDIUM_BODY_TARGET_MIN}-${MEDIUM_BODY_TARGET_MAX} non-whitespace Unicode code points of plain Chinese prose`;
  const size =
    input.over !== null
      ? `Your body was ${input.over} non-whitespace Unicode code points, over the ${MEDIUM_BODY_MAX} ceiling. Rewrite it to ${band}: keep every fact and citation, drop padding and repeated phrasing.`
      : input.under !== null
        ? `Your body was ${input.under} non-whitespace Unicode code points, below the ${MEDIUM_BODY_MIN} floor. Extend it to ${band} with durable detail the existing summary and the cited evidence already state. Do not pad, do not repeat a sentence, and do not invent facts.`
        : `The body must be ${band}.`;
  return [
    `Your previous reply was not usable: ${input.reason ?? "unreadable"}.`,
    'Reply with exactly one JSON object {"body": "..."} and nothing else.',
    size,
    `It must cite at least one of these approved evidence ids with [来源:<id>]: ${input.mustCite.join(", ")}. No other id may appear.`,
  ].join("\n");
}

function guidance(targetKind: "new" | "existing", pendingCount: number): string {
  if (targetKind === "new") {
    return [
      "This writes one new memory from evidence the operator explicitly approved saving.",
      "Capture the durable decision, convention or exception the evidence supports, plus the facts needed to apply it later.",
      "Do not claim any action was taken, do not invent facts, and do not add a rule the evidence does not state.",
      `Aim for ${MEDIUM_BODY_TARGET_MIN}-${MEDIUM_BODY_TARGET_MAX} non-whitespace code points, in Chinese.`,
    ].join(" ");
  }
  return [
    `This rewrite folds one operator-approved request${pendingCount > 0 ? ` and ${pendingCount} pending change(s)` : ""} into an existing summary.`,
    "Write the resulting state only, as if nothing had ever been pending: never mention a previous summary, a gap, a correction, a confirmation or a pending event.",
    "This replaces the general instruction to describe the discussion: do not say what was discussed, what was tried, or what is still uncertain.",
    "Keep every fact, path and procedure the summary already states and the approved evidence does not replace.",
    "Never extend a rule further than the evidence states it, and never name a revision, an id, or the evidence set.",
    "Do not hedge or raise an open question about a value the evidence settles.",
    `Aim for ${MEDIUM_BODY_TARGET_MIN}-${MEDIUM_BODY_TARGET_MAX} non-whitespace code points.`,
  ].join(" ");
}

export async function composeMemoryRequest(input: ComposeMemoryRequestInput): Promise<RequestComposeOutcome> {
  const calls: MediumCall[] = [];
  const request = input.request;

  // A previous attempt may have saved the revision but crashed before the row
  // was completed. Reuse that exact target instead of writing a twin.
  if (request.memory_uri !== null && request.revision !== null) {
    const existing = input.store.readMemory(request.memory_uri, request.revision);
    if (existing !== null) {
      return outcome(request.status === "merged" ? "merged" : "saved", "already_saved", existing, calls);
    }
  }

  if (input.model === null) {
    return outcome("retry", "model_not_configured", null, calls);
  }

  const target = findTarget(input.store, request.scope, request.title, request.evidence);
  const pending = target === null ? [] : input.store.listPendingStaleEvents(target.memory_id).slice(0, MAX_FRESHNESS_PENDING);
  const requestIds = request.evidence.map((entry) => entry.source.message_id);
  const pendingIds = pending.map((event) => event.event_id);

  if (target !== null && pending.length === 0) {
    const requestKeys = new Set(request.evidence.map((entry) => sourceIdentity(entry.source)));
    const covered =
      requestKeys.size > 0 &&
      [...requestKeys].every((key) => target.medium.sources.some((source) => sourceIdentity(source) === key));
    if (covered) return outcome("merged", "already_covered", target, calls);
  }

  const evidence: MediumEvidence[] = [];
  const allowedIds: string[] = [];
  if (target !== null) {
    evidence.push({
      id: target.memory_id,
      kind: "memory",
      ...sourceDefault(target.medium.sources[0]),
      text: target.medium.body,
    });
    allowedIds.push(target.memory_id);
  }
  evidence.push(
    ...request.evidence.map(
      (entry): MediumEvidence => ({
        id: entry.source.message_id,
        kind: "history",
        provider: entry.source.provider,
        source_instance: entry.source.source_instance,
        session_id: entry.source.session_id,
        timestamp: entry.source.timestamp,
        text: entry.excerpt,
      }),
    ),
  );
  allowedIds.push(...requestIds);
  evidence.push(
    ...pending.map(
      (event): MediumEvidence => {
        const anchor = sourceDefault(event.sources[0]);
        const label = event.reason.length > 0 ? event.reason : "later activity not absorbed";
        return {
          id: event.event_id,
          kind: "history",
          provider: anchor.provider,
          source_instance: anchor.source_instance,
          session_id: anchor.session_id,
          timestamp: anchor.timestamp,
          text: `[pending stale evidence -> must be folded into the summary] ${label} :: ${event.excerpt}`,
        };
      },
    ),
  );
  allowedIds.push(...pendingIds);

  const mustCite = [...new Set([...requestIds, ...(target === null ? [] : pendingIds)])];
  const question = target === null ? request.title : request.intent;

  const ask = async (correction: string | null): Promise<MediumExtraction> => {
    const extraction = await extractMediumSummary({
      model: input.model as ModelPort,
      model_id: input.model_id,
      evidence: {
        question, project: input.project, evidence,
        alias_grounding_ids: request.evidence.map((entry) => entry.source.message_id),
      },
      allowed_ids: allowedIds,
      max_output_tokens: input.max_output_tokens ?? REQUEST_MAX_OUTPUT_TOKENS,
      signal: input.signal,
      ...(correction === null
        ? { guidance: guidance(target === null ? "new" : "existing", pending.length) }
        : { correction }),
    });
    calls.push(extraction.call);
    return extraction;
  };

  const citesRequest = (extraction: MediumExtraction): boolean =>
    extraction.status === "ok" && extraction.cited_ids.some((id) => requestIds.includes(id));

  let extraction = await ask(null);
  for (let attempt = 0; attempt < REQUEST_MAX_CORRECTIONS; attempt += 1) {
    if (input.signal.aborted) break;
    const citesNew = citesRequest(extraction);
    const over = overrun(extraction);
    const under = underrun(extraction);
    if (citesNew && over === null) break;
    if (extraction.status === "cancelled") break;
    if (extraction.status === "insufficient_evidence" && under === null) break;
    if (extraction.status === "failed" && !retryable(extraction) && under === null) break;
    extraction = await ask(
      correctionMessage({
        mustCite,
        reason: extraction.reason ?? "the body did not cite the approved evidence",
        over,
        under,
      }),
    );
  }

  if (input.signal.aborted || extraction.status === "cancelled") {
    return outcome("retry", extraction.reason ?? "cancelled", null, calls);
  }
  if (extraction.status === "failed") {
    return outcome("retry", extraction.reason, null, calls);
  }
  if (extraction.status === "insufficient_evidence") {
    return outcome("rejected", extraction.reason, null, calls);
  }
  if (extraction.status !== "ok" || extraction.body === null) {
    return outcome("retry", extraction.reason ?? "invalid_body", null, calls);
  }
  if (!citesRequest(extraction)) {
    return outcome("retry", "not_incorporated", null, calls);
  }

  const at = parseTimestamp(input.at, "$.at");
  const requestSources = request.evidence.map((entry) => entry.source);
  if (target === null) {
    const memoryId: MemoryId = `mem-${request.dedup_key.slice(0, 16)}`;
    const uri = parseMemoryUri(`memory://${input.store.storeId}/${memoryId}`);
    const memory: Memory = parseMemory({
      memory_id: memoryId,
      uri,
      scope: request.scope,
      title: request.title,
      keywords: formationKeywords(request.intent, [], extraction.aliases),
      revision: 1,
      state: "medium_ready",
      medium: {
        body: extraction.body,
        body_char_count: nonWhitespaceCodePointCount(extraction.body),
        sources: dedupeSources(requestSources).slice(0, REQUEST_MAX_SOURCES),
      },
      nav: null,
      hit_count: 0,
      access_count: 0,
      last_access_at: null,
      created_at: at,
      updated_at: at,
    });
    try {
      input.store.saveMemory(memory, {
        beforeCommit: () => {
          const db = input.store.database();
          enqueueSummaryJob(db, { memory_id: memoryId, revision: 1, at });
        },
      });
    } catch (error) {
      const raced = input.store.readMemory(uri);
      if (raced !== null) return outcome("saved", "already_saved", raced, calls);
      return outcome("retry", error instanceof Error ? error.message : String(error), null, calls);
    }
    const stored = input.store.readMemory(uri);
    if (stored === null) return outcome("retry", "saved_revision_missing", null, calls);
    return outcome("saved", null, stored, calls);
  }

  const cited = new Set(extraction.cited_ids);
  const acknowledged = pending.filter((event) => cited.has(event.event_id)).map((event) => event.event_id);
  const sources = dedupeSources([
    ...target.medium.sources,
    ...requestSources,
    ...pending.flatMap((event) => (cited.has(event.event_id) ? event.sources : [])),
  ]).slice(0, REQUEST_MAX_SOURCES);
  const next: Memory = parseMemory({
    memory_id: target.memory_id,
    uri: target.uri,
    scope: target.scope,
    title: target.title,
    keywords: formationKeywords(request.intent, target.keywords, extraction.aliases),
    revision: target.revision + 1,
    state: "medium_ready",
    medium: {
      body: extraction.body,
      body_char_count: nonWhitespaceCodePointCount(extraction.body),
      sources,
    },
    nav: null,
    hit_count: target.hit_count,
    access_count: target.access_count,
    last_access_at: target.last_access_at,
    created_at: target.created_at,
    updated_at: at,
  });

  try {
    const result = input.store.updateSummary({
      memory: next,
      expected_revision: target.revision,
      acknowledge_event_ids: acknowledged,
      at,
    });
    if (!result.saved || result.memory === undefined) {
      return outcome("retry", "head_moved_during_request", null, calls);
    }
    return outcome("merged", null, result.memory, calls);
  } catch (error) {
    return outcome("retry", error instanceof Error ? error.message : String(error), null, calls);
  }
}

/** The title a request uses, so `findTarget` and the resolver agree on a subject. */
export function requestTitle(intent: string): string {
  return buildTitle(intent);
}
