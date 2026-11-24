-- 0007: durable per-turn rows (OBS-03).
--
-- One row per real input the `input` handler saw, whether or not a memory was
-- delivered. The row exists so the injection probability has a denominator that
-- drops the host's own `/` commands: `recordProjectInput` advances on every
-- non-extension input, `injection_receipts` only on delivery, and the gap was
-- previously visible only in the debug-only decision log.
--
-- The write is an upsert on `turn_key` (session id + input id), so replaying
-- one turn rewrites its row instead of appending a second. `outcome` is the
-- coarse bucket the audit counts; `reason` keeps the fine-grained injection
-- reason when it differs.
--
-- No secondary index: reads are whole-table aggregates over a table that gains
-- one row per turn, and the write is on the turn hot path, so an index would
-- buy little and cost the hot path.

CREATE TABLE turn_events (
  turn_key     TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  branch_ref   TEXT NOT NULL,
  input_id     TEXT NOT NULL,
  at           TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  reason       TEXT,
  matched      INTEGER NOT NULL,
  delivered    INTEGER NOT NULL,
  estimated_tokens INTEGER,
  block_bytes  INTEGER,
  handler_ms   INTEGER,
  elapsed_ms   INTEGER
);

