#!/usr/bin/env node
/**
 * How much of a lexical miss does the resolver's query expansion recover?
 *
 * `memory.resolve` feeds the judge's `next_queries` back into the same
 * conjunctive index, so a natural-language question only reaches a memory when
 * the model names a phrase the matcher can use. This replays that step offline:
 * run the literal query, and for every miss ask the model for short retrieval
 * phrasings and search again.
 *
 * Usage (from eval/memory):
 *   node --import ../pi/hook.mjs ./rescue.mjs [--cases <path>] [--limit N] [--model <id>] [--out <path>]
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { recordProjectInput } from "@vestigio/core/hotspots";
import { layeredSearch } from "@vestigio/core/retrieval";
import { openStore } from "@vestigio/core/storage";
import { AT, seedStore } from "./catalog.mjs";
import { DEFAULT_MODEL, ask, parseJson } from "./judge.mjs";

const SYSTEM = `你是检索查询改写器。记忆库用合取匹配：查询被切成汉字二元组后，每个二元组都必须出现在记忆里才算命中，整句问句通常一条也匹配不到。

给定用户问题，给出最多 3 个短检索短语：
- 每个短语 2 到 6 个汉字，或一个英文标识符；
- 只用问题里已经出现的词，不要新造同义词；
- 不要整句，不要问号。

只输出 JSON 数组，例如 ["迁移 回滚", "回滚步骤"]。`;

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) return null;
	if (process.argv[index + 1] === undefined) throw new Error(`${name} needs a value`);
	return process.argv[index + 1];
}

const casesPath = resolve(argument("--cases") ?? "candidates.batch-2.jsonl");
const outPath = resolve(argument("--out") ?? "out/rescue.json");
const model = argument("--model") ?? DEFAULT_MODEL;
const limit = Number(argument("--limit") ?? "0");

const tempDir = mkdtempSync(join(tmpdir(), "vestigio-memory-rescue-"));
const store = openStore({ path: join(tempDir, "store.sqlite") });
seedStore(store);
mkdirSync(dirname(outPath), { recursive: true });

const casesBytes = readFileSync(casesPath);
const datasetSha = createHash("sha256").update(casesBytes).digest("hex");
const cases = casesBytes
	.toString("utf8")
	.split("\n")
	.filter((line) => line.trim() !== "")
	.map((line) => JSON.parse(line))
	.filter((item) => item.surface === "search" || item.surface === "inject");

async function search(text, projectId) {
	const outcome = await layeredSearch({
		store,
		query: text,
		scope: { kind: "project", project_id: projectId },
		limit: 10,
	});
	return outcome.result.cards.map((card) => card.memory_id);
}

async function phrasings(question) {
	const response = await ask({ text: question, model, system: SYSTEM });
	const parsed = parseJson(response.reply);
	if (!Array.isArray(parsed)) return { phrases: [], response };
	const phrases = parsed
		.filter((value) => typeof value === "string")
		.map((value) => value.trim())
		.filter((value) => value.length > 0)
		.slice(0, 3);
	return { phrases, response };
}

const rows = [];
let literalHits = 0;
let rescued = 0;
let missed = 0;
let cost = 0;
let calls = 0;
for (const [index, item] of cases.entries()) {
	if (limit > 0 && rows.length >= limit) break;
	const expected = item.expected_memory_ids ?? [];
	if (expected.length === 0) continue;
	recordProjectInput(store, item.project_id, AT);
	const literal = await search(item.text, item.project_id);
	if (literal.some((id) => expected.includes(id))) {
		literalHits += 1;
		rows.push({ id: item.id, text: item.text, via: "literal", phrase: null, ids: literal });
		continue;
	}
	const { phrases, response } = await phrasings(item.text);
	calls += 1;
	cost += response.cost_usd ?? 0;
	let via = null;
	let ids = [];
	for (const phrase of phrases) {
		const found = await search(phrase, item.project_id);
		ids = [...new Set([...ids, ...found])];
		if (found.some((id) => expected.includes(id)) && via === null) via = phrase;
	}
	if (via === null) missed += 1;
	else rescued += 1;
	rows.push({ id: item.id, text: item.text, via: via === null ? "miss" : "expansion", phrase: via, ids });
	if ((index + 1) % 10 === 0) process.stderr.write(`  ${rows.length} cases\n`);
}

const report = {
	schema_version: 1,
	generated_at: new Date().toISOString(),
	model,
	cases_file: casesPath,
	dataset_sha256: datasetSha,
	summary: {
		labeled: rows.length,
		literal_hits: literalHits,
		rescued,
		missed,
		calls,
		cost_usd: Number(cost.toFixed(6)),
	},
	cases: rows,
};
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
const { labeled, rescued: recovered, missed: lost } = report.summary;
console.log(
	`${labeled} labeled cases: ${literalHits} found by the literal query, ${recovered} recovered by expansion, ${lost} still missing`,
);
console.log(`cost $${report.summary.cost_usd} over ${calls} calls`);
console.log(`report ${outPath}`);
