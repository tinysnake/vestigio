import type { DatabaseSync } from "node:sqlite";
import { RESOLVE_MAX_SESSION_RESOLVES, type ResolveContinuation } from "@vestigio/core/resolver";
import type { SessionKey } from "../protocol.js";

export function openResolveContexts(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_resolve_calls (
      source TEXT NOT NULL, session_id TEXT NOT NULL, job_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (source, session_id, job_id)
    );
    CREATE TABLE IF NOT EXISTS daemon_resolve_contexts (
      source TEXT NOT NULL, session_id TEXT NOT NULL, handle TEXT NOT NULL,
      version INTEGER NOT NULL, continuation TEXT, expires_at INTEGER,
      PRIMARY KEY (source, session_id, handle)
    );
  `);
  const reserve = db.prepare(`
    INSERT INTO daemon_resolve_calls (source, session_id, job_id, ordinal)
    SELECT ?, ?, ?, COUNT(*) FROM daemon_resolve_calls
    WHERE source = ? AND session_id = ?
    HAVING COUNT(*) < ?
    ON CONFLICT DO NOTHING
  `);
  const readCall = db.prepare(`SELECT ordinal FROM daemon_resolve_calls
    WHERE source = ? AND session_id = ? AND job_id = ?`);
  const readContext = db.prepare(`SELECT version, continuation FROM daemon_resolve_contexts
    WHERE source = ? AND session_id = ? AND handle = ?`);
  const update = db.prepare(`
    INSERT INTO daemon_resolve_contexts (source, session_id, handle, version, continuation, expires_at)
    SELECT ?, ?, ?, 1, ?, ? WHERE ? = 0 OR EXISTS (
      SELECT 1 FROM daemon_resolve_contexts WHERE source = ? AND session_id = ? AND handle = ?
    )
    ON CONFLICT (source, session_id, handle) DO UPDATE SET
      version = version + 1, continuation = excluded.continuation, expires_at = excluded.expires_at
    WHERE version = ?
  `);
  const discardExpired = db.prepare(`UPDATE daemon_resolve_contexts SET continuation = NULL, expires_at = NULL
    WHERE expires_at <= ?`);
  return {
    begin(session: SessionKey, jobId: string, handle: string, now: number) {
      const identity = [session.source, session.sessionId] as const;
      reserve.run(...identity, jobId, ...identity, RESOLVE_MAX_SESSION_RESOLVES);
      const used = Number(readCall.get(...identity, jobId)?.ordinal ?? RESOLVE_MAX_SESSION_RESOLVES);
      discardExpired.run(now);
      const previous = readContext.get(...identity, handle);
      const version = Number(previous?.version ?? 0);
      return {
        used,
        continuation: typeof previous?.continuation === "string"
          ? JSON.parse(previous.continuation) as ResolveContinuation : null,
        commit(continuation: ResolveContinuation | null): void {
          if (used >= RESOLVE_MAX_SESSION_RESOLVES) return;
          update.run(...identity, handle, continuation ? JSON.stringify(continuation) : null,
            continuation?.expires_at_ms ?? null, version, ...identity, handle, version);
        },
      };
    },
  };
}
