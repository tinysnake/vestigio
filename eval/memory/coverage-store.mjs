#!/usr/bin/env node
/**
 * Measure write coverage of a store the product filled: for every durable
 * coverage row, ask the store the row's own question and record whether any
 * card came back. This is the read side of the join described in
 * docs/memory-eval-coverage.md; a row that returns nothing is a memory the
 * store never formed, or never made reachable.
 *
 *   node ./coverage-store.mjs --store /tmp/store-copy.sqlite --project /abs/project
 *   node ./coverage-store.mjs --store ... --project ... --out out/coverage-store.json
 *
 * The CLI opens a store read-write (WAL, migrations), so this script copies the
 * source and its -wal/-shm siblings to a temp directory and queries the copy.
 * A missing source path fails loudly instead of creating an empty store.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../../packages/cli/bin/vestigio");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const source = flag("store", null);
const project = flag("project", null);
if (source === null || project === null) {
	console.error("usage: coverage-store.mjs --store <sqlite> --project <abs path> [--in coverage.jsonl] [--out file.json]");
	process.exit(2);
}
const sourcePath = resolve(source);
if (!existsSync(sourcePath)) {
	console.error(`no store at ${sourcePath}`);
	process.exit(2);
}
const input = resolve(flag("in", "coverage.jsonl"));
const out = flag("out", null);

const rows = readFileSync(input, "utf8")
	.split("\n")
	.filter((line) => line.trim().length > 0)
	.map((line) => JSON.parse(line));
const durable = rows.filter((row) => row.answer_lives != null && row.durable === true && row.answer_lives !== "nowhere");
if (durable.length === 0) {
	console.error(`no durable rows in ${input}; nothing to measure`);
	process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "vestigio-coverage-"));
const copy = join(scratch, "store.sqlite");
try {
	copyFileSync(sourcePath, copy);
	for (const suffix of ["-wal", "-shm"]) {
		if (existsSync(`${sourcePath}${suffix}`)) copyFileSync(`${sourcePath}${suffix}`, `${copy}${suffix}`);
	}

	const scored = durable.map((row) => {
		const raw = execFileSync(
			CLI,
			["search", "--db", copy, "--project", project, "--query", row.question, "--json"],
			{ encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
		);
		const report = JSON.parse(raw);
		const cards = report.result?.cards ?? [];
		const uris = cards.map((card) => card.uri ?? card.memory_uri);
		const expected = Array.isArray(row.expected_memory_ids) ? row.expected_memory_ids : [];
		return {
			id: row.id,
			status: report.result?.status ?? "error",
			card_count: cards.length,
			top: uris[0] ?? null,
			expected_memory_ids: expected,
			expected_found: expected.filter((memoryId) => uris.some((uri) => uri?.endsWith(`/${memoryId}`))).length,
		};
	});

	const withCards = scored.filter((row) => row.card_count > 0);
	const expectedRows = scored.filter((row) => row.expected_memory_ids.length > 0);
	const report = {
		schema_version: 1,
		generated_at: new Date().toISOString(),
		kind: "store-coverage",
		source: { store: sourcePath, project, cases: input },
		durable_rows: durable.length,
		rows_with_a_card: withCards.length,
		/** Share of durable questions this store could return anything for. */
		read_coverage: withCards.length / durable.length,
		/** Share of labelled rows whose expected memory came back, when labels exist. */
		expected_rows: expectedRows.length,
		expected_rows_found: expectedRows.filter((row) => row.expected_found > 0).length,
		status_counts: Object.fromEntries(
			[...new Set(scored.map((row) => row.status))].sort().map((status) => [status, scored.filter((row) => row.status === status).length]),
		),
		empty_rows: scored.filter((row) => row.card_count === 0).map((row) => row.id),
		/** A question that returns any card counts as covered, so unrelated cards inflate this. */
		rows: scored,
	};

	if (out) {
		const path = resolve(out);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
		console.log(`report ${path}`);
	}
	console.log(
		`durable rows ${report.durable_rows} | returned a card ${report.rows_with_a_card} | read coverage ${(report.read_coverage * 100).toFixed(1)}% | ${Object.entries(report.status_counts).map(([status, count]) => `${status}=${count}`).join(" ")}`,
	);
	if (report.expected_rows > 0) {
		console.log(`labelled rows ${report.expected_rows} | expected memory returned ${report.expected_rows_found}`);
	}
	if (report.empty_rows.length > 0) console.log(`no card: ${report.empty_rows.join(", ")}`);
	if (report.rows_with_a_card === 0) {
		console.log("warning: no durable question returned a card; check the store copy and project id before reading this as a write gap");
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
