/**
 * Actual-model free-choice evaluation for proactive memory requests.
 *
 * This is deliberately not the mock-provider harness. Every turn is a real
 * coding-agent turn against the configured gateway, with only Vestigio's memory
 * tools enabled. The prompt says what the operator wants in natural language;
 * whether that becomes a queued request, a stale marker, or nothing is the
 * model's choice, and the assertions score that choice.
 *
 * Run:
 *   cd eval/requests
 *   node --import ../pi/hook.mjs ./run.mjs
 *   node --import ../pi/hook.mjs ./run.mjs --only overlap-explicit-save
 *
 * Costs real tokens. Writes only inside /tmp/vestigio-requests.
 */

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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { openStore } from "@vestigio/core/storage";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const EXT = join(ROOT, "packages/pi-extension/src/extension.ts");
const CASES = join(HERE, "cases.jsonl");
const PI = process.env.PI_BIN ?? "pi";
const TMP = "/tmp/vestigio-requests";
const REAL_OBELISK = join(homedir(), ".obelisk/obelisk.sqlite");
const AGENT_SRC = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const AGENT_HOME = join(TMP, "agent");
const TURN_TIMEOUT_MS = 180_000;

const DEFAULTS = {
	provider: "magpie",
	agent_model: "auto/deepseek-v4.1-flash",
	extension_model: "auto/deepseek-v4.1-flash",
	thinking: "low",
	repeat: 1,
};

const TOOLS = [
	"memory_request_write",
	"memory_request_status",
	"memory_search",
	"memory_read",
	"memory_resolve",
	"memory_mark_stale",
].join(",");

function args() {
	const options = { ...DEFAULTS, only: null, dryRun: false, keep: false };
	const argv = process.argv.slice(2);
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => {
			index += 1;
			const value = argv[index];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			return value;
		};
		if (arg === "--only") options.only = next();
		else if (arg === "--repeat") options.repeat = Math.max(1, Number(next()) || 1);
		else if (arg === "--provider") options.provider = next();
		else if (arg === "--agent-model") options.agent_model = next();
		else if (arg === "--extension-model") options.extension_model = next();
		else if (arg === "--thinking") options.thinking = next();
		else if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--keep") options.keep = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	return options;
}

function readCases() {
	return readFileSync(CASES, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line, index) => {
			let value;
			try {
				value = JSON.parse(line);
			} catch (error) {
				throw new Error(`cases.jsonl:${index + 1}: ${error.message}`);
			}
			if (typeof value.id !== "string" || typeof value.prompt !== "string") {
				throw new Error(`cases.jsonl:${index + 1}: id and prompt are required`);
			}
			return value;
		});
}

function readAuth() {
	const path = join(AGENT_SRC, "auth.json");
	if (!existsSync(path)) throw new Error(`missing ${path}; run \`pi auth login ${"magpie"}\` first`);
	const auth = JSON.parse(readFileSync(path, "utf8"));
	const key = auth?.magpie?.key;
	if (typeof key !== "string" || key.length === 0) throw new Error(`magpie.key is missing from ${path}`);
	return key;
}

function buildAgentHome(key, options) {
	rmSync(AGENT_HOME, { recursive: true, force: true });
	mkdirSync(AGENT_HOME, { recursive: true });
	const modelsPath = join(AGENT_SRC, "models.json");
	if (!existsSync(modelsPath)) throw new Error(`missing ${modelsPath}`);
	const models = JSON.parse(readFileSync(modelsPath, "utf8"));
	const provider = models?.providers?.[options.provider];
	if (provider === undefined) throw new Error(`${modelsPath} has no ${options.provider} provider`);
	writeFileSync(join(AGENT_HOME, "models.json"), `${JSON.stringify(models, null, 2)}\n`, "utf8");
	copyFileSync(join(AGENT_SRC, "auth.json"), join(AGENT_HOME, "auth.json"));
	writeFileSync(join(AGENT_HOME, "models-store.json"), "{}\n", "utf8");
	return { baseUrl: provider.baseUrl, key };
}

function bodyFor(text) {
	let body = `${text}。`;
	while ([...body].filter((character) => !/\s/u.test(character)).length < 600) {
		body += "这条约定来自已经确认的项目事实，后续同类操作按此执行，不要凭空改写。";
	}
	return body;
}

function sourceFor(memoryId, projectId) {
	return {
		provider: "pi",
		source_instance: "session",
		session_id: "seed-session",
		message_id: `seed-${memoryId}`,
		parent_message_id: null,
		project_id: projectId,
		timestamp: new Date().toISOString(),
		content_hash: `sha256:${createHash("sha256").update(memoryId).digest("hex")}`,
		locator: null,
	};
}

const SEEDS = {
	release_rule: {
		title: "关于「发布前测试要求」的记忆",
		questions: ["发布前测试要求", "发布前必须跑全量测试"],
		text: "发布前必须跑全量测试，任何发布都不得只跑相关用例",
	},
	deploy_port: {
		title: "关于「部署脚本默认端口」的记忆",
		questions: ["部署脚本默认端口", "部署脚本端口约定"],
		text: "部署脚本默认端口是 8080，没有验证前不要修改",
	},
	deploy_port_overlap: {
		title: "关于「部署脚本的默认端口」",
		questions: ["部署脚本默认端口保持 18080", "部署脚本端口约定"],
		text: "部署脚本默认端口保持 18080，项目继续使用 pnpm",
	},
};

function seedStore(storePath, projectId, seedName) {
	const store = openStore({ path: storePath });
	try {
		if (seedName === undefined) return null;
		const seed = SEEDS[seedName];
		if (seed === undefined) throw new Error(`unknown seed: ${seedName}`);
		const memoryId = `mem-${createHash("sha256").update(`${seedName}:${projectId}`).digest("hex").slice(0, 16)}`;
		const body = bodyFor(seed.text);
		const saved = store.saveMemory(
			{
				memory_id: memoryId,
				uri: `memory://vestigio/${memoryId}`,
				scope: { kind: "project", project_id: projectId },
				title: seed.title,
				keywords: seed.questions,
				revision: 1,
				state: "published",
				medium: {
					body,
					body_char_count: [...body].filter((character) => !/\s/u.test(character)).length,
					sources: [sourceFor(memoryId, projectId)],
				},
				nav: {
					text: seed.text,
					char_count: [...seed.text].length,
					source_revision: 1,
				},
				hit_count: 0,
				access_count: 0,
				last_access_at: null,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
			{ beforeCommit: () => {}, at: new Date().toISOString() },
		);
		return { memory_id: saved.memory_id, uri: `memory://vestigio/${saved.memory_id}` };
	} finally {
		store.close();
	}
}

class PiClient {
	constructor(proc) {
		this.proc = proc;
		this.events = [];
		this.stderr = "";
		this.buffer = "";
		this.closed = new Promise((resolveClose) => proc.on("close", (code) => resolveClose(code ?? -1)));
		proc.stdout.on("data", (chunk) => {
			this.buffer += chunk.toString("utf8");
			let index = this.buffer.indexOf("\n");
			while (index >= 0) {
				const line = this.buffer.slice(0, index).replace(/\r$/u, "");
				this.buffer = this.buffer.slice(index + 1);
				if (line.trim().length > 0) {
					try {
						this.events.push(JSON.parse(line));
					} catch {
						// not a protocol line
					}
				}
				index = this.buffer.indexOf("\n");
			}
		});
		proc.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString("utf8");
		});
	}

	send(command) {
		this.proc.stdin.write(`${JSON.stringify(command)}\n`);
	}

	async waitFor(predicate, timeoutMs, from) {
		const deadline = Date.now() + timeoutMs;
		let cursor = from;
		while (Date.now() < deadline) {
			while (cursor < this.events.length) {
				const event = this.events[cursor];
				cursor += 1;
				if (event !== undefined && predicate(event)) return event;
			}
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
		}
		throw new Error(`timed out after ${timeoutMs}ms waiting for an RPC event`);
	}

	async close() {
		try {
			this.proc.stdin.end();
		} catch {
			// already closed
		}
		const timer = setTimeout(() => this.proc.kill("SIGKILL"), 5000);
		const code = await this.closed;
		clearTimeout(timer);
		return code;
	}
}

function redact(text) {
	return String(text)
		.replace(/sk-[A-Za-z0-9_-]{8,}/gu, "[redacted]")
		.replace(/Bearer\s+\S+/gu, "Bearer [redacted]");
}

async function runTurn(client, id, message, dialogs, toolCalls) {
	const from = client.events.length;
	client.send({ id, type: "prompt", message });
	await client.waitFor(
		(event) => {
			if (event.type === "extension_ui_request") dialogs.push(event);
			if (event.type === "tool_execution_start") toolCalls.push(event.toolName ?? event.name ?? "");
			return event.type === "agent_settled";
		},
		TURN_TIMEOUT_MS,
		from,
	);
}

async function runCase(testCase, options, model, repeat) {
	const label = `${testCase.id}-r${repeat}`;
	const runDir = join(TMP, "runs", label);
	rmSync(runDir, { recursive: true, force: true });
	mkdirSync(join(runDir, "sessions"), { recursive: true });
	const projectDir = join(TMP, "projects", label);
	mkdirSync(projectDir, { recursive: true });
	const storePath = join(runDir, "store.sqlite");
	const obeliskHome = join(runDir, "obelisk-home");
	mkdirSync(obeliskHome, { recursive: true });
	const seed = seedStore(storePath, projectDir, testCase.seed);
	const before = inspectStore(storePath, projectDir, seed);
	const proc = spawn(
		PI,
		[
			"--mode",
			"rpc",
			"--provider",
			options.provider,
			"--model",
			options.agent_model,
			"--thinking",
			options.thinking,
			"--no-context-files",
			"--no-mcp",
			"--no-extensions",
			"-e",
			EXT,
			"--tools",
			TOOLS,
			"--session-dir",
			join(runDir, "sessions"),
		],
		{
			cwd: projectDir,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				VESTIGIO_CONFIG: "",
				PI_CODING_AGENT_DIR: AGENT_HOME,
				PI_CODING_AGENT_SESSION_DIR: join(runDir, "sessions"),
				PI_SKIP_VERSION_CHECK: "1",
				VESTIGIO_STORE: storePath,
				VESTIGIO_PROJECT_ID: projectDir,
				VESTIGIO_OBELISK_HOME: obeliskHome,
				...(typeof model.baseUrl === "string" ? { VESTIGIO_MODEL_BASE_URL: model.baseUrl } : {}),
				VESTIGIO_MODEL_ID: options.extension_model,
				VESTIGIO_MODEL_API_KEY: model.key,
				VESTIGIO_MODEL_THINKING: options.thinking,
				VESTIGIO_REPAIR_MODE: "background",
			},
		},
	);
	const client = new PiClient(proc);
	const dialogs = [];
	const toolCalls = [];
	const replies = [];
	let mid = null;
	let exitCode = null;
	try {
		await runTurn(client, label, testCase.prompt, dialogs, toolCalls);
		// A proactive offer no longer parks a row: the agent appends one question and
		// writes nothing. The operator's own next message (default 好) is played as a
		// second real turn, and only a clear agreement may produce a row. A same-turn
		// explicit save already has its row, so it gets no reply turn.
		mid = inspectStore(storePath, projectDir, seed);
		if (testCase.reply !== null && mid.request_count === 0) {
			const reply = typeof testCase.reply === "string" ? testCase.reply : "好";
			replies.push(reply);
			await runTurn(client, `${label}-reply`, reply, dialogs, toolCalls);
		}
	} finally {
		exitCode = await client.close();
	}
	const after = inspectStore(storePath, projectDir, seed);
	const record = {
		case: testCase.id,
		repeat,
		prompt: testCase.prompt,
		replies,
		exit_code: exitCode,
		dialogs: dialogs.map((dialog) => ({ method: dialog.method, title: dialog.title, message: dialog.message })),
		tool_calls: toolCalls,
		before,
		mid,
		after,
		expectation: testCase.expected ?? {},
		stderr_tail: exitCode === 0 ? null : redact(client.stderr).slice(-2000),
	};
	writeFileSync(join(runDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
	const checks = score(testCase, after, dialogs, mid, replies);
	return { ...record, checks };
}

function inspectStore(storePath, projectId, seed) {
	const store = openStore({ path: storePath });
	try {
		const requests = store.listMemoryRequests();
		const heads = store.listHeads({ kind: "project", project_id: projectId });
		const seedMemory = seed === null ? null : store.readMemory(seed.uri);
		const pending = seed === null ? [] : store.listPendingStaleEvents(seed.memory_id);
		return {
			requests,
			request_count: requests.length,
			saved: requests.filter((row) => row.status === "saved" || row.status === "merged" || row.status === "reused"),
			memory_count: heads.length,
			memory_uris: heads.map((head) => head.uri),
			seed: seed === null ? null : {
				uri: seed.uri,
				revision: seedMemory?.revision ?? null,
				state: seedMemory?.state ?? null,
				body: seedMemory?.medium.body ?? null,
			},
			pending: pending.map((event) => event.event_id),
		};
	} finally {
		store.close();
	}
}

function score(testCase, after, dialogs, mid, replies) {
	const expected = testCase.expected ?? {};
	const checks = [];
	const add = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
	if (expected.requests !== undefined) {
		add("request count", after.request_count === expected.requests, `${after.request_count} (want ${expected.requests})`);
	}
	if (expected.memories !== undefined) {
		add("memory count", after.memory_count === expected.memories, `${after.memory_count} (want ${expected.memories})`);
	}
	if (expected.saved !== undefined) {
		add("saved requests", after.saved.length >= expected.saved, `${after.saved.length} (want >= ${expected.saved})`);
	}
	if (expected.scope !== undefined) {
		add("saved scope", after.saved.some((row) => row.scope.kind === expected.scope), JSON.stringify(after.saved.map((row) => row.scope)));
	}
	if (expected.revision !== undefined) {
		add("seed revision", after.seed?.revision === expected.revision, `r${after.seed?.revision} (want r${expected.revision})`);
	}
	if (expected.pending !== undefined) {
		add("pending stale events", after.pending.length === expected.pending, `${after.pending.length} (want ${expected.pending})`);
	}
	if (expected.stale === true) {
		const recorded = after.pending.length > 0 || (after.seed?.revision ?? 1) > 1;
		add("verified change recorded as stale", recorded, `pending=${after.pending.length} r${after.seed?.revision}`);
	}
	if (expected.single_topic === true) {
		const oneHead = after.memory_count === 1;
		const sameUri = after.saved.length === 0 || after.saved.every((row) => row.memory_uri === after.seed?.uri);
		add("one topic after overlap", oneHead && sameUri, `heads=${after.memory_count} uris=${JSON.stringify(after.memory_uris)} saved=${JSON.stringify(after.saved.map((row) => row.memory_uri))}`);
	}
	add(
		"no confirmation dialog",
		dialogs.length === 0,
		`${dialogs.length} dialogs`,
	);
	if (expected.proactive === true) {
		const rowsAfterOffer = mid === null ? 0 : mid.request_count;
		add("no request on the offer turn", rowsAfterOffer === 0, `${rowsAfterOffer} row(s) after turn 1 (want 0)`);
	}
	if (expected.same_turn === true) {
		const savedAfterFirst = mid === null ? 0 : mid.saved.length;
		add("saved on the same turn", savedAfterFirst >= 1, `${savedAfterFirst} saved after turn 1 (want >= 1)`);
	}
	if (expected.reply_turns !== undefined) {
		add("operator reply turns", replies.length === expected.reply_turns, `${replies.length} (want ${expected.reply_turns})`);
	}
	return checks;
}

async function main() {
	const options = args();
	const cases = readCases().filter((testCase) => options.only === null || testCase.id === options.only);
	if (cases.length === 0) throw new Error(`unknown case: ${options.only}`);
	if (options.dryRun) {
		for (const testCase of cases) console.log(`${testCase.id}: ${testCase.prompt}\n  ${testCase.why ?? ""}`);
		return;
	}
	const key = readAuth();
	const model = buildAgentHome(key, options);
	rmSync(join(TMP, "runs"), { recursive: true, force: true });
	mkdirSync(TMP, { recursive: true });
	if (statSync(EXT).isFile() !== true) throw new Error(`missing extension: ${EXT}`);
	const realObeliskBefore = existsSync(REAL_OBELISK) ? statSync(REAL_OBELISK).mtimeMs : null;
	let failures = 0;
	for (const testCase of cases) {
		for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
			console.log(`running ${testCase.id} repeat ${repeat}/${options.repeat} ...`);
			const result = await runCase(testCase, options, model, repeat);
			for (const check of result.checks) {
				console.log(`  ${check.pass ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
				if (!check.pass) failures += 1;
			}
			if (result.exit_code !== 0) {
				console.log(`  FAIL  pi exit: ${result.exit_code}\n${result.stderr_tail ?? ""}`);
				failures += 1;
			}
		}
	}
	const realObeliskAfter = existsSync(REAL_OBELISK) ? statSync(REAL_OBELISK).mtimeMs : null;
	const untouched = realObeliskBefore === realObeliskAfter;
	console.log(`${untouched ? "PASS" : "FAIL"}  operator Obelisk index untouched`);
	if (!untouched) failures += 1;
	if (!options.keep) rmSync(AGENT_HOME, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
	if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
	console.error(`requests eval error: ${error.stack ?? error}`);
	process.exitCode = 1;
});
