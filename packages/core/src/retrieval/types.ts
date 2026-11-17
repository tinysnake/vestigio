/**
 * Layered base retrieval types (PR-04).
 *
 * `packages/core` never imports `@vestigio/source-obelisk`. The history layer is
 * reached through this narrow port and the concrete adapter is injected by the
 * caller (the CLI today). A port implementation must report environment
 * problems as `{ ok: false }` and must not throw, so a missing or broken history
 * source degrades the result to an explicit "unavailable" layer instead of
 * failing the search.
 *
 * `probe()` answers "is this source there", `search()` takes one bounded query
 * and `readByAnchor()` takes one bounded causal-chain window. There is no
 * unbounded method on the port on purpose.
 */

import type { MemoryUri, RetrievalResult, Scope, SourceRef } from "../contracts/index.js";

export type HistoryAvailability = {
  available: boolean;
  /** `null` when available; a short machine-readable reason otherwise. */
  reason: string | null;
};

export type HistoryHit = {
  source_ref: SourceRef;
  /** The stored message text. The core layer truncates it; the port does not. */
  text: string;
  timestamp: string;
  role: string | null;
  /** True when the source resolved the causal parent and the source file. */
  evidence_complete: boolean;
  /**
   * True when `source_ref.project_id` is the exact project path that was asked
   * for. False means the only identity the source could give was a derived
   * slug, and the core layer drops the hit rather than trusting it.
   */
  project_resolved: boolean;
};

export type HistorySearchOutput = {
  hits: HistoryHit[];
  /** `ids_only` on a fast search path that cannot resolve causal parents. */
  evidence: "ids_only" | "resolved";
  elapsed_ms: number;
};

export type HistoryMessage = {
  source_ref: SourceRef;
  text: string;
  role: string | null;
};

export type HistoryReadOutput = {
  anchor: SourceRef;
  messages: HistoryMessage[];
  has_more: boolean;
  elapsed_ms: number;
};

export type HistoryFailureStatus =
  /** The source is not installed, has no index, or is a different version. */
  | "unavailable"
  /** The source is there but the call failed. */
  | "failed";

export type HistoryFailure = {
  ok: false;
  status: HistoryFailureStatus;
  reason: string;
};

export type HistoryOk<T> = { ok: true; value: T };

export type HistoryResult<T> = HistoryOk<T> | HistoryFailure;

export type HistoryPort = {
  probe(): Promise<HistoryAvailability>;
  search(input: {
    text: string;
    project_path: string;
    limit: number;
  }): Promise<HistoryResult<HistorySearchOutput>>;
  /** One bounded causal chain around `anchor`; `before` is 0..N. */
  readByAnchor(input: {
    anchor: string;
    before: number;
  }): Promise<HistoryResult<HistoryReadOutput>>;
};

export type LayerName = "active" | "archived" | "history";

export type LayerStatus =
  | "matched"
  | "empty"
  /** The caller did not ask for this layer, or it cannot apply to this scope. */
  | "skipped"
  | "unavailable"
  | "failed";

export type LayerOutcome = {
  layer: LayerName;
  status: LayerStatus;
  reason: string | null;
  /** Raw candidates the layer returned, before cards or excerpts were built. */
  candidates: number;
  /** Cards (Active/Archived) or bounded excerpts (history) actually emitted. */
  emitted: number;
  /** History only: whether the source resolved complete evidence. */
  evidence: "ids_only" | "resolved" | null;
  /** History only: whether the bounded read-by-anchor ran. */
  read: boolean;
};

export type HistoryExcerpt = {
  source_ref: SourceRef;
  excerpt: string;
  truncated: boolean;
  full_char_count: number;
  excerpt_char_count: number;
  truncation_marker: string | null;
  /** Which port call produced this excerpt. */
  via: "search" | "read";
  evidence_complete: boolean;
  project_resolved: boolean;
};

export type LayeredSearchMeasured = {
  result_bytes: number;
  estimated_tokens: number;
  card_count: number;
  active_cards: number;
  archived_cards: number;
  history_excerpts: number;
  history_available: boolean;
};

export type LayeredSearchOutcome = {
  result: RetrievalResult;
  layers: LayerOutcome[];
  /**
   * Bounded history excerpts. The frozen `RetrievalResult` only has room for
   * `SourceRef`s, so the truncated text lives here and the refs are also
   * carried on `result.evidence`.
   */
  history: HistoryExcerpt[];
  measured: LayeredSearchMeasured;
};

export type LayeredSearchScope = Scope;

export type MemoryReadOutcome = LayeredSearchOutcome & {
  memory_uri: MemoryUri | null;
};
