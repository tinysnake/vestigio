/**
 * Fixture checks for `audit.mjs` (OBS-06).
 *
 * The script is only worth trusting if its six numbers are pinned to a store
 * whose contents are known line by line, so every fixture here is written by
 * hand: a store with the columns the report reads, JSONL streams with the five
 * record types, one corrupt line and one unknown type. The last two tests check
 * what a report is most likely to get wrong — degrading instead of throwing,
 * and staying inside the performance bound.
 *
 * `node --test eval/observability/audit.test.mjs`
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const AUDIT = join(dirname(fileURLToPath(import.meta.url)), "audit.mjs");

/** The store fixture holds only the columns the report's SELECTs name. */
const SCHEMA = [
	`CREATE TABLE turn_events (
		turn_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
		branch_ref TEXT NOT NULL, input_id TEXT NOT NULL, at TEXT NOT NULL, outcome TEXT NOT NULL,
		reason TEXT, matched INTEGER NOT NULL, delivered INTEGER NOT NULL,
		estimated_tokens INTEGER, block_bytes INTEGER, handler_ms INTEGER, elapsed_ms INTEGER)`,
	`CREATE TABLE memory_heads (
		memory_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('medium_ready', 'published', 'archived')),
		updated_at TEXT NOT NULL)`,
	"CREATE TABLE memories (memory_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, project_id TEXT)",
	`CREATE TABLE injection_receipts (
		store_id TEXT NOT NULL, session_id TEXT NOT NULL, branch_ref TEXT NOT NULL, input_id TEXT NOT NULL,
		memory_id TEXT NOT NULL, revision INTEGER NOT NULL, committed_at TEXT NOT NULL,
		PRIMARY KEY (store_id, session_id, branch_ref, input_id, memory_id))`,
	`CREATE TABLE usage_events (
		event_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('hit', 'access')),
		channel TEXT NOT NULL CHECK (channel IN ('hotspot', 'search', 'read')),
		session_id TEXT NOT NULL, input_id TEXT NOT NULL, at TEXT NOT NULL, dedup_key TEXT NOT NULL)`,
	"CREATE TABLE project_activity (project_id TEXT PRIMARY KEY, activity_seq INTEGER NOT NULL, last_input_at TEXT NOT NULL)",
	`CREATE TABLE hotspot_memberships (
		project_id TEXT NOT NULL, memory_id TEXT NOT NULL, admitted_seq INTEGER NOT NULL,
		last_hit_seq INTEGER NOT NULL, last_access_seq INTEGER NOT NULL, recent_hit_weight REAL NOT NULL,
		recent_access_weight REAL NOT NULL, PRIMARY KEY (project_id, memory_id))`,
	"CREATE TABLE store_meta (id INTEGER PRIMARY KEY CHECK (id = 1), store_id TEXT NOT NULL)",
	"CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)",
];

const TURN = (input, project, outcome, at) =>
	[`${input}#${input}`, project, "session-1", "branch-1", input, at, outcome, outcome === "delivered" ? null : outcome, 0, 0, null, null, null, null];

const AGENT_RUN = (id, startedAt, durationMs, tokens, project) => ({
	type: "agent_run",
	v: 1,
	run_id: id,
	session_id: "session-1",
	session_file: null,
	project_id: project,
	project_path: project,
	branch_ref: "branch-1",
	started_at: startedAt,
	ended_at: new Date(Date.parse(startedAt) + durationMs).toISOString(),
	duration_ms: durationMs,
	models: ["mock-1"],
	turns: tokens.turns ?? 1,
	outcome: "completed",
	tokens: {
		input: tokens.input,
		output: tokens.output,
		cache_read: tokens.cache_read ?? 0,
		cache_write: tokens.cache_write ?? 0,
		total: tokens.input + tokens.output,
		cost_usd: tokens.cost_usd ?? null,
		complete: tokens.complete ?? true,
	},
	context: { start_tokens: null, end_tokens: null, context_window: 200000 },
	tools: { calls: {}, status: {} },
	injection: { delivered_turns: 0, injected: 0, matched: 0, stale: 0, outcome_counts: {} },
	error: null,
});

const IFACE = (scope, routes, reasons) => ({
	type: "iface_snapshot",
	v: 1,
	at: "2026-11-24T07:00:00.000Z",
	since: "2026-11-24T06:59:00.000Z",
	window_ms: 60000,
	scope,
	routes,
	reasons,
});

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

/** One store and one observability directory, both small enough to check by hand. */
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "vestigio-audit-"));
	const storePath = join(dir, "fixture.sqlite");
	const obsDir = join(dir, "fixture.sqlite.observability");
	mkdirSync(obsDir);

	const db = new DatabaseSync(storePath);
	for (const statement of SCHEMA) db.exec(statement);
	db.exec("INSERT INTO store_meta (id, store_id) VALUES (1, 'fixture-store')");
	db.exec("INSERT INTO schema_migrations (version, name) VALUES (1, 'initial'), (7, 'turn_events')");

	// Six turns: two delivered, one host command (dropped from the divisor), one
	// over_budget, two no_match. Four belong to p-a, two to p-b.
	const turns = [
		["in-1", "p-a", "delivered", "2026-11-24T06:50:00.000Z"],
		["in-2", "p-a", "delivered", "2026-11-24T06:51:00.000Z"],
		["in-3", "p-a", "no_match", "2026-11-24T06:52:00.000Z"],
		["in-4", "p-a", "over_budget", "2026-11-24T06:53:00.000Z"],
		["in-5", "p-b", "host_command", "2026-11-24T06:54:00.000Z"],
		["in-6", "p-b", "no_match", "2026-11-24T06:55:00.000Z"],
	];
	const insertTurn = db.prepare("INSERT INTO turn_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
	for (const turn of turns) insertTurn.run(...TURN(...turn));

	// Three receipts over two distinct inputs, and four hits (three hotspot, one
	// search) beside one access row that must not be counted as a hit.
	for (const [input, memory] of [["in-1", "mem-1"], ["in-1", "mem-2"], ["in-2", "mem-1"]]) {
		db.prepare("INSERT INTO injection_receipts VALUES (?, ?, ?, ?, ?, ?, ?)").run("fixture-store", "session-1", "branch-1", input, memory, 1, "2026-11-24T06:50:00.000Z");
	}
	let event = 0;
	for (const [kind, channel] of [["hit", "hotspot"], ["hit", "hotspot"], ["hit", "hotspot"], ["hit", "search"], ["access", "read"]]) {
		event += 1;
		db.prepare("INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(`ev-${event}`, "mem-1", 1, kind, channel, "session-1", "in-1", "2026-11-24T06:50:00.000Z", `dedup-${event}`);
	}

	// Five heads: two temporary (medium_ready), two published, one archived.
	// p-a owns three of them, p-b two.
	const heads = [
		["mem-1", "medium_ready", "p-a"],
		["mem-2", "medium_ready", "p-a"],
		["mem-3", "published", "p-a"],
		["mem-4", "published", "p-b"],
		["mem-5", "archived", "p-b"],
	];
	for (const [memory, state, project] of heads) {
		db.prepare("INSERT INTO memory_heads VALUES (?, ?, ?, ?)").run(memory, 1, state, "2026-11-24T06:00:00.000Z");
		db.prepare("INSERT INTO memories VALUES (?, ?, ?, ?)").run(memory, 1, state, project);
	}
	db.prepare("INSERT INTO project_activity VALUES (?, ?, ?)").run("p-a", 9, "2026-11-24T06:50:00.000Z");
	db.prepare("INSERT INTO project_activity VALUES (?, ?, ?)").run("p-b", 3, "2026-11-24T06:55:00.000Z");
	for (const [project, members] of [["p-a", 4], ["p-b", 2]]) {
		for (let index = 0; index < members; index += 1) {
			db.prepare("INSERT INTO hotspot_memberships VALUES (?, ?, ?, ?, ?, ?, ?)").run(project, `mem-${index + 1}`, index, index, index, 1, 1);
		}
	}
	db.close();

	writeFileSync(
		join(obsDir, "agent-runs.jsonl"),
		`${jsonl([
			AGENT_RUN("run-1", "2026-11-24T06:55:00.000Z", 1000, { input: 100, output: 25, cache_read: 5, cost_usd: 0.5, turns: 3 }, "p-a"),
			AGENT_RUN("run-2", "2026-11-24T06:40:00.000Z", 500, { input: 10, output: 10, complete: false, turns: 1 }, "p-b"),
		])}{not json\n${JSON.stringify({ type: "mystery" })}\n`,
	);
	writeFileSync(
		join(obsDir, "iface.jsonl"),
		jsonl([
			IFACE("daemon", { "/v1/run": { "2xx": 3, "4xx": 1, "5xx": 0, total: 4 } }, { rejected_scope: 1, rejected_token: 0 }),
			IFACE("daemon", { "/v1/run": { "2xx": 2, "4xx": 0, "5xx": 0, total: 2 }, "/v1/health": { "2xx": 5, "4xx": 0, "5xx": 0, total: 5 } }, {}),
			// A per-request line the daemon snapshot already counted; it must be ignored.
			IFACE("request", { "/v1/run": { "2xx": 1, "4xx": 0, "5xx": 0, total: 1 } }, {}),
		]),
	);
	writeFileSync(
		join(obsDir, "model.jsonl"),
		jsonl([
			{ type: "model_invocation_start", v: 1, invocation_id: "inv-1", agent: "resolver", project_id: "p-a", session_id: "session-1", input_id: "in-1", at: "2026-11-24T06:50:00.000Z", question: "q1" },
			{ type: "model_call", v: 1, call_id: "call-1", invocation_id: "inv-1", round: 1, purpose: "judge_expand", layer: "l1", model: "mock-1", at: "2026-11-24T06:50:00.100Z", elapsed_ms: 120, request: {}, response: {}, outcome: "ok" },
			{ type: "model_call", v: 1, call_id: "call-2", invocation_id: "inv-1", round: 2, purpose: "detector", layer: "l1", model: "mock-1", at: "2026-11-24T06:50:00.300Z", elapsed_ms: 80, request: {}, response: {}, outcome: "error" },
			{ type: "model_invocation_end", v: 1, invocation_id: "inv-1", at: "2026-11-24T06:50:00.800Z", calls: 2, tokens: { in: 300, out: 40 }, cost_usd: null, outcome: "sufficient" },
			{ type: "model_invocation_start", v: 1, invocation_id: "inv-2", agent: "judge", project_id: "p-a", session_id: "session-1", input_id: "in-2", at: "2026-11-24T06:51:00.000Z", question: "q2" },
		]),
	);

	return { dir, storePath, obsDir };
}

const FIXTURE = fixture();

function audit(...args) {
	const out = execFileSync(process.execPath, [AUDIT, ...args], {
		encoding: "utf8",
		env: { ...process.env, VESTIGIO_STORE: "" },
	});
	return out;
}

const auditJson = (...args) => JSON.parse(audit("--json", ...args));
const base = () => ["--store", FIXTURE.storePath, "--obs-dir", FIXTURE.obsDir];

test("the four record streams and the store tables feed all six items", () => {
	const report = auditJson(...base());
	assert.equal(report.streams.skipped_lines, 1, "the corrupt line is skipped and counted");
	assert.equal(report.streams.unknown_records, 1, "the unknown type is skipped and counted");
	assert.equal(report.streams.records, 10);

	// 1) runs
	assert.equal(report.run_summary.count, 2);
	assert.equal(report.run_summary.turns, 4);
	assert.equal(report.run_summary.latest[0].run_id, "run-1", "newest start first");

	// 2) interface — the daemon snapshots only, never summed with the per-request line
	assert.equal(report.iface.scope, "daemon");
	assert.equal(report.iface.totals.total, 11);
	assert.equal(report.iface.totals["2xx"], 10);
	assert.equal(report.iface.totals["4xx"], 1);
	assert.equal(report.iface.routes[0].route, "/v1/run");
	assert.equal(report.iface.routes[0].total, 6);
	assert.equal(report.iface.reasons.length, 1, "zero-count reasons are dropped");

	// 3) tokens — the main agent run and the internal agents, separated
	assert.equal(report.main_agent.runs, 2);
	assert.equal(report.main_agent.tokens.total, 145);
	assert.equal(report.main_agent.tokens.input, 110);
	assert.equal(report.main_agent.tokens.cache_read, 5);
	assert.equal(report.main_agent.tokens.cost_usd, 0.5);
	assert.equal(report.main_agent.tokens_mean.total, 72.5);
	assert.equal(report.main_agent.incomplete_runs, 1, "run-2 lacked usage");
	const resolver = report.internal_agents.find((entry) => entry.agent === "resolver");
	assert.equal(resolver.invocations, 1);
	assert.equal(resolver.calls, 2);
	assert.equal(resolver.tokens_in, 300);
	assert.equal(resolver.tokens_out, 40);
	assert.deepEqual(resolver.outcomes, { ok: 1, error: 1 });
	const judge = report.internal_agents.find((entry) => entry.agent === "judge");
	assert.equal(judge.invocations_unended, 1, "a start with no end is still counted");

	// 4) durations
	assert.equal(report.main_agent.duration_ms, 1500);
	assert.equal(report.main_agent.duration_ms_max, 1000);
	assert.equal(resolver.invocation_ms, 800);
	assert.equal(resolver.call_ms, 200);
	assert.equal(report.main_agent.duration_ms_mean, 750);

	// 5) injection — both denominators
	assert.equal(report.injection.turns.total, 6);
	assert.deepEqual(report.injection.turns.by_outcome, { delivered: 2, no_match: 2, over_budget: 1, host_command: 1 });
	assert.equal(report.injection.turns.denominator, 5, "host_command leaves the divisor");
	assert.equal(report.injection.delivered, 2);
	assert.equal(report.injection.probability, 0.4);
	assert.equal(report.injection.receipts, 3);
	assert.equal(report.injection.receipt_inputs, 2);
	assert.deepEqual(report.injection.usage.by_channel, { hotspot: 3, search: 1 });
	assert.equal(report.injection.activity_seq, 12);
	assert.equal(report.injection.activity_probability, 2 / 12);
	assert.ok(Math.abs(report.injection.delta - (0.4 - 2 / 12)) < 1e-12);

	// 6) memories and the temporary pool
	assert.equal(report.memory.heads.total, 5);
	assert.deepEqual(report.memory.heads.by_state, { medium_ready: 2, published: 2, archived: 1 });
	assert.equal(report.memory.heads.temporary, 2);
	assert.deepEqual(
		report.memory.pool.map((entry) => [entry.project_id, entry.members, entry.occupancy]),
		[
			["p-a", 4, 4 / 32],
			["p-b", 2, 2 / 32],
		],
	);
	assert.equal(report.store.store_id, "fixture-store");
	assert.deepEqual(report.store.migrations, ["1:initial", "7:turn_events"]);
});

test("the text report prints the six items", () => {
	const text = audit(...base());
	for (const heading of ["1) agent 运行记录", "2) 接口调用", "3) token 消耗", "4) 运行耗时", "5) memory 注入", "6) 记忆与临时池"]) {
		assert.ok(text.includes(heading), `missing ${heading}`);
	}
	assert.ok(text.includes("注入概率 2/5 = 40.0%"), "probability is printed with both halves");
	assert.ok(text.includes("旧口径（全店累计）2/12 = 16.7%"));
});

test("--project narrows the rows it can, and says so about the rest", () => {
	const report = auditJson(...base(), "--project", "p-a");
	assert.equal(report.run_summary.count, 1);
	assert.equal(report.injection.turns.total, 4);
	assert.equal(report.injection.turns.denominator, 4, "p-a has no host_command");
	assert.equal(report.injection.probability, 0.5);
	assert.equal(report.injection.receipts, 3, "receipts are store-wide and stay that way");
	assert.equal(report.injection.delta, null, "a filtered run has no comparable delta");
	assert.equal(report.injection.project_activity_seq, 9);
	assert.equal(report.injection.activity_seq, 12);
	assert.deepEqual(report.memory.project_heads, { medium_ready: 2, published: 1, archived: 0 });
	assert.deepEqual(report.memory.pool.map((entry) => entry.project_id), ["p-a"]);
	assert.equal(report.memory.heads.total, 5, "head totals stay store-wide");
	assert.ok(report.notes.some((line) => line.includes("全店累计")));
});

test("--since narrows the streams and the timestamped tables", () => {
	const report = auditJson(...base(), "--since", "2026-11-24T06:45:00.000Z");
	assert.equal(report.run_summary.count, 1);
	assert.equal(report.run_summary.latest[0].run_id, "run-1");
	assert.equal(report.main_agent.runs, 1);
	assert.equal(report.injection.turns.total, 6, "every fixture turn is after 06:45");
	assert.ok(report.notes.some((line) => line.includes("不受 --since 影响")));
	assert.equal(report.main_agent.duration_ms, 1000);
});

test("--agent narrows the per-agent tables only", () => {
	const report = auditJson(...base(), "--agent", "resolver");
	assert.deepEqual(report.internal_agents.map((entry) => entry.agent), ["resolver"]);
	assert.equal(report.main_agent.runs, 2, "the main agent is unaffected by --agent");
	const main = auditJson(...base(), "--agent", "main");
	assert.deepEqual(main.internal_agents, []);
});

test("a missing store and a missing directory report zeros instead of throwing", () => {
	const missing = join(FIXTURE.dir, "absent.sqlite");
	const report = auditJson("--store", missing, "--obs-dir", join(FIXTURE.dir, "absent"));
	assert.equal(report.run_summary.count, 0);
	assert.equal(report.iface.scope, null);
	assert.equal(report.main_agent.runs, 0);
	assert.equal(report.injection.probability, null);
	assert.equal(report.memory.heads.total, 0);
	assert.equal(report.streams.skipped_lines, 0, "no directory is not a corrupt line");
	assert.ok(report.notes.length > 0, "the zeroes are explained");
	assert.equal(audit().includes("无 store"), true, "no --store at all is also a report");
});

test("a store without the observability tables degrades to zeros", () => {
	const path = join(FIXTURE.dir, "empty.sqlite");
	const db = new DatabaseSync(path);
	db.exec("CREATE TABLE store_meta (id INTEGER PRIMARY KEY CHECK (id = 1), store_id TEXT NOT NULL)");
	db.close();
	const report = auditJson("--store", path);
	assert.equal(report.injection.turns.total, 0);
	assert.equal(report.memory.heads.total, 0);
	assert.equal(report.main_agent.tokens.total, 0);
	assert.ok(report.notes.some((line) => line.includes("没有 turn_events 表")));
});

test("100k lines stay inside the performance bound", () => {
	const dir = mkdtempSync(join(tmpdir(), "vestigio-audit-perf-"));
	const obsDir = join(dir, "perf.observability");
	mkdirSync(obsDir);
	const records = new Array(100000);
	for (let index = 0; index < records.length; index += 1) {
		records[index] = JSON.stringify(
			AGENT_RUN(`run-${index}`, "2026-11-24T06:55:00.000Z", 100, { input: 10, output: 2 }, `p-${index % 7}`),
		);
	}
	writeFileSync(join(obsDir, "agent-runs.jsonl"), `${records.join("\n")}\n`);

	const started = Date.now();
	const report = auditJson("--store", join(dir, "none.sqlite"), "--obs-dir", obsDir);
	const wall = Date.now() - started;
	assert.equal(report.run_summary.count, 100000);
	assert.equal(report.main_agent.tokens.total, 1200000);
	assert.ok(report.elapsed_ms < 5000, `self-timed ${report.elapsed_ms} ms exceeds the 5 s bound`);
	assert.ok(wall < 30000, `wall clock ${wall} ms is far above the bound`);
});
