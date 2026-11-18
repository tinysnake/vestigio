/**
 * The forced medium summary (PR-07, stage one).
 *
 * One model call turns the evidence a `memory.resolve` walk actually used into
 * the 500-1000 non-whitespace code point body that answers "我们之前讨论了什么，
 * 得出了什么结论？" and, when the evidence supports it, the current question.
 * The body and its sources are then persisted by the resolver; this module only
 * produces and validates text, so a rejected body can never reach the store.
 *
 * The prompt is not the guarantee. `validateMediumBody` re-checks length,
 * citations and action claims, and the resolver saves nothing that fails it.
 */

import type { SourceRef } from "../contracts/index.js";
import type { ModelUsage } from "../resolver/types.js";

/** One piece of gathered evidence as the summary prompt sees it. */
export type MediumEvidence = {
  /**
   * Citation id: the history anchor (`source_ref.message_id`) for raw history,
   * or the memory id when the evidence is another stored memory.
   */
  id: string;
  kind: "history" | "memory";
  provider: string;
  source_instance: string;
  session_id: string;
  timestamp: string;
  /** Bounded excerpt; empty when only the reference metadata survived. */
  text: string;
};

export type MediumEvidenceInput = {
  question: string;
  /** The caller's project path, for the prompt only. */
  project: string | null;
  evidence: readonly MediumEvidence[];
};

export type MediumCall = {
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  elapsed_ms: number;
  outcome: "ok" | "malformed" | "invalid" | "failed" | "cancelled";
};

export type MediumExtractionStatus =
  | "ok"
  /** Honest short answer: cannot reach 500 code points, nothing is saved. */
  | "insufficient_evidence"
  /** The body failed validation for a reason other than being short. */
  | "invalid"
  | "failed"
  | "cancelled";

export type MediumExtraction = {
  status: MediumExtractionStatus;
  /** Present for `ok` and `insufficient_evidence` (the shorter honest body). */
  body: string | null;
  body_char_count: number | null;
  cited_ids: string[];
  reason: string | null;
  usage: ModelUsage;
  call: MediumCall;
};

export type MediumExtractInput = {
  model: import("../resolver/types.js").ModelPort;
  model_id: string | undefined;
  evidence: MediumEvidenceInput;
  /** Ids the body may cite; anything else fails validation. */
  allowed_ids: readonly string[];
  max_output_tokens: number;
  signal: AbortSignal;
  /**
   * Appended to the user message on a retry: what was wrong with the previous
   * reply and what the corrected one must satisfy.
   */
  correction?: string | undefined;
};

/** Evidence ids a saved medium body may cite, derived from the used sources. */
export function evidenceIdForSource(source: SourceRef): string {
  return source.message_id;
}
