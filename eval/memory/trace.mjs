/**
 * One joined record per agent turn: the full memory chain the proposal asks for.
 *
 * `trigger.mjs` knows what the agent did, `replay.mjs` knows what the hotspot
 * layer offered, and the usage judge knows whether the answer used it. This
 * script joins them into a single trace per turn — trigger, hotspot, delivery,
 * usage, cost — so a failure can be attributed without reading three files, and
 * it computes the rescue rate for turns the hotspot layer offered nothing on.
 *
 *   node --import ../pi/hook.mjs ./trace.mjs
 *   node --import ../pi/hook.mjs ./trace.mjs --report out/trigger.json --usage out/usage.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { COLD_BY_FACT, TURN_FACTS, compact, navEntry, replayInjection, withSeededStore } from "./replay.mjs";

function argument(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const reportPath = resolve(argument("--report") ?? "out/trigger.json");
const usagePath = resolve(argument("--usage") ?? "out/usage.json");
const outPath = resolve(argument("--out") ?? "out/trace.json");
const report = JSON.parse(readFileSync(reportPath, "utf8"));

/** Judge verdicts are optional: a trigger run can be traced before it is graded. */
let verdicts = new Map();
try {
	const usage = JSON.parse(readFileSync(usagePath, "utf8"));
	verdicts = new Map((usage.results ?? []).map((row) => [row.case_id ?? row.id, row.verdict]));
} catch {
	verdicts = new Map();
}

const traces = [];
withSeededStore((store) => {
	for (const turn of report.cases) {
		const fact = TURN_FACTS.get(turn.id);
		const plan = replayInjection(store, turn.question, `trace-${turn.id}`);
		// A cold turn has no injection to replay: name the memory the fact belongs
		// to so the trace says which memory the turn was expected to reach.
		const coldId = fact === undefined ? undefined : COLD_BY_FACT.get(fact);
		const offered = plan.injected.length > 0 ? plan.injected : coldId === undefined ? [] : [navEntry(coldId)];
		traces.push({
			turn: turn.id,
			question: turn.question,
			expect: turn.expect,
			stages: {
				trigger: {
					memory_calls: turn.memory_calls ?? [],
					active_retrieval: turn.active_retrieval === true,
					failure: turn.failure ?? "none",
				},
				hotspot: {
					reason: plan.reason,
					candidates: plan.candidates,
					injected: plan.injected.map((entry) => ({ memory_id: entry.memory_id, stale: entry.stale })),
				},
				delivery: {
					surfaced: turn.surfaced === true,
					expected_memory: offered[0]?.memory_id ?? null,
				},
				usage: {
					fact: fact ?? null,
					carried: turn.used,
					status: turn.status,
					judge: verdicts.get(`usage-${turn.id}`) ?? null,
					compact_answer_has_fact:
						fact === undefined || turn.answer === undefined
							? null
							: compact(turn.answer).includes(compact(fact)),
				},
				cost: { usd: turn.cost_usd ?? null, ms: turn.wall_ms ?? null },
			},
		});
	}
});

// The rescue rate the proposal asks for, measured on real turns: of the recall
// turns the hotspot layer offered nothing on, how many still ended resolved?
// Quiet turns also have an empty hotspot; they are not rescue candidates.
const coldTurns = traces.filter(
	(trace) => trace.expect === "query" && trace.stages.hotspot.injected.length === 0,
);
const rescued = coldTurns.filter((trace) => trace.stages.usage.status === "hit");
const recallTurns = traces.filter((trace) => trace.expect === "query");
// Stale Misuse Rate, on real turns: of the turns that carried a memory the store
// already marked stale, how many did the judge call misused? A turn with no
// verdict is counted once it is graded, not assumed innocent.
const staleTurns = traces.filter((trace) =>
	trace.stages.hotspot.injected.some((entry) => entry.stale),
);
const staleJudged = staleTurns.filter((trace) => trace.stages.usage.judge !== null);
const staleMisused = staleJudged.filter((trace) => trace.stages.usage.judge === "misused");
const summary = {
	turns: traces.length,
	recall_turns: recallTurns.length,
	hotspot_offered: traces.filter((trace) => trace.stages.hotspot.injected.length > 0).length,
	delivered: traces.filter((trace) => trace.stages.delivery.surfaced).length,
	rescue_rate: coldTurns.length === 0 ? null : rescued.length / coldTurns.length,
	rescue_turns: coldTurns.length,
	judged: traces.filter((trace) => trace.stages.usage.judge !== null).length,
	stale_turns: staleTurns.length,
	stale_judged: staleJudged.length,
	stale_misuse_rate: staleJudged.length === 0 ? null : staleMisused.length / staleJudged.length,
};
// Fewer cold turns than scenarios means a filtered run (`--only`), where the
// rescue rate is a single sample rather than a rate.
if (coldTurns.length !== 0 && coldTurns.length < 4) {
	console.log(`note: only ${coldTurns.length} cold turns in this report — run the full scenario set for a comparable rate`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
	outPath,
	`${JSON.stringify(
		{
			schema_version: 1,
			generated_at: new Date().toISOString(),
			model: report.summary?.model ?? null,
			resolver_model: report.summary?.resolver_model ?? null,
			summary,
			traces,
		},
		null,
		"\t",
	)}\n`,
);
console.log(
	`${summary.turns} turns: ${summary.hotspot_offered} injected, ${summary.delivered} delivered, ` +
		`rescue ${summary.rescue_rate === null ? "-" : summary.rescue_rate.toFixed(3)} over ${summary.rescue_turns} cold turns, ` +
		`${summary.judged} judged, stale misuse ${summary.stale_misuse_rate === null ? "-" : summary.stale_misuse_rate.toFixed(3)} over ${summary.stale_judged} graded stale turns`,
);
console.log(`trace: ${outPath}`);
