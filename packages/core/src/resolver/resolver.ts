/**
 * `memory.resolve` — the budgeted, model-backed layered retrieval executor
 * (PR-06).
 *
 * The walk is exactly the plan's: zero-LLM candidates first (Active →
 * Archived → raw history through the caller's `HistoryPort`), a model judgment
 * between layers, and a stop as soon as the evidence is sufficient. A lexical
 * candidate that matches the words but not the question is not trusted; the
 * model's `sufficient=false` continues the descent.
 *
 * What this module deliberately does not do:
 * - It never saves on a reuse-only answer. The forced medium summary and the
 *   save happen only when the walk ended `resolved` on evidence that includes
 *   raw history (PR-07, `persist.ts`); an Active/Archived answer alone writes
 *   nothing because it is reuse, not new history.
 * - It never records usage events for the cards it reads. Access accounting is
 *   the caller's (PR-08) decision; the one exception is the delivery access for
 *   a body this request wrote, which is part of the write's own contract.
 * - It never widens scope. Every candidate comes from a store search scoped to
 *   the caller's project or from a history hit the port marked
 *   `project_resolved`, and the judge reader rejects any evidence id that is not
 *   one of those candidates.
 *
 * Statuses are earned: `resolved` only when a sufficiency decision passes
 * evidence validation, `conflicted` when the evidence disagrees, `partial` when
 * something was found but not enough, `not_found` when nothing was. A
 * non-resolved result never carries prose in `answer`; the gap is reported in
 * `missing` (and `conflicts`).
 */

import {
  parseRetrievalResult,
  parseScope,
  type MemoryCard,
  type MemoryUri,
  type RetrievalResult,
  type RetrievalStatus,
  type Scope,
  type SourceRef,
} from "../contracts/index.js";
import { hasRawHistoryEvidence, persistResolvedMemory, replaySavedRequest } from "./persist.js";
import {
  layeredSearch,
  readMemoryResult,
  subjectKey,
  subjectsCollide,
  type HistoryExcerpt,
  type HistoryPort,
  type LayerName,
  type LayerOutcome,
} from "../retrieval/index.js";
import { retrievalError } from "../retrieval/errors.js";
import { type MemoryStore } from "../storage/store.js";
import {
  RESOLVE_COLD_REFRESH_THRESHOLD_MS,
  RESOLVE_TOKEN_ESTIMATE_BYTES_PER_TOKEN,
  ResolveBudgetLedger,
  readResolveBudget,
} from "./budget.js";
import {
  JUDGE_SYSTEM_PROMPT,
  buildJudgeUserMessage,
  judgeAllowList,
  parseJudgeDecision,
  type JudgeDecision,
} from "./judge.js";
import type {
  ModelPort,
  ModelRequest,
  PendingResolvePersistence,
  ResolveCallRecord,
  ResolveContinuation,
  ResolveInput,
  ResolveOutcome,
} from "./types.js";

const LAYER_ORDER: readonly LayerName[] = ["active", "archived", "history"];
const HISTORY_EXCERPT_CHARS = 1200;
const HISTORY_HITS = 6;
const MAX_HISTORY_BYTES = 12 * 1024;
/**
 * A layer may be gathered at most twice: once on arrival, once re-queried with
 * the judge's better phrasings. The second gather is what keeps `next_queries`
 * from only ever reaching the *lower* layers.
 */
const MAX_LAYER_GATHERS = 2;
/** Re-gathers one resolve may spend; each one costs the judge call it triggers. */
export const MAX_LAYER_REQUERIES = 2;

/**
 * The judge answers with whole phrasings, e.g. "发布窗口 灰度比例 发布时长上限".
 * One query matches every token ANDed (`packages/core/src/storage/tokenize.ts`),
 * so a phrasing that names several concepts can never match a memory that states
 * them in separate clauses, and the re-ask would come back as empty as the first
 * gather. Split a phrasing on whitespace and list punctuation so each concept is
 * searched on its own; the store unions the hits and the judge still decides
 * sufficiency.
 */
const PHRASING_SEPARATORS = /[\s、，,；;·|/]+/u;
/**
 * How many of those fragments one re-ask may spend. A re-ask is a few cheap
 * index lookups and no extra model call, but the caller's variant budget is not
 * the right ceiling for it: the judge can name one concept per phrasing, so a
 * three-fragment re-ask drops the concept that finally matches. The judge still
 * filters whatever the wider net pulls in.
 */
const MAX_REQUERY_VARIANTS = 8;

/**
 * Fragments ordered by length: a two-to-four character fragment is a keyword
 * and ANDs the fewest tokens, while a longer one is closer to a sentence and a
 * conjunctive index rarely matches it whole.
 */
function expandPhrasings(queries: readonly string[]): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    for (const segment of query.split(PHRASING_SEPARATORS)) {
      const trimmed = segment.trim();
      const key = trimmed.toLocaleLowerCase();
      if (Array.from(trimmed).length < 2 || seen.has(key)) continue;
      seen.add(key);
      expanded.push(trimmed);
    }
  }
  return expanded.sort((left, right) => Array.from(left).length - Array.from(right).length);
}

type ReadBody = { uri: string; body: string };

type Bundle = {
  cards: MemoryCard[];
  excerpts: HistoryExcerpt[];
  sources: SourceRef[];
  read_bodies: ReadBody[];
  layers: LayerOutcome[];
  missing: string[];
  gathered: Set<LayerName>;
  next_action: string | null;
  history_available: boolean;
};

type Assembly = { result: RetrievalResult; layers: LayerOutcome[] };

function emptyBundle(): Bundle {
  return {
    cards: [],
    excerpts: [],
    sources: [],
    read_bodies: [],
    layers: [],
    missing: [],
    gathered: new Set(),
    next_action: null,
    history_available: false,
  };
}

function sourceKey(source: SourceRef): string {
  return [source.provider, source.source_instance, source.session_id, source.message_id, source.content_hash].join("|");
}

function excerptKey(excerpt: HistoryExcerpt): string {
  return `${excerpt.source_ref.message_id}|${excerpt.source_ref.content_hash}`;
}

function scopeEqual(left: Scope, right: Scope): boolean {
  if (left.kind === "global" && right.kind === "global") return true;
  if (left.kind === "project" && right.kind === "project") return left.project_id === right.project_id;
  return false;
}

function scopeLabel(scope: Scope): string {
  return scope.kind === "project" ? scope.project_id : "global";
}

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / RESOLVE_TOKEN_ESTIMATE_BYTES_PER_TOKEN);
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Layers merge across gathers instead of being overwritten: a later gather for
 * a lower layer must not erase the fact that Active matched earlier in the
 * same walk. The strongest status wins; candidates/emitted take the maximum;
 * a resolved evidence flag is never downgraded to ids-only.
 */
const LAYER_STATUS_RANK: Record<LayerOutcome["status"], number> = {
  skipped: 0,
  failed: 1,
  unavailable: 2,
  empty: 3,
  matched: 4,
};

function mergeLayers(target: Bundle, add: readonly LayerOutcome[]): void {
  for (const incoming of add) {
    const index = target.layers.findIndex((existing) => existing.layer === incoming.layer);
    if (index === -1) {
      target.layers.push(incoming);
      continue;
    }
    const existing = target.layers[index] as LayerOutcome;
    const incomingWins = LAYER_STATUS_RANK[incoming.status] > LAYER_STATUS_RANK[existing.status];
    target.layers[index] = {
      layer: incoming.layer,
      status: incomingWins ? incoming.status : existing.status,
      reason: incomingWins ? incoming.reason : existing.reason,
      candidates: Math.max(existing.candidates, incoming.candidates),
      emitted: Math.max(existing.emitted, incoming.emitted),
      evidence: existing.evidence === "resolved" || incoming.evidence === "resolved" ? "resolved" : existing.evidence ?? incoming.evidence,
      read: existing.read || incoming.read,
    };
  }
  target.layers.sort((left, right) => LAYER_ORDER.indexOf(left.layer) - LAYER_ORDER.indexOf(right.layer));
}

function mergeCards(bundle: Bundle, cards: readonly MemoryCard[]): void {
  const seen = new Set(bundle.cards.map((card) => card.memory_id));
  for (const card of cards) {
    if (seen.has(card.memory_id)) continue;
    seen.add(card.memory_id);
    bundle.cards.push(card);
  }
}

function mergeExcerpts(bundle: Bundle, excerpts: readonly HistoryExcerpt[]): void {
  const seen = new Set(bundle.excerpts.map(excerptKey));
  for (const excerpt of excerpts) {
    if (seen.has(excerptKey(excerpt))) continue;
    seen.add(excerptKey(excerpt));
    bundle.excerpts.push(excerpt);
  }
}

function cardBytes(card: MemoryCard): number {
  return Buffer.byteLength(`${card.memory_id}\n${card.title}\n${card.nav_text}`, "utf8");
}

function excerptBytes(excerpt: HistoryExcerpt): number {
  return Buffer.byteLength(excerpt.excerpt, "utf8");
}

function sourcesForCard(store: MemoryStore, uri: MemoryUri): SourceRef[] {
  try {
    const memory = store.readMemory(uri);
    return memory === null ? [] : [...memory.medium.sources];
  } catch {
    return [];
  }
}

function readQuestion(question: unknown): string {
  if (typeof question !== "string" || question.trim().length === 0) {
    throw retrievalError("invalid_option", "question must be a non-empty string");
  }
  return question;
}

/**
 * The stale card, if any, that the judge actually cited. Repair is only for a
 * topic the walk used: silently rewriting a memory that merely happened to be a
 * candidate would be a different bug.
 */
function staleCardInEvidence(cards: readonly MemoryCard[], ids: readonly string[]): MemoryCard | null {
  const cited = new Set(ids);
  for (const card of cards) {
    if (cited.has(card.memory_id) && card.freshness?.is_stale === true) {
      return card;
    }
  }
  return null;
}

/**
 * Conflicts anchored on the cards the answer cites: a card the model relies on
 * is contested when another card in the same scope claims the same subject
 * (the PR-04 `subjectsCollide` rule). Without this a model-held `resolved`
 * would outrank the deterministic conflict signal the zero-LLM path reports.
 * Both sides are named so the caller can compare them.
 */
function findSubjectConflicts(cards: readonly MemoryCard[], ids: readonly string[]): string[] {
  const chosen = cards.filter((card) => ids.includes(card.memory_id));
  if (chosen.length === 0) return [];
  const flagged = new Set<string>();
  for (const cited of chosen) {
    for (const other of cards) {
      if (other.memory_id === cited.memory_id) continue;
      if (!scopeEqual(other.scope, cited.scope)) continue;
      if (subjectsCollide(subjectKey(cited.title), subjectKey(other.title))) {
        flagged.add(cited.memory_id);
        flagged.add(other.memory_id);
      }
    }
  }
  return [...flagged].sort();
}

export async function resolveMemory(input: ResolveInput): Promise<ResolveOutcome> {
  const mono = input.mono_now ?? (() => performance.now());
  const wall = input.wall_now ?? (() => Date.now());
  const started = mono();
  const question = readQuestion(input.question);
  const scope = parseScope(input.scope);
  const options = readResolveBudget(input.budget);
  const ledger = new ResolveBudgetLedger(options);
  const calls: ResolveCallRecord[] = [];
  let gatherMs = 0;
  let modelMs = 0;
  let historyReadMs = 0;
  let cold = false;
  let retryUsed = false;
  let reused = false;
  let summaryMs = 0;
  let persistMs = 0;
  let persistence: ResolveOutcome["persistence"] = null;
  let pendingPersistence: PendingResolvePersistence | null = null;

  const controller = new AbortController();
  const userSignal = input.signal;
  if (userSignal !== undefined) {
    if (userSignal.aborted) controller.abort(userSignal.reason);
    else userSignal.addEventListener("abort", () => controller.abort(userSignal.reason), { once: true });
  }

  const remaining = (): number => {
    if (input.unbounded_time) return Infinity;
    const limit = cold ? options.cold_deadline_ms : options.warm_deadline_ms;
    return limit - (mono() - started);
  };

  const measuringPort = (): HistoryPort | null => {
    const port = input.history;
    if (port === null || port === undefined) return null;
    return {
      probe: () => port.probe(),
      async search(searchInput) {
        const result = await port.search(searchInput);
        if (result.ok) historyReadMs += result.value.elapsed_ms;
        return result;
      },
      async readByAnchor(readInput) {
        const result = await port.readByAnchor(readInput);
        if (result.ok) historyReadMs += result.value.elapsed_ms;
        return result;
      },
    };
  };

  /**
   * One zero-LLM gather for the named layer. `layer` decides which indexes and
   * whether the history port is touched at all, so a sufficient Active answer
   * never searches Archived or raw history.
   */
  async function gather(
    queries: readonly string[],
    layer: LayerName,
    variants: number = options.max_query_variants,
  ): Promise<{ bundle: Bundle; coldRefresh: boolean }> {
    const bundle = emptyBundle();
    const port = measuringPort();
    const historyWanted = layer === "history" && port !== null && scope.kind === "project";
    const archivedWanted = layer !== "active";
    let coldRefresh = false;
    const list = queries.length === 0 ? [question] : [...queries];
    for (const query of list.slice(0, variants)) {
      const before = mono();
      const beforeHistory = historyReadMs;
      const outcome = await layeredSearch({
        store: input.store,
        query,
        scope,
        limit: options.max_candidate_cards,
        include_archived: archivedWanted,
        include_history: historyWanted,
        include_history_read: historyWanted,
        history: port ?? undefined,
        history_limit: HISTORY_HITS,
        history_excerpt_chars: HISTORY_EXCERPT_CHARS,
        max_history_bytes: MAX_HISTORY_BYTES,
      });
      gatherMs += mono() - before;
      if (historyReadMs - beforeHistory >= RESOLVE_COLD_REFRESH_THRESHOLD_MS) coldRefresh = true;
      mergeCards(bundle, outcome.result.cards);
      mergeExcerpts(bundle, outcome.history);
      for (const source of outcome.result.evidence) {
        if (!bundle.sources.some((existing) => sourceKey(existing) === sourceKey(source))) bundle.sources.push(source);
      }
      if (outcome.layers.length > 0) mergeLayers(bundle, outcome.layers);
      if (outcome.result.next_action !== null) bundle.next_action = outcome.result.next_action;
      bundle.history_available = bundle.history_available || outcome.measured.history_available;
      for (const missing of outcome.result.missing) bundle.missing.push(missing);
    }
    return { bundle, coldRefresh };
  }

  function absorb(target: Bundle, add: Bundle): Bundle {
    mergeCards(target, add.cards);
    mergeExcerpts(target, add.excerpts);
    for (const source of add.sources) {
      if (!target.sources.some((existing) => sourceKey(existing) === sourceKey(source))) target.sources.push(source);
    }
    for (const body of add.read_bodies) {
      if (!target.read_bodies.some((entry) => entry.uri === body.uri)) target.read_bodies.push(body);
    }
    if (add.layers.length > 0) mergeLayers(target, add.layers);
    if (add.next_action !== null) target.next_action = add.next_action;
    target.history_available = target.history_available || add.history_available;
    for (const missing of add.missing) target.missing.push(missing);
    return target;
  }

  function bundleFromContinuation(continuation: ResolveContinuation): Bundle {
    const bundle = emptyBundle();
    for (const card of continuation.cards) {
      if (scopeEqual(card.scope, scope)) mergeCards(bundle, [card]);
    }
    mergeExcerpts(bundle, continuation.excerpts);
    bundle.sources = [...continuation.sources];
    for (const layer of LAYER_ORDER) bundle.gathered.add(layer);
    return bundle;
  }

  function boundForModel(bundle: Bundle, maxBytes: number, maxItems: number): {
    cards: MemoryCard[];
    excerpts: HistoryExcerpt[];
  } {
    const cards: MemoryCard[] = [];
    const excerpts: HistoryExcerpt[] = [];
    let bytes = 0;
    let items = 0;
    for (const card of bundle.cards) {
      if (items + 1 > maxItems || bytes + cardBytes(card) > maxBytes) continue;
      cards.push(card);
      bytes += cardBytes(card);
      items += 1;
    }
    for (const excerpt of bundle.excerpts) {
      if (items + 1 > maxItems || bytes + excerptBytes(excerpt) > maxBytes) continue;
      excerpts.push(excerpt);
      bytes += excerptBytes(excerpt);
      items += 1;
    }
    return { cards, excerpts };
  }

  function callRecord(
    layer: LayerName,
    outcome: ResolveCallRecord["outcome"],
    usage: { tokens_in: number; tokens_out: number; cost_usd: number | null },
    elapsed: number,
  ): ResolveCallRecord {
    return {
      index: calls.length,
      layer,
      purpose: "judge_expand",
      model: input.model_id ?? "unconfigured",
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      cost_usd: usage.cost_usd,
      elapsed_ms: elapsed,
      outcome,
    };
  }

  type JudgeResult =
    | { kind: "decision"; decision: JudgeDecision }
    | { kind: "stop"; reason: string; retryable: boolean };

  async function judgeLayer(layer: LayerName, current: Bundle, correction?: string): Promise<JudgeResult> {
    const model = input.model;
    if (model === null || model === undefined) return { kind: "stop", reason: "model_unavailable", retryable: false };
    const bounded = boundForModel(
      current,
      options.max_evidence_bytes,
      options.max_candidate_cards + options.max_evidence_messages,
    );
    const userMessage = buildJudgeUserMessage({
      question,
      scope,
      layer,
      cards: bounded.cards,
      excerpts: bounded.excerpts,
      read_bodies: current.read_bodies,
    });
    const messages = [
      { role: "system" as const, content: JUDGE_SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: correction === undefined ? userMessage : `${userMessage}\n\nCORRECTION: ${correction}`,
      },
    ];
    const estimated = estimateTokens(messages.map((message) => message.content).join("\n"));
    if (!ledger.canCallModel(estimated)) {
      return { kind: "stop", reason: ledger.stopReason(estimated) ?? "model_call_cap", retryable: false };
    }
    const local = input.unbounded_time ? controller.signal :
      AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.floor(remaining())))]);
    const request: ModelRequest = {
      model: input.model_id,
      messages,
      max_output_tokens: ledger.nextOutputCap(),
      expect_json: true,
      signal: local,
    };
    const callStarted = mono();
    const emptyUsage = { tokens_in: 0, tokens_out: 0, cost_usd: null };
    let result: Awaited<ReturnType<ModelPort["complete"]>>;
    try {
      result = await model.complete(request);
    } catch (error) {
      modelMs += mono() - callStarted;
      calls.push(callRecord(layer, "failed", emptyUsage, mono() - callStarted));
      return {
        kind: "stop",
        reason: `model_threw:${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
    }
    const elapsed = mono() - callStarted;
    modelMs += elapsed;
    if (!result.ok) {
      calls.push(callRecord(layer, result.status === "cancelled" ? "cancelled" : "failed", emptyUsage, elapsed));
      if (result.status === "cancelled") {
        return { kind: "stop", reason: controller.signal.aborted ? "cancelled" : "deadline_exceeded", retryable: false };
      }
      return { kind: "stop", reason: `model_${result.status}:${result.reason}`, retryable: true };
    }
    ledger.recordModelCall(result.value.usage);
    const parsed = parseJudgeDecision(result.value.text, judgeAllowList(current));
    if (!parsed.ok) {
      calls.push(callRecord(layer, "malformed", result.value.usage, elapsed));
      return { kind: "stop", reason: `model_malformed_output:${parsed.reason}`, retryable: true };
    }
    calls.push(callRecord(layer, "ok", result.value.usage, elapsed));
    return { kind: "decision", decision: parsed.value };
  }

  function collectEvidence(ids: readonly string[], current: Bundle): SourceRef[] {
    const refs: SourceRef[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const card = current.cards.find((entry) => entry.memory_id === id);
      if (card !== undefined) {
        for (const source of sourcesForCard(input.store, card.uri)) {
          const key = sourceKey(source);
          if (seen.has(key)) continue;
          seen.add(key);
          refs.push(source);
        }
        continue;
      }
      const excerpt = current.excerpts.find((entry) => entry.source_ref.message_id === id);
      if (excerpt !== undefined && !seen.has(sourceKey(excerpt.source_ref))) {
        seen.add(sourceKey(excerpt.source_ref));
        refs.push(excerpt.source_ref);
      }
    }
    const bounded: SourceRef[] = [];
    for (const ref of refs) {
      if (!ledger.addEvidence(Buffer.byteLength(sourceKey(ref), "utf8"), 1)) break;
      bounded.push(ref);
    }
    return bounded;
  }

  function assemble(fields: {
    status: RetrievalStatus;
    answer: string | null;
    cards: MemoryCard[];
    evidence: SourceRef[];
    missing: string[];
    conflicts: string[];
    next_action: string | null;
    continuation_id: string | null;
  }): Assembly {
    const deduped: SourceRef[] = [];
    const seen = new Set<string>();
    for (const source of fields.evidence) {
      const key = sourceKey(source);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(source);
      if (deduped.length >= options.max_evidence_messages) break;
    }
    const result = parseRetrievalResult({
      status: fields.status,
      cards: fields.cards,
      answer: fields.answer,
      memory_summary: null,
      memory_uri: null,
      revision: null,
      persistence_status: "not_attempted",
      navigation_status: "pending",
      evidence: deduped,
      missing: [...new Set(fields.missing)].filter((entry) => entry.length > 0),
      conflicts: [...new Set(fields.conflicts)],
      next_action: fields.next_action,
      continuation_id: fields.continuation_id,
      budget_used: {
        elapsed_ms: mono() - started,
        model_calls: ledger.model_calls,
        tokens_in: ledger.tokens_in,
        tokens_out: ledger.tokens_out,
        cost_usd: ledger.cost_usd,
      },
    });
    return { result, layers: currentLayers };
  }

  let currentLayers: LayerOutcome[] = [];

  function continuationFor(current: Bundle, resume: LayerName): ResolveContinuation | null {
    if (current.cards.length === 0 && current.excerpts.length === 0) return null;
    return {
      id: `resolve-${fnv1a(`${scopeLabel(scope)}\n${question}`)}`,
      scope,
      question,
      expires_at_ms: wall() + options.continuation_ttl_ms,
      resume_layer: resume,
      cards: current.cards.slice(0, options.max_candidate_cards),
      excerpts: current.excerpts.slice(0, options.max_evidence_messages),
      sources: current.sources.slice(0, options.max_evidence_messages),
    };
  }

  function finish(
    assembly: Assembly,
    continuation: ResolveContinuation | null,
    degraded: boolean,
    history: HistoryExcerpt[] = [],
  ): ResolveOutcome {
    return {
      result: assembly.result,
      layers: assembly.layers,
      history,
      calls,
      persistence,
      pending_persistence: pendingPersistence,
      continuation,
      measured: {
        elapsed_ms: mono() - started,
        gather_ms: gatherMs,
        model_ms: modelMs,
        history_read_ms: historyReadMs,
        summary_ms: summaryMs,
        persist_ms: persistMs,
        model_calls: ledger.model_calls,
        tokens_in: ledger.tokens_in,
        tokens_out: ledger.tokens_out,
        cost_usd: ledger.cost_usd,
        evidence_bytes: ledger.evidence_bytes,
        evidence_messages: ledger.evidence_messages,
        candidate_cards: assembly.result.cards.length,
        history_excerpts: history.length,
        degraded,
        cold,
        reused_continuation: reused,
        layers: assembly.layers,
      },
    };
  }

  function stopAssembly(reason: string, current: Bundle): Assembly {
    const hasCandidates = current.cards.length > 0 || current.excerpts.length > 0;
    // A walk that never had a candidate is a different failure from one whose
    // candidates the judge rejected: the first says the index could not reach
    // the memory, the second says the model would not accept what it read.
    // `reason` alone reports the second for both, so record the first as well.
    const nothingGathered = !hasCandidates;
    const conflicts = current.missing
      .filter((entry) => entry.startsWith("conflict:"))
      .map((entry) => entry.slice("conflict:".length));
    const status: RetrievalStatus = conflicts.length > 0 ? "conflicted" : hasCandidates ? "partial" : "not_found";
    currentLayers = current.layers;
    return assemble({
      status,
      answer: null,
      cards: status === "not_found" ? [] : current.cards,
      evidence: status === "not_found" ? [] : current.sources,
      missing: [
        ...(reason.length === 0 ? [] : [reason]),
        ...(nothingGathered ? ["no_candidates_gathered"] : []),
        ...current.missing,
      ],
      conflicts,
      next_action: status === "not_found" ? null : current.next_action,
      continuation_id: hasCandidates ? continuationFor(current, lastLayerOf(current))?.id ?? null : null,
    });
  }

  function lastLayerOf(current: Bundle): LayerName {
    for (let index = LAYER_ORDER.length - 1; index >= 0; index -= 1) {
      const layer = LAYER_ORDER[index] as LayerName;
      if (current.gathered.has(layer)) return layer;
    }
    return "active";
  }

  function degraded(reason: string, current: Bundle): ResolveOutcome {
    return finish(stopAssembly(reason, current), null, true, current.excerpts);
  }

  // ---- paths that skip the model -------------------------------------------

  const usedResolves = Math.max(0, Math.trunc(input.session_resolves_used ?? 0));
  if (input.model === null || input.model === undefined) {
    const gathered = await gather([question], "history");
    return degraded("model_not_configured", gathered.bundle);
  }
  if (usedResolves >= options.max_session_resolves) {
    const gathered = await gather([question], "history");
    return degraded("session_resolve_budget_exhausted", gathered.bundle);
  }
  if (controller.signal.aborted) {
    return finish(stopAssembly("cancelled", emptyBundle()), null, false);
  }

  // ---- replay of an already-saved request -----------------------------------
  //
  // The same scope + question already produced a stored revision: return that
  // exact body. This is the repeat path and the recovery path after a crash
  // between save and return; it searches nothing and calls no model.
  const replay = replaySavedRequest({
    store: input.store,
    scope,
    question,
    request_id: input.request_id,
    session_id: input.session_id,
    mono_now: mono,
    wall_now: wall,
    // A stale or behind-the-head cached answer must not short-circuit the walk:
    // punt to the repair path instead of replaying a body later evidence has
    // outgrown.
    require_current: true,
  });
  if (replay !== null) {
    persistence = replay.persistence;
    summaryMs = 0;
    persistMs = replay.persistence.persist_ms;
    const read = readMemoryResult({
      store: input.store,
      uri: replay.memory.uri,
      revision: replay.memory.revision,
    });
    const replayResult = parseRetrievalResult({
      status: "resolved",
      cards: read.result.cards,
      answer: replay.answer,
      memory_summary: replay.memory.medium.body,
      memory_uri: replay.memory.uri,
      revision: replay.memory.revision,
      persistence_status: "saved",
      navigation_status: replay.memory.nav === null ? "pending" : "ready",
      evidence: replay.memory.medium.sources,
      missing: [],
      conflicts: [],
      next_action: null,
      continuation_id: null,
      budget_used: {
        elapsed_ms: mono() - started,
        model_calls: ledger.model_calls,
        tokens_in: ledger.tokens_in,
        tokens_out: ledger.tokens_out,
        cost_usd: ledger.cost_usd,
      },
      ...(read.result.freshness === undefined ? {} : { freshness: read.result.freshness }),
    });
    return finish({ result: replayResult, layers: [] }, null, false);
  }

  // ---- continuation reuse --------------------------------------------------

  let bundle = emptyBundle();
  let layerIndex = 0;
  const candidate = input.continuation ?? null;
  if (
    candidate !== null &&
    candidate.expires_at_ms > wall() &&
    candidate.question === question &&
    scopeEqual(candidate.scope, scope) &&
    candidate.cards.length + candidate.excerpts.length > 0
  ) {
    bundle = bundleFromContinuation(candidate);
    reused = true;
    layerIndex = Math.max(0, LAYER_ORDER.indexOf(candidate.resume_layer));
  }

  let querySet: string[] = [question];
  let stopReason = "";
  let lastDecision: JudgeDecision | null = null;
  let judgedAny = false;
  // Per-layer gather bookkeeping. `gathered` alone only remembers *that* a layer
  // ran, so the judge's improved phrasings could never re-ask it; these two maps
  // bound the re-ask and make an identical one a no-op.
  const gatherCounts = new Map<LayerName, number>();
  const queryUsed = new Map<LayerName, string>();
  let requeries = 0;

  function queryFingerprint(queries: readonly string[]): string {
    return queries.slice(0, options.max_query_variants).join("\u0000");
  }

  async function gatherLayer(
    layer: LayerName,
    queries: readonly string[] = querySet,
    variants: number = options.max_query_variants,
  ): Promise<void> {
    const gathered = await gather(queries, layer, variants);
    bundle = absorb(bundle, gathered.bundle);
    bundle.gathered.add(layer);
    gatherCounts.set(layer, (gatherCounts.get(layer) ?? 0) + 1);
    queryUsed.set(layer, queryFingerprint(querySet));
    if (gathered.coldRefresh) cold = true;
  }

  /**
   * Re-gather the layer the judge just looked at, once, with the phrasings it
   * supplied. A re-gather costs a judge call by construction, so the deadline and
   * the model-call ledger stay the hard bound and this check runs before both the
   * descend and the ledger gate.
   */
  function shouldRequery(layer: LayerName): boolean {
    if (lastDecision === null || lastDecision.sufficient) return false;
    if (lastDecision.next_queries.length === 0) return false;
    if (controller.signal.aborted) return false;
    if (requeries >= MAX_LAYER_REQUERIES) return false;
    if ((gatherCounts.get(layer) ?? 0) !== MAX_LAYER_GATHERS - 1) return false;
    if (queryUsed.get(layer) === queryFingerprint(querySet)) return false;
    if (remaining() <= 0) return false;
    if (ledger.stopReason() !== null) return false;
    return true;
  }

  while (layerIndex < LAYER_ORDER.length) {
    const layer = LAYER_ORDER[layerIndex] as LayerName;
    if (!bundle.gathered.has(layer)) await gatherLayer(layer);
    currentLayers = bundle.layers;

    if (controller.signal.aborted) {
      stopReason = "cancelled";
      break;
    }
    if (remaining() <= 0) {
      stopReason = "deadline_exceeded";
      break;
    }

    let judged = await judgeLayer(layer, bundle);
    if (judged.kind === "stop" && judged.retryable && !retryUsed) {
      retryUsed = true;
      judged = await judgeLayer(layer, bundle, judged.reason);
    }
    if (judged.kind === "stop") {
      stopReason = judged.reason;
      break;
    }
    judgedAny = true;
    lastDecision = judged.decision;

    if (lastDecision.sufficient) {
      const evidence = collectEvidence(lastDecision.evidence_ids, bundle);
      const conflicts = [
        ...new Set([...lastDecision.conflicts, ...findSubjectConflicts(bundle.cards, lastDecision.evidence_ids)]),
      ];
      if (evidence.length === 0) {
        stopReason = "evidence_insufficient";
        break;
      }
      if (conflicts.length > 0) {
        currentLayers = bundle.layers;
        const assembled = assemble({
          status: "conflicted",
          answer: null,
          cards: bundle.cards,
          evidence,
          missing: bundle.missing,
          conflicts,
          next_action: null,
          continuation_id: continuationFor(bundle, layer)?.id ?? null,
        });
        return finish(assembled, continuationFor(bundle, layer), false, bundle.excerpts);
      }
      const answer = lastDecision.answer;
      if (answer === null || answer.trim().length === 0) {
        stopReason = "evidence_insufficient";
        break;
      }
      currentLayers = bundle.layers;
      const assembled = assemble({
        status: "resolved",
        answer,
        cards: bundle.cards,
        evidence,
        missing: bundle.missing,
        conflicts: [],
        next_action: null,
        continuation_id: null,
      });
      // The judge cited a card that has since gone stale: fold the pending
      // events into that same memory. A cited stale card never falls through to
      // the persistence path, which would mint a duplicate topic.
      const citedStale = staleCardInEvidence(bundle.cards, lastDecision.evidence_ids);
      if (citedStale !== null) {
        const staleFreshness = input.store.readFreshness(citedStale.uri, citedStale.revision);
        if (staleFreshness?.revision_mismatch === true) {
          return finish({ ...assembled, result: parseRetrievalResult({ ...assembled.result, freshness: staleFreshness, next_action: `memory_read(uri=${JSON.stringify(citedStale.uri)}) 当前摘要已更新至 r${staleFreshness.head_revision}` }) }, null, false);
        }
      }
      if (input.model !== null && input.model !== undefined && hasRawHistoryEvidence(evidence, bundle.excerpts)) {
        // The caller owns the write boundary: hand back a self-contained write
        // request and return the read result untouched. A later, separately
        // scheduled job runs `persistPendingResolve` on it.
        if (input.defer_persistence === true) {
          pendingPersistence = {
            question,
            scope,
            answer,
            evidence: [...evidence],
            excerpts: [...bundle.excerpts],
            cards: [...bundle.cards],
            request_id: input.request_id,
            session_id: input.session_id,
            call_index: calls.length,
          };
          return finish(assembled, continuationFor(bundle, layer), false, bundle.excerpts);
        }
        const persisted = await persistResolvedMemory({
          store: input.store,
          question,
          scope,
          answer,
          evidence,
          excerpts: bundle.excerpts,
          cards: bundle.cards,
          model: input.model,
          model_id: input.model_id,
          ledger,
          signal: controller.signal,
          remaining_ms: remaining,
          request_id: input.request_id,
          session_id: input.session_id,
          wall_now: wall,
          mono_now: mono,
          call_index: calls.length,
        });
        summaryMs = persisted.persistence.summary_ms;
        persistMs = persisted.persistence.persist_ms;
        if (persisted.call !== null) calls.push(persisted.call);
        persistence = persisted.persistence;
        const patched = parseRetrievalResult({
          ...assembled.result,
          ...persisted.patch,
          missing: [...new Set([...assembled.result.missing, ...persisted.missing])],
          budget_used: {
            elapsed_ms: mono() - started,
            model_calls: ledger.model_calls,
            tokens_in: ledger.tokens_in,
            tokens_out: ledger.tokens_out,
            cost_usd: ledger.cost_usd,
          },
        });
        return finish({ ...assembled, result: patched }, continuationFor(bundle, layer), false, bundle.excerpts);
      }
      return finish(assembled, continuationFor(bundle, layer), false, bundle.excerpts);
    }

    // Not sufficient. A model-visible disagreement is recorded as a gap.
    for (const conflict of lastDecision.conflicts) bundle.missing.push(`conflict:${conflict}`);
    // The model expands the query; it never replaces the caller's own words.
    // The original question stays first so a lexical hit on the literal term is
    // still found in every lower layer.
    if (lastDecision.next_queries.length > 0) {
      const variants = [question, ...lastDecision.next_queries].filter(
        (value, index, all) => value.trim().length > 0 && all.indexOf(value) === index,
      );
      querySet = variants.slice(0, options.max_query_variants);
    }
    for (const uri of lastDecision.read_uris) readBody(uri, bundle);
    // The judge found the layer's candidates unusable and named better phrasings.
    // Re-ask this same layer with those phrasings, merging into what it already
    // saw, then judge again before deciding whether to descend. Without this the
    // new phrasings only ever reach lower layers and a memory sitting in the
    // layer already searched is never a candidate.
    if (shouldRequery(layer)) {
      requeries += 1;
      const fragments = expandPhrasings(lastDecision.next_queries).slice(0, MAX_REQUERY_VARIANTS);
      // The re-ask gets its own variant budget: `max_query_variants` bounds the
      // caller's question and the descent, not the recall pass that exists to
      // spend one more cheap lookup per concept the judge named.
      await gatherLayer(layer, [question, ...fragments], 1 + fragments.length);
      currentLayers = bundle.layers;
      continue;
    }
    if (!lastDecision.descend || layerIndex + 1 >= LAYER_ORDER.length) {
      stopReason = "evidence_insufficient";
      break;
    }
    if (ledger.stopReason() !== null) {
      stopReason = ledger.stopReason() ?? "model_call_cap";
      break;
    }
    layerIndex += 1;
  }

  if (stopReason.length === 0 && ledger.stopReason() !== null) stopReason = ledger.stopReason() ?? "model_call_cap";
  if (stopReason.length === 0) stopReason = judgedAny ? "evidence_insufficient" : "no_candidates";
  return finish(stopAssembly(stopReason, bundle), continuationFor(bundle, lastLayerOf(bundle)), false, bundle.excerpts);

  function readBody(uri: string, current: Bundle): void {
    const card = current.cards.find((entry) => entry.uri === uri);
    if (card === undefined) return;
    if (current.read_bodies.some((entry) => entry.uri === uri)) return;
    try {
      const read = readMemoryResult({ store: input.store, uri: card.uri });
      if (read.result.status !== "resolved" || read.result.memory_summary === null) return;
      current.read_bodies.push({ uri, body: read.result.memory_summary });
    } catch {
      // A failed read is a gap, not a failure of the whole resolve.
    }
  }
}
