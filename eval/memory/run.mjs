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
import { searchWithRecovery } from "@vestigio/core/resolver";
import { createModelClient } from "../../packages/daemon/src/memory/runtime.ts";
import { openStore } from "@vestigio/core/storage";
import { AT, CATALOG_VERSION, scriptedHistoryPort, seedStore } from "./catalog.mjs";

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
const useRecovery = process.argv.includes("--search-recovery");
const recoveryModel = useRecovery ? createModelClient() : null;
if (useRecovery && recoveryModel === null) throw new Error("--search-recovery needs VESTIGIO_MODEL_BASE_URL");
// `--no-seed` scores a case set against a store the product filled instead of
// building the lab catalogue in it. Without it, `--store` would overwrite the
// question being asked, because every expected id would be planted first.
const noSeed = process.argv.includes("--no-seed");
if (noSeed && storeArgument === null) {
	throw new Error("--no-seed needs --store: a temporary store starts empty either way");
}

const tempDir = storeArgument === null ? mkdtempSync(join(tmpdir(), "vestigio-memory-eval-")) : null;
const storePath = storeArgument === null ? join(tempDir, "store.sqlite") : resolve(storeArgument);
mkdirSync(dirname(storePath), { recursive: true });
const store = openStore({ path: storePath });
const seed = noSeed ? { memories: 0 } : seedStore(store);

const casesBytes = readFileSync(casesPath);
const cases = casesBytes
	.toString("utf8")
	.split("\n")
	.filter((line) => line.trim() !== "")
	.map((line) => JSON.parse(line));

function refKey(ref) {
	return `${ref.session_id}/${ref.message_id}`;
}

async function runSurface(item) {
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
		return {
			ids: plan.injected.map((match) => match.memory_id),
			candidates: plan.matched.map((match) => match.memory_id),
			refs: [],
			status: plan.status,
			reason: plan.reason,
			stale: plan.injected
				.filter((match) => match.freshness.is_stale)
				.map((match) => match.memory_id),
		};
	}
	if (item.surface === "search") {
		const includeHistory = item.include_history === true;
		const search = {
			store,
			query: item.text,
			scope: { kind: "project", project_id: item.project_id },
			limit: 10,
			include_history: includeHistory,
			history: includeHistory ? scriptedHistoryPort(item.history_scenario ?? "none") : undefined,
		};
		const outcome = recoveryModel === null
			? await layeredSearch(search)
			: await searchWithRecovery({ ...search, question: item.text, getModel: () => recoveryModel });
		return {
			ids: outcome.result.cards.map((card) => card.memory_id),
			candidates: [],
			refs: outcome.history.map((excerpt) => refKey(excerpt.source_ref)),
			status: outcome.result.status,
			reason: outcome.recovery?.status ?? null,
			stale: outcome.result.cards
				.filter((card) => card.freshness?.is_stale === true)
				.map((card) => card.memory_id),
		};
	}
	throw new Error(`unknown surface: ${String(item.surface)}`);
}

function score(item, surfaced, error) {
	const expected = item.expected_memory_ids ?? [];
	const forbidden = item.forbidden_memory_ids ?? [];
	const expectedRefs = (item.expected_source_refs ?? []).map(refKey);
	const expectedStale = item.expected_stale_ids ?? [];
	const forbiddenRefs = (item.forbidden_source_refs ?? []).map(refKey);
	const first = surfaced.ids.findIndex((id) => expected.includes(id));
	const leaks = (ids) =>
		forbidden.some((id) => (id === "*" ? ids.length > 0 : ids.includes(id)));
	const forbiddenPresent = leaks(surfaced.ids) || forbiddenRefs.some((ref) => surfaced.refs.includes(ref));
	const candidateLeak = leaks(surfaced.candidates);
	// expected_only turns "these and nothing else" into a claim, so a narrow
	// question cannot quietly collect three neighbours and still score a hit.
	const extraIds = item.expected_only === true ? surfaced.ids.filter((id) => !expected.includes(id)) : [];
	const refPresent = expectedRefs.some((ref) => surfaced.refs.includes(ref));
	// Several expected ids are an AND, not an OR: a composition question is only
	// answered when every memory it needs is there. `findIndex` alone would call
	// one of two a hit.
	const missingExpected = expected.filter((id) => !surfaced.ids.includes(id));
	const expects = expected.length + expectedRefs.length + expectedStale.length > 0;
	const staleOk = expectedStale.every((id) => surfaced.stale.includes(id));
	const idsOk = expected.length === 0 || missingExpected.length === 0;
	const refsOk = expectedRefs.length === 0 || refPresent;
	const expectedStatus = item.expected_status ?? null;
	const statusMismatch = expectedStatus !== null && expectedStatus !== surfaced.status;
	let status;
	if (error) status = "error";
	else if (forbiddenPresent || extraIds.length > 0) status = "false_positive";
	else if (statusMismatch) status = "miss";
	else if (!expects) status = "clean";
	else if (idsOk && refsOk && staleOk) status = "hit";
	else status = "miss";
	return {
		case_id: item.id,
		surface: item.surface,
		text: item.text,
		status,
		expects,
		expected_status: expectedStatus,
		retrieval_status: surfaced.status,
		injection_reason: surfaced.reason ?? null,
		rank: first === -1 || item.rank_ignored === true ? null : first + 1,
		rank_ignored: item.rank_ignored === true,
		expected_present: missingExpected.length === 0,
		memory_found: first !== -1,
		missing_expected_ids: missingExpected,
		forbidden_present: forbiddenPresent,
		expected_only: item.expected_only === true,
		extra_ids: extraIds,
		expected_ids: expected,
		has_forbidden: forbidden.length > 0 || forbiddenRefs.length > 0,
		candidate_ids: surfaced.candidates,
		candidate_leak: candidateLeak,
		surfaced_ids: surfaced.ids,
		surfaced_refs: surfaced.refs,
		surfaced_stale: surfaced.stale,
		expected_stale_present: staleOk,
		category: item.category,
		note: item.note ?? "",
		error,
	};
}

const results = [];
for (const item of cases) {
	let surfaced = { ids: [], candidates: [], refs: [], status: null, reason: null, stale: [] };
	let error = null;
	try {
		surfaced = await runSurface(item);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	}
	results.push(score(item, surfaced, error));
}

// Recall needs the number of labeled expected ids, which the result shape omits.
const labeled = new Map(cases.map((item) => [item.id, (item.expected_memory_ids ?? []).length]));
const refLabeled = new Set(cases.filter((item) => (item.expected_source_refs ?? []).length > 0).map((item) => item.id));
const scored = results.filter((item) => item.status !== "error");
// Candidate and injection FP share a denominator: cases that name a forbidden
// memory, so a leak has something to violate.
// Both rates share this denominator (inject cases that forbid something) so the
// pair reads as "admitted by retrieval" versus "actually injected".
const candidateLabeled = scored.filter((item) => item.has_forbidden === true && item.surface === "inject");
const recallable = scored.filter((item) => labeled.get(item.case_id) > 0 && item.rank_ignored !== true);
const injectable = recallable.filter((item) => item.surface === "inject");
const rate = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);
const recallAt = (k) => rate(recallable.filter((item) => item.rank !== null && item.rank <= k).length, recallable.length);

const summary = { cases: results.length, hit: 0, clean: 0, miss: 0, false_positive: 0, error: 0 };
for (const item of results) summary[item.status] += 1;

// The confusion matrix over the two classes the dataset actually labels: a case
// that should deliver something, and a case that should stay quiet. A case
// labeled only by a forbidden id or an expected status counts as "quiet"; a
// case with no claim at all is reported apart, because it scores clean without
// having been tested.
const shouldDeliver = scored.filter((item) => item.expects === true);
const shouldStayQuiet = scored.filter(
	(item) => item.expects !== true && (item.has_forbidden === true || item.expected_status !== null),
);
const confusion = {
	should_deliver: {
		delivered: shouldDeliver.filter((item) => item.status === "hit").length,
		missed: shouldDeliver.filter((item) => item.status === "miss").length,
		delivered_with_leak: shouldDeliver.filter((item) => item.status === "false_positive").length,
	},
	should_stay_quiet: {
		quiet: shouldStayQuiet.filter((item) => item.status === "clean").length,
		leaked: shouldStayQuiet.filter((item) => item.status === "false_positive").length,
		status_missed: shouldStayQuiet.filter((item) => item.status === "miss").length,
	},
	unlabelled: scored.filter(
		(item) => item.expects !== true && item.has_forbidden !== true && item.expected_status === null,
	).length,
};

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
	seed: { store: storeArgument === null ? "temporary" : storePath, memories: seed.memories, seeded: !noSeed },
	summary,
	confusion,
	metrics: {
		recall_at_1: recallAt(1),
		recall_at_3: recallAt(3),
		recall_at_5: recallAt(5),
		inject_hit_rate: rate(injectable.filter((item) => item.status === "hit").length, injectable.length),
		false_positive_rate: rate(summary.false_positive, scored.length),
		// Split the proposal's two FP tiers: what retrieval admitted versus what
		// the budget actually injected.
		candidate_false_positive_rate: rate(
			candidateLabeled.filter((item) => item.candidate_leak).length,
			candidateLabeled.length,
		),
		injection_false_positive_rate: rate(
			candidateLabeled.filter((item) => item.forbidden_present).length,
			candidateLabeled.length,
		),
		budget_rescued: candidateLabeled.filter((item) => item.candidate_leak && !item.forbidden_present).length,
		expectation_hit_rate: rate(
			confusion.should_deliver.delivered,
			confusion.should_deliver.delivered +
				confusion.should_deliver.missed +
				confusion.should_deliver.delivered_with_leak,
		),
		quiet_rate: rate(
			confusion.should_stay_quiet.quiet,
			confusion.should_stay_quiet.quiet +
				confusion.should_stay_quiet.leaked +
				confusion.should_stay_quiet.status_missed,
		),
		source_gap_rescue_rate: rate(
			scored.filter((item) => refLabeled.has(item.case_id) && item.memory_found === false && item.status === "hit")
				.length,
			scored.filter((item) => refLabeled.has(item.case_id)).length,
		),
	},
	cases: results,
};

const rows = [
	["case", "surface", "status", "retrieval", "rank", "expected", "forbidden", "candidate", "surfaced", "refs", "category"],
	...results.map((item) => [
		item.case_id,
		item.surface,
		item.status,
		item.retrieval_status ?? "-",
		item.rank ?? "-",
		item.expected_present ? "yes" : "no",
		item.forbidden_present ? "LEAK" : item.candidate_leak ? "cap" : "no",
		item.candidate_ids.join(" ") || "-",
		item.surfaced_ids.join(" ") || "-",
		item.surfaced_refs.length,
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
console.log(
	`confusion: should-deliver ${confusion.should_deliver.delivered} delivered / ` +
		`${confusion.should_deliver.missed} missed / ${confusion.should_deliver.delivered_with_leak} leaked, ` +
		`should-stay-quiet ${confusion.should_stay_quiet.quiet} quiet / ` +
		`${confusion.should_stay_quiet.leaked} leaked / ${confusion.should_stay_quiet.status_missed} status-miss, ` +
		`unlabelled ${confusion.unlabelled}`,
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
