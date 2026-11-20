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
 * Nothing here writes. The file is opened read-only (with a query_only
 * fallback for a store that is mid-write) and every statement is a SELECT, so
 * a live agent can be audited while it works.
 *
 * Usage (from eval/memory):
 *   node ./audit.mjs --store ~/.vestigio/store.sqlite [--cases cases.jsonl] [--out out/audit.json]
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) return null;
	if (process.argv[index + 1] === undefined) throw new Error(`${name} needs a value`);
	return process.argv[index + 1];
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
const all = (sql) => db.prepare(sql).all();
const one = (sql) => db.prepare(sql).get() ?? {};

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

const memories = {
	revisions: Number(one("SELECT COUNT(*) AS n FROM memories").n ?? 0),
	ids: Number(one("SELECT COUNT(DISTINCT memory_id) AS n FROM memories").n ?? 0),
	heads_by_state: all("SELECT state, COUNT(*) AS n FROM memory_heads GROUP BY state ORDER BY state").map((row) => ({
		state: String(row.state),
		count: Number(row.n),
	})),
	by_project: all(
		"SELECT scope_kind, project_id, COUNT(*) AS n FROM memory_heads h JOIN memories m ON m.memory_id = h.memory_id AND m.revision = h.revision GROUP BY scope_kind, project_id ORDER BY n DESC",
	).map((row) => ({
		scope_kind: String(row.scope_kind),
		project_id: row.project_id === null ? null : String(row.project_id),
		count: Number(row.n),
	})),
	medium_chars_total: Number(one("SELECT COALESCE(SUM(medium_body_char_count), 0) AS n FROM memories").n ?? 0),
	with_navigation: Number(one("SELECT COUNT(*) AS n FROM memory_heads h JOIN memories m ON m.memory_id = h.memory_id AND m.revision = h.revision WHERE m.nav_text IS NOT NULL").n ?? 0),
	oldest_updated_at: one("SELECT MIN(updated_at) AS t FROM memories").t ?? null,
	newest_updated_at: one("SELECT MAX(updated_at) AS t FROM memories").t ?? null,
	hits_total: Number(one("SELECT COALESCE(SUM(hit_count), 0) AS n FROM memories").n ?? 0),
	accesses_total: Number(one("SELECT COALESCE(SUM(access_count), 0) AS n FROM memories").n ?? 0),
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
	acknowledged: Number(
		one("SELECT COUNT(*) AS n FROM stale_events WHERE acknowledged_at IS NOT NULL").n ?? 0,
	),
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

/** Memory Gap: an expected id that is not in this store at all. */
function coverage(path) {
	const cases = readFileSync(path)
		.toString("utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
	const present = new Set(all("SELECT DISTINCT memory_id FROM memories").map((row) => String(row.memory_id)));
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
		/** Share of the labelled expectations this store could answer at all. */
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
const delivered = runtime.injection_receipts > 0 || runtime.usage_events > 0 || runtime.resolve_versions > 0 || memories.hits_total > 0;
const used = delivered;
report.verdict = {
	product_has_run_here: used,
	notes: [
		delivered
			? "Delivery rows exist (receipts, resolver versions, usage events or hit counters), so these counts are production data, not a fixture."
			: activity.length > 0
				? "Inputs were recorded but nothing was ever delivered: hotspots were built, no memory reached a session."
				: "No usage evidence at all: the store may be freshly created, or the agent has never run against it.",
		report.coverage === null
			? "No --cases file given, so no Memory Gap accounting; a gap needs a labelled question to be visible."
			: "A gap means the labelled question expects an id this store does not contain — the memory was never formed, not merely unfound.",
	],
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
console.log(`store ${storePath} (${(store.size_bytes / 1024).toFixed(0)} KiB, ${store.open_mode})`);
console.log(`store_id ${store.store_id ?? "?"}; migrations ${store.migrations.length}`);
console.log(
	`memories: ${memories.ids} ids / ${memories.revisions} revisions; ${memories.medium_chars_total} body chars; ${memories.with_navigation} with navigation`,
);
console.log(`heads: ${memories.heads_by_state.map((row) => `${row.state}=${row.count}`).join(" ")}`);
console.log(`stale events: ${stale.pending} pending, ${stale.acknowledged} acknowledged`);
console.log(`hotspots: ${hotspots.memberships} memberships across ${hotspots.by_project.length} projects`);
console.log(`runtime: ${runtime.injection_receipts} injection receipts, ${runtime.usage_events} usage events`);
if (report.coverage !== null) {
	console.log(
		`coverage: ${pct(report.coverage.store_coverage)} of labelled expectations present (${report.coverage.present}/${report.coverage.expectations} ids)`,
	);
	console.log(`absent ids: ${report.coverage.absent_ids.join(", ") || "none"}`);
}
console.log(`verdict: product has run here = ${used}`);
console.log(`report ${outPath}`);
db.close();
