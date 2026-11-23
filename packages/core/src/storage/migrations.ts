import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { resealContentHashes } from "./rows.js";
import { normalizeForIndex } from "./tokenize.js";

export type Migration = {
  version: number;
  name: string;
  sql: string;
  /** Data step for migrations that must derive values in TypeScript. Runs in the `sql` transaction. */
  run?: (db: DatabaseSync) => void;
};

export type AppliedMigration = {
  version: number;
  name: string;
  applied_at: string;
};

/**
 * Numbered, forward-only migration list. Each file is applied once, in a
 * transaction, and recorded in `schema_migrations`; re-running an already
 * applied list is a no-op.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: readFileSync(new URL("../../migrations/0001_initial.sql", import.meta.url), "utf8"),
  },
  {
    version: 2,
    name: "summary_jobs",
    sql: readFileSync(new URL("../../migrations/0002_summary_jobs.sql", import.meta.url), "utf8"),
  },
  {
    version: 3,
    name: "stale_events",
    sql: readFileSync(new URL("../../migrations/0003_stale_events.sql", import.meta.url), "utf8"),
  },
  {
    version: 4,
    name: "memory_requests",
    sql: readFileSync(new URL("../../migrations/0004_memory_requests.sql", import.meta.url), "utf8"),
  },
  {
    version: 5,
    name: "memory_title_format",
    sql: readFileSync(new URL("../../migrations/0005_memory_title_format.sql", import.meta.url), "utf8"),
    run: rewriteMemoryTitles,
  },
  {
    version: 6,
    name: "memory_content_hash",
    sql: readFileSync(new URL("../../migrations/0006_memory_content_hash.sql", import.meta.url), "utf8"),
    run: resealContentHashes,
  },
];

/**
 * The title formats on either side of the English-only prompt rewrite. The new
 * side is written here as a literal rather than imported from `buildTitle`:
 * a migration is a frozen snapshot, so a later format change gets its own
 * migration instead of silently rewriting older rows. The store test
 * `test/storage/title-migration.test.ts` pins the two to the same string.
 */
const LEGACY_TITLE_PREFIX = "关于「";
const LEGACY_TITLE_SUFFIX = "」的记忆";

function migratedTitle(title: string): string {
  const inner = title.slice(LEGACY_TITLE_PREFIX.length, title.length - LEGACY_TITLE_SUFFIX.length);
  return `Memory about "${inner}"`;
}

/**
 * 0005 data step. `memories` holds one row per revision, so every matching
 * revision is rewritten, and `memory_requests` holds the operator-visible
 * pending title. The FTS `title` column mirrors `normalizeForIndex(title)`, so
 * it is refreshed for the head revision only; the other FTS tables hold one row
 * per memory, and a title left behind there fails the store integrity check.
 */
function rewriteMemoryTitles(db: DatabaseSync): void {
  const pattern = `${LEGACY_TITLE_PREFIX}%${LEGACY_TITLE_SUFFIX}`;
  const revisions = db
    .prepare(
      `SELECT m.memory_id AS memory_id, m.revision AS revision, m.title AS title,
              h.revision AS head_revision
         FROM memories AS m
         LEFT JOIN memory_heads AS h ON h.memory_id = m.memory_id
        WHERE m.title LIKE ?`,
    )
    .all(pattern);
  const setRevision = db.prepare("UPDATE memories SET title = ? WHERE memory_id = ? AND revision = ?");
  const setIndexTitle = {
    active: db.prepare("UPDATE memory_fts_active SET title = ? WHERE memory_id = ?"),
    archived: db.prepare("UPDATE memory_fts_archived SET title = ? WHERE memory_id = ?"),
  };
  for (const row of revisions) {
    const memoryId = String(row["memory_id"]);
    const revision = Number(row["revision"]);
    const title = migratedTitle(String(row["title"]));
    setRevision.run(title, memoryId, revision);
    const head = row["head_revision"];
    if (head === null || Number(head) !== revision) {
      continue;
    }
    const indexed = normalizeForIndex(title).join(" ");
    setIndexTitle.active.run(indexed, memoryId);
    setIndexTitle.archived.run(indexed, memoryId);
  }
  const requests = db.prepare("SELECT request_id, title FROM memory_requests WHERE title LIKE ?").all(pattern);
  const setRequest = db.prepare("UPDATE memory_requests SET title = ? WHERE request_id = ?");
  for (const row of requests) {
    setRequest.run(migratedTitle(String(row["title"])), String(row["request_id"]));
  }
}

export function listAppliedMigrations(db: DatabaseSync): AppliedMigration[] {
  return db
    .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC")
    .all()
    .map((row) => ({
      version: Number(row["version"]),
      name: String(row["name"]),
      applied_at: String(row["applied_at"]),
    }));
}

/**
 * Apply every migration the database has not seen. DDL and the bookkeeping row
 * commit together, so a failed migration leaves neither.
 */
export function applyMigrations(db: DatabaseSync, at: string): AppliedMigration[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => Number(row["version"])),
  );
  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      migration.run?.(db);
      record.run(migration.version, migration.name, at);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return listAppliedMigrations(db);
}
