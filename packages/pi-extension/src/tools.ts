/**
 * The two memory tools the agent uses.
 *
 * `memory_search` runs the layered base search (Active, then Archived, then the
 * optional read-only history layer), `memory_read` returns one full medium
 * summary by URI, and `memory_resolve` runs the PR-06 budgeted model-backed
 * layered retrieval (zero-LLM candidates, model judgment between layers, a
 * stated gap instead of prose when the evidence is insufficient).
 *
 * All three are bounded: card counts come from `layeredSearch`'s own caps, the
 * short nav text is contract-capped at 200 code points, the medium body is
 * contract-capped at 1000 non-whitespace code points, and `memory_resolve`
 * never exceeds its frozen call/token/evidence budget. An unknown URI is a
 * not-found, never a synthesized memory; `memory_resolve` degrades to the
 * zero-LLM search when no backend is configured rather than inventing one.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { ValidationError, splitMemoryUri } from "@vestigio/core";
import type { Freshness, FreshnessBrief, MemoryUri, RetrievalResult, SourceRef, StaleEventSummary } from "@vestigio/core";
import type { LayeredSearchOutcome, MemoryReadOutcome } from "@vestigio/core/retrieval";
import { layeredSearch, readMemoryResult } from "@vestigio/core/retrieval";
import type { ResolveOutcome, ModelPort, PersistenceOutcome } from "@vestigio/core/resolver";
import { RESOLVE_MAX_SESSION_RESOLVES, resolveMemory } from "@vestigio/core/resolver";
import type { MemoryStore } from "@vestigio/core/storage";
import { recordMemoryRead, recordSearchHits } from "@vestigio/core/hotspots";
import { errorText, nowIso, type VestigioState } from "./state.js";
import { hashQuery } from "./decision-log.js";
import { publishRevision } from "./read-repair.js";
import { stripInjectedNote } from "./stale-detector.js";
import { sessionEntryText, sourceRefForEntry } from "./session-source.js";
import { markStaleParameters, readParameters, resolveParameters, searchParameters } from "./tool-parameters.js";

export function registerMemoryTools(pi: ExtensionAPI, state: VestigioState): void {
	pi.registerTool({
		name: "memory_search",
		label: "Memory search",
		description:
			"Search what you already know about this project and this machine: recorded memories plus, by default, the indexed past sessions. Use it before answering a recall question (a host, an account, a port, a config value, a past decision or fix) and before grepping files or session logs. Returns bounded navigation cards (memory URI, title, short summary); use memory_read for the full summary.",
		parameters: searchParameters,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const store = state.ensureStore();
			if (store === null) {
				return text(`memory_search unavailable: ${state.storeFailureReason ?? "no store configured"}`);
			}
			const projectId = state.projectId(ctx.cwd);
			const inputId = `tool:${toolCallId}`;
			const at = nowIso();
			const wantHistory = params.include_history !== false;
			const history = wantHistory ? await state.historyPort() : null;
			const outcome = await layeredSearch({
				store,
				query: params.query,
				scope: { kind: "project", project_id: projectId },
				limit: params.limit,
				include_archived: params.include_archived,
				include_history: history !== null,
				include_history_read: false,
				history: history ?? undefined,
			});
			let recorded = 0;
			try {
				recorded = recordSearchHits({
					store,
					session_id: state.currentSessionId,
					input_id: inputId,
					at,
					hits: outcome.result.cards.map((card) => ({ memory_id: card.memory_id, revision: card.revision })),
				});
			} catch (error) {
				state.writeDecision({
					ts: at,
					kind: "error",
					status: "search_hits_failed",
					session_id: state.currentSessionId,
					error: errorText(error),
				});
			}
			const note = wantHistory && history === null ? state.historySkipReason() : null;
			for (const card of outcome.result.cards) state.noteMemorySeen(card.memory_id);
			state.writeDecision({
				ts: at,
				kind: "tool_search",
				status: outcome.result.status,
				session_id: state.currentSessionId,
				project_id: projectId,
				input_id: inputId,
				query_hash: hashQuery(params.query),
				query_chars: Array.from(params.query).length,
				// Which memories this call actually put in front of the agent.
				memory_ids: outcome.result.cards.map((card) => card.memory_id),
				detail: `cards=${outcome.result.cards.length} hits=${recorded}`,
			});
			return {
				content: [{ type: "text", text: renderSearch(params.query, projectId, outcome, note) }],
				details: {
					status: outcome.result.status,
					project_id: projectId,
					cards: outcome.result.cards,
					layers: outcome.layers,
					missing: outcome.result.missing,
					conflicts: outcome.result.conflicts,
					next_action: outcome.result.next_action,
					history_note: note,
					hits_recorded: recorded,
					stale_cards: staleCards(outcome.result),
					measured: outcome.measured,
				},
			};
		},
	});

	pi.registerTool({
		name: "memory_resolve",
		label: "Memory resolve",
		description:
			"Answer a recall question from the layered memory: recorded memories first, then the raw session history. Use it when one memory_search was not enough. Budgeted and model-backed: walks Active then Archived then the raw session history, lets the configured model judge whether the evidence answers the question, and stops as soon as it does. When the answer rests on raw history it also writes one 500-660 character medium summary, returns that exact body with its URI and revision, and generates the short nav before the tool returns, so the memory is findable by memory_search immediately; if that nav step fails, the memory stays unsearchable until `vestigio jobs run`. It never edits files or widens the project scope. Costs a few model calls when the store alone is not enough.",
		parameters: resolveParameters,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const store = state.ensureStore();
			if (store === null) {
				return text(`memory_resolve unavailable: ${state.storeFailureReason ?? "no store configured"}`);
			}
			const projectId = state.projectId(ctx.cwd);
			const inputId = `tool:${toolCallId}`;
			const at = nowIso();
			const model = state.modelPort();
			const modelNote = model === null ? state.modelSkipReason() : null;
			const wantHistory = params.include_history !== false;
			const history = wantHistory ? await state.historyPort() : null;
			const usedBefore = state.resolveCountUsed();
			const outcome = await resolveMemory({
				store,
				question: params.question,
				scope: { kind: "project", project_id: projectId },
				model,
				history,
				signal,
				session_resolves_used: usedBefore,
				continuation: state.lastContinuation,
			});
			state.noteResolveUsed();
			state.lastContinuation = outcome.continuation;
			let recorded = 0;
			try {
				recorded = recordSearchHits({
					store,
					session_id: state.currentSessionId,
					input_id: inputId,
					at,
					hits: outcome.result.cards.map((card) => ({ memory_id: card.memory_id, revision: card.revision })),
				});
			} catch (error) {
				state.writeDecision({
					ts: at,
					kind: "error",
					status: "resolve_hits_failed",
					session_id: state.currentSessionId,
					error: errorText(error),
				});
			}
			const historyNote = wantHistory && history === null ? state.historySkipReason() : null;
			for (const card of outcome.result.cards) state.noteMemorySeen(card.memory_id);
			state.writeDecision({
				ts: at,
				kind: "tool_resolve",
				status: outcome.result.status,
				session_id: state.currentSessionId,
				project_id: projectId,
				input_id: inputId,
				query_hash: hashQuery(params.question),
				query_chars: Array.from(params.question).length,
				memory_ids: outcome.result.cards.map((card) => card.memory_id),
				detail: `calls=${outcome.measured.model_calls} degraded=${outcome.measured.degraded} hits=${recorded}`,
			});
			// A resolve that saved has a memory the store cannot search yet. Publish
			// it here, inside this tool call's deadline, instead of leaving the agent
			// with a body that the very next memory_search cannot find.
			const publication = await publishSavedResult({
				state,
				store,
				project_id: projectId,
				at,
				model,
				signal,
				result: outcome.result,
				persistence: outcome.persistence,
			});
			return {
				content: [
					{ type: "text", text: renderResolve(params.question, projectId, outcome, modelNote, historyNote, publication) },
				],
				details: {
					status: outcome.result.status,
					project_id: projectId,
					cards: outcome.result.cards,
					layers: outcome.layers,
					history: outcome.history,
					calls: outcome.calls,
					measured: outcome.measured,
					degraded: outcome.measured.degraded,
					degraded_reason: outcome.measured.degraded ? (modelNote ?? outcome.result.missing[0] ?? null) : null,
					budget_used: outcome.result.budget_used,
					continuation_id: outcome.continuation?.id ?? null,
					missing: outcome.result.missing,
					conflicts: outcome.result.conflicts,
					next_action: outcome.result.next_action,
					history_note: historyNote,
					hits_recorded: recorded,
					resolve_budget: RESOLVE_MAX_SESSION_RESOLVES,
					persistence: outcome.persistence,
					memory_summary: outcome.result.memory_summary,
					memory_uri: outcome.result.memory_uri,
					revision: outcome.result.revision,
					persistence_status: outcome.result.persistence_status,
					navigation_status: outcome.result.navigation_status,
					freshness: outcome.result.freshness ?? null,
					stale_cards: staleCards(outcome.result),
				},
			};
		},
	});

	pi.registerTool({
		name: "memory_read",
		label: "Memory read",
		description:
			"Read the full long (medium) summary of one memory by URI. Use the URI from memory_search or from a hotspot note.",
		parameters: readParameters,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const store = state.ensureStore();
			if (store === null) {
				return text(`memory_read unavailable: ${state.storeFailureReason ?? "no store configured"}`);
			}
			let ids: { storeId: string; memoryId: string };
			try {
				ids = splitMemoryUri(params.uri);
			} catch (error) {
				const reason = error instanceof ValidationError ? error.message : errorText(error);
				return text(`memory_read rejected the URI: ${reason}`);
			}
			if (ids.storeId !== store.storeId) {
				return text(`memory_read refused: ${params.uri} belongs to store ${ids.storeId}, not ${store.storeId}.`);
			}
			const uri = params.uri as MemoryUri;
			const at = nowIso();
			const projectId = state.projectId(ctx.cwd);
			let outcome = readMemoryResult({ store, uri, revision: params.revision });
			// A read never repairs: the stored body is delivered as-is and the
			// pending events are folded in by the `agent_end` pass.
			let deferredPending: number | null = null;
			if (
				params.revision === undefined &&
				outcome.result.status === "resolved" &&
				outcome.result.freshness !== undefined &&
				outcome.result.freshness.is_stale
			) {
				deferredPending = outcome.result.freshness.pending.filter((event) => event.event_id.length > 0).length;
			}
			state.noteMemorySeen(ids.memoryId);
			let recorded: { recorded: boolean; membership: boolean } | null = null;
			if (outcome.result.status === "resolved" && outcome.result.revision !== null) {
				const activity = safeActivitySeq(store, projectId);
				try {
					recorded = recordMemoryRead({
						store,
						project_id: projectId,
						session_id: state.currentSessionId,
						input_id: `tool:${toolCallId}`,
						at,
						memory_id: ids.memoryId,
						revision: outcome.result.revision,
						activity_seq: activity,
					});
				} catch (error) {
					state.writeDecision({
						ts: at,
						kind: "error",
						status: "read_access_failed",
						session_id: state.currentSessionId,
						error: errorText(error),
					});
				}
			}
			state.writeDecision({
				ts: at,
				kind: "tool_read",
				status: outcome.result.status,
				session_id: state.currentSessionId,
				project_id: projectId,
				input_id: `tool:${toolCallId}`,
				memory_ids: [ids.memoryId],
				detail: `uri=${params.uri} recorded=${recorded?.recorded ?? false}`,
			});
			return {
				content: [{ type: "text", text: renderRead(params.uri, outcome, deferredPending) }],
				details: {
					status: outcome.result.status,
					memory_uri: outcome.memory_uri,
					revision: outcome.result.revision,
					persistence_status: outcome.result.persistence_status,
					missing: outcome.result.missing,
					conflicts: outcome.result.conflicts,
					next_action: outcome.result.next_action,
					access_recorded: recorded?.recorded ?? false,
					freshness: outcome.result.freshness ?? null,
					measured: outcome.measured,
				},
			};
		},
	});

	registerStaleTools(pi, state);
}

function staleCards(result: RetrievalResult): Array<{ memory_id: string; head_revision: number; pending_count: number }> {
	return result.cards
		.filter((card) => card.freshness?.is_stale === true)
		.map((card) => ({
			memory_id: card.memory_id,
			head_revision: card.freshness?.head_revision ?? card.revision,
			pending_count: card.freshness?.pending_count ?? 0,
		}));
}

function staleMarker(brief: FreshnessBrief | undefined): string | null {
	if (brief === undefined || brief.is_stale !== true) return null;
	return `stale: 未吸收 ${brief.pending_count} 条后续证据 (head r${brief.head_revision})`;
}

function sessionFileOf(sessionManager: { getSessionFile(): unknown }): string | null {
	try {
		const file = sessionManager.getSessionFile();
		return typeof file === "string" ? file : null;
	} catch {
		return null;
	}
}

function entriesOf(sessionManager: { getBranch(): SessionEntry[] }): SessionEntry[] {
	try {
		return sessionManager.getBranch();
	} catch {
		return [];
	}
}

function sourceContext(state: VestigioState, ctx: ExtensionContext) {
	return {
		session_id: ctx.sessionManager.getSessionId(),
		session_file: sessionFileOf(ctx.sessionManager),
		project_id: state.projectId(ctx.cwd),
	};
}

function renderPendingEvent(event: StaleEventSummary): string[] {
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

function renderFreshness(freshness: Freshness | undefined): string[] {
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

/**
 * Value-looking tokens in a reason: numbers with optional separators, units or
 * a percent sign, clock and date forms, weekdays and slash-separated paths.
 * The grammar is deliberately wide, because the guard only has to notice a
 * reason whose values appear in no evidence text at all.
 */
const REASON_VALUE =
	/(?:\d[\d,_]*(?:[:.]\d+)*)\s*(?:%|[kK]|万|亿|MB|GB|KB|ms|毫秒|秒|分钟|小时|天|次|个|人|元)?|周[一二三四五六日天]|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/gu;

/**
 * Comparison form: full-width digits folded to ASCII, whitespace and numeric
 * separators dropped, case folded, so `5,678` and `5 678` compare equal to
 * `5678` and `MB` compares equal to `mb`.
 */
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
 * and one carried value is enough: agents write the value they replaced next to
 * the new one. A reason that names values and matches none of them is a report
 * with no basis, and it is rejected before it becomes a pending event every
 * later session has to read.
 */
function unanchoredValues(reason: string, evidence: string): string[] | null {
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

function registerStaleTools(pi: ExtensionAPI, state: VestigioState): void {
	pi.registerTool({
		name: "memory_mark_stale",
		label: "Memory mark stale",
		description:
			"Record that a stored memory summary has not absorbed later evidence. Idempotent: re-marking the same logical change stores one durable event. This never rewrites the summary, and you cannot rewrite a stored memory: marking only reports staleness. Repair happens on retrieval — the next memory_resolve that hits this memory folds the pending evidence into the summary and acknowledges the event. The reason must name a value the evidence you pass actually carries, so quote the later evidence that states the new value.",
		parameters: markStaleParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = state.ensureStore();
			if (store === null) {
				return text(`memory_mark_stale unavailable: ${state.storeFailureReason ?? "no store configured"}`);
			}
			let ids: { storeId: string; memoryId: string };
			try {
				ids = splitMemoryUri(params.uri);
			} catch (error) {
				const reason = error instanceof ValidationError ? error.message : errorText(error);
				return text(`memory_mark_stale rejected the URI: ${reason}`);
			}
			if (ids.storeId !== store.storeId) {
				return text(
					`memory_mark_stale refused: ${params.uri} belongs to store ${ids.storeId}, not ${store.storeId}.`,
				);
			}
			const context = sourceContext(state, ctx);
			const memory = store.readMemory(params.uri as MemoryUri);
			if (memory === null) return text(`memory_mark_stale rejected: ${params.uri} does not exist.`);
			if (memory.scope.kind === "project" && memory.scope.project_id !== context.project_id) return text("memory_mark_stale refused: memory belongs to another project.");
			const entries = entriesOf(ctx.sessionManager);
			const byId = new Map(entries.map((entry) => [entry.id, entry]));
			const requestedIds = params.source_message_ids ?? entries.filter((entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "toolResult") && params.excerpt.trim().length > 0 && (sessionEntryText(entry) ?? "").includes(params.excerpt.trim())).slice(-1).map((entry) => entry.id);
			const sources: SourceRef[] = [];
			const excerpts: string[] = [];
			const unknown: string[] = [];
			for (const entryId of requestedIds) {
				const entry = byId.get(entryId);
				const ref = entry === undefined || entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "toolResult") ? null : sourceRefForEntry(entry, context);
				if (ref === null) unknown.push(entryId);
				else {
					sources.push(ref);
					excerpts.push(stripInjectedNote(sessionEntryText(entry!) ?? "").trim());
				}
			}
			if (unknown.length > 0 || sources.length === 0) {
				const detail = unknown.length > 0 ? unknown.join(", ") : "(none given)";
				return text(
					`memory_mark_stale rejected: no session entry for ${detail}. Pass real entry ids from this conversation that carry text.`,
				);
			}
			const unanchored = unanchoredValues(params.reason, excerpts.join("\n"));
			if (unanchored !== null) {
				return text(
					`memory_mark_stale rejected: the reason names ${unanchored.join(", ")}, but no evidence text contains any of them. Quote the later evidence that carries the new value, or pass source_message_ids for the entries that do.`,
				);
			}
			const at = nowIso();
			try {
				const result = store.markStale({
					memory_id: ids.memoryId,
					observed_revision: params.observed_revision,
					reason: params.reason,
					excerpt: excerpts.join("\n\n"),
					sources,
					producer: "agent",
					at,
					branch_ref: state.currentBranchRef,
				});
				const freshness = store.readFreshness(params.uri as MemoryUri, params.observed_revision);
				const lines = [
					`memory_mark_stale(${params.uri}) -> ${result.inserted ? "recorded" : "already recorded"}`,
					`event: ${result.event.event_id} observed r${result.event.observed_revision} producer=${result.event.producer}`,
					...renderFreshness(freshness ?? undefined),
				];
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: {
						status: "recorded",
						event_id: result.event.event_id,
						inserted: result.inserted,
						revision_mismatch: freshness?.revision_mismatch ?? false,
						freshness,
					},
				};
			} catch (error) {
				return text(`memory_mark_stale failed: ${errorText(error)}`);
			}
		},
	});

}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: { status: "unavailable" as const } };
}

function safeActivitySeq(store: { readProjectActivity(projectId: string): { activity_seq: number } | null }, projectId: string): number {
	try {
		return store.readProjectActivity(projectId)?.activity_seq ?? 0;
	} catch {
		return 0;
	}
}

type ResolvePublication = {
	published: boolean;
	/** Why the saved memory is still not searchable; `null` when published. */
	reason: string | null;
	nav_text: string | null;
};

/**
 * `memory_resolve` saved a memory, so the store holds a body no search can
 * admit until its nav job runs. Run that one job here and report the outcome;
 * a failed publication leaves the answer intact and only the status pending.
 * Never throws: a publication attempt must not turn a good answer into a tool
 * error.
 */
async function publishSavedResult(input: {
	state: VestigioState;
	store: MemoryStore;
	project_id: string;
	at: string;
	model: ModelPort | null;
	signal: AbortSignal | undefined;
	result: RetrievalResult;
	persistence: PersistenceOutcome | null;
}): Promise<ResolvePublication | null> {
	const { result, persistence } = input;
	// Only a save leaves an unsearchable memory behind; reuse and answers that
	// wrote nothing have no queued job to run.
	if (
		input.model === null ||
		result.status !== "resolved" ||
		result.persistence_status !== "saved" ||
		result.navigation_status !== "pending" ||
		result.memory_uri === null ||
		result.revision === null
	) {
		return null;
	}
	// The turn's own budget is already spent: leave the job for `jobs run`
	// instead of starting a model call that can only be cut off.
	if (input.signal?.aborted === true) return null;
	const uri = result.memory_uri;
	const revision = result.revision;
	let memoryId: string;
	try {
		memoryId = splitMemoryUri(uri).memoryId;
	} catch (error) {
		return { published: false, reason: `invalid_uri:${errorText(error)}`, nav_text: null };
	}
	try {
		const outcome = await publishRevision(
			{ state: input.state, store: input.store, uri, project_id: input.project_id, at: input.at },
			input.model,
			memoryId,
			revision,
			input.signal,
		);
		const stored = outcome.published ? input.store.readMemory(uri, revision) : null;
		if (!outcome.published || stored === null || stored.nav === null) {
			return { published: false, reason: outcome.reason ?? "nav_not_published", nav_text: null };
		}
		result.navigation_status = "ready";
		if (persistence !== null) persistence.navigation_status = "ready";
		for (const card of result.cards) {
			if (card.memory_id !== memoryId) continue;
			card.nav_text = stored.nav.text;
			card.revision = stored.revision;
			card.state = stored.state;
		}
		return { published: true, reason: null, nav_text: stored.nav.text };
	} catch (error) {
		return { published: false, reason: `nav_threw:${errorText(error)}`, nav_text: null };
	}
}

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

export function renderSearch(
	query: string,
	projectId: string,
	outcome: LayeredSearchOutcome,
	historyNote: string | null,
): string {
	const result: RetrievalResult = outcome.result;
	const lines: string[] = [];
	lines.push(
		`memory_search(${JSON.stringify(query)}) -> ${result.status} | ${result.cards.length} card(s) | project=${projectId}`,
	);
	if (result.cards.length === 0) {
		lines.push("(no matching memory)");
		lines.push(
			"hint: the index matches exact words (unigrams and bigrams, AND-combined), so a full sentence usually matches nothing. Retry with 1-3 words taken from the question, or call memory_resolve with the question.",
		);
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
	lines.push(`layers: ${outcome.layers.map((layer) => `${layer.layer}=${layer.status}(${layer.emitted}/${layer.candidates})`).join(" ")}`);
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
	if (result.cards.length === 0) {
		lines.push("(no matching memory)");
		lines.push(
			"hint: the resolver searches the same exact-word index, so try 1-3 words from the question, or pass include_history to search the raw session history.",
		);
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
