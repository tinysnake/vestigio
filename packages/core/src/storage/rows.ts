import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  deserializeSourceRef,
  parseMemory,
  serializeSourceRef,
  type Memory,
  type Scope,
  type SourceRef,
} from "../contracts/index.js";
import { StorageError } from "./errors.js";

/**
 * Row-level storage primitives: the column accessors, the `Memory` a stored
 * revision rebuilds into, and the hash over that revision's identity and
 * content. They sit apart from the store so a migration can reseal a row with
 * the same mapping the read path uses, instead of a second copy that could
 * drift away from it.
 */
export type Row = Record<string, SQLOutputValue>;

export function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new StorageError("row_corrupt", `column ${key} is not text`);
  }
  return value;
}

export function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new StorageError("row_corrupt", `column ${key} is not text`);
  }
  return value;
}

export function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new StorageError("row_corrupt", `column ${key} is not an integer`);
  }
  return value;
}

export function real(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StorageError("row_corrupt", `column ${key} is not a finite number`);
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Canonical hash of a revision's identity and content. Statistics
 * (hit_count/access_count/last_access_at) and state are deliberately excluded,
 * so re-saving the same revision with newer counters is an idempotent no-op
 * while a changed body, keyword, nav or source set is a hard failure.
 */
export function memoryContentHash(memory: Memory): string {
  return sha256(
    JSON.stringify([
      memory.memory_id,
      memory.uri,
      memory.scope,
      memory.title,
      memory.keywords,
      memory.revision,
      memory.medium.body,
      memory.medium.body_char_count,
      memory.medium.sources.map((source) => serializeSourceRef(source)),
      memory.nav,
      memory.created_at,
    ]),
  );
}

/** Rebuild a revision from its `memories` row and its ordered source rows. */
export function memoryFromRow(row: Row, sources: readonly SourceRef[]): Memory {
  const memoryId = str(row, "memory_id");
  const revision = num(row, "revision");
  const scopeKind = str(row, "scope_kind");
  let scope: Scope;
  if (scopeKind === "project") {
    const projectId = strOrNull(row, "project_id");
    if (projectId === null) {
      throw new StorageError("row_corrupt", `${memoryId}: project scope without project_id`);
    }
    scope = { kind: "project", project_id: projectId };
  } else if (scopeKind === "global") {
    scope = { kind: "global" };
  } else {
    throw new StorageError("row_corrupt", `${memoryId}: unknown scope_kind ${scopeKind}`);
  }

  const keywords = JSON.parse(str(row, "keywords_json")) as unknown;
  const navText = strOrNull(row, "nav_text");
  const nav =
    navText === null
      ? null
      : {
          text: navText,
          char_count: num(row, "nav_char_count"),
          source_revision: num(row, "nav_source_revision"),
        };
  const candidate = {
    memory_id: memoryId,
    uri: str(row, "uri"),
    scope,
    title: str(row, "title"),
    keywords,
    revision,
    state: str(row, "state"),
    medium: {
      body: str(row, "medium_body"),
      body_char_count: num(row, "medium_body_char_count"),
      sources: [...sources],
    },
    nav,
    hit_count: num(row, "hit_count"),
    access_count: num(row, "access_count"),
    last_access_at: strOrNull(row, "last_access_at"),
    created_at: str(row, "created_at"),
    updated_at: str(row, "updated_at"),
  };
  // Every row read back is re-validated through the frozen boundary parser.
  return parseMemory(candidate);
}

/**
 * Rewrite the stored content hash of every revision from its own row. A row
 * whose hash no longer describes it — migration 5 rewrote titles without
 * touching the hash — makes the next save of that revision fail as
 * `uri_content_changed` instead of landing as an idempotent no-op. The caller
 * owns the transaction; this never opens one, so a migration can run it.
 */
export function resealContentHashes(db: DatabaseSync): number {
  const keys = db.prepare("SELECT memory_id, revision FROM memories ORDER BY memory_id ASC, revision ASC").all();
  const selectRevision = db.prepare("SELECT * FROM memories WHERE memory_id = ? AND revision = ?");
  const selectSources = db.prepare(
    "SELECT ref_json FROM sources WHERE memory_id = ? AND revision = ? ORDER BY ordinal ASC",
  );
  const setHash = db.prepare("UPDATE memories SET content_hash = ? WHERE memory_id = ? AND revision = ?");
  let resealed = 0;
  for (const key of keys) {
    const memoryId = str(key, "memory_id");
    const revision = num(key, "revision");
    const row = selectRevision.get(memoryId, revision);
    if (row === undefined) {
      throw new StorageError("row_corrupt", `${memoryId} revision ${revision} vanished while resealing`);
    }
    const sources = selectSources
      .all(memoryId, revision)
      .map((source) => deserializeSourceRef(str(source, "ref_json")));
    setHash.run(memoryContentHash(memoryFromRow(row, sources)), memoryId, revision);
    resealed += 1;
  }
  return resealed;
}
