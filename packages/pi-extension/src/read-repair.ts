/**
 * Repair on read: a `memory_read` of a stale memory folds its pending stale
 * events into the same memory, then publishes it.
 *
 * This module adds no second repair path. The rewrite is
 * `repairStaleMemory` from core (the resolver's path), and the publish is
 * `runDueJobs` scoped to the memory and the revision the repair just saved.
 * What lives here is the ordering and the honest report:
 *
 * - the repair reads the *delivered* revision, so a read never rewrites a
 *   revision the agent did not see;
 * - at most one attempt per memory per session;
 * - the whole thing is bounded by `READ_REPAIR_DEADLINE_MS`;
 * - if the nav step fails, the new body stays and the queued job stays, and the
 *   read says `nav_pending` — never `repaired`, because a memory without a nav
 *   bound to its head is not findable by search yet.
 */

import type { Freshness, MemoryUri, StaleEventSummary } from "@vestigio/core";
import type { ModelPort, RepairOutcome } from "@vestigio/core/resolver";
import { repairStaleMemory } from "@vestigio/core/resolver";
import { runDueJobs } from "@vestigio/core/jobs";
import type { MemoryStore } from "@vestigio/core/storage";
import { errorText, type VestigioState } from "./state.js";

/**
 * Hard ceiling for the whole read-triggered repair, both model calls included.
 * Measured on the live gateway: a repair completion took 20-30 s typically and
 * was still generating at 90 s on one run, which aborted the call and lost the
 * repair. 150 s covers the observed tail; above that the read reports
 * `repair_failed` rather than blocking the turn forever.
 */
export const READ_REPAIR_DEADLINE_MS = 150_000;

export type ReadRepairStatus = "repaired" | "nav_pending" | "repair_failed";

export type ReadRepairReport = {
  status: ReadRepairStatus;
  /** `null` only for a clean `repaired`. */
  reason: string | null;
  /** The revision the read delivered and the repair used as its base. */
  from_revision: number;
  /** The head the repair saved, or null when nothing was written. */
  revision: number | null;
  acknowledged_event_ids: string[];
  /** The nav step's outcome for a landed repair. */
  nav_status: "published" | "pending" | null;
};

export type ReadRepairInput = {
  state: VestigioState;
  store: MemoryStore;
  uri: MemoryUri;
  freshness: Freshness;
  project_id: string;
  at: string;
  /** The tool call's own cancellation signal. */
  signal: AbortSignal | undefined;
};

/**
 * Returns null when no attempt should be made (already attempted this session,
 * or no model configured). A returned report is always worth telling the agent
 * about: it either landed, landed without its nav, or wrote nothing.
 */
export async function repairOnRead(input: ReadRepairInput): Promise<ReadRepairReport | null> {
  const { state, store, uri, freshness } = input;
  const memoryId = freshness.memory_id;
  const pending = freshness.pending.filter((event) => event.event_id.length > 0);
  if (pending.length === 0 || state.repairAttemptedFor(memoryId)) return null;
  const model = state.modelPort();
  if (model === null) {
    return {
      status: "repair_failed",
      reason: `model_unavailable:${state.modelSkipReason() ?? "unknown"}`,
      from_revision: freshness.delivered_revision,
      revision: null,
      acknowledged_event_ids: [],
      nav_status: null,
    };
  }

  state.noteRepairAttempt(memoryId);
  const deadline = AbortSignal.timeout(READ_REPAIR_DEADLINE_MS);
  const signal = input.signal === undefined ? deadline : AbortSignal.any([deadline, input.signal]);
  const failed = (reason: string): ReadRepairReport => ({
    status: "repair_failed",
    reason,
    from_revision: freshness.delivered_revision,
    revision: null,
    acknowledged_event_ids: [],
    nav_status: null,
  });

  let repaired: RepairOutcome;
  try {
    repaired = await repairStaleMemory({
      store,
      card: { uri, revision: freshness.delivered_revision },
      pending: freshness.pending,
      // The read has no answer of its own; the pending events are the change.
      answer: describePending(pending),
      // The events already carry their saved excerpts; no extra history read.
      excerpts: [],
      expected_revision: freshness.delivered_revision,
      model,
      model_id: state.config.model_id,
      signal,
      at: input.at,
      project: input.project_id,
    });
  } catch (error) {
    return failed(`repair_threw:${errorText(error)}`);
  }

  if (repaired.status !== "repaired" || repaired.memory === null) {
    // A cancellation this repair caused is a deadline, not a signal from the turn.
    if (repaired.status === "cancelled" && deadline.aborted) return failed("deadline_exceeded");
    return failed(`repair_${repaired.status}${repaired.reason === null ? "" : `:${repaired.reason}`}`);
  }
  const revision = repaired.memory.revision;
  if (signal.aborted) {
    // The body is saved; the nav step is left to the queued job.
    return {
      status: "nav_pending",
      reason: "deadline_exceeded",
      from_revision: freshness.delivered_revision,
      revision,
      acknowledged_event_ids: repaired.incorporated_event_ids,
      nav_status: "pending",
    };
  }

  const nav = await publish(input, model, memoryId, revision, signal);
  return {
    status: nav ? "repaired" : "nav_pending",
    reason: nav ? null : navReason(input, revision),
    from_revision: freshness.delivered_revision,
    revision,
    acknowledged_event_ids: repaired.incorporated_event_ids,
    nav_status: nav ? "published" : "pending",
  };
}

/**
 * Run the memory's own queued nav job. A failed nav is not an error the read
 * hides: the body is saved, the job stays queued, and search cannot find the
 * memory until the nav is bound to this revision.
 */
async function publish(
  input: ReadRepairInput,
  model: ModelPort,
  memoryId: string,
  revision: number,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const outcome = await runDueJobs({
      store: input.store,
      model,
      model_id: input.state.config.model_id,
      limit: 1,
      memory_id: memoryId,
      revision,
      signal,
      deadline_ms: READ_REPAIR_DEADLINE_MS,
    });
    const result = outcome.results.find((entry) => entry.memory_id === memoryId && entry.revision === revision);
    if (result?.state !== "done") return false;
  } catch (error) {
    input.state.writeDecision({
      ts: input.at,
      kind: "error",
      status: "read_repair_nav_failed",
      session_id: input.state.currentSessionId,
      project_id: input.project_id,
      error: errorText(error),
    });
    return false;
  }
  const stored = readHead(input.store, input.uri);
  return stored?.state === "published" && stored.nav !== null && stored.nav.source_revision === revision;
}

function navReason(input: ReadRepairInput, revision: number): string {
  const stored = readHead(input.store, input.uri);
  if (stored === null || stored.revision !== revision) return "head_moved_after_repair";
  if (stored.nav === null) return "nav_not_generated";
  if (stored.nav.source_revision !== revision) return `nav_bound_to_r${stored.nav.source_revision}`;
  return "nav_not_published";
}

function readHead(store: MemoryStore, uri: MemoryUri): { state: string; revision: number; nav: { source_revision: number } | null } | null {
  try {
    return store.readMemory(uri);
  } catch {
    return null;
  }
}

/**
 * The repair prompt's "question": what the read cannot fix by itself. The
 * pending events are already in the evidence list with their excerpts, so this
 * only has to name the task.
 */
function describePending(pending: readonly StaleEventSummary[]): string {
  return `This memory was read while ${pending.length} later change(s) were still unabsorbed; fold them into the same summary.`;
}
