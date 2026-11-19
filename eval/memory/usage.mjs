#!/usr/bin/env node
/**
 * Usage evaluation: did the answer actually use the memory that was injected?
 *
 * This is the one part of the offline harness that calls a model, so it lives
 * apart from run.mjs and never touches the store: it takes (query, injected
 * memory summaries, answer) triples from usage-cases.jsonl, asks a judge model
 * for a verdict, and compares that verdict with the hand-written label.
 *
 * Usage (from eval/memory):
 *   node ./usage.mjs [--cases <path>] [--out <path>] [--model <id>] [--limit N] [--dry]
 *
 * The judge runs through `pi -p`, which means the prompt, tokens and cost are
 * real: the report keeps duration_ms, input/output tokens and cost per call so
 * "what does one verdict cost" is a measured number, not an estimate.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_MODEL, ask as askModel } from "./judge.mjs";

const VERDICTS = ["used", "partial", "ignored", "misused"];
const SYSTEM = "You are a strict memory-usage evaluator. Reply with JSON only.";

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) return null;
	if (process.argv[index + 1] === undefined) throw new Error(`${name} needs a value`);
	return process.argv[index + 1];
}

const casesPath = resolve(argument("--cases") ?? "usage-cases.jsonl");
const outPath = resolve(argument("--out") ?? "out/usage.json");
const model = argument("--model") ?? DEFAULT_MODEL;
const limit = Number(argument("--limit") ?? "0");
const dry = process.argv.includes("--dry");

const ask = (text) => askModel({ text, model, system: SYSTEM });

function prompt(item) {
	const memories = item.injected.map((memory) => `- ${memory.memory_id}: ${memory.nav_text}`).join("\n");
	return [
		"判断下面的回答是否使用了注入的记忆。",
		"",
		`用户问题：${item.query}`,
		"注入的记忆（只有导航摘要，没有正文）：",
		memories,
		"",
		`Agent 回答：${item.answer}`,
		"",
		"只输出 JSON，不要代码块：",
		'{"verdict":"used|partial|ignored|misused","quote":"回答中体现该记忆的原文片段","reason":"一句话"}',
		"",
		"used = 回答复述或采纳了记忆里的具体内容；partial = 只泛泛提到记忆，没有具体内容；",
		"ignored = 回答了，但没有依赖记忆内容；misused = 回答了，并且依赖了记忆，但结论与记忆相反或把已过期的内容当作当前事实。",
		"判 misused 时，回答必须显示出对记忆内容的依赖（引用、转述或按它下结论），凭空说出相反结论仍属于 ignored。",
	].join("\n");
}

function parseVerdict(reply) {
	if (typeof reply !== "string") return { verdict: null, quote: null, reason: null };
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start === -1 || end === -1) return { verdict: null, quote: null, reason: null };
	let parsed;
	try {
		parsed = JSON.parse(reply.slice(start, end + 1));
	} catch {
		return { verdict: null, quote: null, reason: null };
	}
	const verdict = VERDICTS.includes(parsed.verdict) ? parsed.verdict : null;
	return { verdict, quote: parsed.quote ?? null, reason: parsed.reason ?? null };
}

const items = readFileSync(casesPath, "utf8")
	.split("\n")
	.filter((line) => line.trim() !== "")
	.map((line) => JSON.parse(line))
	.slice(0, limit > 0 ? limit : undefined);

if (dry) {
	for (const item of items) console.log(`--- ${item.id} (${item.expectation})\n${prompt(item)}\n`);
	process.exit(0);
}

const results = [];
for (const item of items) {
	const call = ask(prompt(item));
	const reply = call.reply;
	const parsed = parseVerdict(reply);
	results.push({
		case_id: item.id,
		memory_id: item.memory_id,
		expected: item.expectation,
		verdict: parsed.verdict,
		agree: parsed.verdict === item.expectation,
		quote: parsed.quote,
		reason: parsed.reason,
		duration_ms: call.duration_ms,
		wall_ms: call.wall_ms,
		input_tokens: call.input_tokens,
		output_tokens: call.output_tokens,
		cost_usd: call.cost_usd,
		reply_excerpt: typeof reply === "string" ? reply.slice(0, 200) : null,
	});
}

const scored = results.filter((item) => item.verdict !== null);
const percent = (value, denominator) => (denominator === 0 ? null : value / denominator);
const quantile = (values, q) => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
	return sorted[index];
};
const sum = (values) => values.reduce((total, value) => total + value, 0);
const durations = results.map((item) => item.duration_ms ?? item.wall_ms).filter((value) => value !== null);
const costs = results.map((item) => item.cost_usd).filter((value) => value !== null);

// Confusion: expected verdict rows against judge verdicts.
const labels = [...new Set([...VERDICTS, ...results.map((item) => item.expected)])];
const confusion = {};
for (const expected of labels) {
	confusion[expected] = {};
	for (const verdict of [...VERDICTS, null]) {
		confusion[expected][verdict ?? "unparsed"] = results.filter(
			(item) => item.expected === expected && item.verdict === verdict,
		).length;
	}
}

const report = {
	schema_version: 1,
	generated_at: new Date().toISOString(),
	model,
	system_prompt: SYSTEM,
	cases: results.length,
	metrics: {
		agreement: percent(scored.filter((item) => item.agree).length, scored.length),
		unparsed: results.filter((item) => item.verdict === null).length,
		latency_p50_ms: quantile(durations, 0.5),
		latency_p95_ms: quantile(durations, 0.95),
		total_cost_usd: sum(costs),
		cost_per_verdict_usd: percent(sum(costs), costs.length),
	},
	confusion,
	results,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, "\t")}\n`);

for (const item of results) {
	const mark = item.agree ? "ok  " : "diff";
	console.log(
		`${mark} ${item.case_id}  expected=${item.expected} judge=${item.verdict ?? "unparsed"}  ${item.duration_ms ?? item.wall_ms}ms  $${(item.cost_usd ?? 0).toFixed(6)}`,
	);
}
console.log(
	`${results.length} cases: agreement=${report.metrics.agreement === null ? "null" : report.metrics.agreement.toFixed(3)} p50=${report.metrics.latency_p50_ms}ms p95=${report.metrics.latency_p95_ms}ms total=$${(report.metrics.total_cost_usd ?? 0).toFixed(6)}`,
);
console.log(`model: ${model}`);
console.log(`report: ${outPath}`);
process.exitCode = report.metrics.unparsed > 0 ? 1 : 0;
