/**
 * `@vestigio/core/jobs` — the durable short-summary job (PR-07, stage two).
 *
 * Enqueueing is idempotent on (memory_id, revision) and happens in the medium
 * save's transaction. Running is lease-based: one due job per claim, retried on
 * an expired lease, failed only when the attempt ceiling is reached.
 */

export {
  DEFAULT_SUMMARY_JOB_LEASE_MS,
  SUMMARY_JOB_MAX_ATTEMPTS,
  claimDueSummaryJob,
  completeSummaryJob,
  countSummaryJobs,
  enqueueSummaryJob,
  failSummaryJob,
  listSummaryJobs,
  readSummaryJob,
  readSummaryJobById,
  summaryJobId,
} from "./queue.js";
export type { SummaryJob, SummaryJobState } from "./queue.js";
export { NAV_SUMMARY_SYSTEM_PROMPT, buildNavUserMessage, generateNavigation } from "./nav.js";
export type { NavCall, NavExtraction } from "./nav.js";
export { runDueJobs } from "./run.js";
export type { JobRunResult, JobRunState, RunDueJobsInput, RunDueJobsOutcome } from "./run.js";
