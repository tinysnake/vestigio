#!/usr/bin/env node
/**
 * Offline memory evaluation: every labeled case runs through the real inject or
 * search path against a seeded throwaway store, and the report is diffable by
 * compare.mjs.
 *
 * Usage (from eval/memory):
 *   node --import ../pi/hook.mjs ./run.mjs [--cases <path>] [--out <path>] [--store <path>] [--keep]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InjectionLedger, planInjection, recordProjectInput } from "@vestigio/core/hotspots";
import { layeredSearch } from "@vestigio/core/retrieval";
import { openStore } from "@vestigio/core/storage";
import { AT, CATALOG_VERSION, seedStore } from "./catalog.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FAILING = new Set(["miss", "false_positive"]);

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) return null;
	if (process.argv[index + 1] === undefined) throw new Error(`${name} needs a value`);
	return process.argv[index + 1];
}

const casesPath = resolve(argument("--cases") ?? "cases.jsonl");
const outPath = resolve(argument("--out") ?? "out/report.json");
const storeArgument = argument("--store");
const keep = process.argv.includes("--keep");

const tempDir = storeArgument === null ? mkdtempSync(join(tmpdir(), "vestigio-memory-eval-")) : null;
const storePath = storeArgument === null ? join(tempDir, "store.sqlite") : resolve(storeArgument);
mkdirSync(dirname(storePath), { recursive: true });
const store = openStore({ path: storePath });
const seed = seedStore(store);

const casesBytes = readFileSync(casesPath);
const cases = casesBytes
	.toString("utf8")
	.split("\n")
	.filter((line) => line.trim() !== "")
	.map((line) => JSON.parse(line));

async function surfaceIds(item) {
	if (item.surface === "inject") {
		recordProjectInput(store, item.project_id, AT);
		const plan = planInjection({
			store,
			project_id: item.project_id,
			session_id: "eval",
			branch_ref: "root",
			input_id: item.id,
			text: item.text,
			source: "text",
			host_command: false,
			ledger: new InjectionLedger(),
		});
		return plan.injected.map((match) => match.memory_id);
	}
	if (item.surface === "search") {
		const outcome = await layeredSearch({
			store,
			query: item.text,
			scope: { kind: "project", project_id: item.project_id },
			limit: 10,
		});
		return outcome.result.cards.map((card) => card.memory_id);
	}
	throw new Error(`unknown surface: ${String(item.surface)}`);
}

function score(item, surfaced, elapsed, error) {
	const expected = item.expected_memory_ids;
	const first = surfaced.findIndex((id) => expected.includes(id));
	const forbidden = surfaced.some((id) => item.forbidden_memory_ids.includes(id));
	let status = "hit";
	if (error !== null) status = "error";
	else if (forbidden) status = "false_positive";
	else if (expected.length > 0 && first === -1) status = "miss";
	else if (expected.length === 0) status = "clean";
	return {
		case_id: item.id,
		surface: item.surface,
		status,
		rank: first === -1 ? null : first + 1,
		expected_present: first !== -1,
		forbidden_present: forbidden,
		surfaced_ids: surfaced,
		category: item.category,
		note: item.note ?? "",
		elapsed_ms: elapsed,
		error,
	};
}

const results = [];
for (const item of cases) {
	const started = performance.now();
	let surfaced = [];
	let error = null;
	try {
		surfaced = await surfaceIds(item);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	}
	results.push(score(item, surfaced, Math.round(performance.now() - started), error));
}

// Recall needs the number of labeled expected ids, which the result shape omits.
const labeled = new Map(cases.map((item) => [item.id, item.expected_memory_ids.length]));
const scored = results.filter((item) => item.status !== "error");
const recallable = scored.filter((item) => labeled.get(item.case_id) > 0);
const injectable = recallable.filter((item) => item.surface === "inject");
const rate = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);
const recallAt = (k) => rate(recallable.filter((item) => item.rank !== null && item.rank <= k).length, recallable.length);

const summary = { cases: results.length, hit: 0, clean: 0, miss: 0, false_positive: 0, error: 0 };
for (const item of results) summary[item.status] += 1;

let gitCommit = null;
try {
	gitCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
} catch {
	gitCommit = null;
}

const report = {
	schema_version: 1,
	generated_at: new Date().toISOString(),
	commit: gitCommit,
	catalog_version: CATALOG_VERSION,
	dataset_sha256: createHash("sha256").update(casesBytes).digest("hex"),
	seed: { store: storeArgument === null ? "temporary" : storePath, memories: seed.memories },
	summary,
	metrics: {
		recall_at_1: recallAt(1),
		recall_at_3: recallAt(3),
		recall_at_5: recallAt(5),
		inject_hit_rate: rate(injectable.filter((item) => item.status === "hit").length, injectable.length),
		false_positive_rate: rate(summary.false_positive, scored.length),
	},
	cases: results,
};

const rows = [
	["case", "surface", "status", "rank", "expected", "forbidden", "surfaced", "category"],
	...results.map((item) => [
		item.case_id,
		item.surface,
		item.status,
		item.rank ?? "-",
		item.expected_present ? "yes" : "no",
		item.forbidden_present ? "LEAK" : "no",
		item.surfaced_ids.join(" ") || "-",
		item.category,
	]),
];
const [head, ...body] = rows;
console.log([head, head.map(() => "---"), ...body].map((row) => `| ${row.join(" | ")} |`).join("\n"));
const metrics = Object.entries(report.metrics).map(
	([key, value]) => `${key}=${value === null ? "null" : value.toFixed(3)}`,
);
console.log(
	`\n${summary.cases} cases: ${summary.hit} hit, ${summary.clean} clean, ${summary.miss} miss, ` +
		`${summary.false_positive} false_positive, ${summary.error} error`,
);
console.log(metrics.join(" "));
console.log(`report: ${outPath}`);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

const failing = results.filter((item) => FAILING.has(item.status));
const errors = results.filter((item) => item.status === "error");
for (const item of failing) {
	console.error(`${item.status}: ${item.case_id} surfaced=${item.surfaced_ids.join(",") || "-"}`);
}
if (failing.length > 0 && (keep || storeArgument !== null)) console.error(`store kept: ${storePath}`);

store.close();
if (tempDir !== null && !keep) rmSync(tempDir, { recursive: true, force: true });
process.exitCode = errors.length > 0 ? 1 : 0;
