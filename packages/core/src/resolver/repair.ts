/**
 * Same-memory stale repair (retrieval side of the stale lifecycle).
 *
 * When a resolver walk lands on a memory whose summary has not absorbed later
 * evidence, the honest action is not to write a *second* memory about the same
 * topic — that would leave the stale head stale forever and duplicate the
 * topic. This module rewrites the *same* memory: one bounded model call folds
 * the pending stale events into a new head revision, and only the events the
 * body actually cites are acknowledged, in the same transaction that saves the
 * revision.
 *
 * The failure contract is deliberate: any failure (model error, malformed or
 * undersized body, race on the head, unknown event id) returns a status and
 * writes nothing. The old body and every pending event survive unchanged, so
 * the delivered memory stays readable.
 */

import {
  MEDIUM_BODY_MAX,
  MEDIUM_BODY_MIN,
  nonWhitespaceCodePointCount,
  parseMemory,
  parseTimestamp,
  serializeSourceRef,
  type Memory,
  type MemoryId,
  type MemoryUri,
  type Revision,
  type SourceRef,
  type StaleEventSummary,
} from "../contracts/index.js";
import { MAX_FRESHNESS_PENDING, type MemoryStore } from "../storage/store.js";
import { extractMediumSummary } from "../extraction/medium.js";
import type { MediumCall, MediumEvidence, MediumExtraction } from "../extraction/types.js";
import type { ModelPort } from "./types.js";

/**
 * Output ceiling for the repair call; the body is at most 1000 code points.
 * The prompt and the JSON envelope with real citations need room beyond the
 * body itself: 2048 truncated real replies mid-JSON, which read as `invalid`.
 */
export const REPAIR_MAX_OUTPUT_TOKENS = 4096;
/** Correction retries after the first attempt, each naming the measured miss. */
export const REPAIR_MAX_CORRECTIONS = 2;

/** Keep the new revision's source list bounded the same way delivery is. */
export const REPAIR_MAX_SOURCES = 32;

export type RepairStatus =
  /** A new head revision absorbed the cited pending events. */
  | "repaired"
  /** The memory has no pending events; there is nothing to repair. */
  | "not_applicable"
  /** The model answered without citing any pending event; nothing is written. */
  | "not_incorporated"
  /** The evidence could not honestly fill a medium body; nothing is written. */
  | "insufficient_evidence"
  /** The model body failed validation (foreign/absent citation, action claim). */
  | "invalid"
  /** The model call itself failed or was cancelled. */
  | "failed"
  | "cancelled"
  /** The head moved or an event was acknowledged while we worked; nothing is written. */
  | "conflict";

export type RepairOutcome = {
  status: RepairStatus;
  reason: string | null;
  /** Pending snapshot ids the new body actually cited (subset of the snapshot). */
  incorporated_event_ids: MemoryId[];
  /** The new head revision, present only for `repaired`. */
  memory: Memory | null;
  /** The last model call, kept for the delivery ledger. */
  call: MediumCall | null;
  /** Every model call this repair made, in order; two when a retry ran. */
  calls: MediumCall[];
};

/** Identity and delivered revision of the memory being repaired. */
export type RepairTarget = {
  uri: MemoryUri;
  revision: Revision;
};

export type RepairInput = {
  store: Pick<
    MemoryStore,
    "readMemory" | "readFreshness" | "listPendingStaleEvents" | "updateSummary"
  >;
  /**
   * The delivered memory this repair rewrites. Only the URI and the delivered
   * revision are read, so a resolver card and a bare read target both fit.
   */
  card: RepairTarget;
  /** Snapshot of pending events taken when the card was delivered. */
  pending: readonly StaleEventSummary[];
  /** The answer the resolver walk produced from the gathered evidence. */
  answer: string;
  /** Bounded history excerpt text, keyed by its anchor message id. */
  excerpts: readonly { id: string; provider: string; source_instance: string; session_id: string; timestamp: string; text: string; source: SourceRef }[];
  /** Head revision the snapshot belongs to; a moved head aborts the write. */
  expected_revision: number;
  model: ModelPort;
  model_id: string | undefined;
  signal: AbortSignal;
  at: string;
  project: string | null;
};

function sourceDefault(source: SourceRef | undefined): Pick<SourceRef, "provider" | "source_instance" | "session_id" | "timestamp"> {
  return {
    provider: source?.provider ?? "unknown",
    source_instance: source?.source_instance ?? "unknown",
    session_id: source?.session_id ?? "",
    timestamp: source?.timestamp ?? "",
  };
}

/**
 * One bounded attempt to fold `input.pending` into the same memory.
 *
 * Deterministic target: the caller passes the memory it judged stale, so there
 * is no second candidate search here. Bounded model calls: one, plus one
 * correction retry when the first answer was malformed or unreadable.
 */
export async function repairStaleMemory(input: RepairInput): Promise<RepairOutcome> {
  const pending = input.pending.slice(0, MAX_FRESHNESS_PENDING);
  const calls: MediumCall[] = [];
  const finish = (
    status: RepairStatus,
    reason: string | null,
    incorporated_event_ids: MemoryId[],
    memory: Memory | null,
  ): RepairOutcome => ({
    status,
    reason,
    incorporated_event_ids,
    memory,
    call: calls.at(-1) ?? null,
    calls: [...calls],
  });
  if (pending.length === 0) {
    return finish("not_applicable", null, [], null);
  }

  const uri = input.card.uri;
  const delivered = input.store.readMemory(uri, input.card.revision);
  if (delivered === null) {
    return finish("conflict", "delivered_revision_missing", [], null);
  }
  if (delivered.revision !== input.card.revision) {
    return finish("conflict", "delivered_revision_moved", [], null);
  }

  const pendingIds = new Set(pending.map((event) => event.event_id));
  const evidence: MediumEvidence[] = [
    {
      id: delivered.memory_id,
      kind: "memory",
      ...sourceDefault(delivered.medium.sources[0]),
      text: delivered.medium.body,
    },
    ...pending.map((event): MediumEvidence => {
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
    }),
    ...input.excerpts.map(
      (excerpt): MediumEvidence => ({
        id: excerpt.id,
        kind: "history",
        provider: excerpt.provider,
        source_instance: excerpt.source_instance,
        session_id: excerpt.session_id,
        timestamp: excerpt.timestamp,
        text: excerpt.text,
      }),
    ),
  ];
  const allowedIds = [delivered.memory_id, ...pendingIds, ...input.excerpts.map((excerpt) => excerpt.id)];

  const ask = async (correction: string | null): Promise<MediumExtraction> => {
    const extraction = await extractMediumSummary({
      model: input.model,
      model_id: input.model_id,
      evidence: { question: input.answer, project: input.project, evidence },
      allowed_ids: allowedIds,
      max_output_tokens: REPAIR_MAX_OUTPUT_TOKENS,
      signal: input.signal,
      ...(correction === null ? {} : { correction }),
    });
    calls.push(extraction.call);
    return extraction;
  };

  let extraction = await ask(null);
  // A body one line over the ceiling is a formatting miss, not a verdict: two
  // corrections with the measured count fix it. The caller's deadline bounds
  // the total, so a slow endpoint still cannot stall the read forever.
  for (let attempt = 0; attempt < REPAIR_MAX_CORRECTIONS; attempt += 1) {
    if (input.signal.aborted || !retryableExtraction(extraction)) break;
    extraction = await ask(correctionMessage(pending, extraction.reason));
  }

  if (extraction.status === "cancelled") {
    return finish("cancelled", extraction.reason, [], null);
  }
  if (extraction.status === "failed") {
    return finish("failed", extraction.reason, [], null);
  }
  if (extraction.status === "insufficient_evidence") {
    return finish("insufficient_evidence", extraction.reason, [], null);
  }
  if (extraction.status !== "ok" || extraction.body === null || extraction.body_char_count === null) {
    return finish("invalid", extraction.reason, [], null);
  }

  const incorporated = [...new Set(extraction.cited_ids.filter((id) => pendingIds.has(id)))];
  if (incorporated.length === 0) {
    return finish("not_incorporated", extraction.reason, [], null);
  }

  const at = parseTimestamp(input.at, "$.at");
  const acknowledged = new Set(incorporated);
  const sources = dedupeSources([
    ...delivered.medium.sources,
    ...pending.flatMap((event) => (acknowledged.has(event.event_id) ? event.sources : [])),
    ...input.excerpts.map((excerpt) => excerpt.source),
  ]).slice(0, REPAIR_MAX_SOURCES);

  const next: Memory = parseMemory({
    memory_id: delivered.memory_id,
    uri: delivered.uri,
    scope: delivered.scope,
    title: delivered.title,
    keywords: delivered.keywords,
    revision: input.expected_revision + 1,
    state: "medium_ready",
    medium: {
      body: extraction.body,
      body_char_count: nonWhitespaceCodePointCount(extraction.body),
      sources,
    },
    nav: null,
    hit_count: delivered.hit_count,
    access_count: delivered.access_count,
    last_access_at: delivered.last_access_at,
    created_at: delivered.created_at,
    updated_at: at,
  });

  try {
    const outcome = input.store.updateSummary({
      memory: next,
      expected_revision: input.expected_revision,
      acknowledge_event_ids: incorporated,
      at,
    });
    if (!outcome.saved || outcome.memory === undefined) {
      return finish("conflict", "head_moved_during_repair", [], null);
    }
    return finish("repaired", null, incorporated, outcome.memory);
  } catch (error) {
    // A raced head or an event acknowledged by someone else aborts the whole
    // transaction; the old revision and pending events are untouched.
    return finish("conflict", error instanceof Error ? error.message : String(error), [], null);
  }
}

/**
 * One more ask is worth it for a body the reader rejected, an answer the backend
 * could not parse, or a gateway 5xx; a cancellation is not, and neither is an
 * evidence verdict (`not_incorporated`, `insufficient_evidence`).
 */
function retryableExtraction(extraction: MediumExtraction): boolean {
  if (extraction.status === "invalid") return true;
  const reason = extraction.reason ?? "";
  if (extraction.status !== "failed") return false;
  if (reason.startsWith("model_invalid_response:")) return true;
  // A gateway 5xx is worth one more ask: nothing was written, and the live
  // runs showed the same call failing on 502 and succeeding on the next turn.
  return /http (?:5\d\d)\b/iu.test(reason);
}

function correctionMessage(pending: readonly StaleEventSummary[], reason: string | null): string {
  const ids = pending.map((event) => event.event_id).join(", ");
  const count = /medium_(?:above|below)_(?:max|min):(\d+)/u.exec(reason ?? "")?.[1];
  const size = count === undefined
    ? `The body must be ${MEDIUM_BODY_MIN}-${MEDIUM_BODY_MAX} non-whitespace Unicode code points of plain Chinese prose.`
    : `Your body was ${count} non-whitespace Unicode code points. Rewrite it to ${MEDIUM_BODY_MIN}-${MEDIUM_BODY_MAX}: keep every fact and citation, drop padding and repeated phrasing.`;
  return [
    `Your previous reply was not usable: ${reason ?? "unreadable"}.`,
    `Reply with exactly one JSON object {"body": "..."} and nothing else.`,
    size,
    `It must cite at least one of these pending event ids with [来源:<id>]: ${ids}. No other id may appear.`,
  ].join("\n");
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
