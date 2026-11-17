/**
 * `@vestigio/core/resolver` — the PR-06 model-backed layered retrieval executor.
 *
 * The model port (`ModelPort`) is defined here and implemented out of tree in
 * `@vestigio/model-client`; core depends on the port, never on HTTP.
 */

export { resolveMemory } from "./resolver.js";
export { JUDGE_SYSTEM_PROMPT, buildJudgeUserMessage, judgeAllowList, parseJudgeDecision } from "./judge.js";
export type { JudgeAllowList, JudgeCandidateInput, JudgeDecision, JudgeParse } from "./judge.js";
export {
  DEFAULT_RESOLVE_BUDGET,
  RESOLVE_COLD_DEADLINE_MS,
  RESOLVE_COLD_REFRESH_THRESHOLD_MS,
  RESOLVE_CONTINUATION_TTL_MS,
  RESOLVE_MAX_CANDIDATE_CARDS,
  RESOLVE_MAX_EVIDENCE_BYTES,
  RESOLVE_MAX_EVIDENCE_MESSAGES,
  RESOLVE_MAX_INPUT_TOKENS,
  RESOLVE_MAX_MODEL_CALLS,
  RESOLVE_MAX_OUTPUT_TOKENS,
  RESOLVE_MAX_OUTPUT_TOKENS_PER_CALL,
  RESOLVE_MAX_QUERY_VARIANTS,
  RESOLVE_MAX_SESSION_RESOLVES,
  RESOLVE_TOKEN_ESTIMATE_BYTES_PER_TOKEN,
  RESOLVE_WARM_DEADLINE_MS,
  ResolveBudgetLedger,
  readResolveBudget,
} from "./budget.js";
export type { LedgerStop } from "./budget.js";
export type {
  ModelFailure,
  ModelFailureStatus,
  ModelMessage,
  ModelOk,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelResult,
  ModelRole,
  ModelThinking,
  ModelUsage,
  ResolveBudgetOptions,
  ResolveCallRecord,
  ResolveContinuation,
  ResolveInput,
  ResolveMeasured,
  ResolveOutcome,
} from "./types.js";
