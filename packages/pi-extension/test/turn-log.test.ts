/**
 * OBS-03's durable turn row. The live handler owns the delivery decision, so
 * `TurnLog` is what makes that decision auditable: one row per real input, keyed
 * so a replay rewrites its own row, written through the store's own read API,
 * and never a thrown error.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "@vestigio/core/storage";
import { afterEach, describe, expect, it } from "vitest";
import { TurnLog, turnOutcome, type TurnRow } from "../src/turn-log.js";

const AT = "2026-11-24T12:00:00.000Z";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempStore(): string {
	const dir = mkdtempSync(join(tmpdir(), "vestigio-turn-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "store.sqlite");
	openStore({ path });
	return path;
}

function row(overrides: Partial<TurnRow> = {}): TurnRow {
	return {
		turn_key: "s-turn#in-1",
		project_id: "p-turn",
		session_id: "s-turn",
		branch_ref: "br-1",
		input_id: "in-1",
		at: AT,
		outcome: "delivered",
		reason: null,
		matched: 4,
		delivered: 2,
		estimated_tokens: 180,
		block_bytes: 717,
		handler_ms: 2.5,
		elapsed_ms: 1.25,
		...overrides,
	};
}

function storedRows(path: string): Record<string, unknown>[] {
	const db = new DatabaseSync(path);
	try {
		return db.prepare("SELECT * FROM turn_events").all() as Record<string, unknown>[];
	} finally {
		db.close();
	}
}

describe("TurnLog", () => {
	it("writes the handler's counts as one durable row the store can count", () => {
		const path = tempStore();
		new TurnLog({ storePath: path }).note(row());

		expect(storedRows(path)).toEqual([
			{
				turn_key: "s-turn#in-1",
				project_id: "p-turn",
				session_id: "s-turn",
				branch_ref: "br-1",
				input_id: "in-1",
				at: AT,
				outcome: "delivered",
				reason: null,
				matched: 4,
				delivered: 2,
				estimated_tokens: 180,
				block_bytes: 717,
				handler_ms: 2.5,
				elapsed_ms: 1.25,
			},
		]);

		const store = openStore({ path });
		expect(store.countTurnEvents({ project_id: "p-turn", session_id: "s-turn" })).toBe(1);
		expect(store.turnOutcomeCounts("p-turn")).toEqual([{ outcome: "delivered", count: 1 }]);
	});

	it("rewrites its own row when the same turn is replayed", () => {
		const path = tempStore();
		const log = new TurnLog({ storePath: path });
		log.note(row());
		log.note(row({ outcome: "delivered", matched: 1, delivered: 1, handler_ms: 3.5 }));

		const rows = storedRows(path);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ matched: 1, delivered: 1, handler_ms: 3.5 });
	});

	it("reports an unusable store instead of throwing into the turn", () => {
		const errors: unknown[] = [];
		const log = new TurnLog({
			storePath: "/nonexistent/store.sqlite",
			open: () => {
				throw new Error("store unavailable");
			},
			report: (error) => errors.push(error),
		});

		expect(() => log.note(row())).not.toThrow();
		expect(errors.map(String)).toEqual(["Error: store unavailable"]);
	});
});

describe("turnOutcome", () => {
	it("coarsens a fine reason into the bucket the audit counts", () => {
		expect(turnOutcome(null, true)).toBe("host_command");
		expect(turnOutcome(null, false)).toBe("no_match");
		expect(turnOutcome("empty_input", false)).toBe("no_match");
		expect(turnOutcome("all_deduped", false)).toBe("all_deduped");
		expect(turnOutcome("store_error", false)).toBe("store_error");
		expect(turnOutcome("a_reason_from_the_future", false)).toBe("no_match");
	});
});
