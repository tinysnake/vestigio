/**
 * Durable proactive-memory requests.
 *
 * A request row carries the exact source snapshot and scope the agent
 * resolved against the active branch, not a model-provided "confirmed" flag.
 * The row is claimed with a lease, so a crash or a failed model call retries
 * the same request instead of writing a second memory.
 *
 * This module owns only the queue. Composing and validating the summary lives
 * in `compose.ts`; both share the row shape below.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  parseScope,
  parseSourceRef,
  parseTimestamp,
  serializeSourceRef,
  type MemoryUri,
  type NavigationStatus,
  type Revision,
  type Scope,
  type SourceRef,
} from "../contracts/index.js";
import { StorageError } from "../storage/errors.js";

export const MEMORY_REQUEST_MAX_ATTEMPTS = 3;
export const MEMORY_REQUEST_LEASE_MS = 60_000;
export const MEMORY_REQUEST_RETRY_MS = 30_000;
export const MEMORY_REQUEST_MAX_EVIDENCE = 8;
/** Per-evidence excerpt stored with the fixed source snapshot. */
export const MEMORY_REQUEST_MAX_EXCERPT = 2000;

export type MemoryRequestStatus =
  | "pending"
  | "processing"
  | "saved"
  | "merged"
  | "failed"
  | "rejected";

export type MemoryRequestEvidence = {
  /** The exact branch entry this request was approved against. */
  source: SourceRef;
  /** Bounded text captured at acceptance time; the session may move on. */
  excerpt: string;
};

export type MemoryRequest = {
  request_id: string;
  dedup_key: string;
  scope: Scope;
  project_id: string;
  session_id: string;
  branch_ref: string;
  intent: string;
  title: string;
  evidence: MemoryRequestEvidence[];
  status: MemoryRequestStatus;
  attempts: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_expires_at: number | null;
  memory_uri: MemoryUri | null;
  revision: Revision | null;
  navigation_status: NavigationStatus | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
};

export type EnqueueMemoryRequestInput = {
  scope: Scope;
  project_id: string;
  session_id: string;
  branch_ref: string;
  intent: string;
  title: string;
  evidence: readonly MemoryRequestEvidence[];
  at: string;
};

export type EnqueueMemoryRequestResult = {
  request: MemoryRequest;
  /** False when the identical request was already stored. */
  inserted: boolean;
};

export type CompleteMemoryRequestInput = {
  request_id: string;
  outcome: "saved" | "merged";
  memory_uri: MemoryUri;
  revision: Revision;
  navigation_status: NavigationStatus;
  at: string;
};

type Row = Record<string, SQLOutputValue>;

const STATUSES: readonly MemoryRequestStatus[] = [
  "pending",
  "processing",
  "saved",
  "merged",
  "failed",
  "rejected",
];

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new StorageError("row_corrupt", `memory_requests.${key} is not text`);
  return value;
}

function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new StorageError("row_corrupt", `memory_requests.${key} is not text`);
  return value;
}

function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new StorageError("row_corrupt", `memory_requests.${key} is not an integer`);
  }
  return value;
}

function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new StorageError("row_corrupt", `memory_requests.${key} is not an integer`);
  }
  return value;
}

function parseStatus(value: string): MemoryRequestStatus {
  const match = STATUSES.find((status) => status === value);
  if (match === undefined) throw new StorageError("row_corrupt", `memory_requests.status has unknown value ${value}`);
  return match;
}

function parseNavigationStatus(value: string | null): NavigationStatus | null {
  if (value === null) return null;
  if (value === "pending" || value === "ready" || value === "failed") return value;
  throw new StorageError("row_corrupt", `memory_requests.navigation_status has unknown value ${value}`);
}

function parseEvidence(json: string): MemoryRequestEvidence[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new StorageError("row_corrupt", "memory_requests.evidence_json is not JSON");
  }
  if (!Array.isArray(parsed)) throw new StorageError("row_corrupt", "memory_requests.evidence_json is not an array");
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new StorageError("row_corrupt", `memory_requests.evidence_json[${index}] is not an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record["excerpt"] !== "string") {
      throw new StorageError("row_corrupt", `memory_requests.evidence_json[${index}].excerpt is not text`);
    }
    return {
      source: parseSourceRef(record["source"], `$.evidence[${index}].source`),
      excerpt: record["excerpt"],
    };
  });
}

function rowToRequest(row: Row): MemoryRequest {
  return {
    request_id: str(row, "request_id"),
    dedup_key: str(row, "dedup_key"),
    scope: parseScope(JSON.parse(str(row, "scope_json"))),
    project_id: str(row, "project_id"),
    session_id: str(row, "session_id"),
    branch_ref: str(row, "branch_ref"),
    intent: str(row, "intent"),
    title: str(row, "title"),
    evidence: parseEvidence(str(row, "evidence_json")),
    status: parseStatus(str(row, "status")),
    attempts: num(row, "attempts"),
    next_attempt_at: str(row, "next_attempt_at"),
    lease_owner: strOrNull(row, "lease_owner"),
    lease_expires_at: numOrNull(row, "lease_expires_at"),
    memory_uri: strOrNull(row, "memory_uri") as MemoryUri | null,
    revision: numOrNull(row, "revision"),
    navigation_status: parseNavigationStatus(strOrNull(row, "navigation_status")),
    reason: strOrNull(row, "reason"),
    created_at: str(row, "created_at"),
    updated_at: str(row, "updated_at"),
  };
}

function evidenceIdentity(source: SourceRef): string {
  return [
    source.provider,
    source.source_instance,
    source.session_id,
    source.message_id,
    source.content_hash,
  ].join("\u0000");
}

function normalizedIntent(intent: string): string {
  return intent.replace(/\s+/gu, " ").trim();
}

/**
 * Stable identity of one request: scope, normalized intent and the sorted
 * evidence source identities. Consent is not part of the identity.
 */
export function memoryRequestDedupKey(input: {
  scope: Scope;
  intent: string;
  evidence: readonly MemoryRequestEvidence[];
}): string {
  const scope = input.scope.kind === "project" ? `project:${input.scope.project_id}` : "global";
  const evidence = [...new Set(input.evidence.map((entry) => evidenceIdentity(entry.source)))].sort();
  return createHash("sha256")
    .update(JSON.stringify([scope, normalizedIntent(input.intent), evidence]), "utf8")
    .digest("hex");
}

/** The candidate identity is the row identity: same scope, intent and evidence. */
export function memoryRequestCandidateKey(input: {
  scope: Scope;
  intent: string;
  evidence: readonly MemoryRequestEvidence[];
}): string {
  return memoryRequestDedupKey(input);
}

function clip(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, Math.max(1, max - 1)).join("")}…`;
}

function dedupeEvidence(evidence: readonly MemoryRequestEvidence[]): MemoryRequestEvidence[] {
  const seen = new Set<string>();
  const out: MemoryRequestEvidence[] = [];
  for (const entry of evidence) {
    const key = serializeSourceRef(entry.source);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: { ...entry.source },
      excerpt: clip(entry.excerpt.trim(), MEMORY_REQUEST_MAX_EXCERPT),
    });
  }
  return out;
}

/** The persisted scope shape: read-side project aliases are dropped on the way in. */
function serializableScope(scope: Scope): Scope {
  return scope.kind === "project" ? { kind: "project", project_id: scope.project_id } : scope;
}

export function insertMemoryRequest(
  db: DatabaseSync,
  input: EnqueueMemoryRequestInput,
): EnqueueMemoryRequestResult {
  const evidence = dedupeEvidence(input.evidence);
  if (evidence.length === 0) {
    throw new StorageError("invariant_violation", "a memory request needs at least one evidence source");
  }
  if (evidence.length > MEMORY_REQUEST_MAX_EVIDENCE) {
    throw new StorageError(
      "invariant_violation",
      `a memory request accepts at most ${MEMORY_REQUEST_MAX_EVIDENCE} evidence sources`,
    );
  }
  const at = parseTimestamp(input.at, "$.at");
  const intent = normalizedIntent(input.intent);
  if (intent.length === 0) throw new StorageError("invariant_violation", "a memory request needs an intent");
  const dedupKey = memoryRequestDedupKey({ scope: input.scope, intent, evidence });
  const requestId = `req-${createHash("sha256").update(dedupKey, "utf8").digest("hex").slice(0, 16)}`;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO memory_requests
         (request_id, dedup_key, scope_json, project_id, session_id, branch_ref, intent, title,
          evidence_json, status, attempts, next_attempt_at,
          lease_owner, lease_expires_at, memory_uri, revision, navigation_status, reason,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      requestId,
      dedupKey,
      JSON.stringify(serializableScope(input.scope)),
      input.project_id,
      input.session_id,
      input.branch_ref,
      intent,
      input.title,
      JSON.stringify(evidence),
      at,
      at,
      at,
    );
  const stored = readMemoryRequestByDedupKey(db, dedupKey);
  if (stored === null) throw new StorageError("write_failed", "memory request was not stored");
  return { request: stored, inserted: Number(result.changes) === 1 };
}

export function readMemoryRequest(db: DatabaseSync, requestId: string): MemoryRequest | null {
  const row = db.prepare("SELECT * FROM memory_requests WHERE request_id = ?").get(requestId);
  return row === undefined ? null : rowToRequest(row);
}

export function readMemoryRequestByDedupKey(db: DatabaseSync, dedupKey: string): MemoryRequest | null {
  const row = db.prepare("SELECT * FROM memory_requests WHERE dedup_key = ?").get(dedupKey);
  return row === undefined ? null : rowToRequest(row);
}

export function listMemoryRequests(db: DatabaseSync, limit = 50): MemoryRequest[] {
  return db
    .prepare("SELECT * FROM memory_requests ORDER BY created_at ASC, request_id ASC LIMIT ?")
    .all(Math.max(1, Math.trunc(limit)))
    .map(rowToRequest);
}

export function countMemoryRequests(db: DatabaseSync, status?: MemoryRequestStatus): number {
  const row =
    status === undefined
      ? db.prepare("SELECT COUNT(*) AS n FROM memory_requests").get()
      : db.prepare("SELECT COUNT(*) AS n FROM memory_requests WHERE status = ?").get(status);
  return row === undefined ? 0 : num(row, "n");
}

/**
 * Claim one due request: pending and past its retry time, or processing with an
 * expired lease. The compare-and-set re-states the observed row, so a
 * concurrent claim makes this one a no-op instead of a second worker.
 */
export function claimDueMemoryRequest(
  db: DatabaseSync,
  input: {
    now_ms: number;
    owner: string;
    lease_ms?: number | undefined;
    max_attempts?: number | undefined;
  },
): MemoryRequest | null {
  const leaseMs = Math.max(1, Math.trunc(input.lease_ms ?? MEMORY_REQUEST_LEASE_MS));
  const maxAttempts = Math.max(1, Math.trunc(input.max_attempts ?? MEMORY_REQUEST_MAX_ATTEMPTS));
  const at = new Date(input.now_ms).toISOString();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = db
      .prepare(
        `SELECT * FROM memory_requests
          WHERE (status = 'pending' AND attempts < ? AND next_attempt_at <= ?)
             OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
          ORDER BY created_at ASC, request_id ASC
          LIMIT 1`,
      )
      .get(maxAttempts, at, input.now_ms);
    if (candidate === undefined) return null;
    const request = rowToRequest(candidate);

    // A crash after the final attempt leaves a `processing` row at the
    // ceiling. Its expired lease must drain to `failed`; without this branch
    // the row would stay `processing` forever because no attempt remains.
    if (request.status === "processing" && request.attempts >= maxAttempts) {
      db.prepare(
        `UPDATE memory_requests
            SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                reason = ? || CASE WHEN reason IS NULL OR reason = '' THEN '' ELSE '; ' || reason END,
                updated_at = ?
          WHERE request_id = ? AND status = 'processing' AND attempts = ?`,
      ).run("attempt ceiling after an expired lease", at, request.request_id, request.attempts);
      continue;
    }

    const result = db
      .prepare(
        `UPDATE memory_requests
            SET status = 'processing', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1,
                updated_at = ?
          WHERE request_id = ? AND status = ? AND attempts = ?
            AND (lease_expires_at IS NULL OR lease_expires_at = ?)
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(
        input.owner,
        input.now_ms + leaseMs,
        at,
        request.request_id,
        request.status,
        request.attempts,
        request.lease_expires_at,
        input.now_ms,
      );
    if (Number(result.changes) === 1) {
      return readMemoryRequest(db, request.request_id);
    }
  }
  return null;
}

/** Persist the produced target before the slow nav step, so a crash cannot duplicate it. */
export function attachMemoryRequestTarget(
  db: DatabaseSync,
  input: { request_id: string; memory_uri: MemoryUri; revision: Revision; at: string },
): void {
  const at = parseTimestamp(input.at, "$.at");
  db.prepare(
    `UPDATE memory_requests
        SET memory_uri = ?, revision = ?, navigation_status = 'pending', updated_at = ?
      WHERE request_id = ?`,
  ).run(input.memory_uri, input.revision, at, input.request_id);
}

export function completeMemoryRequest(
  db: DatabaseSync,
  input: CompleteMemoryRequestInput,
): MemoryRequest {
  const at = parseTimestamp(input.at, "$.at");
  db.prepare(
    `UPDATE memory_requests
        SET status = ?, memory_uri = ?, revision = ?, navigation_status = ?,
            lease_owner = NULL, lease_expires_at = NULL, reason = NULL, updated_at = ?
      WHERE request_id = ?`,
  ).run(input.outcome, input.memory_uri, input.revision, input.navigation_status, at, input.request_id);
  const stored = readMemoryRequest(db, input.request_id);
  if (stored === null) throw new StorageError("write_failed", `memory request ${input.request_id} vanished`);
  return stored;
}

export function setMemoryRequestNavigation(
  db: DatabaseSync,
  input: { request_id: string; navigation_status: NavigationStatus; at: string },
): void {
  const at = parseTimestamp(input.at, "$.at");
  db.prepare(
    "UPDATE memory_requests SET navigation_status = ?, updated_at = ? WHERE request_id = ?",
  ).run(input.navigation_status, at, input.request_id);
}

/**
 * Record a failed attempt. A retryable failure returns to `pending` with a
 * later `next_attempt_at`; at the attempt ceiling, or for a terminal rejection,
 * the request becomes `failed`/`rejected` and keeps the reason for the status
 * tool. Nothing is written to memory in this path.
 */
export function failMemoryRequest(
  db: DatabaseSync,
  input: {
    request: MemoryRequest;
    status: "pending" | "failed" | "rejected";
    reason: string;
    next_attempt_at: string;
    at: string;
    max_attempts?: number | undefined;
  },
): MemoryRequest {
  const maxAttempts = Math.max(1, Math.trunc(input.max_attempts ?? MEMORY_REQUEST_MAX_ATTEMPTS));
  const exhausted = input.request.attempts >= maxAttempts;
  const status = input.status === "pending" && exhausted ? "failed" : input.status;
  db.prepare(
    `UPDATE memory_requests
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL, reason = ?,
            next_attempt_at = ?, updated_at = ?
      WHERE request_id = ?`,
  ).run(status, input.reason.slice(0, 2000), parseTimestamp(input.next_attempt_at, "$.next_attempt_at"), input.at, input.request.request_id);
  const stored = readMemoryRequest(db, input.request.request_id);
  if (stored === null) throw new StorageError("write_failed", `memory request ${input.request.request_id} vanished`);
  return stored;
}

/** Reset a request row for a new dedup key; used only by tests and recovery tools. */
export function requestAttemptCeiling(request: MemoryRequest): boolean {
  return request.attempts >= MEMORY_REQUEST_MAX_ATTEMPTS;
}
