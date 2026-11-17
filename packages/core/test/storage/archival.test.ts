import { describe, expect, it } from "vitest";
import { parseMemory } from "../../src/contracts/index.js";
import { openTempStore } from "./support.js";
import { bodyWith, storedMemory } from "./support.js";

const DEPLOY_BODY = bodyWith("部署端口约定为 8787，改动前先读回滚章节。");
const DEPLOY_URI = "memory://vestigio/mem-0001";

describe("Active and Archived index separation", () => {
  it("an archived memory is invisible to a default query and visible to an explicit Archived one", () => {
    const store = openTempStore();
    store.saveMemory(parseMemory(storedMemory({ body: DEPLOY_BODY })));

    expect(store.searchActive("端口").map((hit) => hit.memory_id)).toEqual(["mem-0001"]);
    expect(store.searchArchived("端口")).toEqual([]);

    store.setMemoryState(DEPLOY_URI, "archived");

    expect(store.searchActive("端口")).toEqual([]);
    expect(store.searchArchived("端口").map((hit) => hit.memory_id)).toEqual(["mem-0001"]);
    // Archived is not deleted: the medium body and its sources still read back.
    expect(store.readMemory(DEPLOY_URI)?.state).toBe("archived");
    expect(store.readMemory(DEPLOY_URI)?.medium.sources.length).toBe(1);
    expect(store.countMemories("archived")).toBe(1);
    expect(store.countMemories("published")).toBe(0);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  it("moves a memory back to Active without leaving a copy in the Archived index", () => {
    const store = openTempStore();
    store.saveMemory(parseMemory(storedMemory({ body: DEPLOY_BODY })));
    store.setMemoryState(DEPLOY_URI, "archived");
    store.setMemoryState(DEPLOY_URI, "published");

    expect(store.searchActive("端口")).toHaveLength(1);
    expect(store.searchArchived("端口")).toEqual([]);
    expect(store.integrityCheck()).toMatchObject({
      ok: true,
      headCount: 1,
      activeIndexCount: 1,
      archivedIndexCount: 0,
    });
    store.close();
  });

  it("indexes a medium_ready memory as Active", () => {
    const store = openTempStore();
    store.saveMemory(
      parseMemory(storedMemory({ body: DEPLOY_BODY, state: "medium_ready", nav: null })),
    );
    expect(store.searchActive("端口")).toHaveLength(1);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  it("keeps scope exact: a project query never sees another project or a global memory", () => {
    const store = openTempStore();
    store.saveMemory(parseMemory(storedMemory({ body: DEPLOY_BODY })));
    store.saveMemory(
      parseMemory(
        storedMemory({
          memory_id: "mem-0002",
          uri: "memory://vestigio/mem-0002",
          scope: { kind: "global" },
          body: bodyWith("全局偏好：端口一律使用 9000。"),
        }),
      ),
    );
    store.saveMemory(
      parseMemory(
        storedMemory({
          memory_id: "mem-0003",
          uri: "memory://vestigio/mem-0003",
          scope: { kind: "project", project_id: "p-other" },
          body: bodyWith("另一个项目的端口约定为 7000。"),
        }),
      ),
    );

    expect(
      store
        .searchActive("端口", { scope: { kind: "project", project_id: "p-vestigio" } })
        .map((hit) => hit.memory_id),
    ).toEqual(["mem-0001"]);
    expect(
      store.searchActive("端口", { scope: { kind: "global" } }).map((hit) => hit.memory_id),
    ).toEqual(["mem-0002"]);
    expect(store.searchActive("端口")).toHaveLength(3);
    store.close();
  });
});

describe("conflicting memories", () => {
  it("retains both sides of a conflict instead of overwriting one", () => {
    const store = openTempStore();
    const claimA = parseMemory(
      storedMemory({
        body: bodyWith("结论：端口是 8787。"),
        title: "端口约定",
        keywords: ["端口"],
      }),
    );
    const claimB = parseMemory(
      storedMemory({
        memory_id: "mem-0002",
        uri: "memory://vestigio/mem-0002",
        body: bodyWith("相反结论：端口是 9090，旧的 8787 已废弃。"),
        title: "端口约定（冲突）",
        keywords: ["端口"],
      }),
    );
    store.saveMemory(claimA);
    store.saveMemory(claimB);

    const hits = store.searchActive("端口");
    expect(hits.map((hit) => hit.memory_id).sort()).toEqual(["mem-0001", "mem-0002"]);
    expect(store.readMemory(claimA.uri)?.medium.body).toBe(claimA.medium.body);
    expect(store.readMemory(claimB.uri)?.medium.body).toBe(claimB.medium.body);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });
});
