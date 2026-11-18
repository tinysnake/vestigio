/**
 * Session-scoped persistence for the injection ledger.
 *
 * The store cannot answer "which memories has this session already been given?"
 * (`MemoryStore.hasInjectionReceipt` is an exact five-key lookup), so the
 * authoritative dedup memory lives here: one custom session entry per turn that
 * actually delivered something, replayed from the current branch on every
 * session start and every branch move.
 *
 * Reading the **branch** is what gives the contract's fork/revert semantics for
 * free: a fork copies the branch it forked from, so the child inherits the
 * reminders already shown on that branch; a revert drops the entries of the
 * abandoned branch, so re-entering the hotspot after a revert is allowed. Only
 * a delivered injection is ever written, so a failed or budget-excluded turn
 * leaves the ledger untouched and can inject later.
 */

import type { InjectionLedgerDelta } from "@vestigio/core/hotspots";
import { InjectionLedger } from "@vestigio/core/hotspots";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionManagerLike } from "./pi-types.js";

export const LEDGER_ENTRY_TYPE = "vestigio.injection-ledger";

/** Anything that can append one custom session entry (`ExtensionAPI`). */
export type LedgerEntryHost = {
	appendEntry<T>(customType: string, data?: T): void;
};

/**
 * Rebuild the ledger from the current branch. Unknown/corrupt entries are
 * skipped rather than thrown on: a ledger that cannot be read must degrade to
 * "nothing recorded", never break the input.
 */
export function loadLedger(sessionManager: Pick<SessionManagerLike, "getBranch">): InjectionLedger {
	let branch: readonly SessionEntry[];
	try {
		branch = sessionManager.getBranch();
	} catch {
		return new InjectionLedger();
	}
	const deltas: InjectionLedgerDelta[] = [];
	for (const entry of branch) {
		const delta = ledgerDeltaFromEntry(entry);
		if (delta !== null) deltas.push(delta);
	}
	return InjectionLedger.replay(deltas);
}

export function ledgerDeltaFromEntry(entry: unknown): InjectionLedgerDelta | null {
	if (!isRecord(entry)) return null;
	if (entry.type !== "custom" || entry.customType !== LEDGER_ENTRY_TYPE) return null;
	const data = entry.data;
	if (!isRecord(data)) return null;
	const at = data.at;
	const inputId = data.input_id;
	const memoryIds = data.memory_ids;
	if (typeof at !== "string" || at.length === 0) return null;
	if (typeof inputId !== "string" || inputId.length === 0) return null;
	if (!Array.isArray(memoryIds)) return null;
	const ids: string[] = [];
	for (const id of memoryIds) {
		if (typeof id !== "string" || id.length === 0) return null;
		ids.push(id);
	}
	if (ids.length === 0) return null;
	const rawSigs = data.freshness_sigs;
	const sigs: Record<string, string> = {};
	if (rawSigs !== undefined) {
		if (!isRecord(rawSigs)) return null;
		for (const id of ids) {
			const value = rawSigs[id];
			if (value !== undefined && typeof value !== "string") return null;
			if (typeof value === "string") sigs[id] = value;
		}
	}
	return { at, input_id: inputId, memory_ids: ids, ...(rawSigs === undefined ? {} : { freshness_sigs: sigs }) };
}

/** Append one delta. Only called for turns that actually delivered memories. */
export function persistLedgerDelta(host: LedgerEntryHost, delta: InjectionLedgerDelta): void {
	if (delta.memory_ids.length === 0) return;
	host.appendEntry(LEDGER_ENTRY_TYPE, delta);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
