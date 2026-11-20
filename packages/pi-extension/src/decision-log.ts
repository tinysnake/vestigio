/**
 * Optional JSONL decision log for the injection path.
 *
 * Diagnostics only: nothing reads this file back, and it never carries memory
 * bodies, source text or keywords — only ids, counts and timings, plus a short
 * hash of the query so two turns asking the same thing can be recognised
 * without keeping their words. It exists so that a real run can be explained
 * after the fact without turning on a debugger, so the harness can read the
 * p50/p95 of the match path without parsing the terminal, and so
 * `eval/memory/shadow.mjs` can join one turn's plan, tools and results into a
 * single trace. The wire request body is the authority for "did the append land
 * and where"; this is supplementary.
 */

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

export type DecisionRecord = {
	readonly ts: string;
	readonly kind: "input" | "tool_search" | "tool_read" | "tool_resolve" | "session" | "error";
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
	/** Injected memory ids, so a turn's delivery can be named, not just counted. */
	readonly memory_ids?: readonly string[];
	/** Candidate ids before budget and dedup: the two false-positive tiers. */
	readonly matched_ids?: readonly string[];
	/** 12 hex characters of sha256(query): identity without the words. */
	readonly query_hash?: string;
	readonly query_chars?: number;
};

/** A short, stable digest of a query. Never throws, so a log line never fails. */
export function hashQuery(text: string): string {
	try {
		return createHash("sha256").update(text).digest("hex").slice(0, 12);
	} catch {
		return "";
	}
}

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
