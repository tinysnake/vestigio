import { createHash } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  deserializeSourceRef,
  parseHotspotMembership,
  parseInjectionReceipt,
  parseMemory,
  parseMemoryState,
  parseNavSummary,
  parseProjectActivity,
  parseRevision,
  parseStoreId,
  parseUsageEvent,
  serializeSourceRef,
  splitMemoryUri,
  type HotspotMembership,
  type InjectionReceipt,
  type Memory,
  type MemoryId,
  type MemoryState,
  type MemoryUri,
  type NavSummary,
  type ProjectActivity,
  type Revision,
  type Scope,
  type UsageEvent,
} from "../contracts/index.js";
import { StorageError, isUniqueViolation } from "./errors.js";
import { applyMigrations, listAppliedMigrations, type AppliedMigration } from "./migrations.js";
import { buildMatchQuery, normalizeForIndex, type MatchMode } from "./tokenize.js";

export const DEFAULT_STORE_ID = "vestigio";
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

type Row = Record<string, SQLOutputValue>;
type IndexName = "active" | "archived";

const FTS_TABLE: Record<IndexName, string> = {
  active: "memory_fts_active",
  archived: "memory_fts_archived",
};

export type OpenStoreOptions = {
  /** SQLite file path. Use a real file; `:memory:` cannot show restart behaviour. */
  path: string;
  /** Store identity. Must match a store that already owns the file. */
  storeId?: string;
  /** How long a failed write lock waits before giving up. Default 5000 ms. */
  busyTimeoutMs?: number;
};

export type SaveMemoryOptions = {
  /**
   * Fault-injection hook: runs inside the write transaction, after every row is
   * written and just before COMMIT. A live crash test kills the process here to
   * prove an interrupted write leaves the previous revision intact.
   */
  beforeCommit?: () => void;
};

export type SaveMemoryResult = {
  memory_id: MemoryId;
  revision: Revision;
  /** False when the exact same revision and content were already stored. */
  inserted: boolean;
};

export type SearchOptions = {
  scope?: Scope;
  limit?: number;
  offset?: number;
  mode?: MatchMode;
};

export type SearchHit = {
  memory_id: MemoryId;
  uri: MemoryUri;
  state: MemoryState;
  /** FTS5 bm25: lower is better, only comparable within one index. */
  score: number;
};

export type IntegrityReport = {
  ok: boolean;
  problems: string[];
  headCount: number;
  activeIndexCount: number;
  archivedIndexCount: number;
};

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new StorageError("row_corrupt", `column ${key} is not text`);
  }
  return value;
}

function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new StorageError("row_corrupt", `column ${key} is not text`);
  }
  return value;
}

function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new StorageError("row_corrupt", `column ${key} is not an integer`);
  }
  return value;
}

function real(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StorageError("row_corrupt", `column ${key} is not a finite number`);
  }
  return value;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Canonical hash of a revision's identity and content. Statistics
 * (hit_count/access_count/last_access_at) and state are deliberately excluded,
 * so re-saving the same revision with newer counters is an idempotent no-op
 * while a changed body, keyword, nav or source set is a hard failure.
 */
function memoryContentHash(memory: Memory): string {
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

function ftsValues(memory: Memory): { title: string; keywords: string; nav: string; body: string } {
  return {
    title: normalizeForIndex(memory.title).join(" "),
    keywords: normalizeForIndex(memory.keywords.join(" ")).join(" "),
    nav: memory.nav === null ? "" : normalizeForIndex(memory.nav.text).join(" "),
    body: normalizeForIndex(memory.medium.body).join(" "),
  };
}

/**
 * One SQLite file, its migrations, and every read/write path over them. No
 * caller writes SQL: all access goes through these methods, which keep the row
 * state and the disjoint Active/Archived FTS indexes in one transaction.
 */
export class MemoryStore {
  readonly storeId: string;
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(db: DatabaseSync, storeId: string, path: string) {
    this.db = db;
    this.storeId = storeId;
    this.path = path;
  }

  /** Recorded migrations, oldest first. */
  listMigrations(): AppliedMigration[] {
    this.assertOpen();
    return listAppliedMigrations(this.db);
  }

  saveMemory(memory: Memory, options: SaveMemoryOptions = {}): SaveMemoryResult {
    const parsed = parseMemory(memory);
    const { storeId, memoryId } = splitMemoryUri(parsed.uri);
    if (storeId !== this.storeId) {
      throw new StorageError("store_mismatch", `store ${this.storeId} cannot write ${parsed.uri}`);
    }
    const hash = memoryContentHash(parsed);

    return this.write(() => {
      const existing = this.selectRevision(memoryId, parsed.revision);
      if (existing !== undefined) {
        if (str(existing, "content_hash") !== hash) {
          throw new StorageError(
            "uri_content_changed",
            `${parsed.uri} revision ${parsed.revision} already exists with different content`,
          );
        }
        return { memory_id: memoryId, revision: parsed.revision, inserted: false };
      }

      const head = this.selectHead(memoryId);
      if (head === undefined) {
        if (parsed.revision !== 1) {
          throw new StorageError(
            "first_revision_not_one",
            `${parsed.uri} has no revision yet; the first must be 1, got ${parsed.revision}`,
          );
        }
      } else {
        const headRevision = num(head, "revision");
        if (parsed.revision <= headRevision) {
          throw new StorageError(
            "stale_revision",
            `${parsed.uri} revision ${parsed.revision} is not newer than head ${headRevision}`,
          );
        }
        const headRow = this.selectRevision(memoryId, headRevision);
        if (headRow === undefined) {
          throw new StorageError("row_corrupt", `${parsed.uri} head ${headRevision} has no row`);
        }
        if (str(headRow, "created_at") !== parsed.created_at) {
          throw new StorageError(
            "created_at_mismatch",
            `${parsed.uri} revision ${parsed.revision} changed created_at (${parsed.created_at})`,
          );
        }
      }

      this.insertMemoryRow(parsed, hash);
      this.insertSources(parsed);
      this.upsertHead(parsed);
      this.rewriteFts(memoryId, parsed);
      options.beforeCommit?.();
      return { memory_id: memoryId, revision: parsed.revision, inserted: true };
    });
  }

  /**
   * Fill in the navigation summary for an already-saved revision
   * (medium_ready -> published) without touching the medium body or its
   * sources. The nav's source_revision must equal the revision it completes.
   */
  setNavigation(uri: MemoryUri, revision: Revision, nav: NavSummary): Memory {
    const { storeId, memoryId } = splitMemoryUri(uri);
    if (storeId !== this.storeId) {
      throw new StorageError("store_mismatch", `store ${this.storeId} cannot read ${uri}`);
    }
    const targetRevision = parseRevision(revision);
    const parsedNav = parseNavSummary(nav);
    if (parsedNav.source_revision !== targetRevision) {
      throw new StorageError(
        "nav_revision_mismatch",
        `nav.source_revision ${parsedNav.source_revision} must equal memory revision ${targetRevision}`,
      );
    }

    return this.write(() => {
      const head = this.selectHead(memoryId);
      if (head === undefined) {
        throw new StorageError("not_found", `${uri} is not stored`);
      }
      if (num(head, "revision") !== targetRevision) {
        throw new StorageError(
          "stale_revision",
          `nav can only complete the head revision ${num(head, "revision")}, got ${targetRevision}`,
        );
      }
      const row = this.selectRevision(memoryId, targetRevision);
      if (row === undefined) {
        throw new StorageError("not_found", `${uri} revision ${targetRevision} is not stored`);
      }
      if (strOrNull(row, "nav_text") !== null) {
        throw new StorageError("uri_content_changed", `${uri} revision ${targetRevision} already has nav`);
      }
      const state = str(row, "state") === "medium_ready" ? "published" : str(row, "state");
      const updatedAt = this.nowAfter(str(row, "created_at"));

      this.db
        .prepare(
          `UPDATE memories
             SET nav_text = ?, nav_char_count = ?, nav_source_revision = ?,
                 state = ?, updated_at = ?, content_hash = ?
           WHERE memory_id = ? AND revision = ?`,
        )
        .run(
          parsedNav.text,
          parsedNav.char_count,
          parsedNav.source_revision,
          state,
          updatedAt,
          "",
          memoryId,
          targetRevision,
        );
      const updated = this.selectRevision(memoryId, targetRevision);
      if (updated === undefined) {
        throw new StorageError("row_corrupt", `${uri} revision ${targetRevision} vanished`);
      }
      this.db
        .prepare("UPDATE memories SET content_hash = ? WHERE memory_id = ? AND revision = ?")
        .run(memoryContentHash(this.rowToMemory(updated)), memoryId, targetRevision);
      this.db
        .prepare("UPDATE memory_heads SET state = ?, updated_at = ? WHERE memory_id = ?")
        .run(state, updatedAt, memoryId);
      this.rewriteFts(memoryId, this.rowToMemory(this.selectRevision(memoryId, targetRevision) as Row));
      return this.readMemoryOrThrow(memoryId);
    });
  }

  /**
   * Move the head revision between Active and Archived. The row state, the head
   * state and the FTS membership change in one transaction, so a default query
   * can never see an archived memory and an archived query can never see it
   * before it is archived.
   */
  setMemoryState(uri: MemoryUri, state: MemoryState, at?: string): Memory {
    const { storeId, memoryId } = splitMemoryUri(uri);
    if (storeId !== this.storeId) {
      throw new StorageError("store_mismatch", `store ${this.storeId} cannot write ${uri}`);
    }
    const next = parseMemoryState(state);
    return this.write(() => {
      const head = this.selectHead(memoryId);
      if (head === undefined) {
        throw new StorageError("not_found", `${uri} is not stored`);
      }
      const revision = num(head, "revision");
      const row = this.selectRevision(memoryId, revision);
      if (row === undefined) {
        throw new StorageError("row_corrupt", `${uri} head ${revision} has no row`);
      }
      const updatedAt = this.nowAfter(str(row, "created_at"), at);
      this.db
        .prepare("UPDATE memories SET state = ?, updated_at = ? WHERE memory_id = ? AND revision = ?")
        .run(next, updatedAt, memoryId, revision);
      this.db
        .prepare("UPDATE memory_heads SET state = ?, updated_at = ? WHERE memory_id = ?")
        .run(next, updatedAt, memoryId);
      const updated = this.selectRevision(memoryId, revision);
      if (updated === undefined) {
        throw new StorageError("row_corrupt", `${uri} revision ${revision} vanished`);
      }
      this.rewriteFts(memoryId, this.rowToMemory(updated));
      return this.readMemoryOrThrow(memoryId);
    });
  }

  readMemory(uri: MemoryUri, revision?: Revision): Memory | null {
    const { storeId, memoryId } = splitMemoryUri(uri);
    if (storeId !== this.storeId) {
      throw new StorageError("store_mismatch", `store ${this.storeId} cannot read ${uri}`);
    }
    const target = revision === undefined ? undefined : parseRevision(revision);
    return this.read(() => {
      const resolved = target ?? this.headRevision(memoryId);
      if (resolved === undefined) {
        return null;
      }
      const row = this.selectRevision(memoryId, resolved);
      if (row === undefined) {
        return null;
      }
      return this.rowToMemory(row);
    });
  }

  listRevisions(uri: MemoryUri): Revision[] {
    const { storeId, memoryId } = splitMemoryUri(uri);
    if (storeId !== this.storeId) {
      throw new StorageError("store_mismatch", `store ${this.storeId} cannot read ${uri}`);
    }
    return this.db
      .prepare("SELECT revision FROM memories WHERE memory_id = ? ORDER BY revision ASC")
      .all(memoryId)
      .map((row) => num(row, "revision"));
  }

  /** Default (Active) ranking. Archived rows live in a different index and cannot appear. */
  searchActive(query: string, options: SearchOptions = {}): SearchHit[] {
    return this.searchIndex("active", query, options);
  }

  /** Explicit Archived ranking, disjoint from the Active index. */
  searchArchived(query: string, options: SearchOptions = {}): SearchHit[] {
    return this.searchIndex("archived", query, options);
  }

  countMemories(state?: MemoryState): number {
    this.assertOpen();
    const row =
      state === undefined
        ? this.db.prepare("SELECT COUNT(*) AS n FROM memory_heads").get()
        : this.db.prepare("SELECT COUNT(*) AS n FROM memory_heads WHERE state = ?").get(state);
    return row === undefined ? 0 : num(row, "n");
  }

  /** Insert a usage event. Returns false when the deterministic event_id was already stored. */
  recordUsageEvent(event: UsageEvent): boolean {
    const parsed = parseUsageEvent(event);
    return this.write(() => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO usage_events
             (event_id, memory_id, revision, kind, channel, session_id, input_id, at, dedup_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.event_id,
          parsed.memory_id,
          parsed.revision,
          parsed.kind,
          parsed.channel,
          parsed.session_id,
          parsed.input_id,
          parsed.at,
          parsed.dedup_key,
        );
      if (Number(result.changes) === 0) {
        return false;
      }
      this.applyUsageToCounters(parsed);
      return true;
    });
  }

  /**
   * Keep the head row's denormalised counters in step with the event log, in
   * the same transaction as the insert. Counters are memory-level aggregates
   * stored on the head revision because every read and ranking joins through
   * the head; per-revision history stays in `usage_events`. `event_id` dedup
   * already prevents a retried delivery from counting twice, and an access
   * only moves `last_access_at` forward so out-of-order delivery cannot
   * rewind it. An event for a memory this store does not hold stays in the log
   * without inventing a row to count against.
   */
  private applyUsageToCounters(event: UsageEvent): void {
    const head = this.selectHead(event.memory_id);
    if (head === undefined) {
      return;
    }
    const memoryId = str(head, "memory_id");
    const revision = num(head, "revision");
    if (event.kind === "hit") {
      this.db
        .prepare("UPDATE memories SET hit_count = hit_count + 1 WHERE memory_id = ? AND revision = ?")
        .run(memoryId, revision);
      return;
    }
    this.db
      .prepare(
        `UPDATE memories
            SET access_count = access_count + 1,
                last_access_at = CASE
                  WHEN last_access_at IS NULL OR last_access_at < ? THEN ?
                  ELSE last_access_at
                END
          WHERE memory_id = ? AND revision = ?`,
      )
      .run(event.at, event.at, memoryId, revision);
  }

  hasUsageEvent(eventId: string): boolean {
    this.assertOpen();
    return this.db.prepare("SELECT 1 AS present FROM usage_events WHERE event_id = ?").get(eventId) !== undefined;
  }

  countUsageEvents(): number {
    this.assertOpen();
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get();
    return row === undefined ? 0 : num(row, "n");
  }

  /**
   * Record a delivered injection. The uniqueness key is
   * (store_id, session_id, branch_ref, input_id, memory_id): a duplicate is a
   * hard failure, not a silent update.
   */
  recordInjectionReceipt(receipt: InjectionReceipt): void {
    const parsed = parseInjectionReceipt(receipt);
    if (parsed.store_id !== this.storeId) {
      throw new StorageError("store_mismatch", `receipt store ${parsed.store_id} != ${this.storeId}`);
    }
    try {
      this.write(() => {
        this.db
          .prepare(
            `INSERT INTO injection_receipts
               (store_id, session_id, branch_ref, input_id, memory_id, revision, committed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            parsed.store_id,
            parsed.session_id,
            parsed.branch_ref,
            parsed.input_id,
            parsed.memory_id,
            parsed.revision,
            parsed.committed_at,
          );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StorageError(
          "duplicate_injection_receipt",
          `${this.storeId}/${parsed.session_id}/${parsed.branch_ref}/${parsed.input_id}/${parsed.memory_id} was already recorded`,
        );
      }
      throw error;
    }
  }

  hasInjectionReceipt(
    sessionId: string,
    branchRef: string,
    inputId: string,
    memoryId: MemoryId,
  ): boolean {
    this.assertOpen();
    return (
      this.db
        .prepare(
          `SELECT 1 AS present FROM injection_receipts
            WHERE store_id = ? AND session_id = ? AND branch_ref = ? AND input_id = ? AND memory_id = ?`,
        )
        .get(this.storeId, sessionId, branchRef, inputId, memoryId) !== undefined
    );
  }

  countInjectionReceipts(): number {
    this.assertOpen();
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM injection_receipts").get();
    return row === undefined ? 0 : num(row, "n");
  }

  /** Monotonic per-project logical clock: a lower or equal sequence never moves it back. */
  upsertProjectActivity(activity: ProjectActivity): ProjectActivity {
    const parsed = parseProjectActivity(activity);
    return this.write(() => {
      this.db
        .prepare(
          `INSERT INTO project_activity (project_id, activity_seq, last_input_at) VALUES (?, ?, ?)
             ON CONFLICT(project_id) DO UPDATE SET
               activity_seq = excluded.activity_seq,
               last_input_at = excluded.last_input_at
             WHERE excluded.activity_seq > project_activity.activity_seq`,
        )
        .run(parsed.project_id, parsed.activity_seq, parsed.last_input_at);
      const stored = this.readProjectActivity(parsed.project_id);
      if (stored === null) {
        throw new StorageError("row_corrupt", `project_activity ${parsed.project_id} vanished`);
      }
      return stored;
    });
  }

  readProjectActivity(projectId: string): ProjectActivity | null {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT project_id, activity_seq, last_input_at FROM project_activity WHERE project_id = ?")
      .get(projectId);
    if (row === undefined) {
      return null;
    }
    return {
      project_id: str(row, "project_id"),
      activity_seq: num(row, "activity_seq"),
      last_input_at: str(row, "last_input_at"),
    };
  }

  upsertHotspotMembership(membership: HotspotMembership): void {
    const parsed = parseHotspotMembership(membership);
    this.write(() => {
      this.db
        .prepare(
          `INSERT INTO hotspot_memberships
             (project_id, memory_id, admitted_seq, last_hit_seq, last_access_seq, recent_hit_weight, recent_access_weight)
           VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id, memory_id) DO UPDATE SET
               admitted_seq = excluded.admitted_seq,
               last_hit_seq = excluded.last_hit_seq,
               last_access_seq = excluded.last_access_seq,
               recent_hit_weight = excluded.recent_hit_weight,
               recent_access_weight = excluded.recent_access_weight`,
        )
        .run(
          parsed.project_id,
          parsed.memory_id,
          parsed.admitted_seq,
          parsed.last_hit_seq,
          parsed.last_access_seq,
          parsed.recent_hit_weight,
          parsed.recent_access_weight,
        );
    });
  }

  readHotspotMemberships(projectId: string): HotspotMembership[] {
    this.assertOpen();
    return this.db
      .prepare(
        `SELECT project_id, memory_id, admitted_seq, last_hit_seq, last_access_seq,
                recent_hit_weight, recent_access_weight
           FROM hotspot_memberships WHERE project_id = ? ORDER BY memory_id ASC`,
      )
      .all(projectId)
      .map((row) => ({
        project_id: str(row, "project_id"),
        memory_id: str(row, "memory_id"),
        admitted_seq: num(row, "admitted_seq"),
        last_hit_seq: num(row, "last_hit_seq"),
        last_access_seq: num(row, "last_access_seq"),
        recent_hit_weight: real(row, "recent_hit_weight"),
        recent_access_weight: real(row, "recent_access_weight"),
      }));
  }

  deleteHotspotMembership(projectId: string, memoryId: MemoryId): void {
    this.write(() => {
      this.db
        .prepare("DELETE FROM hotspot_memberships WHERE project_id = ? AND memory_id = ?")
        .run(projectId, memoryId);
    });
  }

  /**
   * Compare every head row with its FTS membership and token columns. A
   * mismatch (an index that disagrees with the row state) is reported, not
   * repaired.
   */
  integrityCheck(): IntegrityReport {
    this.assertOpen();
    const problems: string[] = [];
    const activeIndexCount =
      this.db.prepare("SELECT COUNT(*) AS n FROM memory_fts_active").get()?.["n"] ?? 0;
    const archivedIndexCount =
      this.db.prepare("SELECT COUNT(*) AS n FROM memory_fts_archived").get()?.["n"] ?? 0;
    const heads = this.db
      .prepare("SELECT memory_id, revision, state FROM memory_heads ORDER BY memory_id ASC")
      .all();

    for (const head of heads) {
      const memoryId = str(head, "memory_id");
      const revision = num(head, "revision");
      const state = str(head, "state");
      const row = this.selectRevision(memoryId, revision);
      if (row === undefined) {
        problems.push(`${memoryId}: head revision ${revision} has no memories row`);
        continue;
      }
      const memory = this.rowToMemory(row);
      if (memory.state !== state) {
        problems.push(`${memoryId}: head state ${state} != row state ${memory.state}`);
      }
      const expected = ftsValues(memory);
      const activeRows = this.ftsRows("active", memoryId);
      const archivedRows = this.ftsRows("archived", memoryId);
      if (activeRows.length + archivedRows.length !== 1) {
        problems.push(
          `${memoryId}: indexed ${activeRows.length + archivedRows.length} times, expected exactly once`,
        );
        continue;
      }
      const target = state === "archived" ? archivedRows : activeRows;
      const indexed = target[0];
      if (indexed === undefined) {
        problems.push(`${memoryId}: state ${state} but indexed in the other index`);
        continue;
      }
      for (const column of ["title", "keywords", "nav", "body"] as const) {
        if (str(indexed, column) !== expected[column]) {
          problems.push(`${memoryId}: ${column} index text does not match the row`);
        }
      }
    }

    for (const index of ["active", "archived"] as const) {
      const orphans = this.db
        .prepare(
          `SELECT memory_id FROM ${FTS_TABLE[index]}
             WHERE memory_id NOT IN (SELECT memory_id FROM memory_heads)`,
        )
        .all();
      for (const orphan of orphans) {
        problems.push(`${str(orphan, "memory_id")}: index row in ${index} with no head`);
      }
    }

    return {
      ok: problems.length === 0,
      problems,
      headCount: heads.length,
      activeIndexCount: Number(activeIndexCount),
      archivedIndexCount: Number(archivedIndexCount),
    };
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError("closed", "store is closed");
    }
  }

  private write<T>(fn: () => T): T {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private read<T>(fn: () => T): T {
    this.assertOpen();
    this.db.exec("BEGIN");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private nowAfter(createdAt: string, at?: string): string {
    const candidate = at ?? new Date().toISOString();
    return Date.parse(candidate) < Date.parse(createdAt) ? createdAt : candidate;
  }

  private headRevision(memoryId: MemoryId): Revision | undefined {
    const row = this.selectHead(memoryId);
    return row === undefined ? undefined : num(row, "revision");
  }

  private selectHead(memoryId: MemoryId): Row | undefined {
    return this.db
      .prepare("SELECT memory_id, revision, state, updated_at FROM memory_heads WHERE memory_id = ?")
      .get(memoryId);
  }

  private selectRevision(memoryId: MemoryId, revision: Revision): Row | undefined {
    return this.db
      .prepare("SELECT * FROM memories WHERE memory_id = ? AND revision = ?")
      .get(memoryId, revision);
  }

  private readMemoryOrThrow(memoryId: MemoryId): Memory {
    const revision = this.headRevision(memoryId);
    if (revision === undefined) {
      throw new StorageError("not_found", `${memoryId} is not stored`);
    }
    const row = this.selectRevision(memoryId, revision);
    if (row === undefined) {
      throw new StorageError("row_corrupt", `${memoryId} head ${revision} has no row`);
    }
    return this.rowToMemory(row);
  }

  private rowToMemory(row: Row): Memory {
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
        sources: this.selectSources(memoryId, revision).map((source) =>
          deserializeSourceRef(str(source, "ref_json")),
        ),
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

  private selectSources(memoryId: MemoryId, revision: Revision): Row[] {
    return this.db
      .prepare(
        `SELECT ref_json FROM sources WHERE memory_id = ? AND revision = ? ORDER BY ordinal ASC`,
      )
      .all(memoryId, revision);
  }

  private insertMemoryRow(memory: Memory, hash: string): void {
    const scopeKind = memory.scope.kind;
    const projectId = memory.scope.kind === "project" ? memory.scope.project_id : null;
    this.db
      .prepare(
        `INSERT INTO memories (
           memory_id, revision, store_id, uri, scope_kind, project_id, title, keywords_json,
           state, medium_body, medium_body_char_count, nav_text, nav_char_count,
           nav_source_revision, hit_count, access_count, last_access_at, created_at,
           updated_at, content_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.memory_id,
        memory.revision,
        splitMemoryUri(memory.uri).storeId,
        memory.uri,
        scopeKind,
        projectId,
        memory.title,
        JSON.stringify(memory.keywords),
        memory.state,
        memory.medium.body,
        memory.medium.body_char_count,
        memory.nav === null ? null : memory.nav.text,
        memory.nav === null ? null : memory.nav.char_count,
        memory.nav === null ? null : memory.nav.source_revision,
        memory.hit_count,
        memory.access_count,
        memory.last_access_at,
        memory.created_at,
        memory.updated_at,
        hash,
      );
  }

  private insertSources(memory: Memory): void {
    const statement = this.db.prepare(
      `INSERT INTO sources
         (memory_id, revision, ordinal, ref_json, content_hash, provider, source_instance, session_id, message_id, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    memory.medium.sources.forEach((source, ordinal) => {
      statement.run(
        memory.memory_id,
        memory.revision,
        ordinal,
        serializeSourceRef(source),
        source.content_hash,
        source.provider,
        source.source_instance,
        source.session_id,
        source.message_id,
        source.project_id,
      );
    });
  }

  private upsertHead(memory: Memory): void {
    this.db
      .prepare(
        `INSERT INTO memory_heads (memory_id, revision, state, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(memory_id) DO UPDATE SET
             revision = excluded.revision,
             state = excluded.state,
             updated_at = excluded.updated_at`,
      )
      .run(memory.memory_id, memory.revision, memory.state, memory.updated_at);
  }

  /** Delete every index row for a memory, then insert the one matching its state. */
  private rewriteFts(memoryId: MemoryId, memory: Memory): void {
    const values = ftsValues(memory);
    this.db.prepare("DELETE FROM memory_fts_active WHERE memory_id = ?").run(memoryId);
    this.db.prepare("DELETE FROM memory_fts_archived WHERE memory_id = ?").run(memoryId);
    const table = FTS_TABLE[memory.state === "archived" ? "archived" : "active"];
    this.db
      .prepare(
        `INSERT INTO ${table} (memory_id, title, keywords, nav, body) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(memoryId, values.title, values.keywords, values.nav, values.body);
  }

  private ftsRows(index: IndexName, memoryId: MemoryId): Row[] {
    return this.db
      .prepare(
        `SELECT memory_id, title, keywords, nav, body FROM ${FTS_TABLE[index]} WHERE memory_id = ?`,
      )
      .all(memoryId);
  }

  private searchIndex(index: IndexName, query: string, options: SearchOptions): SearchHit[] {
    this.assertOpen();
    const match = buildMatchQuery(query, options.mode ?? "all");
    if (match === null) {
      return [];
    }
    const table = FTS_TABLE[index];
    const stateSql = index === "archived" ? "memories.state = 'archived'" : "memories.state <> 'archived'";
    let scopeSql = "";
    const parameters: SQLOutputValue[] = [match];
    if (options.scope !== undefined) {
      if (options.scope.kind === "project") {
        scopeSql = "AND memories.scope_kind = 'project' AND memories.project_id = ?";
        parameters.push(options.scope.project_id);
      } else {
        scopeSql = "AND memories.scope_kind = 'global'";
      }
    }
    parameters.push(options.limit ?? 5, options.offset ?? 0);

    return this.db
      .prepare(
        `SELECT ${table}.memory_id AS memory_id,
                memories.uri AS uri,
                memories.state AS state,
                bm25(${table}, 0.0, 5.0, 3.0, 2.0, 1.0) AS score
           FROM ${table}
           JOIN memory_heads ON memory_heads.memory_id = ${table}.memory_id
           JOIN memories ON memories.memory_id = memory_heads.memory_id
                        AND memories.revision = memory_heads.revision
          WHERE ${table} MATCH ? ${scopeSql} AND ${stateSql}
          ORDER BY score ASC, ${table}.memory_id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...parameters)
      .map((row) => ({
        memory_id: str(row, "memory_id"),
        uri: str(row, "uri") as MemoryUri,
        state: str(row, "state") as MemoryState,
        score: typeof row["score"] === "number" ? row["score"] : 0,
      }));
  }
}

/**
 * Open (or create) a store at `options.path`, run migrations, and resolve the
 * store identity. The file owns its migrations; re-opening a migrated file is a
 * no-op.
 */
export function openStore(options: OpenStoreOptions): MemoryStore {
  const db = new DatabaseSync(options.path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  applyMigrations(db, new Date().toISOString());

  const requested =
    options.storeId === undefined ? undefined : parseStoreId(options.storeId);
  const existing = db.prepare("SELECT store_id FROM store_meta WHERE id = 1").get();
  let storeId: string;
  if (existing === undefined) {
    storeId = requested ?? DEFAULT_STORE_ID;
    db.prepare("INSERT INTO store_meta (id, store_id) VALUES (1, ?)").run(storeId);
  } else {
    storeId = str(existing, "store_id");
    if (requested !== undefined && requested !== storeId) {
      throw new StorageError(
        "store_identity_mismatch",
        `${options.path} belongs to store ${storeId}, not ${requested}`,
      );
    }
  }
  return new MemoryStore(db, storeId, options.path);
}
