#!/usr/bin/env node
/**
 * Draft candidate cases with a model, then check them against the real pipeline.
 *
 * The point is not to trust the model: it is to get a first batch cheaply, mark
 * every row `needs_review`, and hand a reviewer a table of "what the drafter
 * claimed" versus "what the pipeline did". Anything that agrees is cheap to
 * confirm; anything that disagrees is where the reviewer's time goes.
 *
 * Usage (from eval/memory):
 *   node --import ../pi/hook.mjs ./generate-candidates.mjs [--per-memory N] [--out <path>] [--model <id>]
 *   node --import ../pi/hook.mjs ./run.mjs --cases candidates.jsonl --out out/candidates.json
 *   node ./generate-candidates.mjs --review out/candidates.json --out out/candidates-review.md
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_MODEL, ask, parseJson } from "./judge.mjs";

const SYSTEM = "You draft evaluation cases for a memory system. Reply with a JSON array only.";

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) return null;
	if (process.argv[index + 1] === undefined) throw new Error(`${name} needs a value`);
	return process.argv[index + 1];
}

const perMemory = Number(argument("--per-memory") ?? "6");
/** Small batches: this model cuts long JSON arrays off mid-object. */
const BATCH = 3;
const outPath = resolve(argument("--out") ?? "candidates.jsonl");
const model = argument("--model") ?? DEFAULT_MODEL;
const reviewPath = argument("--review");

/** Truncated arrays still carry whole objects at the front; keep them. */
function repairArray(reply) {
	const direct = parseJson(reply);
	if (Array.isArray(direct)) return direct;
	if (typeof reply !== "string") return null;
	const start = reply.indexOf("[");
	const last = reply.lastIndexOf("}");
	if (start === -1 || last <= start) return null;
	try {
		const partial = JSON.parse(`${reply.slice(start, last + 1)}]`);
		return Array.isArray(partial) ? partial : null;
	} catch {
		return null;
	}
}

function prompt(memory, count) {
	return [
		"你在为一个 Agent 记忆系统起草评测样本。下面是一条记忆的元数据：",
		"",
		`memory_id: ${memory.memory_id}`,
		`项目: ${memory.scope.project_id}`,
		`标题: ${memory.title}`,
		`关键词: ${memory.keywords.join(", ")}`,
		`导航摘要: ${memory.nav.text}`,
		"",
		`请起草 ${count} 条用户输入，覆盖这三类：`,
		"(a) 应当召回这条记忆的输入，其中至少一条是关键词式短语、一条是自然语言问句；",
		"(b) 相邻但不应召回任何记忆的输入（对这条记忆不得注入）；",
		"(c) 完全不相关的输入。",
		"",
		"输出 JSON 数组，每项字段：",
		'{"text":"用户输入原文","surface":"inject 或 search","expect":"hit 或 none",',
		'"category":"explicit-recall|implicit-recall|negative|cross-project","rationale":"不超过 20 字"}',
		"",
		"约束：expect=hit 时 surface 允许 inject 或 search；expect=none 时 surface 用 inject 或 search 均可。",
		"文本要像真实用户在编码时说的话，不要出现 memory_id，不要解释规则。",
	].join("\n");
}

function normalize(raw, memory) {
	if (typeof raw?.text !== "string" || raw.text.trim() === "") return null;
	const surface = raw.surface === "search" ? "search" : "inject";
	const expect = raw.expect === "hit" ? "hit" : "none";
	const case_ = {
		id: `cand-${memory.memory_id}-${raw.text.trim().slice(0, 12).replace(/\s+/g, "-")}`,
		surface,
		project_id: memory.scope.project_id,
		text: raw.text.trim(),
		expected_memory_ids: expect === "hit" ? [memory.memory_id] : [],
		forbidden_memory_ids: expect === "hit" ? [] : [memory.memory_id],
		category: typeof raw.category === "string" ? raw.category : "unsorted",
		note: typeof raw.rationale === "string" ? raw.rationale : "",
		status: "candidate",
		needs_review: true,
		model,
	};
	for (const id of [...case_.expected_memory_ids, ...case_.forbidden_memory_ids]) {
		if (!ids.has(id)) return null;
	}
	return case_;
}

if (reviewPath !== null) {
	const report = JSON.parse(readFileSync(reviewPath, "utf8"));
	// A disagreement is not automatically a bad label. Sorting them by cause is
	// what makes the sheet reviewable: matcher-weak rows are a known property,
	// precision-leak rows are the interesting ones.
	const bucketOf = (expected, observed, item) => {
		if (observed === expected) return "agree";
		if (expected === "hit" && observed === "miss" && item.surface === "search") return "matcher-weak";
		if (expected === "hit" && observed === "miss") return "recall-gap";
		if (expected === "none" && observed === "false_positive") return "precision-leak";
		return "label-question";
	};
	const rows = report.cases.map((item) => {
		const expected = (item.expected_ids ?? []).length > 0 ? "hit" : "none";
		const observed = item.status === "hit" ? "hit" : item.status === "clean" ? "none" : item.status;
		return [
			bucketOf(expected, observed, item),
			item.case_id,
			item.surface,
			`\`${item.text}\``,
			expected,
			observed,
			item.note.replace(/\|/g, "/"),
		];
	});
	const order = ["precision-leak", "recall-gap", "label-question", "matcher-weak", "agree"];
	rows.sort((left, right) => order.indexOf(left[0]) - order.indexOf(right[0]) || left[1].localeCompare(right[1]));
	const header = ["bucket", "case", "surface", "text", "expected", "observed", "rationale"];
	const lines = [
		"| " + header.join(" | ") + " |",
		"| " + header.map(() => "---").join(" | ") + " |",
		...rows.map((row) => "| " + row.join(" | ") + " |"),
	];
	const counts = {};
	for (const row of rows) counts[row[0]] = (counts[row[0]] ?? 0) + 1;
	const disagree = rows.length - (counts.agree ?? 0);
	const banner = [
		`<!-- generated by generate-candidates.mjs from ${report.commit ?? "?"}; do not edit by hand -->`,
		"",
		`${rows.length} candidates, ${disagree} need a human look:`,
		"",
		...order
			.filter((bucket) => counts[bucket] !== undefined)
			.map((bucket) => `- \`${bucket}\`: ${counts[bucket]}`),
		"",
	];
	writeFileSync(
		resolve(argument("--out") ?? "out/candidates-review.md"),
		`${banner.join("\n")}\n${lines.join("\n")}\n`,
	);
	console.log(`${rows.length} candidates: ${disagree} need a human look (${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ")})`);
	process.exit(0);
}

// Imported here, not at the top: review mode must not need the catalog (and so
// must not need the core package's import map).
const { MEMORIES } = await import("./catalog.mjs");
const ids = new Set(MEMORIES.map((memory) => memory.memory_id));

const drafted = [];
let cost = 0;
let parsedCalls = 0;
for (const memory of MEMORIES) {
	for (let done = 0; done < perMemory; done += BATCH) {
		const count = Math.min(BATCH, perMemory - done);
		const call = ask({ text: prompt(memory, count), model, system: SYSTEM });
		cost += call.cost_usd ?? 0;
		const parsed = repairArray(call.reply);
		if (!Array.isArray(parsed)) {
			console.error(`unparsable draft for ${memory.memory_id}: ${(call.reply ?? "").slice(0, 120)}`);
			continue;
		}
		parsedCalls += 1;
		for (const raw of parsed.slice(0, count)) {
			const item = normalize(raw, memory);
			if (item !== null) drafted.push(item);
		}
	}
}

const seen = new Set();
const unique = drafted.filter((item) => {
	const key = `${item.surface}/${item.text}`;
	if (seen.has(key)) return false;
	seen.add(key);
	return true;
});
writeFileSync(outPath, unique.map((item) => JSON.stringify(item)).join("\n") + "\n");
const calls = MEMORIES.length * Math.ceil(perMemory / BATCH);
console.log(`${unique.length} candidate cases from ${parsedCalls}/${calls} calls, cost $${cost.toFixed(6)}`);
console.log(`wrote ${outPath}`);
console.log("next: node --import ../pi/hook.mjs ./run.mjs --cases " + outPath + " --out out/candidates.json");
if (!existsSync(outPath)) process.exitCode = 1;
