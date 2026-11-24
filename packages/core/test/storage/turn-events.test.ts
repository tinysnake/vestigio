/**
 * Durable per-turn rows (`turn_events`) and the memory-side aggregates that read
 * them (OBS-03).
 *
 * The rows go in through the store itself, so the counts, the two denominators
 * of the injection probability, and the pool ratio are checked against hand
 * arithmetic instead of against the writer that produced them.
 */

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMemory } from "../../src/contracts/index.js";
import { admitHotspotCandidate, recordProjectInput } from "../../src/hotspots/index.js";
import { DEFAULT_HOTSPOT_POOL_CAPACITY } from "../../src/hotspots/policy.js";
import {
  readInjectionCounts,
  readInjectionProbability,
  readMemoryStats,
  readPoolOccupancy,
  readTurnStats,
} from "../../src/observability/stats.js";
import type { TurnEvent } from "../../src/storage/index.js";
import { NOW, PROJECT, newStore, seedMemory, setActivity } from "../hotspots/support.js";
import { makeInjectionReceipt, makeUsageEvent } from "../support.js";
import { bodyWith, openTempStore, storedMemory } from "./support.js";

function turn(overrides: Partial<TurnEvent> = {}): TurnEvent {
  return {
    turn_key: "s-1#1",
    project_id: PROJECT,
    session_id: "s-1",
    branch_ref: "main",
    input_id: "1",
    at: NOW,
    outcome: "delivered",
    reason: null,
    matched: 1,
    delivered: 1,
    estimated_tokens: 120,
    block_bytes: 300,
    handler_ms: 1,
    elapsed_ms: 2,
    ...overrides,
  };
}

describe("turn_events", () => {
  it("applies the 0007 migration once", () => {
    const store = openTempStore();
    expect(store.listMigrations().filter((migration) => migration.version === 7)).toHaveLength(1);
    store.close();
  });

  it("rewrites one turn_key in place, so a retry adds no row", () => {
    const store = openTempStore();
    store.recordTurnEvent(turn({ turn_key: "s-1#1", outcome: "delivered", delivered: 1 }));
    store.recordTurnEvent(
      turn({ turn_key: "s-1#1", outcome: "store_error", reason: "receipt_failed", delivered: 0 }),
    );

    expect(store.countTurnEvents()).toBe(1);
    expect(store.turnOutcomeCounts()).toEqual([{ outcome: "store_error", count: 1 }]);
    expect(store.countTurnEvents({ project_id: PROJECT, session_id: "s-1", outcome: "store_error" })).toBe(1);
    expect(store.countTurnEvents({ session_id: "s-2" })).toBe(0);
    store.close();
  });

  it("keeps host_command out of the probability denominator, on hand-checked numbers", () => {
    const store = openTempStore();
    // Project A: two delivered turns, one miss, one slash command.
    store.recordTurnEvent(turn({ turn_key: "a#1", project_id: "p-a", outcome: "delivered" }));
    store.recordTurnEvent(turn({ turn_key: "a#2", project_id: "p-a", outcome: "delivered" }));
    store.recordTurnEvent(turn({ turn_key: "a#3", project_id: "p-a", outcome: "no_match", reason: "no_match", delivered: 0 }));
    store.recordTurnEvent(
      turn({ turn_key: "a#4", project_id: "p-a", outcome: "host_command", reason: "slash_command", delivered: 0 }),
    );
    // Project B is separate: one delivered turn and one timeout.
    store.recordTurnEvent(turn({ turn_key: "b#1", project_id: "p-b", outcome: "delivered" }));
    store.recordTurnEvent(turn({ turn_key: "b#2", project_id: "p-b", outcome: "timeout", delivered: 0 }));

    expect(store.countTurnEvents()).toBe(6);
    expect(store.turnOutcomeCounts("p-a")).toEqual([
      { outcome: "delivered", count: 2 },
      { outcome: "host_command", count: 1 },
      { outcome: "no_match", count: 1 },
    ]);
    // The slash command was counted, but only the three injectable turns divide.
    const scope = readInjectionProbability(store, "p-a");
    expect(scope.delivered).toBe(2);
    expect(scope.host_command).toBe(1);
    expect(scope.denominator).toBe(3);
    expect(scope.probability).toBeCloseTo(2 / 3, 12);
    expect(scope.denominator).toBe(readTurnStats(store, "p-a").rows - scope.host_command);
    // Store-wide the same rule holds: 3 delivered over 5 non-command turns.
    const all = readInjectionProbability(store);
    expect(all.denominator).toBe(5);
    expect(all.probability).toBeCloseTo(3 / 5, 12);
    store.close();
  });

  it("matches hand arithmetic for both probability denominators", () => {
    const store = openTempStore();
    seedMemory(store, { memory_id: "mem-0001" });
    // Injections: two hotspot hits and one search hit; an access is not an injection.
    store.recordUsageEvent(makeUsageEvent({ kind: "hit", channel: "hotspot", input_id: "i-1" }));
    store.recordUsageEvent(makeUsageEvent({ kind: "hit", channel: "hotspot", input_id: "i-2" }));
    store.recordUsageEvent(makeUsageEvent({ kind: "hit", channel: "search", input_id: "i-3" }));
    store.recordUsageEvent(makeUsageEvent({ kind: "access", channel: "read", input_id: "i-4" }));
    // Turns: three delivered, one miss, one slash command.
    store.recordTurnEvent(turn({ turn_key: "t#1", outcome: "delivered" }));
    store.recordTurnEvent(turn({ turn_key: "t#2", outcome: "delivered" }));
    store.recordTurnEvent(turn({ turn_key: "t#3", outcome: "delivered" }));
    store.recordTurnEvent(turn({ turn_key: "t#4", outcome: "no_match", reason: "no_match", delivered: 0 }));
    store.recordTurnEvent(turn({ turn_key: "t#5", outcome: "host_command", reason: "slash_command", delivered: 0 }));
    // Deliveries: two distinct inputs recorded as receipts, over a clock of 8.
    setActivity(store, PROJECT, 8);
    store.recordInjectionReceipt(makeInjectionReceipt({ input_id: "i-1" }));
    store.recordInjectionReceipt(makeInjectionReceipt({ input_id: "i-2" }));

    expect(readInjectionCounts(store)).toEqual({
      total: 3,
      by_channel: [
        { channel: "hotspot", count: 2 },
        { channel: "search", count: 1 },
      ],
    });

    const probability = readInjectionProbability(store, PROJECT);
    expect(probability.delivered).toBe(3);
    expect(probability.denominator).toBe(4);
    expect(probability.probability).toBeCloseTo(3 / 4, 12);
    expect(probability.receipt_inputs).toBe(2);
    expect(probability.activity_seq).toBe(8);
    expect(probability.activity_probability).toBeCloseTo(2 / 8, 12);
    expect(probability.delta).toBeCloseTo(3 / 4 - 2 / 8, 12);
    store.close();
  });

  it("holds the pool at capacity and never reports occupancy above one", () => {
    const store = newStore();
    const capacity = 2;
    seedMemory(store, { memory_id: "mem-a", admitted_seq: 1 });
    seedMemory(store, { memory_id: "mem-b", admitted_seq: 2 });
    setActivity(store, PROJECT, 7);

    expect(readPoolOccupancy(store, PROJECT, capacity)).toEqual({
      project_id: PROJECT,
      members: 2,
      capacity,
      occupancy: 1,
    });
    // A third candidate that does not beat the weakest incumbent is refused,
    // so the pool replaces rather than grows.
    seedMemory(store, { memory_id: "mem-c", pooled: false });
    expect(
      admitHotspotCandidate({ store, project_id: PROJECT, memory_id: "mem-c", activity_seq: 7, capacity }),
    ).toMatchObject({ admitted: false, reason: "capacity" });
    const pool = readPoolOccupancy(store, PROJECT, capacity);
    expect(pool.members).toBe(capacity);
    expect(pool.occupancy).toBeLessThanOrEqual(1);
    store.close();
  });

  it("zero-fills the three states, counts temporary memories, and defaults the capacity", () => {
    const store = openTempStore();
    expect(readMemoryStats(store, PROJECT, 4)).toEqual({
      total: 0,
      by_state: [
        { state: "medium_ready", count: 0 },
        { state: "published", count: 0 },
        { state: "archived", count: 0 },
      ],
      temporary: 0,
      pool: { project_id: PROJECT, members: 0, capacity: 4, occupancy: 0 },
    });

    store.saveMemory(parseMemory(storedMemory({ memory_id: "mem-pub", body: bodyWith("已发布的部署说明。") })));
    store.saveMemory(
      parseMemory(
        storedMemory({
          memory_id: "mem-med",
          body: bodyWith("还没定稿的部署说明。"),
          state: "medium_ready",
          nav: null,
        }),
      ),
    );
    store.saveMemory(parseMemory(storedMemory({ memory_id: "mem-arc", body: bodyWith("已归档的部署说明。") })));
    store.setMemoryState("memory://vestigio/mem-arc", "archived");

    const stats = readMemoryStats(store, PROJECT, 4);
    expect(stats.total).toBe(3);
    expect(stats.by_state).toEqual([
      { state: "medium_ready", count: 1 },
      { state: "published", count: 1 },
      { state: "archived", count: 1 },
    ]);
    expect(stats.temporary).toBe(1);
    expect(stats.total).toBe(stats.by_state.reduce((sum, row) => sum + row.count, 0));
    // The published capacity is the default, and the ratio stays at or below one.
    expect(readPoolOccupancy(store, PROJECT).capacity).toBe(DEFAULT_HOTSPOT_POOL_CAPACITY);
    expect(readPoolOccupancy(store, PROJECT).occupancy).toBeLessThanOrEqual(1);
    store.close();
  });
});

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

describe("turn write cost", () => {
  it("costs less than one recordProjectInput call", () => {
    const store = openTempStore();
    const at = "2026-11-18T00:00:00Z";
    // Warm both paths so compiling the statements is not part of the sample.
    for (let i = 0; i < 20; i += 1) {
      recordProjectInput(store, "p-perf", at);
      store.recordTurnEvent(turn({ turn_key: `warm#${i}`, project_id: "p-perf" }));
    }

    const batch = 50;
    const runs = 10;
    const baseline: number[] = [];
    const write: number[] = [];
    let n = 20;
    for (let run = 0; run < runs; run += 1) {
      // The baseline goes first, and both batches run against the same store
      // state, so neither write pays for the other's page or WAL work.
      const startedAt = performance.now();
      for (let i = 0; i < batch; i += 1) recordProjectInput(store, "p-perf", at);
      baseline.push((performance.now() - startedAt) / batch);

      const turnStartedAt = performance.now();
      for (let i = 0; i < batch; i += 1) {
        store.recordTurnEvent(turn({ turn_key: `p-perf#${n++}`, project_id: "p-perf" }));
      }
      write.push((performance.now() - turnStartedAt) / batch);
    }

    // The added cost of one turn write must stay under 1x one input record.
    const baselineMedian = median(baseline);
    const writeMedian = median(write);
    const outPath = process.env.VESTIGIO_PERF_OUT;
    if (outPath !== undefined && outPath !== "") {
      const report = { batch, runs, baseline_ms: baselineMedian, turn_write_ms: writeMedian, ratio: writeMedian / baselineMedian };
      writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    expect(writeMedian, `turn write ${writeMedian} vs input record ${baselineMedian}`).toBeLessThan(
      baselineMedian,
    );
    store.close();
  });
});
