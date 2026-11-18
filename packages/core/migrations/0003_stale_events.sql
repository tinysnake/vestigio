-- 0003: stale lifecycle — durable pending stale events and freshness delivery.
--
-- A stale event is evidence that a topic memory's summary has not absorbed
-- later activity. Events live separately from immutable revisions and belong to
-- a stable memory id, so an event recorded against an older revision survives
-- when the head moves on. `acknowledged_at` is set only by the summary-update
-- transaction that incorporated the event; an event created after that snapshot
-- stays pending on the new head.

CREATE TABLE stale_events (
  event_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  observed_revision INTEGER NOT NULL CHECK (observed_revision >= 1),
  reason TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  excerpt_char_count INTEGER NOT NULL CHECK (excerpt_char_count >= 0),
  excerpt_truncated INTEGER NOT NULL CHECK (excerpt_truncated IN (0, 1)),
  branch_ref TEXT,
  producer TEXT NOT NULL CHECK (producer IN ('agent', 'detector')),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_revision INTEGER,
  CHECK ((acknowledged_at IS NULL) = (acknowledged_revision IS NULL))
);

CREATE INDEX stale_events_pending ON stale_events (memory_id, acknowledged_at, created_at);

-- One row per source anchor, mirroring `sources`, so the locators an event was
-- derived from survive independently of any revision.
CREATE TABLE stale_event_sources (
  event_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  ref_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (event_id, ordinal),
  FOREIGN KEY (event_id) REFERENCES stale_events (event_id) ON DELETE CASCADE
);

-- A delivery receipt is per input turn. A changed freshness snapshot for the
-- same memory in a later turn updates the receipt instead of being rejected, so
-- an unchanged set is not re-injected while a changed one is still delivered.
ALTER TABLE injection_receipts ADD COLUMN freshness_sig TEXT NOT NULL DEFAULT '';
