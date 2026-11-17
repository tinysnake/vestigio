/**
 * Optional JSONL decision log for the injection path.
 *
 * Diagnostics only: nothing reads this file back, and it never carries memory
 * bodies, source text or keywords — only ids, counts and timings. It exists so
 * that a real run can be explained after the fact without turning on a debugger,
 * and so the harness can read the p50/p95 of the match path without parsing the
 * terminal. The wire request body is the authority for "did the append land and
 * where"; this is supplementary.
 */

import { appendFileSync } from "node:fs";

export type DecisionRecord = {
	readonly ts: string;
	readonly kind: "input" | "tool_search" | "tool_read" | "session" | "error";
	readonly status: string;
	readonly reason?: string | null;
	readonly source?: string | null;
	readonly streaming_behavior?: string | null;
	readonly session_id?: string | null;
	readonly branch_ref?: string | null;
	readonly input_id?: string | null;
	readonly project_id?: string | null;
	readonly matched?: number;
	readonly injected?: number;
	readonly block_bytes?: number;
	readonly estimated_tokens?: number;
	readonly elapsed_ms?: number;
	readonly handler_ms?: number;
	readonly ledger_added?: number;
	readonly error?: string | null;
	readonly detail?: string | null;
};

export class DecisionLog {
	private path: string | null;
	private failures = 0;

	constructor(path: string | null) {
		this.path = path;
	}

	get enabled(): boolean {
		return this.path !== null;
	}

	write(record: DecisionRecord): void {
		if (this.path === null) return;
		try {
			appendFileSync(this.path, `${JSON.stringify(record)}\n`);
		} catch {
			// A diagnostic log must never break the turn; stop trying after a
			// few failures rather than paying the cost on every later turn.
			this.failures += 1;
			if (this.failures > 5) this.path = null;
		}
	}
}
