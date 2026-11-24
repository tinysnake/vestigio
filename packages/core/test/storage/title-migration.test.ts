import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseMemory } from "../../src/contracts/index.js";
import { buildTitle } from "../../src/resolver/persist.js";
import { openStore } from "../../src/storage/index.js";
import { makeSourceRef } from "../support.js";
import { bodyWith, memoryAtRevision, storedMemory, tempDbPath } from "./support.js";

const AT = "2026-11-17T16:40:00Z";

/** The title format the store wrote before the English-only prompt rewrite. */
function legacyTitle(inner: string): string {
  return `关于「${inner}」的记忆`;
}

/**
 * Forget the title and hash migrations, so the next open rewrites the titles a
 * store written by the old code held and then reseals their hashes, exactly as
 * a store that ran 5 before 6 existed is repaired. Named one by one, not
 * "everything since 5": a migration added after this pair must stay applied so
 * the reopen does not try to create its table twice.
 */
function forgetTitleMigration(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM schema_migrations WHERE version IN (5, 6)");
  db.close();
}

describe("memory title migration", () => {
  it("rewrites legacy titles and leaves current-format titles alone", () => {
    const path = tempDbPath("title-migration");
    const inner = "部署与回滚";
    const legacy = parseMemory(storedMemory({ body: bodyWith("迁移脚本需要幂等。"), title: legacyTitle(inner) }));
    const current = parseMemory(
      storedMemory({
        memory_id: "mem-0002",
        body: bodyWith("新格式标题保持不动。"),
        title: buildTitle("新格式标题"),
      }),
    );

    const old = openStore({ path });
    old.saveMemory(legacy);
    old.saveMemory(current);
    old.close();
    forgetTitleMigration(path);

    const store = openStore({ path });
    try {
      expect(store.listMigrations().map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(store.readMemory(legacy.uri)?.title).toBe(buildTitle(inner));
      expect(store.readMemory(current.uri)?.title).toBe(buildTitle("新格式标题"));
      expect(store.integrityCheck()).toEqual({
        ok: true,
        problems: [],
        headCount: 2,
        activeIndexCount: 2,
        archivedIndexCount: 0,
      });
    } finally {
      store.close();
    }
  });

  it("maps a clipped legacy title back to the title of its question", () => {
    const path = tempDbPath("title-clipped");
    const question = "端口".repeat(40);
    const clipped = buildTitle(question).slice('Memory about "'.length, -1);
    const memory = parseMemory(
      storedMemory({ body: bodyWith("长问题也要还原成同一标题。"), title: legacyTitle(clipped) }),
    );

    const old = openStore({ path });
    old.saveMemory(memory);
    old.close();
    forgetTitleMigration(path);

    const store = openStore({ path });
    try {
      expect(clipped.endsWith("…")).toBe(true);
      expect(store.readMemory(memory.uri)?.title).toBe(buildTitle(question));
      expect(store.integrityCheck().problems).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rewrites every revision and indexes the head title", () => {
    const path = tempDbPath("title-revisions");
    const inner = "端口 8787";
    const first = parseMemory(storedMemory({ body: bodyWith("第一次写入。"), title: legacyTitle(inner) }));
    const second = memoryAtRevision(2, { body: bodyWith("第二次写入。"), title: legacyTitle(inner) });

    const old = openStore({ path });
    old.saveMemory(first);
    old.saveMemory(parseMemory(second));
    old.close();
    forgetTitleMigration(path);

    const store = openStore({ path });
    try {
      expect(store.listRevisions(first.uri)).toEqual([1, 2]);
      expect(store.readMemory(first.uri, 1)?.title).toBe(buildTitle(inner));
      expect(store.readMemory(first.uri, 2)?.title).toBe(buildTitle(inner));
      expect(store.integrityCheck().problems).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("leaves an already migrated title alone when the migration runs a second time", () => {
    const path = tempDbPath("title-twice");
    const memory = parseMemory(storedMemory({ body: bodyWith("只迁移一次。"), title: legacyTitle("端口") }));

    const old = openStore({ path });
    old.saveMemory(memory);
    old.close();
    forgetTitleMigration(path);

    const first = openStore({ path });
    const migrated = first.readMemory(memory.uri)?.title;
    first.close();
    forgetTitleMigration(path);

    const second = openStore({ path });
    try {
      expect(migrated).toBe('Memory about "端口"');
      expect(second.readMemory(memory.uri)?.title).toBe(migrated);
      expect(second.integrityCheck().problems).toEqual([]);
    } finally {
      second.close();
    }
  });

  it("reseals the hash so a rewritten title still saves as a no-op", () => {
    const path = tempDbPath("title-hash");
    const inner = "端口 8787";
    const memory = parseMemory(
      storedMemory({ body: bodyWith("迁移标题之后仍可重复写入。"), title: legacyTitle(inner) }),
    );

    const old = openStore({ path });
    old.saveMemory(memory);
    old.close();
    forgetTitleMigration(path);

    const store = openStore({ path });
    try {
      const migrated = store.readMemory(memory.uri);
      expect(migrated?.title).toBe(buildTitle(inner));
      // Without the reseal this throws `uri_content_changed`, because the stored
      // hash still covers the legacy title the row no longer carries.
      expect(store.saveMemory(migrated!)).toEqual({ memory_id: memory.memory_id, revision: 1, inserted: false });
      expect(store.integrityCheck().problems).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rewrites a queued request title", () => {
    const path = tempDbPath("title-request");
    const inner = "部署 端口";
    const store = openStore({ path });
    const queued = store.enqueueMemoryRequest({
      scope: { kind: "project", project_id: "p-vestigio" },
      project_id: "p-vestigio",
      session_id: "s-1",
      branch_ref: "root",
      intent: "部署统一用 8787 端口",
      title: legacyTitle(inner),
      evidence: [{ source: makeSourceRef({ message_id: "m-10" }), excerpt: "以后部署都用 8787 端口" }],
      at: AT,
    });
    store.close();
    forgetTitleMigration(path);

    const reopened = openStore({ path });
    try {
      expect(reopened.readMemoryRequest(queued.request.request_id)?.title).toBe(buildTitle(inner));
    } finally {
      reopened.close();
    }
  });
});
