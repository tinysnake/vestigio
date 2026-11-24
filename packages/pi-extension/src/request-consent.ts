/**
 * Save-directive classification and evidence resolution for a proactive memory
 * request.
 *
 * There is deliberately no `confirmed` argument on the tool and no dialog: the
 * agent decides when to request a write, and the operator's own words are the
 * evidence. This module only does what code can check —
 *   - classify the real input, so a bare "remember this" is not treated as a
 *     self-contained command, and
 *   - resolve the model's ids/quotes against the real branch, refusing every
 *     unknown, future or non-operator source.
 *
 * A request that is limited to this session is refused because Vestigio
 * has only durable memories.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { nonWhitespaceCodePointCount } from "@vestigio/core";
import type { Scope, SourceRef } from "@vestigio/core";
import type { MemoryRequestEvidence as Evidence } from "@vestigio/core/requests";
import { sessionEntryText, sourceRefForEntry, stripInjectedNote, type EntrySourceContext } from "./session-source.js";

export const MAX_REQUEST_EVIDENCE = 8;
export const MAX_REQUEST_EXCERPT_POINTS = 2000;
export const MAX_REQUEST_INTENT_CHARS = 500;

export type SaveDirectiveKind = "none" | "negated" | "temporary" | "self_contained" | "deictic";

export type SaveDirective = {
	kind: SaveDirectiveKind;
	scope_hint: "project" | "global" | null;
	payload: string;
};

const DIRECTIVE_ZH = /记住|记一下|记下来|记到记忆|记入记忆|存到记忆|保存到记忆|写入记忆|记录到记忆/u;
const DIRECTIVE_EN =
	/\b(?:remember|memorize)\b|\b(?:save|store|write|keep)\b[^\n.]{0,40}\b(?:memory|memories)\b|\bmake a note\b/iu;
const TEMPORARY =
	/\b(?:this|current|the)\s+session\s+only\b|\bfor\s+this\s+session\b|\bsession[- ]only\b|\btemporar(?:y|ily)\b|\bfor\s+now\b|\bjust\s+for\s+now\b|这次先|本次先|这回先|临时|暂时|仅限这次|仅限本次|就这一次|会话内|当前会话/u;
const NEGATED_TEMPORARY =
	/不是\s*(?:临时|暂时|仅限这次|仅限本次|一次性的?)|并非\s*(?:临时|暂时|仅限这次|仅限本次|一次性的?)|不是\s*只(?:有|是)?\s*(?:这次|本次)|not\s+temporar(?:y|ily)|not\s+(?:just\s+)?for\s+(?:this|now)/iu;
const NEGATED_SAVE =
	/(?:不要|不用|不必|无需|别|甭)\s*(?:再)?\s*(?:记住|记下|记一下|记到|保存|写入|存入)|\b(?:do\s+not|don't|dont|never|no\s+need\s+to)\b[^\n.]{0,24}\b(?:remember|memorize|save|store|write)\b/iu;
const GLOBAL_SCOPE =
	/\bglobal(?:ly)?\b|\bacross\s+(?:all\s+)?projects\b|\ball\s+projects\b|\ball\s+repos\b|全局|所有项目|跨项目|所有仓库/u;
const PROJECT_SCOPE =
	/\bthis\s+project\b|\bthis\s+repo(?:sitory)?\b|\bcurrent\s+project\b|这个项目|本项目|当前项目|这个仓库|本仓库/u;
const DEICTIC_ONLY =
	/^(?:this|that|it|the above|this one|these|those|这个|那个|它|上面这个|这些|那些|刚才那个|刚刚那个)[\s。.!！?？]*$/iu;
const LEADING_FILLER = /^(?:请|帮我|帮忙|麻烦|please|kindly|can you|could you)\s*/iu;
const DIRECTIVE_PREFIX = /^(?:记住|记一下|记下来|记到记忆|记入记忆|存到记忆|保存到记忆|写入记忆|记录到记忆)(?:一下)?\s*[:：,，]?\s*/u;
const DIRECTIVE_PREFIX_EN = /^(?:remember(?:\s+that)?|memorize|make a note(?:\s+that)?)\s*[:：,，]?\s*/iu;
const SAVE_TO_MEMORY = /^(?:save|store|write|keep)\s+(?:this|that|it)?\s*(?:to|in|into)\s+(?:your\s+)?memor(?:y|ies)\s*[:：,，]?\s*/iu;
const TRAILING_TO_MEMORY = /\s*(?:to|in|into)\s+(?:your\s+)?memor(?:y|ies)\s*$/iu;

/** Classify the real input. A direct command is only self-contained if it carries the payload. */
export function classifySaveDirective(text: string): SaveDirective {
	const raw = text.trim();
	const hasZh = DIRECTIVE_ZH.test(raw);
	const hasEn = DIRECTIVE_EN.test(raw);
	if (!hasZh && !hasEn) return { kind: "none", scope_hint: null, payload: "" };

	const global = GLOBAL_SCOPE.test(raw);
	const project = PROJECT_SCOPE.test(raw);
	const scopeHint = global && !project ? "global" : project && !global ? "project" : null;
	if (NEGATED_SAVE.test(raw)) return { kind: "negated", scope_hint: scopeHint, payload: "" };
	if (TEMPORARY.test(raw.replace(NEGATED_TEMPORARY, ""))) {
		return { kind: "temporary", scope_hint: scopeHint, payload: "" };
	}

	let payload = raw.replace(LEADING_FILLER, "");
	if (hasZh) payload = payload.replace(DIRECTIVE_PREFIX, "");
	if (hasEn) payload = payload.replace(DIRECTIVE_PREFIX_EN, "").replace(SAVE_TO_MEMORY, "");
	payload = payload.replace(TRAILING_TO_MEMORY, "").replace(/^[\s:：,，。.!！?？]+/u, "").trim();
	if (DEICTIC_ONLY.test(payload)) return { kind: "deictic", scope_hint: scopeHint, payload };
	if (nonWhitespaceCodePointCount(payload) < 3) return { kind: "deictic", scope_hint: scopeHint, payload };
	return { kind: "self_contained", scope_hint: scopeHint, payload };
}

function clip(text: string, max: number): string {
	const points = [...text];
	return points.length <= max ? text : `${points.slice(0, Math.max(1, max - 1)).join("")}…`;
}

function isUserEntry(entry: SessionEntry): boolean {
	if (entry.type !== "message") return false;
	const message = entry.message as { role?: string };
	return message.role === "user";
}

function entryIndex(entries: readonly SessionEntry[], id: string): number {
	return entries.findIndex((entry) => entry.id === id);
}

function normalizedForQuote(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

export type EvidenceFailure = { ok: false; reason: string };
export type EvidenceOk = { ok: true; evidence: Evidence[] };
export type EvidenceResult = EvidenceOk | EvidenceFailure;

/**
 * Resolve model-supplied ids/quotes against the real branch. Every failure is
 * closed: an unknown id or a quote that is not in this branch never degrades to
 * "use what you have". With no ids or quotes, evidence defaults to the newest
 * real operator entry so a proactive request still carries the operator's own
 * words.
 */
export function resolveRequestEvidence(input: {
	entries: readonly SessionEntry[];
	context: EntrySourceContext;
	ids: readonly string[];
	quotes: readonly string[];
}): EvidenceResult {
	const cutoff = input.entries.length - 1;
	if (cutoff < 0) return { ok: false, reason: "evidence_required" };

	const selected = new Map<string, SessionEntry>();
	for (const id of input.ids) {
		const index = entryIndex(input.entries, id);
		if (index < 0 || index > cutoff) return { ok: false, reason: `unknown_or_future_source:${id}` };
		const entry = input.entries[index];
		if (entry === undefined || sessionEntryText(entry) === null) {
			return { ok: false, reason: `source_has_no_text:${id}` };
		}
		selected.set(entry.id, entry);
	}
	for (const quote of input.quotes) {
		const wanted = normalizedForQuote(quote);
		if (wanted.length < 4) return { ok: false, reason: "quote_too_short" };
		let found: SessionEntry | null = null;
		for (let index = cutoff; index >= 0; index -= 1) {
			const entry = input.entries[index];
			// Only the operator's own messages can authorize a quote. Searching
			// assistant or tool entries would let the model's own tool call, or its
			// note about a memory, become the evidence for itself.
			if (entry === undefined || !isUserEntry(entry)) continue;
			const text = sessionEntryText(entry);
			if (text === null) continue;
			// The extension's own memory note is not operator evidence. Searching
			// raw text would let a quote copied from the injected note resolve to
			// the current entry and authorize itself.
			const evidenceText = stripInjectedNote(text);
			if (evidenceText.includes(quote) || normalizedForQuote(evidenceText).includes(wanted)) {
				found = entry;
				break;
			}
		}
		if (found === null) return { ok: false, reason: "quote_not_found_in_branch" };
		selected.set(found.id, found);
	}
	// No model-supplied evidence: default to the newest real operator entry at
	// or before the cutoff, so the tool can offer a question instead of failing
	// closed. This widens no other path.
	if (input.ids.length === 0 && input.quotes.length === 0) {
		for (let index = cutoff; index >= 0; index -= 1) {
			const entry = input.entries[index];
			if (entry === undefined || !isUserEntry(entry)) continue;
			if (sessionEntryText(entry) === null) continue;
			selected.set(entry.id, entry);
			break;
		}
	}
	if (selected.size === 0) return { ok: false, reason: "evidence_required" };
	if (selected.size > MAX_REQUEST_EVIDENCE) {
		return { ok: false, reason: `too_many_evidence_sources:${selected.size}` };
	}

	const evidence: Evidence[] = [];
	for (const entry of selected.values()) {
		const text = sessionEntryText(entry);
		if (text === null) continue;
		const source: SourceRef | null = sourceRefForEntry(entry, input.context);
		if (source === null) continue;
		evidence.push({ source, excerpt: clip(stripInjectedNote(text).trim(), MAX_REQUEST_EXCERPT_POINTS) });
	}
	if (evidence.length === 0) return { ok: false, reason: "evidence_required" };
	return { ok: true, evidence };
}

export function requestedScope(input: {
	requested: "project" | "global" | undefined;
	directive: SaveDirective;
	project_id: string;
}): Scope {
	const requested = input.requested ?? input.directive.scope_hint ?? "project";
	return requested === "global" ? { kind: "global" } : { kind: "project", project_id: input.project_id };
}
