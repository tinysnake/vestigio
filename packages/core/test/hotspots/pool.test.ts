import { describe, expect, it } from "vitest";
import { makeFakeMemory } from "./support.js";
import {
  admitHotspotCandidate,
  evaluatePool,
  markHotspotAccess,
  markHotspotHits,
  recordProjectInput,
} from "../../src/hotspots/index.js";
import { FakeStore, PROJECT, newStore, seedMemory, setActivity } from "./support.js";

describe("evaluatePool", () => {
  it("joins memberships to published memories and carries the source label", () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-0001", admitted_seq: 3 });
    setActivity(store, PROJECT, 7);
    const pool = evaluatePool({ store, project_id: PROJECT, activity_seq: 7 });
    expect(pool.entries).toHaveLength(1);
    expect(pool.entries[0]?.nav_text).toContain("部署");
    expect(pool.entries[0]?.source_label).toBe("pi/local");
    expect(pool.entries[0]?.admitted_seq).toBe(3);
    expect(pool.skipped).toEqual([]);
    store.close();
  });

  it("reports unusable members instead of silently dropping them", () => {
    const fake = new FakeStore();
    const published = makeFakeMemory({ memory_id: "mem-ok" });
    const archived = makeFakeMemory({ memory_id: "mem-arch", state: "archived" });
    const global = makeFakeMemory({ memory_id: "mem-global", scope: { kind: "global" } });
    const stale = {
      ...makeFakeMemory({ memory_id: "mem-stale" }),
      nav: { text: "旧摘要", char_count: 3, source_revision: 99 },
    };
    for (const memory of [published, archived, global, stale]) {
      fake.memories.set(memory.uri, memory);
      fake.upsertHotspotMembership({
        project_id: PROJECT,
        memory_id: memory.memory_id,
        admitted_seq: 1,
        last_hit_seq: 0,
        last_access_seq: 0,
        recent_hit_weight: 0,
        recent_access_weight: 0,
      });
    }
    fake.upsertHotspotMembership({
      project_id: PROJECT,
      memory_id: "mem-missing",
      admitted_seq: 1,
      last_hit_seq: 0,
      last_access_seq: 0,
      recent_hit_weight: 0,
      recent_access_weight: 0,
    });

    const pool = evaluatePool({ store: fake, project_id: PROJECT, activity_seq: 2 });
    expect(pool.entries.map((entry) => entry.memory_id)).toEqual(["mem-ok"]);
    const reasons = Object.fromEntries(pool.skipped.map((skip) => [skip.memory_id, skip.reason]));
    expect(reasons).toEqual({
      "mem-arch": "state_archived",
      "mem-global": "scope_mismatch",
      "mem-missing": "memory_missing",
      "mem-stale": "nav_not_ready",
    });
  });
});

describe("pool retention", () => {
  it("keeps an idle project's pool and never decays it from another project", () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-a" });
    seedMemory(store, { memory_id: "mem-b" });
    setActivity(store, PROJECT, 3);
    const before = evaluatePool({ store, project_id: PROJECT, activity_seq: 3 });
    setActivity(store, "p-other", 500);
    const after = evaluatePool({ store, project_id: PROJECT, activity_seq: 3 });
    expect(after.entries.map((entry) => [entry.memory_id, entry.admitted_seq])).toEqual(
      before.entries.map((entry) => [entry.memory_id, entry.admitted_seq]),
    );
    expect(after.entries).toHaveLength(2);
    store.close();
  });

  it("replaces the weakest member only when a clearly stronger candidate appears", () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-a", admitted_seq: 1 });
    seedMemory(store, { memory_id: "mem-b", admitted_seq: 1 });
    seedMemory(store, { memory_id: "mem-strong", pooled: false, hit_count: 10, access_count: 10 });
    seedMemory(store, { memory_id: "mem-weak", pooled: false });

    const weak = admitHotspotCandidate({
      store,
      project_id: PROJECT,
      memory_id: "mem-weak",
      activity_seq: 5,
      capacity: 2,
    });
    expect(weak).toMatchObject({ admitted: false, reason: "capacity", replaced: null });

    const strong = admitHotspotCandidate({
      store,
      project_id: PROJECT,
      memory_id: "mem-strong",
      activity_seq: 5,
      capacity: 2,
    });
    expect(strong.admitted).toBe(true);
    expect(strong.replaced).toBe("mem-a");
    const after = evaluatePool({ store, project_id: PROJECT, activity_seq: 5 });
    expect(after.entries.map((entry) => entry.memory_id).sort()).toEqual(["mem-b", "mem-strong"]);
    store.close();
  });

  it("admits below capacity and is idempotent for an existing member", () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-a" });
    seedMemory(store, { memory_id: "mem-b", pooled: false });
    expect(
      admitHotspotCandidate({ store, project_id: PROJECT, memory_id: "mem-b", activity_seq: 2, capacity: 4 }),
    ).toMatchObject({ admitted: true, reason: "admitted" });
    expect(
      admitHotspotCandidate({ store, project_id: PROJECT, memory_id: "mem-b", activity_seq: 2, capacity: 4 }),
    ).toMatchObject({ admitted: true, reason: "already_member" });
    expect(evaluatePool({ store, project_id: PROJECT, activity_seq: 2 }).entries).toHaveLength(2);
    store.close();
  });

  it("refuses a candidate with no ready navigation summary", () => {
    const fake = new FakeStore();
    const memory = makeFakeMemory({ memory_id: "mem-0001" });
    fake.memories.set(memory.uri, { ...memory, nav: null, state: "medium_ready" });
    const result = admitHotspotCandidate({
      store: fake,
      project_id: PROJECT,
      memory_id: memory.memory_id,
      activity_seq: 1,
    });
    expect(result).toMatchObject({ admitted: false, reason: "nav_not_ready" });
  });
});

describe("pool statistics", () => {
  it("advances the project clock only through recordProjectInput", () => {
    const store = newStore();
    expect(recordProjectInput(store, PROJECT, "2026-11-17T18:00:00Z").activity_seq).toBe(1);
    expect(recordProjectInput(store, PROJECT, "2026-11-17T18:01:00Z").activity_seq).toBe(2);
    expect(store.readProjectActivity(PROJECT)?.last_input_at).toBe("2026-11-17T18:01:00Z");
    store.close();
  });

  it("marks hits and accesses on the membership row", () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-a" });
    expect(markHotspotHits(store, PROJECT, ["mem-a", "mem-absent"], 4)).toBe(1);
    expect(markHotspotAccess(store, PROJECT, "mem-a", 5)).toBe(true);
    expect(markHotspotAccess(store, PROJECT, "mem-absent", 5)).toBe(false);
    const row = store.readHotspotMemberships(PROJECT)[0];
    expect(row?.last_hit_seq).toBe(4);
    expect(row?.last_access_seq).toBe(5);
    store.close();
  });
});
