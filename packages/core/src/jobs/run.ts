/**
 * The background runner: claim one due job, generate the nav from the stored
 * medium body, publish the memory, admit it to its project's hotspot pool.
 *
 * Order matters. `setNavigation` is the publishing step (medium_ready →
 * published) and the hotspot join refuses a memory whose nav is missing or
 * bound to another revision, so admission after it is both safe and meaningful.
 * A failure before it leaves the medium summary readable and the job retryable:
 * stage two is independent of stage one by construction, not by convention.
 */

import { memoryUri, type Memory } from "../contracts/index.js";
import { admitHotspotCandidate, type AdmissionResult } from "../hotspots/index.js";
import { RESOLVE_NAV_MAX_OUTPUT_TOKENS } from "../resolver/budget.js";
import type { ModelPort } from "../resolver/types.js";
import type { MemoryStore } from "../storage/store.js";
import { generateNavigation } from "./nav.js";
import {
  SUMMARY_JOB_MAX_ATTEMPTS,
  claimDueSummaryJob,
  completeSummaryJob,
  failSummaryJob,
  type SummaryJob,
} from "./queue.js";

export type JobRunState = "done" | "retried" | "failed" | "cancelled";

export type JobRunResult = {
  job_id: string;
  memory_id: string;
  revision: number;
  state: JobRunState;
  /** Why this run ended as it did; `null` only for a clean `done`. */
  reason: string | null;
  nav: string | null;
  admitted: AdmissionResult | null;
  /** Set when publishing succeeded but pool admission failed; never a retry. */
  admit_error: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  elapsed_ms: number;
};

export type RunDueJobsInput = {
  store: MemoryStore;
  /** `null` reports `model_not_configured`; the jobs stay pending for later. */
  model: ModelPort | null;
  model_id?: string | undefined;
  /** Jobs to attempt in this batch. Default 3, max 20. */
  limit?: number | undefined;
  lease_ms?: number | undefined;
  max_attempts?: number | undefined;
  owner?: string | undefined;
  now?: (() => number) | undefined;
  mono?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
  /** Per-job ceiling; the default keeps the nav call small. */
  max_output_tokens?: number | undefined;
  /** Per-job deadline. Reaching it is reported as `deadline_exceeded`. */
  deadline_ms?: number | undefined;
};

export type RunDueJobsOutcome = {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  results: JobRunResult[];
  elapsed_ms: number;
  missing: string[];
};

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 20;
const DEFAULT_JOB_DEADLINE_MS = 30_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function projectOf(memory: Memory): string | null {
  return memory.scope.kind === "project" ? memory.scope.project_id : null;
}

/**
 * Run a bounded batch. Nothing here throws for an environment problem: a model
 * or store failure becomes a `retried`/`failed` result with its reason, and the
 * remaining jobs are left for the next trigger.
 */
export async function runDueJobs(input: RunDueJobsInput): Promise<RunDueJobsOutcome> {
  const mono = input.mono ?? (() => performance.now());
  const now = input.now ?? (() => Date.now());
  const started = mono();
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(input.limit ?? DEFAULT_LIMIT)));
  const leaseMs = Math.max(1, Math.trunc(input.lease_ms ?? 60_000));
  const maxAttempts = Math.max(1, Math.trunc(input.max_attempts ?? SUMMARY_JOB_MAX_ATTEMPTS));
  const owner = input.owner ?? `jobs-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const maxOutputTokens = Math.max(32, Math.trunc(input.max_output_tokens ?? RESOLVE_NAV_MAX_OUTPUT_TOKENS));
  const deadlineMs = Math.max(1, Math.trunc(input.deadline_ms ?? DEFAULT_JOB_DEADLINE_MS));
  const outcome: RunDueJobsOutcome = {
    claimed: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    results: [],
    elapsed_ms: 0,
    missing: [],
  };

  if (input.model === null) {
    outcome.missing.push("model_not_configured");
    outcome.elapsed_ms = mono() - started;
    return outcome;
  }

  const db = input.store.database();
  for (let index = 0; index < limit; index += 1) {
    if (input.signal?.aborted === true) {
      outcome.missing.push("cancelled");
      break;
    }
    const job = claimDueSummaryJob(db, { now_ms: now(), lease_ms: leaseMs, owner, max_attempts: maxAttempts });
    if (job === null) break;
    outcome.claimed += 1;
    const result = await runOne(input, job, {
      now,
      mono,
      maxAttempts,
      maxOutputTokens,
      deadlineMs,
    });
    outcome.results.push(result);
    if (result.state === "done") outcome.completed += 1;
    else if (result.state === "retried") outcome.retried += 1;
    else if (result.state === "failed") outcome.failed += 1;
    else outcome.missing.push("cancelled");
    // A retryable failure ends this batch: re-claiming the same row in the same
    // run would burn its attempts on one outage. The next trigger retries it.
    if (result.state === "retried") break;
  }
  outcome.elapsed_ms = mono() - started;
  return outcome;
}

async function runOne(
  input: RunDueJobsInput,
  job: SummaryJob,
  options: { now: () => number; mono: () => number; maxAttempts: number; maxOutputTokens: number; deadlineMs: number },
): Promise<JobRunResult> {
  const started = options.mono();
  const base = {
    job_id: job.job_id,
    memory_id: job.memory_id,
    revision: job.revision,
    nav: null as string | null,
    admitted: null as AdmissionResult | null,
    admit_error: null as string | null,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: null as number | null,
  };
  const finish = (state: JobRunState, reason: string | null): JobRunResult => ({
    ...base,
    state,
    reason,
    elapsed_ms: options.mono() - started,
  });

  const db = input.store.database();
  const uri = memoryUri(input.store.storeId, job.memory_id);
  const memory = input.store.readMemory(uri, job.revision);
  if (memory === null) {
    // The row is gone: no attempt count will bring it back, so fail terminally.
    failSummaryJob(db, { job, at: iso(options.now()), error: "memory_missing", max_attempts: 1 });
    return finish("failed", "memory_missing");
  }
  // A completed nav on this revision means an earlier run already published it;
  // publishing twice would be a duplicate, so the job just closes.
  if (memory.nav !== null) {
    completeSummaryJob(db, job, iso(options.now()));
    return { ...finish("done", null), nav: memory.nav.text };
  }

  const model = input.model;
  if (model === null) {
    const stored = failSummaryJob(db, {
      job,
      at: iso(options.now()),
      error: "model_not_configured",
      max_attempts: options.maxAttempts,
    });
    return finish(stored.state === "failed" ? "failed" : "retried", "model_not_configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("job_deadline_exceeded")), options.deadlineMs);
  const signal =
    input.signal === undefined ? controller.signal : AbortSignal.any([input.signal, controller.signal]);
  let generated: Awaited<ReturnType<typeof generateNavigation>>;
  try {
    generated = await generateNavigation({
      model,
      model_id: input.model_id,
      memory,
      max_output_tokens: options.maxOutputTokens,
      signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  base.tokens_in = generated.call.tokens_in;
  base.tokens_out = generated.call.tokens_out;
  base.cost_usd = generated.call.cost_usd;

  if (generated.status !== "ok") {
    const reason = controller.signal.aborted ? "deadline_exceeded" : `nav_${generated.status}:${generated.reason}`;
    const stored = failSummaryJob(db, {
      job,
      at: iso(options.now()),
      error: reason,
      max_attempts: options.maxAttempts,
    });
    return finish(stored.state === "failed" ? "failed" : "retried", reason);
  }
  // A backend that returns after the deadline is not allowed to publish: the
  // batch said the time was up, and that is what it must report.
  if (controller.signal.aborted) {
    const stored = failSummaryJob(db, {
      job,
      at: iso(options.now()),
      error: "deadline_exceeded",
      max_attempts: options.maxAttempts,
    });
    return finish(stored.state === "failed" ? "failed" : "retried", "deadline_exceeded");
  }

  try {
    input.store.setNavigation(uri, job.revision, generated.nav);
  } catch (error) {
    const reason = `publish_failed:${error instanceof Error ? error.message : String(error)}`;
    const stored = failSummaryJob(db, {
      job,
      at: iso(options.now()),
      error: reason,
      max_attempts: options.maxAttempts,
    });
    return finish(stored.state === "failed" ? "failed" : "retried", reason);
  }

  const projectId = projectOf(memory);
  let admitted: AdmissionResult | null = null;
  let admitError: string | null = null;
  if (projectId !== null) {
    try {
      const activity = input.store.readProjectActivity(projectId);
      admitted = admitHotspotCandidate({
        store: input.store,
        project_id: projectId,
        memory_id: job.memory_id,
        activity_seq: activity?.activity_seq ?? 0,
      });
    } catch (error) {
      // Publishing already succeeded; a broken pool must not turn that into a
      // retry that would attempt to publish the same nav again.
      admitError = `admit_failed:${error instanceof Error ? error.message : String(error)}`;
    }
  }

  completeSummaryJob(db, job, iso(options.now()));
  return { ...finish("done", null), nav: generated.nav.text, admitted, admit_error: admitError };
}
