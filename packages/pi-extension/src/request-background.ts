/**
 * Bounded background processing for human-confirmed requests.
 *
 * `agent_end` calls this: claim up to two due rows, compose each into at most one
 * revision, run the nav job for the saved revision, then mark the request saved
 * or merged with its URI. A retryable failure returns the row to `pending` with
 * a later attempt time; an honest refusal is terminal. Nothing here throws for a
 * model or store problem, because a broken request must never disturb the turn.
 */

import type { Memory, MemoryUri, Revision } from "@vestigio/core";
import { runDueJobs } from "@vestigio/core/jobs";
import {
	MEMORY_REQUEST_RETRY_MS,
	composeMemoryRequest,
	type MemoryRequest,
} from "@vestigio/core/requests";
import type { ModelPort } from "@vestigio/core/resolver";
import type { MemoryStore } from "@vestigio/core/storage";
import { errorText, type VestigioState } from "./state.js";

export const REQUEST_BATCH_LIMIT = 2;
export const REQUEST_NAV_LIMIT = 2;

export type RequestRunEntry = {
	request_id: string;
	status: string;
	memory_uri: MemoryUri | null;
	revision: Revision | null;
	navigation_status: string | null;
	reason: string | null;
};

export type RequestRunReport = {
	claimed: number;
	saved: number;
	merged: number;
	retried: number;
	failed: number;
	entries: RequestRunEntry[];
};

function emptyReport(): RequestRunReport {
	return { claimed: 0, saved: 0, merged: 0, retried: 0, failed: 0, entries: [] };
}

function navStatus(store: MemoryStore, memory: Memory): "pending" | "ready" | "failed" {
	const read = store.readMemory(memory.uri, memory.revision);
	if (read === null || read.nav === null) return "pending";
	if (read.nav.source_revision !== memory.revision) return "pending";
	return read.nav.text.length > 0 ? "ready" : "pending";
}

async function publishNavigation(input: {
	store: MemoryStore;
	model: ModelPort | null;
	model_id: string | undefined;
	memory: Memory;
	at: string;
	signal: AbortSignal | undefined;
}): Promise<{ status: "ready" | "pending" | "failed"; reason: string | null }> {
	if (input.model === null) return { status: "pending", reason: "model_not_configured" };
	const runs = await runDueJobs({
		store: input.store,
		model: input.model,
		model_id: input.model_id,
		limit: 1,
		memory_id: input.memory.memory_id,
		revision: input.memory.revision,
		signal: input.signal,
	});
	const result = runs.results[0];
	const read = input.store.readMemory(input.memory.uri, input.memory.revision);
	const status = read === null ? "pending" : navStatus(input.store, read);
	if (result !== undefined && result.state === "failed") return { status: "failed", reason: result.reason };
	return { status, reason: result?.reason ?? null };
}

export async function processMemoryRequests(input: {
	state: VestigioState;
	store: MemoryStore;
	model: ModelPort | null;
	model_id: string | undefined;
	project: string | null;
	at: string;
	signal?: AbortSignal | undefined;
	limit?: number | undefined;
}): Promise<RequestRunReport> {
	const report = emptyReport();
	const limit = Math.max(1, Math.min(REQUEST_BATCH_LIMIT, Math.trunc(input.limit ?? REQUEST_BATCH_LIMIT)));
	const owner = `requests-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

	for (let index = 0; index < limit; index += 1) {
		if (input.signal?.aborted === true) break;
		let request: MemoryRequest | null;
		try {
			request = input.store.claimDueMemoryRequest({ now_ms: Date.now(), owner });
		} catch (error) {
			report.entries.push({
				request_id: "claim",
				status: "failed",
				memory_uri: null,
				revision: null,
				navigation_status: null,
				reason: errorText(error),
			});
			break;
		}
		if (request === null) break;
		report.claimed += 1;
		const at = input.at;
		try {
			const outcome = await composeMemoryRequest({
				store: input.store,
				request,
				model: input.model,
				model_id: input.model_id,
				signal: input.signal ?? new AbortController().signal,
				at,
				project: input.project,
			});
			const memory = outcome.memory;
			if (memory === null) {
				const terminal = outcome.status === "insufficient_evidence" || outcome.status === "rejected";
				const stored = input.store.failMemoryRequest({
					request,
					status: terminal ? "failed" : "pending",
					reason: outcome.reason ?? outcome.status,
					next_attempt_at: new Date(Date.now() + MEMORY_REQUEST_RETRY_MS).toISOString(),
					at,
				});
				if (stored.status === "failed" || stored.status === "rejected") report.failed += 1;
				else report.retried += 1;
				report.entries.push({
					request_id: stored.request_id,
					status: stored.status,
					memory_uri: stored.memory_uri,
					revision: stored.revision,
					navigation_status: stored.navigation_status,
					reason: stored.reason,
				});
				continue;
			}

			if (request.memory_uri !== memory.uri || request.revision !== memory.revision) {
				input.store.attachMemoryRequestTarget({
					request_id: request.request_id,
					memory_uri: memory.uri,
					revision: memory.revision,
					at,
				});
			}
			const nav = await publishNavigation({
				store: input.store,
				model: input.model,
				model_id: input.model_id,
				memory,
				at,
				signal: input.signal,
			});
			const outcomeKind: "saved" | "merged" = outcome.status === "merged" ? "merged" : "saved";
			const completed = input.store.completeMemoryRequest({
				request_id: request.request_id,
				outcome: outcomeKind,
				memory_uri: memory.uri,
				revision: memory.revision,
				navigation_status: nav.status,
				at,
			});
			if (outcomeKind === "merged") report.merged += 1;
			else report.saved += 1;
			report.entries.push({
				request_id: completed.request_id,
				status: completed.status,
				memory_uri: completed.memory_uri,
				revision: completed.revision,
				navigation_status: completed.navigation_status,
				reason: completed.reason,
			});
		} catch (error) {
			try {
				const stored = input.store.failMemoryRequest({
					request,
					status: "pending",
					reason: errorText(error),
					next_attempt_at: new Date(Date.now() + MEMORY_REQUEST_RETRY_MS).toISOString(),
					at,
				});
				if (stored.status === "failed") report.failed += 1;
				else report.retried += 1;
				report.entries.push({
					request_id: stored.request_id,
					status: stored.status,
					memory_uri: stored.memory_uri,
					revision: stored.revision,
					navigation_status: stored.navigation_status,
					reason: stored.reason,
				});
			} catch (nested) {
				report.entries.push({
					request_id: request.request_id,
					status: "failed",
					memory_uri: null,
					revision: null,
					navigation_status: null,
					reason: errorText(nested),
				});
			}
		}
	}

	// A saved body whose nav job was still pending (for example, no model was
	// configured at save time) gets another bounded attempt on later turns.
	if (input.model !== null) {
		let resumed = 0;
		for (const request of input.store.listMemoryRequests(200)) {
			if (resumed >= REQUEST_NAV_LIMIT) break;
			if ((request.status !== "saved" && request.status !== "merged") || request.navigation_status !== "pending") continue;
			if (request.memory_uri === null || request.revision === null) continue;
			resumed += 1;
			try {
				const memory = input.store.readMemory(request.memory_uri, request.revision);
				if (memory === null) continue;
				const runs = await runDueJobs({
					store: input.store,
					model: input.model,
					model_id: input.model_id,
					limit: 1,
					memory_id: memory.memory_id,
					revision: memory.revision,
					signal: input.signal,
				});
				const result = runs.results[0];
				if (result === undefined) continue;
				const status = navStatus(input.store, memory);
				input.store.setMemoryRequestNavigation({
					request_id: request.request_id,
					navigation_status: result.state === "failed" ? "failed" : status,
					at: input.at,
				});
			} catch {
				// The next agent_end retries; a nav problem must not fail the body.
			}
		}
	}

	return report;
}
