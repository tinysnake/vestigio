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
import { ask } from "./judge.mjs";
import { navEntry } from "./replay.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EXTENSION = join(ROOT, "packages/pi-extension/src/extension.ts");
const MODEL = argument("--model") ?? "magpie/auto/deepseek-v4.1-flash";
const REPEATS = Number(argument("--repeats") ?? "2");
const ONLY = argument("--only");
const DRY = process.argv.includes("--dry");
// The contamination judge costs one model call per graded turn, so it can be
// turned off the same way the resolver model can.
const JUDGE_HARM = !process.argv.includes("--no-judge");
/**
 * The resolver needs a model to rewrite a question into index terms. Pointed at
 * the local gateway by default; `--no-resolve-model` keeps the degraded
 * zero-LLM path measurable on purpose.
 */
const RESOLVER_MODEL = resolveModelPort();
const REFUSAL = /(没有找到|查不到|无结果|记忆库为空|没有任何相关|no matching memory|not found|cannot find)/u;
const MEMORY_TOOLS = new Set(["memory_search", "memory_resolve", "memory_read", "memory_mark_stale"]);

/**
 * `query` means the turn cannot be answered honestly without the project's own
 * memory; `no_query` means a lookup would be noise. Each pair is written so the
 * cwd holds nothing that could answer it either way.
 */
const SCENARIOS = [
	{ id: "recall-deploy-port", expect: "query", fact: "18080", question: "这个项目的部署脚本默认端口是多少？之前定过吗" },
	{ id: "recall-migration-rollback", expect: "query", fact: "第五步", question: "数据库迁移失败的时候，按我们之前定的步骤该怎么回滚？" },
	{ id: "recall-cache-invalidation", expect: "query", fact: "删缓存", question: "我们的缓存失效是怎么约定的，写路径和读路径分别怎么做？" },
	// `misused` names the value the memory itself carries: `mem-stale-ttl` holds
	// 30 minutes with a pending event that moved it to 15, so an answer of 30 is
	// a stale memory used as current, not merely a missed fact.
	{ id: "recall-stale-timeout", expect: "query", fact: "15", misused: "30", question: "空闲会话多久自动断开？" },
	// Cold: the hotspot layer injects nothing for these (checked with
	// planInjection), so only a deliberate search can answer them.
	{ id: "cold-conn-limit", expect: "query", fact: "20", question: "我们数据库连接那儿最多允许多少个" },
	{ id: "cold-log-retention", expect: "query", fact: "14", question: "那些访问记录一般留多久" },
	{ id: "cold-image-tag", expect: "query", fact: "哈希", question: "打包成容器的时候名字怎么起" },
	{ id: "cold-secret-rotation", expect: "query", fact: "90", question: "凭证多久换一次" },
	{ id: "quiet-readme-heading", expect: "no_query", question: "把 README 里的一级标题改成中文，只改标题这一行" },
	{ id: "quiet-explain-index", expect: "no_query", question: "用三句话解释一下数据库索引为什么能加速查询" },
	{ id: "quiet-hello-world", expect: "no_query", question: "写一个最小的 node hello world 脚本，打印一行字" },
	{ id: "quiet-enoent", expect: "no_query", question: "报错 ENOENT: no such file or directory 一般是哪里写错了？" },
	// This one is a false positive the hotspot layer produces today: the query
	// starts with 容器, which is a whole keyword of `mem-docker-image`, so the
	// memory is injected before the agent speaks. It is the only shape in which
	// the *harm* of a false positive can be observed end to end.
	{
		id: "quiet-docker-nginx",
		expect: "no_query",
		question: "容器里怎么装 nginx？",
		contaminated_by: "mem-docker-image",
	},
	// The dangerous class: the plan injects the deploy-port memory together with
	// two same-subject 端口约定 memories that disagree with it, so the answer can
	// adopt a superseded value while the correct one is sitting right there.
	{
		id: "conflict-deploy-port",
		expect: "query",
		fact: "18080",
		question: "部署脚本默认端口是多少？",
		contaminated_by: "mem-port-rule-a",
	},
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
			// Without these the resolver degrades to the zero-LLM search, so a
			// turn that calls memory_resolve measures nothing but the matcher.
			...(RESOLVER_MODEL === null
				? {}
				: {
						VESTIGIO_MODEL_BASE_URL: RESOLVER_MODEL.base_url,
						VESTIGIO_MODEL_ID: RESOLVER_MODEL.model_id,
						VESTIGIO_MODEL_API_KEY: RESOLVER_MODEL.api_key,
						VESTIGIO_MODEL_THINKING: RESOLVER_MODEL.thinking,
					}),
		},
	});
	const tools = [];
	let text = "";
	let cost = 0;
	// Everything the model was shown that is not its own answer: the injected
	// block arrives as a user message, tool results as their own messages. A
	// memory URI here means retrieval delivered something, which is what tells a
	// retrieval miss apart from a usage miss.
	let context = "";
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const message = event.message;
		if (event.type === "message_end" && message?.role !== "assistant") {
			const parts = Array.isArray(message?.content) ? message.content : [];
			for (const part of parts) {
				if (typeof part.text === "string") context += `${part.text}\n`;
				else if (typeof part.content === "string") context += `${part.content}\n`;
			}
			continue;
		}
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
	return {
		args,
		env: {},
		tools,
		memoryCalls,
		text,
		cost,
		surfaced: context.includes("memory://"),
		wall_ms: Date.now() - started,
	};
}

if (DRY) {
	const turn = runTurn("dry");
	console.log(`cd ${cwd} && pi ${turn.args.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ")}`);
	process.exit(0);
}

function resolveModelPort() {
	if (process.argv.includes("--no-resolve-model")) return null;
	const base = argument("--resolve-base-url") ?? "http://127.0.0.1:3425/v1";
	// Configured unconditionally: this mirrors production. A wrong URL shows up
	// as a resolver error in the report rather than as a silently degraded run.
	return {
		base_url: base,
		model_id: argument("--resolve-model-id") ?? "auto/deepseek-v4.1-flash",
		api_key: "magpie",
		thinking: "low",
	};
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
		// The fact is a literal from the memory's own text; the answer has to
		// carry it for the turn to count as using memory, not just retrieving it.
		const used = scenario.fact === undefined ? null : compact(turn.text ?? "").includes(compact(scenario.fact));
		// Naming the superseded value is the right thing to do as long as the answer
		// also states the current one; only an answer that carries the old value
		// *instead of* the new one is a misuse, so this needs both halves.
		const staleMisuse =
			scenario.misused === undefined || turn.text === undefined
				? null
				: !compact(turn.text).includes(compact(scenario.fact)) &&
					compact(turn.text).includes(compact(scenario.misused));
		const status =
			scenario.expect === "query"
				? !called
					? "trigger_miss"
					: used === false
						? staleMisuse === true
							? "stale_misuse"
							: REFUSAL.test(turn.text ?? "")
								? "miss"
								: "usage_miss"
						: "hit"
				: called
					? "over_trigger"
					: "clean";
		// Attribution for the proposal's four-way split. A turn that reached a
		// memory and still did not carry the fact is a usage miss; one that
		// called a tool and was shown nothing is a retrieval miss.
		const failure =
			scenario.expect !== "query" || status === "hit"
				? "none"
				: !called
					? "trigger_miss"
					: turn.surfaced !== true
						? "retrieval_miss"
						: "usage_miss";
		rows.push({
			id: scenario.id,
			expect: scenario.expect,
			status,
			stale_misuse: staleMisuse,
			failure,
			surfaced: turn.surfaced === true,
			question: scenario.question,
			memory_calls: calls,
			active_retrieval: active,
			used,
			answer: (turn.text ?? "").slice(0, 600),
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

// Harm of a false positive, end to end. Counting a leak says retrieval delivered
// something it should not have; it does not say whether that changed the answer.
// Here the memory is already in context, so the answer either adopts its content
// or does not, and a judge can be asked about carry and harm without being told
// which answer is "right".
if (JUDGE_HARM && !DRY) {
	for (const row of rows) {
		const scenario = SCENARIOS.find((item) => item.id === row.id);
		if (scenario?.contaminated_by === undefined) continue;
		if (row.surfaced !== true || row.answer === "") continue;
		const memory = navEntry(scenario.contaminated_by);
		const text = [
			"一个编码 Agent 在回答问题时，上下文里被自动注入了下面这条项目记忆（不是它自己搜的）。请判断这条记忆有没有影响回答。",
			"",
			`用户问题：${row.question}`,
			`Agent 回答：${row.answer}`,
			`被注入的记忆（${memory.memory_id}）：摘要「${memory.nav_text}」`,
			memory.body_text === "" ? "" : `正文「${memory.body_text}」`,
			"",
			'只输出 JSON：{"carried": true/false, "harmed": "yes"|"no"|"unclear", "why": "不超过 30 字"}',
			"- carried：回答是否重述或采纳了这条记忆的内容，哪怕只是顺著它的说法。",
			"- harmed：若采纳了，是否让回答对当前问题变得不正确或误导；只是多提一句无关信息算 unclear，不算 yes。",
		].filter((line) => line !== "").join("\n");
		try {
			const judged = ask({ text });
			const parsed = parseJudgement(judged.reply);
			row.contamination = {
				memory_id: memory.memory_id,
				carried: parsed?.carried === true,
				harmed: parsed?.harmed ?? null,
				why: typeof parsed?.why === "string" ? parsed.why.slice(0, 80) : "",
				cost_usd: judged.cost_usd,
			};
		} catch (caught) {
			row.contamination = {
				memory_id: memory.memory_id,
				error: caught instanceof Error ? caught.message : String(caught),
			};
		}
	}
}

const graded = rows.filter((row) => row.contamination !== undefined);
const report = {
	schema_version: 1,
	generated_at: new Date().toISOString(),
	model: MODEL,
	repeats: REPEATS,
	summary: {
		model: MODEL,
		resolver_model: RESOLVER_MODEL === null ? null : RESOLVER_MODEL.model_id,
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
		usage_miss_rate: rate(
			rows.filter((row) => row.status === "usage_miss").length,
			rows.filter((row) => row.expect === "query" && row.used !== null).length,
		),
		cost_per_hit_usd: (() => {
			const hits = rows.filter((row) => row.status === "hit").length;
			const total = rows.reduce((sum, row) => sum + row.cost_usd, 0);
			return hits === 0 ? null : Number((total / hits).toFixed(6));
		})(),
		// Stale Misuse Rate: of the turns whose memory carries a superseded value,
		// how many answered with that value anyway? Only scenarios that name a
		// `misused` value are graded; the rest have nothing to misuse.
		stale_misuse_rate: rate(
			rows.filter((row) => row.stale_misuse === true).length,
			rows.filter((row) => row.stale_misuse !== null).length,
		),
		failures: {
			trigger_miss: rows.filter((row) => row.failure === "trigger_miss").length,
			retrieval_miss: rows.filter((row) => row.failure === "retrieval_miss").length,
			usage_miss: rows.filter((row) => row.failure === "usage_miss").length,
		},
		// Contamination is the false-positive counterpart of usage: a quiet turn
		// that was handed a memory anyway, graded on whether the answer adopted it
		// and whether that adoption hurt.
		contamination: {
			graded: graded.length,
			carried: graded.filter((row) => row.contamination.carried === true).length,
			harmed: graded.filter((row) => row.contamination.harmed === "yes").length,
		},
		contamination_rate: rate(
			graded.filter((row) => row.contamination.carried === true).length,
			graded.length,
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
	`resolver model: ${summary.resolver_model ?? "none (degraded)"}`,
	`${summary.turns} turns: should-recall ${summary.should_recall_rate} (active ${summary.should_recall_active_rate}), usage-miss ${summary.usage_miss_rate}, stale-misuse ${summary.stale_misuse_rate}, over-trigger ${summary.over_trigger_rate}, cost $${summary.cost_usd}`,
);
console.log(
	`failures: trigger ${summary.failures.trigger_miss} retrieval ${summary.failures.retrieval_miss} usage ${summary.failures.usage_miss}`,
);
for (const row of graded) {
	console.log(
		`contamination ${row.id}: carried=${row.contamination.carried} harmed=${row.contamination.harmed} (${row.contamination.memory_id}) ${row.contamination.why ?? row.contamination.error ?? ""}`,
	);
}
console.log(
	`cost per hit: ${summary.cost_per_hit_usd === null ? "-" : `$${summary.cost_per_hit_usd.toFixed(6)}`}  (${summary.turns} turns, $${Number(summary.cost_usd).toFixed(6)} total)`,
);
console.log(`p50 ${summary.p50_ms}ms p95 ${summary.p95_ms}ms`);
console.log(`report ${outPath}`);

/** Space-insensitive comparison, so 15 分钟 and 15分钟 both match. */
function compact(value) {
	return value.replace(/\s+/g, "").toLowerCase();
}

/** The judge's JSON verdict, tolerating fences and prose around it. */
function parseJudgement(reply) {
	if (typeof reply !== "string") return null;
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		return JSON.parse(reply.slice(start, end + 1));
	} catch {
		return null;
	}
}

function percentile(values, quantile) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.ceil((quantile / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)];
}
