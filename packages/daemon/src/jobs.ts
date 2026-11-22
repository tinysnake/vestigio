/**
 * Durable daemon job store (daemon-architecture.md, persistence section).
 *
 * One SQLite file holds four things: `sessions` (the normalized identity a job
 * belongs to), `jobs` (execution state plus the submission idempotency key),
 * `job_results` (full result waiting for delivery or expiry), and
 * `session_notifications` (the per-session inbox).
 *
 * A job has exactly one visible terminal state, reached by a compare-and-set on
 * `(state, attempt_id)`, so a late or fenced attempt cannot commit. The terminal
 * state, the full result, and the notification are written in one transaction.
 *
 * There are no leases. A claimed job stays `running` until `finish`, `cancel`, or
 * `recover` requeues it after a daemon restart; the caller owns the exclusivity
 * decision that makes `recover` safe.
 *
 * The doc names a separate `job_summaries` table for the long-term compact
 * record. Here that record is the `jobs` row itself: terminalization drops the
 * request payload (`input_json`) and keeps only `jobId`/`sessionRef`/`kind`/
 * `state`/`finished_at`/`resultCode`/idempotency hash. One compact row per job,
 * never a second jobs-sized row beside it.
 */

import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

export const JOB_KINDS = ["maintenance", "detector", "search"] as const;
export type Kind = (typeof JOB_KINDS)[number];

export type SessionKey = { source: string; sessionId: string };

export type JobState = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type TerminalState = "succeeded" | "failed" | "cancelled";

export const DEFAULT_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const DEFAULT_PENDING_LIMIT = 100;
const MAX_PENDING_LIMIT = 1000;
const MAX_DELIVERED_BATCH = 500;

export type JobStoreErrorCode =
  | "invalid_input"
  | "request_conflict"
  | "invalid_cursor"
  | "store_closed";

export class JobStoreError extends Error {
  code: JobStoreErrorCode;

  constructor(code: JobStoreErrorCode, message: string) {
    super(message);
    this.name = "JobStoreError";
    this.code = code;
  }
}

export type JobStoreOptions = {
  /**
   * Wall clock in epoch milliseconds. Tests inject a controllable clock so
   * expiry is deterministic; production uses `Date.now`.
   */
  now?: () => number;
  /** How long a terminal result and its notification stay deliverable. */
  resultTtlMs?: number;
};

export type SubmitResult = {
  jobId: string;
  sessionRef: number;
  /** True when an identical submission already existed (idempotent replay). */
  deduplicated: boolean;
};

export type Claim = {
  jobId: string;
  sessionRef: number;
  session: SessionKey;
  kind: Kind;
  input: unknown;
  attemptId: string;
};

export type FinishOutcome = {
  status: TerminalState;
  resultCode: string;
  result: unknown;
};

export type ActiveJob = {
  visibility: "active";
  jobId: string;
  sessionRef: number;
  session: SessionKey;
  requestId: string;
  kind: Kind;
  state: "queued" | "running" | "waiting";
  attemptId: string | null;
  attempts: number;
  input: unknown;
  createdAt: number;
  updatedAt: number;
};

export type FullJob = {
  visibility: "full";
  jobId: string;
  sessionRef: number;
  session: SessionKey;
  requestId: string;
  kind: Kind;
  state: TerminalState;
  resultCode: string;
  result: unknown;
  createdAt: number;
  finishedAt: number;
};

export type SummaryOnlyJob = {
  visibility: "summary_only";
  jobId: string;
  sessionRef: number;
  session: SessionKey;
  requestId: string;
  kind: Kind;
  state: TerminalState;
  resultCode: string;
  inputHash: string;
  createdAt: number;
  finishedAt: number;
};

export type JobRecord = ActiveJob | FullJob | SummaryOnlyJob;

export type JobSummary = {
  jobId: string;
  sessionRef: number;
  requestId: string;
  kind: Kind;
  state: JobState;
  attemptId: string | null;
  resultCode: string | null;
  hasResult: boolean;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
};

export type JobListPage = {
  jobs: JobSummary[];
  /** Pass back as `after` to continue; null when the session has no more jobs. */
  nextCursor: string | null;
};

export type PendingEvent = {
  eventId: string;
  jobId: string;
  sessionRef: number;
  kind: Kind;
  state: TerminalState;
  resultCode: string;
  result: unknown;
  createdAt: number;
  expiresAt: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_ref INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (source, session_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id      TEXT PRIMARY KEY,
  session_ref INTEGER NOT NULL REFERENCES sessions(session_ref),
  request_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  state       TEXT NOT NULL,
  input_json  TEXT,
  input_hash  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  attempt_id  TEXT,
  owner       TEXT,
  result_code TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE (session_ref, request_id)
);

CREATE INDEX IF NOT EXISTS jobs_claim ON jobs (kind, state, created_at, job_id);
CREATE INDEX IF NOT EXISTS jobs_session ON jobs (session_ref, created_at, job_id);

CREATE TABLE IF NOT EXISTS job_results (
  job_id      TEXT PRIMARY KEY REFERENCES jobs(job_id),
  session_ref INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS job_results_expiry ON job_results (expires_at);

CREATE TABLE IF NOT EXISTS session_notifications (
  event_id    TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(job_id),
  session_ref INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_notifications_pending
  ON session_notifications (session_ref, created_at, event_id);
CREATE INDEX IF NOT EXISTS session_notifications_expiry
  ON session_notifications (expires_at);

CREATE TABLE IF NOT EXISTS job_dependencies (
  parent_id TEXT NOT NULL REFERENCES jobs(job_id),
  child_id TEXT NOT NULL REFERENCES jobs(job_id),
  outcome_json TEXT,
  mandatory INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX IF NOT EXISTS job_dependencies_child ON job_dependencies (child_id);
`;

const CLAIM_SQL = `
UPDATE jobs
   SET state = 'running', attempt_id = ?, owner = ?, attempts = attempts + 1, updated_at = ?
 WHERE job_id = (
   SELECT job_id FROM jobs
    WHERE kind = ? AND state = 'queued'
      AND (? = 0 OR (COALESCE(json_extract(input_json, '$.op') IN (
        'session.input', 'hotspot.commit', 'usage.search_hits', 'usage.memory_read', 'request.write'
      ), 0)) = (? = 1))
    ORDER BY created_at ASC, job_id ASC
    LIMIT 1
 )
   AND state = 'queued'
RETURNING *
`;

type Row = Record<string, SQLOutputValue>;

type JobRow = {
  job_id: string;
  session_ref: number;
  request_id: string;
  kind: Kind;
  state: JobState;
  input_json: string | null;
  input_hash: string;
  attempts: number;
  attempt_id: string | null;
  owner: string | null;
  result_code: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};

function asString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`jobs.${key} is not text`);
  return value;
}

function asNullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`jobs.${key} is not text`);
  return value;
}

function asInt(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`jobs.${key} is not an integer`);
  }
  return value;
}

function asNullableInt(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`jobs.${key} is not an integer`);
  }
  return value;
}

function asKind(value: string): Kind {
  if ((JOB_KINDS as readonly string[]).includes(value)) return value as Kind;
  throw new Error(`jobs.kind has unknown value ${value}`);
}

function asState(value: string): JobState {
  switch (value) {
    case "queued":
    case "running":
    case "waiting":
    case "succeeded":
    case "failed":
    case "cancelled":
      return value;
    default:
      throw new Error(`jobs.state has unknown value ${value}`);
  }
}

function asTerminalState(value: string): TerminalState {
  if (value === "succeeded" || value === "failed" || value === "cancelled") return value;
  throw new Error(`jobs.state is not terminal: ${value}`);
}

function rowToJob(row: Row): JobRow {
  return {
    job_id: asString(row, "job_id"),
    session_ref: asInt(row, "session_ref"),
    request_id: asString(row, "request_id"),
    kind: asKind(asString(row, "kind")),
    state: asState(asString(row, "state")),
    input_json: asNullableString(row, "input_json"),
    input_hash: asString(row, "input_hash"),
    attempts: asInt(row, "attempts"),
    attempt_id: asNullableString(row, "attempt_id"),
    owner: asNullableString(row, "owner"),
    result_code: asNullableString(row, "result_code"),
    created_at: asInt(row, "created_at"),
    updated_at: asInt(row, "updated_at"),
    finished_at: asNullableInt(row, "finished_at"),
  };
}

/** Deterministic per (session, request) id, so a retry resolves to the same job. */
function jobIdFor(sessionRef: number, requestId: string): string {
  return `job-${sha256(`${sessionRef}:${requestId}`).slice(0, 32)}`;
}

function eventIdFor(jobId: string): string {
  return `evt-${sha256(jobId).slice(0, 32)}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonicalize(item)));
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined) continue;
    out[key] = canonicalize(item);
  }
  return out;
}

/**
 * Stable JSON for an arbitrary input value: object keys are sorted recursively
 * so two structurally equal payloads hash and store identically.
 */
function canonicalJson(value: unknown): string {
  const text = JSON.stringify(canonicalize(value));
  return text === undefined ? "null" : text;
}

function parseJson(text: string | null): unknown {
  return text === null ? null : JSON.parse(text);
}

function encodeCursor(createdAt: number, jobId: string): string {
  return Buffer.from(JSON.stringify([createdAt, jobId]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: number; jobId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new JobStoreError("invalid_cursor", "cursor is not a valid job page cursor");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "number" ||
    !Number.isInteger(parsed[0]) ||
    typeof parsed[1] !== "string"
  ) {
    throw new JobStoreError("invalid_cursor", "cursor is not a valid job page cursor");
  }
  return { createdAt: parsed[0], jobId: parsed[1] };
}

function clampLimit(value: number, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new JobStoreError("invalid_input", `${label} must be a non-empty string`);
  }
}

function requireSession(session: SessionKey): void {
  requireNonEmpty(session?.source, "session.source");
  requireNonEmpty(session?.sessionId, "session.sessionId");
}

export class JobStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly resultTtlMs: number;
  private closed = false;

  constructor(path: string, options: JobStoreOptions = {}) {
    requireNonEmpty(path, "path");
    const ttl = options.resultTtlMs ?? DEFAULT_RESULT_TTL_MS;
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new JobStoreError("invalid_input", "resultTtlMs must be a positive integer");
    }
    this.now = options.now ?? Date.now;
    this.resultTtlMs = ttl;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.ensureMandatoryColumn();
  }

  /** Raw handle for a caller that needs its own read transaction. */
  database(): DatabaseSync {
    this.assertOpen();
    return this.db;
  }

  /** Normalize a session key to its internal ref, creating it on first use. */
  ensureSession(session: SessionKey): number {
    this.assertOpen();
    requireSession(session);
    return this.sessionRef(session);
  }

  /**
   * Accept a job. `(session, requestId)` is the idempotency key: the same key
   * with the same canonical input returns the stored job; the same key with a
   * different input raises `request_conflict`.
   */
  submit(session: SessionKey, requestId: string, kind: Kind, input: unknown): SubmitResult {
    this.assertOpen();
    return this.transaction(() => this.insertJob(session, requestId, kind, input));
  }

  private insertJob(session: SessionKey, requestId: string, kind: Kind, input: unknown): SubmitResult {
    this.assertOpen();
    requireSession(session);
    requireNonEmpty(requestId, "requestId");
    if (!(JOB_KINDS as readonly string[]).includes(kind)) {
      throw new JobStoreError("invalid_input", `unknown job kind ${String(kind)}`);
    }
    const encoded = canonicalJson(input);
    const hash = `sha256:${sha256(canonicalJson([kind, input]))}`;
    const sessionRef = this.sessionRef(session);
    const jobId = jobIdFor(sessionRef, requestId);
    const at = this.now();
    const inserted = this.db
      .prepare(
        `INSERT INTO jobs
           (job_id, session_ref, request_id, kind, state, input_json, input_hash, attempts,
            attempt_id, owner, result_code, created_at, updated_at, finished_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, NULL, NULL, NULL, ?, ?, NULL)
         ON CONFLICT (session_ref, request_id) DO NOTHING`,
      )
      .run(jobId, sessionRef, requestId, kind, encoded, hash, at, at);
    const row = this.db
      .prepare("SELECT job_id, input_hash FROM jobs WHERE session_ref = ? AND request_id = ?")
      .get(sessionRef, requestId);
    if (row === undefined) throw new Error("job row vanished right after submit");
    if (asString(row, "input_hash") !== hash) {
      throw new JobStoreError(
        "request_conflict",
        `requestId ${requestId} is already used by this session with different input`,
      );
    }
    return { jobId: asString(row, "job_id"), sessionRef, deduplicated: inserted.changes === 0 };
  }

  /**
   * Claim the oldest queued job of one kind. Atomic: the candidate is chosen and
   * flipped to `running` in a single statement, so two claimers cannot both win.
   */
  claim(kind: Kind, owner: string, lane: "all" | "short" | "agent" = "all"): Claim | undefined {
    this.assertOpen();
    if (!(JOB_KINDS as readonly string[]).includes(kind)) {
      throw new JobStoreError("invalid_input", `unknown job kind ${String(kind)}`);
    }
    requireNonEmpty(owner, "owner");
    const at = this.now();
    const attemptId = `att-${randomUUID()}`;
    const selector = lane === "all" ? 0 : lane === "short" ? 1 : 2;
    const row = this.db.prepare(CLAIM_SQL).get(attemptId, owner, at, kind, selector, selector);
    if (row === undefined) return undefined;
    const job = rowToJob(row);
    const attempt = job.attempt_id;
    if (attempt === null) throw new Error("claimed job has no attempt id");
    return {
      jobId: job.job_id,
      sessionRef: job.session_ref,
      session: this.readSession(job.session_ref),
      kind: job.kind,
      input: parseJson(job.input_json),
      attemptId: attempt,
    };
  }

  /**
   * Commit a terminal state for the attempt that currently owns the job. A stale
   * attempt (fenced by cancel or by a post-restart reclaim) gets `false`.
   */
  childId(jobId: string, key: string): string {
    const parent = this.readJobRow(jobId);
    if (!parent) throw new Error("Unknown parent job");
    return jobIdFor(parent.session_ref, `@child:${jobId}:${key}`);
  }

  waitForChildren(
    job: Claim,
    outcome: FinishOutcome,
    children: readonly { key: string; kind: Kind; input: unknown; mandatory?: boolean }[],
  ): boolean {
    return this.transaction(() => {
      const at = this.now();
      const updated = this.db.prepare(`UPDATE jobs SET state = 'waiting', input_json = ?, attempt_id = NULL,
        owner = NULL, updated_at = ? WHERE job_id = ? AND state = 'running' AND attempt_id = ?`)
        .run(canonicalJson(outcome), at, job.jobId, job.attemptId);
      if (!updated.changes) return false;
      for (const child of children) {
        const { jobId } = this.insertJob(job.session, `@child:${job.jobId}:${child.key}`, child.kind, child.input);
        this.db.prepare("INSERT INTO job_dependencies(parent_id, child_id, mandatory) VALUES (?, ?, ?)")
          .run(job.jobId, jobId, child.mandatory === false ? 0 : 1);
      }
      return true;
    });
  }

  /**
   * `mandatory` arrived after the first job schema, so a store that predates it
   * needs the column added. The default keeps every edge it already holds
   * required, which is exactly the old behavior; the column check makes this
   * safe to run on every open.
   */
  private ensureMandatoryColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(job_dependencies)").all();
    if (columns.some((column) => asString(column, "name") === "mandatory")) return;
    this.db.exec("ALTER TABLE job_dependencies ADD COLUMN mandatory INTEGER NOT NULL DEFAULT 1");
  }

  private advanceParent(childId: string, outcome: FinishOutcome, at: number): void {
    const edge = this.db.prepare("SELECT parent_id FROM job_dependencies WHERE child_id = ?").get(childId);
    if (!edge) return;
    const parentId = asString(edge, "parent_id");
    this.db.prepare("UPDATE job_dependencies SET outcome_json = ? WHERE child_id = ?").run(canonicalJson(outcome), childId);
    const dependencies = this.db.prepare("SELECT child_id, outcome_json, mandatory FROM job_dependencies WHERE parent_id = ? ORDER BY rowid").all(parentId);
    if (dependencies.some((item) => item.outcome_json === null)) return;
    const parent = this.readJobRow(parentId);
    if (!parent || parent.state !== "waiting") throw new Error("Missing waiting parent");
    const original = parseJson(parent.input_json) as FinishOutcome;
    const children = dependencies.map((item) => ({
      jobId: asString(item, "child_id"),
      ...parseJson(asString(item, "outcome_json")) as FinishOutcome,
      mandatory: asInt(item, "mandatory") !== 0,
    }));
    // Only a required child decides the parent. An accounting edge that failed
    // is reported in `children` but cannot invalidate an answer already built.
    const failed = children.some((item) => item.mandatory && item.status !== "succeeded");
    const final: FinishOutcome = {
      status: failed ? "failed" : original.status,
      resultCode: failed ? "dependency_failed" : original.resultCode,
      result: { ...(original.result as Record<string, unknown>), children },
    };
    this.db.prepare(`UPDATE jobs SET state = ?, result_code = ?, input_json = NULL, finished_at = ?, updated_at = ?
      WHERE job_id = ?`).run(final.status, final.resultCode, at, at, parentId);
    this.db.prepare("DELETE FROM job_dependencies WHERE parent_id = ?").run(parentId);
    this.writeTerminal(parent, at, canonicalJson(final.result));
    this.advanceParent(parentId, final, at);
  }

  finish(jobId: string, attemptId: string, outcome: FinishOutcome): boolean {
    this.assertOpen();
    requireNonEmpty(jobId, "jobId");
    requireNonEmpty(attemptId, "attemptId");
    asTerminalState(outcome.status);
    requireNonEmpty(outcome.resultCode, "outcome.resultCode");
    const encoded = canonicalJson(outcome.result);
    const at = this.now();
    return this.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE jobs
              SET state = ?, result_code = ?, input_json = NULL, attempt_id = NULL, owner = NULL,
                  finished_at = ?, updated_at = ?
            WHERE job_id = ? AND state = 'running' AND attempt_id = ?`,
        )
        .run(outcome.status, outcome.resultCode, at, at, jobId, attemptId);
      if (updated.changes === 0) return false;
      const job = this.readJobRow(jobId);
      if (job === null) throw new Error(`job ${jobId} vanished while finishing`);
      this.writeTerminal(job, at, encoded);
      this.advanceParent(jobId, outcome, at);
      return true;
    });
  }

  /**
   * Move a queued or running job to `cancelled`, fencing any live attempt, and
   * publish its notification. Returns false when the job is missing or already
   * terminal, so the transition happens at most once.
   */
  cancel(jobId: string, resultCode = "cancelled", result: unknown = null): boolean {
    this.assertOpen();
    requireNonEmpty(jobId, "jobId");
    requireNonEmpty(resultCode, "resultCode");
    const encoded = canonicalJson(result);
    const at = this.now();
    return this.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE jobs
              SET state = 'cancelled', result_code = ?, input_json = NULL, attempt_id = NULL,
                  owner = NULL, finished_at = ?, updated_at = ?
            WHERE job_id = ? AND state IN ('queued', 'running', 'waiting')`,
        )
        .run(resultCode, at, at, jobId);
      if (updated.changes === 0) return false;
      const job = this.readJobRow(jobId);
      if (job === null) throw new Error(`job ${jobId} vanished while cancelling`);
      this.db.prepare("DELETE FROM job_dependencies WHERE parent_id = ?").run(jobId);
      this.writeTerminal(job, at, encoded);
      this.advanceParent(jobId, { status: "cancelled", resultCode, result }, at);
      return true;
    });
  }

  /**
   * Requeue every `running` job after a daemon restart. The caller must hold the
   * kernel's exclusivity lock and must have confirmed the old executor stopped;
   * there are no leases, so this is the only thing that revives a stuck job.
   */
  recover(): number {
    this.assertOpen();
    const at = this.now();
    const updated = this.db
      .prepare(
        `UPDATE jobs
            SET state = 'queued', attempt_id = NULL, owner = NULL, updated_at = ?
          WHERE state = 'running'`,
      )
      .run(at);
    return Number(updated.changes);
  }

  /** Read one job: active while queued/running, else full or summary_only. */
  get(jobId: string): JobRecord | undefined {
    this.assertOpen();
    requireNonEmpty(jobId, "jobId");
    const job = this.readJobRow(jobId);
    if (job === null) return undefined;
    const session = this.readSession(job.session_ref);
    const state = job.state;
    if (state === "queued" || state === "running" || state === "waiting") {
      return {
        visibility: "active",
        jobId: job.job_id,
        sessionRef: job.session_ref,
        session,
        requestId: job.request_id,
        kind: job.kind,
        state,
        attemptId: job.attempt_id,
        attempts: job.attempts,
        input: parseJson(job.input_json),
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      };
    }
    const resultCode = job.result_code ?? "";
    const finishedAt = job.finished_at ?? job.updated_at;
    const result = this.db
      .prepare("SELECT result_json, expires_at FROM job_results WHERE job_id = ?")
      .get(jobId);
    if (result !== undefined && asInt(result, "expires_at") > this.now()) {
      return {
        visibility: "full",
        jobId: job.job_id,
        sessionRef: job.session_ref,
        session,
        requestId: job.request_id,
        kind: job.kind,
        state,
        resultCode,
        result: parseJson(asString(result, "result_json")),
        createdAt: job.created_at,
        finishedAt,
      };
    }
    return {
      visibility: "summary_only",
      jobId: job.job_id,
      sessionRef: job.session_ref,
      session,
      requestId: job.request_id,
      kind: job.kind,
      state,
      resultCode,
      inputHash: job.input_hash,
      createdAt: job.created_at,
      finishedAt,
    };
  }

  /**
   * Page a session's job records, oldest first, ordered by `(created_at, jobId)`.
   * `after` is the opaque cursor from the previous page; it stays valid across
   * restarts because it encodes the sort key, not an offset.
   */
  list(sessionRef: number, after?: string, limit = DEFAULT_LIST_LIMIT): JobListPage {
    this.assertOpen();
    if (!Number.isInteger(sessionRef) || sessionRef <= 0) {
      throw new JobStoreError("invalid_input", "sessionRef must be a positive integer");
    }
    const size = clampLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const params: (string | number)[] = [this.now(), sessionRef];
    let where = "j.session_ref = ?";
    if (after !== undefined) {
      const cursor = decodeCursor(after);
      where += " AND (j.created_at > ? OR (j.created_at = ? AND j.job_id > ?))";
      params.push(cursor.createdAt, cursor.createdAt, cursor.jobId);
    }
    const rows = this.db
      .prepare(
        `SELECT j.job_id, j.session_ref, j.request_id, j.kind, j.state, j.attempt_id,
                j.result_code, j.created_at, j.updated_at, j.finished_at,
                EXISTS (
                  SELECT 1 FROM job_results r
                   WHERE r.job_id = j.job_id AND r.expires_at > ?
                ) AS has_result
           FROM jobs j
          WHERE ${where}
          ORDER BY j.created_at ASC, j.job_id ASC
          LIMIT ?`,
      )
      .all(...params, size + 1);
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > size && last !== undefined ? encodeCursor(asInt(last, "created_at"), asString(last, "job_id")) : null;
    return { jobs: page.map(rowToSummary), nextCursor };
  }

  /**
   * Undelivered, unexpired notifications for one session, each with its full
   * result. Reading does not consume; `delivered` is the only reclaim path.
   */
  pending(sessionRef: number, limit = DEFAULT_PENDING_LIMIT): PendingEvent[] {
    this.assertOpen();
    if (!Number.isInteger(sessionRef) || sessionRef <= 0) {
      throw new JobStoreError("invalid_input", "sessionRef must be a positive integer");
    }
    const size = clampLimit(limit, DEFAULT_PENDING_LIMIT, MAX_PENDING_LIMIT);
    const rows = this.db
      .prepare(
        `SELECT n.event_id, n.job_id, n.session_ref, n.created_at, n.expires_at,
                j.kind, j.state, j.result_code, r.result_json
           FROM session_notifications n
           JOIN jobs j ON j.job_id = n.job_id
           JOIN job_results r ON r.job_id = n.job_id
          WHERE n.session_ref = ? AND n.expires_at > ?
          ORDER BY n.created_at ASC, n.event_id ASC
          LIMIT ?`,
      )
      .all(sessionRef, this.now(), size);
    return rows.map((row) => {
      const state = asTerminalState(asString(row, "state"));
      return {
        eventId: asString(row, "event_id"),
        jobId: asString(row, "job_id"),
        sessionRef: asInt(row, "session_ref"),
        kind: asKind(asString(row, "kind")),
        state,
        resultCode: asNullableString(row, "result_code") ?? "",
        result: parseJson(asString(row, "result_json")),
        createdAt: asInt(row, "created_at"),
        expiresAt: asInt(row, "expires_at"),
      };
    });
  }

  /**
   * Reclaim notifications the daemon has successfully written out, together
   * with their full results, in one transaction. The compact job row survives.
   * Returns how many notifications were removed.
   */
  delivered(eventIds: readonly string[]): number {
    this.assertOpen();
    const ids = [...new Set(eventIds.filter((id) => typeof id === "string" && id.length > 0))];
    if (ids.length === 0) return 0;
    return this.transaction(() => {
      let removed = 0;
      for (let offset = 0; offset < ids.length; offset += MAX_DELIVERED_BATCH) {
        const chunk = ids.slice(offset, offset + MAX_DELIVERED_BATCH);
        const placeholders = chunk.map(() => "?").join(", ");
        const jobRows = this.db
          .prepare(`SELECT job_id FROM session_notifications WHERE event_id IN (${placeholders})`)
          .all(...chunk);
        const jobIds = [...new Set(jobRows.map((row) => asString(row, "job_id")))];
        const deleted = this.db
          .prepare(`DELETE FROM session_notifications WHERE event_id IN (${placeholders})`)
          .run(...chunk);
        removed += Number(deleted.changes);
        if (jobIds.length > 0) {
          const jobPlaceholders = jobIds.map(() => "?").join(", ");
          this.db.prepare(`DELETE FROM job_results WHERE job_id IN (${jobPlaceholders})`).run(...jobIds);
        }
      }
      return removed;
    });
  }

  /**
   * Delete notifications and full results past their `expiresAt`. Expiry is not
   * failure: the compact job row keeps reporting the terminal state. Idempotent.
   */
  expire(): number {
    this.assertOpen();
    const at = this.now();
    return this.transaction(() => {
      const deleted = this.db
        .prepare("DELETE FROM session_notifications WHERE expires_at <= ?")
        .run(at);
      this.db.prepare("DELETE FROM job_results WHERE expires_at <= ?").run(at);
      return Number(deleted.changes);
    });
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private sessionRef(session: SessionKey): number {
    this.db
      .prepare(
        `INSERT INTO sessions (source, session_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT (source, session_id) DO NOTHING`,
      )
      .run(session.source, session.sessionId, this.now());
    const row = this.db
      .prepare("SELECT session_ref FROM sessions WHERE source = ? AND session_id = ?")
      .get(session.source, session.sessionId);
    if (row === undefined) throw new Error("session row vanished right after insert");
    return asInt(row, "session_ref");
  }

  private readSession(sessionRef: number): SessionKey {
    const row = this.db
      .prepare("SELECT source, session_id FROM sessions WHERE session_ref = ?")
      .get(sessionRef);
    if (row === undefined) throw new Error(`session ${sessionRef} not found`);
    return { source: asString(row, "source"), sessionId: asString(row, "session_id") };
  }

  private readJobRow(jobId: string): JobRow | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId);
    return row === undefined ? null : rowToJob(row);
  }

  private writeTerminal(job: JobRow, at: number, resultJson: string): void {
    const expiresAt = at + this.resultTtlMs;
    this.db
      .prepare(
        `INSERT INTO job_results (job_id, session_ref, result_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(job.job_id, job.session_ref, resultJson, at, expiresAt);
    this.db
      .prepare(
        `INSERT INTO session_notifications (event_id, job_id, session_ref, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(eventIdFor(job.job_id), job.job_id, job.session_ref, at, expiresAt);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The transaction is already gone; surface the original error.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new JobStoreError("store_closed", "JobStore is closed");
  }
}

function rowToSummary(row: Row): JobSummary {
  return {
    jobId: asString(row, "job_id"),
    sessionRef: asInt(row, "session_ref"),
    requestId: asString(row, "request_id"),
    kind: asKind(asString(row, "kind")),
    state: asState(asString(row, "state")),
    attemptId: asNullableString(row, "attempt_id"),
    resultCode: asNullableString(row, "result_code"),
    hasResult: asInt(row, "has_result") === 1,
    createdAt: asInt(row, "created_at"),
    updatedAt: asInt(row, "updated_at"),
    finishedAt: asNullableInt(row, "finished_at"),
  };
}
