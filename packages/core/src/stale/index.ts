/**
 * `@vestigio/core/stale` — the bounded model check that decides whether a
 * memory delivered this session has not absorbed later activity.
 *
 * The detector is a pure contract: it receives the candidate memories (with
 * their current freshness and pending events), the bounded evidence gathered
 * from the completed turn, and one model port. It makes exactly one bounded
 * call, validates the structured answer against the supplied candidate and
 * evidence ids, and returns findings. It never writes storage and never starts
 * an agent turn — the caller owns identity capture, storage writes and the
 * "do not write into a switched session" guard.
 */

export {
  DETECTOR_MAX_CANDIDATES,
  DETECTOR_MAX_EVIDENCE,
  DETECTOR_MAX_OUTPUT_TOKENS,
  STALE_DETECTOR_SYSTEM_PROMPT,
  buildDetectorUserMessage,
  parseDetectorDecision,
  detectStale,
} from "./detector.js";
export type {
  DetectorCall,
  DetectorDecisionParse,
  DetectorEvidence,
  DetectorFinding,
  DetectorResult,
  DetectorStatus,
  StaleCandidate,
  StaleDetectorInput,
} from "./detector.js";
