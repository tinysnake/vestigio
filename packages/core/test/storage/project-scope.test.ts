import { describe, expect, it } from "vitest";
import { parseMemory } from "../../src/contracts/index.js";
import type { Scope } from "../../src/contracts/index.js";
import { bodyWith, openTempStore, storedMemory } from "./support.js";

const REPO_ROOT = "/repo";
const OLD_WORKTREE = "/repo/.git-worktrees/feature";

describe("project scope aliases", () => {
  it("widens listHeads, hasMemories and searchActive over the scope's project ids", () => {
    const store = openTempStore();
    store.saveMemory(
      parseMemory(
        storedMemory({
          body: bodyWith("部署脚本默认端口是 8787。"),
          scope: { kind: "project", project_id: OLD_WORKTREE },
        }),
      ),
    );

    const aliased: Scope = { kind: "project", project_id: REPO_ROOT, project_ids: [OLD_WORKTREE] };
    const canonical: Scope = { kind: "project", project_id: REPO_ROOT };

    expect(store.listProjectIds()).toEqual([OLD_WORKTREE]);

    expect(store.hasMemories(aliased)).toBe(true);
    expect(store.hasMemories(canonical)).toBe(false);

    expect(store.listHeads(aliased).map((memory) => memory.uri)).toEqual(["memory://vestigio/mem-0001"]);
    expect(store.listHeads(canonical)).toEqual([]);

    expect(store.searchActive("端口", { scope: aliased }).map((hit) => hit.memory_id)).toEqual(["mem-0001"]);
    expect(store.searchActive("端口", { scope: canonical })).toEqual([]);

    store.close();
  });

  it("lists every distinct project id the store holds", () => {
    const store = openTempStore();
    store.saveMemory(
      parseMemory(storedMemory({ body: bodyWith("端口是 8787。"), scope: { kind: "project", project_id: "/b" } })),
    );
    store.saveMemory(
      parseMemory(
        storedMemory({
          memory_id: "mem-0002",
          uri: "memory://vestigio/mem-0002",
          body: bodyWith("端口是 9090。"),
          scope: { kind: "project", project_id: "/a" },
        }),
      ),
    );
    store.saveMemory(
      parseMemory(
        storedMemory({
          memory_id: "mem-0003",
          uri: "memory://vestigio/mem-0003",
          body: bodyWith("全局端口约定。"),
          scope: { kind: "global" },
        }),
      ),
    );

    expect(store.listProjectIds()).toEqual(["/a", "/b"]);
    store.close();
  });
});
