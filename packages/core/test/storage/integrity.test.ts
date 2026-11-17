import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseMemory } from "../../src/contracts/index.js";
import { openStore } from "../../src/storage/index.js";
import { bodyWith, storedMemory, tempDbPath } from "./support.js";

const URI = "memory://vestigio/mem-0001";

function savedStore(path: string) {
  const store = openStore({ path });
  store.saveMemory(parseMemory(storedMemory({ body: bodyWith("索引一致性检查：端口 8787。") })));
  return store;
}

describe("index consistency", () => {
  it("reports a clean index after ordinary writes, archival and revision updates", () => {
    const store = savedStore(tempDbPath("clean"));
    store.setMemoryState(URI, "archived");
    store.setMemoryState(URI, "published");
    expect(store.integrityCheck()).toEqual({
      ok: true,
      problems: [],
      headCount: 1,
      activeIndexCount: 1,
      archivedIndexCount: 0,
    });
    store.close();
  });

  it("detects a memory that lost its index row", () => {
    const path = tempDbPath("missing-index");
    const store = savedStore(path);
    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM memory_fts_active WHERE memory_id = ?").run("mem-0001");
    raw.close();

    const report = store.integrityCheck();
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toMatch(/indexed 0 times/);
    store.close();
  });

  it("detects an archived row sitting in the Active index", () => {
    const path = tempDbPath("wrong-index");
    const store = savedStore(path);
    store.setMemoryState(URI, "archived");

    const raw = new DatabaseSync(path);
    raw.exec("BEGIN");
    raw.prepare("DELETE FROM memory_fts_archived WHERE memory_id = ?").run("mem-0001");
    raw.prepare(
      "INSERT INTO memory_fts_active (memory_id, title, keywords, nav, body) VALUES (?, '', '', '', '端口')",
    ).run("mem-0001");
    raw.exec("COMMIT");
    raw.close();

    const report = store.integrityCheck();
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toMatch(/archived/);
    store.close();
  });

  it("detects index text that no longer matches the row", () => {
    const path = tempDbPath("drifted-text");
    const store = savedStore(path);
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE memory_fts_active SET body = 'tampered' WHERE memory_id = ?").run("mem-0001");
    raw.close();

    const report = store.integrityCheck();
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toMatch(/body index text does not match the row/);
    store.close();
  });
});
