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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ValidationError, splitMemoryUri } from "@vestigio/core";
import type { MemoryUri, RetrievalResult } from "@vestigio/core";
import type { LayeredSearchOutcome, MemoryReadOutcome } from "@vestigio/core/retrieval";
import { MAX_CARD_LIMIT, layeredSearch, readMemoryResult } from "@vestigio/core/retrieval";
import type { ResolveOutcome } from "@vestigio/core/resolver";
import { RESOLVE_MAX_SESSION_RESOLVES, resolveMemory } from "@vestigio/core/resolver";
import { recordMemoryRead, recordSearchHits } from "@vestigio/core/hotspots";
import { errorText, nowIso, type VestigioState } from "./state.js";

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
				"Search the read-only session history layer when the stored memories are not sufficient (default true).",
		}),
	),
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
					measured: outcome.measured,
				},
			};
		},
	});

	pi.registerTool({
		name: "memory_resolve",
		label: "Memory resolve",
		description:
			"Budgeted, model-backed layered retrieval. Walks Active then Archived then the raw session history, lets the configured model judge whether the evidence answers the question, and stops as soon as it does. Returns evidence and a stated gap or conflict; it never edits files or widens the project scope. Costs a few model calls when the store alone is not enough.",
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
			const outcome = readMemoryResult({ store, uri, revision: params.revision });
			const projectId = state.projectId(ctx.cwd);
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
				detail: `uri=${params.uri} recorded=${recorded?.recorded ?? false}`,
			});
			return {
				content: [{ type: "text", text: renderRead(params.uri, outcome) }],
				details: {
					status: outcome.result.status,
					memory_uri: outcome.memory_uri,
					revision: outcome.result.revision,
					persistence_status: outcome.result.persistence_status,
					missing: outcome.result.missing,
					conflicts: outcome.result.conflicts,
					next_action: outcome.result.next_action,
					access_recorded: recorded?.recorded ?? false,
					measured: outcome.measured,
				},
			};
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
	});
	for (const excerpt of outcome.history) {
		lines.push(`history ${excerpt.source_ref.session_id}/${excerpt.source_ref.message_id}: ${excerpt.excerpt}`);
	}
	if (result.evidence.length > 0) {
		lines.push(`evidence: ${result.evidence.map((ref) => `${ref.provider}/${ref.source_instance}`).join(", ")}`);
	}
	if (result.answer !== null) lines.push(`answer: ${result.answer}`);
	if (result.conflicts.length > 0) lines.push(`conflicts: ${result.conflicts.join("; ")}`);
	if (result.missing.length > 0) lines.push(`missing: ${result.missing.join("; ")}`);
	if (result.next_action !== null) lines.push(`next: ${result.next_action}`);
	if (historyNote !== null) lines.push(`history: skipped (${historyNote})`);
	return lines.join("\n");
}

export function renderRead(uri: string, outcome: MemoryReadOutcome): string {
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
		`long summary:`,
		body,
	];
	if (result.evidence.length > 0) {
		lines.push(`sources: ${result.evidence.map((ref) => `${ref.provider}/${ref.source_instance}`).join(", ")}`);
	}
	return lines.join("\n");
}
