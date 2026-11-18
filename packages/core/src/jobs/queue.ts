/**
 * Durable short-summary job queue (PR-07, stage two).
 *
 * The queue lives beside the memories in the same SQLite file and is written
 * through the store's own connection, so enqueueing happens inside the medium
 * save's transaction: a saved memory always has its pending job (or a finished
 * one). Claiming is a compare-and-set on the lease, never a read-then-write, so
 * two workers cannot both own a job and a crashed worker's lease expires into a
 * retry instead of a duplicate.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { MemoryId, Revision } from "../contracts/index.js";

export const SUMMARY_JOB_MAX_ATTEMPTS = 3;
export const DEFAULT_SUMMARY_JOB_LEASE_MS = 60_000;

export type SummaryJobState = "pending" | "running" | "done" | "failed";

export type SummaryJob = {
  job_id: string;
  memory_id: MemoryId;
  revision: Revision;
  state: SummaryJobState;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type Row = Record<string, SQLOutputValue>;

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`summary_jobs.${key} is not text`);
  return value;
}

function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`summary_jobs.${key} is not text`);
  return value;
}

function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`summary_jobs.${key} is not an integer`);
  }
  return value;
}

function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`summary_jobs.${key} is not an integer`);
  }
  return value;
}

function rowToJob(row: Row): SummaryJob {
  const state = str(row, "state");
  if (state !== "pending" && state !== "running" && state !== "done" && state !== "failed") {
    throw new Error(`summary_jobs.state has unknown value ${state}`);
  }
  return {
    job_id: str(row, "job_id"),
    memory_id: str(row, "memory_id"),
    revision: num(row, "revision"),
    state,
    attempts: num(row, "attempts"),
    lease_owner: strOrNull(row, "lease_owner"),
    lease_expires_at: numOrNull(row, "lease_expires_at"),
    last_error: strOrNull(row, "last_error"),
    created_at: str(row, "created_at"),
    updated_at: str(row, "updated_at"),
  };
}

/** Stable id for one (memory, revision): re-enqueueing is a no-op, never a twin. */
export function summaryJobId(memoryId: MemoryId, revision: Revision): string {
  return `job-${createHash("sha256").update(`${memoryId}:${revision}`, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * Insert the pending job if it does not exist yet. Safe inside an open write
 * transaction (that is how `saveMemory`'s `beforeCommit` uses it) and outside
 * one, where it runs as a single autocommitted statement.
 */
export function enqueueSummaryJob(
  db: DatabaseSync,
  input: { memory_id: MemoryId; revision: Revision; at: string },
): SummaryJob {
  db.prepare(
    `INSERT OR IGNORE INTO summary_jobs
       (job_id, memory_id, revision, state, attempts, lease_owner, lease_expires_at,
        last_error, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?)`,
  ).run(summaryJobId(input.memory_id, input.revision), input.memory_id, input.revision, input.at, input.at);
  const job = readSummaryJob(db, input.memory_id, input.revision);
  if (job === null) throw new Error(`summary job for ${input.memory_id} r${input.revision} was not stored`);
  return job;
}

export function readSummaryJob(db: DatabaseSync, memoryId: MemoryId, revision: Revision): SummaryJob | null {
  const row = db
    .prepare("SELECT * FROM summary_jobs WHERE memory_id = ? AND revision = ?")
    .get(memoryId, revision);
  return row === undefined ? null : rowToJob(row);
}

export function listSummaryJobs(db: DatabaseSync, limit = 50): SummaryJob[] {
  return db
    .prepare("SELECT * FROM summary_jobs ORDER BY created_at ASC, job_id ASC LIMIT ?")
    .all(limit)
    .map(rowToJob);
}

export function countSummaryJobs(db: DatabaseSync, state?: SummaryJobState): number {
  const row =
    state === undefined
      ? db.prepare("SELECT COUNT(*) AS n FROM summary_jobs").get()
      : db.prepare("SELECT COUNT(*) AS n FROM summary_jobs WHERE state = ?").get(state);
  return row === undefined ? 0 : num(row, "n");
}

/**
 * Claim one due job: a pending row, or a running row whose lease expired.
 *
 * The update re-states the observed state, attempt count and lease as its
 * predicate, so a concurrent claim that won the race makes this one a no-op and
 * the loop tries the next candidate. `attempts` increments on every claim; an
 * expired lease is therefore a retry of the same row, never a second row.
 */
export function claimDueSummaryJob(
  db: DatabaseSync,
  input: {
    now_ms: number;
    lease_ms?: number;
    owner: string;
    max_attempts?: number;
    /** Claim only this memory's job; both narrow the same compare-and-set. */
    memory_id?: string | undefined;
    revision?: number | undefined;
  },
): SummaryJob | null {
  const leaseMs = Math.max(1, Math.trunc(input.lease_ms ?? DEFAULT_SUMMARY_JOB_LEASE_MS));
  const maxAttempts = Math.max(1, Math.trunc(input.max_attempts ?? SUMMARY_JOB_MAX_ATTEMPTS));
  const at = new Date(input.now_ms).toISOString();
  const filters: string[] = [];
  const params: (string | number)[] = [maxAttempts, input.now_ms];
  if (input.memory_id !== undefined) {
    filters.push("AND memory_id = ?");
    params.push(input.memory_id);
  }
  if (input.revision !== undefined) {
    filters.push("AND revision = ?");
    params.push(input.revision);
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = db
      .prepare(
        `SELECT * FROM summary_jobs
          WHERE attempts < ?
            AND (state = 'pending'
                 OR (state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
          ${filters.join("\n          ")}
          ORDER BY created_at ASC, job_id ASC
          LIMIT 1`,
      )
      .get(...params);
    if (candidate === undefined) {
      return null;
    }
    const job = rowToJob(candidate);
    const result = db
      .prepare(
        `UPDATE summary_jobs
            SET state = 'running', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1,
                updated_at = ?
          WHERE job_id = ? AND state = ? AND attempts = ?
            AND (lease_expires_at IS NULL OR lease_expires_at = ?)
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(
        input.owner,
        input.now_ms + leaseMs,
        at,
        job.job_id,
        job.state,
        job.attempts,
        job.lease_expires_at,
        input.now_ms,
      );
    if (Number(result.changes) === 1) {
      return readSummaryJobById(db, job.job_id);
    }
  }
  return null;
}

export function readSummaryJobById(db: DatabaseSync, jobId: string): SummaryJob | null {
  const row = db.prepare("SELECT * FROM summary_jobs WHERE job_id = ?").get(jobId);
  return row === undefined ? null : rowToJob(row);
}

export function completeSummaryJob(db: DatabaseSync, job: SummaryJob, at: string): void {
  db.prepare(
    `UPDATE summary_jobs
        SET state = 'done', lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
      WHERE job_id = ?`,
  ).run(at, job.job_id);
}

/**
 * Record a failed attempt. Below the attempt ceiling the job returns to
 * `pending` (its lease cleared) so the next run retries it; at the ceiling it
 * becomes `failed` and keeps `last_error` for the report.
 */
export function failSummaryJob(
  db: DatabaseSync,
  input: { job: SummaryJob; at: string; error: string; max_attempts?: number },
): SummaryJob {
  const maxAttempts = Math.max(1, Math.trunc(input.max_attempts ?? SUMMARY_JOB_MAX_ATTEMPTS));
  const exhausted = input.job.attempts >= maxAttempts;
  db.prepare(
    `UPDATE summary_jobs
        SET state = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE job_id = ?`,
  ).run(exhausted ? "failed" : "pending", input.error.slice(0, 2000), input.at, input.job.job_id);
  const stored = readSummaryJobById(db, input.job.job_id);
  if (stored === null) throw new Error(`summary job ${input.job.job_id} vanished`);
  return stored;
}
