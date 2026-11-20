#!/usr/bin/env node
// How repeatable is a trigger run?
//
// The harness asks a real model, so the same scenario does not always end the
// same way. Reading one run and calling the difference a regression is how the
// number stops being trustworthy: this script measures the flip rate instead, so
// a later comparison knows what counts as noise.
//
//   node --import ../pi/hook.mjs ./trigger.mjs --repeats 3 --out out/trigger-repeat.json
//   node ./stability.mjs --report out/trigger-repeat.json
//
// It reads a report only: no model, no store, no network.

import { readFileSync } from "node:fs";

function argument(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const reportPath = argument("--report") ?? "out/trigger-repeat.json";
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const cases = report.cases ?? [];

if (cases.length === 0) {
	console.error(`no cases in ${reportPath}`);
	process.exitCode = 1;
} else {
	/** Rows grouped by scenario id, in the order they were run (one per repeat). */
	const groups = new Map();
	for (const row of cases) {
		const group = groups.get(row.id);
		if (group === undefined) groups.set(row.id, [row]);
		else group.push(row);
	}

	const rows = [];
	for (const [id, group] of groups) {
		const counts = new Map();
		for (const row of group) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
		const outcomes = [...counts.entries()]
			.sort((left, right) => right[1] - left[1])
			.map(([status, count]) => `${status}×${count}`)
			.join(" ");
		rows.push({
			id,
			expect: group[0].expect,
			n: group.length,
			outcomes,
			stable: counts.size === 1,
			statuses: [...counts.keys()],
			// A judged row's verdict is the interesting outcome, not its status
			// label, so a refusal that flips to committed shows up here.
			decisions: group.map((row) => row.decision?.decided ?? null).filter((value) => value !== null),
			active: group.map((row) => row.active_retrieval === true),
		});
	}
	rows.sort((left, right) => left.id.localeCompare(right.id));

	const flipped = rows.filter((row) => !row.stable);
	const repeats = Math.max(...rows.map((row) => row.n));

	// Per-repeat headline numbers, so a reader can see whether the summary moved
	// because a scenario flipped or because the whole run drifted.
	const perRepeat = [];
	for (let index = 0; index < repeats; index += 1) {
		const slice = rows.map((row) => groups.get(row.id)[index]).filter((row) => row !== undefined);
		const recall = slice.filter((row) => row.expect === "query");
		const quiet = slice.filter((row) => row.expect !== "query");
		perRepeat.push({
			repeat: index + 1,
			should_recall_rate: recall.length === 0 ? null : recall.filter((row) => row.status === "hit").length / recall.length,
			active_rate: recall.length === 0 ? null : recall.filter((row) => row.active_retrieval === true).length / recall.length,
			over_trigger_rate: quiet.length === 0 ? null : quiet.filter((row) => row.active_retrieval === true).length / quiet.length,
			refused: recall.filter((row) => row.status === "refused").length,
		});
	}

	console.log(`report ${reportPath}`);
	console.log(`${rows.length} scenarios × ${repeats} repeats, ${cases.length} turns`);
	console.log("");
	console.log("| scenario | expect | outcomes | stable |");
	console.log("| --- | --- | --- | --- |");
	for (const row of rows) {
		console.log(`| \`${row.id}\` | ${row.expect} | ${row.outcomes} | ${row.stable ? "yes" : "NO"} |`);
	}
	console.log("");
	console.log("| repeat | should-recall | active | over-trigger | refused |");
	console.log("| --- | --- | --- | --- | --- |");
	for (const run of perRepeat) {
		const percent = (value) => (value === null ? "-" : value.toFixed(3));
		console.log(
			`| ${run.repeat} | ${percent(run.should_recall_rate)} | ${percent(run.active_rate)} | ${percent(run.over_trigger_rate)} | ${run.refused} |`,
		);
	}
	console.log("");
	console.log(
		`stable: ${rows.length - flipped.length}/${rows.length}${flipped.length === 0 ? "" : `; flipped: ${flipped.map((row) => row.id).join(", ")}`}`,
	);
	// A scenario that flips on whether it looked is a different kind of noise
	// from one that flips between two answers, so the two are named apart.
	const activeFlipped = rows.filter((row) => new Set(row.active).size > 1);
	if (activeFlipped.length > 0) {
		console.log(`flipped on whether it searched at all: ${activeFlipped.map((row) => row.id).join(", ")}`);
	}
}
