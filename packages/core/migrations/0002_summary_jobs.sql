-- 0002: PR-07 durable short-summary jobs and resolved-evidence versions.
--
-- One row per (memory_id, revision): the stage-2 job and the version ledger
-- share a key because both are created in the same transaction as the medium
-- save. A memory that exists therefore always has either a pending/running job
-- or a finished one, and a retried resolve finds the version row before it
-- regenerates anything.
--
-- `stage` is the resolve pipeline checkpoint (searched -> summarized -> saved ->
-- returned). It is only persisted from `saved` onward: nothing before the save
-- is durable by design, so an interrupted request simply redoes it.

CREATE TABLE summary_jobs (
  job_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (memory_id, revision)
);

CREATE INDEX summary_jobs_due ON summary_jobs (state, lease_expires_at, created_at);

-- Which evidence version produced which memory revision. `version_key` is a
-- hash of the sorted source identities (provider, source instance, session,
-- message, content hash), so the same evidence set is one version and a changed
-- set is a new one.
CREATE TABLE resolve_versions (
  version_key TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  stage TEXT NOT NULL CHECK (stage IN ('saved', 'returned')),
  request_key TEXT NOT NULL,
  -- The answer the model gave for this version. Replaying the request must
  -- return it verbatim; the memory title is presentation, not an answer.
  answer TEXT NOT NULL,
  -- Immutable save time. Replay ageing reads this, never `updated_at`, which
  -- every delivery refreshes.
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX resolve_versions_memory ON resolve_versions (memory_id, revision);

-- A retried delivery must find at most one access event per dedup key. The
-- resolver derives the event id from this key, and the lookup index keeps the
-- guard cheap.
CREATE INDEX usage_events_dedup ON usage_events (dedup_key);
