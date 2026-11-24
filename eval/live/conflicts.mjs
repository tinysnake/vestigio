#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codePointCount, nonWhitespaceCodePointCount } from "@vestigio/core";
import { openStore } from "@vestigio/core/storage";
import { daemonRunning, VestigioClient } from "../../packages/client/src/index.ts";
import {
	PiClient,
	appendJsonl,
	childFirstLine,
	readMagpieKey,
	redactText,
	redactValue,
	registerSecret,
	sha256,
	startProxy,
	textContent,
	timestamp,
} from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, "../..");
const EXT = join(ROOT, "packages/pi-extension/src/extension.ts");
const RUNS_DIR = join(HERE, "runs");
const TMP = "/tmp/vestigio-live";
const conflictStores = new Set();
const AGENT_SRC = join(homedir(), ".pi/agent");
let AGENT_HOME = null;
const REAL_OBELISK = join(homedir(), ".obelisk/obelisk.sqlite");
const PI = process.env.PI_BIN ?? "pi";

const TURN_TIMEOUT_MS = 300_000;
const STORE_ID = "vestigio";
const CONFLICT_TOOL_ALLOWLIST = ["memory_search", "memory_read", "memory_resolve"];

const DEFAULTS = {
	endpoint: "http://127.0.0.1:3425/v1",
	provider: "magpie",
	agent_model: "auto/deepseek-v4.1-flash",
	agent_thinking: "low",
	extension_model: "auto/deepseek-v4.1-flash",
	extension_thinking: "low",
	max_model_calls: 150,
	max_total_tokens: 1_500_000,
	wall_clock_ms: 900_000,
};

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(redactValue(value), null, 2)}\n`, "utf8");
}

function loadConfig() {
	const localPath = join(HERE, "config.local.json");
	let raw = {};
	if (existsSync(localPath)) {
		try {
			raw = JSON.parse(readFileSync(localPath, "utf8"));
		} catch (error) {
			throw new Error(`cannot parse ${localPath}: ${error.message}`);
		}
	}
	const config = { ...DEFAULTS };
	for (const key of Object.keys(DEFAULTS)) {
		if (raw[key] !== undefined && raw[key] !== null) config[key] = raw[key];
	}
	return config;
}

function buildAgentHome(agentHome, proxyBaseUrl) {
	rmSync(agentHome, { recursive: true, force: true });
	mkdirSync(agentHome, { recursive: true });
	const models = JSON.parse(readFileSync(join(AGENT_SRC, "models.json"), "utf8"));
	if (models?.providers?.magpie === undefined) {
		throw new Error("~/.pi/agent/models.json has no `magpie` provider; cannot route the agent");
	}
	models.providers.magpie.baseUrl = proxyBaseUrl;
	writeFileSync(join(agentHome, "models.json"), `${JSON.stringify(models, null, 2)}\n`, "utf8");
	copyFileSync(join(AGENT_SRC, "auth.json"), join(agentHome, "auth.json"));
	writeFileSync(join(agentHome, "models-store.json"), "{}\n", "utf8");
}

function assistantProse(client, from = 0) {
	return client.events
		.slice(from)
		.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
		.map((event) => textContent(event.message?.content))
		.filter((text) => text.length > 0)
		.join("\n");
}

function toolResultTexts(client, from = 0) {
	return client.events
		.slice(from)
		.filter((event) => event.type === "tool_execution_end")
		.map((event) => textContent(event.result?.content))
		.filter((text) => text.length > 0);
}

function toolCalls(client, from = 0) {
	return client.events
		.slice(from)
		.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
		.flatMap((event) =>
			(event.message?.content ?? [])
				.filter((part) => part?.type === "toolCall")
				.map((part) => ({ name: part.name, arguments: part.arguments })),
		);
}

function memoryUri(memoryId) {
	return `memory://${STORE_ID}/${memoryId}`;
}
function buildBody({ title, value, lines, context }) {
	let text = `${title}：这是当前生效的结论。`;
	text += `\n- 当前值: ${value}`;
	for (const line of lines) text += `\n- ${line}`;
	for (const sentence of context) text += `\n${sentence}`;
	text += "\n补充说明：改动前先核对本页，改动后把新值写回这里，并保留可追溯的来源与时间，方便后续交接与回溯，也方便下一次改动的同学核对。";
	const count = nonWhitespaceCodePointCount(text);
	if (count < 500 || count > 1000) {
		throw new Error(`body for "${title}" is ${count} non-whitespace code points; must be 500-1000`);
	}
	return text;
}

function navText(title, value) {
	const text = `${title}的当前结论：${value}。改动前先读本页，改动后写回新值。`;
	if (codePointCount(text) > 200) throw new Error(`nav for "${title}" exceeds 200 code points`);
	return text;
}

function sourceRef({ projectId, memoryId, revision, at, body }) {
	return {
		provider: "pi",
		source_instance: "local-session",
		session_id: "pi-session-2026-11-17",
		message_id: `message-${memoryId}-${revision}`,
		parent_message_id: null,
		project_id: projectId,
		timestamp: at,
		content_hash: `sha256:${sha256(body)}`,
		locator: null,
	};
}
function seedScenario({ storePath, scenario, agentProject, otherProject }) {
	mkdirSync(dirname(storePath), { recursive: true });
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${storePath}${suffix}`, { force: true });
	const at = "2026-11-17T12:00:00.000Z";
	const store = openStore({ path: storePath });
	let seq = 1;
	try {
		for (const spec of scenario.memories) {
			const projectId = spec.project === "other" ? otherProject : agentProject;
			const uri = memoryUri(spec.memory_id);
			spec.revisions.forEach((rev, index) => {
				const revision = index + 1;
				const body = buildBody({
					title: spec.title,
					value: rev.value,
					lines: rev.lines ?? [],
					context: CONTEXT,
				});
				const nav = {
					text: navText(spec.title, rev.nav_value ?? rev.value),
					char_count: 0,
					source_revision: revision,
				};
				nav.char_count = codePointCount(nav.text);
				store.saveMemory({
					memory_id: spec.memory_id,
					uri,
					scope: { kind: "project", project_id: projectId },
					title: spec.title,
					keywords: spec.keywords,
					revision,
					state: "published",
					medium: {
						body,
						body_char_count: nonWhitespaceCodePointCount(body),
							sources: [sourceRef({ projectId, memoryId: spec.memory_id, revision, at, body })],
					},
					nav,
					hit_count: 0,
					access_count: 0,
					last_access_at: null,
					created_at: at,
					updated_at: at,
				});
			});
			store.upsertHotspotMembership({
				project_id: projectId,
				memory_id: spec.memory_id,
				admitted_seq: seq,
				last_hit_seq: 0,
				last_access_seq: 0,
				recent_hit_weight: 0,
				recent_access_weight: 0,
			});
			seq += 1;
		}
		store.upsertProjectActivity({ project_id: agentProject, activity_seq: 10, last_input_at: at });
		store.upsertProjectActivity({ project_id: otherProject, activity_seq: 20, last_input_at: at });
	} finally {
		store.close();
	}
}
function readStoreFacts(storePath, ids) {
	const store = openStore({ path: storePath });
	try {
		const facts = { memory_count: store.countMemories(), memories: {} };
		for (const id of ids) {
			const memory = store.readMemory(memoryUri(id));
			facts.memories[id] =
				memory === null
					? null
					: {
							revision: memory.revision,
							state: memory.state,
							title: memory.title,
							scope: memory.scope,
							source_count: memory.medium.sources.length,
							body_char_count: memory.medium.body_char_count,
						};
		}
		return facts;
	} finally {
		store.close();
	}
}
function readResolverStatus(decisionsPath) {
	if (!existsSync(decisionsPath)) return [];
	const out = [];
	for (const line of readFileSync(decisionsPath, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const record = JSON.parse(line);
			if (record.kind === "tool_search" || record.kind === "tool_resolve") {
				out.push({ tool: record.kind, status: record.status });
			}
		} catch {
		}
	}
	return out;
}
const CONTEXT = [
	"这套服务用 deploy.sh 发布到测试和生产两套环境，两边共用同一份配置，改任何参数之前都要先确认反向代理、健康检查、监控探针和容器端口映射指向的值一致，发布之后还要实际请求一次首页和一条业务接口，确认改动真的生效，避免其中一处漏改导致请求打不进来却没有人发现，同时通知值班同学确认监控面板没有异常报警。",
	"值班同学在变更窗口内盯着监控面板的错误率、响应时间和连接数，确认没有明显退化后再关闭发布任务，并把调整前后的数值、观察结果和责任人写进发布记录，方便事后回溯和交接。发布日志会按照日期归档，值班人员可以据此定位发布批次、镜像标签和执行人，出现问题时沿着请求链路检查各个组件。",
	"每次发布都会保留镜像标签、提交编号、发布批次与执行日志，便于出现故障时定位受影响的实例。回滚由 ops/rollback.sh 完成，执行前检查目标镜像仍然可用，执行后观察错误率和请求耗时，并在发布记录中补上回滚原因与实际结果。交接时值班同学会说明尚未完成的巡检和下一班需要关注的报警。",
];

const NEUTRAL_QUESTION = "请依据记忆工具给出结论，并列出你依据的来源。";

function scenarioDefs() {
	return [
		{
			key: "ordered-revision",
			project_name: "release-toolkit",
			other_project_name: "release-toolkit-legacy",
			description:
				"One memory, two ordered revisions: the head revision is the current value. The agent must report the head value and must not surface the superseded revision.",
			question: `项目当前默认端口是多少？${NEUTRAL_QUESTION}`,
			memories: [
				{
					memory_id: "default-port-policy",
					project: "agent",
					title: "默认端口约定",
					keywords: ["默认端口", "端口", "部署"],
					revisions: [
						{ value: "34567", lines: ["本页最早记录的默认端口是 34567。"] },
						{
							value: "45678",
							lines: ["本页在最近一次有序变更后把默认端口更新为 45678，旧的取值不再生效。"],
						},
					],
				},
			],
			expect: {
				must_include: ["45678"],
				must_exclude: ["34567"],
				expect_unresolved: false,
				retain_ids: ["default-port-policy"],
				head_revision: { "default-port-policy": 2 },
			},
		},
		{
			key: "ordered-effective-change",
			project_name: "deploy-runner",
			other_project_name: "deploy-runner-staging",
			description:
				"Two same-scope memories on the same subject, where the newer one states a later definite effective change that supersedes the older. The deterministic subject guard fires, but the prompt says an effective change is not a conflict, so the agent must converge on the new value.",
			question: `项目的部署端口约定是多少？${NEUTRAL_QUESTION}`,
			memories: [
				{
					memory_id: "deploy-port-policy",
					project: "agent",
					title: "部署端口约定",
					keywords: ["部署端口", "端口", "部署"],
					revisions: [{ value: "34567", lines: ["本页记录的是较早的部署端口约定。"] }],
				},
				{
					memory_id: "deploy-port-policy-updated",
					project: "agent",
					title: "部署端口约定（已更新）",
					keywords: ["部署端口", "端口", "部署"],
					revisions: [
						{
							value: "45678",
							lines: [
								"本页记录一次已经生效的变更：部署端口已从 34567 改为 45678 并已上线，本页取代旧约定，后续以 45678 为准。",
							],
						},
					],
				},
			],
			expect: {
				must_include: ["45678"],
				must_exclude: [],
				expect_unresolved: false,
				retain_ids: ["deploy-port-policy", "deploy-port-policy-updated"],
			},
		},
		{
			key: "contradiction-same-title",
			project_name: "billing-api",
			other_project_name: "billing-api-archive",
			description:
				"Two current memories, same scope, same title, different values, neither stated as superseding the other. This is the easy case: the deterministic subject guard already flags it.",
			question: `项目的部署端口约定是多少？${NEUTRAL_QUESTION}`,
			memories: [
				{
					memory_id: "deploy-port-policy",
					project: "agent",
					title: "部署端口约定",
					keywords: ["部署端口", "端口", "部署"],
					revisions: [{ value: "34567", lines: ["本页记录的部署端口是 34567。"] }],
				},
				{
					memory_id: "deploy-port-setting",
					project: "agent",
					title: "部署端口约定",
					keywords: ["部署端口", "端口", "部署"],
					revisions: [{ value: "45678", lines: ["本页记录的部署端口是 45678。"] }],
				},
			],
			expect: {
				must_include: ["34567", "45678"],
				must_exclude: [],
				expect_unresolved: true,
				retain_ids: ["deploy-port-policy", "deploy-port-setting"],
			},
		},
		{
			key: "contradiction-different-title",
			project_name: "edge-gateway",
			other_project_name: "edge-gateway-archive",
			description:
				"Two current memories, same scope, different titles that the subject key does not collide, different values, neither superseding. Only the model judge (and the agent's reading) can see the contradiction.",
			question: `项目的部署或者监听端口到底是多少？${NEUTRAL_QUESTION}`,
			memories: [
				{
					memory_id: "deploy-port-policy",
					project: "agent",
					title: "部署端口约定",
					keywords: ["部署端口", "端口", "部署"],
					revisions: [{ value: "34567", lines: ["部署时使用的端口是 34567。"] }],
				},
				{
					memory_id: "listener-port-note",
					project: "agent",
					title: "服务监听端口说明",
					keywords: ["监听端口", "端口", "服务"],
					revisions: [{ value: "45678", lines: ["服务监听端口当前是 45678，部署脚本也会跟着这个值走。"] }],
				},
			],
			expect: {
				must_include: ["34567", "45678"],
				must_exclude: [],
				expect_unresolved: true,
				retain_ids: ["deploy-port-policy", "listener-port-note"],
			},
		},
		{
			key: "scoped-nonconflict",
			project_name: "media-pipeline",
			other_project_name: "media-pipeline-legacy",
			description:
				"The same title and subject in two different project scopes. The agent answers for its own project and must not treat the other project's value as a conflict.",
			question: `当前这个工作目录（这个项目）的默认端口是多少？只回答这个项目的值。`,
			memories: [
				{
					memory_id: "default-port-policy",
					project: "agent",
					title: "默认端口约定",
					keywords: ["默认端口", "端口"],
					revisions: [{ value: "34567", lines: ["本项目的默认端口是 34567。"] }],
				},
				{
					memory_id: "default-port-policy-legacy",
					project: "other",
					title: "默认端口约定",
					keywords: ["默认端口", "端口"],
					revisions: [{ value: "45678", lines: ["另一个项目的默认端口是 45678。"] }],
				},
			],
			expect: {
				must_include: ["34567"],
				must_exclude: ["45678"],
				expect_unresolved: false,
				retain_ids: ["default-port-policy", "default-port-policy-legacy"],
				hidden_ids: ["default-port-policy-legacy"],
			},
		},
	];
}
const UNRESOLVED_RE =
	/(未知|无法(?:唯一)?确定|不能(?:唯一)?确定|无法(?:唯一)?判断|无法判定|无法给出唯一|尚未确定|不确定|存疑|无法确认|unresolved|unknown|undetermined|cannot determine)/giu;

function reportsUnresolved(prose) {
	UNRESOLVED_RE.lastIndex = 0;
	let match = UNRESOLVED_RE.exec(prose);
	while (match !== null) {
		const before = prose.slice(Math.max(0, match.index - 24), match.index);
		const negated = /(没有|不存在|不|无|非)\s*$/u.test(before)
			|| /(?:不按|不视为|不作为|不是|并非)[^。；\n]{0,15}$/u.test(before);
		if (!negated) return true;
		match = UNRESOLVED_RE.exec(prose);
	}
	return false;
}

function scoreScenario(scenario, { prose, transcript, storeFacts }) {
	const checks = [];
	const proseRefs = new Set(prose.match(/[\w-]+/gu) ?? []);
	const transcriptRefs = new Set(transcript.match(/[\w-]+/gu) ?? []);
	const add = (name, pass, detail = null) => checks.push({ name, pass, detail });

	for (const value of scenario.expect.must_include) {
		add(`prose states ${value}`, prose.includes(value));
	}
	for (const value of scenario.expect.must_exclude) {
		add(`prose omits ${value}`, !prose.includes(value));
	}
	const unresolved = reportsUnresolved(prose);
	if (scenario.expect.expect_unresolved) {
		add("prose reports unresolved", unresolved, `markers=${unresolved}`);
	} else if (scenario.expect.expect_unresolved === false) {
		add("prose does not report unresolved", !unresolved, `markers=${unresolved}`);
	}

	for (const id of scenario.expect.retain_ids) {
		if (scenario.expect.hidden_ids?.includes(id)) {
			add(`transcript excludes ${id}`, !transcriptRefs.has(id));
		} else {
			add(`transcript retains ${id}`, transcriptRefs.has(id));
		}
		if (scenario.expect.expect_unresolved) add(`prose cites ${id}`, proseRefs.has(id));
		const facts = storeFacts.memories[id];
		add(`store retains ${id}`, facts !== null && facts !== undefined, facts === null ? "missing" : null);
	}
	for (const [id, revision] of Object.entries(scenario.expect.head_revision ?? {})) {
		const facts = storeFacts.memories[id];
		add(`store head ${id}=r${revision}`, facts?.revision === revision, `actual=${facts?.revision ?? "null"}`);
	}

	const pass = checks.every((check) => check.pass);
	return { pass, unresolved, checks };
}

async function runScenario({ scenario, repeat, config, key, proxy, budget, runDir, runRoot }) {
	const label = `${scenario.key}-r${repeat}`;
	const organic = scenario.project_name;
	const dirLabel = `${organic}-r${repeat}`;
	const storePath = join(runRoot, "stores", `${dirLabel}.sqlite`);
	conflictStores.add(storePath);
	const projectDir = join(runRoot, "projects", organic);
	const otherProjectDir = join(runRoot, "projects", scenario.other_project_name);
	const sessionDir = join(runRoot, "sessions", dirLabel);
	const obeliskHome = join(runRoot, "obelisk-home", dirLabel);
	const decisionsPath = join(runDir, "decisions", `${label}.jsonl`);
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(otherProjectDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(obeliskHome, { recursive: true });
	mkdirSync(dirname(decisionsPath), { recursive: true });
	rmSync(decisionsPath, { force: true });

	seedScenario({ storePath, scenario, agentProject: projectDir, otherProject: otherProjectDir });

	const env = {
		...process.env,
		VESTIGIO_CONFIG: "",
		PI_CODING_AGENT_DIR: AGENT_HOME,
		PI_CODING_AGENT_SESSION_DIR: sessionDir,
		PI_SKIP_VERSION_CHECK: "1",
		VESTIGIO_STORE: storePath,
		VESTIGIO_PROJECT_ID: projectDir,
		VESTIGIO_OBELISK_HOME: obeliskHome,
		VESTIGIO_DECISION_LOG: decisionsPath,
		VESTIGIO_MODEL_BASE_URL: proxy.url,
		VESTIGIO_MODEL_ID: config.extension_model,
		VESTIGIO_MODEL_THINKING: config.extension_thinking,
		VESTIGIO_MODEL_API_KEY: key,
	};
	const args = [
		"--mode",
		"rpc",
		"--provider",
		config.provider,
		"--model",
		config.agent_model,
		"--thinking",
		config.agent_thinking,
		"--no-context-files",
		"--no-mcp",
		"--no-extensions",
		"-e",
		EXT,
		"--tools",
		CONFLICT_TOOL_ALLOWLIST.join(","),
		"--session-dir",
		sessionDir,
	];
	const proc = spawn(PI, args, { cwd: projectDir, env, stdio: ["pipe", "pipe", "pipe"] });
	const client = new PiClient(proc);

	const startedIso = new Date().toISOString();
	const turnStart = Date.now();
	let rpcError = null;
	let exitCode = null;
	try {
		await client.promptAndSettle(`${label}-1`, scenario.question);
	} catch (error) {
		rpcError = String(error.message ?? error);
	} finally {
		exitCode = await client.close();
	}
	const latencyMs = Date.now() - turnStart;

	const prose = redactText(assistantProse(client));
	const toolTexts = toolResultTexts(client).map(redactText);
	const calls = toolCalls(client);
	const transcript = redactText([...toolTexts, prose, JSON.stringify(calls)].join("\n"));
	const storeFacts = readStoreFacts(storePath, scenario.memories.map((spec) => spec.memory_id));
	const score = scoreScenario(scenario, { prose, transcript, storeFacts });
	const resolverStatus = readResolverStatus(decisionsPath);

	const result = {
		key: scenario.key,
		description: scenario.description,
		repeat,
		question: scenario.question,
		started_at: startedIso,
		latency_ms: latencyMs,
		rpc_error: rpcError,
		pi_exit_code: exitCode,
		pass: score.pass && rpcError === null && exitCode === 0,
		unresolved_marker: score.unresolved,
		checks: score.checks,
		resolver_status: resolverStatus,
		store: storeFacts,
		tool_calls: calls,
		stderr_tail: redactText(client.stderr).split("\n").slice(-20).join("\n"),
	};

	mkdirSync(join(runDir, "prose"), { recursive: true });
	mkdirSync(join(runDir, "tools"), { recursive: true });
	writeFileSync(join(runDir, "prose", `${label}.txt`), `${redactText(prose)}\n`, "utf8");
	writeFileSync(join(runDir, "tools", `${label}.txt`), `${transcript}\n`, "utf8");
	writeJson(join(runDir, "results", `${label}.json`), result);
	return result;
}
function selftest() {
	const scenarios = scenarioDefs();
	const stamp = timestamp();
	const scratchRoot = join(TMP, `conflicts-selftest-${stamp}`);
	mkdirSync(scratchRoot, { recursive: true });
	try {
		for (const scenario of scenarios) {
			const storePath = join(scratchRoot, "stores", `${scenario.key}.sqlite`);
			conflictStores.add(storePath);
			seedScenario({
				storePath,
				scenario,
				agentProject: join(scratchRoot, "project"),
				otherProject: join(scratchRoot, "project-other"),
			});
			const ids = scenario.memories.map((spec) => spec.memory_id);
			const facts = readStoreFacts(storePath, ids);
			if (facts.memory_count !== ids.length) {
				throw new Error(`${scenario.key}: seeded ${facts.memory_count} memories, expected ${ids.length}`);
			}
			for (const id of ids) {
				if (facts.memories[id] === null) throw new Error(`${scenario.key}: ${id} missing after seed`);
			}
		}
		const sameTitle = scenarios.find((scenario) => scenario.key === "contradiction-same-title");
		const diffTitle = scenarios.find((scenario) => scenario.key === "contradiction-different-title");
		const ordered = scenarios.find((scenario) => scenario.key === "ordered-revision");
		const effective = scenarios.find((scenario) => scenario.key === "ordered-effective-change");
		const scoped = scenarios.find((scenario) => scenario.key === "scoped-nonconflict");
		const keepBoth = (scenario) => scenario.memories.map((spec) => spec.memory_id).join(" ");

		const cases = [
			{
				name: "other project remains stored but hidden",
				scenario: scoped,
				prose: "本项目当前默认端口是 34567。",
				transcript: "memory://vestigio/default-port-policy",
				want: true,
			},
			{
				name: "same-title unresolved passes",
				scenario: sameTitle,
				prose: `记忆里两种说法不一致：34567 和 45678，当前值无法确定。来源 ${keepBoth(sameTitle)}`,
				transcript: keepBoth(sameTitle),
				want: true,
			},
			{
				name: "unknown value with both sources passes",
				scenario: sameTitle,
				prose: `当前值未知，34567 与 45678 不能裁决。来源 ${keepBoth(sameTitle)}`,
				transcript: keepBoth(sameTitle),
				want: true,
			},
			{
				name: "same-title one-sided fails",
				scenario: sameTitle,
				prose: "当前部署端口是 45678。",
				transcript: keepBoth(sameTitle),
				want: false,
			},
			{
				name: "different-title unresolved passes",
				scenario: diffTitle,
				prose: `两条记忆互相矛盾：34567 与 45678 都自称当前值，当前值无法确定，来源 ${keepBoth(diffTitle)}`,
				transcript: keepBoth(diffTitle),
				want: true,
			},
			{
				name: "unresolved without source citations fails",
				scenario: sameTitle,
				prose: "34567 和 45678 互相矛盾，当前值无法确定。",
				transcript: keepBoth(sameTitle),
				want: false,
			},
			{
				name: "ordered head passes",
				scenario: ordered,
				prose: "当前默认端口是 45678。",
				transcript: "default-port-policy",
				want: true,
			},
			{
				name: "conflict heading and negated conflict are not uncertainty",
				scenario: ordered,
				prose: "当前默认端口是 45678。冲突检查：未发现冲突。",
				transcript: "default-port-policy",
				want: true,
			},
			{
				name: "negated unknown label is a settled answer",
				scenario: ordered,
				prose: "当前默认端口是 45678，因此不按「当前值未知」处理。",
				transcript: "default-port-policy",
				want: true,
			},
			{
				name: "ordered old value fails",
				scenario: ordered,
				prose: "当前默认端口是 34567。",
				transcript: "default-port-policy",
				want: false,
			},
			{
				name: "effective change passes without conflict",
				scenario: effective,
				prose: "部署端口已从 34567 改为 45678 并已生效，当前以 45678 为准。",
				transcript: keepBoth(effective),
				want: true,
			},
			{
				name: "effective change called a conflict fails",
				scenario: effective,
				prose: "两条记忆互相矛盾，34567 与 45678 无法确定。",
				transcript: keepBoth(effective),
				want: false,
			},
		];
		for (const testCase of cases) {
			const storePath = join(scratchRoot, "stores", `${testCase.scenario.key}.sqlite`);
			conflictStores.add(storePath);
			const realFacts = readStoreFacts(storePath, testCase.scenario.memories.map((spec) => spec.memory_id));
			const score = scoreScenario(testCase.scenario, {
				prose: testCase.prose,
				transcript: testCase.transcript,
				storeFacts: realFacts,
			});
			if (score.pass !== testCase.want) {
				throw new Error(
					`scorer case "${testCase.name}": expected pass=${testCase.want}, got ${score.pass} (${JSON.stringify(
						score.checks.filter((check) => !check.pass),
					)})`,
				);
			}
		}
		console.log(`selftest PASS: ${scenarios.length} scenarios, ${cases.length} scorer cases`);
		return 0;
	} finally {
		rmSync(scratchRoot, { recursive: true, force: true });
	}
}

function parseArgs(argv) {
	const options = { only: null, repeat: 1, help: false, selftest: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--only") options.only = argv[++index];
		else if (arg === "--repeat") options.repeat = Number(argv[++index]);
		else if (arg === "--selftest") options.selftest = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (!Number.isInteger(options.repeat) || options.repeat < 1) {
		throw new Error("--repeat must be a positive integer");
	}
	return options;
}

function printSummary(results) {
	const header = ["scenario", "repeat", "pass", "unresolved", "latency", "failed checks"];
	console.log(`\n${header.join("\t")}`);
	for (const result of results) {
		const failed = result.checks.filter((check) => !check.pass).map((check) => check.name);
		console.log(
			[
				result.key,
				result.repeat,
				result.pass ? "PASS" : "FAIL",
				result.unresolved_marker ? "yes" : "no",
				`${(result.latency_ms / 1000).toFixed(1)}s`,
				failed.length === 0 ? "-" : failed.join("; "),
			].join("\t"),
		);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(
			"usage: node --import ../pi/hook.mjs ./conflicts.mjs [--only <key>[,<key>...]] [--repeat <n>] [--selftest]",
		);
		return 0;
	}
	if (options.selftest) return selftest();

	const config = loadConfig();
	const key = readMagpieKey();
	registerSecret(key);

	const all = scenarioDefs();
	const names =
		options.only === null
			? all.map((scenario) => scenario.key)
			: options.only
					.split(",")
					.map((name) => name.trim())
					.filter((name) => name.length > 0);
	const scenarios = names.map((name) => {
		const found = all.find((scenario) => scenario.key === name);
		if (found === undefined) {
			throw new Error(`unknown scenario "${name}" (expected ${all.map((scenario) => scenario.key).join("|")})`);
		}
		return found;
	});

	const stamp = timestamp();
	const runDir = join(RUNS_DIR, `${stamp}-conflicts`);
	const runRoot = join(TMP, "work", stamp);
	AGENT_HOME = join(TMP, `agent-${stamp}`);
	mkdirSync(runDir, { recursive: true });
	mkdirSync(runRoot, { recursive: true });
	mkdirSync(join(runDir, "decisions"), { recursive: true });

	const gitCommit = (() => {
		try {
			return childFirstLine("git", ["rev-parse", "HEAD"], ROOT);
		} catch {
			return null;
		}
	})();
	const piVersion = (() => {
		try {
			return childFirstLine(PI, ["--version"], ROOT);
		} catch {
			return null;
		}
	})();
	const realObeliskBefore = existsSync(REAL_OBELISK) ? statSync(REAL_OBELISK).mtimeMs : null;

	const budget = {
		maxModelCalls: config.max_model_calls,
		maxTokens: config.max_total_tokens,
		wallClockMs: config.wall_clock_ms,
		calls: 0,
		tokens: 0,
		exceeded: false,
		reason: null,
	};
	const proxy = await startProxy({
		upstream: config.endpoint,
		logPath: join(runDir, "requests.jsonl"),
		failuresDir: join(runDir, "failures"),
		budget,
	});
	buildAgentHome(AGENT_HOME, proxy.url);

	const wallDeadline = Date.now() + config.wall_clock_ms;
	const results = [];
	let aborted = false;
	try {
		for (const scenario of scenarios) {
			for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
				if (budget.exceeded) {
					aborted = true;
					break;
				}
				if (Date.now() > wallDeadline) {
					aborted = true;
					budget.exceeded = true;
					budget.reason = `wall_clock_ms ${config.wall_clock_ms} exceeded`;
					break;
				}
				console.log(`\n=== ${scenario.key} r${repeat} ===`);
				const result = await runScenario({
					scenario,
					repeat,
					config,
					key,
					proxy,
					budget,
					runDir,
					runRoot,
				});
				results.push(result);
				for (const check of result.checks) {
					console.log(`  ${check.pass ? "ok  " : "FAIL"} ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
				}
				const resolver =
					result.resolver_status.map((item) => `${item.tool}=${item.status}`).join(", ") || "none";
				console.log(`  resolver status (evidence, not scored): ${resolver}`);
				console.log(`  -> ${result.pass ? "PASS" : "FAIL"} (${(result.latency_ms / 1000).toFixed(1)}s)`);
			}
			if (aborted) break;
		}
	} finally {
		await proxy.close();
	}

	const summary = {
		harness: "conflicts",
		version: 1,
		started_at: stamp,
		git_commit: gitCommit,
		pi_version: piVersion,
		config: {
			endpoint: config.endpoint,
			provider: config.provider,
			agent_model: config.agent_model,
			agent_thinking: config.agent_thinking,
			extension_model: config.extension_model,
			extension_thinking: config.extension_thinking,
			tools: CONFLICT_TOOL_ALLOWLIST,
			max_model_calls: config.max_model_calls,
			max_total_tokens: config.max_total_tokens,
			wall_clock_ms: config.wall_clock_ms,
		},
		proxy_stats: proxy.stats,
		aborted,
		abort_reason: budget.exceeded ? budget.reason : null,
		results,
	};
	writeJson(join(runDir, "summary.json"), summary);
	printSummary(results);
	console.log(`\nrun directory: ${runDir}`);

	const realObeliskAfter = existsSync(REAL_OBELISK) ? statSync(REAL_OBELISK).mtimeMs : null;
	const obeliskUnchanged = realObeliskBefore === realObeliskAfter;
	console.log(`real Obelisk index unchanged: ${obeliskUnchanged}`);
	if (!obeliskUnchanged) {
		console.error("FATAL: the real Obelisk index mtime changed during the run");
		return 4;
	}
	if (aborted) {
		console.error(`run aborted by guardrail: ${budget.reason}`);
		return 3;
	}
	const failed = results.filter((result) => !result.pass);
	return failed.length === 0 ? 0 : 1;
}

async function run() {
	let code = 2;
	try {
		code = await main();
	} catch (error) {
		console.error("conflict harness error:", error);
	} finally {
		for (const store of conflictStores) {
			await new VestigioClient(store).stop();
			if (await daemonRunning(store)) {
				console.error(`leaked daemon for: ${store}`);
				code = 1;
			}
		}
		if (AGENT_HOME !== null) rmSync(AGENT_HOME, { recursive: true, force: true });
	}
	process.exit(code);
}

export { scenarioDefs, scoreScenario };

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
	await run();
}
