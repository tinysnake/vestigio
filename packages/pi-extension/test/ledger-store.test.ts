import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { LEDGER_ENTRY_TYPE, ledgerDeltaFromEntry, loadLedger, persistLedgerDelta } from "../src/ledger-store.js";

const MAIN = "2026-11-17T18:00:00Z";

function ledgerEntry(id: string, at: string, inputId: string, memoryIds: string[]): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: at,
		customType: LEDGER_ENTRY_TYPE,
		data: { at, input_id: inputId, memory_ids: memoryIds },
	} as unknown as SessionEntry;
}

function userEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: MAIN,
		message: { role: "user", content: "hello" },
	} as unknown as SessionEntry;
}

const manager = (branch: SessionEntry[]) => ({ getBranch: () => branch });

describe("loadLedger", () => {
	it("restores the exact freshness snapshot after a session reload", () => {
		const entry = ledgerEntry("e-snapshot", MAIN, "i-snapshot", ["mem-a"]);
		if (entry.type !== "custom") throw new Error("fixture must be custom");
		entry.data = { at: MAIN, input_id: "i-snapshot", memory_ids: ["mem-a"], freshness_sigs: { "mem-a": "r2:event-b" } };
		const ledger = loadLedger({ getBranch: () => [entry] });
		expect(ledger.isDelivered("mem-a", "r2:event-b")).toBe(true);
		expect(ledger.isDelivered("mem-a", "r2:event-c")).toBe(false);
	});
	it("replays ledger entries from the branch", () => {
		const ledger = loadLedger(
			manager([ledgerEntry("e2", "2026-11-17T18:02:00Z", "i2", ["mem-b"]), userEntry("m1"), ledgerEntry("e1", MAIN, "i1", ["mem-a"])]),
		);
		expect(ledger.size).toBe(2);
		expect(ledger.has("mem-a")).toBe(true);
		expect(ledger.has("mem-b")).toBe(true);
	});

	it("keeps the earliest delivery timestamp when a memory is replayed twice", () => {
		const ledger = loadLedger(
			manager([ledgerEntry("e2", "2026-11-17T18:05:00Z", "i2", ["mem-a"]), ledgerEntry("e1", MAIN, "i1", ["mem-a"])]),
		);
		expect(ledger.deliveredAt("mem-a")).toBe(MAIN);
	});

	it("forgets entries of a reverted branch (they are not on the current branch)", () => {
		const kept = loadLedger(manager([userEntry("m1"), ledgerEntry("e1", MAIN, "i1", ["mem-a"])]));
		const reverted = loadLedger(manager([userEntry("m1")]));
		expect(kept.has("mem-a")).toBe(true);
		expect(reverted.has("mem-a")).toBe(false);
	});

	it("inherits entries a fork copied onto the new branch", () => {
		const fork = loadLedger(manager([userEntry("m1"), ledgerEntry("e1", MAIN, "i1", ["mem-a", "mem-c"])]));
		expect(fork.ids()).toEqual(["mem-a", "mem-c"]);
	});

	it("skips unrelated and malformed entries instead of throwing", () => {
		const ledger = loadLedger(
			manager([
				userEntry("m1"),
				{ type: "custom", id: "e2", parentId: null, timestamp: MAIN, customType: "other.thing", data: {} } as unknown as SessionEntry,
				{ type: "custom", id: "e3", parentId: null, timestamp: MAIN, customType: LEDGER_ENTRY_TYPE } as unknown as SessionEntry,
				ledgerEntry("e4", MAIN, "i4", ["mem-a"]),
			]),
		);
		expect(ledger.size).toBe(1);
		expect(ledger.has("mem-a")).toBe(true);
	});

	it("survives a session manager that throws", () => {
		const ledger = loadLedger({
			getBranch: () => {
				throw new Error("no session");
			},
		});
		expect(ledger.size).toBe(0);
	});
});

describe("ledgerDeltaFromEntry", () => {
	it("accepts a complete delta", () => {
		expect(ledgerDeltaFromEntry(ledgerEntry("e1", MAIN, "i1", ["mem-a"]))).toEqual({
			at: MAIN,
			input_id: "i1",
			memory_ids: ["mem-a"],
		});
	});

	it.each([
		["no data", { type: "custom", customType: LEDGER_ENTRY_TYPE }],
		["empty ids", { type: "custom", customType: LEDGER_ENTRY_TYPE, data: { at: MAIN, input_id: "i1", memory_ids: [] } }],
		["bad id", { type: "custom", customType: LEDGER_ENTRY_TYPE, data: { at: MAIN, input_id: "i1", memory_ids: [7] } }],
		["no timestamp", { type: "custom", customType: LEDGER_ENTRY_TYPE, data: { input_id: "i1", memory_ids: ["mem-a"] } }],
		["plain string", "nope"],
	])("rejects %s", (_label, value) => {
		expect(ledgerDeltaFromEntry(value)).toBeNull();
	});
});

describe("persistLedgerDelta", () => {
	it("appends one entry under the ledger custom type", () => {
		const calls: Array<{ customType: string; data: unknown }> = [];
		persistLedgerDelta({ appendEntry: (customType, data) => calls.push({ customType, data }) }, {
			at: MAIN,
			input_id: "i1",
			memory_ids: ["mem-a"],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.customType).toBe(LEDGER_ENTRY_TYPE);
		expect(calls[0]?.data).toEqual({ at: MAIN, input_id: "i1", memory_ids: ["mem-a"] });
	});

	it("writes nothing when the delta carries no memory", () => {
		const calls: unknown[] = [];
		persistLedgerDelta({ appendEntry: (...args: unknown[]) => calls.push(args) }, {
			at: MAIN,
			input_id: "i1",
			memory_ids: [],
		});
		expect(calls).toHaveLength(0);
	});
});
