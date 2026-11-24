/**
 * OBS-03's durable row: one `turn_events` record per real input.
 *
 * The live handler in `daemon-adapter.ts` decides delivery, so it owns the row.
 * The rows the plan listed in `input.ts` can never land: no module imports that
 * file, so its `writeTurn` is unreachable.
 *
 * Telemetry only. `note` swallows and reports every failure, because a store
 * that cannot be opened must never turn a delivery into a `continue`.
 */

import type { MemoryStore, TurnEvent, TurnOutcome } from "@vestigio/core/storage";
import { openStore } from "@vestigio/core/storage";

/** The plan's fine-grained reason, coarsened into the bucket the audit counts. */
export function turnOutcome(reason: string | null, hostCommand: boolean): TurnOutcome {
	if (hostCommand) return "host_command";
	switch (reason) {
		case "empty_input":
		case "no_pool_members":
		case "no_match":
		case null:
			return "no_match";
		case "all_deduped":
		case "over_budget":
		case "timeout":
		case "store_unavailable":
		case "store_error":
			return reason;
		default:
			return "no_match";
	}
}

type Required = "turn_key" | "project_id" | "session_id" | "branch_ref" | "input_id" | "at" | "outcome";

/** One row to write. The identity fields are required; the counts default. */
export type TurnRow = Pick<TurnEvent, Required> & Partial<Omit<TurnEvent, Required>>;

export type TurnLogOptions = {
	/** Absolute path of the vestigio store. */
	storePath: string;
	/** Store opener. Defaults to the real `openStore`. */
	open?: ((path: string) => MemoryStore) | undefined;
	/** Debug logger for swallowed failures. Defaults to a no-op. */
	report?: ((error: unknown) => void) | undefined;
};

/** Writes the durable per-turn row. One instance per pi process. */
export class TurnLog {
	private readonly storePath: string;
	private readonly open: (path: string) => MemoryStore;
	private readonly report: (error: unknown) => void;
	private store: MemoryStore | null = null;

	constructor(options: TurnLogOptions) {
		this.storePath = options.storePath;
		this.open = options.open ?? ((path) => openStore({ path }));
		this.report = options.report ?? (() => {});
	}

	/** Writes one row. Never throws: a failed write is reported and dropped. */
	note(row: TurnRow): void {
		try {
			const store = this.ensure();
			if (store === null) return;
			store.recordTurnEvent({
				turn_key: row.turn_key,
				project_id: row.project_id,
				session_id: row.session_id,
				branch_ref: row.branch_ref,
				input_id: row.input_id,
				at: row.at,
				outcome: row.outcome,
				reason: row.reason ?? null,
				matched: row.matched ?? 0,
				delivered: row.delivered ?? 0,
				estimated_tokens: row.estimated_tokens ?? null,
				block_bytes: row.block_bytes ?? null,
				handler_ms: row.handler_ms ?? null,
				elapsed_ms: row.elapsed_ms ?? null,
			});
		} catch (error) {
			this.report(error);
		}
	}

	private ensure(): MemoryStore | null {
		if (this.store !== null) return this.store;
		try {
			this.store = this.open(this.storePath);
		} catch (error) {
			this.report(error);
		}
		return this.store;
	}
}
