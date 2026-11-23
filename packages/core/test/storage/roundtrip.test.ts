import { describe, expect, it } from "vitest";
import {
  ValidationError,
  parseMemory,
  type Memory,
  type SourceRef,
} from "../../src/contracts/index.js";
import { StorageError, openStore } from "../../src/storage/index.js";
import { makeMemory, makeNav, makeSourceRef, measuredNonWhitespace } from "../support.js";
import { bodyWith, openTempStore, storedMemory, tempDbPath } from "./support.js";

const ROUND_TRIP_BODY = "服务器部署配置：端口 8787，回滚需要保留旧镜像。";

function threeSources(): SourceRef[] {
  return [
    makeSourceRef({ message_id: "m-1", session_id: "s-1" }),
    makeSourceRef({
      message_id: "m-2",
      parent_message_id: "m-1",
      session_id: "s-1",
      locator: "session/s-1.jsonl#L42",
    }),
    makeSourceRef({
      provider: "obelisk",
      source_instance: "obelisk-0",
      message_id: "m-9",
      session_id: "s-2",
      project_id: "p-other",
      content_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    }),
  ];
}

function fullMemory(): Memory {
  const body = bodyWith(ROUND_TRIP_BODY);
  return makeMemory({
    title: "部署脚本默认端口",
    keywords: ["部署", "端口", "8787"],
    medium: {
      body,
      body_char_count: measuredNonWhitespace(body),
      sources: threeSources(),
    },
  });
}

describe("storage round-trip", () => {
  it("persists a full Memory with every source and reads it back unchanged", () => {
    const store = openTempStore();
    const memory = fullMemory();
    const expected = parseMemory(memory);

    store.saveMemory(memory);
    const read = store.readMemory(memory.uri);

    expect(read).not.toBeNull();
    expect(read).toEqual(expected);
    expect(read?.medium.sources).toHaveLength(3);
    expect(read?.medium.sources[2]?.locator).toBeNull();
    store.close();
  });

  it("survives a restart: a fresh open reads the same URI", () => {
    const path = tempDbPath("restart");
    const memory = parseMemory(storedMemory({ body: bodyWith("迁移脚本需要幂等，重跑不能重复建表。") }));

    const first = openStore({ path });
    first.saveMemory(memory);
    first.close();

    const second = openStore({ path });
    expect(second.readMemory(memory.uri)).toEqual(memory);
    expect(second.listRevisions(memory.uri)).toEqual([1]);
    expect(second.listMigrations().map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6]);
    second.close();
  });

  it("re-opening a migrated file is a no-op and keeps the store identity", () => {
    const path = tempDbPath("identity");
    const first = openStore({ path, storeId: "vestigio" });
    first.close();
    const second = openStore({ path });
    expect(second.storeId).toBe("vestigio");
    expect(second.listMigrations()).toHaveLength(6);
    second.close();

    expect(() => openStore({ path, storeId: "elsewhere" })).toThrow(StorageError);
  });

  it("rejects a contract-invalid memory before writing anything", () => {
    const store = openTempStore();
    const short = storedMemory({ body: "短".repeat(100) });
    expect(() => store.saveMemory(short)).toThrow(ValidationError);
    expect(store.countMemories()).toBe(0);
    store.close();
  });

  it("rejects a memory whose URI does not belong to this store", () => {
    const store = openTempStore({ storeId: "vestigio" });
    const foreign = storedMemory({ body: bodyWith("全局偏好：编辑器使用 vi 键位。") });
    expect(() => store.saveMemory({ ...foreign, uri: "memory://other-store/mem-0001" })).toThrow(
      StorageError,
    );
    store.close();
  });

  it("returns null for a URI that was never stored", () => {
    const store = openTempStore();
    expect(store.readMemory("memory://vestigio/mem-missing")).toBeNull();
    store.close();
  });
});

describe("navigation completion", () => {
  it("moves medium_ready to published without rewriting the body", () => {
    const store = openTempStore();
    const mediumReady = parseMemory(
      storedMemory({
        body: bodyWith("两阶段摘要：先保存中期正文，再生成短摘要。"),
        state: "medium_ready",
        nav: null,
      }),
    );
    store.saveMemory(mediumReady);
    expect(store.searchActive("短摘要")).toHaveLength(1);

    const nav = makeNav({ source_revision: 1 });
    const published = store.setNavigation(mediumReady.uri, 1, nav);
    expect(published.state).toBe("published");
    expect(published.nav).toEqual(nav);
    expect(published.medium.body).toBe(mediumReady.medium.body);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  it("refuses a nav whose source_revision is not the revision it completes", () => {
    const store = openTempStore();
    const mediumReady = parseMemory(
      storedMemory({ body: bodyWith("短摘要必须绑定正文 revision。"), state: "medium_ready", nav: null }),
    );
    store.saveMemory(mediumReady);

    expect(() => store.setNavigation(mediumReady.uri, 1, makeNav({ source_revision: 2 }))).toThrow(
      StorageError,
    );
    expect(store.readMemory(mediumReady.uri)?.state).toBe("medium_ready");
    store.close();
  });
});
