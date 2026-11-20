#!/usr/bin/env node
/**
 * Which lexical gather strategy finds what.
 *
 * The store's default search is conjunctive: every unigram and bigram of the
 * query has to occur in one memory. That is why a question naming two topics
 * (`迁移 端口`) finds nothing. This script measures the alternatives on every
 * labelled row we have, without touching production code:
 *
 *   and        the shipped default
 *   or         the same tokens joined with OR
 *   split      every whitespace-separated term searched on its own, unioned
 *
 * It measures the lexical layer only: no layers, no budget, no judge.
 *
 * Usage (from eval/memory):
 *   node --import ../pi/hook.mjs ./strategies.mjs [--out <path>]
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { matchHotspots } from "@vestigio/core/hotspots";
import { evaluatePool } from "@vestigio/core/hotspots";
import { openStore } from "@vestigio/core/storage";
import { CATALOG_VERSION, seedStore } from "./catalog.mjs";

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) return null;
	if (process.argv[index + 1] === undefined) throw new Error(`${name} needs a value`);
	return process.argv[index + 1];
}

const outPath = resolve(argument("--out") ?? "out/strategies.json");
const LIMIT = 10;
// `--source cases.jsonl` restricts the measurement to the hand-confirmed rows,
// which is the trustworthy subset; the candidate batches are drafts.
const sourceArgument = argument("--source");
const SOURCES =
	sourceArgument === null
		? [
				"cases.jsonl",
				"candidates.jsonl",
				"candidates.batch-2.jsonl",
				"candidates.batch-3.jsonl",
				"candidates.batch-4.jsonl",
			]
		: [sourceArgument];

const tempDir = mkdtempSync(join(tmpdir(), "vestigio-strategies-"));
const store = openStore({ path: join(tempDir, "store.sqlite") });
seedStore(store);

function readRows(path) {
	let text;
	try {
		text = readFileSync(resolve(path), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line))
		// Both sides matter: a positive row says what recall costs, a row that
		// forbids an id says what precision costs. Rows that assert nothing are
		// dropped.
		.filter((row) => (row.expected_memory_ids ?? []).length > 0 || (row.forbidden_memory_ids ?? []).length > 0)
		.map((row) => ({ ...row, source: path }));
}

const rows = SOURCES.flatMap(readRows);

function ids(hits) {
	return hits.map((hit) => hit.uri.split("/").pop() ?? hit.uri);
}

function searchAnd(text, projectId) {
	return ids(store.searchActive(text, { scope: { kind: "project", project_id: projectId }, limit: LIMIT }));
}

function searchOr(text, projectId) {
	return ids(
		store.searchActive(text, {
			scope: { kind: "project", project_id: projectId },
			limit: LIMIT,
			mode: "any",
		}),
	);
}

function searchSplit(text, projectId) {
	const seen = [];
	for (const term of text.split(/\s+/).filter((part) => part !== "")) {
		for (const id of searchAnd(term, projectId)) {
			if (!seen.includes(id)) seen.push(id);
		}
	}
	return seen;
}

/**
 * The interesting candidate is not "always split" but "keep the AND query, and
 * only when it returns nothing, try again". That leaves every query that works
 * today untouched, and prices the fallback purely on the queries that are
 * currently silent.
 */
function andThenSplit(text, projectId) {
	const first = searchAnd(text, projectId);
	return first.length > 0 ? first : searchSplit(text, projectId);
}

function andThenOr(text, projectId) {
	const first = searchAnd(text, projectId);
	return first.length > 0 ? first : searchOr(text, projectId);
}

/**
 * The fallback that reuses the layer already tuned for precision: the hotspot
 * matcher. It requires a whole alias, a contiguous alias phrase, or two
 * independent tokens, so it cannot answer with a lone shared word the way a raw
 * split does.
 */
const pools = new Map();
function poolFor(projectId) {
	let pool = pools.get(projectId);
	if (pool === undefined) {
		pool = evaluatePool({ store, project_id: projectId, activity_seq: 10 });
		pools.set(projectId, pool);
	}
	return pool;
}

function searchHotspot(text, projectId, minScore) {
	const pool = poolFor(projectId);
	const input = { entries: pool.entries, text, activity_seq: pool.activity_seq };
	return matchHotspots(minScore === undefined ? input : { ...input, min_score: minScore }).map(
		(match) => match.memory_id,
	);
}

function andThenHotspot(text, projectId) {
	const first = searchAnd(text, projectId);
	return first.length > 0 ? first : searchHotspot(text, projectId);
}

function andThenHotspotScored(minScore) {
	return (text, projectId) => {
		const first = searchAnd(text, projectId);
		return first.length > 0 ? first : searchHotspot(text, projectId, minScore);
	};
}

const STRATEGIES = {
	and: { run: searchAnd, calls: () => 1, fallback: false },
	or: { run: searchOr, calls: () => 1, fallback: false },
	split: { run: searchSplit, calls: (text) => text.split(/\s+/).filter((part) => part !== "").length, fallback: false },
	and_then_split: { run: andThenSplit, calls: (text) => text.split(/\s+/).filter((part) => part !== "").length, fallback: true },
	and_then_or: { run: andThenOr, calls: () => 1, fallback: true },
	and_then_hotspot: { run: andThenHotspot, calls: () => 1, fallback: true },
	and_then_hotspot_2: { run: andThenHotspotScored(2), calls: () => 1, fallback: true },
	and_then_hotspot_3: { run: andThenHotspotScored(3), calls: () => 1, fallback: true },
};

const positives = rows.filter((row) => (row.expected_memory_ids ?? []).length > 0);
const negatives = rows.filter(
	(row) => (row.expected_memory_ids ?? []).length === 0 && (row.forbidden_memory_ids ?? []).length > 0,
);

const perStrategy = {};
for (const [name, strategy] of Object.entries(STRATEGIES)) {
	const found = [];
	const full = [];
	let noise = 0;
	let noiseRows = 0;
	let calls = 0;
	for (const row of positives) {
		const expected = row.expected_memory_ids ?? [];
		const surfaced = strategy.run(row.text, row.project_id);
		calls += strategy.calls(row.text);
		const present = expected.filter((id) => surfaced.includes(id));
		if (present.length > 0) found.push(row.id);
		if (present.length === expected.length) full.push(row.id);
		// Noise is what a hit drags in beside the memory it was asked for: the
		// budget has to spend context on it, so a strategy that finds everything
		// by returning everything is not free.
		const extra = surfaced.filter((id) => !expected.includes(id)).length;
		if (present.length > 0 && extra > 0) {
			noise += extra;
			noiseRows += 1;
		}
	}
	const leaks = [];
	let fired = 0;
	for (const row of negatives) {
		const surfaces = strategy.run(row.text, row.project_id);
		calls += strategy.calls(row.text);
		if (strategy.fallback && searchAnd(row.text, row.project_id).length === 0) fired += 1;
		const forbidden = row.forbidden_memory_ids ?? [];
		if (forbidden.some((id) => (id === "*" ? surfaces.length > 0 : surfaces.includes(id)))) {
			leaks.push(row.id);
		}
	}
	perStrategy[name] = {
		positive_rows: positives.length,
		all_expected_found: full.length,
		negative_rows: negatives.length,
		fallback_fired_on_negatives: fired,
		forbidden_leaks: leaks.length,
		noise_ids_beside_a_hit: noise,
		rows_with_noise: noiseRows,
		search_calls: calls,
		missing_all: positives.filter((row) => !full.includes(row.id)).map((row) => row.id),
		leaked: leaks,
	};
}

const report = {
	schema_version: 1,
	generated_at: new Date().toISOString(),
	catalog_version: CATALOG_VERSION,
	limit: LIMIT,
	sources: SOURCES,
	rows: rows.length,
	strategies: perStrategy,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

const header = [
	"strategy",
	"all expected",
	"noise beside a hit",
	"negative leaks",
	"fallback fired",
	"search calls",
];
console.log(`| ${header.join(" | ")} |`);
console.log(`| ${header.map(() => "---").join(" | ")} |`);
for (const [name, value] of Object.entries(perStrategy)) {
	console.log(
		`| ${name} | ${value.all_expected_found}/${value.positive_rows} | ${value.noise_ids_beside_a_hit} (${value.rows_with_noise} rows) | ${value.forbidden_leaks}/${value.negative_rows} | ${value.fallback_fired_on_negatives} | ${value.search_calls} |`,
	);
}
console.log(`report: ${outPath}`);
