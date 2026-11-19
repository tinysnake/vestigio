#!/usr/bin/env node
/**
 * Live real-model evaluation harness (milestones 1 and 2: F1/F2 and F5 repair).
 *
 * It drives the real `pi` binary in `--mode rpc` against the operator's local
 * magpie gateway and scores the agent-facing memory flows deterministically
 * from the store's stale-event `producer` field. No mock provider. F1/F2 needs
 * no judge; F5 adds a second `pi` session that repairs the stale memory on
 * retrieval, deterministic checks on the repaired store, and one non-streaming
 * LLM judge call per repeat.
 *
 * Run it with the workspace hook so the TypeScript sources are used directly:
 *
 *   cd eval/live
 *   node --import ../pi/hook.mjs ./run.mjs --only f1f2 --repeat 3
 *
 * Isolation:
 *   - the real Obelisk index is never opened; `VESTIGIO_OBELISK_HOME` points at
 *     a scratch directory and the real index mtime is asserted unchanged;
 *   - every repeat gets a fresh store, session directory and project cwd under
 *     `/tmp/vestigio-live`;
 *   - the magpie key is read at runtime from `~/.pi/agent/auth.json`, passed to
 *     the child through the environment only, and redacted from every log line.
 *
 * Model traffic (both the agent's own calls and the extension's detector calls)
 * is routed through a local recording proxy so the full request and response are
 * captured. The proxy forwards to the real gateway; it is not a mock.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codePointCount, nonWhitespaceCodePointCount } from "@vestigio/core";
import { layeredSearch } from "@vestigio/core/retrieval";
import { resolveMemory } from "@vestigio/core/resolver";
import { openStore } from "@vestigio/core/storage";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, "../..");
const EXT = join(ROOT, "packages/pi-extension/src/extension.ts");
const CORPUS_DIR = join(HERE, "corpus");
const RUNS_DIR = join(HERE, "runs");
const TMP = "/tmp/vestigio-live";
const AGENT_SRC = join(homedir(), ".pi/agent");
const AGENT_HOME = join(TMP, "agent");
const REAL_OBELISK = join(homedir(), ".obelisk/obelisk.sqlite");
const PI = process.env.PI_BIN ?? "pi";

const HARNESS_VERSION = "0.5.0";
const INJECTION_OPEN = "<vestigio_memory_note>";
const INJECTION_CLOSE = "</vestigio_memory_note>";

const TURN_TIMEOUT_MS = 300_000;
const DETECTOR_GRACE_MS = 60_000;
/**
 * The judge reasons at `high` on a long rubric and its family is slow: measured
 * 29-131 s per call on this gateway. `TURN_TIMEOUT_MS` cut a real verdict off at
 * 300 s, which read as a score of 0 rather than as a missing measurement.
 */
const JUDGE_TIMEOUT_MS = 600_000;

/**
 * Every memory tool name this milestone knows about, so an allowlist can name
 * and reject one. `memory_update` is listed even though no variant may enable
 * it: the extension no longer exposes it, and `assertMemoryToolset` below
 * refuses it for both variants. Its whole toolset is pi's `--tools` allowlist,
 * so the built-in read/bash/edit/write tools never reach the model. Anything
 * outside this list is a harness bug.
 */
const MEMORY_TOOL_UNIVERSE = [
	"memory_search",
	"memory_read",
	"memory_resolve",
	"memory_update",
	"memory_mark_stale",
];

/**
 * Tools that rewrite a stored memory. The agent never gets these: repair is
 * retrieval-side, so the only writer is the resolver when a stale memory is
 * next read.
 */
const MEMORY_WRITER_TOOLS = ["memory_update"];

const AGENT_TOOL_ALLOWLIST = [
	"memory_search",
	"memory_read",
	"memory_resolve",
	"memory_mark_stale",
];

/**
 * The detector variant: read-only memory tools. The agent can surface a memory
 * but cannot mark it stale or repair it, so anything the detector records is
 * the detector's own catch, never the agent's instruction-following.
 */
const DETECTOR_TOOL_ALLOWLIST = ["memory_search", "memory_read", "memory_resolve"];

const VARIANTS = {
	agent: { name: "agent", tools: AGENT_TOOL_ALLOWLIST },
	detector: { name: "detector", tools: DETECTOR_TOOL_ALLOWLIST },
};

const DEFAULTS = {
	endpoint: "http://127.0.0.1:3425/v1",
	provider: "magpie",
	tools: AGENT_TOOL_ALLOWLIST.join(","),
	agent_model: "auto/deepseek-v4.1-flash",
	agent_thinking: "low",
	extension_model: "auto/deepseek-v4.1-flash",
	extension_thinking: "low",
	// docs/live-eval.md writes `magpie/auto/gpt-6.1-sol`, but this gateway serves
	// no such id (HTTP 404), `remote-magpie/auto/gpt-6.1-sol` does not answer, and
	// `auto/gpt-6.1-sol` is switched off. `group/auto-gpt-6-sol` routes across
	// models, so the same prompt scored pass and fail on different calls; a pinned
	// id keeps the judge reproducible. `codex/gpt-6.2-sol` is served and stable.
	// F5 refuses to start if the judge equals a model under test.
	judge_model: "codex/gpt-6.2-sol",
	judge_thinking: "high",
	max_model_calls: 700,
	max_total_tokens: 7_000_000,
	wall_clock_ms: 3_600_000,
};

function assertMemoryToolset(tools, variantName) {
	const variant = VARIANTS[variantName];
	if (variant === undefined) {
		throw new Error(`unknown variant "${variantName}" (expected ${Object.keys(VARIANTS).join("|")})`);
	}
	const entries = String(tools)
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (entries.length === 0) throw new Error("agent tool allowlist is empty");
	const stray = entries.filter((entry) => !MEMORY_TOOL_UNIVERSE.includes(entry));
	if (stray.length > 0) {
		throw new Error(`agent tool allowlist contains non-memory tools: ${stray.join(",")}`);
	}
	const missing = variant.tools.filter((name) => !entries.includes(name));
	if (missing.length > 0) {
		throw new Error(`${variantName} tool allowlist is missing memory tools: ${missing.join(",")}`);
	}
	if (variantName === "agent") {
		const writers = entries.filter((name) => MEMORY_WRITER_TOOLS.includes(name));
		if (writers.length > 0) {
			throw new Error(`agent variant must not enable memory-writer tools (repair is retrieval-side): ${writers.join(",")}`);
		}
	}
	if (variantName === "detector") {
		const forbidden = entries.filter(
			(name) => MEMORY_WRITER_TOOLS.includes(name) || name === "memory_mark_stale",
		);
		if (forbidden.length > 0) {
			throw new Error(`detector variant must not enable marking tools: ${forbidden.join(",")}`);
		}
	}
	return entries;
}

const AT = "2026-11-17T12:00:00.000Z";

let SECRETS = [];
function registerSecret(value) {
	if (typeof value === "string" && value.length > 0) SECRETS.push(value);
}

function redactText(text) {
	let out = String(text);
	for (const secret of SECRETS) {
		if (secret.length > 0) out = out.split(secret).join("[redacted]");
	}
	return out
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
		.replace(/\bsk-[A-Za-z0-9._~-]{4,}/gu, "[redacted]")
		.replace(/token=[^\s&"'\\]+/giu, "token=[redacted]")
		.replace(/authorization/giu, "authorization");
}

function redactValue(value, key = "") {
	if (/^(authorization|api[_-]?key|proxy-authorization|x-api-key)$/iu.test(key)) return "[redacted]";
	if (typeof value === "string") return redactText(value);
	if (Array.isArray(value)) return value.map((item) => redactValue(item));
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k);
		return out;
	}
	return value;
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(redactValue(value), null, 2)}\n`, "utf8");
}

function appendJsonl(path, value) {
	appendFileSync(path, `${JSON.stringify(redactValue(value))}\n`, "utf8");
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

function readMagpieKey() {
	const path = join(AGENT_SRC, "auth.json");
	if (!existsSync(path)) throw new Error(`missing ${path}; run \`pi auth login magpie\` first`);
	const auth = JSON.parse(readFileSync(path, "utf8"));
	const key = auth?.magpie?.key;
	if (typeof key !== "string" || key.length === 0) {
		throw new Error(`magpie.key is missing from ${path}`);
	}
	return key;
}

function buildAgentHome(proxyBaseUrl) {
	rmSync(AGENT_HOME, { recursive: true, force: true });
	mkdirSync(AGENT_HOME, { recursive: true });
	const models = JSON.parse(readFileSync(join(AGENT_SRC, "models.json"), "utf8"));
	if (models?.providers?.magpie === undefined) {
		throw new Error("~/.pi/agent/models.json has no `magpie` provider; cannot route the agent");
	}
	models.providers.magpie.baseUrl = proxyBaseUrl;
	writeFileSync(join(AGENT_HOME, "models.json"), `${JSON.stringify(models, null, 2)}\n`, "utf8");
	copyFileSync(join(AGENT_SRC, "auth.json"), join(AGENT_HOME, "auth.json"));
	writeFileSync(join(AGENT_HOME, "models-store.json"), "{}\n", "utf8");
}

function extractUsage(raw, contentType) {
	const streamed = String(contentType ?? "").includes("text/event-stream");
	let usage = null;
	if (streamed) {
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("data:")) continue;
			const data = trimmed.slice(5).trim();
			if (data.length === 0 || data === "[DONE]") continue;
			try {
				const obj = JSON.parse(data);
				if (obj.usage !== undefined && obj.usage !== null) usage = obj.usage;
			} catch {
				// partial or non-JSON SSE line
			}
		}
	} else {
		try {
			const obj = JSON.parse(raw);
			usage = obj?.usage ?? null;
		} catch {
			usage = null;
		}
	}
	const tokensIn = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
	const tokensOut = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
	return { streamed, usage, tokensIn, tokensOut };
}

async function startProxy({ upstream, logPath, failuresDir, budget }) {
	const upstreamUrl = new URL(upstream);
	const entries = [];
	const responses = new Map();
	const stats = { calls: 0, agentCalls: 0, extensionCalls: 0, tokensIn: 0, tokensOut: 0 };
	let nextId = 1;
	let inflight = 0;

	const server = createServer((req, res) => {
		const id = nextId;
		nextId += 1;
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const bodyBuf = Buffer.concat(chunks);
			const isChat = req.url !== undefined && req.url.includes("/chat/completions");
			let parsedBody = null;
			try {
				parsedBody = JSON.parse(bodyBuf.toString("utf8"));
			} catch {
				parsedBody = null;
			}
			const stream = parsedBody?.stream === true;
			const requestRecord = {
				id,
				kind: "request",
				ts: new Date().toISOString(),
				method: req.method,
				url: req.url,
				isChat,
				stream,
				headers: redactValue(req.headers),
				body: parsedBody ?? redactText(bodyBuf.toString("utf8")),
			};
			entries.push(requestRecord);
			appendJsonl(logPath, requestRecord);

			if (isChat) {
				stats.calls += 1;
				if (stats.calls > budget.maxModelCalls) {
					budget.exceeded = true;
					budget.reason = `max_model_calls ${budget.maxModelCalls} exceeded`;
					res.writeHead(429, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: { message: "harness budget: max_model_calls exceeded" } }));
					entries.push({ id, kind: "budget_block", ts: new Date().toISOString() });
					return;
				}
			}

			inflight += 1;
			const headers = { ...req.headers };
			delete headers.host;
			delete headers["content-length"];
			delete headers["accept-encoding"];
			const upstreamReq = httpRequest(
				{
					hostname: upstreamUrl.hostname,
					port: upstreamUrl.port,
					path: req.url,
					method: req.method,
					// A pooled socket the gateway already closed stalls the forward until the
					// caller's timeout, which reads as a model failure. One connection per
					// forwarded call avoids that class of stall.
					agent: false,
					headers,
				},
				(upstreamRes) => {
					res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
					const respChunks = [];
					upstreamRes.on("data", (chunk) => {
						respChunks.push(chunk);
						if (res.write(chunk) === false) upstreamRes.pause();
					});
					res.on("drain", () => upstreamRes.resume());
					upstreamRes.on("end", () => {
						res.end();
						inflight -= 1;
						const raw = Buffer.concat(respChunks).toString("utf8");
						const contentType = upstreamRes.headers["content-type"];
						const { streamed, usage, tokensIn, tokensOut } = extractUsage(raw, contentType);
						const status = upstreamRes.statusCode ?? 0;
						const record = {
							id,
							kind: "response",
							ts: new Date().toISOString(),
							status,
							streamed,
							isChat,
							usage,
							tokensIn,
							tokensOut,
							body: redactText(raw.length > 200_000 ? `${raw.slice(0, 200_000)}\n[truncated]` : raw),
						};
						responses.set(id, record);
						entries.push(record);
						appendJsonl(logPath, record);
						if (isChat) {
							if (stream) stats.agentCalls += 1;
							else stats.extensionCalls += 1;
							stats.tokensIn += tokensIn;
							stats.tokensOut += tokensOut;
							if (tokensIn + tokensOut > 0) {
								budget.tokens += tokensIn + tokensOut;
								if (budget.tokens > budget.maxTokens && !budget.exceeded) {
									budget.exceeded = true;
									budget.reason = `max_total_tokens ${budget.maxTokens} exceeded`;
								}
							}
						}
						if (status >= 400 || (!streamed && isChat && usage === null)) {
							mkdirSync(failuresDir, { recursive: true });
							writeJson(join(failuresDir, `${String(id).padStart(4, "0")}.json`), {
								request: entries.find((entry) => entry.id === id && entry.kind === "request"),
								response: record,
							});
						}
					});
				},
			);
			upstreamReq.on("error", (error) => {
				inflight -= 1;
				res.writeHead(502, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: String(error.message ?? error) } }));
				responses.set(id, { id, kind: "response", status: 0, error: String(error.message ?? error) });
				entries.push(responses.get(id));
				appendJsonl(logPath, responses.get(id));
				mkdirSync(failuresDir, { recursive: true });
				writeJson(join(failuresDir, `${String(id).padStart(4, "0")}.json`), {
					request: entries.find((entry) => entry.id === id && entry.kind === "request"),
					error: String(error.message ?? error),
				});
			});
			upstreamReq.end(bodyBuf);
		});
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return {
		url: `http://127.0.0.1:${port}/v1`,
		port,
		stats,
		entries,
		responses,
		inflight: () => inflight,
		async close() {
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

class PiClient {
	constructor(proc) {
		this.proc = proc;
		this.events = [];
		this.stderr = "";
		this.buffer = "";
		this.exited = new Promise((resolve) => {
			proc.on("close", (code) => resolve(code ?? -1));
		});
		proc.stdout.on("data", (chunk) => {
			this.buffer += chunk.toString("utf8");
			let index = this.buffer.indexOf("\n");
			while (index >= 0) {
				let line = this.buffer.slice(0, index);
				this.buffer = this.buffer.slice(index + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line.trim().length > 0) {
					try {
						this.events.push(JSON.parse(line));
					} catch {
						// non-protocol stdout line: ignore
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

	async waitFor(pred, timeoutMs = TURN_TIMEOUT_MS, from = 0) {
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
		throw new Error(`timed out after ${timeoutMs}ms waiting for an RPC event`);
	}

	async promptAndSettle(id, message) {
		const from = this.events.length;
		this.send({ id, type: "prompt", message });
		await this.waitFor((event) => event.type === "agent_settled", TURN_TIMEOUT_MS, from);
	}

	async close() {
		try {
			this.proc.stdin.end();
		} catch {
			// already closed
		}
		const timer = setTimeout(() => this.proc.kill("SIGKILL"), 5000);
		const code = await this.exited;
		clearTimeout(timer);
		return code;
	}
}

function memoryUri(memoryId) {
	return `memory://vestigio/${memoryId}`;
}

function storeSnapshot(storePath, memoryId) {
	const store = openStore({ path: storePath });
	try {
		const events = store.listStaleEvents(memoryId);
		const freshness = store.readFreshness(memoryUri(memoryId));
		const memory = store.readMemory(memoryUri(memoryId));
		return {
			head_revision: memory?.revision ?? null,
			state: memory?.state ?? null,
			body: memory?.medium?.body ?? null,
			nav_source_revision: memory?.nav?.source_revision ?? null,
			memory_count: store.countMemories(),
			event_ids: events.map((event) => event.event_id),
			pending_ids: store.listPendingStaleEvents(memoryId).map((event) => event.event_id),
			freshness_sig: freshness?.freshness_sig ?? null,
			events,
		};
	} finally {
		store.close();
	}
}

/**
 * The `agent_end` background pass records one `vestigio.background-repair`
 * custom entry per session. Reading it back is how a report tells a repair the
 * pass performed from a repair that never happened, and how it measures the
 * pass without a turn to attribute the time to.
 */
function readBackgroundRepair(sessionDir) {
	if (!existsSync(sessionDir)) return null;
	const files = readdirSync(sessionDir).sort().reverse();
	for (const file of files) {
		let lines = [];
		try {
			lines = readFileSync(join(sessionDir, file), "utf8").split("\n");
		} catch {
			continue;
		}
		for (const line of lines.reverse()) {
			if (!line.includes("vestigio.background-repair")) continue;
			let data = null;
			try {
				const parsed = JSON.parse(line);
				data = parsed?.data ?? parsed;
			} catch {
				continue;
			}
			if (data === null || !Array.isArray(data.entries)) continue;
			return {
				candidates: data.candidates ?? null,
				attempted: data.attempted ?? null,
				repaired: data.repaired ?? null,
				deadline_exceeded: data.deadline_exceeded ?? null,
				entries: data.entries,
				elapsed_ms: data.entries.reduce((sum, entry) => sum + (entry.elapsed_ms ?? 0), 0),
			};
		}
	}
	return null;
}

/**
 * Compose the memory body from the corpus title, facts, context and stable
 * strings. The length band is real: a corpus whose composed body falls outside
 * 500-1000 non-whitespace code points is invalid, so the failure names the
 * corpus and the distance instead of padding the body with filler the judge
 * would count as invented content.
 */
function composeBody(corpus) {
	const memory = corpus.memory;
	const context = memory.context;
	if (!Array.isArray(context) || context.length < 2 || context.length > 3) {
		throw new Error(`corpus "${corpus.name}" memory.context must be an array of two or three sentences`);
	}
	if (context.some((sentence) => typeof sentence !== "string" || sentence.trim().length === 0)) {
		throw new Error(`corpus "${corpus.name}" memory.context entries must be non-empty strings`);
	}
	let text = `${memory.title}：这是当前生效的结论。`;
	for (const [key, value] of Object.entries(memory.facts ?? {})) {
		text += `\n- ${key}: ${value}`;
	}
	for (const sentence of context) text += `\n${sentence}`;
	for (const stable of memory.stable ?? []) {
		text += `\n- ${stable}`;
	}
	text += "\n补充说明：改动前先核对本页，改动后把新值写回这里，并保留可追溯的来源。";
	const count = nonWhitespaceCodePointCount(text);
	if (count < 500 || count > 1000) {
		const distance = count < 500 ? `${500 - count} short of the 500 floor` : `${count - 1000} over the 1000 ceiling`;
		throw new Error(
			`corpus "${corpus.name}" composes a ${count} non-whitespace code point body; it must be 500-1000 (${distance})`,
		);
	}
	return text;
}

function seedWorkspace(projectDir, corpus) {
	const files = corpus.workspace ?? {};
	for (const [relative, content] of Object.entries(files)) {
		if (relative.startsWith("/") || relative.split("/").includes("..")) {
			throw new Error(`corpus workspace path must be relative and inside the project: ${relative}`);
		}
		const path = join(projectDir, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, String(content), { encoding: "utf8", mode: relative.endsWith(".sh") ? 0o755 : 0o644 });
	}
}

function seedStore({ storePath, corpus, projectId }) {
	rmSync(storePath, { force: true });
	rmSync(`${storePath}-wal`, { force: true });
	rmSync(`${storePath}-shm`, { force: true });
	const memory = corpus.memory;
	const body = composeBody(corpus);
	if (corpus.workspace !== undefined) {
		const deploy = corpus.workspace["deploy.sh"];
		const port = Object.values(memory.facts ?? {})[0];
		if (deploy !== undefined && typeof port === "string" && !deploy.includes(port)) {
			throw new Error(`seeded deploy.sh does not contain the memory fact ${port}`);
		}
		for (const stable of memory.stable ?? []) {
			const path = stable.split(/\s+/u).find((token) => token.includes("/"));
			if (path !== undefined && corpus.workspace[path] === undefined) {
				throw new Error(`seeded workspace is missing the stable fact path ${path}`);
			}
		}
	}
	const navText = `${memory.title}的当前结论与来源，改这里之前先读本页。`;
	const nav = { text: navText, char_count: codePointCount(navText), source_revision: 1 };
	const record = {
		memory_id: memory.memory_id,
		uri: memoryUri(memory.memory_id),
		scope: { kind: "project", project_id: projectId },
		title: memory.title,
		keywords: memory.keywords,
		revision: 1,
		state: "published",
		medium: {
			body,
			body_char_count: nonWhitespaceCodePointCount(body),
			sources: [
				{
					provider: "pi",
					source_instance: "live-eval",
					session_id: `live-seed-${memory.memory_id}`,
					message_id: `live-seed-${memory.memory_id}-1`,
					parent_message_id: null,
					project_id: projectId,
					timestamp: AT,
					content_hash: `sha256:${"0".repeat(64)}`,
					locator: null,
				},
			],
		},
		nav,
		hit_count: 0,
		access_count: 0,
		last_access_at: null,
		created_at: AT,
		updated_at: AT,
	};
	const store = openStore({ path: storePath });
	try {
		store.saveMemory(record);
		store.upsertHotspotMembership({
			project_id: projectId,
			memory_id: memory.memory_id,
			admitted_seq: 1,
			last_hit_seq: 0,
			last_access_seq: 0,
			recent_hit_weight: 0,
			recent_access_weight: 0,
		});
		store.upsertProjectActivity({ project_id: projectId, activity_seq: 10, last_input_at: AT });
	} finally {
		store.close();
	}
	return { body, nav };
}

function loadCorpus(name) {
	const path = join(CORPUS_DIR, `${name}.json`);
	if (!existsSync(path)) {
		throw new Error(`unknown corpus "${name}" (no ${path})`);
	}
	const corpus = JSON.parse(readFileSync(path, "utf8"));
	if (corpus.name === undefined || corpus.memory === undefined || !Array.isArray(corpus.turns)) {
		throw new Error(`${path} is not a corpus`);
	}
	if (
		corpus.session2 !== undefined &&
		(typeof corpus.session2.search_query !== "string" || corpus.session2.search_query.trim().length === 0)
	) {
		throw new Error(`${path}: session2.search_query must be a non-empty string`);
	}
	return corpus;
}

function discoverCorpora() {
	if (!existsSync(CORPUS_DIR)) return [];
	return readdirSync(CORPUS_DIR)
		.filter((file) => file.endsWith(".json"))
		.map((file) => file.slice(0, -5))
		.sort();
}

function readDecisions(path) {
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

async function waitForDetector({ storePath, memoryId, decisionsPath, proxy, baselineCount, turnStartIso, maxMs }) {
	const deadline = Date.now() + maxMs;
	let decisionSeen = false;
	while (Date.now() < deadline) {
		const decisions = readDecisions(decisionsPath);
		decisionSeen = decisions.some(
			(record) =>
				record.ts >= turnStartIso &&
				(typeof record.status === "string" && record.status.startsWith("detector")),
		);
		const events = storeSnapshot(storePath, memoryId).event_ids;
		if (decisionSeen && proxy.inflight() === 0) {
			await sleep(150);
			return { observed: true, events: events.length !== baselineCount };
		}
		await sleep(300);
	}
	return { observed: decisionSeen, events: storeSnapshot(storePath, memoryId).event_ids.length !== baselineCount };
}

function textContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

/**
 * True when pi refused to run the call because the tool is not in the
 * `--tools` allowlist. Such an attempt never executed, so it must not count as
 * an observed (ran) tool or as an allowlist violation.
 */
function toolBlocked(toolName, end) {
	if (end === null || end?.isError !== true) return false;
	return textContent(end.result?.content).includes(`Tool ${toolName} not found`);
}

/**
 * Classify a `memory_mark_stale` result as `ok` or `rejected`, and keep the
 * rejection reason. pi reports rejection as a normal tool text (not a transport
 * error), so without this the summary hides every logical rejection behind a
 * 0-error count. `memory_update` is kept in the classifier for the stale runs
 * that predate its removal; the current extension never emits it.
 */
function parseToolOutcome(toolName, result) {
	if (toolName !== "memory_update" && toolName !== "memory_mark_stale") return null;
	const text = textContent(result?.content);
	const rejected = new RegExp(`^${toolName} rejected(?: the body| the URI)?:?[ \\t]*([^\\n]*)`, "mu").exec(text);
	if (rejected !== null) {
		return { status: "rejected", rejection_reason: rejected[1].trim() || null };
	}
	const okPattern = toolName === "memory_update" ? /-> saved r\d+/u : /-> recorded\b/u;
	if (okPattern.test(text)) return { status: "ok", rejection_reason: null };
	return { status: null, rejection_reason: null };
}

function userMessages(body) {
	return (body?.messages ?? [])
		.map((message) => ({ role: message.role, text: textContent(message.content) }))
		.filter((message) => message.role === "user");
}

function systemText(body) {
	return (body?.messages ?? [])
		.filter((message) => message.role === "system" || message.role === "developer")
		.map((message) => textContent(message.content))
		.join("\n");
}

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function extractBlock(text) {
	const open = text.indexOf(INJECTION_OPEN);
	if (open < 0) return null;
	const close = text.indexOf(INJECTION_CLOSE, open);
	return close < 0 ? text.slice(open) : text.slice(open, close + INJECTION_CLOSE.length);
}

function buildJudgePrompt({ body, oldBody, session2, changes }) {
	return [
		"你是 Vestigio 记忆修复的评审。一个项目记忆在早先的会话里被标记为过时（stale，带有待吸收的后续证据），",
		"随后在检索时被修复：正文被重写成吸收新证据后的版本。请只评审修复后的正文。",
		"修复可以保留旧摘要里已有的内容，只应该改掉被取代的值并吸收新证据。",
		"正文里的 [来源:<id>] 是系统的引用格式（用来标记证据出处），不是正文内容，也不算编造；不要因为它而判 fail。",
		"",
		`当前正确的值（expected）：${JSON.stringify(session2.expected ?? {})}`,
		`被取代的旧值（superseded，正文只能把它们当历史或错误来源，不能当作当前值）：${JSON.stringify(session2.superseded ?? {})}`,
		`必须保留的稳定事实（stable）：${JSON.stringify(session2.stable ?? [])}`,
		`第一段会话告知的变更：${JSON.stringify(changes)}`,
		"",
		"旧摘要（修复前的正文）：",
		'"""',
		oldBody,
		'"""',
		"",
		"修复后的正文：",
		'"""',
		body,
		'"""',
		"",
		"判断以下几点：",
		"- current_values_correct：正文是否把 expected 里的每个当前值都写对。",
		"- stale_shown_as_current：正文把哪些 superseded 的值当成了当前值（列出这些值，没有就空数组）。",
		"- invented：正文有没有编造出旧摘要、expected、stable、变更叙述里都没有依据的新事实。旧摘要里已有的句子或已记录的流程要求不算编造，即使它没有出现在 expected/stable 里。概括性措辞（例如把两次调整说成「窗口两次提前」「先后调整」）不算编造，只要其中的数值、路径和结论与给定事实一致；只有与给定事实不一致、或无法由给定事实推出的具体数值、路径、结论才算。列出原文片段，没有就空数组。",
		"- dropped_stable：正文丢掉了哪些 stable 事实（列出，没有就空数组）。",
		'- verdict：只有当 current_values_correct 为 true，且 stale_shown_as_current、invented、dropped_stable 都为空时才给 "pass"，否则 "fail"。',
		"",
		"只返回一个 JSON 对象，不要解释，不要代码块：",
		'{"verdict":"pass"|"fail","current_values_correct":true|false,"stale_shown_as_current":[],"invented":[],"dropped_stable":[],"reasoning":"..."}',
	].join("\n");
}

function parseJudgeReply(content) {
	if (typeof content !== "string") return null;
	let text = content.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(text);
	if (fence !== null) text = fence[1].trim();
	try {
		return JSON.parse(text);
	} catch {
		// fall through to the brace scan
	}
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			return JSON.parse(text.slice(start, end + 1));
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * One non-streaming chat completion through the recording proxy, so the judge
 * is logged like any other model call and counts against the same budget. The
 * reply is returned raw; parsing is the caller's job.
 */
async function callJudge({ proxyUrl, key, model, thinking, prompt }) {
	const body = {
		model,
		messages: [{ role: "user", content: prompt }],
		max_tokens: 1024,
		temperature: 0,
		stream: false,
		response_format: { type: "json_object" },
	};
	if (typeof thinking === "string" && thinking.length > 0 && thinking !== "off") {
		body.reasoning_effort = thinking;
	}
	const attempts = [];
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const call = await postChat({ proxyUrl, key, body, timeoutMs: JUDGE_TIMEOUT_MS });
		attempts.push(call);
		if (call.content !== null) break;
		if (call.status !== 0 && call.status < 500) break;
	}
	const last = attempts[attempts.length - 1];
	const errors = attempts.map((item) => item.error).filter((item) => typeof item === "string");
	return {
		...last,
		attempts: attempts.length,
		elapsed_ms: attempts.reduce((sum, item) => sum + (item.elapsed_ms ?? 0), 0),
		error: last.content === null && errors.length > 0 ? errors.join(" | ") : null,
	};
}

function postChat({ proxyUrl, key, body, signal, timeoutMs = TURN_TIMEOUT_MS }) {
	const url = new URL(`${proxyUrl.replace(/\/+$/u, "")}/chat/completions`);
	const payload = JSON.stringify(body);
	const started = Date.now();
	return new Promise((resolve) => {
		const req = httpRequest(
			{
				hostname: url.hostname,
				port: url.port,
				path: `${url.pathname}${url.search}`,
				method: "POST",
				// A pooled upstream socket can be closed by the gateway while this
				// process holds it, and the request then stalls until the timeout.
				agent: false,
				headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf8");
					let content = null;
					let error = null;
					let json = null;
					try {
						json = JSON.parse(raw);
						if ((res.statusCode ?? 0) >= 400) error = json?.error?.message ?? `HTTP ${res.statusCode}`;
						else content = json?.choices?.[0]?.message?.content ?? null;
					} catch (parseError) {
						error = `unparseable response: ${parseError.message}`;
					}
					resolve({ status: res.statusCode ?? 0, raw, content, json, error, elapsed_ms: Date.now() - started });
				});
			},
		);
		req.on("error", (error) => resolve({ status: 0, raw: "", content: null, json: null, error: String(error.message ?? error), elapsed_ms: Date.now() - started }));
		req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
		if (signal !== undefined) {
			const onAbort = () => req.destroy(new Error("aborted"));
			if (signal.aborted === true) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		req.end(payload);
	});
}

/**
 * Whether a repaired body states the expected values, keeps the stable paths and
 * sits inside the real length band. Spacing is formatting, not a fact:
 * 周四20:00 and 周四 20:00 are the same value.
 */
function bodyFacts(body, session2) {
	const squash = (value) => value.replace(/\s+/gu, "");
	const required = session2.required_strings ?? [];
	const requiredPresent = required.every((value) => squash(body).includes(squash(value)));
	const stablePaths = (session2.stable ?? []).map((value) => value.split(/\s+/u).find((token) => token.includes("/")));
	const stablePresent = stablePaths
		.filter((path) => path !== undefined)
		.every((path) => squash(body).includes(squash(path)));
	const inBand = nonWhitespaceCodePointCount(body) >= 500 && nonWhitespaceCodePointCount(body) <= 1000;
	return { requiredPresent, stablePaths, stablePresent, inBand, satisfied: requiredPresent && stablePresent && inBand };
}

/**
 * Deterministic F5 verdicts for one second session. Every number is measured at
 * the end of session 2, so every field carries the `_s2` window suffix. The
 * session-1-end window (background repair) is scored separately in `scoreRepeat`
 * with `_s1` fields; `repair_source` names which window a repeat used.
 */
function scoreSession2({ before, after, navSourceRevision, searchable, session2, toolCalls }) {
	const body = after.body ?? "";
	const bodyChars = nonWhitespaceCodePointCount(body);
	const headBefore = before.head_revision;
	const headAfter = after.head_revision;
	const repaired = headBefore !== null && headAfter !== null && headAfter > headBefore;
	const retrievalRan = toolCalls.some(
		(call) => call.ran && (call.tool_name === "memory_resolve" || call.tool_name === "memory_read"),
	);
	const facts = bodyFacts(body, session2);
	return {
		repair_rate_s2: repaired,
		pending_drained_s2: after.pending_ids.length === 0,
		repaired_in_place_s2: after.memory_count === 1,
		fact_fidelity_s2: facts.satisfied,
		retrieval_drove_repair_s2: repaired && retrievalRan,
		navigation_updated_s2: repaired && navSourceRevision === headAfter,
		// Gated on a repair: a memory that was already published and findable says
		// nothing about whether the repair left it that way.
		published_after_s2: repaired ? after.state === "published" : null,
		searchable_after_repair_s2: repaired ? searchable.returned : null,
		// Ungated, so a repair window outside session 2 (background mode) can still
		// read whether the memory was findable afterwards.
		search_returned_s2: searchable.returned,
		state_after_s2: after.state,
		search_query_s2: searchable.query,
		search_status_s2: searchable.status,
		search_returned_cards_s2: searchable.cards,
		body_char_count_s2: bodyChars,
		required_strings_present_s2: facts.requiredPresent,
		stable_paths_s2: facts.stablePaths,
		stable_paths_present_s2: facts.stablePresent,
		body_in_band_s2: facts.inBand,
		retrieval_ran_s2: retrievalRan,
	};
}

function judgeChanges(corpus) {
	return corpus.turns
		.filter((turn) => turn.label === "CHANGE" || turn.label === "MULTI")
		.map((turn) => ({
			label: turn.label,
			text: turn.text,
			stated: turn.facts ?? (turn.fact_after === undefined ? [] : [turn.fact_after]),
		}));
}

/**
 * One store-level search after the second session, through the same core
 * `layeredSearch` the extension uses and the same store handle the harness
 * already opens. No model call: this asks whether the repaired memory is
 * reachable by a plain query a user could type, which is exactly what an
 * unpublished or nav-less repair breaks.
 */
async function searchableAfterRepair({ storePath, projectId, memoryId, query }) {
	const store = openStore({ path: storePath });
	try {
		const outcome = await layeredSearch({
			store,
			query,
			scope: { kind: "project", project_id: projectId },
			limit: 10,
		});
		const uri = memoryUri(memoryId);
		return {
			query,
			status: outcome.result.status,
			cards: outcome.result.cards.length,
			returned: outcome.result.cards.some((card) => card.uri === uri),
		};
	} finally {
		store.close();
	}
}

/**
 * A `ModelPort` for the resolve probe. It posts through the same recording
 * proxy the agent, extension and judge use, so a probe call is logged and
 * counted like any other real model call; it is not a mock.
 */
function probeModelPort({ proxyUrl, key, model, thinking }) {
	return {
		async complete(request) {
			const body = {
				model: request.model ?? model,
				messages: request.messages,
				max_tokens: request.max_output_tokens,
				temperature: 0,
				stream: false,
			};
			if (request.expect_json === true) body.response_format = { type: "json_object" };
			if (typeof thinking === "string" && thinking.length > 0 && thinking !== "off") body.reasoning_effort = thinking;
			const call = await postChat({ proxyUrl, key, body, signal: request.signal, timeoutMs: TURN_TIMEOUT_MS });
			const aborted = request.signal?.aborted === true;
			if (call.content === null) {
				const status = aborted ? "cancelled" : call.status === 0 || call.status >= 500 ? "unavailable" : "failed";
				return { ok: false, status, reason: call.error ?? `http ${call.status}` };
			}
			return {
				ok: true,
				value: {
					text: call.content,
					model: call.json?.model ?? model,
					finish_reason: call.json?.choices?.[0]?.finish_reason ?? null,
					usage: {
						tokens_in: call.json?.usage?.prompt_tokens ?? 0,
						tokens_out: call.json?.usage?.completion_tokens ?? 0,
						cost_usd: null,
					},
				},
			};
		},
	};
}

/**
 * The resolver re-gather regression, run directly through the core
 * `resolveMemory` the `memory_resolve` tool calls, on a fresh store seeded from
 * the corpus. No agent chooses the tool here, so the layer walk a natural
 * question produces is observed directly and repeatably. `repair: "defer"`
 * keeps the probe about retrieval: it never rewrites the memory.
 */
async function runResolveProbe({ corpus, question, index, repeat, config, key, proxy, scratchRoot, runDir }) {
	const projectId = join(scratchRoot, `probe-${corpus.name}-r${repeat}-${index}`);
	const storePath = join(scratchRoot, `${corpus.name}-probe-r${repeat}-${index}.sqlite`);
	mkdirSync(projectId, { recursive: true });
	seedStore({ storePath, corpus, projectId });
	const store = openStore({ path: storePath });
	try {
		const outcome = await resolveMemory({
			store,
			question,
			scope: { kind: "project", project_id: projectId },
			model: probeModelPort({
				proxyUrl: proxy.url,
				key,
				model: config.extension_model,
				thinking: config.extension_thinking,
			}),
			model_id: config.extension_model,
			signal: new AbortController().signal,
			repair: "defer",
		});
		const record = {
			corpus: corpus.name,
			repeat,
			index,
			question,
			status: outcome.result.status,
			answer: outcome.result.answer ?? null,
			cards: outcome.result.cards.map((card) => card.memory_id),
			missing: outcome.result.missing,
			model_calls: outcome.measured.model_calls,
			elapsed_ms: outcome.measured.elapsed_ms,
			layers: outcome.layers.map((layer) => `${layer.layer}=${layer.status}(${layer.emitted}/${layer.candidates})`),
		};
		appendJsonl(join(runDir, "resolve_probe.jsonl"), record);
		return record;
	} finally {
		store.close();
	}
}

function resultText(result) {
	if (typeof result === "string") return result;
	if (result === null || typeof result !== "object") return "";
	const content = result.content;
	if (!Array.isArray(content)) return JSON.stringify(result);
	return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

/**
 * The tool call that triggered the repair, labelled by how it was attributed.
 * `observed` is the first ran call whose result already reports the new head
 * revision. The head move alone is not attribution, so a repair that advanced
 * it without any recorded call reporting the new revision falls back to the
 * first repair-capable call (`memory_read` or `memory_resolve`) and labels that
 * `inferred`; a repeat with no repair has no trigger.
 */
function repairTrigger({ toolCalls, repaired, headAfter }) {
	if (!repaired) return null;
	const marker = new RegExp(`revision[=: ]+${headAfter}\\b`, "u");
	for (const call of toolCalls) {
		if (!call.ran) continue;
		if (marker.test(resultText(call.result))) {
			return { attribution: "observed", tool_call_id: call.tool_call_id, tool_name: call.tool_name, args: call.args };
		}
	}
	const capable = toolCalls.find(
		(call) => call.ran && (call.tool_name === "memory_resolve" || call.tool_name === "memory_read"),
	);
	return capable === undefined
		? null
		: { attribution: "inferred", tool_call_id: capable.tool_call_id, tool_name: capable.tool_name, args: capable.args };
}

/**
 * Whether the session came back with a `repair_failed` line, in a tool result
 * or on stderr. The extension renders it as `repair: repair_failed (…)`; the
 * match is line-anchored so a body that merely mentions the word does not
 * count.
 */
function sawRepairFailedLine({ toolCalls, stderr }) {
	const texts = [...toolCalls.map((call) => resultText(call.result)), stderr ?? ""];
	return texts.some((text) => /^[ \t]*(?:repair:[^\n]*\brepair_failed\b|repair_failed\b)/mu.test(text));
}

/**
 * Wall time of the tool call that carried a repair, in milliseconds. With the
 * single repair path this is the resolver read's repair, if a session 2 read
 * performed one; the `agent_end` pass is measured from its own session entry.
 */
function repairWallMs({ toolCalls }) {
	// `repair: deferred (… repaired when this session ends…)` is not a repair.
	const hit = toolCalls.find((call) => /^[ \t]*repair: (?:repaired|repair_failed|nav_pending)\b/mu.test(resultText(call.result)));
	return hit?.duration_ms ?? null;
}

async function runSecondSession({ corpus, repeat, config, key, proxy, runDir, storePath, projectDir, env2, args2, memoryId, label }) {
	const session2 = corpus.session2;
	const before = storeSnapshot(storePath, memoryId);
	const startedAt = new Date().toISOString();
	const proc = spawn(PI, args2, { cwd: projectDir, env: env2, stdio: ["pipe", "pipe", "pipe"] });
	const client = new PiClient(proc);
	let rpcError = null;
	let exitCode = null;
	try {
		const from = client.events.length;
		client.send({ id: `${label}-s2`, type: "prompt", message: session2.question });
		await client.waitFor((event) => event.type === "agent_settled", TURN_TIMEOUT_MS, from);
	} catch (error) {
		rpcError = String(error.message ?? error);
	}
	const after = storeSnapshot(storePath, memoryId);
	const starts = client.events.filter((event) => event.type === "tool_execution_start");
	const ends = client.events.filter((event) => event.type === "tool_execution_end");
	const toolCalls = starts.map((start) => {
		const end = ends.find((candidate) => candidate.toolCallId === start.toolCallId) ?? null;
		const blocked = toolBlocked(start.toolName, end);
		return {
			tool_call_id: start.toolCallId,
			tool_name: start.toolName,
			args: start.args ?? null,
			ran: !blocked,
			is_error: end?.isError ?? null,
			duration_ms: end?.durationMs ?? null,
			result: end?.result ?? null,
		};
	});
	exitCode = await client.close();
	const search = await searchableAfterRepair({
		storePath,
		projectId: projectDir,
		memoryId,
		query: session2.search_query,
	});
	const repaired = before.head_revision !== null && after.head_revision !== null && after.head_revision > before.head_revision;
	const repair_trigger = repairTrigger({ toolCalls, repaired, headAfter: after.head_revision });
	const repair_failed = sawRepairFailedLine({ toolCalls, stderr: client.stderr });
	const deterministic = scoreSession2({
		before,
		after,
		navSourceRevision: after.nav_source_revision,
		searchable: search,
		session2,
		toolCalls,
	});
	const prompt = buildJudgePrompt({ body: after.body ?? "", oldBody: before.body ?? "", session2, changes: judgeChanges(corpus) });
	const promptHash = sha256(prompt);
	const call = await callJudge({
		proxyUrl: proxy.url,
		key,
		model: config.judge_model,
		thinking: config.judge_thinking,
		prompt,
	});
	const parsed = parseJudgeReply(call.content);
	const judge = {
		model: config.judge_model,
		thinking: config.judge_thinking,
		prompt_hash: promptHash,
		status: call.status,
		error: call.error ?? null,
		attempts: call.attempts ?? 1,
		elapsed_ms: call.elapsed_ms ?? null,
		raw_reply: call.content ?? null,
		raw_response: call.raw ?? null,
		parsed,
		pass: parsed !== null && parsed.verdict === "pass",
	};
	const record = {
		corpus: corpus.name,
		repeat,
		question: session2.question,
		started_at: startedAt,
		ended_at: new Date().toISOString(),
		exit_code: exitCode,
		rpc_error: rpcError,
		tool_calls: toolCalls,
		head_revision_before: before.head_revision,
		head_revision_after: after.head_revision,
		state_after: after.state,
		old_body: before.body,
		new_body: after.body,
		new_body_char_count: deterministic.body_char_count_s2,
		pending_event_ids_after: after.pending_ids,
		memory_count: after.memory_count,
		nav_source_revision: after.nav_source_revision,
		repair_trigger,
		repair_failed,
		repair_ms: repairWallMs({ toolCalls }),
		search_after_repair: search,
		deterministic,
		judge,
	};
	appendJsonl(join(runDir, "session2.jsonl"), record);
	return record;
}

async function runRepeat({ corpus, repeat, config, key, proxy, budget, runDir, scratchRoot }) {
	const label = `${corpus.name}-r${repeat}`;
	const storePath = join(scratchRoot, `${label}.sqlite`);
	const projectDir = join(scratchRoot, "project", label);
	const sessionDir = join(scratchRoot, "sessions", label);
	const obeliskHome = join(scratchRoot, "obelisk-home", label);
	const decisionsPath = join(runDir, "decisions", `${label}.jsonl`);
	mkdirSync(projectDir, { recursive: true });
	seedWorkspace(projectDir, corpus);
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(obeliskHome, { recursive: true });
	mkdirSync(dirname(decisionsPath), { recursive: true });
	rmSync(decisionsPath, { force: true });

	seedStore({ storePath, corpus, projectId: projectDir });

	const env = {
		...process.env,
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
		config.tools,
		"--session-dir",
		sessionDir,
	];
	const toolsFlag = args.indexOf("--tools");
	if (toolsFlag < 0 || args[toolsFlag + 1] !== config.tools) {
		throw new Error("the agent process must be launched with an explicit --tools allowlist");
	}
	const proc = spawn(PI, args, { cwd: projectDir, env, stdio: ["pipe", "pipe", "pipe"] });
	let client = new PiClient(proc);
	client.stderr = "";

	const memoryId = corpus.memory.memory_id;
	const headAtStart = storeSnapshot(storePath, memoryId).head_revision;
	const turns = [];
	const toolNames = [];
	const attemptedToolNames = [];
	const blockedToolNames = [];
	const toolOutcomes = [];
	let exitCode = null;
	let failure = null;
	let session2Record = null;
	let session1After = null;
	let backgroundRepair = null;
	let stderrTail = "";
	try {
		for (let index = 0; index < corpus.turns.length; index += 1) {
			if (budget.exceeded) break;
			const turn = corpus.turns[index];
			const before = storeSnapshot(storePath, memoryId);
			const turnStartEvent = client.events.length;
			const proxyFrom = proxy.entries.length;
			const turnStart = Date.now();
			const turnStartIso = new Date(turnStart).toISOString();
			let rpcError = null;
			try {
				await client.promptAndSettle(`${label}-${index + 1}`, turn.text);
			} catch (error) {
				rpcError = String(error.message ?? error);
			}
			const detector = await waitForDetector({
				storePath,
				memoryId,
				decisionsPath,
				proxy,
				baselineCount: before.event_ids.length,
				turnStartIso,
				maxMs: DETECTOR_GRACE_MS,
			});
			const latencyMs = Date.now() - turnStart;
			const after = storeSnapshot(storePath, memoryId);

			const window = proxy.entries.slice(proxyFrom);
			const requests = window.filter((entry) => entry.kind === "request" && entry.isChat);
			const agentRequests = requests.filter((entry) => entry.stream === true);
			const extensionRequests = requests.filter((entry) => entry.stream !== true);
			const lastAgent = agentRequests.at(-1);
			const agentUsages = agentRequests
				.map((entry) => proxy.responses.get(entry.id))
				.filter(Boolean);
			const extensionUsages = extensionRequests
				.map((entry) => proxy.responses.get(entry.id))
				.filter(Boolean);
			const tokensIn = agentUsages.reduce((sum, item) => sum + item.tokensIn, 0);
			const tokensOut = agentUsages.reduce((sum, item) => sum + item.tokensOut, 0);
			const detectorTokensIn = extensionUsages.reduce((sum, item) => sum + item.tokensIn, 0);
			const detectorTokensOut = extensionUsages.reduce((sum, item) => sum + item.tokensOut, 0);

			const rpcEvents = client.events.slice(turnStartEvent);
			const messageEnds = rpcEvents.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
			const toolStarts = rpcEvents.filter((event) => event.type === "tool_execution_start");
			const toolEnds = rpcEvents.filter((event) => event.type === "tool_execution_end");
			const responseContent = messageEnds
				.map((event) => textContent(event.message?.content))
				.filter((text) => text.length > 0)
				.join("\n");
			const toolCalls = messageEnds.flatMap((event) =>
				(event.message?.content ?? [])
					.filter((part) => part?.type === "toolCall")
					.map((part) => ({ name: part.name, arguments: part.arguments })),
			);

			const lastUser = userMessages(lastAgent?.body).at(-1)?.text ?? "";
			const block = extractBlock(lastUser);
			const system = systemText(lastAgent?.body);
			const newEvents = after.events.filter((event) => !before.event_ids.includes(event.event_id));

			const turnRecord = {
				repeat,
				corpus: corpus.name,
				turn_index: index,
				label: turn.label,
				user_text: turn.text,
				started_at: turnStartIso,
				ended_at: new Date().toISOString(),
				outcome: turn.outcome ?? null,
				expected_events: turn.expected_events ?? corpus.expected_multi_events ?? null,
				stated_facts: turn.facts ?? null,
				fact_after: turn.fact_after ?? null,
				body_fact_present: turn.fact_after === undefined ? null : (after.body ?? "").includes(turn.fact_after),
				injected_block: block,
				system_prompt_hash: system.length > 0 ? sha256(system) : null,
				system_prompt_length: system.length,
				model_request_messages: lastAgent?.body?.messages ?? [],
				agent_request_count: agentRequests.length,
				response_content: responseContent.length > 0 ? responseContent : null,
				response_tool_calls: toolCalls,
				usage: {
					tokens_in: tokensIn,
					tokens_out: tokensOut,
					detector_tokens_in: detectorTokensIn,
					detector_tokens_out: detectorTokensOut,
					detector_calls: extensionRequests.length,
				},
				latency_ms: latencyMs,
				head_revision_before: before.head_revision,
				head_revision_after: after.head_revision,
				shown_revision: before.head_revision,
				pending_event_ids_after: after.pending_ids,
				new_event_ids: newEvents.map((event) => event.event_id),
				new_events: newEvents.map((event) => ({
					event_id: event.event_id,
					producer: event.producer,
					observed_revision: event.observed_revision,
					reason: event.reason,
				})),
				detector_observed: detector.observed,
				error: rpcError,
			};
			turns.push(turnRecord);
			appendJsonl(join(runDir, "turns.jsonl"), turnRecord);
			appendJsonl(join(runDir, "store.jsonl"), {
				repeat,
				corpus: corpus.name,
				turn_index: index,
				head_revision: after.head_revision,
				pending_event_ids: after.pending_ids,
				freshness_sig: after.freshness_sig,
				memory_count: after.memory_count,
			});

			for (let toolIndex = 0; toolIndex < toolStarts.length; toolIndex += 1) {
				const start = toolStarts[toolIndex];
				const end = toolEnds.find((candidate) => candidate.toolCallId === start.toolCallId) ?? null;
				const blocked = toolBlocked(start.toolName, end);
				attemptedToolNames.push(start.toolName);
				if (blocked) blockedToolNames.push(start.toolName);
				else toolNames.push(start.toolName);
				const outcome = blocked
					? { status: "blocked", rejection_reason: `Tool ${start.toolName} not found` }
					: parseToolOutcome(start.toolName, end?.result ?? null);
				if (outcome !== null) {
					toolOutcomes.push({
						repeat,
						corpus: corpus.name,
						turn_index: index,
						tool_name: start.toolName,
						status: outcome.status,
						rejection_reason: outcome.rejection_reason,
					});
				}
				appendJsonl(join(runDir, "tools.jsonl"), {
					repeat,
					corpus: corpus.name,
					turn_index: index,
					tool_call_id: start.toolCallId,
					tool_name: start.toolName,
					args: start.args,
					result: end?.result ?? null,
					is_error: end?.isError ?? null,
					ran: !blocked,
					status: outcome?.status ?? null,
					rejection_reason: outcome?.rejection_reason ?? null,
					duration_ms: end?.durationMs ?? null,
				});
			}
		}
		session1After = storeSnapshot(storePath, memoryId);
		backgroundRepair = readBackgroundRepair(sessionDir);
		if (corpus.session2 !== undefined && failure === null && !budget.exceeded) {			stderrTail = client.stderr;
			exitCode = await client.close();
			client = null;
			if (exitCode !== 0) {
				failure = failure ?? `first session exited with code ${exitCode}; not running the F5 second session`;
			} else {
				const session2Dir = join(scratchRoot, "sessions", `${label}-s2`);
				mkdirSync(session2Dir, { recursive: true });
				const env2 = { ...env, PI_CODING_AGENT_SESSION_DIR: session2Dir };
				const args2 = [...args];
				args2[args2.length - 1] = session2Dir;
				const sessionFlag = args2.indexOf("--session-dir");
				if (sessionFlag < 0 || args2[sessionFlag + 1] !== session2Dir) {
					throw new Error("the second session must run with its own --session-dir");
				}
				try {
					session2Record = await runSecondSession({
						corpus,
						repeat,
						config,
						key,
						proxy,
						runDir,
						storePath,
						projectDir,
						env2,
						args2,
						memoryId,
						label,
					});
				} catch (error) {
					failure = String(error.stack ?? error.message ?? error);
				}
			}
		}
	} catch (error) {
		failure = String(error.stack ?? error.message ?? error);
	} finally {
		if (client !== null) {
			stderrTail = client.stderr;
			exitCode = await client.close();
		}
	}
	if (failure !== null) {
		mkdirSync(join(runDir, "failures"), { recursive: true });
		writeJson(join(runDir, "failures", `${label}.json`), { failure, stderr: stderrTail.slice(-8000) });
	}
	return { corpus: corpus.name, repeat, exit_code: exitCode, stderr_tail: exitCode === 0 ? null : stderrTail.slice(-2000), turns, tool_names: toolNames, attempted_tool_names: attemptedToolNames, blocked_tool_names: blockedToolNames, tool_outcomes: toolOutcomes, head_at_start: headAtStart, session1_after: session1After, background_repair: backgroundRepair, session2: session2Record };
}

const FALSE_LABELS = new Set(["READ", "CONFIRM", "HYPOTHESIS", "FAILED", "UNRELATED", "OLD_SOURCE", "INJECTION"]);

/**
 * A change is handled when a producer recorded an event for it and nothing was
 * left silently unrecorded: every change the turn stated must have its own
 * event. The agent cannot rewrite a stored memory, so a change is handled by
 * recording a stale event, never by advancing the head revision. The harness
 * knows how many changes a turn stated (`expected_events` for `MULTI`, one for
 * a plain `CHANGE`); it cannot attribute an individual event to a single fact,
 * so the count of distinct recorded event ids is the proxy.
 */
function turnHandled(turn) {
	const expected = turn.label === "MULTI" ? (turn.expected_events ?? 2) : 1;
	const distinct = new Set(turn.new_events.map((event) => event.event_id));
	return distinct.size >= expected;
}

function scoreRepeat(result, corpus) {
	const turns = result.turns;
	const changeTurns = turns.filter((turn) => turn.label === "CHANGE");
	const agentMarked = changeTurns.filter((turn) => turn.new_events.some((event) => event.producer === "agent"));
	const detectorCatches = changeTurns.filter(
		(turn) => !turn.new_events.some((event) => event.producer === "agent") && turn.new_events.length > 0,
	);
	const unmarked = changeTurns.filter((turn) => !turn.new_events.some((event) => event.producer === "agent"));
	const falseTurns = turns.filter((turn) => FALSE_LABELS.has(turn.label));
	const falseMarked = falseTurns.filter((turn) => turn.new_events.length > 0);
	const handledTurns = turns.filter((turn) => turn.label === "CHANGE" || turn.label === "MULTI");
	const handled = handledTurns.filter(turnHandled);
	const multiTurns = turns.filter((turn) => turn.label === "MULTI");
	const multiCorrect = multiTurns.filter((turn) => {
		const expected = turn.expected_events ?? corpus.expected_multi_events ?? 2;
		const distinct = new Set(turn.new_events.map((event) => event.event_id));
		return distinct.size === expected;
	});
	const allEvents = turns.flatMap((turn) => turn.new_events);
	// A read can repair the memory before the mark, so both the revision the turn
	// started with and the one it ended with were legitimately observed.
	const revisionCorrect = allEvents.filter((turn) => {
		const owner = turns.find((candidate) => candidate.new_event_ids.includes(turn.event_id));
		if (owner === undefined) return false;
		return (
			turn.observed_revision === owner.shown_revision ||
			turn.observed_revision === owner.head_revision_after
		);
	});
	const toolOutcomes = result.tool_outcomes ?? [];
	const updates = toolOutcomes.filter((outcome) => outcome.tool_name === "memory_update");
	const marks = toolOutcomes.filter((outcome) => outcome.tool_name === "memory_mark_stale");
	const updateSaved = updates.filter((outcome) => outcome.status === "ok").length;
	const updateRejected = updates.filter((outcome) => outcome.status === "rejected").length;
	const markRecorded = marks.filter((outcome) => outcome.status === "ok").length;
	const markRejected = marks.filter((outcome) => outcome.status === "rejected").length;
	const multiDetails = multiTurns.map((turn) => {
		const expected = turn.expected_events ?? corpus.expected_multi_events ?? 2;
		const distinct = [...new Set(turn.new_events.map((event) => event.event_id))];
		return {
			turn_index: turn.turn_index,
			facts_stated: turn.stated_facts ?? [],
			expected_events: expected,
			recorded_events: distinct.length,
			event_ids: distinct,
			reasons: turn.new_events.map((event) => event.reason),
		};
	});
	const tokensIn = turns.reduce((sum, turn) => sum + turn.usage.tokens_in, 0);
	const tokensOut = turns.reduce((sum, turn) => sum + turn.usage.tokens_out, 0);
	const detectorCalls = turns.reduce((sum, turn) => sum + turn.usage.detector_calls, 0);
	const wallMs = turns.reduce((sum, turn) => sum + turn.latency_ms, 0);
	const ratio = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);
	const session2 = result.session2 ?? null;
	const f5 = session2 === null ? null : session2.deterministic;
	const session1 = result.session1_after ?? null;
	const background = result.background_repair ?? null;
	const s1Repaired =
		session1 === null || session1.head_revision === null || result.head_at_start === undefined
			? null
			: session1.head_revision > result.head_at_start;
	// The pass repairs at the first session's `agent_end`, so the repair window is
	// session 1's end, not session 2's. Scoring session 2 would report that
	// nothing was repaired, which is exactly what a deferred repair looks like.
	// Every number here carries an `_s1` suffix so no name can be read as the
	// other window's.
	const s1Window =
		s1Repaired === true && session1 !== null && corpus.session2 !== undefined
			? {
					repair_rate_s1: true,
					pending_drained_s1: session1.pending_ids.length === 0,
					repaired_in_place_s1: session1.memory_count === 1,
					fact_fidelity_s1: bodyFacts(session1.body ?? "", corpus.session2).satisfied,
					retrieval_drove_repair_s1: false,
					navigation_updated_s1: session1.nav_source_revision === session1.head_revision,
					published_after_s1: session1.state === "published",
					state_after_s1: session1.state,
					body_char_count_s1: nonWhitespaceCodePointCount(session1.body ?? ""),
					head_revision_before_s1: result.head_at_start ?? null,
					head_revision_after_s1: session1.head_revision,
			  }
			: null;
	// `_s1` is session 1's end (`s1Window`) and `_s2` is session 2's end (`f5`),
	// which only a session 2 read repair produces. `searchable_after_repair` is
	// the exception: the post-repair store search runs once session 2 has
	// settled, so it reads session 2's ungated result.
	const repairWindow = (field) => {
		if (s1Window === null) return f5 === null ? null : f5[`${field}_s2`];
		if (field === "searchable_after_repair") return f5 === null ? null : f5.search_returned_s2;
		return s1Window[`${field}_s1`];
	};
	const repairSource = s1Repaired === null ? null : s1Repaired ? "background" : "none";
	return {
		corpus: result.corpus,
		repeat: result.repeat,
		turns: turns.length,
		exit_code: result.exit_code,
		system_recall: ratio(changeTurns.filter((turn) => turn.new_events.length > 0).length, changeTurns.length),
		handled_rate: ratio(handled.length, handledTurns.length),
		agent_mark_rate: ratio(agentMarked.length, changeTurns.length),
		detector_catch_rate: ratio(detectorCatches.length, unmarked.length),
		false_mark_rate: ratio(falseMarked.length, falseTurns.length),
		multiplicity: ratio(multiCorrect.length, multiTurns.length),
		revision_correctness: ratio(revisionCorrect.length, allEvents.length),
		multi_events: multiDetails.reduce((sum, item) => sum + item.recorded_events, 0),
		multi_expected_events: multiDetails.reduce((sum, item) => sum + item.expected_events, 0),
		multi_turns: multiDetails,
		update_saved: updateSaved,
		update_rejected: updateRejected,
		update_saved_per_turn: ratio(updateSaved, turns.length),
		update_rejected_per_turn: ratio(updateRejected, turns.length),
		mark_stale_recorded: markRecorded,
		mark_stale_rejected: markRejected,
		repair_rate: repairWindow("repair_rate"),
		pending_drained: repairWindow("pending_drained"),
		repaired_in_place: repairWindow("repaired_in_place"),
		fact_fidelity: repairWindow("fact_fidelity"),
		retrieval_drove_repair: repairWindow("retrieval_drove_repair"),
		repair_source: repairSource,
		navigation_updated: repairWindow("navigation_updated"),
		published_after: repairWindow("published_after"),
		searchable_after_repair: repairWindow("searchable_after_repair"),
		repair_window_state_after: repairWindow("state_after"),
		f5_repair_ms: background === null ? null : background.elapsed_ms,
		s2_search_query: f5 === null ? null : f5.search_query_s2,
		judge_pass: session2 === null ? null : session2.judge.pass,
		repair_window_body_char_count: repairWindow("body_char_count"),
		repair_window_head_revision_before: repairWindow("head_revision_before"),
		repair_window_head_revision_after: repairWindow("head_revision_after"),
		s1_pending_drained: session1 === null ? null : session1.pending_ids.length === 0,
		s1_repaired: s1Repaired,
		cost: {
			tokens_in: tokensIn,
			tokens_out: tokensOut,
			tokens_per_turn: turns.length === 0 ? null : Math.round((tokensIn + tokensOut) / turns.length),
			detector_calls: detectorCalls,
			detector_calls_per_turn: turns.length === 0 ? null : round(detectorCalls / turns.length),
			wall_ms: wallMs,
		},
	};
}

function median(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2);
}

function round(value) {
	return value === null ? null : Math.round(value * 1000) / 1000;
}

function formatMetric(value) {
	return value === null || value === undefined ? "n/a" : String(round(value));
}

function formatBool(value) {
	return value === null || value === undefined ? "n/a" : value ? "true" : "false";
}

/**
 * Booleans are counted, not averaged: the median of [false, true, true] is
 * `true`, which hides a third of the repeats failing.
 */
function passRate(block, metric) {
	const values = block.repeats.map((item) => item[metric]).filter((value) => value !== null && value !== undefined);
	if (values.length === 0) return "n/a";
	return `${values.filter((value) => value === true).length}/${values.length}`;
}

function printTable(metricsByCorpus, variantName) {
	console.log(`\n=== live eval metrics (milestones 1+2: F1/F2 and F5 repair, variant ${variantName}) ===`);
	for (const [corpus, block] of Object.entries(metricsByCorpus)) {
		console.log(`\ncorpus ${corpus}  (${block.repeats.length} repeat(s))`);
		const header = ["metric", ...block.repeats.map((item) => `r${item.repeat}`), "summary"];
		const f1Rows = [
			["system_recall", ...block.repeats.map((item) => formatMetric(item.system_recall)), formatMetric(block.distribution.system_recall)],
			["handled_rate", ...block.repeats.map((item) => formatMetric(item.handled_rate)), formatMetric(block.distribution.handled_rate)],
			["agent_mark_rate", ...block.repeats.map((item) => formatMetric(item.agent_mark_rate)), formatMetric(block.distribution.agent_mark_rate)],
			["detector_catch_rate", ...block.repeats.map((item) => formatMetric(item.detector_catch_rate)), formatMetric(block.distribution.detector_catch_rate)],
			["false_mark_rate", ...block.repeats.map((item) => formatMetric(item.false_mark_rate)), formatMetric(block.distribution.false_mark_rate)],
			["multiplicity", ...block.repeats.map((item) => formatMetric(item.multiplicity)), formatMetric(block.distribution.multiplicity)],
			["multi_events", ...block.repeats.map((item) => `${item.multi_events}/${item.multi_expected_events}`), `${block.distribution.multi_events ?? "n/a"}/${block.distribution.multi_expected_events ?? "n/a"}`],
			["revision_correctness", ...block.repeats.map((item) => formatMetric(item.revision_correctness)), formatMetric(block.distribution.revision_correctness)],
			["update_saved", ...block.repeats.map((item) => String(item.update_saved)), String(block.distribution.update_saved ?? "n/a")],
			["update_rejected", ...block.repeats.map((item) => String(item.update_rejected)), String(block.distribution.update_rejected ?? "n/a")],
			["update_saved/turn", ...block.repeats.map((item) => formatMetric(item.update_saved_per_turn)), formatMetric(block.distribution.update_saved_per_turn)],
			["update_rejected/turn", ...block.repeats.map((item) => formatMetric(item.update_rejected_per_turn)), formatMetric(block.distribution.update_rejected_per_turn)],
			["mark_stale_recorded", ...block.repeats.map((item) => String(item.mark_stale_recorded)), String(block.distribution.mark_stale_recorded ?? "n/a")],
			["mark_stale_rejected", ...block.repeats.map((item) => String(item.mark_stale_rejected)), String(block.distribution.mark_stale_rejected ?? "n/a")],
			["tokens_in", ...block.repeats.map((item) => String(item.cost.tokens_in)), String(block.distribution.tokens_in ?? "n/a")],
			["tokens_out", ...block.repeats.map((item) => String(item.cost.tokens_out)), String(block.distribution.tokens_out ?? "n/a")],
			["detector_calls", ...block.repeats.map((item) => String(item.cost.detector_calls)), String(block.distribution.detector_calls ?? "n/a")],
			["wall_ms", ...block.repeats.map((item) => String(item.cost.wall_ms)), String(block.distribution.wall_ms ?? "n/a")],
		];
		const f5Rows = [
			["repair_rate", ...block.repeats.map((item) => formatBool(item.repair_rate)), passRate(block, "repair_rate")],
			["pending_drained", ...block.repeats.map((item) => formatBool(item.pending_drained)), passRate(block, "pending_drained")],
			["repaired_in_place", ...block.repeats.map((item) => formatBool(item.repaired_in_place)), passRate(block, "repaired_in_place")],
			["fact_fidelity", ...block.repeats.map((item) => formatBool(item.fact_fidelity)), passRate(block, "fact_fidelity")],
			["retrieval_drove_repair", ...block.repeats.map((item) => formatBool(item.retrieval_drove_repair)), passRate(block, "retrieval_drove_repair")],
			["repair_source", ...block.repeats.map((item) => String(item.repair_source ?? "n/a")), "n/a"],
			["navigation_updated", ...block.repeats.map((item) => formatBool(item.navigation_updated)), passRate(block, "navigation_updated")],
			["published_after", ...block.repeats.map((item) => formatBool(item.published_after)), passRate(block, "published_after")],
			["searchable_after_repair", ...block.repeats.map((item) => formatBool(item.searchable_after_repair)), passRate(block, "searchable_after_repair")],
			["judge_pass", ...block.repeats.map((item) => formatBool(item.judge_pass)), passRate(block, "judge_pass")],
			["s1_pending_drained", ...block.repeats.map((item) => formatBool(item.s1_pending_drained)), passRate(block, "s1_pending_drained")],
			["s1_repaired", ...block.repeats.map((item) => formatBool(item.s1_repaired)), passRate(block, "s1_repaired")],
			["repair_window_state_after", ...block.repeats.map((item) => String(item.repair_window_state_after ?? "n/a")), String(block.distribution.repair_window_state_after ?? "n/a")],
			["f5_repair_ms", ...block.repeats.map((item) => (item.f5_repair_ms === null ? "n/a" : String(item.f5_repair_ms))), block.distribution.f5_repair_ms === null ? "n/a" : String(block.distribution.f5_repair_ms)],
			["repair_window_body_chars", ...block.repeats.map((item) => formatMetric(item.repair_window_body_char_count)), formatMetric(median(block.repeats.map((item) => item.repair_window_body_char_count).filter((value) => value !== null)))],
		];
		const allRows = [...f1Rows, ...f5Rows];
		const widths = header.map((cell, column) => Math.max(cell.length, ...allRows.map((row) => row[column].length)));
		const line = (cells) => `  ${cells.map((cell, column) => cell.padEnd(widths[column])).join("  ")}`;
		console.log(line(header));
		for (const row of f1Rows) console.log(line(row));
		console.log("  -- milestone 2: F5 repair --");
		for (const row of f5Rows) console.log(line(row));
	}
}

function parseArgs(argv) {
	const options = { only: null, repeat: 3, help: false, variant: "agent", probeOnly: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--only") options.only = argv[++index];
		else if (arg === "--repeat") options.repeat = Number(argv[++index]);
		else if (arg === "--variant") options.variant = argv[++index];
		else if (arg === "--probe-only") options.probeOnly = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (!Number.isInteger(options.repeat) || options.repeat < 1) {
		throw new Error("--repeat must be a positive integer");
	}
	return options;
}

function timestamp() {
	return new Date().toISOString().replace(/[:.]/gu, "-");
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log("usage: node --import ../pi/hook.mjs ./run.mjs [--only <corpus>[,<corpus>...]] [--repeat <n>] [--variant agent|detector] [--probe-only]");
		return 0;
	}
	const baseConfig = loadConfig();
	const tools =
		options.variant === "detector" ? DETECTOR_TOOL_ALLOWLIST.join(",") : baseConfig.tools;
	const agentTools = assertMemoryToolset(tools, options.variant);
	const config = { ...baseConfig, tools };
	if (config.judge_model === config.agent_model || config.judge_model === config.extension_model) {
		throw new Error(
			`judge_model (${config.judge_model}) must differ from agent_model and extension_model; F5 fidelity must be scored by a model not under test`,
		);
	}
	const key = readMagpieKey();
	registerSecret(key);

	const names =
		options.only === null
			? discoverCorpora()
			: options.only
					.split(",")
					.map((name) => name.trim())
					.filter((name) => name.length > 0);
	const corpora = names.map(loadCorpus);
	if (corpora.length === 0) throw new Error("no corpora found");

	const startedAt = new Date().toISOString();
	const stamp = timestamp();
	const runDir = join(RUNS_DIR, stamp);
	const scratchRoot = join(TMP, stamp);
	mkdirSync(runDir, { recursive: true });
	mkdirSync(scratchRoot, { recursive: true });
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
	const entriesPath = join(runDir, "requests.jsonl");
	const proxy = await startProxy({
		upstream: config.endpoint,
		logPath: entriesPath,
		failuresDir: join(runDir, "failures"),
		budget,
	});
	buildAgentHome(proxy.url);

	const wallDeadline = Date.now() + config.wall_clock_ms;
	const results = [];
	const probeRecords = [];
	let aborted = false;
	for (const corpus of corpora) {
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
			if (Array.isArray(corpus.resolve_probe) && corpus.resolve_probe.length > 0) {
				for (let index = 0; index < corpus.resolve_probe.length; index += 1) {
					const question = corpus.resolve_probe[index];
					if (typeof question !== "string" || question.trim().length === 0) continue;
					console.log(`resolver probe ${corpus.name} r${repeat} [${index}] ...`);
					const probe = await runResolveProbe({ corpus, question, index, repeat, config, key, proxy, scratchRoot, runDir });
					probeRecords.push(probe);
					console.log(`  resolve ${probe.status}; layers: ${probe.layers.join(" ")}`);
				}
			}
			if (options.probeOnly) break;
			console.log(`running ${corpus.name} repeat ${repeat}/${options.repeat} ...`);
			const result = await runRepeat({ corpus, repeat, config, key, proxy, budget, runDir, scratchRoot });
			results.push(result);
			if (result.exit_code !== 0) {
				console.log(`  pi exited with code ${result.exit_code}`);
			}
		}
		if (aborted) break;
	}

	if (options.probeOnly) {
		console.log(`resolve probes done: ${probeRecords.length}`);
		return;
	}

	const mergedDecisions = [];
	for (const file of readdirSync(join(runDir, "decisions"))) {
		mergedDecisions.push(...readDecisions(join(runDir, "decisions", file)));
	}
	for (const record of mergedDecisions) appendJsonl(join(runDir, "decisions.jsonl"), record);

	const realObeliskAfter = existsSync(REAL_OBELISK) ? statSync(REAL_OBELISK).mtimeMs : null;
	const obeliskUnchanged = realObeliskBefore === realObeliskAfter;

	const endsAt = new Date().toISOString();
	budget.calls = proxy.stats.calls;
	budget.tokens = proxy.stats.tokensIn + proxy.stats.tokensOut;

	const observedToolCounts = {};
	const attemptedToolCounts = {};
	const blockedToolCounts = {};
	const tally = (counts, names) => {
		for (const name of names ?? []) counts[name] = (counts[name] ?? 0) + 1;
	};
	for (const result of results) {
		tally(observedToolCounts, result.tool_names);
		tally(attemptedToolCounts, result.attempted_tool_names);
		tally(blockedToolCounts, result.blocked_tool_names);
	}
	const nonAllowlistedTools = Object.keys(observedToolCounts).filter((name) => !agentTools.includes(name));
	const toolSummary = {
		flag: "--tools",
		allowlist: agentTools,
		observed_counts: observedToolCounts,
		attempted_counts: attemptedToolCounts,
		blocked_counts: blockedToolCounts,
		non_allowlisted: nonAllowlistedTools,
	};
	if (nonAllowlistedTools.length > 0) {
		console.error(`WARNING: agent used tools outside the allowlist: ${nonAllowlistedTools.join(", ")}`);
	}
	const blockedSummary = Object.entries(blockedToolCounts)
		.map(([name, count]) => `${name}=${count}`)
		.join(" ");
	if (blockedSummary.length > 0) {
		console.log(`agent attempted blocked (not-in-allowlist) tools: ${blockedSummary}`);
	}
	const observedSummary = Object.entries(observedToolCounts)
		.map(([name, count]) => `${name}=${count}`)
		.join(" ");
	console.log(`agent tools: ${observedSummary.length > 0 ? observedSummary : "none"} (non-allowlisted: ${nonAllowlistedTools.length})`);

	const metricsByCorpus = {};
	for (const corpus of corpora) {
		const repeats = results
			.filter((result) => result.corpus === corpus.name)
			.map((result) => scoreRepeat(result, corpus));
		const distribution = {};
		const numeric = ["system_recall", "handled_rate", "agent_mark_rate", "detector_catch_rate", "false_mark_rate", "multiplicity", "revision_correctness", "update_saved", "update_rejected", "update_saved_per_turn", "update_rejected_per_turn", "mark_stale_recorded", "mark_stale_rejected", "multi_events", "multi_expected_events"];
		for (const metric of numeric) {
			distribution[metric] = median(repeats.map((item) => item[metric]).filter((value) => value !== null));
		}
		const booleanMetrics = ["repair_rate", "pending_drained", "repaired_in_place", "fact_fidelity", "retrieval_drove_repair", "navigation_updated", "published_after", "searchable_after_repair", "judge_pass", "s1_pending_drained", "s1_repaired"];
		for (const metric of booleanMetrics) {
			distribution[metric] = median(
				repeats.map((item) => (item[metric] === null ? null : item[metric] ? 1 : 0)).filter((value) => value !== null),
			);
		}
		distribution.tokens_in = median(repeats.map((item) => item.cost.tokens_in));
		distribution.tokens_out = median(repeats.map((item) => item.cost.tokens_out));
		distribution.detector_calls = median(repeats.map((item) => item.cost.detector_calls));
		distribution.wall_ms = median(repeats.map((item) => item.cost.wall_ms));
		distribution.f5_repair_ms = median(
			repeats.map((item) => item.f5_repair_ms).filter((value) => value !== null),
		);
		metricsByCorpus[corpus.name] = {
			corpus: corpus.name,
			repeats,
			distribution,
			turns_per_repeat: corpus.turns.length,
		};
	}

	writeJson(join(runDir, "metrics.json"), {
		harness_version: HARNESS_VERSION,
		aborted,
		budget: { ...budget, consumed_calls: proxy.stats.calls },
		corpora: metricsByCorpus,
	});
	writeJson(join(runDir, "judge.json"), {
		judge_model: config.judge_model,
		judge_thinking: config.judge_thinking,
		entries: results
			.filter((result) => result.session2 !== null && result.session2 !== undefined)
			.map((result) => ({
				corpus: result.corpus,
				repeat: result.repeat,
				prompt_hash: result.session2.judge.prompt_hash,
				status: result.session2.judge.status,
				error: result.session2.judge.error,
				attempts: result.session2.judge.attempts ?? null,
				elapsed_ms: result.session2.judge.elapsed_ms ?? null,
				verdict: result.session2.judge.parsed?.verdict ?? null,
				pass: result.session2.judge.pass,
				current_values_correct: result.session2.judge.parsed?.current_values_correct ?? null,
				stale_shown_as_current: result.session2.judge.parsed?.stale_shown_as_current ?? null,
				invented: result.session2.judge.parsed?.invented ?? null,
				dropped_stable: result.session2.judge.parsed?.dropped_stable ?? null,
				reasoning: result.session2.judge.parsed?.reasoning ?? null,
				raw_reply: result.session2.judge.raw_reply,
			})),
	});
	writeJson(join(runDir, "run.json"), {
		git_commit: gitCommit,
		pi_version: piVersion,
		harness_version: HARNESS_VERSION,
		variant: options.variant,
		provider: config.provider,
		agent_model: config.agent_model,
		agent_thinking: config.agent_thinking,
		agent_tools: { ...toolSummary, variant: options.variant },
		extension_model: config.extension_model,
		extension_thinking: config.extension_thinking,
		judge_model: config.judge_model,
		judge_thinking: config.judge_thinking,
		endpoint: config.endpoint,
		endpoint_host: new URL(config.endpoint).hostname,
		endpoint_port: new URL(config.endpoint).port,
		proxy_port: proxy.port,
		corpora: corpora.map((corpus) => corpus.name),
		repeat: options.repeat,
		started_at: startedAt,
		ended_at: endsAt,
		exit_code: aborted ? 3 : 0,
		aborted,
		budget: { ...budget },
		real_obelisk: {
			path: REAL_OBELISK,
			mtime_before: realObeliskBefore,
			mtime_after: realObeliskAfter,
			unchanged: obeliskUnchanged,
		},
		model_usage: proxy.stats,
		resolve_probe: probeRecords,
	});

	await proxy.close();

	for (const file of readdirSync(join(runDir, "decisions"))) {
		const path = join(runDir, "decisions", file);
		const records = readDecisions(path);
		writeFileSync(path, records.map((record) => JSON.stringify(redactValue(record))).join("\n") + (records.length > 0 ? "\n" : ""), "utf8");
	}

	printTable(metricsByCorpus, options.variant);
	console.log(`\nrun directory: ${runDir}`);
	console.log(`real Obelisk index unchanged: ${obeliskUnchanged}`);
	if (!obeliskUnchanged) {
		console.error("FATAL: the real Obelisk index mtime changed during the run");
		return 4;
	}
	if (aborted) {
		console.error(`run aborted by guardrail: ${budget.reason}`);
		return 3;
	}
	return 0;
}

function childFirstLine(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${command} failed`);
	return result.stdout.split("\n")[0].trim();
}

/**
 * The harness owns the process exit, and it is the only owner. `main` closes the
 * recording proxy, but a spawned pi or a lingering socket can still keep the
 * event loop alive long after `main` resolves; every artifact is written
 * synchronously, so the process ends here with the one code `main` computed.
 */
async function run() {
	let code = 2;
	try {
		code = await main();
	} catch (error) {
		console.error("live harness error:", error);
	}
	process.exit(code);
}

export {
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
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
	await run();
}
