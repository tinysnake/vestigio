/**
 * The hotspot pool: per-project membership, the join to a usable memory, and
 * the capacity admission rule.
 *
 * The pool is persisted through the store's `hotspot_memberships` table, so it
 * survives restart and does not vanish when a project goes idle. Nothing in
 * this file reads wall-clock time for eviction: the only time signal is the
 * project's own `activity_seq`, which advances on real user input only.
 */

import {
  memoryUri,
  type HotspotMembership,
  type Memory,
  type MemoryId,
  type ProjectActivity,
} from "../contracts/index.js";
import type { Deadline } from "./deadline.js";
import {
  DEFAULT_HOTSPOT_POOL_CAPACITY,
  REPLACEMENT_MARGIN,
  retentionScore,
  type RetentionInput,
} from "./policy.js";
import type { HotspotEntry, HotspotPool, HotspotStore, PoolSkip } from "./types.js";

export type EvaluatePoolInput = {
  store: HotspotStore;
  project_id: string;
  /** 0 when the project has never seen real input. */
  activity_seq: number;
  capacity?: number;
  deadline?: Deadline;
};

/**
 * Read the project's memberships and join each to the head of its memory.
 * Rows that cannot be injected right now are returned as `skipped` instead of
 * silently disappearing, so a caller can report why the pool is thin.
 */
export function evaluatePool(input: EvaluatePoolInput): HotspotPool {
  const capacity = input.capacity ?? DEFAULT_HOTSPOT_POOL_CAPACITY;
  const memberships = input.store.readHotspotMemberships(input.project_id);
  input.deadline?.check("readHotspotMemberships");
  const entries: HotspotEntry[] = [];
  const skipped: PoolSkip[] = [];
  for (const membership of memberships) {
    input.deadline?.check("joinPool");
    const uri = memoryUri(input.store.storeId, membership.memory_id);
    const memory = input.store.readMemory(uri);
    input.deadline?.check("readMemory");
    const joined = joinMember(memory, membership, input.project_id);
    if (joined.kind === "entry") {
      entries.push(joined.entry);
    } else {
      skipped.push({ memory_id: membership.memory_id, reason: joined.reason });
    }
  }
  return { project_id: input.project_id, activity_seq: input.activity_seq, capacity, entries, skipped };
}

type JoinResult = { kind: "entry"; entry: HotspotEntry } | { kind: "skip"; reason: PoolSkip["reason"] };

function joinMember(
  memory: Memory | null,
  membership: HotspotMembership,
  projectId: string,
): JoinResult {
  if (memory === null) {
    return { kind: "skip", reason: "memory_missing" };
  }
  if (memory.scope.kind !== "project" || memory.scope.project_id !== projectId) {
    return { kind: "skip", reason: "scope_mismatch" };
  }
  if (memory.state === "archived") {
    return { kind: "skip", reason: "state_archived" };
  }
  if (memory.state !== "published") {
    return { kind: "skip", reason: "state_not_published" };
  }
  // A navigation summary that does not bind to the current body revision is
  // not ready; §2 forbids showing a stale short summary over a new body.
  if (memory.nav === null || memory.nav.source_revision !== memory.revision) {
    return { kind: "skip", reason: "nav_not_ready" };
  }
  const firstSource = memory.medium.sources[0];
  return {
    kind: "entry",
    entry: {
      memory_id: memory.memory_id,
      uri: memory.uri,
      title: memory.title,
      keywords: memory.keywords,
      nav: memory.nav,
      nav_text: memory.nav.text,
      revision: memory.revision,
      state: memory.state,
      scope: memory.scope,
      source_label: firstSource === undefined ? null : `${firstSource.provider}/${firstSource.source_instance}`,
      source_count: memory.medium.sources.length,
      hit_count: memory.hit_count,
      access_count: memory.access_count,
      last_access_at: memory.last_access_at,
      admitted_seq: membership.admitted_seq,
      last_hit_seq: membership.last_hit_seq,
      last_access_seq: membership.last_access_seq,
      recent_hit_weight: membership.recent_hit_weight,
      recent_access_weight: membership.recent_access_weight,
    },
  };
}

/** Advance a project's real-input clock by one round. Monotonic in the store. */
export function recordProjectInput(
  store: HotspotStore,
  projectId: string,
  at: string,
): ProjectActivity {
  const existing = store.readProjectActivity(projectId);
  return store.upsertProjectActivity({
    project_id: projectId,
    activity_seq: (existing?.activity_seq ?? 0) + 1,
    last_input_at: at,
  });
}

export type AdmissionReason =
  | "admitted"
  | "already_member"
  | "memory_missing"
  | "scope_mismatch"
  | "state_archived"
  | "state_not_published"
  | "nav_not_ready"
  | "capacity";

export type AdmissionResult = {
  admitted: boolean;
  reason: AdmissionReason;
  /** Set when the admission pushed another memory out of the pool. */
  replaced: MemoryId | null;
  retention: number | null;
};

export type AdmitCandidateInput = {
  store: HotspotStore;
  project_id: string;
  memory_id: MemoryId;
  activity_seq: number;
  capacity?: number;
  /** ISO timestamp kept on the membership refresh. Membership has no `at`. */
  deadline?: Deadline;
};

/**
 * Admit one candidate to the project pool.
 *
 * Candidates come from the independent promotion entry points (a freshly
 * generated complete summary, an explicit pin, or a memory found by active
 * search and successfully read). Search exposure alone is not a promotion.
 */
export function admitHotspotCandidate(input: AdmitCandidateInput): AdmissionResult {
  const capacity = input.capacity ?? DEFAULT_HOTSPOT_POOL_CAPACITY;
  const uri = memoryUri(input.store.storeId, input.memory_id);
  const memory = input.store.readMemory(uri);
  input.deadline?.check("admit.readMemory");
  if (memory === null) {
    return { admitted: false, reason: "memory_missing", replaced: null, retention: null };
  }
  if (memory.scope.kind !== "project" || memory.scope.project_id !== input.project_id) {
    return { admitted: false, reason: "scope_mismatch", replaced: null, retention: null };
  }
  if (memory.state === "archived") {
    return { admitted: false, reason: "state_archived", replaced: null, retention: null };
  }
  if (memory.state !== "published" || memory.nav === null || memory.nav.source_revision !== memory.revision) {
    return { admitted: false, reason: "nav_not_ready", replaced: null, retention: null };
  }

  const memberships = input.store.readHotspotMemberships(input.project_id);
  input.deadline?.check("admit.readHotspotMemberships");
  const candidate = retentionScore(candidateStats(memory, input.activity_seq), input.activity_seq);
  if (memberships.some((row) => row.memory_id === input.memory_id)) {
    return { admitted: true, reason: "already_member", replaced: null, retention: candidate };
  }

  if (memberships.length < capacity) {
    input.store.upsertHotspotMembership({
      project_id: input.project_id,
      memory_id: input.memory_id,
      admitted_seq: input.activity_seq,
      last_hit_seq: 0,
      last_access_seq: 0,
      recent_hit_weight: 0,
      recent_access_weight: 0,
    });
    return { admitted: true, reason: "admitted", replaced: null, retention: candidate };
  }

  let weakest: { membership: HotspotMembership; score: number } | null = null;
  for (const membership of memberships) {
    input.deadline?.check("admit.rank");
    const joined = joinMember(
      input.store.readMemory(memoryUri(input.store.storeId, membership.memory_id)),
      membership,
      input.project_id,
    );
    if (joined.kind !== "entry") {
      // A slot whose memory cannot be injected is the weakest possible holder.
      weakest = { membership, score: Number.NEGATIVE_INFINITY };
      break;
    }
    const score = retentionScore(joined.entry, input.activity_seq);
    if (weakest === null || score < weakest.score) {
      weakest = { membership, score };
    }
  }
  input.deadline?.check("admit.compare");
  if (weakest === null || candidate <= weakest.score + REPLACEMENT_MARGIN) {
    return { admitted: false, reason: "capacity", replaced: null, retention: candidate };
  }
  input.store.deleteHotspotMembership(input.project_id, weakest.membership.memory_id);
  input.store.upsertHotspotMembership({
    project_id: input.project_id,
    memory_id: input.memory_id,
    admitted_seq: input.activity_seq,
    last_hit_seq: 0,
    last_access_seq: 0,
    recent_hit_weight: 0,
    recent_access_weight: 0,
  });
  return { admitted: true, reason: "admitted", replaced: weakest.membership.memory_id, retention: candidate };
}

/** The candidate's retention input with `admitted_seq` set to this round. */
function candidateStats(memory: Memory, activitySeq: number): RetentionInput {
  return {
    hit_count: memory.hit_count,
    access_count: memory.access_count,
    recent_hit_weight: 0,
    recent_access_weight: 0,
    admitted_seq: activitySeq,
  };
}

/** Refresh `last_hit_seq` on the memberships a turn actually matched. */
export function markHotspotHits(
  store: HotspotStore,
  projectId: string,
  memoryIds: readonly MemoryId[],
  activitySeq: number,
): number {
  const memberships = store.readHotspotMemberships(projectId);
  const byId = new Map(memberships.map((row) => [row.memory_id, row]));
  let updated = 0;
  for (const memoryId of memoryIds) {
    const row = byId.get(memoryId);
    if (row === undefined) {
      continue;
    }
    store.upsertHotspotMembership({ ...row, last_hit_seq: Math.max(row.last_hit_seq, activitySeq) });
    updated += 1;
  }
  return updated;
}

/** Refresh `last_access_seq` on the membership a long-summary read touched. */
export function markHotspotAccess(
  store: HotspotStore,
  projectId: string,
  memoryId: MemoryId,
  activitySeq: number,
): boolean {
  const row = store.readHotspotMemberships(projectId).find((it) => it.memory_id === memoryId);
  if (row === undefined) {
    return false;
  }
  store.upsertHotspotMembership({ ...row, last_access_seq: Math.max(row.last_access_seq, activitySeq) });
  return true;
}
