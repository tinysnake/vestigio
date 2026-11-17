import { describe, expect, it } from "vitest";
import { StorageError } from "../../src/storage/index.js";
import { openTempStore } from "./support.js";
import { bodyWith, memoryAtRevision } from "./support.js";

const V1_BODY = bodyWith("alpha 版本的正文：回滚使用旧镜像。");
const V2_BODY = bodyWith("beta 版本的正文：回滚使用快照。");

function saveRevision(store: ReturnType<typeof openTempStore>, revision: number, body: string) {
  const memory = memoryAtRevision(revision, { body });
  return { memory, result: store.saveMemory(memory) };
}

describe("revision visibility", () => {
  it("a new revision replaces the old atomically for reads and for search", () => {
    const store = openTempStore();
    saveRevision(store, 1, V1_BODY);

    expect(store.searchActive("alpha")).toHaveLength(1);
    expect(store.searchActive("beta")).toHaveLength(0);

    saveRevision(store, 2, V2_BODY);

    // Plain URI read follows the head.
    const head = store.readMemory("memory://vestigio/mem-0001");
    expect(head?.revision).toBe(2);
    expect(head?.medium.body).toBe(V2_BODY);
    expect(head?.nav?.source_revision).toBe(2);

    // Both revisions are retained and addressable.
    expect(store.listRevisions("memory://vestigio/mem-0001")).toEqual([1, 2]);
    expect(store.readMemory("memory://vestigio/mem-0001", 1)?.medium.body).toBe(V1_BODY);

    // Only the head is searchable: the old body does not leak into the index.
    expect(store.searchActive("alpha")).toHaveLength(0);
    expect(store.searchActive("beta")).toHaveLength(1);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  it("an interrupted write leaves the previous revision intact", () => {
    const store = openTempStore();
    saveRevision(store, 1, V1_BODY);

    const interrupted = memoryAtRevision(2, { body: V2_BODY });
    expect(() =>
      store.saveMemory(interrupted, {
        beforeCommit: () => {
          throw new Error("simulated crash before COMMIT");
        },
      }),
    ).toThrow("simulated crash before COMMIT");

    const head = store.readMemory("memory://vestigio/mem-0001");
    expect(head?.revision).toBe(1);
    expect(head?.medium.body).toBe(V1_BODY);
    expect(store.listRevisions("memory://vestigio/mem-0001")).toEqual([1]);
    expect(store.searchActive("beta")).toHaveLength(0);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  it("refuses to change the content already stored under a revision", () => {
    const store = openTempStore();
    const first = memoryAtRevision(1, { body: V1_BODY });
    store.saveMemory(first);

    expect(() => store.saveMemory(memoryAtRevision(1, { body: V2_BODY }))).toThrow(StorageError);
    expect(store.readMemory(first.uri)?.medium.body).toBe(V1_BODY);
    store.close();
  });

  it("treats an identical re-save as an idempotent no-op", () => {
    const store = openTempStore();
    const memory = memoryAtRevision(1, { body: V1_BODY });
    expect(store.saveMemory(memory).inserted).toBe(true);
    expect(store.saveMemory(memory).inserted).toBe(false);
    expect(store.countMemories()).toBe(1);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  it("rejects a first revision that is not 1", () => {
    const store = openTempStore();
    expect(() => store.saveMemory(memoryAtRevision(2, { body: V2_BODY }))).toThrow(StorageError);
    expect(store.countMemories()).toBe(0);
    store.close();
  });

  it("rejects a revision that is not newer than the head", () => {
    const store = openTempStore();
    store.saveMemory(memoryAtRevision(1, { body: V1_BODY }));
    store.saveMemory(memoryAtRevision(3, { body: V2_BODY }));
    expect(() => store.saveMemory(memoryAtRevision(2, { body: V1_BODY }))).toThrow(StorageError);
    expect(store.listRevisions("memory://vestigio/mem-0001")).toEqual([1, 3]);
    store.close();
  });

  it("rejects a new revision that rewrites the memory creation time", () => {
    const store = openTempStore();
    store.saveMemory(memoryAtRevision(1, { body: V1_BODY }));
    expect(() =>
      store.saveMemory({
        ...memoryAtRevision(2, { body: V2_BODY }),
        created_at: "2026-11-17T16:00:00Z",
      }),
    ).toThrow(StorageError);
    expect(store.listRevisions("memory://vestigio/mem-0001")).toEqual([1]);
    store.close();
  });
});
