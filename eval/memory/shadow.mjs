/**
 * Shadow view of a real session's decision log.
 *
 * The offline harness can only score cases someone wrote down. A real run knows
 * something the labelled set cannot: what the agent did with the block it was
 * given. The extension already writes that to `VESTIGIO_DECISION_LOG`
 * (`packages/pi-extension/src/decision-log.ts`) — ids, counts, statuses and
 * timings, never query text or memory bodies — so this file only reads that log
 * and joins each turn's plan, tool calls and results into one trace.
 *
 * It observes, it never writes back: no store access, no model call, no
 * sampling inside production. What it cannot do is judge recall — that needs a
 * label — so it reports the rates a label is not required for, and
 * `eval/memory/trace.mjs` remains the label-aware per-turn view.
 *
 *   node ./shadow.mjs --log ~/.vestigio/decisions.jsonl
 *   node ./shadow.mjs --log ... --sample 0.1 --out out/shadow.json
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const argument = (name) => {
	const index = process.argv.indexOf(name);
	return index === -1 ? null : (process.argv[index + 1] ?? null);
};

const LOG = argument("--log") ?? process.env.VESTIGIO_DECISION_LOG ?? null;
const SAMPLE = argument("--sample") === null ? 1 : Number(argument("--sample"));
const MAX_TURNS = argument("--max-turns") === null ? null : Number(argument("--max-turns"));
const OUT = resolve(argument("--out") ?? join(ROOT, "eval/memory/out/shadow.json"));

if (LOG === null) {
	console.error("usage: node ./shadow.mjs --log <decisions.jsonl> [--sample 0.1] [--max-turns N] [--out path]");
	process.exit(2);
}

/** Deterministic subset, so the same log always yields the same report. */
function sampled(key) {
	if (SAMPLE >= 1) return true;
	const digest = createHash("sha256").update(key).digest();
	return digest[0] / 255 < SAMPLE;
}

function readRecords(path) {
	const text = readFileSync(path, "utf8");
	const records = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			records.push(JSON.parse(trimmed));
		} catch {
			// A truncated last line is normal for a log being appended to.
		}
	}
	return records;
}

/**
 * Group records into turns. Tool records are attributed to the most recent
 * `input` record of the same session, because a tool call carries the tool-call
 * id rather than the turn's input id.
 */
function buildTurns(records) {
	const turns = [];
	const open = new Map();
	for (const record of records) {
		const session = record.session_id ?? "unknown";
		if (record.kind === "input") {
			const turn = {
				session_id: session,
				input_id: record.input_id ?? null,
				ts: record.ts ?? null,
				status: record.status ?? "unknown",
				reason: record.reason ?? null,
				matched_ids: record.matched_ids ?? [],
				injected_ids: record.memory_ids ?? [],
				stale_ids: record.stale_ids ?? [],
				query_hash: record.query_hash ?? null,
				query_chars: record.query_chars ?? null,
				// What the injection cost this turn: the block the extension built,
				// as bytes and as the extension's own token estimate. A turn that
				// injected nothing has null here rather than 0, so an average over
				// the injected turns cannot be dragged down by quiet ones.
				injected_tokens: record.estimated_tokens ?? null,
				injected_bytes: record.block_bytes ?? null,
				elapsed_ms: record.elapsed_ms ?? null,
				tools: [],
			};
			turns.push(turn);
			open.set(session, turn);
			continue;
		}
		const turn = open.get(session) ?? null;
		if (turn === null) continue;
		if (record.kind === "tool_search" || record.kind === "tool_resolve") {
			turn.tools.push({
				kind: record.kind,
				status: record.status ?? "unknown",
				memory_ids: record.memory_ids ?? [],
				detail: record.detail ?? null,
			});
		} else if (record.kind === "tool_read") {
			turn.tools.push({
				kind: record.kind,
				status: record.status ?? "unknown",
				memory_ids: record.memory_ids ?? [],
				detail: record.detail ?? null,
			});
		}
	}
	return turns;
}

const rate = (count, total) => (total === 0 ? null : Number((count / total).toFixed(4)));

function percentile(values, quantile) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.ceil((quantile / 100) * sorted.length) - 1);
	const value = sorted[Math.max(0, index)];
	return typeof value === "number" ? Number(value.toFixed(2)) : value;
}

const records = readRecords(LOG);
const turns = buildTurns(records).filter((turn) => sampled(`${turn.session_id}:${turn.input_id}`));
const limited = MAX_TURNS === null ? turns : turns.slice(-MAX_TURNS);

const injected = limited.filter((turn) => turn.injected_ids.length > 0);
const notInjected = limited.filter((turn) => turn.injected_ids.length === 0);
const withTool = (turn) => turn.tools.length > 0;
const readBody = (turn) => turn.tools.some((tool) => tool.kind === "tool_read");
const searched = (turn) => turn.tools.some((tool) => tool.kind === "tool_search" || tool.kind === "tool_resolve");

const searches = limited.flatMap((turn) => turn.tools.filter((tool) => tool.kind !== "tool_read"));
// A turn that gathered and got nothing back is an inferred retrieval miss: the
// log cannot say whether a memory should have existed, so this is reported as a
// rate over gather turns rather than as recall.
const gathered = limited.filter(searched);
const gatherEmpty = gathered.filter(
	(turn) => turn.injected_ids.length === 0 && turn.tools.every((tool) => tool.memory_ids.length === 0),
);
const staleDelivered = injected.filter((turn) => turn.stale_ids.length > 0);
const injectedTokens = injected
	.map((turn) => turn.injected_tokens)
	.filter((value) => typeof value === "number");
const injectedBytes = injected
	.map((turn) => turn.injected_bytes)
	.filter((value) => typeof value === "number");
const resolves = searches.filter((tool) => tool.kind === "tool_resolve");
const zeroHit = searches.filter((tool) => tool.memory_ids.length === 0);

const reasons = {};
for (const turn of notInjected) {
	const key = turn.reason ?? turn.status;
	reasons[key] = (reasons[key] ?? 0) + 1;
}

const injectedCounts = new Map();
for (const turn of injected) {
	for (const id of turn.injected_ids) injectedCounts.set(id, (injectedCounts.get(id) ?? 0) + 1);
}
const topInjected = [...injectedCounts.entries()]
	.sort((left, right) => right[1] - left[1])
	.slice(0, 10)
	.map(([memory_id, count]) => ({ memory_id, count }));

const statuses = (list) => {
	const counts = {};
	for (const tool of list) counts[tool.status] = (counts[tool.status] ?? 0) + 1;
	return counts;
};

const summary = {
	sessions: new Set(limited.map((turn) => turn.session_id)).size,
	turns: limited.length,
	sample: SAMPLE,
	injected_turns: injected.length,
	not_injected_turns: notInjected.length,
	// What the agent did with a block it was handed, versus what it did when
	// nothing was pushed. The first is the "uses what it was given" side, the
	// second is Trigger Miss in production (an unprompted search is the only
	// way a turn with no delivery can still reach memory).
	tool_after_injection_rate: rate(injected.filter(withTool).length, injected.length),
	body_read_after_injection_rate: rate(injected.filter(readBody).length, injected.length),
	tool_when_not_injected_rate: rate(notInjected.filter(searched).length, notInjected.length),
	not_injected_reasons: reasons,
	search_calls: searches.filter((tool) => tool.kind === "tool_search").length,
	resolve_calls: resolves.length,
	resolve_degraded: resolves.filter((tool) => (tool.detail ?? "").includes("degraded=true")).length,
	zero_hit_rate: rate(zeroHit.length, searches.length),
	// Stale Misuse, the part a log can see on its own: a stale memory reached the
	// turn, and whether the agent then opened the pending detail. Heeding it still
	// needs the answer text, which only `trigger.mjs` has.
	stale_delivered_turns: staleDelivered.length,
	stale_read_after_delivery_rate: rate(staleDelivered.filter(readBody).length, staleDelivered.length),
	// The cost side the proposal asks for and a log can answer without labels:
	// how many tokens a delivery spends. The model turn's own latency is not in
	// this file (the log sees the hook, not the answer).
	injected_tokens_p50: percentile(injectedTokens, 50),
	injected_tokens_p95: percentile(injectedTokens, 95),
	injected_tokens_total: injectedTokens.reduce((total, value) => total + value, 0),
	injected_bytes_p50: percentile(injectedBytes, 50),
	gather_turns: gathered.length,
	gather_empty_rate: rate(gatherEmpty.length, gathered.length),
	search_statuses: statuses(searches.filter((tool) => tool.kind === "tool_search")),
	resolve_statuses: statuses(resolves),
	top_injected: topInjected,
	input_elapsed_p50_ms: percentile(
		limited.map((turn) => turn.elapsed_ms).filter((value) => typeof value === "number"),
		50,
	),
	input_elapsed_p95_ms: percentile(
		limited.map((turn) => turn.elapsed_ms).filter((value) => typeof value === "number"),
		95,
	),
};

const report = {
	schema_version: 1,
	generated_at: new Date().toISOString(),
	source: LOG,
	summary,
	// The per-turn trace is what `trace.mjs` gives for labelled runs; here it is
	// the log's own shape, so a real turn can be explained without the words.
	turns: limited.map((turn) => ({
		session_id: turn.session_id,
		input_id: turn.input_id,
		ts: turn.ts,
		status: turn.status,
		reason: turn.reason,
		query_hash: turn.query_hash,
		query_chars: turn.query_chars,
		matched_ids: turn.matched_ids,
		injected_ids: turn.injected_ids,
		stale_ids: turn.stale_ids,
		tools: turn.tools,
		elapsed_ms: turn.elapsed_ms,
	})),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

const percent = (value) => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
console.log(
	`${summary.turns} turns (${summary.sessions} sessions, sample ${summary.sample}): ${summary.injected_turns} injected`,
);
console.log(
	`  after injection: tools ${percent(summary.tool_after_injection_rate)}, body read ${percent(summary.body_read_after_injection_rate)}`,
);
console.log(
	`  nothing injected: unprompted search ${percent(summary.tool_when_not_injected_rate)}; reasons ${JSON.stringify(summary.not_injected_reasons)}`,
);
console.log(
	`  gather calls ${summary.search_calls + summary.resolve_calls} (search ${summary.search_calls}, resolve ${summary.resolve_calls} / degraded ${summary.resolve_degraded}), zero-hit ${percent(summary.zero_hit_rate)}`,
);
console.log(
	`  gather turns that got nothing: ${percent(summary.gather_empty_rate)} of ${summary.gather_turns}; stale delivered ${summary.stale_delivered_turns} (read ${percent(summary.stale_read_after_delivery_rate)})`,
);
console.log(
	`  injected budget: p50 ${summary.injected_tokens_p50 ?? "-"} tokens, p95 ${summary.injected_tokens_p95 ?? "-"}, total ${summary.injected_tokens_total} over ${injected.length} injected turns`,
);
if (topInjected.length > 0) {
	console.log(`  injected most: ${topInjected.map((entry) => `${entry.memory_id}×${entry.count}`).join(", ")}`);
}
console.log(`  input handler p50 ${summary.input_elapsed_p50_ms}ms p95 ${summary.input_elapsed_p95_ms}ms`);
console.log(`report ${OUT}`);
