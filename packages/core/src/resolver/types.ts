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
  MemoryUri,
  RetrievalResult,
  Scope,
  SourceRef,
} from "../contracts/index.js";
import type { HistoryExcerpt, HistoryPort, LayerOutcome, LayerName } from "../retrieval/types.js";
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
  signal: AbortSignal;
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
  purpose: "judge_expand";
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  elapsed_ms: number;
  outcome: "ok" | "malformed" | "failed" | "cancelled";
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

export type ResolveOutcome = {
  result: RetrievalResult;
  layers: LayerOutcome[];
  history: HistoryExcerpt[];
  calls: ResolveCallRecord[];
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
  continuation?: ResolveContinuation | null | undefined;
  /** Absolute-time source for continuation expiry. Default `Date.now`. */
  wall_now?: (() => number) | undefined;
  /** Monotonic-time source for the deadline. Default `performance.now`. */
  mono_now?: (() => number) | undefined;
  /** Bounded structural overrides (tests and measured tuning). */
  budget?: Partial<ResolveBudgetOptions> | undefined;
  /** Recorded on every call; informational. */
  model_id?: string | undefined;
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
  continuation_ttl_ms: number;
};
