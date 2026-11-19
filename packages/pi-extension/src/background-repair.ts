import type { MemoryStore } from "@vestigio/core/storage";
import type { Freshness } from "@vestigio/core";
import { errorText, type VestigioState } from "./state.js";
import { repairStaleMemoryNow } from "./read-repair.js";
import { memoryUriOf } from "./session-source.js";

/**
 * The `agent_end` repair pass for `background` mode: the caller waited for
 * nothing, so the pass has one wall-clock budget and each memory gets whatever
 * is left of it. A memory that does not finish is left stale; its attempt is
 * still consumed, which is what keeps the next `agent_end` from retrying it.
 *
 * The ceiling matches the inline read's (`READ_REPAIR_DEADLINE_MS`): the live
 * runs measured repairs between 15 s and 101 s, so a smaller budget failed
 * genuinely completable repairs.
 */
export const BACKGROUND_REPAIR_DEADLINE_MS = 150_000;
export const BACKGROUND_REPAIR_MAX_MEMORIES = 3;

export type BackgroundRepairEntry = {
	memory_id: string;
	status: "repaired" | "nav_pending" | "repair_failed" | "skipped";
	revision: number | null;
	reason: string | null;
	acknowledged_event_ids: string[];
	/** Wall clock of this memory's attempt; `null` when nothing was attempted. */
	elapsed_ms: number | null;
};

export type BackgroundRepairReport = {
	candidates: number;
	attempted: number;
	repaired: number;
	deadline_exceeded: boolean;
	entries: BackgroundRepairEntry[];
};

function skipped(memoryId: string, reason: string): BackgroundRepairEntry {
	return { memory_id: memoryId, status: "skipped", revision: null, reason, acknowledged_event_ids: [], elapsed_ms: null };
}

export async function repairStaleMemoriesInBackground(input: {
	state: VestigioState;
	store: MemoryStore;
	project_id: string;
	at: string;
}): Promise<BackgroundRepairReport> {
	const { state, store, project_id } = input;
	const candidates: Array<{ memory_id: string; oldest_at: string; uri: ReturnType<typeof memoryUriOf>; freshness: Freshness }> = [];
	// The same pool the detector records events for: a memory the session read but
	// that no hotspot lists would otherwise keep its pending events forever.
	const poolIds = store.readHotspotMemberships(project_id).map((membership) => membership.memory_id);
	for (const memory_id of new Set([...state.seenMemoryIds(), ...poolIds])) {
		const uri = memoryUriOf(store.storeId, memory_id);
		const head = store.readMemory(uri);
		if (head === null) continue;
		const freshness = store.readFreshness(uri, head.revision);
		if (freshness === null) continue;
		const pending = freshness.pending.filter((event) => event.event_id.length > 0);
		if (pending.length === 0) continue;
		// Already tried this exact pending set in this session: only a new change
		// makes it worth another model call.
		if (state.backgroundAttemptedFor(freshness.freshness_sig)) continue;
		const oldest = pending.reduce<string | null>(
			(min, event) => (min === null || event.created_at < min ? event.created_at : min),
			null,
		);
		if (oldest === null) continue;
		candidates.push({ memory_id, oldest_at: oldest, uri, freshness });
	}
	// Oldest pending change first: the longest-unabsorbed evidence is the one
	// most likely to be what the next turn reads.
	candidates.sort((a, b) => (a.oldest_at < b.oldest_at ? -1 : a.oldest_at > b.oldest_at ? 1 : 0));
	const selected = candidates.slice(0, BACKGROUND_REPAIR_MAX_MEMORIES);

	const model = state.modelPort();
	if (model === null) {
		const reason = `model_unavailable:${state.modelSkipReason() ?? "unknown"}`;
		return {
			candidates: selected.length,
			attempted: 0,
			repaired: 0,
			deadline_exceeded: false,
			entries: selected.map((candidate) => skipped(candidate.memory_id, reason)),
		};
	}

	const entries: BackgroundRepairEntry[] = [];
	let attempted = 0;
	let repaired = 0;
	const budget_end = Date.now() + BACKGROUND_REPAIR_DEADLINE_MS;
	for (let index = 0; index < selected.length; index += 1) {
		const remaining = budget_end - Date.now();
		if (remaining <= 0) {
			return {
				candidates: selected.length,
				attempted,
				repaired,
				deadline_exceeded: true,
				entries: [
					...entries,
					...selected.slice(index).map((candidate) => skipped(candidate.memory_id, "deadline_exceeded")),
				],
			};
		}
		const candidate = selected[index]!;
		const attempt_started = Date.now();
		try {
			state.noteBackgroundAttempt(candidate.freshness.freshness_sig);
			attempted += 1;
			const report = await repairStaleMemoryNow({
				state,
				store,
				uri: candidate.uri,
				freshness: candidate.freshness,
				project_id,
				at: input.at,
				signal: undefined,
				deadline_ms: remaining,
			});
			if (report.status === "repaired") repaired += 1;
			entries.push({
				memory_id: candidate.memory_id,
				status: report.status,
				revision: report.revision,
				reason: report.reason,
				acknowledged_event_ids: report.acknowledged_event_ids,
				elapsed_ms: Date.now() - attempt_started,
			});
		} catch (error) {
			entries.push({
				memory_id: candidate.memory_id,
				status: "repair_failed",
				revision: null,
				reason: `repair_threw:${errorText(error)}`,
				acknowledged_event_ids: [],
				elapsed_ms: Date.now() - attempt_started,
			});
		}
	}
	return { candidates: selected.length, attempted, repaired, deadline_exceeded: false, entries };
}
