/**
 * Memory- and runtime-side aggregates over the store (OBS-03).
 *
 * These are pure reads: every function takes a store that satisfies the small
 * read surface below and returns plain numbers, so the same values feed a CLI
 * report, a test, or a future dashboard without a second writer. Nothing here
 * touches `turn_events`; the injection probability is derived from the counter
 * that already existed alongside the one OBS-03 adds.
 */

import type { MemoryState, ProjectActivity, UsageChannel, UsageEventKind } from "../contracts/index.js";
import { DEFAULT_HOTSPOT_POOL_CAPACITY } from "../hotspots/policy.js";
import type { TurnEventFilter, TurnOutcome, TurnOutcomeCount } from "../storage/index.js";

/**
 * The slice of `MemoryStore` these aggregates read. Structural rather than
 * `Pick<MemoryStore, ...>` so the stats stay decoupled from the writer and a
 * caller cannot accidentally mutate through this path.
 */
export interface StatsStore {
  countMemories(state?: MemoryState): number;
  countMemoriesByState(): { state: MemoryState; memories: number }[];
  countUsageEventsByChannel(kind: UsageEventKind): { channel: UsageChannel; count: number }[];
  countInjectionReceipts(): number;
  countInjectionReceiptInputs(): number;
  countTurnEvents(filter?: TurnEventFilter): number;
  turnOutcomeCounts(projectId?: string): TurnOutcomeCount[];
  readProjectActivity(projectId: string): ProjectActivity | null;
  listProjectActivity(): ProjectActivity[];
  readHotspotMemberships(projectId: string): { memory_id: string }[];
}

/** Every state a head revision can carry, in the order a report should print them. */
const MEMORY_STATES: readonly MemoryState[] = ["medium_ready", "published", "archived"];

/** How full one project's hotspot pool is, against the capacity it was read with. */
export type PoolOccupancy = {
  project_id: string;
  members: number;
  capacity: number;
  /** `members / capacity`; the admission invariant keeps it `<= 1`. */
  occupancy: number;
};

/** Head counts, by state and total, plus the current project's pool occupancy. */
export type MemoryStats = {
  total: number;
  by_state: { state: MemoryState; count: number }[];
  /** Heads not yet published: replaceable before the next published revision. */
  temporary: number;
  pool: PoolOccupancy;
};

/** `usage_events` rows of `kind = 'hit'`, grouped by how the hit was found. */
export type InjectionCounts = {
  total: number;
  by_channel: { channel: UsageChannel; count: number }[];
};

/** How many turns ran, and how each ended. */
export type TurnStats = {
  rows: number;
  by_outcome: TurnOutcomeCount[];
};

/**
 * The injection probability under both the new and the old denominator.
 *
 * New: `turn_events` delivered rows over the rows that are not `host_command`.
 * Old: distinct delivered `input_id`s over the project's `activity_seq`.
 * The gap between them is slash-command dilution: `project_activity` advances
 * for commands the handler never injects into, so the old denominator is
 * inflated. `null` means "no rows to divide", which is not the same as zero.
 */
export type InjectionProbability = {
  delivered: number;
  denominator: number;
  probability: number | null;
  host_command: number;
  receipts: number;
  receipt_inputs: number;
  activity_seq: number;
  activity_probability: number | null;
  /** `probability - activity_probability`, or null when either side is undefined. */
  delta: number | null;
};

/** The whole runtime side of the report: injections, turns, and their ratio. */
export type RuntimeStats = {
  injections: InjectionCounts;
  turns: TurnStats;
  probability: InjectionProbability;
};

function assertCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError(`pool capacity must be a positive integer, got ${capacity}`);
  }
}

/**
 * How many memories one project's hotspot pool holds, against `capacity`.
 * `capacity` defaults to the published pool size; passing the value the pool was
 * actually evaluated with is what makes the ratio comparable across a test that
 * shrinks the pool.
 */
export function readPoolOccupancy(
  store: StatsStore,
  projectId: string,
  capacity: number = DEFAULT_HOTSPOT_POOL_CAPACITY,
): PoolOccupancy {
  assertCapacity(capacity);
  const members = store.readHotspotMemberships(projectId).length;
  return { project_id: projectId, members, capacity, occupancy: members / capacity };
}

/**
 * Head counts by state and in total, the temporary count, and the project's pool
 * occupancy. States with no head report zero rather than being absent, so a
 * reader always sees the same three buckets.
 */
export function readMemoryStats(
  store: StatsStore,
  projectId: string,
  capacity: number = DEFAULT_HOTSPOT_POOL_CAPACITY,
): MemoryStats {
  const counted = new Map(store.countMemoriesByState().map((row) => [row.state, row.memories]));
  const by_state = MEMORY_STATES.map((state) => ({ state, count: counted.get(state) ?? 0 }));
  return {
    total: store.countMemories(),
    by_state,
    temporary: counted.get("medium_ready") ?? 0,
    pool: readPoolOccupancy(store, projectId, capacity),
  };
}

/** Injection counts: the `kind = 'hit'` usage rows, total and per channel. */
export function readInjectionCounts(store: StatsStore): InjectionCounts {
  const by_channel = store.countUsageEventsByChannel("hit");
  return { total: by_channel.reduce((sum, row) => sum + row.count, 0), by_channel };
}

/** Turn rows, total and per outcome, for one project or for the whole store. */
export function readTurnStats(store: StatsStore, projectId?: string): TurnStats {
  return {
    rows: store.countTurnEvents(projectId === undefined ? {} : { project_id: projectId }),
    by_outcome: store.turnOutcomeCounts(projectId),
  };
}

/**
 * The activity denominator: one project's sequence number, or the sum over
 * every project when no project is named.
 */
export function readActivitySeq(store: StatsStore, projectId?: string): number {
  if (projectId !== undefined) {
    return store.readProjectActivity(projectId)?.activity_seq ?? 0;
  }
  return store.listProjectActivity().reduce((sum, row) => sum + row.activity_seq, 0);
}

/**
 * The delivered-turn share under both denominators. The new one drops
 * `host_command` rows from the divisor; the old one divides distinct delivered
 * inputs by the activity counter. `activity_probability` is store-wide because
 * `injection_receipts` carries no project id.
 */
export function readInjectionProbability(store: StatsStore, projectId?: string): InjectionProbability {
  const turns = readTurnStats(store, projectId);
  const countFor = (outcome: TurnOutcome): number =>
    turns.by_outcome.find((row) => row.outcome === outcome)?.count ?? 0;
  const delivered = countFor("delivered");
  const host_command = countFor("host_command");
  const denominator = turns.rows - host_command;
  const probability = denominator === 0 ? null : delivered / denominator;

  const receipt_inputs = store.countInjectionReceiptInputs();
  const activity_seq = readActivitySeq(store, projectId);
  const activity_probability = activity_seq === 0 ? null : receipt_inputs / activity_seq;

  return {
    delivered,
    denominator,
    probability,
    host_command,
    receipts: store.countInjectionReceipts(),
    receipt_inputs,
    activity_seq,
    activity_probability,
    delta:
      probability === null || activity_probability === null ? null : probability - activity_probability,
  };
}

/** The runtime half of the report: injections, turns, and the probability pair. */
export function readRuntimeStats(store: StatsStore, projectId?: string): RuntimeStats {
  return {
    injections: readInjectionCounts(store),
    turns: readTurnStats(store, projectId),
    probability: readInjectionProbability(store, projectId),
  };
}
