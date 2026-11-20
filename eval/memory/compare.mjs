#!/usr/bin/env node
/**
 * Diff two run.mjs reports by case id and call out regressions.
 *
 * Usage: node ./compare.mjs <baseline.json> <candidate.json>
 *
 * A regression is a case that used to pass (hit or clean) and no longer does;
 * the exit code is 1 when there is at least one, so CI can gate on this alone.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (baselinePath === undefined || candidatePath === undefined) {
	console.error("usage: compare.mjs <baseline.json> <candidate.json>");
	console.error("       compare.mjs --baseline=<git-ref> <candidate.json>");
	process.exit(2);
}

/**
 * A baseline may be a file or a committed revision, so a regression can be
 * stated against another commit without checking it out:
 *
 *   node ./compare.mjs --baseline=HEAD~1 out/report.json
 */
function loadBaseline(spec) {
	const prefix = "--baseline=";
	if (!spec.startsWith(prefix)) return JSON.parse(readFileSync(spec, "utf8"));
	const ref = spec.slice(prefix.length);
	if (ref.length === 0) {
		console.error("--baseline= needs a git ref, e.g. --baseline=HEAD~1");
		process.exit(2);
	}
	const text = execFileSync("git", ["show", `${ref}:eval/memory/baseline.json`], { encoding: "utf8" });
	console.log(`baseline read from ${ref}:eval/memory/baseline.json`);
	return JSON.parse(text);
}

const GOOD = new Set(["hit", "clean"]);
const byId = (report) => new Map(report.cases.map((item) => [item.case_id, item]));
const baselineReport = loadBaseline(baselinePath);
const candidateReport = JSON.parse(readFileSync(candidatePath, "utf8"));
const before = byId(baselineReport);
const after = byId(candidateReport);

const format = (value) =>
	value === null || value === undefined ? "-" : typeof value === "number" ? value.toFixed(3) : String(value);
const delta = (from, to) =>
	typeof from === "number" && typeof to === "number" ? `${to - from >= 0 ? "+" : ""}${(to - from).toFixed(3)}` : "-";

// A different dataset or catalog makes metric deltas meaningless even when the
// case ids line up, so say so before printing numbers.
const keyOf = (report) =>
	`${report.dataset_sha256 ?? "?"}/${report.catalog_version ?? "?"}`;
const sameInputs = keyOf(baselineReport) === keyOf(candidateReport);
if (!sameInputs) {
	console.log(`datasets differ: ${keyOf(baselineReport)} vs ${keyOf(candidateReport)} — metric deltas are not comparable`);
}
console.log(`baseline ${baselineReport.commit ?? "?"} (${baselineReport.generated_at})`);
console.log(`candidate ${candidateReport.commit ?? "?"} (${candidateReport.generated_at})`);

const keys = new Set([...Object.keys(baselineReport.metrics ?? {}), ...Object.keys(candidateReport.metrics ?? {})]);
const rows = [...keys].sort().map((key) => {
	const from = baselineReport.metrics?.[key] ?? null;
	const to = candidateReport.metrics?.[key] ?? null;
	return [key, format(from), format(to), delta(from, to)];
});
const counts = ["hit", "clean", "miss", "false_positive", "error"].map((status) => {
	const from = baselineReport.summary?.[status] ?? 0;
	const to = candidateReport.summary?.[status] ?? 0;
	return [`summary.${status}`, String(from), String(to), `${to - from >= 0 ? "+" : ""}${to - from}`];
});
const table = [...rows, ...counts];
const width = Math.max(...table.map((row) => row[0].length));
console.log(["metric", "baseline", "candidate", "delta"].map((cell, index) => cell.padEnd(index === 0 ? width : 10)).join(" "));
for (const [name, from, to, change] of table) {
	console.log([name.padEnd(width), from.padEnd(10), to.padEnd(10), change].join(" "));
}

const groups = { regressions: [], fixes: [], "status changes": [], "missing from candidate": [], "added in candidate": [] };
for (const id of new Set([...before.keys(), ...after.keys()])) {
	const baseline = before.get(id);
	const candidate = after.get(id);
	if (baseline === undefined) {
		groups["added in candidate"].push(id);
	} else if (candidate === undefined) {
		groups["missing from candidate"].push(id);
	} else if (baseline.status !== candidate.status) {
		const line = `${id}  ${baseline.status} -> ${candidate.status}  surfaced=[${candidate.surfaced_ids.join(" ")}]`;
		if (GOOD.has(baseline.status) && !GOOD.has(candidate.status)) groups.regressions.push(line);
		else if (!GOOD.has(baseline.status) && GOOD.has(candidate.status)) groups.fixes.push(line);
		else groups["status changes"].push(line);
	}
}

for (const [title, lines] of Object.entries(groups)) {
	if (lines.length === 0) continue;
	console.log(`${title}:`);
	for (const line of lines) console.log(`  ${line}`);
}
console.log(Object.entries(groups).map(([title, lines]) => `${title}: ${lines.length}`).join(", "));
process.exitCode = groups.regressions.length > 0 ? 1 : 0;
