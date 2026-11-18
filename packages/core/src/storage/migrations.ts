import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export type Migration = {
  version: number;
  name: string;
  sql: string;
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
];

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
      record.run(migration.version, migration.name, at);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return listAppliedMigrations(db);
}
