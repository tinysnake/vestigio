/**
 * Tool-surface tests: `memory_search` runs the layered base search and
 * `memory_read` returns one full medium summary by URI, and both keep the store
 * statistics honest (a search is a hit, a completed read is an access).
 *
 * The tools are captured through a stub `ExtensionAPI`, so the tests exercise
 * the real handler bodies against a real temporary store — nothing is mocked
 * except the host's registration surface.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codePointCount, nonWhitespaceCodePointCount } from "@vestigio/core";
import type { Memory } from "@vestigio/core";
import { openStore } from "@vestigio/core/storage";
import type { HistoryPort } from "@vestigio/core/retrieval";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { DecisionLog } from "../src/decision-log.js";
import { VestigioState, type StateDeps } from "../src/state.js";
import { registerMemoryTools } from "../src/tools.js";
import type { ModelPort } from "@vestigio/core/resolver";

const AT = "2026-11-17T12:00:00.000Z";
const PROJECT = "p-tools";

type CapturedTool = {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	): Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
};

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeStore() {
	const dir = mkdtempSync(join(tmpdir(), "vestigio-tools-"));
	const path = join(dir, "store.sqlite");
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return { path, store: openStore({ path }) };
}

function body(prefix: string): string {
	let text = prefix;
	while (nonWhitespaceCodePointCount(text) < 600) {
		text += "本记忆记录了当时的结论、改动方式和验证办法，供后续同类工作参考。";
	}
	return text;
}

function markStale(store: ReturnType<typeof makeStore>["store"], messageId = "m-2"): string {
	return store.markStale({
		memory_id: "mem-deploy",
		observed_revision: 1,
		reason: "默认端口已从 8080 改为 18080",
		excerpt: "今天我们决定默认端口改成 18080。",
		sources: [
			{
				provider: "pi",
				source_instance: "local",
				session_id: "s-tools",
				message_id: messageId,
				parent_message_id: null,
				project_id: PROJECT,
				timestamp: AT,
				content_hash: "sha256:02",
				locator: null,
			},
		],
		producer: "detector",
		at: AT,
	}).event.event_id;
}

function repairModel(cited: () => string | null) {
	let calls = 0;
	const port: ModelPort = {
		async complete(request) {
			calls += 1;
			const system = request.messages[0]?.content ?? "";
			const text = system.includes("导航短摘要")
				? JSON.stringify({ nav: "部署脚本的默认端口已改为 18080。" })
				: JSON.stringify({ body: body(`默认端口现在是 18080。 [来源:${cited() ?? "unknown"}]`) });
			return {
				ok: true,
				value: { text, model: "scripted", finish_reason: "stop", usage: { tokens_in: 10, tokens_out: 10, cost_usd: 0 } },
			};
		},
	};
	return { port, calls: () => calls };
}

function memory(overrides: { memory_id: string; title: string; keywords: string[]; nav: string; prefix: string }): Memory {
	const medium = body(overrides.prefix);
	return {
		memory_id: overrides.memory_id,
		uri: `memory://vestigio/${overrides.memory_id}`,
		scope: { kind: "project", project_id: PROJECT },
		title: overrides.title,
		keywords: overrides.keywords,
		revision: 1,
		state: "published",
		medium: {
			body: medium,
			body_char_count: nonWhitespaceCodePointCount(medium),
			sources: [
				{
					provider: "pi",
					source_instance: "local",
					session_id: "s-tools",
					message_id: "m-1",
					parent_message_id: null,
					project_id: PROJECT,
					timestamp: AT,
					content_hash: "sha256:00",
					locator: null,
				},
			],
		},
		nav: { text: overrides.nav, char_count: codePointCount(overrides.nav), source_revision: 1 },
		hit_count: 0,
		access_count: 0,
		last_access_at: null,
		created_at: AT,
		updated_at: AT,
	};
}

function capture(tools: Map<string, CapturedTool>) {
	const pi = {
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
	};
	return pi;
}

function setup(options: { deps?: StateDeps; env?: Record<string, string | undefined> } = {}) {
	const { path, store } = makeStore();
	store.saveMemory(
		memory({
			memory_id: "mem-deploy",
			title: "部署脚本默认端口",
			keywords: ["部署", "端口"],
			nav: "部署配置与默认端口，改端口前值得读取。",
			prefix: "把服务端口从 8080 改成 18080 时，部署脚本里的默认值也要一起改。",
		}),
	);
	store.upsertHotspotMembership({
		project_id: PROJECT,
		memory_id: "mem-deploy",
		admitted_seq: 1,
		last_hit_seq: 0,
		last_access_seq: 0,
		recent_hit_weight: 0,
		recent_access_weight: 0,
	});
	store.upsertProjectActivity({ project_id: PROJECT, activity_seq: 7, last_input_at: AT });
	const state = new VestigioState(
		readConfig({ VESTIGIO_STORE: path, VESTIGIO_PROJECT_ID: PROJECT, ...options.env }),
		new DecisionLog(null),
		options.deps,
	);
	const tools = new Map<string, CapturedTool>();
	registerMemoryTools(capture(tools) as never, state);
	const ctx = { cwd: "/tmp/vestigio-tools-cwd" };
	return { store, state, tools, ctx };
}

describe("memory_search", () => {
	it("returns a bounded card with the URI and short summary", async () => {
		const { store, tools, ctx } = setup();
		const tool = tools.get("memory_search");
		expect(tool).toBeDefined();
		const result = await tool!.execute("call-1", { query: "部署 端口" }, undefined, undefined, ctx);
		const text = result.content[0]!.text;
		expect(text).toContain("memory://vestigio/mem-deploy");
		expect(text).toContain("部署脚本默认端口");
		expect(text).toContain("部署配置与默认端口");
		expect(result.details.status).toBe("partial");
		// A returned card counts as a hit; the medium body never appears.
		expect(store.countUsageEvents()).toBe(1);
		expect(text).not.toContain("18080");
		store.close();
	});

	it("searches the indexed sessions unless the caller turns the layer off", async () => {
		let searches = 0;
		const history: HistoryPort = {
			async probe() {
				return { available: true, reason: null };
			},
			async search() {
				searches += 1;
				return { ok: true, value: { hits: [], evidence: "resolved", elapsed_ms: 1 } };
			},
			async readByAnchor() {
				return { ok: false, status: "failed", reason: "not used by search" };
			},
		};
		const { store, tools, ctx } = setup({ deps: { create_history: () => history } });
		await tools.get("memory_search")!.execute("call-h1", { query: "部署 端口" }, undefined, undefined, ctx);
		expect(searches).toBe(1);
		await tools.get("memory_search")!.execute("call-h2", { query: "部署 端口", include_history: false }, undefined, undefined, ctx);
		expect(searches).toBe(1);
		store.close();
	});

	it("reports no match without writing a hit", async () => {
		const { store, tools, ctx } = setup();
		const result = await tools.get("memory_search")!.execute("call-2", { query: "量子力学" }, undefined, undefined, ctx);
		expect(result.content[0]!.text).toContain("(no matching memory)");
		expect(result.content[0]!.text).toContain("Retry with 1-3 words");
		expect(store.countUsageEvents()).toBe(0);
		store.close();
	});
});

describe("memory_read", () => {
	it("returns the full medium summary and records one access", async () => {
		const { store, tools, ctx } = setup();
		const result = await tools.get("memory_read")!.execute(
			"call-3",
			{ uri: "memory://vestigio/mem-deploy" },
			undefined,
			undefined,
			ctx,
		);
		const text = result.content[0]!.text;
		expect(result.details.status).toBe("resolved");
		expect(text).toContain("long summary:");
		expect(text).toContain("18080");
		const head = store.readMemory("memory://vestigio/mem-deploy");
		expect(head?.access_count).toBe(1);
		expect(head?.last_access_at).not.toBeNull();
		expect(store.readHotspotMemberships(PROJECT)[0]?.last_access_seq).toBe(7);
		store.close();
	});

	it("does not record an access for an unknown URI", async () => {
		const { store, tools, ctx } = setup();
		const result = await tools.get("memory_read")!.execute(
			"call-4",
			{ uri: "memory://vestigio/mem-missing" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details.status).toBe("not_found");
		expect(store.countUsageEvents()).toBe(0);
		store.close();
	});

	it("refuses a URI from another store", async () => {
		const { store, tools, ctx } = setup();
		const result = await tools.get("memory_read")!.execute(
			"call-5",
			{ uri: "memory://other-store/mem-deploy" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.content[0]!.text).toContain("belongs to store other-store");
		store.close();
	});

	it("rejects a malformed URI", async () => {
		const { store, tools, ctx } = setup();
		const result = await tools.get("memory_read")!.execute("call-6", { uri: "not-a-uri" }, undefined, undefined, ctx);
		expect(result.content[0]!.text).toContain("rejected the URI");
		store.close();
	});

	it("reports unavailable when no store is configured", async () => {
		const state = new VestigioState(readConfig({}), new DecisionLog(null));
		const tools = new Map<string, CapturedTool>();
		registerMemoryTools(capture(tools) as never, state);
		const result = await tools
			.get("memory_read")!
			.execute("call-7", { uri: "memory://vestigio/mem-deploy" }, undefined, undefined, { cwd: "/tmp" });
		expect(result.content[0]!.text).toContain("unavailable");
	});

	it("defers a stale repair without a model call or write", async () => {
		const model = repairModel(() => null);
		const { store, tools, ctx } = setup({
			deps: { create_model: () => model.port },
			env: { VESTIGIO_MODEL_BASE_URL: "http://127.0.0.1:9/v1" },
		});
		markStale(store);
		const result = await tools
			.get("memory_read")!
			.execute("call-defer", { uri: "memory://vestigio/mem-deploy" }, undefined, undefined, ctx);
		const text = result.content[0]!.text;
		expect(text).toContain("repair: deferred (repaired when this session ends; 1 pending event(s))");
		expect(text).toContain("freshness: STALE pending=1");
		expect(model.calls()).toBe(0);
		expect(store.readMemory("memory://vestigio/mem-deploy")?.revision).toBe(1);
		expect(store.countPendingStaleEvents("mem-deploy")).toBe(1);
		store.close();
	});
});

function fakeModel(replies: readonly string[]): { port: ModelPort; requests: unknown[] } {
	const requests: unknown[] = [];
	let index = 0;
	const port: ModelPort = {
		async complete(request) {
			requests.push(request);
			const text = replies[Math.min(index, replies.length - 1)] ?? "";
			index += 1;
			return {
				ok: true,
				value: {
					text,
					usage: { tokens_in: 100, tokens_out: 20, cost_usd: 0.0001 },
					model: "fake",
					finish_reason: "stop",
				},
			};
		},
	};
	return { port, requests };
}

function decision(overrides: Record<string, unknown>): string {
	return JSON.stringify({
		sufficient: false,
		answer: null,
		evidence_ids: [],
		read_uris: [],
		next_queries: [],
		conflicts: [],
		descend: false,
		...overrides,
	});
}

describe("memory_resolve", () => {
	it("answers from Active without descending or touching history", async () => {
		const model = fakeModel([
			decision({ sufficient: true, answer: "默认端口是 18080，部署脚本也要一起改。", evidence_ids: ["mem-deploy"] }),
		]);
		const { store, state, tools, ctx } = setup({
			deps: { create_model: () => model.port },
			env: { VESTIGIO_MODEL_BASE_URL: "http://127.0.0.1:9/v1" },
		});
		const result = await tools
			.get("memory_resolve")!
			.execute("call-r1", { question: "部署 端口" }, undefined, undefined, ctx);
		const text = result.content[0]!.text;
		expect(result.details.status).toBe("resolved");
		expect(text).toContain("-> resolved");
		expect(text).toContain("18080");
		expect(text).toContain("active=matched");
		expect(text).toContain("history=skipped");
		expect(result.details.degraded).toBe(false);
		expect((result.details.measured as { model_calls: number }).model_calls).toBe(1);
		// The returned card is a hit, exactly like memory_search.
		expect(store.countUsageEvents()).toBe(1);
		expect(state.resolveCountUsed()).toBe(1);
		store.close();
	});

	it("degrades to the zero-LLM layered search when no backend is configured", async () => {
		const { store, tools, ctx } = setup();
		const result = await tools
			.get("memory_resolve")!
			.execute("call-r2", { question: "部署 端口" }, undefined, undefined, ctx);
		const text = result.content[0]!.text;
		expect(result.details.degraded).toBe(true);
		expect(text).toContain("degraded: zero-LLM layered search");
		expect(text).toContain("VESTIGIO_MODEL_BASE_URL");
		expect(store.countUsageEvents()).toBe(1);
		store.close();
	});

	it("reports a stated gap instead of prose when the model declines to answer", async () => {
		const model = fakeModel([decision({ sufficient: false, descend: false })]);
		const { store, tools, ctx } = setup({
			deps: { create_model: () => model.port },
			env: { VESTIGIO_MODEL_BASE_URL: "http://127.0.0.1:9/v1" },
		});
		const result = await tools
			.get("memory_resolve")!
			.execute("call-r3", { question: "部署 端口" }, undefined, undefined, ctx);
		const text = result.content[0]!.text;
		expect(result.details.status).not.toBe("resolved");
		expect(text).toContain("missing:");
		expect(text).not.toContain("answer:");
		expect(store.countUsageEvents()).toBe(1);
		store.close();
	});
});
