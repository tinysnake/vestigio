#!/usr/bin/env node
/**
 * Diff two run.mjs reports by case id and call out regressions.
 *
 * Usage: node ./compare.mjs <baseline.json> <candidate.json>
 *
 * Exit 1 for a regression or new errors and 2 for incompatible or incomplete reports.
 * Pass --exploratory to inspect reports from different inputs.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const exploratory = args[0] === "--exploratory";
if (exploratory) args.shift();
const [baselinePath, candidatePath] = args;
if (args.length !== 2) {
	console.error("usage: compare.mjs [--exploratory] <baseline.json|--baseline=<git-ref>> <candidate.json>");
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
const KNOWN = new Set(["hit", "clean", "miss", "false_positive", "error"]);
function reportProblems(report, label) {
	const problems = [];
	const list = Array.isArray(report.cases) ? report.cases : [];
	if (list.length === 0) problems.push(`${label}: no cases`);
	for (const [index, item] of list.entries()) {
		if (typeof item?.case_id !== "string" || item.case_id === "") problems.push(`${label}[${index}]: missing case_id`);
		if (!KNOWN.has(item?.status)) problems.push(`${label}[${index}]: unknown status ${String(item?.status)}`);
		if (!Array.isArray(item?.surfaced_ids)) problems.push(`${label}[${index}]: missing surfaced_ids`);
	}
	return problems;
}
const byId = (report) => new Map(report.cases.map((item) => [item.case_id, item]));
const baselineReport = loadBaseline(baselinePath);
const candidateReport = JSON.parse(readFileSync(candidatePath, "utf8"));
const problems = [...reportProblems(baselineReport, "baseline"), ...reportProblems(candidateReport, "candidate")];
if (problems.length > 0) {
	for (const problem of problems) console.error(problem);
	process.exit(2);
}
const before = byId(baselineReport);
const after = byId(candidateReport);
const errorCount = (report) => report.cases.filter((item) => item.status === "error").length;

const format = (value) =>
	value === null || value === undefined ? "-" : typeof value === "number" ? value.toFixed(3) : String(value);
const delta = (from, to) =>
	typeof from === "number" && typeof to === "number" ? `${to - from >= 0 ? "+" : ""}${(to - from).toFixed(3)}` : "-";

// A different dataset or catalog makes metric deltas meaningless even when the
// case ids line up, so say so before printing numbers.
const keyOf = (report) =>
	`${report.dataset_sha256 ?? "?"}/${report.catalog_version ?? "?"}`;
const sameInputs = ["dataset_sha256", "catalog_version"].every((key) =>
	baselineReport[key] != null && baselineReport[key] !== "" && baselineReport[key] === candidateReport[key]);
const uniqueIds = before.size === baselineReport.cases.length && after.size === candidateReport.cases.length;
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
const sameCases = groups["missing from candidate"].length === 0 && groups["added in candidate"].length === 0;
const newErrors = errorCount(candidateReport) > errorCount(baselineReport);
if (!uniqueIds) console.error("duplicate case ids make the reports ambiguous");
if (newErrors) console.error(`candidate has ${errorCount(candidateReport)} errored cases, baseline ${errorCount(baselineReport)}`);
process.exitCode = !uniqueIds || (!exploratory && (!sameInputs || !sameCases))
	? 2
	: groups.regressions.length > 0 || newErrors ? 1 : 0;
