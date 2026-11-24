#!/usr/bin/env node
/**
 * Read-only report over one store's observability streams and tables (OBS-06).
 *
 * OBS-01..05 write five streams and fill four tables, and each answers a
 * different question, so this prints the six the plan asks for in one pass:
 * agent runs, interface calls, per-agent tokens, per-agent durations, injection
 * probability under both denominators, and memory/pool totals.
 *
 * Nothing here writes. The store is opened read-only (`query_only` fallback for
 * a store mid-write) and every statement is a SELECT; the `.observability`
 * directory is only read. A missing table, a missing directory or a corrupt
 * line degrades to a counted zero with a note, never to an exception.
 *
 * The store aggregates mirror `packages/core/src/observability/stats.ts`
 * (OBS-03) query for query; they are re-derived here because that module needs
 * an open `MemoryStore`, and opening one can migrate the schema — a write.
 *
 * Usage:
 *   node eval/observability/audit.mjs [--store <path>] [--obs-dir <dir>] [--json]
 *     [--since <iso>] [--project <id>] [--limit <n>] [--agent <name>] [--capacity <n>]
 *
 * `--store` defaults to `VESTIGIO_STORE`, `--obs-dir` to `<store>.observability`.
 * `--since` filters the record streams and the two timestamped tables
 * (`turn_events`, `usage_events`). The cumulative counters (`injection_receipts`,
 * `project_activity`) and the head/pool snapshots are lifetime by construction,
 * so the legacy probability keeps numerator and denominator in one scope; the
 * report notes every place a filter cannot reach. `--limit` caps listed rows
 * (runs, interface routes, pool projects), not the aggregates and not the
 * per-agent tables. `--agent` narrows those per-agent tables; `main` selects
 * only the pi agent run. `--capacity` is the hotspot pool capacity the
 * occupancy is measured against when the store does not record one.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The three head states, in report order (`../packages/core/migrations/0001_initial.sql`). */
const STATES = ["medium_ready", "published", "archived"];
/** `DEFAULT_HOTSPOT_POOL_CAPACITY` (`packages/core/src/hotspots/policy.ts:38`). */
const DEFAULT_POOL_CAPACITY = 32;
const KNOWN_TYPES = new Set([
	"agent_run",
	"iface_snapshot",
	"model_invocation_start",
	"model_call",
	"model_invocation_end",
]);
/** The two switches that make the optional streams exist at all. */
const DEBUG_SWITCHES = [
	["VESTIGIO_IFACE_LOG", "接口逐请求记录"],
	["VESTIGIO_MODEL_LOG", "内部 agent 模型调用记录"],
];

function fail(message) {
	console.error(message);
	process.exit(2);
}

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) return null;
	if (process.argv[index + 1] === undefined) fail(`${name} needs a value`);
	return process.argv[index + 1];
}

const has = (name) => process.argv.includes(name);

const json = has("--json");
const limitArgument = argument("--limit");
const limit = limitArgument === null ? 5 : Number(limitArgument);
if (!Number.isInteger(limit) || limit < 1) fail("--limit needs a positive integer");
const capacityArgument = argument("--capacity");
const capacity = capacityArgument === null ? DEFAULT_POOL_CAPACITY : Number(capacityArgument);
if (!Number.isInteger(capacity) || capacity < 1) fail("--capacity needs a positive integer");
const since = argument("--since");
const sinceMs = since === null ? null : Date.parse(since);
if (since !== null && Number.isNaN(sinceMs)) fail("--since needs an ISO timestamp");
const project = argument("--project") ?? undefined;
const agent = argument("--agent") ?? undefined;
const storeArgument = argument("--store") ?? process.env["VESTIGIO_STORE"] ?? "";
const storePath = storeArgument === "" ? null : resolve(storeArgument);
const obsArgument = argument("--obs-dir");
const obsDir = obsArgument !== null ? resolve(obsArgument) : storePath === null ? null : `${storePath}.observability`;

const startedMs = Date.now();
const notes = [];
function note(message) {
	if (!notes.includes(message)) notes.push(message);
}

/** `null` (no value) is distinct from `"0"`: the report must not print a 0 it never read. */
function number(value) {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function mean(total, count) {
	return count === 0 ? null : total / count;
}

function stampOf(record) {
	if (record.type === "agent_run") return typeof record.started_at === "string" ? record.started_at : null;
	return typeof record.at === "string" ? record.at : null;
}

function withinSince(stamp) {
	if (sinceMs === null) return true;
	if (stamp === null) return false;
	const at = Date.parse(stamp);
	return !Number.isNaN(at) && at >= sinceMs;
}

/* ------------------------------------------------------------------ streams */

/** Every `*.jsonl` in the observability directory, rotated segments included. */
function readStreams(dir) {
	const result = { dir, files: [], lines: 0, skipped: 0, unknown: 0, records: [], error: null };
	if (dir === null) {
		result.error = "没有指定观测目录";
		return result;
	}
	if (!existsSync(dir)) {
		result.error = "观测目录不存在";
		return result;
	}
	let names;
	try {
		names = readdirSync(dir);
	} catch (error) {
		result.error = `观测目录无法读取：${String(error)}`;
		return result;
	}
	for (const name of names.filter((entry) => entry.endsWith(".jsonl")).sort()) {
		result.files.push(name);
		let text;
		try {
			text = readFileSync(join(dir, name), "utf8");
		} catch (error) {
			note(`${name} 无法读取：${String(error)}`);
			continue;
		}
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			result.lines += 1;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				result.skipped += 1;
				continue;
			}
			if (record === null || typeof record !== "object" || typeof record.type !== "string") {
				result.skipped += 1;
				continue;
			}
			if (!KNOWN_TYPES.has(record.type)) {
				result.unknown += 1;
				continue;
			}
			if (!withinSince(stampOf(record))) continue;
			result.records.push(record);
		}
	}
	if (result.skipped > 0) note(`${result.skipped} 行 JSONL 损坏已跳过`);
	if (result.unknown > 0) note(`${result.unknown} 行记录类型无法识别已跳过`);
	return result;
}

const streams = readStreams(obsDir);
const recordsOf = (type) => streams.records.filter((record) => record.type === type);

/* -------------------------------------------------------------- 1) agent 运行 */

const runRecords = recordsOf("agent_run")
	.filter((record) => project === undefined || record.project_id === project)
	.sort((left, right) => (stampOf(right) ?? "").localeCompare(stampOf(left) ?? ""));
const runSummary = {
	count: runRecords.length,
	turns: runRecords.reduce((total, record) => total + number(record.turns), 0),
	latest: runRecords.slice(0, limit).map((record) => ({
		run_id: record.run_id ?? null,
		session_id: record.session_id ?? null,
		project_id: record.project_id ?? null,
		started_at: record.started_at ?? null,
		ended_at: record.ended_at ?? null,
		duration_ms: record.duration_ms === undefined ? null : number(record.duration_ms),
		outcome: record.outcome ?? null,
		turns: number(record.turns),
		models: Array.isArray(record.models) ? record.models : [],
		tokens_total: record.tokens === undefined ? null : number(record.tokens.total),
	})),
};

/* ---------------------------------------------------------------- 2) 接口调用 */

const ifaceRecords = recordsOf("iface_snapshot");
const daemonSnapshots = ifaceRecords.filter((record) => record.scope === "daemon");
// A `scope: "request"` line (VESTIGIO_IFACE_LOG=1) counts one request that the
// daemon snapshot also counts, so the two are never summed together.
const ifaceScope = daemonSnapshots.length > 0 ? "daemon" : ifaceRecords.length > 0 ? "request" : null;
const ifaceChosen = ifaceScope === "daemon" ? daemonSnapshots : ifaceRecords;
if (ifaceScope === "request" && daemonSnapshots.length === 0 && ifaceRecords.length > 0) {
	note("接口只有逐请求记录（VESTIGIO_IFACE_LOG=1 且守护进程快照缺失），按请求计数");
}
if (ifaceScope === null) note("没有 iface_snapshot 记录");

const ifaceRoutes = new Map();
const ifaceReasons = new Map();
let ifaceWindowMs = 0;
for (const record of ifaceChosen) {
	ifaceWindowMs += number(record.window_ms);
	for (const [route, counts] of Object.entries(record.routes ?? {})) {
		if (counts === null || typeof counts !== "object") continue;
		const current = ifaceRoutes.get(route) ?? { "2xx": 0, "4xx": 0, "5xx": 0, total: 0 };
		current["2xx"] += number(counts["2xx"]);
		current["4xx"] += number(counts["4xx"]);
		current["5xx"] += number(counts["5xx"]);
		current.total += number(counts.total);
		ifaceRoutes.set(route, current);
	}
	for (const [reason, count] of Object.entries(record.reasons ?? {})) {
		ifaceReasons.set(reason, (ifaceReasons.get(reason) ?? 0) + number(count));
	}
}
const ifaceTotals = [...ifaceRoutes.values()].reduce(
	(total, counts) => ({
		"2xx": total["2xx"] + counts["2xx"],
		"4xx": total["4xx"] + counts["4xx"],
		"5xx": total["5xx"] + counts["5xx"],
		total: total.total + counts.total,
	}),
	{ "2xx": 0, "4xx": 0, "5xx": 0, total: 0 },
);
const iface = {
	scope: ifaceScope,
	snapshots: ifaceChosen.length,
	window_ms: ifaceWindowMs,
	totals: ifaceTotals,
	routes: [...ifaceRoutes.entries()]
		.map(([route, counts]) => ({ route, ...counts, share_2xx: counts.total === 0 ? null : counts["2xx"] / counts.total }))
		.sort((left, right) => right.total - left.total)
		.slice(0, limit),
	reasons: [...ifaceReasons.entries()]
		.map(([reason, count]) => ({ reason, count }))
		.filter((entry) => entry.count > 0)
		.sort((left, right) => right.count - left.count),
};

/* ------------------------------------------------- 3) token 消耗 / 4) 耗时 */

const runTokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 };
let runCost = 0;
let runCostSeen = false;
let runIncomplete = 0;
let runDuration = 0;
let runDurationMax = 0;
for (const record of runRecords) {
	const tokens = record.tokens ?? {};
	for (const key of Object.keys(runTokens)) runTokens[key] += number(tokens[key]);
	if (tokens.cost_usd !== null && tokens.cost_usd !== undefined) {
		runCost += number(tokens.cost_usd);
		runCostSeen = true;
	}
	if (tokens.complete === false) runIncomplete += 1;
	const duration = record.duration_ms === undefined ? null : number(record.duration_ms);
	if (duration !== null) {
		runDuration += duration;
		runDurationMax = Math.max(runDurationMax, duration);
	}
}
const mainAgent = {
	runs: runRecords.length,
	tokens: { ...runTokens, cost_usd: runCostSeen ? runCost : null },
	tokens_mean: Object.fromEntries(Object.entries(runTokens).map(([key, value]) => [key, mean(value, runRecords.length)])),
	incomplete_runs: runIncomplete,
	duration_ms: runDuration,
	duration_ms_mean: mean(runDuration, runRecords.length),
	duration_ms_max: runRecords.length === 0 ? null : runDurationMax,
};

const invocations = new Map();
for (const record of recordsOf("model_invocation_start")) {
	if (project !== undefined && record.project_id !== project) continue;
	invocations.set(record.invocation_id ?? "", {
		agent: record.agent ?? "(unknown)",
		at: record.at ?? null,
		tokens: { in: 0, out: 0 },
		ended: false,
	});
}
for (const record of recordsOf("model_invocation_end")) {
	const invocation = invocations.get(record.invocation_id ?? "");
	if (invocation === undefined) {
		invocations.set(record.invocation_id ?? "", {
			agent: "(unknown)",
			at: null,
			tokens: { in: number(record.tokens?.in), out: number(record.tokens?.out) },
			ended: true,
		});
		continue;
	}
	invocation.ended = true;
	invocation.tokens.in = number(record.tokens?.in);
	invocation.tokens.out = number(record.tokens?.out);
	invocation.endAt = record.at ?? null;
}
const internal = new Map();
function internalFor(name) {
	const current = internal.get(name) ?? {
		agent: name,
		invocations: 0,
		invocations_unended: 0,
		calls: 0,
		tokens_in: 0,
		tokens_out: 0,
		invocation_ms: 0,
		invocation_ms_count: 0,
		call_ms: 0,
		outcomes: {},
	};
	internal.set(name, current);
	return current;
}
for (const invocation of invocations.values()) {
	if (agent === "main") continue;
	if (agent !== undefined && invocation.agent !== agent) continue;
	const current = internalFor(invocation.agent);
	current.invocations += 1;
	if (!invocation.ended) current.invocations_unended += 1;
	current.tokens_in += invocation.tokens.in;
	current.tokens_out += invocation.tokens.out;
	const span = invocation.at === null || invocation.endAt === undefined || invocation.endAt === null ? null : Date.parse(invocation.endAt) - Date.parse(invocation.at);
	if (span !== null && !Number.isNaN(span)) {
		current.invocation_ms += Math.max(0, span);
		current.invocation_ms_count += 1;
	}
}
for (const record of recordsOf("model_call")) {
	if (agent === "main") continue;
	const name = invocations.get(record.invocation_id ?? "")?.agent ?? "(unknown)";
	if (agent !== undefined && name !== agent) continue;
	const current = internalFor(name);
	current.calls += 1;
	current.call_ms += number(record.elapsed_ms);
	const outcome = record.outcome ?? "(unknown)";
	current.outcomes[outcome] = (current.outcomes[outcome] ?? 0) + 1;
}
const internalAgents = [...internal.values()]
	.map((current) => ({
		agent: current.agent,
		invocations: current.invocations,
		invocations_unended: current.invocations_unended,
		calls: current.calls,
		tokens_in: current.tokens_in,
		tokens_out: current.tokens_out,
		tokens_in_mean: mean(current.tokens_in, current.invocations),
		tokens_out_mean: mean(current.tokens_out, current.invocations),
		invocation_ms: current.invocation_ms,
		invocation_ms_mean: mean(current.invocation_ms, current.invocation_ms_count),
		call_ms: current.call_ms,
		call_ms_mean: mean(current.call_ms, current.calls),
		outcomes: current.outcomes,
	}))
	.sort((left, right) => right.invocations - left.invocations);

/* ------------------------------------------------------------ store 侧读取 */

const store = { path: storePath, size_bytes: null, open_mode: null, store_id: null, migrations: [] };
let db = null;
let tables = new Set();
if (storePath !== null && existsSync(storePath)) {
	try {
		try {
			db = new DatabaseSync(storePath, { readOnly: true });
			store.open_mode = "read-only";
		} catch {
			db = new DatabaseSync(storePath);
			db.exec("PRAGMA query_only = ON");
			store.open_mode = "query_only";
		}
		store.size_bytes = statSync(storePath).size;
	} catch (error) {
		db = null;
		note(`store 无法打开：${String(error)}`);
	}
} else if (storePath !== null) {
	note(`没有 store：${storePath}`);
} else {
	note("没有指定 store，store 相关项按 0 计");
}

if (db !== null) {
	try {
		tables = new Set(
			db
				.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name IS NOT NULL")
				.all()
				.map((row) => String(row.name)),
		);
	} catch (error) {
		note(`store 结构无法读取：${String(error)}`);
	}
}

/** `null` when the table is absent or the query fails; `[]` is a real empty result. */
function query(sql, ...params) {
	if (db === null) return null;
	try {
		return db.prepare(sql).all(...params);
	} catch (error) {
		note(`store 查询失败：${String(error)}`);
		return null;
	}
}

function tableRows(table, columns, where = "", params = []) {
	if (db !== null && !tables.has(table)) {
		note(`store 里没有 ${table} 表，相关项按 0 计`);
		return null;
	}
	return query(`SELECT ${columns} FROM ${table}${where}`, ...params);
}

/**
 * The conditions the store reads share. `--since` reaches the two tables that
 * timestamp an individual event; the counters are running totals with no time
 * column, so they stay lifetime and the report says so rather than printing a
 * ratio whose two halves came from different scopes.
 */
function conditionsOf(spec = {}) {
	const conditions = [];
	const params = [];
	for (const [sql, value] of spec.extra ?? []) {
		conditions.push(sql);
		params.push(value);
	}
	if (spec.project === true && project !== undefined) {
		conditions.push("project_id = ?");
		params.push(project);
	}
	if (spec.at !== undefined && since !== null) {
		conditions.push(`${spec.at} >= ?`);
		params.push(since);
	}
	return { sql: conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`, params };
}

const projectParams = project === undefined ? [] : [project];

if (db !== null && tables.has("store_meta")) {
	const row = query("SELECT store_id FROM store_meta");
	store.store_id = row?.[0]?.store_id === undefined ? null : String(row[0].store_id);
}
if (db !== null && tables.has("schema_migrations")) {
	const rows = query("SELECT version, name FROM schema_migrations ORDER BY version") ?? [];
	store.migrations = rows.map((row) => `${row.version}:${row.name}`);
}

/* ---------------------------------------------------------- 5) memory 注入 */

const turnScope = conditionsOf({ project: true, at: "at" });
const turnRows = tableRows("turn_events", "outcome, COUNT(*) AS n", `${turnScope.sql} GROUP BY outcome`, turnScope.params) ?? [];
const turnsByOutcome = Object.fromEntries(turnRows.map((row) => [String(row.outcome), number(row.n)]));
const turnTotal = Object.values(turnsByOutcome).reduce((total, count) => total + count, 0);
const delivered = turnsByOutcome["delivered"] ?? 0;
const hostCommand = turnsByOutcome["host_command"] ?? 0;
const denominator = turnTotal - hostCommand;

const usageScope = conditionsOf({ extra: [["kind = ?", "hit"]], at: "at" });
const usageRows = tableRows("usage_events", "channel, COUNT(*) AS n", `${usageScope.sql} GROUP BY channel`, usageScope.params) ?? [];
const usageByChannel = Object.fromEntries(usageRows.map((row) => [String(row.channel), number(row.n)]));
const usageTotal = Object.values(usageByChannel).reduce((total, count) => total + count, 0);

const receiptRows = tableRows("injection_receipts", "COUNT(*) AS n, COUNT(DISTINCT input_id) AS inputs", "", []);
const receipts = receiptRows === null ? 0 : number(receiptRows[0]?.n);
const receiptInputs = receiptRows === null ? 0 : number(receiptRows[0]?.inputs);

const activityRows = tableRows("project_activity", "SUM(activity_seq) AS n", "", []);
const activitySeq = activityRows === null ? 0 : number(activityRows[0]?.n);
const projectActivityRows = project === undefined ? null : tableRows("project_activity", "SUM(activity_seq) AS n", " WHERE project_id = ?", [project]);
const projectActivitySeq = projectActivityRows === null ? null : number(projectActivityRows[0]?.n);
const filtered = project !== undefined || since !== null;
if (filtered) {
	note("injection_receipts 与 usage_events 不带项目列、project_activity 不带时间列：这三项为全店累计，不与已过滤口径相减");
}

const injection = {
	turns: { total: turnTotal, by_outcome: turnsByOutcome, host_command: hostCommand, denominator },
	delivered,
	probability: denominator === 0 ? null : delivered / denominator,
	receipts,
	receipt_inputs: receiptInputs,
	usage: { total: usageTotal, by_channel: usageByChannel },
	activity_seq: activitySeq,
	project_activity_seq: projectActivitySeq,
	activity_probability: activitySeq === 0 ? null : receiptInputs / activitySeq,
	delta: filtered || denominator === 0 || activitySeq === 0 ? null : delivered / denominator - receiptInputs / activitySeq,
};

/* --------------------------------------------------------- 6) 记忆与临时池 */

const headRows = tableRows("memory_heads", "state, COUNT(*) AS n", " GROUP BY state", []) ?? [];
const headByState = Object.fromEntries(STATES.map((state) => [state, 0]));
for (const row of headRows) {
	if (headByState[String(row.state)] !== undefined) headByState[String(row.state)] = number(row.n);
}
const headTotal = Object.values(headByState).reduce((total, count) => total + count, 0);

let projectHeads = null;
if (project !== undefined && tables.has("memory_heads") && tables.has("memories")) {
	const rows =
		query(
			`SELECT h.state AS state, COUNT(*) AS n FROM memory_heads h JOIN memories m
			 ON m.memory_id = h.memory_id AND m.revision = h.revision WHERE m.project_id = ? GROUP BY h.state`,
			project,
		) ?? [];
	projectHeads = Object.fromEntries(STATES.map((state) => [state, 0]));
	for (const row of rows) {
		if (projectHeads[String(row.state)] !== undefined) projectHeads[String(row.state)] = number(row.n);
	}
}

const poolRows =
	tableRows(
		"hotspot_memberships",
		"project_id, COUNT(*) AS members",
		project === undefined ? " GROUP BY project_id ORDER BY members DESC" : " WHERE project_id = ? GROUP BY project_id",
		projectParams,
	) ?? [];
if (since !== null) note("记忆头版本与临时池是当前快照，不受 --since 影响");
const pool = poolRows.slice(0, limit).map((row) => {
	const members = number(row.members);
	return { project_id: String(row.project_id), members, capacity, occupancy: members / capacity };
});
if (pool.some((entry) => entry.occupancy > 1)) {
	note(`占用率超过 1：实际容量可能大于默认 ${DEFAULT_POOL_CAPACITY}，用 --capacity 指明确切值`);
}

const memory = {
	heads: { total: headTotal, by_state: headByState, temporary: headByState["medium_ready"] ?? 0 },
	project_heads: projectHeads,
	pool,
};

/* ------------------------------------------------------------------- report */

const elapsedMs = Date.now() - startedMs;
const report = {
	generated_at: new Date().toISOString(),
	elapsed_ms: elapsedMs,
	filters: { since, project: project ?? null, agent: agent ?? null, limit, capacity },
	store,
	streams: {
		dir: streams.dir,
		files: streams.files,
		lines: streams.lines,
		records: streams.records.length,
		skipped_lines: streams.skipped,
		unknown_records: streams.unknown,
		error: streams.error,
	},
	debug_switches: DEBUG_SWITCHES.map(([name, what]) => ({ env: name, what, on: process.env[name] === "1" })),
	run_summary: runSummary,
	iface,
	main_agent: mainAgent,
	internal_agents: internalAgents,
	injection,
	memory,
	notes,
};

function displayWidth(text) {
	let width = 0;
	for (const character of String(text)) {
		const code = character.codePointAt(0) ?? 0;
		width += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)) ? 2 : 1;
	}
	return width;
}

function pad(text, width) {
	const value = String(text);
	return value + " ".repeat(Math.max(0, width - displayWidth(value)));
}

function table(headers, rows) {
	const widths = headers.map((header, index) =>
		Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index] ?? ""))),
	);
	const lines = [headers.map((header, index) => pad(header, widths[index])).join("  ")];
	for (const row of rows) lines.push(row.map((cell, index) => pad(cell ?? "", widths[index])).join("  "));
	return lines;
}

function percent(value) {
	return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function fixed(value, digits = 1) {
	return value === null ? "—" : value.toFixed(digits);
}

function printHuman() {
	const storeLabel = store.path ?? "无 store";
	const lines = [
		`观测审计 · ${storeLabel} · ${report.generated_at}`,
		`观测目录 ${streams.dir ?? "无"} · 读取 ${streams.lines} 行（记录 ${streams.records.length}，损坏 ${streams.skipped}，未知 ${streams.unknown}）· 用时 ${elapsedMs} ms`,
	];
	if (streams.files.length > 0) lines.push(`文件：${streams.files.join(", ")}`);
	lines.push(`调试开关：${report.debug_switches.map((entry) => `${entry.env}=${entry.on ? "1" : "0"}（${entry.what}）`).join(" · ")}`);
	if (streams.error !== null) lines.push(`⚠ ${streams.error}`);

	lines.push("", `1) agent 运行记录 · ${runSummary.count} 条 · 共 ${runSummary.turns} turns`);
	if (runSummary.latest.length === 0) {
		lines.push("   无数据");
	} else {
		lines.push(
			...table(
				["started_at", "duration_ms", "outcome", "tokens.total", "turns", "models", "run_id"],
				runSummary.latest.map((record) => [
					record.started_at ?? "—",
					record.duration_ms === null ? "—" : String(record.duration_ms),
					record.outcome ?? "—",
					record.tokens_total === null ? "—" : String(record.tokens_total),
					String(record.turns),
					record.models.join(",") || "—",
					record.run_id ?? "—",
				]),
			).map((line) => `   ${line}`),
		);
	}

	lines.push("", `2) 接口调用 · ${iface.scope === null ? "无记录" : `scope ${iface.scope} · 全部 ${iface.totals.total} 次`}`);
	if (iface.scope !== null) {
		lines.push(
			`   状态占比：2xx ${iface.totals["2xx"]} (${percent(iface.totals.total === 0 ? null : iface.totals["2xx"] / iface.totals.total)}) · 4xx ${iface.totals["4xx"]} · 5xx ${iface.totals["5xx"]} · 窗口合计 ${iface.window_ms} ms`,
		);
		lines.push(
			...table(
				["route", "total", "2xx", "4xx", "5xx", "2xx 占比"],
				iface.routes.map((route) => [
					route.route,
					String(route.total),
					String(route["2xx"]),
					String(route["4xx"]),
					String(route["5xx"]),
					percent(route.share_2xx),
				]),
			).map((line) => `   ${line}`),
		);
		if (iface.reasons.length > 0) {
			lines.push(`   拒绝原因：${iface.reasons.map((reason) => `${reason.reason} ${reason.count}`).join(" · ")}`);
		}
	}

	lines.push("", "3) token 消耗（主 agent 与内部 agent 分开）");
	lines.push(
		`   主 agent · ${mainAgent.runs} 次 · 总 ${mainAgent.tokens.total} · 均 ${fixed(mainAgent.tokens_mean.total)} · in/out ${mainAgent.tokens.input}/${mainAgent.tokens.output} · cache ${mainAgent.tokens.cache_read}r/${mainAgent.tokens.cache_write}w · cost ${mainAgent.tokens.cost_usd === null ? "—" : `$${mainAgent.tokens.cost_usd.toFixed(4)}`} · 不完整 ${mainAgent.incomplete_runs} 次`,
	);
	if (internalAgents.length === 0) {
		lines.push("   内部 agent：无数据（需 VESTIGIO_MODEL_LOG=1）");
	} else {
		lines.push(
			...table(
				["agent", "invocations", "calls", "tokens_in", "tokens_out", "均 in/inv", "均 out/inv"],
				internalAgents.map((entry) => [
					entry.agent,
					String(entry.invocations),
					String(entry.calls),
					String(entry.tokens_in),
					String(entry.tokens_out),
					fixed(entry.tokens_in_mean),
					fixed(entry.tokens_out_mean),
				]),
			).map((line) => `   ${line}`),
		);
	}

	lines.push("", "4) 运行耗时");
	lines.push(
		`   主 agent · 总 ${mainAgent.duration_ms} ms · 均 ${fixed(mainAgent.duration_ms_mean)} ms · 最大 ${mainAgent.duration_ms_max ?? "—"} ms`,
	);
	if (internalAgents.length === 0) {
		lines.push("   内部 agent：无数据");
	} else {
		lines.push(
			...table(
				["agent", "invocation 总 ms", "均 ms", "调用总 ms", "调用均 ms"],
				internalAgents.map((entry) => [
					entry.agent,
					String(entry.invocation_ms),
					fixed(entry.invocation_ms_mean),
					String(entry.call_ms),
					fixed(entry.call_ms_mean),
				]),
			).map((line) => `   ${line}`),
		);
	}

	lines.push("", "5) memory 注入");
	const outcomes = Object.entries(turnsByOutcome)
		.sort((left, right) => right[1] - left[1])
		.map(([outcome, count]) => `${outcome} ${count}`)
		.join(" · ");
	lines.push(`   turn 行 ${turnTotal}${outcomes === "" ? "" : `（${outcomes}）`} · 分母 ${denominator}（去掉 host_command ${hostCommand}）`);
	lines.push(
		`   注入概率 ${delivered}/${denominator} = ${percent(injection.probability)} · 旧口径（全店累计）${receiptInputs}/${activitySeq} = ${percent(injection.activity_probability)} · 差 ${injection.delta === null ? "—" : `${(injection.delta * 100).toFixed(1)} pt`}`,
	);
	if (injection.project_activity_seq !== null) {
		lines.push(`   项目 activity_seq ${injection.project_activity_seq} · 全店 activity_seq ${activitySeq}`);
	}
	lines.push(
		`   receipts ${receipts} 条（${receiptInputs} 个输入）· usage_events(kind=hit) ${usageTotal}${Object.keys(usageByChannel).length === 0 ? "" : `（${Object.entries(usageByChannel).map(([channel, count]) => `${channel} ${count}`).join(" · ")}）`}`,
	);

	lines.push("", `6) 记忆与临时池 · 总 ${memory.heads.total}`);
	lines.push(
		`   ${STATES.map((state) => `${state} ${memory.heads.by_state[state] ?? 0}`).join(" · ")} · 临时记忆（medium_ready）${memory.heads.temporary}`,
	);
	if (memory.project_heads !== null) {
		lines.push(
			`   项目 ${project} 头版本 ${Object.values(memory.project_heads).reduce((total, count) => total + count, 0)}（${STATES.map((state) => `${state} ${memory.project_heads[state] ?? 0}`).join(" · ")}）`,
		);
	}
	if (memory.pool.length === 0) {
		lines.push("   临时记忆池：无成员");
	} else {
		lines.push(
			...table(
				["project_id", "members", "capacity", "occupancy"],
				memory.pool.map((entry) => [entry.project_id, String(entry.members), String(entry.capacity), entry.occupancy.toFixed(3)]),
			).map((line) => `   ${line}`),
		);
	}

	if (notes.length > 0) {
		lines.push("", "说明：");
		for (const message of notes) lines.push(`   · ${message}`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else printHuman();
