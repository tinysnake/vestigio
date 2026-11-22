/**
 * Legacy pi tool text, kept byte-compatible where it matters.
 *
 * The daemon returns structured results, but the tools an agent reads are text,
 * and the text is the contract a session was trained on. These renderers are
 * ported from `packages/pi-extension/src/tools.ts` unchanged in behaviour so a
 * daemon-served `memory_search` reads exactly like a local one. The duplication
 * is deliberate: the daemon must not depend on the pi extension, and the
 * extension must not depend on the daemon. A later change can lift these into
 * `@vestigio/core` once both consumers import from there.
 */

import type { Freshness, FreshnessBrief, RetrievalResult, StaleEventSummary } from "@vestigio/core";
import type { LayeredSearchOutcome, MemoryReadOutcome } from "@vestigio/core/retrieval";
import type { ResolveOutcome, SearchRecovery } from "@vestigio/core/resolver";

export type ResolvePublication = {
  published: boolean;
  reason: string | null;
  nav_text: string | null;
};

/**
 * How many raw-history snippets a search prints. The layer already fetched the
 * bodies and capped them by bytes, so showing the strongest few usually ends a
 * recall question here; the rest stay as pointers for `memory_resolve`.
 */
const SEARCH_SNIPPET_LIMIT = 3;

/**
 * A short, readable pointer. Obelisk message ids already begin with their
 * session id, so printing both would repeat it twice on every line.
 */
function snippetRef(ref: { session_id: string; message_id: string }): string {
  const prefix = `${ref.session_id}:`;
  const suffix = ref.message_id.startsWith(prefix) ? ref.message_id.slice(prefix.length) : ref.message_id;
  const short = suffix.length > 32 ? `${suffix.slice(0, 32)}…` : suffix;
  return `${ref.session_id.slice(0, 24)}…/${short}`;
}

export function staleCards(result: RetrievalResult): Array<{ memory_id: string; head_revision: number; pending_count: number }> {
  return result.cards
    .filter((card) => card.freshness?.is_stale === true)
    .map((card) => ({
      memory_id: card.memory_id,
      head_revision: card.freshness?.head_revision ?? card.revision,
      pending_count: card.freshness?.pending_count ?? 0,
    }));
}

export function staleMarker(brief: FreshnessBrief | undefined): string | null {
  if (brief === undefined || brief.is_stale !== true) return null;
  return `stale: 未吸收 ${brief.pending_count} 条后续证据 (head r${brief.head_revision})`;
}

export function renderPendingEvent(event: StaleEventSummary): string[] {
  const lines = [
    `  - event ${event.event_id} observed r${event.observed_revision} (${event.producer}): ${event.reason}`,
    `    excerpt: ${event.excerpt}${event.excerpt_truncated ? " …" : ""}`,
  ];
  if (event.sources.length > 0) {
    const anchors = event.sources
      .map(
        (source) =>
          `${source.session_id}/${source.message_id}${source.locator === null ? "" : ` (${source.locator})`}`,
      )
      .join(", ");
    const more = event.sources_truncated ? ` (+${event.source_count - event.sources.length} more)` : "";
    lines.push(`    sources: ${anchors}${more}`);
  }
  return lines;
}

export function renderFreshness(freshness: Freshness | undefined): string[] {
  if (freshness === undefined) return [];
  const state = freshness.is_stale
    ? `STALE pending=${freshness.pending_count} head=r${freshness.head_revision}`
    : `current head=r${freshness.head_revision}`;
  const mismatch = freshness.revision_mismatch
    ? ` (delivered r${freshness.delivered_revision}, head r${freshness.head_revision})`
    : "";
  const lines = [`freshness: ${state}${mismatch}`];
  for (const event of freshness.pending) lines.push(...renderPendingEvent(event));
  if (freshness.pending_truncated) {
    lines.push(`  … ${freshness.pending_count - freshness.pending.length} more pending event(s)`);
  }
  return lines;
}

export function renderSearch(
  query: string,
  projectId: string,
  outcome: LayeredSearchOutcome,
  historyNote: string | null,
  recovery?: SearchRecovery,
): string {
  const result: RetrievalResult = outcome.result;
  const lines: string[] = [];
  lines.push(
    `memory_search(${JSON.stringify(query)}) -> ${result.status} | ${result.cards.length} card(s) | project=${projectId}`,
  );
  if (result.cards.length === 0) lines.push("(no matching memory)");
  if (recovery?.status === "recovered") {
    lines.push("recovery: returned cards checked against the original question");
  } else if (recovery?.status === "not_found") {
    lines.push("recovery: no relevant card found after reformulating and checking partial matches. Try memory_resolve for broader evidence.");
  } else if (recovery?.status === "unavailable") {
    lines.push("recovery: could not complete. Try a short, specific keyword query.");
  } else if (recovery?.status === "skipped" && result.cards.length === 0 && outcome.history.length === 0) {
    lines.push("recovery: skipped. Try the first page of a specific query.");
  }
  result.cards.forEach((card, index) => {
    lines.push(
      `${index + 1}. [${card.state} r${card.revision}] ${card.uri} score=${card.score} hit=${card.hit_count} access=${card.access_count}`,
    );
    lines.push(`   ${card.title}`);
    lines.push(`   ${card.nav_text}`);
    const marker = staleMarker(card.freshness);
    if (marker !== null) lines.push(`   ${marker}`);
  });
  const shown = outcome.history.slice(0, SEARCH_SNIPPET_LIMIT);
  if (shown.length > 0) {
    lines.push(`history snippets (${outcome.history.length}):`);
    for (const excerpt of shown) {
      lines.push(
        `  ${snippetRef(excerpt.source_ref)}: ${excerpt.excerpt}${excerpt.truncated ? " …" : ""}`,
      );
    }
    const rest = outcome.history.length - shown.length;
    if (rest > 0) lines.push(`  … ${rest} more snippet(s); memory_resolve reads the full window`);
  }
  lines.push(
    `layers: ${outcome.layers.map((layer) => `${layer.layer}=${layer.status}(${layer.emitted}/${layer.candidates})`).join(" ")}`,
  );
  if (result.missing.length > 0) lines.push(`missing: ${result.missing.join("; ")}`);
  if (result.conflicts.length > 0) lines.push(`conflicts: ${result.conflicts.join("; ")}`);
  if (result.next_action !== null) lines.push(`next: ${result.next_action}`);
  if (historyNote !== null) lines.push(`history: skipped (${historyNote})`);
  return lines.join("\n");
}

export function renderResolve(
  question: string,
  projectId: string,
  outcome: ResolveOutcome,
  modelNote: string | null,
  historyNote: string | null,
  publication: ResolvePublication | null = null,
): string {
  const result: RetrievalResult = outcome.result;
  const { measured } = outcome;
  const lines: string[] = [];
  lines.push(
    `memory_resolve(${JSON.stringify(question)}) -> ${result.status} | ${result.cards.length} card(s) | ${outcome.history.length} excerpt(s) | project=${projectId}`,
  );
  lines.push(
    `layers: ${outcome.layers.map((layer) => `${layer.layer}=${layer.status}(${layer.emitted}/${layer.candidates})`).join(" ")}`,
  );
  lines.push(
    `budget: calls=${measured.model_calls} in=${measured.tokens_in} out=${measured.tokens_out} cost=${measured.cost_usd === null ? "n/a" : `$${measured.cost_usd.toFixed(6)}`} elapsed=${Math.round(measured.elapsed_ms)}ms gather=${Math.round(measured.gather_ms)}ms model=${Math.round(measured.model_ms)}ms${measured.cold ? " cold" : ""}`,
  );
  if (outcome.calls.length > 0) {
    lines.push(
      `model calls: ${outcome.calls.map((call) => `#${call.index} ${call.layer} ${call.outcome} ${Math.round(call.elapsed_ms)}ms`).join("; ")}`,
    );
  }
  if (measured.degraded) lines.push(`degraded: zero-LLM layered search${modelNote === null ? "" : ` (${modelNote})`}`);
  if (result.cards.length === 0) lines.push("(no matching memory)");
  result.cards.forEach((card, index) => {
    lines.push(
      `${index + 1}. [${card.state} r${card.revision}] ${card.uri} score=${card.score} hit=${card.hit_count} access=${card.access_count}`,
    );
    lines.push(`   ${card.title}`);
    lines.push(`   ${card.nav_text}`);
    const marker = staleMarker(card.freshness);
    if (marker !== null) lines.push(`   ${marker}`);
  });
  for (const excerpt of outcome.history) {
    lines.push(`history ${excerpt.source_ref.session_id}/${excerpt.source_ref.message_id}: ${excerpt.excerpt}`);
  }
  if (result.evidence.length > 0) {
    lines.push(`evidence: ${result.evidence.map((ref) => `${ref.provider}/${ref.source_instance}`).join(", ")}`);
  }
  if (outcome.persistence !== null) {
    const persistence = outcome.persistence;
    lines.push(
      `persistence: ${persistence.status} stage=${persistence.stage} nav=${persistence.navigation_status}` +
        `${persistence.target === null ? "" : ` target=${persistence.target.memory_uri} r${persistence.target.revision}`}` +
        `${persistence.reused ? " (reused existing revision)" : ""}` +
        `${persistence.delivery_recorded ? " access_recorded" : ""}`,
    );
  }
  if (result.memory_summary !== null && result.memory_uri !== null) {
    lines.push(`memory: ${result.memory_uri} revision ${result.revision ?? "?"}`);
    lines.push("long summary:");
    lines.push(result.memory_summary);
  }
  if (publication !== null) {
    lines.push(
      publication.published
        ? `nav: ${publication.nav_text ?? ""} (published; findable by memory_search)`
        : `nav pending: ${publication.reason ?? "nav_not_published"} (not findable by memory_search yet)`,
    );
  }
  if (result.answer !== null) lines.push(`answer: ${result.answer}`);
  if (result.conflicts.length > 0) lines.push(`conflicts: ${result.conflicts.join("; ")}`);
  if (result.missing.length > 0) lines.push(`missing: ${result.missing.join("; ")}`);
  if (result.next_action !== null) lines.push(`next: ${result.next_action}`);
  if (historyNote !== null) lines.push(`history: skipped (${historyNote})`);
  return lines.join("\n");
}

export function renderRead(
  uri: string,
  outcome: MemoryReadOutcome,
  deferredPending: number | null = null,
): string {
  const result: RetrievalResult = outcome.result;
  if (result.status !== "resolved") {
    const lines = [`memory_read(${uri}) -> ${result.status}`];
    if (result.missing.length > 0) lines.push(`missing: ${result.missing.join("; ")}`);
    if (result.next_action !== null) lines.push(`next: ${result.next_action}`);
    return lines.join("\n");
  }
  const body = result.memory_summary ?? "";
  const lines = [
    `memory_read(${uri}) -> resolved | revision=${result.revision ?? "?"}`,
    `title: ${result.cards[0]?.title ?? "(untitled)"}`,
  ];
  if (deferredPending !== null) {
    lines.push(`repair: deferred (repaired when this session ends; ${deferredPending} pending event(s))`);
  }
  lines.push(...renderFreshness(result.freshness));
  lines.push(`long summary:`, body);
  if (result.evidence.length > 0) {
    lines.push(`sources: ${result.evidence.map((ref) => `${ref.provider}/${ref.source_instance}`).join(", ")}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------- mark_stale guardrails */

/**
 * Value-looking tokens in a reason: numbers with optional separators, units or
 * a percent sign, clock and date forms, weekdays and slash-separated paths.
 * The grammar is deliberately wide, because the guard only has to notice a
 * reason whose values appear in no evidence text at all.
 */
const REASON_VALUE =
  /(?:\d[\d,_]*(?:[:.]\d+)*)\s*(?:%|[kK]|万|亿|MB|GB|KB|ms|毫秒|秒|分钟|小时|天|次|个|人|元)?|周[一二三四五六日天]|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/gu;

function flattenForCompare(text: string): string {
  return text
    .replace(/[０-９]/gu, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/[\s,_]/gu, "")
    .toLowerCase();
}

function containsToken(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // The boundaries stop `16` from matching inside `2016`.
  return new RegExp(`(?<![0-9a-z])${escaped}(?![0-9a-z])`, "u").test(haystack);
}

/**
 * The values a reason names that its evidence does not carry, or null when the
 * reason is grounded. A reason with no value token is qualitative and passes,
 * and one carried value is enough. A reason that names values and matches none
 * of them is a report with no basis, and it is rejected before it becomes a
 * pending event every later session has to read.
 */
export function unanchoredValues(reason: string, evidence: string): string[] | null {
  const named: string[] = [];
  for (const match of reason.matchAll(REASON_VALUE)) {
    const token = match[0];
    named.push(token);
    const numeric = /^\d[\d,_]*(?:[:.]\d+)*/u.exec(token)?.[0];
    if (numeric !== undefined && numeric !== token) named.push(numeric);
  }
  if (named.length === 0) return null;
  const haystack = flattenForCompare(evidence);
  return named.some((token) => containsToken(haystack, flattenForCompare(token))) ? null : named;
}
