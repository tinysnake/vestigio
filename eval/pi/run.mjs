#!/usr/bin/env node
/**
 * PR-05 harness: the real pi `input` path against a local mock provider.
 *
 * It never talks to a real model and never reaches the operator's Obelisk
 * index. Each run creates its own session, store, and history directories.
 * The extension is loaded explicitly with `-e` while
 * `--no-extensions` disables discovery, so the operator's own extensions are
 * not involved.
 *
 * Usage: node --import ./hook.mjs run.mjs [--dump <scenario>]
 *
 * For each scenario the wire request bodies are the authority: the harness
 * asserts on the final user message text that pi actually sent to the provider,
 * not on the extension's own logs.
 */

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarioStale } from "./stale.mjs";
import { scenarioRequest } from "./request.mjs";
import { stopProbeDaemons } from "../lib/daemon.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HERE = join(ROOT, "eval/pi");
const TMP = mkdtempSync(join(tmpdir(), "vestigio-pi-"));
const CWD = join(TMP, "cwd");
const PROJECT = join(TMP, "project");
const PERF_PROJECT = join(TMP, "perf-project");
const EMPTY_PROJECT = join(TMP, "project-empty");
let runStore = join(TMP, "run.sqlite");
const usedStores = new Set([runStore]);
const SEED_STORE = join(TMP, "seed.sqlite");
const OBELISK_HOME = join(TMP, "obelisk-home");
const EXT = join(ROOT, "packages/pi-extension/src/extension.ts");
const THROWER = join(HERE, "extensions/throw-on-input.ts");
const CLI = join(ROOT, "packages/cli/bin/vestigio");
const AGENT_DIR = join(TMP, "agent");
const PI = process.env.PI_BIN ?? join(ROOT, "packages/pi-extension/node_modules/.bin/pi");
const REAL_OBELISK = join(homedir(), ".obelisk/obelisk.sqlite");

const OPEN_TAG = "<vestigio_memory_note>";
const CLOSE_TAG = "</vestigio_memory_note>";

// ---------------------------------------------------------------- mock server

function startMock() {
	const requests = [];
	let delayMs = 0;
	let responder = () => ({ content: "OK" });
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			let body = null;
			try {
				body = JSON.parse(raw);
			} catch {
				body = null;
			}
			requests.push({ ts: Date.now(), url: req.url, body });
			if (req.url.includes("/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "mock-1", object: "model" }] }));
				return;
			}
			const reply = async () => {
				const message = { role: "assistant", ...await responder(body) };
				const finishReason = message.tool_calls?.length ? "tool_calls" : "stop";
				const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
				if (body?.stream === true) {
					res.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					});
					const chunk = (delta, finish) =>
						`data: ${JSON.stringify({
							id: "chatcmpl-mock",
							object: "chat.completion.chunk",
							created: Math.floor(Date.now() / 1000),
							model: "mock-1",
							choices: [{ index: 0, delta, finish_reason: finish }],
						})}\n\n`;
					res.write(chunk(message, null));
					res.write(
						`data: ${JSON.stringify({
							id: "chatcmpl-mock",
							object: "chat.completion.chunk",
							created: Math.floor(Date.now() / 1000),
							model: "mock-1",
							choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
							usage,
						})}\n\n`,
					);
					res.write("data: [DONE]\n\n");
					res.end();
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						id: "chatcmpl-mock",
						object: "chat.completion",
						created: Math.floor(Date.now() / 1000),
						model: "mock-1",
						choices: [{ index: 0, message, finish_reason: finishReason }],
						usage,
					}),
				);
			};
			const respond = () => void reply().catch((error) => res.destroy(error));
			if (delayMs > 0) setTimeout(respond, delayMs);
			else respond();
		});
	});
	return {
		requests,
		setDelay(ms) {
			delayMs = ms;
		},
		setResponder(fn) {
			responder = fn ?? (() => ({ content: "OK" }));
		},
		get port() {
			return server.address().port;
		},
		async listen() {
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject);
					resolve();
				});
			});
		},
		async close() {
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

// ---------------------------------------------------------------- pi client

let callId = 0;

class PiClient {
	constructor(proc) {
		this.proc = proc;
		this.events = [];
		this.stderr = "";
		this.exited = new Promise((resolve) => proc.on("close", (code) => resolve(code ?? -1)));
		const rl = createInterface({ input: proc.stdout });
		rl.on("line", (line) => {
			try {
				const event = JSON.parse(line);
				this.events.push(event);
				if (process.env.VESTIGIO_HARNESS_DEBUG === "1") {
					console.error(`[rpc] ${event.type}${event.command ? ` ${event.command}` : ""}${event.success === false ? ` FAILED ${JSON.stringify(event.error)}` : ""}`);
				}
			} catch {
				// non-JSON stdout line: ignore, the wire is the authority
			}
		});
		proc.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
	}

	send(command) {
		this.proc.stdin.write(`${JSON.stringify(command)}\n`);
	}

	async waitFor(pred, timeoutMs = 60000, from = 0) {
		const deadline = Date.now() + timeoutMs;
		let cursor = from;
		while (Date.now() < deadline) {
			while (cursor < this.events.length) {
				const event = this.events[cursor];
				cursor += 1;
				if (event !== undefined && pred(event)) return event;
			}
			await sleep(15);
		}
		throw new Error(
			`timed out after ${timeoutMs}ms waiting for an RPC event; saw: ${this.events
				.slice(-8)
				.map((event) => event.type)
				.join(", ")}`,
		);
	}

	settle(timeoutMs = 60000) {
		const from = this.events.length;
		return this.waitFor((event) => event.type === "agent_settled", timeoutMs, from);
	}

	async prompt(message, id = String(++callId)) {
		this.send({ id, type: "prompt", message });
		return this.settle();
	}

	async settleCount(count, timeoutMs = 60000) {
		const from = this.events.length;
		let seen = 0;
		await this.waitFor((event) => {
			if (event.type !== "agent_settled") return false;
			seen += 1;
			return seen >= count;
		}, timeoutMs, from);
	}

	async close() {
		try {
			this.proc.stdin.end();
		} catch {
			// already closed
		}
		const timer = setTimeout(() => this.proc.kill("SIGKILL"), 3000);
		const code = await this.exited;
		clearTimeout(timer);
		return code;
	}
}

function spawnPi({ name, project = PROJECT, cwd = CWD, extraExtensions = [], continueSession = false, disableExtension = false, keepSessions = false, env = {} }) {
	const sessionDir = join(TMP, "sessions", name);
	if (!keepSessions) {
		rmSync(sessionDir, { recursive: true, force: true });
	}
	mkdirSync(sessionDir, { recursive: true });
	const decisions = join(TMP, `decisions-${name}.jsonl`);
	if (!keepSessions) rmSync(decisions, { force: true });
	const args = [
		"--mode",
		"rpc",
		"--provider",
		"mock",
		"--model",
		"mock-1",
		"--no-context-files",
		"--no-mcp",
		"--no-extensions",
		...(disableExtension ? [] : ["-e", EXT]),
		...extraExtensions.flatMap((path) => ["-e", path]),
		"--prompt-template",
		join(HERE, "prompts"),
		"--skill",
		join(HERE, "skills"),
		"--session-dir",
		sessionDir,
	];
	if (continueSession) args.push("--continue");
	const childEnv = {
		...process.env,
		VESTIGIO_CONFIG: "",
		PI_CODING_AGENT_DIR: AGENT_DIR,
		PI_CODING_AGENT_SESSION_DIR: sessionDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		VESTIGIO_STORE: runStore,
		VESTIGIO_MODEL_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
		VESTIGIO_MODEL_ID: "mock-1",
		VESTIGIO_MODEL_API_KEY: "mock",
		// `project: null` leaves the id unset so the session cwd decides it.
		...(project === null ? {} : { VESTIGIO_PROJECT_ID: project }),
		// Explicit isolated history home: the extension can never fall back to
		// the operator's real Obelisk index.
		VESTIGIO_OBELISK_HOME: OBELISK_HOME,
		VESTIGIO_DECISION_LOG: decisions,
		...env,
	};
	const proc = spawn(PI, args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
	return { client: new PiClient(proc), sessionDir, decisions };
}

function decisionRecords(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

// ---------------------------------------------------------------- wire helpers

function chatRequests(fromIndex) {
	return mock.requests.slice(fromIndex).filter((entry) => entry.body?.stream === true && Array.isArray(entry.body.messages));
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

function userMessages(entry) {
	return (entry.body?.messages ?? [])
		.map((message, index) => ({ index, role: message.role, text: contentText(message.content) }))
		.filter((message) => message.role === "user");
}

function lastUserText(entry) {
	const users = userMessages(entry);
	return users.length === 0 ? "" : users[users.length - 1].text;
}

function systemText(entry) {
	return (entry.body?.messages ?? [])
		.filter((message) => message.role === "system")
		.map((message) => contentText(message.content))
		.join("\n");
}

function blockCount(text) {
	return text.split(OPEN_TAG).length - 1;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, p) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)];
}

function stats(values) {
	if (values.length === 0) return { n: 0, p50: null, p95: null, max: null, mean: null };
	return {
		n: values.length,
		p50: round(percentile(values, 50)),
		p95: round(percentile(values, 95)),
		max: round(Math.max(...values)),
		mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
	};
}

function round(value) {
	return value === null ? null : Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------- reporting

const checks = [];
function check(name, ok, detail = "") {
	checks.push({ name, ok: Boolean(ok), detail });
}
function report(title, lines) {
	console.log(`\n=== ${title} ===`);
	for (const line of lines) console.log(line);
}

// ---------------------------------------------------------------- scenarios

async function scenarioNewSession() {
	const { client, decisions } = spawnPi({ name: "new-session" });
	const wireFrom = mock.requests.length;
	try {
		await client.prompt("部署 端口 需要修改", "1");
		const first = chatRequests(wireFrom).at(-1);
		const firstText = first ? lastUserText(first) : "";
		check("new_session: first turn injected a block", blockCount(firstText) === 1, `${blockCount(firstText)} block(s)`);
		check("new_session: append is the tail of the user message", firstText.endsWith(CLOSE_TAG), tail(firstText));
		check("new_session: block names the matched memory", firstText.includes("memory://vestigio/mem-deploy-port"));
		check("new_session: block offers the read tool", firstText.includes('memory_read(uri="memory://vestigio/mem-deploy-port")'));
		check("new_session: system prompt carries no memory content", !systemText(first).includes("memory://vestigio/mem-deploy-port"));
		check("new_session: no medium body on the wire", !firstText.includes("18080"), tail(firstText, 60));
		check(
			"new_session: no cross-project memory on the wire",
			!firstText.includes("mem-perf-00") && !firstText.includes("mem-migration"),
		);

		await client.prompt("部署 端口 再确认一次", "2");
		const second = chatRequests(wireFrom).at(-1);
		const secondText = second ? lastUserText(second) : "";
		check("new_session: repeat turn did not re-inject", blockCount(secondText) === 0, `${blockCount(secondText)} block(s)`);
		const total = chatRequests(wireFrom).reduce((sum, entry) => sum + blockCount(lastUserText(entry)), 0);
		check("new_session: exactly one block across the session", total === 1, `${total} block(s)`);

		const records = decisionRecords(decisions).filter((record) => record.kind === "input");
		check("new_session: decision log records the delivered card and budget", records.some((record) =>
			record.status === "injected" && record.memory_ids?.includes("mem-deploy-port") && record.estimated_tokens > 0,
		));
		check("new_session: decision log records the dedup", records.some((record) => record.reason === "all_deduped" && record.memory_ids?.length === 0));
		report("new_session decisions", records.map((record) => `  ${record.status} reason=${record.reason} injected=${record.injected ?? 0}`));
	} finally {
		check("new_session: pi exits cleanly", (await client.close()) === 0);
	}
}

async function scenarioSearchRecovery() {
	const cases = [
		{ name: "image-tag", question: "打包成容器的时候名字怎么起", query: "容器 镜像 命名 container image name", rewrites: [], hits: ["mem-docker-image"], calls: 2, hint: "checked against the original question" },
		{ name: "image-layer", question: "帮我把 docker 镜像中间层合并一下", query: "docker 镜像 中间层 合并", rewrites: [], hits: [], calls: 2, hint: "no relevant card found" },
		{ name: "literal", question: "之前镜像标签怎么定的", query: "镜像标签", hits: ["mem-docker-image"], calls: 0 },
	];
	for (const { name, question, query, rewrites, hits, calls, hint } of cases) {
		let toolAsked = false;
		const modelInputs = [];
		let toolResult;
		mock.setResponder((body) => {
			if (body?.stream === false) {
				const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
				const user = body.messages?.find((message) => message.role === "user")?.content ?? "";
				if (!system.includes("next_queries") && !system.includes("relevant_ids")) return { content: "{}" };
				modelInputs.push(user);
				return { content: JSON.stringify(system.includes("relevant_ids") ? { relevant_ids: hits } : { next_queries: rewrites }) };
			}
			if (!toolAsked) {
				toolAsked = true;
				return { content: null, tool_calls: [{ index: 0, id: `search-${name}`, type: "function", function: { name: "memory_search", arguments: JSON.stringify({ query }) } }] };
			}
			toolResult = body?.messages.findLast((message) => message.role === "tool")?.content;
			return { content: "OK" };
		});
		const { client } = spawnPi({ name: `search-${name}` });
		try {
			await client.prompt(question, `search-recovery-${name}`);
			const result = JSON.stringify(toolResult) ?? "";
			check(`search_recovery ${name}: delivered expected cards`, result.includes(hits.length > 0 ? "-> partial | 1 card(s)" : "-> not_found | 0 card(s)") && result.includes("memory://vestigio/mem-docker-image") === (hits.length > 0), result.slice(0, 280));
			check(`search_recovery ${name}: bounded model calls with original question`, modelInputs.length === calls && modelInputs.every((input) => input.includes(question)), `${modelInputs.length}/${calls}`);
			check(`search_recovery ${name}: tool text describes recovery`, hint === undefined ? !result.includes("recovery:") : result.includes(hint));
		} finally {
			await client.close();
			mock.setResponder(null);
		}
	}
}

async function scenarioWorktree() {
	// A real repository with a linked worktree. The fixture rows are scoped to the
	// repository root, and the session runs from the second worktree with no
	// explicit project id, so a delivered card proves the cwd resolved to the root.
	const realTmp = realpathSync(TMP);
	const repo = join(realTmp, "worktree-repo");
	const worktreeB = join(realTmp, "worktree-b");
	const storePath = join(realTmp, "worktree.sqlite");
	usedStores.add(storePath);
	mkdirSync(repo, { recursive: true });
	const gitEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "vestigio-harness",
		GIT_AUTHOR_EMAIL: "vestigio-harness@example.com",
		GIT_COMMITTER_NAME: "vestigio-harness",
		GIT_COMMITTER_EMAIL: "vestigio-harness@example.com",
	};
	execFileSync("git", ["-C", repo, "init", "-q"], { env: gitEnv });
	writeFileSync(join(repo, "README.md"), "harness\n");
	execFileSync("git", ["-C", repo, "add", "."], { env: gitEnv });
	execFileSync("git", ["-C", repo, "commit", "-qm", "init"], { env: gitEnv });
	execFileSync("git", ["-C", repo, "worktree", "add", "-q", worktreeB], { env: gitEnv });

	const seeded = execFileSync(
		process.execPath,
		["--import", join(HERE, "hook.mjs"), join(HERE, "seed.mjs"), storePath, repo, repo],
		{ encoding: "utf8" },
	);
	check("worktree: the fixture store is scoped to the repository root", seeded.includes(repo), seeded.trim());

	runStore = storePath;
	const { client } = spawnPi({ name: "worktree", project: null, cwd: worktreeB });
	const wireFrom = mock.requests.length;
	try {
		await client.prompt("部署 端口 需要修改", "worktree-1");
		const first = chatRequests(wireFrom).at(-1);
		const firstText = first ? lastUserText(first) : "";
		check("worktree: session cwd resolved to the repository root", firstText.includes("memory://vestigio/mem-deploy-port"), tail(firstText));
		check("worktree: exactly one block was injected", blockCount(firstText) === 1, `${blockCount(firstText)} block(s)`);
	} finally {
		check("worktree: pi exits cleanly", (await client.close()) === 0);
	}

	const explicit = spawnPi({ name: "worktree-explicit", project: worktreeB, cwd: EMPTY_PROJECT });
	const explicitFrom = mock.requests.length;
	try {
		await explicit.client.prompt("部署 端口 需要修改", "worktree-2");
		const first = chatRequests(explicitFrom).at(-1);
		const firstText = first ? lastUserText(first) : "";
		check("worktree: an explicit project id wins and is canonicalized", firstText.includes("memory://vestigio/mem-deploy-port"), tail(firstText));
	} finally {
		check("worktree: explicit session exits cleanly", (await explicit.client.close()) === 0);
	}
}

async function scenarioCompound() {
	// Two questions in one turn, sent as one query. The pool holds `部署 端口`, not
	// `日志保留期`, and the conjunction matches nothing, so the page is empty and
	// recovery runs without selecting either clause. This measures the loss; it
	// asserts today's behaviour, so run it with `--only compound` and flip the
	// checks when a fix lands.
	let toolAsked = false;
	const modelInputs = [];
	let toolResult;
	mock.setResponder((body) => {
		if (body?.stream === false) {
			const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
			if (!system.includes("next_queries") && !system.includes("relevant_ids")) return { content: "{}" };
			modelInputs.push(body.messages?.find((message) => message.role === "user")?.content ?? "");
			return { content: JSON.stringify(system.includes("relevant_ids") ? { relevant_ids: [] } : { next_queries: [] }) };
		}
		if (!toolAsked) {
			toolAsked = true;
			return { content: null, tool_calls: [{ index: 0, id: "search-compound", type: "function", function: { name: "memory_search", arguments: JSON.stringify({ query: "部署 端口 日志保留期" }) } }] };
		}
		toolResult = body?.messages.findLast((message) => message.role === "tool")?.content;
		return { content: "OK" };
	});
	const { client } = spawnPi({ name: "compound" });
	try {
		await client.prompt("部署端口要改吗，另外日志保留期是多少", "compound");
		const result = JSON.stringify(toolResult) ?? "";
		const heldAlone = JSON.parse(
			execFileSync(CLI, ["search", "--db", runStore, "--project", PROJECT, "--query", "部署 端口", "--json"], { encoding: "utf8" }),
		);
		const heldUris = (heldAlone.result?.cards ?? []).map((card) => card.uri ?? card.memory_uri);
		check("compound: the held clause alone finds its card", heldUris.some((uri) => uri?.includes("mem-deploy-port")), heldUris.join(" "));
		check("compound: the clause the pool holds is lost in the combined query", result.includes("-> not_found | 0 card(s)") && !result.includes("memory://vestigio/mem-deploy-port"), result.slice(0, 240));
		check("compound: recovery runs and still returns nothing", result.includes("no relevant card found"));
		check("compound: two recovery model calls for one turn", modelInputs.length === 2, `${modelInputs.length} call(s)`);
	} finally {
		await client.close();
		mock.setResponder(null);
	}
}

async function scenarioContinue() {
	const { client, decisions } = spawnPi({ name: "continue" });
	try {
		await client.prompt("部署 端口 起步", "1");
	} finally {
		await client.close();
	}
	const { client: resumed, decisions: resumedDecisions } = spawnPi({ name: "continue", continueSession: true, keepSessions: true });
	const wireFrom = mock.requests.length;
	try {
		await resumed.prompt("部署 端口 继续", "2");
		const last = chatRequests(wireFrom).at(-1);
		const text = last ? lastUserText(last) : "";
		check("continue: resumed session did not re-inject", blockCount(text) === 0, `${blockCount(text)} block(s)`);
		const records = decisionRecords(resumedDecisions).filter((record) => record.kind === "input");
		check("continue: decision log records the dedup", records.some((record) => record.reason === "all_deduped"));
		report("continue decisions", records.map((record) => `  ${record.status} reason=${record.reason}`));
	} finally {
		check("continue: pi exits cleanly", (await resumed.close()) === 0);
	}
	check("continue: first process wrote decisions", decisionRecords(decisions).length > 0);
}

async function scenarioCompaction() {
	const { client, decisions } = spawnPi({ name: "compaction" });
	const wireFrom = mock.requests.length;
	try {
		await client.prompt("部署 端口 第一轮", "1");
		const first = chatRequests(wireFrom).at(-1);
		check("compaction: pre-compaction turn injected", blockCount(lastUserText(first)) === 1);
		const compactFrom = client.events.length;
		client.send({ id: "compact", type: "compact", customInstructions: "保留要点" });
		await client.waitFor(
			(event) => event.type === "compaction_end" || (event.type === "response" && event.command === "compact"),
			120000,
			compactFrom,
		);
		await client.prompt("部署 端口 第二轮", "3");
		const after = chatRequests(wireFrom).at(-1);
		check("compaction: post-compaction turn did not re-inject", blockCount(lastUserText(after)) === 0, tail(lastUserText(after)));
		const records = decisionRecords(decisions).filter((record) => record.kind === "input");
		check("compaction: decision log records the dedup", records.some((record) => record.reason === "all_deduped"));
		report("compaction decisions", records.map((record) => `  ${record.status} reason=${record.reason}`));
	} finally {
		check("compaction: pi exits cleanly", (await client.close()) === 0);
	}
}

async function slashScenario(name, promptText, bodyMarker) {
	const { client, decisions } = spawnPi({ name });
	const wireFrom = mock.requests.length;
	try {
		await client.prompt(promptText, "1");
		const last = chatRequests(wireFrom).at(-1);
		const text = last ? lastUserText(last) : "";
		check(`${name}: expansion survived`, text.includes(bodyMarker), text.slice(0, 120));
		check(`${name}: no hotspot block`, blockCount(text) === 0, `${blockCount(text)} block(s)`);
		const records = decisionRecords(decisions).filter((record) => record.kind === "input");
		check(`${name}: not-injected with slash_command reason`, records.some((record) => record.reason === "slash_command"));
		check(`${name}: no store_error`, !records.some((record) => record.reason === "store_error"));
		report(`${name} decisions`, records.map((record) => `  ${record.status} reason=${record.reason} text=${JSON.stringify(record.detail ?? "")}`));
	} finally {
		check(`${name}: pi exits cleanly`, (await client.close()) === 0);
	}
}

async function scenarioQueuedInput() {
	// The mock reply is delayed so the follow-up arrives while the first turn is
	// still streaming; otherwise pi is already idle and nothing drains the queue.
	mock.setDelay(800);
	const { client, decisions } = spawnPi({ name: "queued" });
	const wireFrom = mock.requests.length;
	try {
		const from = client.events.length;
		client.send({ id: "1", type: "prompt", message: "部署 端口 先看" });
		// Queued while the first turn is streaming (the mock reply is delayed).
		await client.waitFor((event) => event.type === "agent_start", 30000, from);
		await sleep(120);
		client.send({ id: "2", type: "follow_up", message: "迁移 回滚 也要看" });
		await client.settle(90000);
		await sleep(200);
		const requests = chatRequests(wireFrom);
		const base = requests.at(-2);
		const queued = requests.at(-1);
		const baseText = base ? lastUserText(base) : "";
		const queuedText = queued ? lastUserText(queued) : "";
		check("queued: base turn injected its memory", baseText.includes("mem-deploy-port"), tail(baseText));
		check("queued: follow-up turn injected a different memory", queuedText.includes("mem-migration"), tail(queuedText));
		check("queued: follow-up append is the tail", queuedText.endsWith(CLOSE_TAG));
		check("queued: follow-up did not repeat the base memory", !queuedText.includes("mem-deploy-port"));
		const records = decisionRecords(decisions).filter((record) => record.kind === "input");
		check("queued: two input decisions", records.length >= 2, `${records.length}`);
		report("queued decisions", records.map((record) => `  ${record.status} reason=${record.reason} source=${record.source}/${record.streaming_behavior}`));
	} finally {
		mock.setDelay(0);
		check("queued: pi exits cleanly", (await client.close()) === 0);
	}
}

async function scenarioSteer() {
	mock.setDelay(600);
	const { client, decisions } = spawnPi({ name: "steer" });
	const wireFrom = mock.requests.length;
	try {
		const from = client.events.length;
		client.send({ id: "1", type: "prompt", message: "部署 端口 流式中" });
		// Steered while the first turn is streaming (the mock reply is delayed).
		await client.waitFor((event) => event.type === "agent_start", 30000, from);
		await sleep(120);
		client.send({ id: "2", type: "steer", message: "缓存 失效 也要改" });
		await client.settle(90000);
		await sleep(200);
		const requests = chatRequests(wireFrom);
		const base = requests.at(-2);
		const steer = requests.at(-1);
		const steerText = steer ? lastUserText(steer) : "";
		check("steer: base turn injected", blockCount(base ? lastUserText(base) : "") === 1);
		check("steer: steer turn injected the cache memory", steerText.includes("mem-cache"), tail(steerText));
		check("steer: steer append is the tail", steerText.endsWith(CLOSE_TAG));
		const records = decisionRecords(decisions).filter((record) => record.kind === "input");
		check("steer: decision log marks the steer source", records.some((record) => record.streaming_behavior === "steer"));
		report("steer decisions", records.map((record) => `  ${record.status} reason=${record.reason} source=${record.source}/${record.streaming_behavior}`));
	} finally {
		mock.setDelay(0);
		check("steer: pi exits cleanly", (await client.close()) === 0);
	}
}

async function scenarioHandlerError() {
	const { client, decisions } = spawnPi({
		name: "handler-error",
		extraExtensions: [THROWER],
		env: { VESTIGIO_TEST_THROW: "1" },
	});
	const wireFrom = mock.requests.length;
	try {
		await client.prompt("部署 端口 THROW_NOW", "1");
		const first = chatRequests(wireFrom).at(-1);
		const firstText = first ? lastUserText(first) : "";
		const present = blockCount(firstText);
		check("handler_error: run completed despite the throw", Boolean(first), "no chat request");
		check("handler_error: no truncated or duplicated block", present <= 1 && (present === 0 || firstText.endsWith(CLOSE_TAG)), `blocks=${present}`);
		await client.prompt("部署 端口 THROW_NOW 二", "2");
		const second = chatRequests(wireFrom).at(-1);
		const secondText = second ? lastUserText(second) : "";
		check("handler_error: repeat turn adds no extra block", blockCount(secondText) === 0, `${blockCount(secondText)} block(s)`);
		const records = decisionRecords(decisions).filter((record) => record.kind === "input");
		check("handler_error: extension still recorded a decision", records.length >= 2, `${records.length}`);
		const errors = client.events.filter((event) => event.type === "extension_error");
		const sawThrow = errors.some((event) => JSON.stringify(event).includes("VESTIGIO_TEST_HANDLER_THROW"));
		check("handler_error: pi reported the handler error", errors.length >= 1, `${errors.length} extension_error event(s)`);
		check("handler_error: the reported error is the thrower's", sawThrow);
		report("handler_error observations", [
			`  first user text: ${tail(firstText, 160)}`,
			`  block survived pi's error handling: ${present === 1 ? "yes" : "no (pi reverted the whole chain)"}`,
			`  pi extension_error events: ${errors.length} (thrower's message seen: ${sawThrow})`,
		]);
	} finally {
		check("handler_error: pi exits cleanly", (await client.close()) === 0);
	}
}

// ---------------------------------------------------------------- performance

async function perfBaselineDisabled(turns) {
	const { client } = spawnPi({ name: "perf-disabled", disableExtension: true });
	// The extension is not loaded at all here: this is the unmodified pi path.
	const wireTimes = [];
	try {
		for (let index = 0; index < turns; index += 1) {
			const before = Date.now();
			await client.prompt(`perftoken${String(index).padStart(2, "0")} 检查`);
			wireTimes.push(Date.now() - before);
		}
		check("perf_baseline: all turns settled", wireTimes.length === turns, `${wireTimes.length}/${turns}`);
	} finally {
		await client.close();
	}
	return wireTimes;
}

async function perfScenario(name, project, turns, expectInjection) {
	const { client, decisions } = spawnPi({ name, project });
	const wireFrom = mock.requests.length;
	const roundTrips = [];
	try {
		for (let index = 0; index < turns; index += 1) {
			const before = Date.now();
			await client.prompt(`perftoken${String(index).padStart(2, "0")} 检查`);
			roundTrips.push(Date.now() - before);
		}
	} finally {
		await client.close();
	}
	const records = decisionRecords(decisions).filter((record) => record.kind === "input");
	const elapsed = records.map((record) => record.elapsed_ms).filter((value) => typeof value === "number");
	const handler = records.map((record) => record.handler_ms).filter((value) => typeof value === "number");
	const tokens = records.map((record) => record.estimated_tokens ?? 0);
	const injectedTurns = records.filter((record) => record.status === "injected").length;
	const requests = chatRequests(wireFrom);
	const totalBlocks = requests.reduce((sum, entry) => sum + blockCount(lastUserText(entry)), 0);
	check(`${name}: every turn produced a decision`, records.length === turns, `${records.length}/${turns}`);
	check(`${name}: hotspot p95 under 1000ms`, stats(elapsed).p95 !== null && stats(elapsed).p95 < 1000);
	check(`${name}: no repeated block in any turn`, requests.every((entry) => blockCount(lastUserText(entry)) <= 1));
	check(`${name}: total blocks match injected turns`, totalBlocks === injectedTurns, `${totalBlocks} vs ${injectedTurns}`);
	if (expectInjection) {
		check(`${name}: every turn injected a distinct memory`, injectedTurns === turns, `${injectedTurns}/${turns}`);
	}
	return { roundTrips, elapsed, handler, tokens, injectedTurns, totalBlocks, stats: stats(roundTrips) };
}

// ---------------------------------------------------------------- main

const mock = startMock();

async function main() {
	const dumpIndex = process.argv.indexOf("--dump");
	mkdirSync(CWD, { recursive: true });
	mkdirSync(EMPTY_PROJECT, { recursive: true });
	mkdirSync(OBELISK_HOME, { recursive: true });
	cpSync(join(HERE, "agent"), AGENT_DIR, { recursive: true });

	const realBefore = existsSync(REAL_OBELISK) ? statSync(REAL_OBELISK).mtimeMs : null;

	await mock.listen();
	try {
		console.log(`Pi scratch: ${TMP} (provider 127.0.0.1:${mock.port})`);
		const modelsPath = join(AGENT_DIR, "models.json");
		const models = JSON.parse(readFileSync(modelsPath, "utf8"));
		models.providers.mock.baseUrl = `http://127.0.0.1:${mock.port}/v1`;
		writeFileSync(modelsPath, JSON.stringify(models));
		// Seed the isolated store with the workspace hook.
		const { spawnSync } = await import("node:child_process");
		const seeded = spawnSync(
			process.execPath,
			["--import", join(HERE, "hook.mjs"), join(HERE, "seed.mjs"), SEED_STORE, PROJECT, PERF_PROJECT],
			{ encoding: "utf8" },
		);
		if (seeded.status !== 0) {
			throw new Error(`seed failed: ${seeded.stderr || seeded.stdout}`);
		}
		console.log(`seed: ${seeded.stdout.trim()}`);
		copyFileSyncData(SEED_STORE, runStore);

		if (dumpIndex !== -1) {
			const name = process.argv[dumpIndex + 1] ?? "new-session";
			const { client } = spawnPi({ name });
			try {
				await client.prompt(process.argv[dumpIndex + 2] ?? "部署 端口 需要修改", "1");
			} finally {
				await client.close();
			}
			console.log(JSON.stringify(mock.requests.filter((entry) => entry.body?.messages), null, 2));
			return 0;
		}

		const onlyIndex = process.argv.indexOf("--only");
		const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
		const scenarios = ["new_session", "continue", "compaction", "prompt-template", "skill-command", "queued", "steer", "handler-error", "stale", "request", "search_recovery", "worktree", "perf"];
		// `compound` is a measurement of a known limitation, not a regression test; run it explicitly.
		const measurements = ["compound"];
		if (only !== null && !scenarios.includes(only) && !measurements.includes(only)) throw new Error(`unknown scenario: ${only}`);
		const maybe = async (name, fn) => {
			if (only === null || only === name) await fn();
		};

		await maybe("new_session", scenarioNewSession);
		await maybe("continue", scenarioContinue);
		await maybe("compaction", scenarioCompaction);
		await maybe("prompt-template", () => slashScenario("prompt-template", "/probe 部署 端口", "TEMPLATE_BODY_START"));
		await maybe("skill-command", () => slashScenario("skill-command", "/skill:probe-skill 部署 端口", "SKILL_BODY_START"));
		await maybe("queued", scenarioQueuedInput);
		await maybe("steer", scenarioSteer);
		await maybe("handler-error", scenarioHandlerError);
		const useFreshStore = (name) => {
			runStore = join(TMP, `${name}.sqlite`);
			usedStores.add(runStore);
			copyFileSyncData(SEED_STORE, runStore);
		};
		await maybe("stale", () => {
			useFreshStore("stale");
			return scenarioStale({ mock, spawnPi, check, storePath: runStore, port: mock.port, chatRequests, systemText, lastUserText });
		});
		await maybe("request", () => {
			useFreshStore("request");
			return scenarioRequest({ mock, spawnPi, check, storePath: runStore, port: mock.port });
		});
		await maybe("search_recovery", () => {
			useFreshStore("search-recovery");
			return scenarioSearchRecovery();
		});
		await maybe("worktree", scenarioWorktree);
		if (only === "compound") {
			useFreshStore("compound");
			await scenarioCompound();
		}
		if (only === null || only === "perf") useFreshStore("perf");

		const perfEnabled = only === null || only === "perf";
		const baseline = perfEnabled ? await perfBaselineDisabled(32) : [];
		const matchingOff = perfEnabled ? await perfScenario("perf-matching-off", EMPTY_PROJECT, 32, false) : emptyPerf();
		const full = perfEnabled ? await perfScenario("perf-full", PERF_PROJECT, 32, true) : emptyPerf();

		if (perfEnabled) {
			report("performance", [
			`  extension disabled (round trip, ms): n=${baseline.length} p50=${stats(baseline).p50} p95=${stats(baseline).p95}`,
			`  matching off  (handler_ms): n=${matchingOff.handler.length} p50=${stats(matchingOff.handler).p50} p95=${stats(matchingOff.handler).p95} max=${stats(matchingOff.handler).max}`,
			`  matching off  (round trip, ms): p50=${matchingOff.stats.p50} p95=${matchingOff.stats.p95}`,
			`  full match    (elapsed_ms): n=${full.elapsed.length} p50=${stats(full.elapsed).p50} p95=${stats(full.elapsed).p95} max=${stats(full.elapsed).max}`,
			`  full match    (handler_ms): p50=${stats(full.handler).p50} p95=${stats(full.handler).p95} max=${stats(full.handler).max}`,
			`  full match    (round trip, ms): p50=${full.stats.p50} p95=${full.stats.p95}`,
			`  full match    injected turns=${full.injectedTurns} total blocks=${full.totalBlocks} (repeated=0)`,
			`  full match    added tokens/turn: ${full.tokens.map((value) => `${value}`).join(", ")}`,
			`  full match    added tokens p50=${percentile(full.tokens, 50)} p95=${percentile(full.tokens, 95)}`,
			]);
		}

		check("perf_full: baseline round trip is recorded", perfEnabled ? baseline.length === 32 : true);
	} finally {
		try {
			const leaked = new Set(await stopProbeDaemons([...usedStores]));
			for (const storePath of usedStores) {
				check(`daemon stopped for ${storePath}`, !leaked.has(storePath), storePath);
			}
		} finally {
			await mock.close();
		}
	}

	const realAfter = existsSync(REAL_OBELISK) ? statSync(REAL_OBELISK).mtimeMs : null;
	check(
		"operator Obelisk index untouched",
		realBefore === realAfter,
		`before=${realBefore} after=${realAfter}`,
	);
	console.log(`\noperator Obelisk index: ${REAL_OBELISK} before=${realBefore} after=${realAfter}`);

	const failed = checks.filter((entry) => !entry.ok);
	console.log(`\n=== checks (${checks.length - failed.length}/${checks.length} passed) ===`);
	for (const entry of checks) {
		console.log(`  ${entry.ok ? "PASS" : "FAIL"}  ${entry.name}${entry.detail ? `  [${entry.detail}]` : ""}`);
	}
	if (failed.length > 0) {
		console.log(`\nFAILED ${failed.length} check(s)`);
		return 1;
	}
	console.log("\nALL CHECKS PASSED");
	return 0;
}

function emptyPerf() {
	return {
		roundTrips: [],
		elapsed: [],
		handler: [],
		tokens: [],
		injectedTurns: 0,
		totalBlocks: 0,
		stats: stats([]),
	};
}

function tail(text, length = 80) {
	const flat = text.replace(/\n/g, "\\n");
	return flat.length <= length ? flat : `...${flat.slice(-length)}`;
}

function copyFileSyncData(source, target) {
	rmSync(target, { force: true });
	copyFileSync(source, target);
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		console.error("harness error:", error);
		process.exitCode = 2;
	});
