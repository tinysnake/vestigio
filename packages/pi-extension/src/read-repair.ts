import type { MemoryUri } from "@vestigio/core";
import type { ModelPort } from "@vestigio/core/resolver";
import { runDueJobs } from "@vestigio/core/jobs";
import type { MemoryStore } from "@vestigio/core/storage";
import { errorText, type VestigioState } from "./state.js";

/**
 * Hard ceiling for one nav job, the single model call a publication runs.
 * Measured on the live gateway: a nav completion took 20-30 s typically and was
 * still generating at 90 s on one run, which aborted the call and lost the
 * publication. 150 s covers the observed tail; above that the job reports
 * `deadline_exceeded` rather than blocking the caller forever.
 */
const NAV_PUBLISH_DEADLINE_MS = 150_000;

/** The store facts a publication needs; `read-repair` and `memory_resolve`
 * share them, which is why this is not private to the read path. */
export type PublishRevisionInput = {
  state: VestigioState;
  store: MemoryStore;
  uri: MemoryUri;
  project_id: string;
  at: string;
};

export type PublishRevisionOutcome = {
  published: boolean;
  /** Why the memory is still not searchable; `null` when `published`. */
  reason: string | null;
};

/**
 * Run the memory's own queued nav job and verify the head is searchable.
 *
 * One attempt, scoped to `memoryId`/`revision`, bounded by
 * `NAV_PUBLISH_DEADLINE_MS`. A failed nav is not an error the caller hides:
 * the body is saved, the job stays queued, and search cannot find the memory
 * until the nav is bound to this revision. Callers that just wrote the memory
 * use the returned reason instead of claiming it is findable.
 */
export async function publishRevision(
  input: PublishRevisionInput,
  model: ModelPort,
  memoryId: string,
  revision: number,
  signal: AbortSignal | undefined,
): Promise<PublishRevisionOutcome> {
  try {
    const outcome = await runDueJobs({
      store: input.store,
      model,
      model_id: input.state.config.model_id,
      limit: 1,
      memory_id: memoryId,
      revision,
      ...(signal === undefined ? {} : { signal }),
      deadline_ms: NAV_PUBLISH_DEADLINE_MS,
    });
    const result = outcome.results.find((entry) => entry.memory_id === memoryId && entry.revision === revision);
    if (result?.state !== "done") {
      return { published: false, reason: navReason(input, revision) };
    }
  } catch (error) {
    input.state.writeDecision({
      ts: input.at,
      kind: "error",
      status: "read_repair_nav_failed",
      session_id: input.state.currentSessionId,
      project_id: input.project_id,
      error: errorText(error),
    });
    return { published: false, reason: navReason(input, revision) };
  }
  const stored = readHead(input.store, input.uri);
  const published = stored?.state === "published" && stored.nav !== null && stored.nav.source_revision === revision;
  return { published, reason: published ? null : navReason(input, revision) };
}

function navReason(input: PublishRevisionInput, revision: number): string {
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
