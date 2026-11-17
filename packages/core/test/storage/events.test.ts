import { describe, expect, it } from "vitest";
import { StorageError } from "../../src/storage/index.js";
import { makeInjectionReceipt, makeUsageEvent } from "../support.js";
import { bodyWith, memoryAtRevision, openTempStore, storedMemory } from "./support.js";

/** A stored memory whose counters start at zero, so each assertion is an increment. */
function freshCounters() {
  return storedMemory({ hit_count: 0, access_count: 0, last_access_at: null });
}

describe("usage events", () => {
  it("dedupes a retried event with the same derived event_id", () => {
    const store = openTempStore();
    const event = makeUsageEvent();

    expect(store.recordUsageEvent(event)).toBe(true);
    expect(store.recordUsageEvent(event)).toBe(false);
    expect(store.countUsageEvents()).toBe(1);
    expect(store.hasUsageEvent(event.event_id)).toBe(true);
    store.close();
  });

  it("keeps events that differ in any hashed field", () => {
    const store = openTempStore();
    expect(store.recordUsageEvent(makeUsageEvent({ kind: "hit" }))).toBe(true);
    expect(store.recordUsageEvent(makeUsageEvent({ kind: "access", channel: "read" }))).toBe(true);
    expect(store.recordUsageEvent(makeUsageEvent({ at: "2026-11-17T16:32:00Z" }))).toBe(true);
    expect(store.countUsageEvents()).toBe(3);
    store.close();
  });

  it("applies a hit to the head row's counter without counting a retry twice", () => {
    const store = openTempStore();
    store.saveMemory(freshCounters());
    const event = makeUsageEvent({ kind: "hit", channel: "hotspot" });

    expect(store.recordUsageEvent(event)).toBe(true);
    expect(store.recordUsageEvent(event)).toBe(false);
    expect(store.readMemory("memory://vestigio/mem-0001")?.hit_count).toBe(1);
    store.close();
  });

  it("counts every access and keeps last_access_at at the newest delivery", () => {
    const store = openTempStore();
    store.saveMemory(freshCounters());

    store.recordUsageEvent(makeUsageEvent({ kind: "access", channel: "read", at: "2026-11-17T17:00:00Z" }));
    store.recordUsageEvent(makeUsageEvent({ kind: "access", channel: "read", at: "2026-11-17T18:00:00Z" }));
    store.recordUsageEvent(makeUsageEvent({ kind: "access", channel: "read", at: "2026-11-17T16:00:00Z" }));

    const memory = store.readMemory("memory://vestigio/mem-0001");
    expect(memory?.access_count).toBe(3);
    expect(memory?.last_access_at).toBe("2026-11-17T18:00:00Z");
    expect(memory?.hit_count).toBe(0);
    store.close();
  });

  it("counts an older revision's hit against the head, which is what ranking reads", () => {
    const store = openTempStore();
    store.saveMemory(freshCounters());
    store.saveMemory(
      memoryAtRevision(2, {
        body: bodyWith("第二版部署配置。"),
        hit_count: 0,
        access_count: 0,
        last_access_at: null,
      }),
    );
    store.recordUsageEvent(makeUsageEvent({ kind: "hit", revision: 1 }));

    const head = store.readMemory("memory://vestigio/mem-0001");
    expect(head?.revision).toBe(2);
    expect(head?.hit_count).toBe(1);
    store.close();
  });

  it("logs an event for an absent memory without inventing a counter row", () => {
    const store = openTempStore();
    expect(
      store.recordUsageEvent(makeUsageEvent({ memory_id: "mem-missing", dedup_key: "absent" })),
    ).toBe(true);
    expect(store.readMemory("memory://vestigio/mem-missing")).toBeNull();
    expect(store.countUsageEvents()).toBe(1);
    expect(store.countMemories()).toBe(0);
    store.close();
  });

  it("rejects an event_id that does not match its own fields", () => {
    const store = openTempStore();
    const forged = { ...makeUsageEvent(), event_id: "not-the-derived-id" };
    expect(() => store.recordUsageEvent(forged)).toThrow();
    expect(store.countUsageEvents()).toBe(0);
    store.close();
  });
});

describe("injection receipts", () => {
  it("records a delivered injection exactly once", () => {
    const store = openTempStore();
    const receipt = makeInjectionReceipt();
    store.recordInjectionReceipt(receipt);
    expect(store.hasInjectionReceipt("s-1", "main", "input-1", "mem-0001")).toBe(true);
    expect(store.countInjectionReceipts()).toBe(1);
    store.close();
  });

  it("rejects a duplicate (session, branch, input, memory) even across revisions", () => {
    const store = openTempStore();
    store.recordInjectionReceipt(makeInjectionReceipt());
    expect(() => store.recordInjectionReceipt(makeInjectionReceipt())).toThrow(StorageError);
    expect(() =>
      store.recordInjectionReceipt(makeInjectionReceipt({ revision: 2 })),
    ).toThrow(StorageError);
    expect(store.countInjectionReceipts()).toBe(1);
    store.close();
  });

  it("allows a new session or a new input to inject the same memory", () => {
    const store = openTempStore();
    store.recordInjectionReceipt(makeInjectionReceipt());
    store.recordInjectionReceipt(makeInjectionReceipt({ session_id: "s-2" }));
    store.recordInjectionReceipt(makeInjectionReceipt({ input_id: "input-2" }));
    store.recordInjectionReceipt(makeInjectionReceipt({ branch_ref: "feature" }));
    expect(store.countInjectionReceipts()).toBe(4);
    store.close();
  });

  it("rejects a receipt from another store", () => {
    const store = openTempStore({ storeId: "vestigio" });
    expect(() => store.recordInjectionReceipt(makeInjectionReceipt({ store_id: "other" }))).toThrow(
      StorageError,
    );
    store.close();
  });
});

describe("project activity and hotspot membership", () => {
  it("advances the logical clock only forward", () => {
    const store = openTempStore();
    expect(
      store.upsertProjectActivity({
        project_id: "p-vestigio",
        activity_seq: 1,
        last_input_at: "2026-11-17T16:00:00Z",
      }).activity_seq,
    ).toBe(1);
    store.upsertProjectActivity({
      project_id: "p-vestigio",
      activity_seq: 3,
      last_input_at: "2026-11-17T16:10:00Z",
    });
    const stale = store.upsertProjectActivity({
      project_id: "p-vestigio",
      activity_seq: 2,
      last_input_at: "2026-11-17T16:20:00Z",
    });
    expect(stale.activity_seq).toBe(3);
    expect(stale.last_input_at).toBe("2026-11-17T16:10:00Z");
    store.close();
  });

  it("round-trips and removes hotspot memberships", () => {
    const store = openTempStore();
    const membership = {
      project_id: "p-vestigio",
      memory_id: "mem-0001",
      admitted_seq: 4,
      last_hit_seq: 9,
      last_access_seq: 7,
      recent_hit_weight: 0.5,
      recent_access_weight: 1.25,
    };
    store.upsertHotspotMembership(membership);
    store.upsertHotspotMembership({ ...membership, last_hit_seq: 10 });
    expect(store.readHotspotMemberships("p-vestigio")).toEqual([
      { ...membership, last_hit_seq: 10 },
    ]);
    store.deleteHotspotMembership("p-vestigio", "mem-0001");
    expect(store.readHotspotMemberships("p-vestigio")).toEqual([]);
    store.close();
  });
});
