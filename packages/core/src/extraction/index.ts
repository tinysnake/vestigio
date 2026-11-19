/**
 * `@vestigio/core/extraction` — the forced medium summary (PR-07, stage one).
 *
 * Produces and validates one 500-660 non-whitespace code point body (accepted up
 * to 2000 when a rewrite overruns) from the evidence a resolve walk used. It
 * never writes: the resolver decides whether a validated body becomes a memory
 * revision.
 */

export { extractMediumSummary } from "./medium.js";
export {
  MEDIUM_SUMMARY_SYSTEM_PROMPT,
  buildMediumUserMessage,
  describeMediumFailure,
  validateMediumBody,
} from "./prompt.js";
export type { MediumBodyFailure, MediumBodyValidation } from "./prompt.js";
export { evidenceIdForSource } from "./types.js";
export type {
  MediumCall,
  MediumEvidence,
  MediumEvidenceInput,
  MediumExtractInput,
  MediumExtraction,
  MediumExtractionStatus,
  MediumFailure,
} from "./types.js";
