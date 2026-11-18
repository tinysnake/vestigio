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
import { Type } from "typebox";
import { ValidationError, splitMemoryUri } from "@vestigio/core";
import type { Freshness, FreshnessBrief, MemoryUri, RetrievalResult, SourceRef, StaleEventSummary } from "@vestigio/core";
import type { LayeredSearchOutcome, MemoryReadOutcome } from "@vestigio/core/retrieval";
import { MAX_CARD_LIMIT, layeredSearch, readMemoryResult } from "@vestigio/core/retrieval";
import type { ResolveOutcome } from "@vestigio/core/resolver";
import { RESOLVE_MAX_SESSION_RESOLVES, resolveMemory } from "@vestigio/core/resolver";
import { recordMemoryRead, recordSearchHits } from "@vestigio/core/hotspots";
import { errorText, nowIso, type VestigioState } from "./state.js";
import { repairOnRead, type ReadRepairReport } from "./read-repair.js";
import { stripInjectedNote } from "./stale-detector.js";
import { sessionEntryText, sourceRefForEntry } from "./session-source.js";

const searchParameters = Type.Object({
	query: Type.String({
		description:
			"Hotspot keywords or a short phrase to look up in the local memory store. Exact words work best.",
	}),
	include_archived: Type.Optional(
		Type.Boolean({ description: "Also search archived memories (default false)." }),
	),
	include_history: Type.Optional(
		Type.Boolean({
			description:
				"Also search the read-only session history layer. Requires the host to be configured with a history source.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			description: `Maximum number of memory cards (1-${MAX_CARD_LIMIT}, default 5).`,
			minimum: 1,
			maximum: MAX_CARD_LIMIT,
		}),
	),
});

const readParameters = Type.Object({
	uri: Type.String({
		description: "A memory URI of the form memory://<store-id>/<memory-id>, as returned by memory_search.",
	}),
	revision: Type.Optional(
		Type.Integer({ description: "Read a specific revision instead of the current one.", minimum: 1 }),
	),
});

const resolveParameters = Type.Object({
	question: Type.String({
		description:
			"A question in natural language. The resolver gathers zero-LLM candidates, then asks the configured model to judge them, expand the query and descend through Active, Archived and the raw history layer.",
	}),
	include_history: Type.Optional(
		Type.Boolean({
			description:
				"Search the read-only history layer when the stored memories are not sufficient (default true).",
		}),
	),
});

const markStaleParameters = Type.Object({
	uri: Type.String({
		description: "A memory URI of the form memory://<store-id>/<memory-id>, as returned by memory_search.",
	}),
	observed_revision: Type.Integer({
		minimum: 1,
		description: "The revision of the summary you actually read (the delivered revision).",
	}),
	reason: Type.String({
		description: "One short sentence naming the change this summary has not absorbed yet.",
	}),
	excerpt: Type.String({
		description:
			"The later evidence text. It is bounded and stored next to the event so the warning survives even when history indexing lags.",
	}),
	source_message_ids: Type.Optional(Type.Array(Type.String(), {
		description: "Optional real entry ids from the active branch. If omitted, excerpt must quote a user/tool message verbatim so the tool can locate it.",
	})),
});

export function registerMemoryTools(pi: ExtensionAPI, state: VestigioState): void {
	pi.registerTool({
		name: "memory_search",
		label: "Memory search",
		description:
			"Search the local Vestigio memory store for previously captured project memories. Returns bounded navigation cards (memory URI, title, short summary). Use memory_read for the full long summary.",
		parameters: searchParameters,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const store = state.ensureStore();
			if (store === null) {
				return text(`memory_search unavailable: ${state.storeFailureReason ?? "no store configured"}`);
			}
			const projectId = state.projectId(ctx.cwd);
			const inputId = `tool:${toolCallId}`;
			const at = nowIso();
			const wantHistory = params.include_history === true;
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
			"Budgeted, model-backed layered retrieval. Walks Active then Archived then the raw session history, lets the configured model judge whether the evidence answers the question, and stops as soon as it does. When the answer rests on raw history it also writes one 500-1000 character medium summary, returns that exact body with its URI and revision, and queues the short nav for `vestigio jobs run`. It never edits files or widens the project scope. Costs a few model calls when the store alone is not enough.",
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
				detail: `calls=${outcome.measured.model_calls} degraded=${outcome.measured.degraded} hits=${recorded}`,
			});
			return {
				content: [{ type: "text", text: renderResolve(params.question, projectId, outcome, modelNote, historyNote) }],
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
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
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
			// A read is the repair trigger: the agent already has this memory in
			// front of it, so folding the pending change in here is the one place
			// repair is guaranteed to be reached. Pinned-revision reads skip it.
			let repair: ReadRepairReport | null = null;
			if (
				params.revision === undefined &&
				outcome.result.status === "resolved" &&
				outcome.result.freshness !== undefined &&
				outcome.result.freshness.is_stale
			) {
				try {
					repair = await repairOnRead({
						state,
						store,
						uri,
						freshness: outcome.result.freshness,
						project_id: projectId,
						at,
						signal,
					});
				} catch (error) {
					state.writeDecision({
						ts: at,
						kind: "error",
						status: "read_repair_failed",
						session_id: state.currentSessionId,
						project_id: projectId,
						error: errorText(error),
					});
				}
				// A landed repair saved a new head; render that body and revision.
				if (repair !== null && repair.revision !== null) {
					outcome = readMemoryResult({ store, uri });
				}
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
				detail: `uri=${params.uri} recorded=${recorded?.recorded ?? false} repair=${repair?.status ?? "none"}`,
			});
			return {
				content: [{ type: "text", text: renderRead(params.uri, outcome, repair) }],
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
					repair,
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

/**
 * The repair line is the difference between "the body you are reading is the
 * current one" and "you are still reading the stale body". Never soften a
 * `nav_pending` into a success: until the nav is bound to the new revision,
 * search cannot return this memory.
 */
function renderRepair(repair: ReadRepairReport): string {
	const acknowledged = repair.acknowledged_event_ids.length;
	switch (repair.status) {
		case "repaired":
			return `repair: repaired r${repair.from_revision} -> r${repair.revision ?? "?"} (acknowledged ${acknowledged} pending event(s); published and findable)`;
		case "nav_pending":
			return `repair: nav_pending r${repair.from_revision} -> r${repair.revision ?? "?"} (acknowledged ${acknowledged} pending event(s); body saved, nav job queued, not findable by search yet${repair.reason === null ? "" : `: ${repair.reason}`})`;
		case "repair_failed":
			return `repair: repair_failed (${repair.reason ?? "unknown"}); the stored body and every pending event are unchanged`;
	}
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

function registerStaleTools(pi: ExtensionAPI, state: VestigioState): void {
	pi.registerTool({
		name: "memory_mark_stale",
		label: "Memory mark stale",
		description:
			"Record that a stored memory summary has not absorbed later evidence. Idempotent: re-marking the same logical change stores one durable event. This never rewrites the summary, and you cannot rewrite a stored memory: marking only reports staleness. Repair happens on retrieval — the next memory_resolve that hits this memory folds the pending evidence into the summary and acknowledges the event.",
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
	if (result.answer !== null) lines.push(`answer: ${result.answer}`);
	if (result.conflicts.length > 0) lines.push(`conflicts: ${result.conflicts.join("; ")}`);
	if (result.missing.length > 0) lines.push(`missing: ${result.missing.join("; ")}`);
	if (result.next_action !== null) lines.push(`next: ${result.next_action}`);
	if (historyNote !== null) lines.push(`history: skipped (${historyNote})`);
	return lines.join("\n");
}

export function renderRead(uri: string, outcome: MemoryReadOutcome, repair: ReadRepairReport | null = null): string {
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
	if (repair !== null) lines.push(renderRepair(repair));
	lines.push(...renderFreshness(result.freshness));
	lines.push(`long summary:`, body);
	if (result.evidence.length > 0) {
		lines.push(`sources: ${result.evidence.map((ref) => `${ref.provider}/${ref.source_instance}`).join(", ")}`);
	}
	return lines.join("\n");
}
