#!/usr/bin/env node
/**
 * Read-only inventory of a store nobody seeded, plus Memory Gap accounting.
 *
 * run.mjs measures the lab: a fresh store built from catalog.mjs with known
 * content. This audits the other thing — the store the product itself filled,
 * the one VESTIGIO_STORE points at — and answers what the lab cannot: what is
 * actually in there, whether the memory ids a labelled question expects exist
 * at all, and whether the product has ever really run against it.
 *
 * `--pin <memory_id>@<revision>` is the replay handle. A timestamp cannot be
 * one: every revision of a memory carries the same immutable `created_at` (the
 * memory's creation time — saving a revision with a different one is rejected
 * as `created_at_mismatch`, packages/core/src/storage/store.ts:309) and its
 * `updated_at` is refreshed by delivery, so the store records no per-revision
 * time. Pinning a revision is therefore how a past state is named.
 *
 * Nothing here writes. The file is opened read-only (with a query_only fallback
 * for a store that is mid-write) and every statement is a SELECT, so a live
 * agent can be audited while it works.
 *
 * Usage (from eval/memory):
 *   node ./audit.mjs --store ~/.vestigio/store.sqlite [--cases cases.jsonl] [--out out/audit.json]
 *   node ./audit.mjs --store <copy> --pin mem-deploy-port@1 --cases cases.jsonl
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) return null;
	if (process.argv[index + 1] === undefined) throw new Error(`${name} needs a value`);
	return process.argv[index + 1];
}

function argumentsOf(name) {
	const values = [];
	for (let index = 0; index < process.argv.length; index += 1) {
		if (process.argv[index] !== name) continue;
		if (process.argv[index + 1] === undefined) throw new Error(`${name} needs a value`);
		values.push(process.argv[index + 1]);
	}
	return values;
}

const storeArgument = argument("--store") ?? process.env.VESTIGIO_STORE ?? "";
if (storeArgument === "") {
	console.error("audit.mjs needs --store <path> (or VESTIGIO_STORE)");
	process.exit(2);
}
const storePath = resolve(storeArgument);
if (!existsSync(storePath)) {
	console.error(`no store at ${storePath}`);
	process.exit(2);
}

const casesPath = argument("--cases");
const outPath = resolve(argument("--out") ?? "out/audit.json");
const pinArguments = argumentsOf("--pin").map((value) => {
	const at = value.lastIndexOf("@");
	const revision = at === -1 ? Number.NaN : Number(value.slice(at + 1));
	if (at === -1 || !Number.isInteger(revision) || revision < 1) {
		console.error(`--pin needs <memory_id>@<revision>, got ${value}`);
		process.exit(2);
	}
	return { memory_id: value.slice(0, at), revision };
});

/** A live store holds a write lock; read-only open can fail on WAL recovery. */
function open(path) {
	try {
		return { db: new DatabaseSync(path, { readOnly: true }), mode: "read-only" };
	} catch {
		const db = new DatabaseSync(path);
		db.exec("PRAGMA query_only = ON");
		return { db, mode: "query_only" };
	}
}

const { db, mode } = open(storePath);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const one = (sql, ...params) => db.prepare(sql).get(...params) ?? {};

const tableExists = (name) =>
	all("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name IS NOT NULL").some(
		(row) => row.name === name,
	);

const store = {
	path: storePath,
	size_bytes: statSync(storePath).size,
	open_mode: mode,
	store_id: tableExists("store_meta") ? String(one("SELECT store_id FROM store_meta").store_id ?? "") : null,
	migrations: tableExists("schema_migrations")
		? all("SELECT version, name FROM schema_migrations ORDER BY version").map((row) => `${row.version}:${row.name}`)
		: [],
};

const HEAD_COLUMNS = `memory_id, revision, state, scope_kind, project_id,
	medium_body_char_count AS body_chars, nav_text, updated_at, hit_count, access_count`;
const HEAD_COLUMNS_ON_M = `m.memory_id, m.revision, m.state, m.scope_kind, m.project_id,
	m.medium_body_char_count AS body_chars, m.nav_text, m.updated_at, m.hit_count, m.access_count`;

/**
 * The heads under the given pins: a pinned memory reports the revision asked
 * for, every other memory reports its current head. That is what a replay
 * fixture needs — a state named by revision, not by time.
 */
function heads(pins) {
	const pinned = new Map(pins.map((pin) => [pin.memory_id, pin]));
	const rows = [];
	const applied = [];
	for (const pin of pins) {
		const row = one(`SELECT ${HEAD_COLUMNS} FROM memories WHERE memory_id = ? AND revision = ?`, pin.memory_id, pin.revision);
		if (row.memory_id === undefined) {
			applied.push({ ...pin, applied: false, reason: "no such memory id or revision in this store" });
			continue;
		}
		rows.push(row);
		applied.push({ ...pin, applied: true, state: String(row.state), body_chars: Number(row.body_chars) });
	}
	const excluded = pins.map((pin) => pin.memory_id);
	const placeholders = excluded.map(() => "?").join(", ") || "''";
	const rest = all(
		`SELECT ${HEAD_COLUMNS_ON_M} FROM memory_heads h JOIN memories m
		 ON m.memory_id = h.memory_id AND m.revision = h.revision
		 WHERE h.memory_id NOT IN (${placeholders})`,
		...excluded,
	);
	return { rows: [...rows, ...rest], applied };
}

const { rows: headRows, applied: pins } = heads(pinArguments);
const rejected = pins.filter((pin) => !pin.applied);
if (rejected.length > 0) {
	console.error(`no such revision: ${rejected.map((pin) => `${pin.memory_id}@${pin.revision}`).join(", ")}`);
	process.exit(2);
}

const sum = (key) => headRows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
function groupBy(list, key) {
	const counts = new Map();
	for (const row of list) {
		const value = key(row) ?? null;
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

const revisionsPerMemory = all(
	"SELECT memory_id, COUNT(*) AS n, MAX(revision) AS head FROM memories GROUP BY memory_id ORDER BY n DESC, memory_id",
);
const memories = {
	revisions: Number(one("SELECT COUNT(*) AS n FROM memories").n ?? 0),
	ids: headRows.length,
	heads_by_state: groupBy(headRows, (row) => String(row.state)).map(([value, count]) => ({ state: value, count })),
	by_project: groupBy(
		headRows,
		(row) => `${String(row.scope_kind)}\u0000${row.project_id === null ? "" : String(row.project_id)}`,
	).map(([key, count]) => {
		const [scope_kind, project_id] = key.split("\u0000");
		return { scope_kind, project_id: project_id === "" ? null : project_id, count };
	}),
	medium_chars_total: sum("body_chars"),
	with_navigation: headRows.filter((row) => row.nav_text !== null).length,
	newest_updated_at: headRows.map((row) => String(row.updated_at)).sort().at(-1) ?? null,
	hits_total: sum("hit_count"),
	accesses_total: sum("access_count"),
	/** History is what a replay can pin: a memory with one revision has none. */
	with_history: revisionsPerMemory.filter((row) => Number(row.n) > 1).length,
	max_revisions: revisionsPerMemory.length === 0 ? 0 : Number(revisionsPerMemory[0].n),
};

const pendingStale = all(
	"SELECT memory_id, reason, created_at, excerpt_char_count FROM stale_events WHERE acknowledged_at IS NULL ORDER BY created_at ASC",
).map((row) => ({
	memory_id: String(row.memory_id),
	reason: String(row.reason),
	created_at: String(row.created_at),
	excerpt_chars: Number(row.excerpt_char_count),
}));

const stale = {
	pending: pendingStale.length,
	acknowledged: Number(one("SELECT COUNT(*) AS n FROM stale_events WHERE acknowledged_at IS NOT NULL").n ?? 0),
	oldest_pending_at: pendingStale.length === 0 ? null : pendingStale[0].created_at,
	per_memory: pendingStale,
};

const hotspots = {
	memberships: Number(one("SELECT COUNT(*) AS n FROM hotspot_memberships").n ?? 0),
	by_project: all(
		"SELECT project_id, COUNT(*) AS n, SUM(CASE WHEN last_hit_seq > 0 THEN 1 ELSE 0 END) AS ever_hit FROM hotspot_memberships GROUP BY project_id ORDER BY n DESC",
	).map((row) => ({
		project_id: String(row.project_id),
		count: Number(row.n),
		ever_hit: Number(row.ever_hit),
	})),
};

const activity = all("SELECT project_id, activity_seq, last_input_at FROM project_activity ORDER BY activity_seq DESC").map(
	(row) => ({
		project_id: String(row.project_id),
		activity_seq: Number(row.activity_seq),
		last_input_at: String(row.last_input_at),
	}),
);

const fts = {
	active_rows: Number(one("SELECT COUNT(*) AS n FROM memory_fts_active").n ?? 0),
	archived_rows: Number(one("SELECT COUNT(*) AS n FROM memory_fts_archived").n ?? 0),
};

const runtime = {
	resolve_versions: Number(one("SELECT COUNT(*) AS n FROM resolve_versions").n ?? 0),
	resolve_versions_saved: Number(one("SELECT COUNT(*) AS n FROM resolve_versions WHERE stage = 'saved'").n ?? 0),
	summary_jobs_by_state: all("SELECT state, COUNT(*) AS n FROM summary_jobs GROUP BY state ORDER BY state").map((row) => ({
		state: String(row.state),
		count: Number(row.n),
	})),
	requests_by_status: all("SELECT status, COUNT(*) AS n FROM memory_requests GROUP BY status ORDER BY n DESC").map((row) => ({
		status: String(row.status),
		count: Number(row.n),
	})),
	injection_receipts: Number(one("SELECT COUNT(*) AS n FROM injection_receipts").n ?? 0),
	usage_events: Number(one("SELECT COUNT(*) AS n FROM usage_events").n ?? 0),
	usage_events_by_channel: all("SELECT channel, COUNT(*) AS n FROM usage_events GROUP BY channel ORDER BY n DESC").map((row) => ({
		channel: String(row.channel),
		count: Number(row.n),
	})),
};

/** Memory Gap: an expected id the store does not hold under the current pins. */
function coverage(path) {
	const cases = readFileSync(path)
		.toString("utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
	const present = new Set(headRows.map((row) => String(row.memory_id)));
	const expected = [];
	const gapRows = [];
	for (const item of cases) {
		const ids = item.expected_memory_ids ?? [];
		if (ids.length === 0) continue;
		const missing = ids.filter((id) => !present.has(id));
		expected.push(...ids);
		if (missing.length > 0) {
			gapRows.push({ case_id: item.id, surface: item.surface, expected_memory_ids: ids, absent: missing });
		}
	}
	const presentExpected = expected.filter((id) => present.has(id));
	return {
		cases: cases.length,
		rows_with_a_gap: gapRows.length,
		expectations: expected.length,
		present: presentExpected.length,
		absent: expected.length - presentExpected.length,
		/** Share of the labelled expectations this store state could answer at all. */
		store_coverage: expected.length === 0 ? null : presentExpected.length / expected.length,
		absent_ids: [...new Set(expected.filter((id) => !present.has(id)))],
		gap_rows: gapRows,
	};
}

const report = {
	schema_version: 1,
	generated_at: new Date().toISOString(),
	kind: "store-audit",
	source: { store: storePath, read_only: true, open_mode: mode },
	replay:
		pinArguments.length === 0
			? null
			: {
					pins: pins.map((pin) => ({ memory_id: pin.memory_id, revision: pin.revision, state: pin.state, body_chars: pin.body_chars })),
					unpinned_memories: headRows.length - pinArguments.length,
					note: "A pin names a revision, not a time: every revision of a memory shares one immutable created_at and its updated_at is refreshed by delivery.",
				},
	store,
	memories,
	stale,
	hotspots,
	activity,
	fts,
	runtime,
	coverage: casesPath === null ? null : coverage(resolve(casesPath)),
};

// Activity alone does not prove delivery — recordProjectInput writes it for any
// input, including the lab's. Receipts, resolver versions, usage events and hit
// counters are the rows only a real delivery writes, so they decide the verdict.
const delivered =
	runtime.injection_receipts > 0 || runtime.usage_events > 0 || runtime.resolve_versions > 0 || memories.hits_total > 0;
report.verdict = {
	product_has_run_here: delivered,
	notes: [
		delivered
			? "Delivery rows exist (receipts, resolver versions, usage events or hit counters), so these counts are production data, not a fixture."
			: activity.length > 0
				? "Inputs were recorded but nothing was ever delivered: hotspots were built, no memory reached a session."
				: "No usage evidence at all: the store may be freshly created, or the agent has never run against it.",
		report.coverage === null
			? "No --cases file given, so no Memory Gap accounting; a gap needs a labelled question to be visible."
			: "A gap means the labelled question expects an id this store does not hold — the memory was never formed, not merely unfound.",
	],
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
console.log(`store ${storePath} (${(store.size_bytes / 1024).toFixed(0)} KiB, ${store.open_mode})`);
console.log(`store_id ${store.store_id ?? "?"}; migrations ${store.migrations.length}`);
console.log(
	`memories: ${memories.ids} heads / ${memories.revisions} revisions; ${memories.medium_chars_total} body chars; ${memories.with_history} with history (max ${memories.max_revisions} revisions)`,
);
console.log(`heads: ${memories.heads_by_state.map((row) => `${row.state}=${row.count}`).join(" ")}`);
if (report.replay !== null) {
	console.log(
		`replay pins: ${report.replay.pins.map((pin) => `${pin.memory_id}@${pin.revision} (${pin.state})`).join(", ")}; ${report.replay.unpinned_memories} heads at current revision`,
	);
}
console.log(`stale events: ${stale.pending} pending, ${stale.acknowledged} acknowledged`);
console.log(`hotspots: ${hotspots.memberships} memberships across ${hotspots.by_project.length} projects`);
console.log(`runtime: ${runtime.injection_receipts} injection receipts, ${runtime.usage_events} usage events`);
if (report.coverage !== null) {
	console.log(
		`coverage: ${pct(report.coverage.store_coverage)} of labelled expectations present (${report.coverage.present}/${report.coverage.expectations} ids)`,
	);
	console.log(`absent ids: ${report.coverage.absent_ids.join(", ") || "none"}`);
}
console.log(`verdict: product has run here = ${delivered}`);
console.log(`report ${outPath}`);
db.close();
