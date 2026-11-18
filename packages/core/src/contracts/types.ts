/**
 * Vestigio core contracts (PR-01).
 *
 * These types are the frozen boundary shapes. Everything that crosses into the
 * system (CLI, pi extension callbacks, Obelisk output, stored JSON) is parsed by
 * the matching `parse*` function in `./parse.ts` before it is trusted.
 *
 * Invariants enforced by the parsers, not expressible in the type:
 * - medium body: 500-1000 non-whitespace Unicode code points, count must match
 * - nav text: 1-200 Unicode code points, count must match
 * - nav.source_revision must equal the owning memory revision
 * - a medium_ready memory has no nav yet; a published one always has it
 * - parent_message_id is a causal parent, never a time neighbour
 * - UsageEvent.event_id is derived from the event's own fields
 */

export type StoreId = string;
export type MemoryId = string;
export type MemoryUri = `memory://${StoreId}/${MemoryId}`;
export type Revision = number;

export type Scope = { kind: "project"; project_id: string } | { kind: "global" };

export type SourceRef = {
  provider: string;
  source_instance: string;
  session_id: string;
  message_id: string;
  parent_message_id: string | null;
  project_id: string;
  timestamp: string;
  content_hash: string;
  locator: string | null;
};

export type MediumSummary = {
  body: string;
  body_char_count: number;
  sources: SourceRef[];
};

export type NavSummary = {
  text: string;
  char_count: number;
  source_revision: Revision;
};

export type MemoryState = "medium_ready" | "published" | "archived";

export type Memory = {
  memory_id: MemoryId;
  uri: MemoryUri;
  scope: Scope;
  title: string;
  keywords: string[];
  revision: Revision;
  state: MemoryState;
  medium: MediumSummary;
  nav: NavSummary | null;
  hit_count: number;
  access_count: number;
  last_access_at: string | null;
  created_at: string;
  updated_at: string;
};

export type UsageEventKind = "hit" | "access";
export type UsageChannel = "hotspot" | "search" | "read";

export type UsageEvent = {
  event_id: string;
  memory_id: MemoryId;
  revision: Revision;
  kind: UsageEventKind;
  channel: UsageChannel;
  session_id: string;
  input_id: string;
  at: string;
  dedup_key: string;
};

export type InjectionReceipt = {
  store_id: StoreId;
  session_id: string;
  branch_ref: string;
  input_id: string;
  memory_id: MemoryId;
  revision: Revision;
  committed_at: string;
};

export type ProjectActivity = {
  project_id: string;
  activity_seq: number;
  last_input_at: string;
};

export type HotspotMembership = {
  project_id: string;
  memory_id: MemoryId;
  admitted_seq: number;
  last_hit_seq: number;
  last_access_seq: number;
  recent_hit_weight: number;
  recent_access_weight: number;
};

export type RetrievalStatus = "resolved" | "partial" | "conflicted" | "not_found";
/**
 * `insufficient_evidence` and `budget_exhausted` are PR-07 additions: the
 * retrieval succeeded but no medium summary was written, and the reason is a
 * property of the retrieval, not a save failure. `saved` still means the row is
 * readable at `memory_uri`/`revision` right now.
 */
export type PersistenceStatus =
  | "saved"
  | "failed"
  | "not_attempted"
  | "insufficient_evidence"
  | "budget_exhausted";
export type NavigationStatus = "pending" | "ready" | "failed";

/** A phase of the PR-07 resolve pipeline, checkpointed once a revision is saved. */
export type PersistenceStage = "searched" | "summarized" | "saved" | "returned";

/** Compact stale state carried on every search card and hotspot entry. */
export type FreshnessBrief = {
  is_stale: boolean;
  head_revision: Revision;
  /** Pending (unacknowledged) stale events for this memory. */
  pending_count: number;
  /** Fingerprint of the head revision and sorted pending event ids. */
  freshness_sig: string;
};

/** Full freshness state returned with a read or a resolver result. */
export type Freshness = FreshnessBrief & {
  memory_id: MemoryId;
  /** The revision the caller asked for or was given. */
  delivered_revision: Revision;
  /** True when `delivered_revision` is older than the current head. */
  revision_mismatch: boolean;
  pending: StaleEventSummary[];
  /** Total pending events, which may exceed `pending.length`. */
  pending_count: number;
  pending_truncated: boolean;
};

export type StaleProducer = "agent" | "detector";

export type StaleEventSummary = {
  event_id: string;
  memory_id: MemoryId;
  observed_revision: Revision;
  reason: string;
  excerpt: string;
  excerpt_truncated: boolean;
  excerpt_char_count: number;
  sources: SourceRef[];
  source_count: number;
  sources_truncated: boolean;
  branch_ref: string | null;
  producer: StaleProducer;
  created_at: string;
};

export type MemoryCard = {
  memory_id: MemoryId;
  uri: MemoryUri;
  scope: Scope;
  title: string;
  nav_text: string;
  revision: Revision;
  state: MemoryState;
  score: number;
  hit_count: number;
  access_count: number;
  last_access_at: string | null;
  /** Always present on cards built by the delivery paths. */
  freshness?: FreshnessBrief;
};

export type BudgetUsed = {
  elapsed_ms: number;
  model_calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
};

export type RetrievalResult = {
  status: RetrievalStatus;
  cards: MemoryCard[];
  answer: string | null;
  memory_summary: string | null;
  memory_uri: MemoryUri | null;
  revision: Revision | null;
  persistence_status: PersistenceStatus;
  navigation_status: NavigationStatus;
  evidence: SourceRef[];
  missing: string[];
  conflicts: string[];
  next_action: string | null;
  continuation_id: string | null;
  budget_used: BudgetUsed;
  /** Present on every delivered result; reports pending stale evidence. */
  freshness?: Freshness;
};
