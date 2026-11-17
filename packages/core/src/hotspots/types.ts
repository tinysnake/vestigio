/**
 * Hotspot layer types (PR-05).
 *
 * The hotspot layer is the prompt-facing half of the memory system: a small,
 * per-project pool of published memories whose short navigation summaries are
 * matched lexically against the text a user just typed. A match appends a
 * bounded reference block to the end of that same user input. Matching is
 * purely local and lexical; it never calls a model and never writes a summary.
 *
 * Nothing here imports pi. The pi surface lives in `packages/pi-extension`,
 * which is the only place that knows about the `input` event.
 */

import type {
  HotspotMembership,
  InjectionReceipt,
  Memory,
  MemoryId,
  MemoryState,
  MemoryUri,
  NavSummary,
  ProjectActivity,
  Revision,
  Scope,
  UsageEvent,
} from "../contracts/index.js";

/**
 * The narrow slice of `MemoryStore` the hotspot layer uses. Declared
 * structurally so tests can pass a fake store and drive the timeout path.
 *
 * `MemoryStore` satisfies it as-is; a caller must not write SQL of its own.
 */
export type HotspotStore = {
  readonly storeId: string;
  readProjectActivity(projectId: string): ProjectActivity | null;
  readHotspotMemberships(projectId: string): HotspotMembership[];
  readMemory(uri: MemoryUri, revision?: Revision): Memory | null;
  recordUsageEvent(event: UsageEvent): boolean;
  recordInjectionReceipt(receipt: InjectionReceipt): void;
  upsertProjectActivity(activity: ProjectActivity): ProjectActivity;
  upsertHotspotMembership(membership: HotspotMembership): void;
  deleteHotspotMembership(projectId: string, memoryId: MemoryId): void;
};

/** Why a pool membership is not usable for matching right now. */
export type PoolSkipReason =
  | "memory_missing"
  | "scope_mismatch"
  | "state_archived"
  | "state_not_published"
  | "nav_not_ready";

export type PoolSkip = {
  memory_id: MemoryId;
  reason: PoolSkipReason;
};

/**
 * A pool member joined with the head of its memory. `nav_text` is the exact
 * text the matcher and the rendered block use; it is never longer than
 * `NAV_TEXT_MAX` code points.
 */
export type HotspotEntry = {
  memory_id: MemoryId;
  uri: MemoryUri;
  title: string;
  keywords: readonly string[];
  nav: NavSummary;
  nav_text: string;
  revision: Revision;
  state: MemoryState;
  scope: Scope;
  /** Compact `provider/source_instance` of the first source, for the block. */
  source_label: string | null;
  source_count: number;
  /** Lifetime statistics read from the memory head. */
  hit_count: number;
  access_count: number;
  last_access_at: string | null;
  /** Pool statistics read from the membership row. */
  admitted_seq: number;
  last_hit_seq: number;
  last_access_seq: number;
  recent_hit_weight: number;
  recent_access_weight: number;
};

export type HotspotPool = {
  project_id: string;
  activity_seq: number;
  capacity: number;
  entries: HotspotEntry[];
  skipped: PoolSkip[];
};

export type HotspotMatch = {
  memory_id: MemoryId;
  uri: MemoryUri;
  title: string;
  nav_text: string;
  revision: Revision;
  keywords: readonly string[];
  source_label: string | null;
  source_count: number;
  /** Token matches plus the phrase bonus, so higher is a stronger signal. */
  score: number;
  /** 0..1; the share of the entry's own tokens that matched. */
  specificity: number;
  matched_tokens: string[];
  phrase_matched: boolean;
  retention_score: number;
};

/**
 * Why the current user input got no appended block. Every value is recorded;
 * only `null` means an injection was delivered. `extension_source` also guards
 * against feeding our own message back into the matcher.
 */
export type InjectionReason =
  | "extension_source"
  | "empty_input"
  | "slash_command"
  | "store_unavailable"
  | "no_pool_members"
  | "no_match"
  | "all_deduped"
  | "over_budget"
  | "timeout"
  | "store_error";

export type InjectionBudget = {
  limit_bytes: number;
  used_bytes: number;
  estimated_tokens: number;
};

export type InjectionPlan = {
  status: "injected" | "not_injected";
  reason: InjectionReason | null;
  /** The user input exactly as received. */
  original_text: string;
  /** The text to submit: `original_text` when nothing was injected. */
  text: string;
  block: string | null;
  /** Every memory that matched, deduped or not; used for hit statistics. */
  matched: HotspotMatch[];
  /** The subset that fit the budget and the Session dedup; used for receipts. */
  injected: HotspotMatch[];
  budget: InjectionBudget;
  elapsed_ms: number;
  timeout_ms: number;
  session_id: string;
  branch_ref: string;
  input_id: string;
  project_id: string;
};

export type CommitResult = {
  hit_events: number;
  duplicate_hit_events: number;
  receipts: number;
  /**
   * Memories whose delivery receipt landed. The ledger advances only when this
   * is every injected memory: a partly receipted delivery must not be recorded
   * as delivered, or the same memory could be injected again next turn.
   */
  delivered: MemoryId[];
  membership_hits: number;
  ledger_added: MemoryId[];
  /** The batch to persist for Session dedup, or null when nothing was new. */
  delta: InjectionLedgerDelta | null;
  errors: string[];
};

/** One delivered-injection batch, the unit of Session dedup persistence. */
export type InjectionLedgerDelta = {
  /** ISO timestamp of the delivery. */
  at: string;
  input_id: string;
  memory_ids: MemoryId[];
};

export type { HotspotMembership, Memory, MemoryId, MemoryUri, ProjectActivity, Revision, Scope };
