/**
 * The frozen PR-06 budget, as constants plus a ledger that tracks spend.
 *
 * The numbers are structural: PR-06 may tune the values after measuring, but the
 * shape (a warm deadline with a cold allowance, a model-call ceiling, per-call
 * and accumulated token ceilings, an evidence ceiling, a per-Session ceiling)
 * does not open up. Over-budget stops the work and says why; it never silently
 * continues.
 */

import { retrievalError } from "../retrieval/errors.js";
import type { HistoryReadBudget } from "../retrieval/types.js";
import type { ResolveBudgetOptions } from "./types.js";

/** Warm path: candidates, judgment, composition and (PR-07) writes. */
export const RESOLVE_WARM_DEADLINE_MS = 30_000;
/** Cold path: Obelisk had to refresh an incremental index. */
export const RESOLVE_COLD_DEADLINE_MS = 120_000;
/** A history search this slow is a refresh, not a warm lookup. */
export const RESOLVE_COLD_REFRESH_THRESHOLD_MS = 5_000;
export const RESOLVE_MAX_MODEL_CALLS = 3;
/**
 * PR-07 reserves one call for the forced medium summary, outside the judgment
 * ceiling above. The judgment walk can still spend its three calls (including
 * one correction/retry) and the summary stage is never starved by it; the
 * summary call is refused when the request deadline or the token ceilings are
 * already gone, and that refusal is reported as `budget_exhausted`.
 */
export const RESOLVE_SUMMARY_MODEL_CALLS = 1;
/**
 * Output ceiling for the summary call; the body itself is capped at 1000.
 *
 * Measured on the configured gateway (`auto/deepseek-v4.1-flash`): the route
 * spends ~1900 output tokens on internal reasoning before it emits any body, so
 * a 1200/2500 total ceiling turned the mandatory 500-character body into a
 * truncated JSON object and then a 502 ("whole output spent on reasoning"). The
 * structure stays bounded; the numbers are what this backend needs.
 */
export const RESOLVE_SUMMARY_MAX_OUTPUT_TOKENS = 4000;
/** Stage-2 navigation call: a short JSON object, never a full summary. */
export const RESOLVE_NAV_MAX_OUTPUT_TOKENS = 400;
/**
 * Output ceiling for one judge call. The judge is asked to keep its answer to
 * 300 characters; this ceiling leaves room for the ~1900 output tokens this
 * backend spends on internal reasoning before it emits any body.
 *
 * Measured on the configured gateway (`auto/deepseek-v4.1-flash`) with the real
 * judge prompt: at 1200, 7 of 82 replies were cut mid-JSON, and every cut reply
 * had spent its whole ceiling (tokens_out == 1200). With the brevity rule the
 * observed use was 389 tokens at p50 and 1294 at the maximum over 40 samples
 * (ceilings 1800 and 2400), with no cut. The structure stays bounded; the
 * numbers are what this backend needs.
 */
export const RESOLVE_MAX_OUTPUT_TOKENS_PER_CALL = 2000;
export const RESOLVE_MAX_INPUT_TOKENS = 20_000;
/**
 * Total output ceiling for one resolve, sized so every stage can reach its own
 * ceiling instead of one stage eating another's: the three judge calls at 2000,
 * the one extra call an unreadable reply may retry into, plus the 4000-token
 * summary. Measured use is far below it (p50 ~500 per call).
 */
export const RESOLVE_MAX_OUTPUT_TOKENS = 12_000;
export const RESOLVE_MAX_EVIDENCE_BYTES = 24 * 1024;
export const RESOLVE_MAX_EVIDENCE_MESSAGES = 6;
export const RESOLVE_MAX_SESSION_RESOLVES = 40;
export const RESOLVE_MAX_CANDIDATE_CARDS = 10;
/** Query variants the model may expand into for the next layer's lexical search. */
export const RESOLVE_MAX_QUERY_VARIANTS = 3;
/**
 * History reads are the only stage whose cost is decided by an external process,
 * and one measured window took 16 s against a 30 s warm deadline. A read may
 * not spend the time the judgment and summary still need.
 */
export const RESOLVE_HISTORY_READ_RESERVE_MS = 8_000;
/**
 * Ceiling for one read. The Obelisk CLI kills its own script at 30 s, so a read
 * that needs longer is already failing rather than slow.
 */
export const RESOLVE_HISTORY_READ_TIMEOUT_MS = 20_000;
/**
 * Windows one resolve may read, shared by all of its query variants: the
 * parents chain and the reply timeline of the one anchor worth reading.
 */
export const RESOLVE_MAX_HISTORY_READS = 2;
/** How long a returned continuation stays reusable. */
export const RESOLVE_CONTINUATION_TTL_MS = 5 * 60_000;
/** Same estimator PR-01/PR-04 use, so the token numbers compare. */
export const RESOLVE_TOKEN_ESTIMATE_BYTES_PER_TOKEN = 4;

export const DEFAULT_RESOLVE_BUDGET: ResolveBudgetOptions = {
  warm_deadline_ms: RESOLVE_WARM_DEADLINE_MS,
  cold_deadline_ms: RESOLVE_COLD_DEADLINE_MS,
  max_model_calls: RESOLVE_MAX_MODEL_CALLS,
  max_output_tokens_per_call: RESOLVE_MAX_OUTPUT_TOKENS_PER_CALL,
  max_input_tokens: RESOLVE_MAX_INPUT_TOKENS,
  max_output_tokens: RESOLVE_MAX_OUTPUT_TOKENS,
  max_evidence_bytes: RESOLVE_MAX_EVIDENCE_BYTES,
  max_evidence_messages: RESOLVE_MAX_EVIDENCE_MESSAGES,
  max_session_resolves: RESOLVE_MAX_SESSION_RESOLVES,
  max_candidate_cards: RESOLVE_MAX_CANDIDATE_CARDS,
  max_query_variants: RESOLVE_MAX_QUERY_VARIANTS,
  max_history_reads: RESOLVE_MAX_HISTORY_READS,
  continuation_ttl_ms: RESOLVE_CONTINUATION_TTL_MS,
};

const CAPS: Record<keyof ResolveBudgetOptions, readonly [number, number]> = {
  warm_deadline_ms: [1, 10 * 60_000],
  cold_deadline_ms: [1, 10 * 60_000],
  max_model_calls: [0, 10],
  max_output_tokens_per_call: [1, 100_000],
  max_input_tokens: [1, 10_000_000],
  max_output_tokens: [1, 10_000_000],
  max_evidence_bytes: [64, 10 * 1024 * 1024],
  max_evidence_messages: [0, 1000],
  max_session_resolves: [0, 100_000],
  max_candidate_cards: [1, 100],
  max_query_variants: [0, 10],
  max_history_reads: [0, 10],
  continuation_ttl_ms: [0, 24 * 60 * 60_000],
};

export function readResolveBudget(overrides: Partial<ResolveBudgetOptions> = {}): ResolveBudgetOptions {
  const merged = { ...DEFAULT_RESOLVE_BUDGET, ...overrides };
  for (const key of Object.keys(CAPS) as (keyof ResolveBudgetOptions)[]) {
    const value = merged[key];
    const [min, max] = CAPS[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw retrievalError(
        "limit_out_of_range",
        `budget.${key} must be an integer from ${min} to ${max}; got ${JSON.stringify(value)}`,
      );
    }
  }
  if (merged.cold_deadline_ms < merged.warm_deadline_ms) {
    throw retrievalError(
      "limit_out_of_range",
      `budget.cold_deadline_ms (${merged.cold_deadline_ms}) must be >= budget.warm_deadline_ms (${merged.warm_deadline_ms})`,
    );
  }
  return merged;
}

/** Why the ledger refused to continue, or `null` when it is not out of budget. */
export type LedgerStop =
  | "model_call_cap"
  | "input_token_cap"
  | "output_token_cap"
  | null;

/**
 * Running totals for one resolve. Evidence is tracked as both bytes and message
 * count; "first to arrive wins" means the first entry that would cross a cap is
 * dropped and the cap is reported.
 */
export class ResolveBudgetLedger {
  readonly options: ResolveBudgetOptions;
  model_calls = 0;
  tokens_in = 0;
  tokens_out = 0;
  cost_usd: number | null = null;
  evidence_bytes = 0;
  evidence_messages = 0;
  evidence_capped = false;

  /**
   * Judgement calls allowed before the reserved summary call. The ledger counts
   * every call in `model_calls`; this ceiling keeps the summary slot free.
   */
  judgment_calls = 0;

  constructor(options: ResolveBudgetOptions) {
    this.options = options;
  }

  /** The per-call output ceiling: the smaller of the per-call and remaining total. */
  nextOutputCap(): number {
    return Math.max(1, Math.min(this.options.max_output_tokens_per_call, this.options.max_output_tokens - this.tokens_out));
  }

  /** The summary call's own output ceiling, still bounded by the remaining total. */
  nextSummaryOutputCap(): number {
    return Math.max(
      1,
      Math.min(RESOLVE_SUMMARY_MAX_OUTPUT_TOKENS, this.options.max_output_tokens - this.tokens_out),
    );
  }

  /** Whether one more judgment call fits the call, input and output ceilings. */
  canCallModel(estimated_input_tokens = 0): boolean {
    if (this.judgment_calls >= this.options.max_model_calls) return false;
    if (this.model_calls >= this.options.max_model_calls + RESOLVE_SUMMARY_MODEL_CALLS) return false;
    if (this.tokens_out >= this.options.max_output_tokens) return false;
    if (this.tokens_in + estimated_input_tokens > this.options.max_input_tokens) return false;
    return true;
  }

  stopReason(estimated_input_tokens = 0): LedgerStop {
    if (this.judgment_calls >= this.options.max_model_calls) return "model_call_cap";
    if (this.tokens_out >= this.options.max_output_tokens) return "output_token_cap";
    if (this.tokens_in + estimated_input_tokens > this.options.max_input_tokens) return "input_token_cap";
    return null;
  }

  /**
   * Whether the reserved medium-summary call fits. It may use the one slot past
   * the judgment ceiling, and the same input/output token ceilings.
   */
  canCallSummaryModel(estimated_input_tokens = 0): boolean {
    if (this.model_calls >= this.options.max_model_calls + RESOLVE_SUMMARY_MODEL_CALLS) return false;
    if (this.tokens_out >= this.options.max_output_tokens) return false;
    if (this.tokens_in + estimated_input_tokens > this.options.max_input_tokens) return false;
    return true;
  }

  /** Why the summary call cannot run, or `null` when it fits. */
  summaryStopReason(estimated_input_tokens = 0): LedgerStop {
    if (this.model_calls >= this.options.max_model_calls + RESOLVE_SUMMARY_MODEL_CALLS) return "model_call_cap";
    if (this.tokens_out >= this.options.max_output_tokens) return "output_token_cap";
    if (this.tokens_in + estimated_input_tokens > this.options.max_input_tokens) return "input_token_cap";
    return null;
  }

  recordModelCall(
    usage: { tokens_in: number; tokens_out: number; cost_usd: number | null },
    role: "judgment" | "summary" = "judgment",
  ): void {
    this.model_calls += 1;
    if (role === "judgment") this.judgment_calls += 1;
    this.tokens_in += Math.max(0, usage.tokens_in);
    this.tokens_out += Math.max(0, usage.tokens_out);
    if (usage.cost_usd !== null) {
      this.cost_usd = (this.cost_usd ?? 0) + usage.cost_usd;
    }
  }

  /**
   * Reserve `bytes`/one message of evidence. Returns false and sets
   * `evidence_capped` when either ceiling would be crossed, so the caller stops
   * adding evidence instead of blowing the budget.
   */
  addEvidence(bytes: number, messages = 1): boolean {
    if (this.evidence_capped) return false;
    const messageLimit = this.options.max_evidence_messages;
    const byteLimit = this.options.max_evidence_bytes;
    if (this.evidence_messages + messages > messageLimit || this.evidence_bytes + bytes > byteLimit) {
      this.evidence_capped = true;
      return false;
    }
    this.evidence_bytes += bytes;
    this.evidence_messages += messages;
    return true;
  }
}

/**
 * Builds the read allowance a resolve hands to the history layer. Refusals are
 * cheap and explicit: `reads` when the allowance is gone, `deadline` when the
 * time left is under the reserve the judgment still needs.
 */
export function createHistoryReadBudget(input: {
  remaining_ms: () => number;
  max_reads: number;
  reserve_ms?: number | undefined;
  timeout_cap_ms?: number | undefined;
}): HistoryReadBudget {
  let reads = input.max_reads;
  const reserve = input.reserve_ms ?? RESOLVE_HISTORY_READ_RESERVE_MS;
  const cap = input.timeout_cap_ms ?? RESOLVE_HISTORY_READ_TIMEOUT_MS;
  return {
    take() {
      if (reads <= 0) return { ok: false, reason: "reads" };
      const timeout = Math.min(cap, Math.floor(input.remaining_ms() - reserve));
      if (timeout < 1) return { ok: false, reason: "deadline" };
      reads -= 1;
      return { ok: true, timeout_ms: timeout };
    },
  };
}
