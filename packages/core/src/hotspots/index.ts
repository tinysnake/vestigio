/**
 * Hotspot layer (PR-05): a per-project pool of published memories, a purely
 * local lexical matcher over their short summaries, and the bounded block that
 * gets appended to the end of the current user input.
 *
 * No pi dependency and no model call. The host (today `packages/pi-extension`)
 * owns the `input` event, the dedup persistence and the read tool.
 */

export { Deadline, HotspotTimeoutError } from "./deadline.js";
export {
  DEFAULT_MAX_HOTSPOT_MEMORIES,
  DEFAULT_MIN_MATCH_SCORE,
  PHRASE_BONUS,
  matchHotspots,
  matchTokens,
} from "./match.js";
export type { MatchInput } from "./match.js";
export {
  ADMISSION_RECENCY_BIAS,
  DEFAULT_HOTSPOT_POOL_CAPACITY,
  REPLACEMENT_MARGIN,
  RETENTION_ACCESS_WEIGHT,
  RETENTION_HIT_WEIGHT,
  retentionScore,
} from "./policy.js";
export type { RetentionInput } from "./policy.js";
export {
  admitHotspotCandidate,
  evaluatePool,
  markHotspotAccess,
  markHotspotHits,
  recordProjectInput,
} from "./pool.js";
export type {
  AdmissionReason,
  AdmissionResult,
  AdmitCandidateInput,
  EvaluatePoolInput,
} from "./pool.js";
export {
  DEFAULT_INJECTION_BUDGET_BYTES,
  INJECTION_BLOCK_CLOSE,
  INJECTION_BLOCK_HEADER,
  INJECTION_BLOCK_OPEN,
  MAX_INJECTED_NAV_CHARS,
  MEMORY_READ_TOOL,
  clampSummary,
  renderInjectionBlock,
} from "./render.js";
export type { RenderInput, RenderedBlock } from "./render.js";
export {
  DEFAULT_HOTSPOT_TIMEOUT_MS,
  commitInjection,
  planInjection,
  recordMemoryRead,
  recordSearchHits,
} from "./inject.js";
export type {
  CommitInjectionInput,
  PlanInjectionInput,
  RecordMemoryReadInput,
  RecordSearchHitsInput,
} from "./inject.js";
export { InjectionLedger } from "./ledger.js";
export type {
  CommitResult,
  HotspotEntry,
  HotspotMatch,
  HotspotPool,
  HotspotStore,
  InjectionBudget,
  InjectionLedgerDelta,
  InjectionPlan,
  InjectionReason,
  PoolSkip,
  PoolSkipReason,
} from "./types.js";
