-- 0004: durable proactive memory requests.
--
-- A request is its own durable row, separate from the memory it may produce.
-- The agent resolves the evidence against the active branch and enqueues the
-- request; the row then survives a crash, a restart and a failed model call,
-- so the background manager can retry it.
--
-- `dedup_key` is a hash of scope, normalized intent and the sorted evidence
-- source identities. Repeating the same tool call therefore returns the
-- existing row (and its saved URI) instead of minting a second memory.
-- `status='processing'` is a lease: an expired lease is a retry of the same
-- row, never a second row.

CREATE TABLE memory_requests (
  request_id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  scope_json TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_ref TEXT NOT NULL,
  intent TEXT NOT NULL,
  title TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'saved', 'merged', 'failed', 'rejected')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  memory_uri TEXT,
  revision INTEGER,
  navigation_status TEXT CHECK (navigation_status IN ('pending', 'ready', 'failed')),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((memory_uri IS NULL) = (revision IS NULL))
);

CREATE INDEX memory_requests_due ON memory_requests (status, next_attempt_at, created_at);
CREATE INDEX memory_requests_scope ON memory_requests (project_id, created_at);
