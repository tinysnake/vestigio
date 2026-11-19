#!/usr/bin/env node
/**
 * Diff two run.mjs reports by case id and call out regressions.
 *
 * Usage: node ./compare.mjs <baseline.json> <candidate.json>
 *
 * A regression is a case that used to pass (hit or clean) and no longer does;
 * the exit code is 1 when there is at least one, so CI can gate on this alone.
 */

import { readFileSync } from "node:fs";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (baselinePath === undefined || candidatePath === undefined) {
	console.error("usage: compare.mjs <baseline.json> <candidate.json>");
	process.exit(2);
}

const GOOD = new Set(["hit", "clean"]);
const byId = (report) => new Map(report.cases.map((item) => [item.case_id, item]));
const before = byId(JSON.parse(readFileSync(baselinePath, "utf8")));
const after = byId(JSON.parse(readFileSync(candidatePath, "utf8")));

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
