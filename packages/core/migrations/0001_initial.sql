-- 0001_initial: durable memory store for PR-02.
--
-- One row per memory revision. `memory_heads` points at the revision a plain
-- URI read returns. Retrieval text lives in two disjoint FTS5 indexes so an
-- archived row can never appear in a default (Active) ranking.

CREATE TABLE memories (
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  store_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'global')),
  project_id TEXT,
  title TEXT NOT NULL,
  keywords_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('medium_ready', 'published', 'archived')),
  medium_body TEXT NOT NULL,
  medium_body_char_count INTEGER NOT NULL CHECK (medium_body_char_count >= 0),
  nav_text TEXT,
  nav_char_count INTEGER,
  nav_source_revision INTEGER,
  hit_count INTEGER NOT NULL CHECK (hit_count >= 0),
  access_count INTEGER NOT NULL CHECK (access_count >= 0),
  last_access_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  CHECK ((nav_text IS NULL) = (nav_char_count IS NULL)),
  CHECK ((nav_text IS NULL) = (nav_source_revision IS NULL)),
  CHECK (scope_kind = 'global' OR project_id IS NOT NULL),
  CHECK (scope_kind = 'project' OR project_id IS NULL),
  PRIMARY KEY (memory_id, revision)
);

CREATE TABLE memory_heads (
  memory_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('medium_ready', 'published', 'archived')),
  updated_at TEXT NOT NULL
);

CREATE INDEX memories_scope ON memories (scope_kind, project_id);
CREATE INDEX memories_state ON memories (state);

-- Canonical SourceRef rows, one per (memory, revision, position). ref_json is
-- exactly what serializeSourceRef produces.
CREATE TABLE sources (
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  ref_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (memory_id, revision, ordinal)
);

CREATE INDEX sources_session ON sources (session_id, message_id);

CREATE TABLE usage_events (
  event_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hit', 'access')),
  channel TEXT NOT NULL CHECK (channel IN ('hotspot', 'search', 'read')),
  session_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  at TEXT NOT NULL,
  dedup_key TEXT NOT NULL
);

CREATE TABLE injection_receipts (
  store_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_ref TEXT NOT NULL,
  input_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (store_id, session_id, branch_ref, input_id, memory_id)
);

CREATE TABLE project_activity (
  project_id TEXT PRIMARY KEY,
  activity_seq INTEGER NOT NULL CHECK (activity_seq >= 0),
  last_input_at TEXT NOT NULL
);

CREATE TABLE hotspot_memberships (
  project_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  admitted_seq INTEGER NOT NULL CHECK (admitted_seq >= 0),
  last_hit_seq INTEGER NOT NULL CHECK (last_hit_seq >= 0),
  last_access_seq INTEGER NOT NULL CHECK (last_access_seq >= 0),
  recent_hit_weight REAL NOT NULL CHECK (recent_hit_weight >= 0),
  recent_access_weight REAL NOT NULL CHECK (recent_access_weight >= 0),
  PRIMARY KEY (project_id, memory_id)
);

CREATE TABLE store_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  store_id TEXT NOT NULL
);

-- Disjoint retrieval indexes. `tokens` columns hold normalizeForIndex output
-- joined by single spaces; the table's own tokenizer only has to split on
-- whitespace. memory_id is UNINDEXED and used for maintenance deletes.
CREATE VIRTUAL TABLE memory_fts_active USING fts5(
  memory_id UNINDEXED,
  title,
  keywords,
  nav,
  body
);

CREATE VIRTUAL TABLE memory_fts_archived USING fts5(
  memory_id UNINDEXED,
  title,
  keywords,
  nav,
  body
);
