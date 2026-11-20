#!/usr/bin/env node
/**
 * Trigger evaluation: does the agent look things up when the question needs
 * project history, and stay quiet when it does not?
 *
 * Every other harness here is offline and deterministic. This one is the
 * opposite by design: it drives the real `pi` binary with the real provider and
 * counts `memory_search` / `memory_resolve` / `memory_read` calls in the event
 * stream. A model that answers from general knowledge without consulting memory
 * is a Trigger Miss, and no amount of offline recall work can see it.
 *
 * Usage (from eval/memory):
 *   node --import ../pi/hook.mjs ./trigger.mjs [--repeats N] [--model <id>] [--only <id>] [--dry]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "@vestigio/core/storage";
import { PROJECT, seedStore } from "./catalog.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EXTENSION = join(ROOT, "packages/pi-extension/src/extension.ts");
const MODEL = argument("--model") ?? "magpie/auto/deepseek-v4.1-flash";
const REPEATS = Number(argument("--repeats") ?? "2");
const ONLY = argument("--only");
const DRY = process.argv.includes("--dry");
const MEMORY_TOOLS = new Set(["memory_search", "memory_resolve", "memory_read", "memory_mark_stale"]);

/**
 * `query` means the turn cannot be answered honestly without the project's own
 * memory; `no_query` means a lookup would be noise. Each pair is written so the
 * cwd holds nothing that could answer it either way.
 */
const SCENARIOS = [
	{ id: "recall-deploy-port", expect: "query", question: "这个项目的部署脚本默认端口是多少？之前定过吗" },
	{ id: "recall-migration-rollback", expect: "query", question: "数据库迁移失败的时候，按我们之前定的步骤该怎么回滚？" },
	{ id: "recall-cache-invalidation", expect: "query", question: "我们的缓存失效是怎么约定的，写路径和读路径分别怎么做？" },
	{ id: "recall-stale-timeout", expect: "query", question: "空闲会话多久自动断开？这个值之前是不是改过" },
	// Cold: the hotspot layer injects nothing for these (checked with
	// planInjection), so only a deliberate search can answer them.
	{ id: "cold-conn-limit", expect: "query", question: "我们数据库连接那儿最多允许多少个" },
	{ id: "cold-log-retention", expect: "query", question: "那些访问记录一般留多久" },
	{ id: "cold-image-tag", expect: "query", question: "打包成容器的时候名字怎么起" },
	{ id: "cold-secret-rotation", expect: "query", question: "凭证多久换一次" },
	{ id: "quiet-readme-heading", expect: "no_query", question: "把 README 里的一级标题改成中文，只改标题这一行" },
	{ id: "quiet-explain-index", expect: "no_query", question: "用三句话解释一下数据库索引为什么能加速查询" },
	{ id: "quiet-hello-world", expect: "no_query", question: "写一个最小的 node hello world 脚本，打印一行字" },
	{ id: "quiet-enoent", expect: "no_query", question: "报错 ENOENT: no such file or directory 一般是哪里写错了？" },
];

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) return null;
	if (process.argv[index + 1] === undefined) throw new Error(`${name} needs a value`);
	return process.argv[index + 1];
}

const scratch = mkdtempSync(join(tmpdir(), "vestigio-trigger-"));
const storePath = join(scratch, "store.sqlite");
const cwd = join(scratch, "cwd");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "README.md"), "# trigger eval\n\nNothing here answers the questions.\n");
const store = openStore({ path: storePath });
seedStore(store);
store.close();

function runTurn(question) {
	const args = [
		"-p",
		"--mode",
		"json",
		"--no-context-files",
		"--no-mcp",
		"--no-session",
		"--no-extensions",
		"-e",
		EXTENSION,
		"--model",
		MODEL,
		question,
	];
	if (DRY) return { args, env: {}, tools: [], text: "", cost: 0, wall_ms: 0 };
	const started = Date.now();
	const stdout = execFileSync("pi", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		env: {
			...process.env,
			PI_SKIP_VERSION_CHECK: "1",
			VESTIGIO_STORE: storePath,
			VESTIGIO_PROJECT_ID: PROJECT,
			VESTIGIO_OBELISK_HOME: join(scratch, "obelisk"),
			VESTIGIO_DECISION_LOG: join(scratch, "decisions.jsonl"),
		},
	});
	const tools = [];
	let text = "";
	let cost = 0;
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const message = event.message;
		if (event.type === "message_end" && message?.role === "assistant") {
			cost += message.usage?.cost?.total ?? 0;
			if (!Array.isArray(message.content)) continue;
			for (const part of message.content) {
				if (part.type === "toolCall" && typeof part.name === "string") tools.push(part.name);
				if (part.type === "text" && typeof part.text === "string") text = part.text;
			}
		}
	}
	const memoryCalls = [...new Set(tools.filter((name) => MEMORY_TOOLS.has(name)))];
	return { args, env: {}, tools, memoryCalls, text, cost, wall_ms: Date.now() - started };
}

if (DRY) {
	const turn = runTurn("dry");
	console.log(`cd ${cwd} && pi ${turn.args.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ")}`);
	process.exit(0);
}

const rows = [];
for (const scenario of SCENARIOS) {
	if (ONLY !== null && scenario.id !== ONLY) continue;
	for (let index = 0; index < REPEATS; index += 1) {
		const turn = runTurn(scenario.question);
		const calls = turn.memoryCalls ?? [];
		const called = calls.length > 0;
		// `memory_read` consumes a block that was already delivered, so a turn
		// that only reads proves delivery, not the decision to look something up.
		const active = calls.some((name) => name !== "memory_read");
		const status =
			scenario.expect === "query" ? (called ? "hit" : "trigger_miss") : called ? "over_trigger" : "clean";
		rows.push({
			id: scenario.id,
			expect: scenario.expect,
			status,
			question: scenario.question,
			memory_calls: calls,
			active_retrieval: active,
			cost_usd: Number((turn.cost ?? 0).toFixed(6)),
			wall_ms: turn.wall_ms ?? 0,
			answer_chars: (turn.text ?? "").length,
		});
		process.stderr.write(`  ${scenario.id} #${index + 1} ${status}\n`);
	}
}

const shouldRecall = rows.filter((row) => row.expect === "query");
const shouldStayQuiet = rows.filter((row) => row.expect === "no_query");
const rate = (count, total) => (total === 0 ? null : count / total);
const report = {
	schema_version: 1,
	generated_at: new Date().toISOString(),
	model: MODEL,
	repeats: REPEATS,
	summary: {
		turns: rows.length,
		should_recall_rate: rate(
			shouldRecall.filter((row) => row.status === "hit").length,
			shouldRecall.length,
		),
		should_recall_active_rate: rate(
			shouldRecall.filter((row) => row.active_retrieval === true).length,
			shouldRecall.length,
		),
		over_trigger_rate: rate(
			shouldStayQuiet.filter((row) => row.status === "over_trigger").length,
			shouldStayQuiet.length,
		),
		cost_usd: Number(rows.reduce((sum, row) => sum + row.cost_usd, 0).toFixed(6)),
		p50_ms: percentile(rows.map((row) => row.wall_ms), 50),
		p95_ms: percentile(rows.map((row) => row.wall_ms), 95),
	},
	cases: rows,
};
mkdirSync(join(ROOT, "eval/memory/out"), { recursive: true });
const outPath = resolve(argument("--out") ?? "out/trigger.json");
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
const summary = report.summary;
console.log(
	`${summary.turns} turns: should-recall ${summary.should_recall_rate} (active ${summary.should_recall_active_rate}), over-trigger ${summary.over_trigger_rate}, cost $${summary.cost_usd}`,
);
console.log(`p50 ${summary.p50_ms}ms p95 ${summary.p95_ms}ms`);
console.log(`report ${outPath}`);

function percentile(values, quantile) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.ceil((quantile / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)];
}
