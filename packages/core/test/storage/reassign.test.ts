import { describe, expect, it } from "vitest";
import { parseMemory } from "../../src/contracts/index.js";
import type { MemoryUri, Memory } from "../../src/contracts/index.js";
import { bodyWith, makeSourceRef, openTempStore } from "./support.js";
import { makeMemory } from "../support.js";

const REPO = "/repo";
const WORKTREE = "/repo/.git-worktrees/feature";
const URI = "memory://vestigio/mem-0001" as MemoryUri;

/** A memory saved by a client that still used its own worktree as the project id. */
function worktreeMemory(memoryId = "mem-0001"): Memory {
  const body = bodyWith("部署脚本默认端口是 8787，改端口前先读这份记忆。");
  return parseMemory({
    ...makeMemory({
      memory_id: memoryId,
      uri: `memory://vestigio/${memoryId}`,
      scope: { kind: "project", project_id: WORKTREE },
    }),
    medium: {
      body,
      body_char_count: [...body.replace(/\s/gu, "")].length,
      sources: [makeSourceRef({ project_id: WORKTREE })],
    },
  });
}

describe("reassignProjectScope", () => {
  it("moves the memories, sources, hotspot rows and activity of one project id onto another", () => {
    const store = openTempStore();
    store.saveMemory(worktreeMemory());
    store.upsertProjectActivity({
      project_id: WORKTREE,
      activity_seq: 4,
      last_input_at: "2026-11-17T16:30:00Z",
    });
    store.upsertHotspotMembership({
      project_id: WORKTREE,
      memory_id: "mem-0001",
      admitted_seq: 2,
      last_hit_seq: 5,
      last_access_seq: 5,
      recent_hit_weight: 0.5,
      recent_access_weight: 0.25,
    });

    expect(store.reassignProjectScope(WORKTREE, REPO)).toEqual({
      from: WORKTREE,
      to: REPO,
      memory_ids: ["mem-0001"],
      revisions: 1,
      sources: 1,
      memberships: 1,
      activity: true,
    });

    expect(store.listProjectIds()).toEqual([REPO]);
    const [moved] = store.listHeads({ kind: "project", project_id: REPO });
    expect(moved?.scope).toEqual({ kind: "project", project_id: REPO });
    expect(moved?.medium.sources.map((source) => source.project_id)).toEqual([REPO]);
    expect(store.listHeads({ kind: "project", project_id: WORKTREE })).toEqual([]);
    expect(
      store
        .searchActive("端口", { scope: { kind: "project", project_id: REPO } })
        .map((hit) => hit.memory_id),
    ).toEqual(["mem-0001"]);

    expect(store.readProjectActivity(WORKTREE)).toBeNull();
    expect(store.readProjectActivity(REPO)).toMatchObject({ project_id: REPO, activity_seq: 4 });
    expect(store.readHotspotMemberships(WORKTREE)).toEqual([]);
    expect(store.readHotspotMemberships(REPO).map((row) => row.last_hit_seq)).toEqual([5]);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  it("leaves a moved revision saveable as an idempotent no-op", () => {
    const store = openTempStore();
    store.saveMemory(worktreeMemory());
    store.reassignProjectScope(WORKTREE, REPO);

    const moved = store.readMemory(URI);
    if (moved === null) {
      throw new Error("the moved memory vanished");
    }
    expect(moved.scope).toEqual({ kind: "project", project_id: REPO });
    expect(store.saveMemory(moved)).toMatchObject({ inserted: false, revision: 1 });
    store.close();
  });

  it("merges the target's own counters instead of colliding with them", () => {
    const store = openTempStore();
    store.saveMemory(worktreeMemory());
    store.upsertProjectActivity({
      project_id: WORKTREE,
      activity_seq: 3,
      last_input_at: "2026-11-17T16:30:00Z",
    });
    store.upsertProjectActivity({
      project_id: REPO,
      activity_seq: 7,
      last_input_at: "2026-11-18T09:00:00Z",
    });
    store.upsertHotspotMembership({
      project_id: WORKTREE,
      memory_id: "mem-0001",
      admitted_seq: 1,
      last_hit_seq: 9,
      last_access_seq: 2,
      recent_hit_weight: 0.5,
      recent_access_weight: 0.1,
    });
    store.upsertHotspotMembership({
      project_id: REPO,
      memory_id: "mem-0001",
      admitted_seq: 5,
      last_hit_seq: 2,
      last_access_seq: 8,
      recent_hit_weight: 0.25,
      recent_access_weight: 0.75,
    });

    store.reassignProjectScope(WORKTREE, REPO);

    expect(store.readHotspotMemberships(REPO)).toEqual([
      {
        project_id: REPO,
        memory_id: "mem-0001",
        admitted_seq: 5,
        last_hit_seq: 9,
        last_access_seq: 8,
        recent_hit_weight: 0.5,
        recent_access_weight: 0.75,
      },
    ]);
    expect(store.readHotspotMemberships(WORKTREE)).toEqual([]);
    expect(store.readProjectActivity(REPO)).toEqual({
      project_id: REPO,
      activity_seq: 7,
      last_input_at: "2026-11-18T09:00:00Z",
    });
    expect(store.readProjectActivity(WORKTREE)).toBeNull();
    store.close();
  });

  it("changes nothing the second time", () => {
    const store = openTempStore();
    store.saveMemory(worktreeMemory());
    store.reassignProjectScope(WORKTREE, REPO);

    expect(store.reassignProjectScope(WORKTREE, REPO)).toEqual({
      from: WORKTREE,
      to: REPO,
      memory_ids: [],
      revisions: 0,
      sources: 0,
      memberships: 0,
      activity: false,
    });
    expect(store.listProjectIds()).toEqual([REPO]);
    expect(store.listHeads({ kind: "project", project_id: REPO })).toHaveLength(1);
    store.close();
  });

  it("refuses to move a project onto itself or to an empty id", () => {
    const store = openTempStore();
    expect(() => store.reassignProjectScope(REPO, REPO)).toThrow(/two different project ids/);
    expect(() => store.reassignProjectScope(REPO, "")).toThrow(/project_id/);
    store.close();
  });

  it("counts the head revisions each project id owns, archived included", () => {
    const store = openTempStore();
    store.saveMemory(worktreeMemory());
    store.saveMemory(
      parseMemory({
        ...makeMemory({
          memory_id: "mem-0002",
          uri: "memory://vestigio/mem-0002",
          scope: { kind: "project", project_id: "/elsewhere" },
          state: "archived",
        }),
      }),
    );

    expect(store.countMemoriesByProject()).toEqual([
      { project_id: "/elsewhere", memories: 1 },
      { project_id: WORKTREE, memories: 1 },
    ]);
    store.close();
  });
});
