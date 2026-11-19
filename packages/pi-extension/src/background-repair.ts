import type { MemoryStore } from "@vestigio/core/storage";
import type { Freshness } from "@vestigio/core";
import { errorText, type VestigioState } from "./state.js";
import { REPAIR_DEADLINE_MS, repairStaleMemoryNow } from "./read-repair.js";
import { memoryUriOf } from "./session-source.js";

/**
 * The `agent_end` repair pass: the caller waited for nothing, so the pass owns
 * one wall-clock budget for the whole run and gives each memory its own bounded
 * attempt rather than slicing the shared remainder. A memory whose attempt
 * fails or is killed by its deadline is retried, up to
 * `BACKGROUND_REPAIR_MAX_ATTEMPTS` per pending set, but never after a success.
 * A memory that runs out of attempts or budget is reported, never silently
 * dropped.
 *
 * The per-attempt ceiling (`REPAIR_DEADLINE_MS`) matches the measured repair
 * tail: live runs measured repairs between 15 s and 101 s, so a smaller budget
 * failed genuinely completable repairs.
 */
export const BACKGROUND_REPAIR_TOTAL_MS = 300_000;
export const BACKGROUND_REPAIR_MAX_MEMORIES = 3;
export const BACKGROUND_REPAIR_MAX_ATTEMPTS = 2;

export type BackgroundRepairEntry = {
	memory_id: string;
	status: "repaired" | "nav_pending" | "repair_failed" | "skipped";
	revision: number | null;
	reason: string | null;
	acknowledged_event_ids: string[];
	/** Wall clock of this memory's last attempt; `null` when nothing was attempted. */
	elapsed_ms: number | null;
	/** How many model attempts this pending set has spent in this session. */
	attempts: number;
};

export type BackgroundRepairReport = {
	candidates: number;
	attempted: number;
	repaired: number;
	deadline_exceeded: boolean;
	entries: BackgroundRepairEntry[];
};

function skipped(memoryId: string, reason: string, attempts: number): BackgroundRepairEntry {
	return { memory_id: memoryId, status: "skipped", revision: null, reason, acknowledged_event_ids: [], elapsed_ms: null, attempts };
}

export async function repairStaleMemoriesInBackground(input: {
	state: VestigioState;
	store: MemoryStore;
	project_id: string;
	at: string;
	/** Bounded overrides (tests and measured tuning); defaults to the module caps. */
	deadline_ms?: number;
	total_ms?: number;
}): Promise<BackgroundRepairReport> {
	const { state, store, project_id } = input;
	const per_attempt_ms = input.deadline_ms ?? REPAIR_DEADLINE_MS;
	const total_ms = input.total_ms ?? BACKGROUND_REPAIR_TOTAL_MS;
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
			entries: selected.map((candidate) =>
				skipped(candidate.memory_id, reason, state.backgroundAttemptsFor(candidate.freshness.freshness_sig)),
			),
		};
	}

	const entries: BackgroundRepairEntry[] = [];
	let attempted = 0;
	let repaired = 0;
	let deadline_exceeded = false;
	const budget_end = Date.now() + total_ms;
	for (const candidate of selected) {
		const signature = candidate.freshness.freshness_sig;
		let spent = state.backgroundAttemptsFor(signature);
		if (spent >= BACKGROUND_REPAIR_MAX_ATTEMPTS) {
			entries.push(skipped(candidate.memory_id, "attempts_exhausted", spent));
			continue;
		}
		let entry: BackgroundRepairEntry | null = null;
		while (spent < BACKGROUND_REPAIR_MAX_ATTEMPTS) {
			if (budget_end - Date.now() <= 0) {
				deadline_exceeded = true;
				break;
			}
			spent += 1;
			state.noteBackgroundAttempt(signature);
			attempted += 1;
			const attempt_started = Date.now();
			// The attempt may not outlive the pass budget, whatever the per-attempt
			// ceiling allows.
			const attempt_deadline_ms = Math.min(per_attempt_ms, budget_end - attempt_started);
			try {
				const report = await repairStaleMemoryNow({
					state,
					store,
					uri: candidate.uri,
					freshness: candidate.freshness,
					project_id,
					at: input.at,
					signal: undefined,
					deadline_ms: attempt_deadline_ms,
				});
				entry = {
					memory_id: candidate.memory_id,
					status: report.status,
					revision: report.revision,
					reason: report.reason,
					acknowledged_event_ids: report.acknowledged_event_ids,
					elapsed_ms: Date.now() - attempt_started,
					attempts: spent,
				};
				// A `nav_pending` attempt already wrote the revision, so retrying it
				// would re-repair the head it just saved; only a failed attempt is
				// worth one more try.
				if (report.status === "repaired") {
					repaired += 1;
					break;
				}
				if (report.status === "nav_pending") break;
			} catch (error) {
				entry = {
					memory_id: candidate.memory_id,
					status: "repair_failed",
					revision: null,
					reason: `repair_threw:${errorText(error)}`,
					acknowledged_event_ids: [],
					elapsed_ms: Date.now() - attempt_started,
					attempts: spent,
				};
			}
		}
		if (entry === null) {
			// The total budget ran out before this memory could be attempted:
			// report it instead of dropping it.
			entries.push(skipped(candidate.memory_id, "deadline_exceeded", spent));
			continue;
		}
		entries.push(entry);
	}
	return { candidates: selected.length, attempted, repaired, deadline_exceeded, entries };
}
