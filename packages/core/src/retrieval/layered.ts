/**
 * Layered base retrieval (PR-04): Active → Archived → raw history, with no
 * model call anywhere on the path.
 *
 * The three rules this module exists to keep:
 *
 * 1. Scope filtering happens before Top K, in the store, for every layer. The
 *    search never mixes projects, and a history hit whose `project_id` is not
 *    the exact project asked for is dropped rather than trusted.
 * 2. Archived rows never take part in the default Active ranking. Archived is
 *    consulted only when the caller asks for it (`include_archived`) or when
 *    Active genuinely returned nothing, and its cards always come after the
 *    Active ones.
 * 3. A lexical score is not evidence that a question is answered. This layer
 *    therefore never emits `resolved` for a search: it reports `partial` when
 *    it found candidates and lets the model-backed layer (PR-06) decide. Only
 *    `readMemoryResult` — where the caller named one memory and got its full
 *    medium summary — reports `resolved`.
 *
 * Output is bounded by construction: at most `MAX_CARD_LIMIT` cards, at most
 * `MAX_HISTORY_HITS` excerpts, each excerpt truncated to a code-point cap with
 * an explicit marker, and a byte ceiling on the history payload as a whole.
 */

import {
  parseMemoryCard,
  parseRetrievalResult,
  parseScope,
  type MemoryCard,
  type MemoryUri,
  type Revision,
  type RetrievalStatus,
  type Scope,
  type SourceRef,
} from "../contracts/index.js";
import type { MemoryStore, SearchHit } from "../storage/store.js";
import { findConflictingMemoryIds } from "./conflict.js";
import { retrievalError } from "./errors.js";
import { boundExcerpt } from "./excerpt.js";
import type {
  HistoryExcerpt,
  HistoryPort,
  LayerOutcome,
  LayeredSearchOutcome,
  LayeredSearchMeasured,
  MemoryReadOutcome,
} from "./types.js";

/** Active cards a default search returns. Expandable, never unbounded. */
export const DEFAULT_CARD_LIMIT = 5;
/** Hard ceiling on cards, Active plus Archived, in one result. */
export const MAX_CARD_LIMIT = 10;
export const DEFAULT_HISTORY_HITS = 3;
export const MAX_HISTORY_HITS = 10;
export const DEFAULT_HISTORY_EXCERPT_CHARS = 400;
export const MIN_HISTORY_EXCERPT_CHARS = 32;
export const MAX_HISTORY_EXCERPT_CHARS = 4000;
export const DEFAULT_MAX_HISTORY_BYTES = 8 * 1024;
export const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
/** Causal predecessors fetched by the one optional read-by-anchor call. */
export const DEFAULT_HISTORY_READ_BEFORE = 2;
/**
 * Replies after the anchor, not before it. A user message is frequently the
 * best lexical hit for its own question while the answer sits in the child
 * message, so reading backwards alone would hand the model the question back.
 */
export const DEFAULT_HISTORY_READ_AFTER = 2;
/** Same estimator PR-01's baseline harness uses, so the numbers compare. */
export const TOKEN_ESTIMATE_BYTES_PER_TOKEN = 4;

export type LayeredSearchInput = {
  store: MemoryStore;
  query: string;
  scope: Scope;
  /** Default 5, hard cap 10. */
  limit?: number | undefined;
  /** Pages the Active ranking only; Archived fills the remaining card budget. */
  offset?: number | undefined;
  /** Explicit widening: consult Archived even when Active matched. */
  include_archived?: boolean | undefined;
  /** Explicit widening to the raw history provider. */
  include_history?: boolean | undefined;
  /** One extra bounded read-by-anchor on the top history hit. */
  include_history_read?: boolean | undefined;
  history?: HistoryPort | undefined;
  history_limit?: number | undefined;
  history_excerpt_chars?: number | undefined;
  max_history_bytes?: number | undefined;
  max_result_bytes?: number | undefined;
};

export type MemoryReadInput = {
  store: MemoryStore;
  uri: MemoryUri;
  revision?: Revision | undefined;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function integerOption(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw retrievalError(
      "limit_out_of_range",
      `${name} must be an integer from ${min} to ${max}; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function sourceKey(source: SourceRef): string {
  return [source.provider, source.source_instance, source.session_id, source.message_id, source.content_hash].join(
    "|",
  );
}

function dedupeSources(sources: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const unique: SourceRef[] = [];
  for (const source of sources) {
    const key = sourceKey(source);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(source);
  }
  return unique;
}

type CardBuild = {
  cards: MemoryCard[];
  sources: SourceRef[];
  /** Parallel to `cards`, so trimming the card list cannot leak dropped sources. */
  sources_per_card: SourceRef[][];
  missing: string[];
};

/**
 * Turn ranked hits into cards. A hit whose memory has no navigation summary
 * (a `medium_ready` row) is not a card — the frozen `MemoryCard.nav_text` is
 * 1..200 code points and inventing one would be a lie — but it is recorded in
 * `missing` so an empty card list is never read as "this layer found nothing".
 */
function buildCards(store: MemoryStore, hits: readonly SearchHit[]): CardBuild {
  const cards: MemoryCard[] = [];
  const sources: SourceRef[] = [];
  const sources_per_card: SourceRef[][] = [];
  const missing: string[] = [];
  for (const hit of hits) {
    let memory;
    try {
      memory = store.readMemory(hit.uri);
    } catch (error) {
      missing.push(`store_unreadable:${hit.uri}:${messageOf(error)}`);
      continue;
    }
    if (memory === null) {
      missing.push(`memory_vanished:${hit.uri}`);
      continue;
    }
    if (memory.nav === null) {
      missing.push(`nav_missing:${hit.uri}`);
      continue;
    }
    sources_per_card.push([...memory.medium.sources]);
    cards.push(
      parseMemoryCard({
        memory_id: memory.memory_id,
        uri: memory.uri,
        scope: memory.scope,
        title: memory.title,
        nav_text: memory.nav.text,
        revision: memory.revision,
        state: memory.state,
        score: hit.score,
        hit_count: memory.hit_count,
        access_count: memory.access_count,
        last_access_at: memory.last_access_at,
      }),
    );
    for (const source of memory.medium.sources) {
      sources.push(source);
    }
  }
  return { cards, sources, sources_per_card, missing };
}

function sourcesOfCards(build: CardBuild, card_count: number): SourceRef[] {
  return build.sources_per_card.slice(0, card_count).flat();
}

type HistoryRun = {
  layer: LayerOutcome;
  excerpts: HistoryExcerpt[];
  sources: SourceRef[];
  missing: string[];
  available: boolean;
};

async function runHistoryLayer(input: {
  requested: boolean;
  port: HistoryPort | undefined;
  scope: Scope;
  query: string;
  limit: number;
  excerpt_chars: number;
  max_bytes: number;
  include_read: boolean;
  read_before: number;
  read_after: number;
}): Promise<HistoryRun> {
  const layer: LayerOutcome = {
    layer: "history",
    status: "skipped",
    reason: null,
    candidates: 0,
    emitted: 0,
    evidence: null,
    read: false,
  };
  const excerpts: HistoryExcerpt[] = [];
  const sources: SourceRef[] = [];
  const missing: string[] = [];
  const done = (available: boolean): HistoryRun => ({ layer, excerpts, sources, missing, available });

  // The raw history layer is the expensive one, and reaching it is a caller
  // decision. Without an explicit ask the port is never touched, not even to
  // probe it.
  if (input.requested !== true) {
    layer.reason = "not_requested";
    return done(false);
  }
  if (input.port === undefined) {
    layer.reason = "history_port_missing";
    missing.push("history:port_missing");
    return done(false);
  }
  if (input.scope.kind !== "project") {
    layer.reason = "history_requires_project_scope";
    missing.push("history:requires_project_scope");
    return done(false);
  }
  const projectPath = input.scope.project_id;

  try {
    const probe = await input.port.probe();
    if (!probe.available) {
      layer.status = "unavailable";
      layer.reason = probe.reason ?? "unavailable";
      missing.push(`history:unavailable:${layer.reason}`);
      return done(false);
    }
  } catch (error) {
    layer.status = "failed";
    layer.reason = messageOf(error);
    missing.push(`history:probe_failed:${layer.reason}`);
    return done(false);
  }

  const seen = new Set<string>();
  let bytes = 0;
  let byteCapped = false;
  let topAnchor: string | null = null;
  let topRole: string | null = null;

  const accept = (entry: {
    source_ref: SourceRef;
    text: string;
    via: "search" | "read";
    evidence_complete: boolean;
    project_resolved: boolean;
  }): "added" | "duplicate" | "capped" | "foreign" => {
    if (entry.source_ref.project_id !== projectPath) {
      missing.push(`history:project_mismatch:${entry.source_ref.message_id}`);
      return "foreign";
    }
    const key = `${entry.source_ref.message_id}|${entry.source_ref.content_hash}`;
    if (seen.has(key)) {
      return "duplicate";
    }
    const bound = boundExcerpt(entry.text, input.excerpt_chars);
    const cost = Buffer.byteLength(bound.excerpt, "utf8");
    if (bytes + cost > input.max_bytes) {
      return "capped";
    }
    seen.add(key);
    bytes += cost;
    excerpts.push({
      source_ref: entry.source_ref,
      excerpt: bound.excerpt,
      truncated: bound.truncated,
      full_char_count: bound.full_char_count,
      excerpt_char_count: bound.excerpt_char_count,
      truncation_marker: bound.truncation_marker,
      via: entry.via,
      evidence_complete: entry.evidence_complete,
      project_resolved: entry.project_resolved,
    });
    sources.push(entry.source_ref);
    return "added";
  };

  try {
    const found = await input.port.search({
      text: input.query,
      project_path: projectPath,
      limit: input.limit,
    });
    if (!found.ok) {
      layer.status = found.status === "unavailable" ? "unavailable" : "failed";
      layer.reason = found.reason;
      missing.push(`history:search_${found.status}:${found.reason}`);
      return done(found.status !== "unavailable");
    }
    layer.candidates = found.value.hits.length;
    layer.evidence = found.value.evidence;
    for (const hit of found.value.hits) {
      const outcome = accept({
        source_ref: hit.source_ref,
        text: hit.text,
        via: "search",
        evidence_complete: hit.evidence_complete,
        project_resolved: hit.project_resolved,
      });
      if (outcome === "capped") {
        byteCapped = true;
        break;
      }
      if (topAnchor === null && outcome === "added") {
        topAnchor = hit.source_ref.message_id;
        topRole = hit.role;
      }
    }
  } catch (error) {
    layer.status = "failed";
    layer.reason = messageOf(error);
    missing.push(`history:search_failed:${layer.reason}`);
    return done(false);
  }

  layer.emitted = excerpts.length;
  layer.status = layer.candidates === 0 ? "empty" : "matched";

  if (input.include_read && topAnchor !== null) {
    layer.read = true;
    const windows: { relation: "parents" | "timeline"; before: number; after: number }[] = [
      { relation: "parents", before: input.read_before, after: 0 },
    ];
    // A user message is the usual lexical winner for its own question, and the
    // answer is its child. Parents alone would return the question to the model.
    if (topRole === "user" && input.read_after > 0) {
      windows.push({ relation: "timeline", before: 0, after: input.read_after });
    }
    for (const window of windows) {
      try {
        const read = await input.port.readByAnchor({
          anchor: topAnchor,
          before: window.before,
          relation: window.relation,
          after: window.after,
        });
        if (!read.ok) {
          missing.push(`history:read_${read.status}:${read.reason}`);
          continue;
        }
        for (const entry of read.value.messages) {
          const outcome = accept({
            source_ref: entry.source_ref,
            text: entry.text,
            via: "read",
            evidence_complete: true,
            project_resolved: true,
          });
          if (outcome === "capped") {
            byteCapped = true;
            break;
          }
        }
      } catch (error) {
        missing.push(`history:read_failed:${messageOf(error)}`);
      }
      if (byteCapped) {
        break;
      }
    }
    layer.emitted = excerpts.length;
  }

  if (byteCapped) {
    layer.reason = layer.reason === null ? "history_byte_cap" : `${layer.reason};history_byte_cap`;
    missing.push("history:byte_cap_reached");
  }

  return done(true);
}

function chooseNextAction(input: {
  active_candidates: number;
  archived_consulted: boolean;
  include_history: boolean;
  scope: Scope;
  cards: readonly MemoryCard[];
  excerpts: readonly HistoryExcerpt[];
}): string | null {
  if (input.active_candidates > 0 && !input.archived_consulted) {
    return "widen:archived";
  }
  // Guidance for the caller, not a claim about this call's wiring: the next
  // step after Archived is the history layer, and the caller decides whether to
  // inject a port and ask for it.
  if (
    !input.include_history &&
    input.scope.kind === "project" &&
    (input.cards.length > 0 || input.excerpts.length > 0)
  ) {
    return "widen:history";
  }
  const firstCard = input.cards[0];
  if (firstCard !== undefined) {
    return `read:${firstCard.uri}`;
  }
  const firstExcerpt = input.excerpts[0];
  if (firstExcerpt !== undefined) {
    return `read-history:${firstExcerpt.source_ref.message_id}`;
  }
  return null;
}

export async function layeredSearch(input: LayeredSearchInput): Promise<LayeredSearchOutcome> {
  const started = performance.now();
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw retrievalError("invalid_option", "query must be a non-empty string");
  }
  const scope = parseScope(input.scope);
  const limit = integerOption(input.limit, DEFAULT_CARD_LIMIT, 1, MAX_CARD_LIMIT, "limit");
  const offset = integerOption(input.offset, 0, 0, 1_000_000, "offset");
  const historyLimit = integerOption(
    input.history_limit,
    DEFAULT_HISTORY_HITS,
    1,
    MAX_HISTORY_HITS,
    "history_limit",
  );
  const excerptChars = integerOption(
    input.history_excerpt_chars,
    DEFAULT_HISTORY_EXCERPT_CHARS,
    MIN_HISTORY_EXCERPT_CHARS,
    MAX_HISTORY_EXCERPT_CHARS,
    "history_excerpt_chars",
  );
  const maxHistoryBytes = integerOption(
    input.max_history_bytes,
    DEFAULT_MAX_HISTORY_BYTES,
    256,
    1024 * 1024,
    "max_history_bytes",
  );
  const maxResultBytes = integerOption(
    input.max_result_bytes,
    DEFAULT_MAX_RESULT_BYTES,
    1024,
    1024 * 1024,
    "max_result_bytes",
  );

  const activeHits = input.store.searchActive(input.query, { scope, limit, offset });
  const activeBuild = buildCards(input.store, activeHits);
  const activeLayer: LayerOutcome = {
    layer: "active",
    status: activeHits.length === 0 ? "empty" : "matched",
    reason: null,
    candidates: activeHits.length,
    emitted: activeBuild.cards.length,
    evidence: null,
    read: false,
  };

  const archivedBudget = Math.max(0, limit - activeBuild.cards.length);
  const fallThrough = offset === 0 && activeHits.length === 0;
  const archivedConsulted = input.include_archived === true || fallThrough;
  const archivedLayer: LayerOutcome = {
    layer: "archived",
    status: "skipped",
    reason: "not_consulted",
    candidates: 0,
    emitted: 0,
    evidence: null,
    read: false,
  };
  let archivedBuild: CardBuild = { cards: [], sources: [], sources_per_card: [], missing: [] };
  if (archivedConsulted) {
    const archivedHits = input.store.searchArchived(input.query, {
      scope,
      limit: Math.max(1, archivedBudget),
      offset: 0,
    });
    const built = buildCards(input.store, archivedHits);
    const kept = built.cards.slice(0, archivedBudget);
    archivedBuild = {
      cards: kept,
      // Only the returned cards may contribute evidence: an Archived hit cut by
      // the card budget is not in the answer, so its sources must not be either.
      sources: sourcesOfCards(built, kept.length),
      sources_per_card: built.sources_per_card.slice(0, kept.length),
      missing: built.missing,
    };
    archivedLayer.status = archivedHits.length === 0 ? "empty" : "matched";
    archivedLayer.candidates = archivedHits.length;
    archivedLayer.emitted = archivedBuild.cards.length;
    // `explicit` widening and automatic fall-through are different events and
    // the caller can see which one happened.
    archivedLayer.reason = input.include_archived === true ? "explicit" : "fall_through";
  }

  const historyRun = await runHistoryLayer({
    requested: input.include_history === true,
    port: input.history,
    scope,
    query: input.query,
    limit: historyLimit,
    excerpt_chars: excerptChars,
    max_bytes: maxHistoryBytes,
    include_read: input.include_history_read === true,
    read_before: DEFAULT_HISTORY_READ_BEFORE,
    read_after: DEFAULT_HISTORY_READ_AFTER,
  });

  const cards = [...activeBuild.cards, ...archivedBuild.cards];
  const missing = [...activeBuild.missing, ...archivedBuild.missing, ...historyRun.missing];

  // Bound the whole result, not just the history excerpt list. Trimming drops
  // the oldest excerpts first and says so; cards alone are far under the cap.
  let historyFinal = historyRun.excerpts;
  if (historyFinal.length > 0) {
    const measure = (excerpts: readonly HistoryExcerpt[]): number =>
      Buffer.byteLength(JSON.stringify({ cards, history: excerpts }), "utf8");
    let bytes = measure(historyFinal);
    while (historyFinal.length > 0 && bytes > maxResultBytes) {
      historyFinal = historyFinal.slice(0, -1);
      bytes = measure(historyFinal);
    }
    if (historyFinal.length !== historyRun.excerpts.length) {
      historyRun.layer.emitted = historyFinal.length;
      historyRun.layer.reason =
        historyRun.layer.reason === null
          ? "result_byte_cap"
          : `${historyRun.layer.reason};result_byte_cap`;
      missing.push(`history:result_byte_cap:${maxResultBytes}`);
    }
  }

  const conflicts = findConflictingMemoryIds(cards);
  const historyCandidates = historyRun.layer.candidates;
  const nothingFound = activeHits.length === 0 && archivedLayer.candidates === 0 && historyCandidates === 0;
  const status: RetrievalStatus = nothingFound
    ? "not_found"
    : conflicts.length > 0
      ? "conflicted"
      : "partial";

  const next_action = chooseNextAction({
    active_candidates: activeHits.length,
    archived_consulted: archivedConsulted,
    include_history: input.include_history === true,
    scope,
    cards,
    excerpts: historyFinal,
  });

  const elapsed = performance.now() - started;
  const result = parseRetrievalResult({
    status,
    cards,
    answer: null,
    memory_summary: null,
    memory_uri: null,
    revision: null,
    persistence_status: "not_attempted",
    navigation_status: "pending",
    evidence: dedupeSources([
      ...activeBuild.sources,
      ...archivedBuild.sources,
      ...historyRun.sources,
    ]),
    missing,
    conflicts,
    next_action,
    continuation_id: null,
    budget_used: {
      elapsed_ms: elapsed,
      model_calls: 0,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: null,
    },
  });

  const resultBytes = Buffer.byteLength(JSON.stringify({ result, history: historyFinal }), "utf8");
  const measured: LayeredSearchMeasured = {
    result_bytes: resultBytes,
    estimated_tokens: Math.ceil(resultBytes / TOKEN_ESTIMATE_BYTES_PER_TOKEN),
    card_count: cards.length,
    active_cards: activeBuild.cards.length,
    archived_cards: archivedBuild.cards.length,
    history_excerpts: historyFinal.length,
    history_available: historyRun.available,
  };

  return {
    result,
    layers: [activeLayer, archivedLayer, historyRun.layer],
    history: historyFinal,
    measured,
  };
}

/**
 * Read one named memory: the only PR-04 path that reports `resolved`, because
 * the caller named the memory and the full medium summary is what comes back.
 * Nothing is written and no model is called, so persistence is
 * `not_attempted` even though the summary is delivered.
 */
export function readMemoryResult(input: MemoryReadInput): MemoryReadOutcome {
  const started = performance.now();
  const memory = input.store.readMemory(input.uri, input.revision);
  if (memory === null) {
    const elapsed = performance.now() - started;
    const result = parseRetrievalResult({
      status: "not_found",
      cards: [],
      answer: null,
      memory_summary: null,
      memory_uri: null,
      revision: null,
      persistence_status: "not_attempted",
      navigation_status: "pending",
      evidence: [],
      missing: [`memory_not_found:${input.uri}`],
      conflicts: [],
      next_action: null,
      continuation_id: null,
      budget_used: {
        elapsed_ms: elapsed,
        model_calls: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: null,
      },
    });
    return {
      result,
      layers: [],
      history: [],
      measured: {
        result_bytes: Buffer.byteLength(JSON.stringify({ result, history: [] }), "utf8"),
        estimated_tokens: Math.ceil(
          Buffer.byteLength(JSON.stringify({ result, history: [] }), "utf8") / TOKEN_ESTIMATE_BYTES_PER_TOKEN,
        ),
        card_count: 0,
        active_cards: 0,
        archived_cards: 0,
        history_excerpts: 0,
        history_available: false,
      },
      memory_uri: null,
    };
  }

  const cards: MemoryCard[] =
    memory.nav === null
      ? []
      : [
          parseMemoryCard({
            memory_id: memory.memory_id,
            uri: memory.uri,
            scope: memory.scope,
            title: memory.title,
            nav_text: memory.nav.text,
            revision: memory.revision,
            state: memory.state,
            // A direct read has no ranking; score 0 is "not ranked".
            score: 0,
            hit_count: memory.hit_count,
            access_count: memory.access_count,
            last_access_at: memory.last_access_at,
          }),
        ];
  const elapsed = performance.now() - started;
  const result = parseRetrievalResult({
    status: "resolved",
    cards,
    answer: null,
    memory_summary: memory.medium.body,
    memory_uri: memory.uri,
    revision: memory.revision,
    persistence_status: "not_attempted",
    navigation_status: memory.nav === null ? "pending" : "ready",
    evidence: dedupeSources(memory.medium.sources),
    missing: [],
    conflicts: [],
    next_action: null,
    continuation_id: null,
    budget_used: {
      elapsed_ms: elapsed,
      model_calls: 0,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: null,
    },
  });
  const resultBytes = Buffer.byteLength(JSON.stringify({ result, history: [] }), "utf8");
  const archived = memory.state === "archived";
  return {
    result,
    layers: [],
    history: [],
    measured: {
      result_bytes: resultBytes,
      estimated_tokens: Math.ceil(resultBytes / TOKEN_ESTIMATE_BYTES_PER_TOKEN),
      card_count: cards.length,
      active_cards: archived ? 0 : cards.length,
      archived_cards: archived ? cards.length : 0,
      history_excerpts: 0,
      history_available: false,
    },
    memory_uri: memory.uri,
  };
}
