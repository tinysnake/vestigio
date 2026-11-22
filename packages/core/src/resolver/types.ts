/**
 * `memory.resolve` types (PR-06).
 *
 * The resolver owns the orchestration and depends only on a narrow chat port
 * (`ModelPort`). The concrete OpenAI-compatible client lives in
 * `@vestigio/model-client`; a different backend is a different implementation of
 * the same port, so `packages/core` stays free of HTTP and provider detail.
 *
 * The port follows the same rule the `HistoryPort` follows: an environment
 * problem is reported as `{ ok: false }` and never thrown. Only the caller's own
 * invalid options throw.
 */

import type {
  MemoryCard,
  MemoryId,
  MemoryUri,
  NavigationStatus,
  PersistenceStatus,
  RetrievalResult,
  Revision,
  Scope,
  SourceRef,
} from "../contracts/index.js";
import type { HistoryExcerpt, HistoryPort, LayerOutcome, LayerName } from "../retrieval/types.js";
import type { PersistenceStage } from "../contracts/index.js";
export type { PersistenceStage };
import type { MemoryStore } from "../storage/store.js";

export type ModelRole = "system" | "user" | "assistant";

export type ModelMessage = {
  role: ModelRole;
  content: string;
};

/** Reasoning budget forwarded as `reasoning_effort` by the client, when set. */
export type ModelThinking = "off" | "low" | "medium" | "high";

export type ModelRequest = {
  /** Overrides the client's configured model when set. */
  model?: string | undefined;
  messages: readonly ModelMessage[];
  /** Hard ceiling on this one response. The resolver also caps the total. */
  max_output_tokens: number;
  /** Ask the backend for a JSON object; the resolver still validates it. */
  expect_json: boolean;
  thinking?: ModelThinking | undefined;
  /** Sent as `user-agent`, so a gateway can attribute the call to an agent. */
  user_agent?: string | undefined;
  signal: AbortSignal;
};

/**
 * Every agent that drives the model names itself here. Without it the gateway
 * sees one client identity and cannot split token usage per agent.
 */
export const AGENT_NAMES = ["resolver", "extraction", "detector", "nav"] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

export const AGENT_USER_AGENT: Record<AgentName, string> = {
  resolver: "vestigio/resolver",
  extraction: "vestigio/extraction",
  detector: "vestigio/detector",
  nav: "vestigio/nav",
};

export type ModelUsage = {
  tokens_in: number;
  tokens_out: number;
  /** `null` when the client has no price table; never invented. */
  cost_usd: number | null;
};

export type ModelResponse = {
  text: string;
  usage: ModelUsage;
  model: string;
  finish_reason: string | null;
};

export type ModelFailureStatus =
  /** The endpoint is unreachable, refused, or the key is unusable. */
  | "unavailable"
  /** The endpoint answered but the call failed. */
  | "failed"
  /** The caller's signal fired, or the deadline did. */
  | "cancelled"
  /** The backend answered with something that cannot be a chat completion. */
  | "invalid_response";

export type ModelFailure = {
  ok: false;
  status: ModelFailureStatus;
  reason: string;
};

export type ModelOk = { ok: true; value: ModelResponse };

export type ModelResult = ModelOk | ModelFailure;

/** One narrow method: one bounded chat request. No streaming, no tools. */
export type ModelPort = {
  complete(request: ModelRequest): Promise<ModelResult>;
};

/** What one model call produced, kept for the report and the tests. */
export type ResolveCallRecord = {
  index: number;
  /** The zero-LLM layer this call was judging. */
  layer: LayerName;
  purpose: "judge_expand" | "medium_summary";
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  elapsed_ms: number;
  outcome: "ok" | "malformed" | "invalid" | "failed" | "cancelled";
};

/**
 * A reusable, bounded candidate set. `continuation` only reuses candidates from
 * the same scope and the same question, and only before it expires; anything
 * else is ignored and gathered again.
 */
export type ResolveContinuation = {
  id: string;
  scope: Scope;
  question: string;
  /** Absolute epoch milliseconds (Date.now). */
  expires_at_ms: number;
  /** The layer the previous call stopped at; reuse resumes there. */
  resume_layer: LayerName;
  cards: MemoryCard[];
  excerpts: HistoryExcerpt[];
  sources: SourceRef[];
};

export type ResolveMeasured = {
  elapsed_ms: number;
  /** Wall time spent in the zero-LLM gathers (store FTS + history port). */
  gather_ms: number;
  /** Wall time spent inside model calls. */
  model_ms: number;
  /** Port-reported time for the history search/read calls, summed. */
  history_read_ms: number;
  /** PR-07: wall time spent generating the forced medium summary. */
  summary_ms: number;
  /** PR-07: wall time spent in the save, job enqueue and delivery accounting. */
  persist_ms: number;
  model_calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  evidence_bytes: number;
  evidence_messages: number;
  candidate_cards: number;
  history_excerpts: number;
  degraded: boolean;
  /** True once a history refresh pushed the request past the warm deadline. */
  cold: boolean;
  reused_continuation: boolean;
  layers: LayerOutcome[];
};

/** The body and the saved revision; present only when `status` is `saved`. */
export type PersistenceTarget = {
  memory_id: MemoryId;
  memory_uri: MemoryUri;
  revision: Revision;
};

/**
 * PR-07's account of the medium-summary write. Separate from
 * `RetrievalResult` because it also carries the checkpoint stage and the call's
 * cost, which no retrieval consumer should have to parse out of prose.
 */
export type PersistenceOutcome = {
  status: PersistenceStatus;
  stage: PersistenceStage;
  target: PersistenceTarget | null;
  /** Stable across retries of one logical request. */
  dedup_key: string | null;
  /** True when the same evidence version was found and reused, no model call. */
  reused: boolean;
  navigation_status: NavigationStatus;
  summary_ms: number;
  persist_ms: number;
  /** Exactly one access is recorded for the first delivery of a revision. */
  delivery_recorded: boolean;
  missing: string[];
  call: ResolveCallRecord | null;
};

/**
 * The self-contained request a deferred resolve hands to the write side when
 * `ResolveInput.defer_persistence` is set. It carries everything persistence
 * needs and nothing that cannot survive a process boundary: no budget ledger,
 * no deadline clock, no store handle. A caller that serializes it (a daemon
 * maintenance job, a durable queue row) can run it later, after the read job
 * has already returned its answer.
 */
export type PendingResolvePersistence = {
  question: string;
  scope: Scope;
  answer: string;
  evidence: SourceRef[];
  excerpts: HistoryExcerpt[];
  cards: MemoryCard[];
  request_id?: string | undefined;
  session_id?: string | undefined;
  /** Index the deferred summary call gets in `ResolveOutcome.calls`. */
  call_index: number;
};

export type ResolveOutcome = {
  result: RetrievalResult;
  layers: LayerOutcome[];
  history: HistoryExcerpt[];
  calls: ResolveCallRecord[];
  /** PR-07 medium-summary write, or `null` when the walk never reached it. */
  persistence: PersistenceOutcome | null;
  /**
   * The write the walk deferred instead of running itself, or `null`. Non-null
   * only when `defer_persistence` was set and the walk actually reached the
   * persistence point; the read result is then unchanged except that nothing
   * was saved.
   */
  pending_persistence: PendingResolvePersistence | null;
  /** Candidates a later call may reuse, or `null` when there is nothing to reuse. */
  continuation: ResolveContinuation | null;
  measured: ResolveMeasured;
};

export type ResolveInput = {
  store: MemoryStore;
  question: string;
  scope: Scope;
  /**
   * Omitted (or `null`) degrades to the zero-LLM layered search with a stated
   * reason. That is the session-cap and unconfigured-model behaviour.
   */
  model?: ModelPort | null | undefined;
  history?: HistoryPort | null | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Caller-tracked number of prior `memory.resolve` calls in this Session. The
   * resolver never keeps session state itself.
   */
  session_resolves_used?: number | undefined;
  /**
   * When true, the walk stops short of writing and returns the write as
   * `pending_persistence` instead. Used when the caller must serialize all
   * shared writes behind a single maintenance boundary but still wants the
   * read result (cards, answer, evidence) from the same walk.
   */
  defer_persistence?: boolean | undefined;
  continuation?: ResolveContinuation | null | undefined;
  unbounded_time?: boolean | undefined;
  /** Absolute-time source for continuation expiry. Default `Date.now`. */
  wall_now?: (() => number) | undefined;
  /** Monotonic-time source for the deadline. Default `performance.now`. */
  mono_now?: (() => number) | undefined;
  /** Bounded structural overrides (tests and measured tuning). */
  budget?: Partial<ResolveBudgetOptions> | undefined;
  /** Recorded on every call; informational. */
  model_id?: string | undefined;
  /**
   * Session identity recorded on the delivery access event. Defaults to
   * `resolve:<hash>` so a caller without a Session still produces one row.
   */
  session_id?: string | undefined;
  /**
   * Opaque id for this logical retrieval. The delivery dedup key is derived
   * from it, so a retry of the same request records one access, not two.
   * Defaults to a hash of scope and question (the same identity the
   * continuation uses).
   */
  request_id?: string | undefined;
};

export type { HistoryExcerpt, HistoryPort, LayerOutcome, LayerName, MemoryCard, MemoryUri, MemoryStore, RetrievalResult, Scope, SourceRef };

// Kept here so `budget.ts` can import the option shape without a cycle.
export type ResolveBudgetOptions = {
  warm_deadline_ms: number;
  cold_deadline_ms: number;
  max_model_calls: number;
  max_output_tokens_per_call: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_evidence_bytes: number;
  max_evidence_messages: number;
  max_session_resolves: number;
  max_candidate_cards: number;
  max_query_variants: number;
  /** Windows the history layer may read across one resolve, all variants included. */
  max_history_reads: number;
  continuation_ttl_ms: number;
};
