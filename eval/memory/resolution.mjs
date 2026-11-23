// The resolver surface, offline and deterministic.
//
// `run.mjs` measures what retrieval *delivers*; this measures what the resolver
// makes of it. The judge is scripted, so every case asserts one branch of the
// walk rather than a model's mood: does an accepting judge resolve, does a
// judge with no follow-up question stop, does a re-query find what the first
// gather missed, what happens when the judge answers garbage, and what a
// completely empty gather reports.
//
//   node --import ../pi/hook.mjs ./resolution.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveMemory } from "@vestigio/core/resolver";
import { openStore } from "@vestigio/core/storage";
import { AT, CATALOG_VERSION, PROJECT, seedStore } from "./catalog.mjs";

const OUT = resolve("out/resolution.json");

/** One JSON judge reply. `evidence_ids` must name a card in the gather. */
const accept = (evidenceId) =>
	JSON.stringify({
		sufficient: true,
		answer: "由记忆给出结论。",
		evidence_ids: [evidenceId],
		read_uris: [],
		next_queries: [],
	});
const refuse = (nextQueries = []) =>
	JSON.stringify({
		sufficient: false,
		answer: null,
		evidence_ids: [],
		read_uris: [],
		next_queries: nextQueries,
	});

/**
 * A model port that replays one judge reply per call, routing by the system
 * prompt the way `packages/core/test/extraction/support.ts` does. The resolver
 * uses its own prompts for the medium summary and the nav short summary; a case
 * here never reaches them unless it says so.
 */
function scriptedModel(replies) {
	const state = { calls: 0, kinds: [], outcomes: [] };
	return {
		state,
		port: {
			async complete(request) {
				const system = request.messages[0]?.content ?? "";
				const kind = system.includes("中期摘要")
					? "summary"
					: system.includes("导航短摘要")
						? "nav"
						: "judge";
				state.kinds.push(kind);
				if (kind !== "judge") {
					return {
						ok: true,
						value: {
							text:
								kind === "summary"
									? JSON.stringify({ body: "摘要正文。" })
									: JSON.stringify({ nav: "导航摘要。" }),
							usage: { tokens_in: 1, tokens_out: 1, cost_usd: null },
							model: "scripted",
							elapsed_ms: 1,
							finish_reason: "stop",
						},
					};
				}
				const index = state.calls;
				state.calls += 1;
				const reply = replies[Math.min(index, replies.length - 1)];
				if (reply === undefined) throw new Error("no scripted reply");
				return {
					ok: true,
					value: {
						text: reply,
						usage: { tokens_in: 10, tokens_out: 10, cost_usd: null },
						model: "scripted",
						elapsed_ms: 1,
						finish_reason: "stop",
					},
				};
			},
		},
	};
}

// The gather is lexical, so the question has to share a word with the memory
// (see "Query wording" in the README). 量子计算调优 shares nothing with anything.
const CASES = [
	{
		id: "res-accept-first-gather",
		question: "部署脚本默认端口",
		replies: [accept("mem-deploy-port")],
		expected_status: "resolved",
		expected_judge_calls: 1,
		expected_missing: [],
		note: "裁判在第一轮 gather 就接受候选，不再进入归档与历史层",
		max_judge_calls: 1,
	},
	{
		id: "res-refuse-without-followup",
		question: "部署脚本默认端口",
		replies: [refuse()],
		expected_status: "partial",
		expected_judge_calls: 1,
		expected_missing: ["evidence_insufficient", "judge_declined"],
		forbidden_missing: ["no_candidates_gathered", "cited_evidence_unavailable"],
		note: "裁判判证据不足又没给 next_queries，走一次裁判就停，不重复 gather；候选不空，因此不该出现 no_candidates_gathered；missing 在结论后紧跟 judge_declined，把「模型不肯下结论」和「检索没拿到证据」分开",
		max_judge_calls: 1,
	},
	{
		id: "res-requery-recovers",
		question: "会话空闲多久断开",
		replies: [refuse(["保活时长"]), accept("mem-stale-ttl")],
		expected_status: "resolved",
		expected_judge_calls: 2,
		expected_missing: [],
		note: "第一轮判不足并给出改写词，改写后的 gather 命中 mem-stale-ttl，状态转为 resolved",
		max_judge_calls: 3,
	},
	{
		id: "res-empty-gather-not-found",
		question: "量子计算调优",
		replies: [refuse()],
		expected_status: "not_found",
		expected_judge_calls: 1,
		expected_missing: ["evidence_insufficient", "judge_declined", "no_candidates_gathered"],
		note: "所有层都空时仍会调用裁判一次：missing 先记裁判的结论，再记 judge_declined 和 no_candidates_gathered，后者让「库里没有」和「库里有但没匹配上」可以分开",
		max_judge_calls: 1,
	},
	{
		id: "res-zero-llm-no-candidates",
		question: "量子计算调优",
		model: null,
		replies: [],
		expected_status: "not_found",
		expected_judge_calls: 0,
		expected_missing: ["model_not_configured", "no_candidates_gathered"],
		note: "没有配置模型时整条链路退化成零模型检索：一次裁判都不调，missing 直接写 model_not_configured",
		max_judge_calls: 0,
	},
	{
		id: "res-zero-llm-with-candidates",
		question: "部署脚本默认端口",
		model: null,
		replies: [],
		expected_status: "partial",
		expected_judge_calls: 0,
		expected_missing: ["model_not_configured"],
		forbidden_missing: ["no_candidates_gathered"],
		note: "同一退化路径下候选命中但无人裁定，状态停在 partial；有候选就不该标成空 gather",
		max_judge_calls: 0,
	},
	{
		id: "res-malformed-judge",
		question: "部署脚本默认端口",
		replies: ["不是 JSON"],
		expected_status: "partial",
		expected_judge_calls: 2,
		expected_missing: null,
		note: "裁判输出无法解析时重试一次，两次都失败则状态停在 partial，missing 以 model_malformed_output 开头",
		max_judge_calls: 2,
	},
];

const rows = [];
for (const item of CASES) {
	const dir = mkdtempSync(join(tmpdir(), "vestigio-res-"));
	const store = openStore({ path: join(dir, "store.sqlite") });
	seedStore(store);
	const model = item.model === null ? null : scriptedModel(item.replies);
	const started = Date.now();
	const outcome = await resolveMemory({
		store,
		question: item.question,
		scope: { kind: "project", project_id: PROJECT },
		model: model === null ? null : model.port,
		session_id: "eval",
		wall_now: () => Date.parse(AT),
		mono_now: (() => {
			let t = 0;
			return () => (t += 1);
		})(),
	});
	store.close();
	const result = outcome.result;
	const judgeCalls = outcome.calls.filter((call) => call.purpose === "judge_expand").length;
	const missing = result.missing;
	const statusOk = result.status === item.expected_status;
	const callsOk = judgeCalls === item.expected_judge_calls;
	const missingOk =
		(item.expected_missing === null
			? missing.every((entry) => entry.startsWith("model_malformed_output"))
			: item.expected_missing.every((entry) => missing.includes(entry))) &&
		(item.forbidden_missing ?? []).every((entry) => !missing.includes(entry));
	const ok = statusOk && callsOk && missingOk;
	rows.push({
		case_id: item.id,
		ok,
		status: result.status,
		expected_status: item.expected_status,
		judge_calls: judgeCalls,
		expected_judge_calls: item.expected_judge_calls,
		missing,
		call_outcomes: outcome.calls.map((call) => call.outcome),
		layers: outcome.layers.map((layer) => `${layer.layer}:${layer.status}`),
		question: item.question,
		note: item.note,
		elapsed_ms: Date.now() - started,
	});
	process.stderr.write(
		`${ok ? "ok  " : "FAIL"} ${item.id} status=${result.status} judge_calls=${judgeCalls} missing=${missing.join("|") || "-"}\n`,
	);
}

const failed = rows.filter((row) => !row.ok);
const report = {
	schema_version: 1,
	generated_at: new Date().toISOString(),
	catalog_version: CATALOG_VERSION,
	cases: rows,
	summary: {
		cases: rows.length,
		ok: rows.length - failed.length,
		failed: failed.length,
	},
};
writeFileSync(OUT, `${JSON.stringify(report, null, "\t")}\n`);
console.log(`${rows.length} resolver cases: ${rows.length - failed.length} ok, ${failed.length} failed`);
console.log(`report: ${OUT}`);
process.exitCode = failed.length > 0 ? 1 : 0;
