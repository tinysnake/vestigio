import { describe, expect, it } from "vitest";
import { InjectionLedger, type InjectionLedgerDelta } from "../../src/hotspots/index.js";

const MAIN_A: InjectionLedgerDelta = { at: "2026-11-17T10:00:00Z", input_id: "input-1", memory_ids: ["mem-a"] };
const MAIN_B: InjectionLedgerDelta = { at: "2026-11-17T10:05:00Z", input_id: "input-2", memory_ids: ["mem-b"] };
const FORK_C: InjectionLedgerDelta = { at: "2026-11-17T10:10:00Z", input_id: "input-3", memory_ids: ["mem-c"] };
const REVERTED_D: InjectionLedgerDelta = { at: "2026-11-17T10:20:00Z", input_id: "input-4", memory_ids: ["mem-d"] };

describe("InjectionLedger", () => {
  it("records a memory once and keeps the first delivery timestamp", () => {
    const ledger = new InjectionLedger();
    expect(ledger.add("mem-a", MAIN_A.at)).toBe(true);
    expect(ledger.add("mem-a", FORK_C.at)).toBe(false);
    expect(ledger.deliveredAt("mem-a")).toBe(MAIN_A.at);
    expect(ledger.has("mem-a")).toBe(true);
    expect(ledger.has("mem-b")).toBe(false);
  });

  it("addMany reports only the newly added ids", () => {
    const ledger = InjectionLedger.fromIds(["mem-a"], MAIN_A.at);
    expect(ledger.addMany(["mem-a", "mem-b"], MAIN_B.at)).toEqual(["mem-b"]);
    expect(ledger.size).toBe(2);
  });

  it("keeps the earliest stamp for an id regardless of replay order", () => {
    const early: InjectionLedgerDelta = { at: "2026-11-17T09:00:00Z", input_id: "input-0", memory_ids: ["mem-a"] };
    const late: InjectionLedgerDelta = { at: "2026-11-17T11:00:00Z", input_id: "input-9", memory_ids: ["mem-a"] };
    expect(InjectionLedger.replay([early, late]).deliveredAt("mem-a")).toBe(early.at);
    // A branch is walked leaf-first, so the same pair may arrive newest first.
    expect(InjectionLedger.replay([late, early]).deliveredAt("mem-a")).toBe(early.at);
  });

  it("restores across a restart by replaying the persisted deltas", () => {
    const before = InjectionLedger.replay([MAIN_A, MAIN_B]);
    const persisted = [MAIN_A, MAIN_B];
    const afterRestart = InjectionLedger.replay(persisted);
    expect(afterRestart.ids().sort()).toEqual(before.ids().sort());
    expect(afterRestart.has("mem-b")).toBe(true);
  });

  it("a fork inherits the affected branch's records", () => {
    const forked = InjectionLedger.replay([MAIN_A, MAIN_B, FORK_C]);
    expect(forked.has("mem-a")).toBe(true);
    expect(forked.has("mem-c")).toBe(true);
  });

  it("a revert is not held back by the abandoned branch", () => {
    const reverted = InjectionLedger.replay([MAIN_A, MAIN_B, REVERTED_D]);
    expect(reverted.has("mem-a")).toBe(true);
    expect(reverted.has("mem-c")).toBe(false);
  });

  it("is unchanged by a revision bump or a compaction, since it keys on memory id", () => {
    const ledger = InjectionLedger.fromIds(["mem-a"], MAIN_A.at);
    expect(ledger.has("mem-a")).toBe(true);
    // Re-entering the hotspot does not reset the record.
    expect(ledger.add("mem-a", REVERTED_D.at)).toBe(false);
    expect(ledger.deliveredAt("mem-a")).toBe(MAIN_A.at);
  });
});
