/**
 * The write half of a deferred resolve.
 *
 * `resolveMemory({ defer_persistence: true })` returns the read answer plus a
 * `PendingResolvePersistence` request instead of writing. This function runs
 * that request later, from whatever boundary the caller serializes writes
 * behind (a daemon maintenance job, a queue worker).
 *
 * The request is self-contained by construction: it carries the question, the
 * answer, the bounded evidence and the candidate cards, and nothing that ties
 * it to the process that produced it. The budget ledger and the deadline clock
 * are deliberately absent, so this side rebuilds a fresh ledger and treats the
 * job as unbounded in wall time while still enforcing the call and token caps.
 */

import { DEFAULT_RESOLVE_BUDGET, ResolveBudgetLedger } from "./budget.js";
import { persistResolvedMemory, type PersistResolveOutcome } from "./persist.js";
import type { ModelPort, PendingResolvePersistence } from "./types.js";
import type { MemoryStore } from "../storage/store.js";

export type PersistPendingResolveInput = {
  store: MemoryStore;
  model: ModelPort;
  model_id?: string | undefined;
  request: PendingResolvePersistence;
  signal: AbortSignal;
  wall_now?: (() => number) | undefined;
  mono_now?: (() => number) | undefined;
};

export async function persistPendingResolve(
  input: PersistPendingResolveInput,
): Promise<PersistResolveOutcome> {
  const wall = input.wall_now ?? (() => Date.now());
  const mono = input.mono_now ?? (() => performance.now());
  const ledger = new ResolveBudgetLedger(DEFAULT_RESOLVE_BUDGET);
  return persistResolvedMemory({
    store: input.store,
    question: input.request.question,
    scope: input.request.scope,
    answer: input.request.answer,
    evidence: input.request.evidence,
    excerpts: input.request.excerpts,
    cards: input.request.cards,
    model: input.model,
    model_id: input.model_id,
    ledger,
    signal: input.signal,
    // No overall model deadline: the maintenance boundary owns scheduling, and
    // "no overall model deadlines" is a daemon-level guarantee. The call and
    // token ceilings inside the ledger still bound what the summary may spend.
    remaining_ms: () => Number.POSITIVE_INFINITY,
    request_id: input.request.request_id,
    session_id: input.request.session_id,
    wall_now: wall,
    mono_now: mono,
    call_index: input.request.call_index,
  });
}
