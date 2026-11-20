/**
 * Turn a trigger run's real answers into usage-judge rows.
 *
 * `usage.mjs` grades hand-written answers, which cannot show whether the judge
 * agrees with reality. This bridge reads `out/trigger.json`, reconstructs the
 * memory each recall turn had in context (the hotspot plan for warm turns, the
 * fact-to-memory table for cold ones), and writes rows whose expectation is the
 * objective one: the answer carries the memory's fact or it does not.
 *
 *   node --import ../pi/hook.mjs ./usage-from-trigger.mjs
 *   node --import ../pi/hook.mjs ./usage.mjs --cases out/usage-from-trigger.jsonl
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { COLD_BY_FACT, TURN_FACTS, compact, navEntry, replayInjection, withSeededStore } from "./replay.mjs";

function argument(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const reportPath = resolve(argument("--report") ?? "out/trigger.json");
const outPath = resolve(argument("--out") ?? "out/usage-from-trigger.jsonl");
const report = JSON.parse(readFileSync(reportPath, "utf8"));

const rows = [];
withSeededStore((store) => {
	for (const turn of report.cases) {
		const fact = TURN_FACTS.get(turn.id);
		if (fact === undefined || turn.answer === undefined) continue;
		const plan = replayInjection(store, turn.question, `bridge-${turn.id}`);
		const coldId = COLD_BY_FACT.get(fact);
		const injected =
			plan.injected.length > 0
				? plan.injected
				: coldId === undefined
					? []
					: [navEntry(coldId)];
		if (injected.length === 0) continue;
		rows.push({
			id: `usage-${turn.id}`,
			memory_id: injected[0].memory_id,
			query: turn.question,
			injected,
			answer: turn.answer,
			expectation: compact(turn.answer).includes(compact(fact)) ? "used" : "ignored",
			note: `trigger ${turn.id}: ${turn.status}, fact=${fact}`,
		});
	}
});

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
console.log(`${rows.length} rows -> ${outPath}`);
console.log(rows.map((row) => `${row.id}=${row.expectation}(${row.memory_id})`).join(" "));
