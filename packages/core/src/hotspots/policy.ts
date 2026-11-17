/**
 * The swappable hotspot retention policy.
 *
 * Plan §4.1.1 and requirements §6 ask for exactly this shape: ship a simple,
 * defensible capacity rule now, keep it behind one function, and let the
 * experiment-driven PR-08 replace the ordering with decayed recent weights and
 * pressure replacement. Nothing else in the hotspot layer computes a retention
 * value, so PR-08 only has to change this file.
 *
 * The rule (basic policy, PR-05):
 *
 *   retention = 2 * (access_count + recent_access_weight)
 *             + 1 * (hit_count    + recent_hit_weight)
 *             + ADMISSION_RECENCY_BIAS * admittedRecency
 *
 *   admittedRecency = 1 / (1 + max(0, activity_seq - admitted_seq))
 *
 * Why this rule, and why not something else:
 *
 * - It uses only data the store already has. `hit_count` / `access_count` live
 *   on the memory head, `admitted_seq` on the membership row, and `activity_seq`
 *   is the project's real-input clock that PR-05 already maintains. No new
 *   statistics table, no wall-clock decay, no model.
 * - A successful read (access) outweighs a plain match (hit), because §3 says a
 *   match is weak evidence and a delivered long summary is strong evidence.
 * - The admission bias is a small, bounded head start (max 0.25) so a brand-new
 *   candidate can win a capacity slot, but it can never outrank an established
 *   member on its own: it is an order of magnitude below one access.
 * - `recent_*_weight` is always 0 in PR-05 because nothing writes it yet. It is
 *   in the formula so PR-08 can start writing it without a second rewrite.
 * - There is deliberately no time-based expiry. §4.1.1 forbids a fixed TTL and
 *   says an idle project keeps its pool; total capacity is the only pressure.
 */

import type { HotspotEntry } from "./types.js";

/** Per-project pool capacity. §4.1.1: a hard cap, not a token budget. */
export const DEFAULT_HOTSPOT_POOL_CAPACITY = 32;

/** Weight of one delivered long-summary read. */
export const RETENTION_ACCESS_WEIGHT = 2;
/** Weight of one hotspot match. */
export const RETENTION_HIT_WEIGHT = 1;
/** Maximum head start a freshly admitted candidate can carry. */
export const ADMISSION_RECENCY_BIAS = 0.25;
/**
 * How much a challenger must beat the weakest member by. §6 says replace only
 * when a clearly better candidate appears, to avoid pool churn; a margin rather
 * than a strict `>` on floating point noise.
 */
export const REPLACEMENT_MARGIN = 2;

export type RetentionInput = Pick<
  HotspotEntry,
  | "hit_count"
  | "access_count"
  | "recent_hit_weight"
  | "recent_access_weight"
  | "admitted_seq"
>;

export function retentionScore(entry: RetentionInput, activitySeq: number): number {
  const idleRounds = Math.max(0, activitySeq - entry.admitted_seq);
  const admissionRecency = 1 / (1 + idleRounds);
  return (
    RETENTION_ACCESS_WEIGHT * (entry.access_count + entry.recent_access_weight) +
    RETENTION_HIT_WEIGHT * (entry.hit_count + entry.recent_hit_weight) +
    ADMISSION_RECENCY_BIAS * admissionRecency
  );
}
