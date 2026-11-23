import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codePointCount, nonWhitespaceCodePointCount } from "@vestigio/core";
import type { Memory, MemoryUri } from "@vestigio/core";
import { countSummaryJobs } from "@vestigio/core/jobs";
import type { HistoryHit, HistoryPort } from "@vestigio/core/retrieval";
import { layeredSearch } from "@vestigio/core/retrieval";
import type { ModelPort, ModelRequest } from "@vestigio/core/resolver";
import { openStore } from "@vestigio/core/storage";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { DecisionLog } from "../src/decision-log.js";
import { VestigioState } from "../src/state.js";
import { registerMemoryTools } from "../src/tools.js";

const AT = "2026-11-17T12:00:00.000Z";
const PROJECT = "p-stale";

type CapturedTool = {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	): Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
};

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeStore() {
	const dir = mkdtempSync(join(tmpdir(), "vestigio-stale-tools-"));
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

function memory(): Memory {
	const medium = body("把服务端口从 8080 改成 18080 时，部署脚本里的默认值也要一起改。");
	return {
		memory_id: "mem-deploy",
		uri: "memory://vestigio/mem-deploy",
		scope: { kind: "project", project_id: PROJECT },
		title: "部署脚本默认端口",
		keywords: ["部署", "端口"],
		revision: 1,
		state: "published",
		medium: {
			body: medium,
			body_char_count: nonWhitespaceCodePointCount(medium),
			sources: [
				{
					provider: "pi",
					source_instance: "session",
					session_id: "s-stale",
					message_id: "e-0",
					parent_message_id: null,
					project_id: PROJECT,
					timestamp: AT,
					content_hash: "sha256:00",
					locator: null,
				},
			],
		},
		nav: { text: "部署配置与默认端口，改端口前值得读取。", char_count: codePointCount("部署配置与默认端口，改端口前值得读取。"), source_revision: 1 },
		hit_count: 0,
		access_count: 0,
		last_access_at: null,
		created_at: AT,
		updated_at: AT,
	};
}

function makeEntry(id: string, text: string, parentId: string | null) {
	return {
		type: "message" as const,
		id,
		parentId,
		timestamp: AT,
		message: { role: "user", content: [{ type: "text", text }], timestamp: AT },
	};
}

function makeSessionManager(): { sessionManager: Record<string, unknown>; entries: ReturnType<typeof makeEntry>[] } {
	const entries = [
		makeEntry("e-1", "今天我们决定默认端口改成 18080，部署脚本已经同步。", null),
		makeEntry("e-2", "顺手修了 README 的一个错别字。", "e-1"),
		makeEntry("e-3", "回滚顺序改为先恢复镜像，再恢复配置。", "e-2"),
	];
	const sessionManager = {
		getSessionId: () => "s-stale",
		getBranch: () => entries,
		getEntries: () => entries,
		getSessionFile: () => "/tmp/vestigio-stale.jsonl",
		getLeafId: () => "e-3",
	};
	return { sessionManager, entries };
}

type Reply = { text: string } | { fail: "cancelled" | "unavailable" };

type ScriptedKind = "summary" | "judge" | "nav" | "other";

/**
 * Routes by the system prompt, like the core extraction tests: one port serves
 * the medium repair call, the retrieval judge and the nav call, and the test
 * can fail any of them alone.
 */
function scriptedModel(
	route: (kind: ScriptedKind, index: number, request: ModelRequest) => Reply,
) {
	const stats = {
		summary_calls: 0,
		judge_calls: 0,
		nav_calls: 0,
		requests: [] as ModelRequest[],
	};
	const port: ModelPort = {
		async complete(request) {
			stats.requests.push(request);
			const system = request.messages[0]?.content ?? "";
			const kind: ScriptedKind = system.includes("Decide whether the candidates")
				? "judge"
				: system.includes("You write one medium summary")
					? "summary"
					: system.includes("You write a navigation summary")
						? "nav"
						: "other";
			const index =
				kind === "summary"
					? stats.summary_calls
					: kind === "judge"
						? stats.judge_calls
						: kind === "nav"
							? stats.nav_calls
							: 0;
			if (kind === "summary") stats.summary_calls += 1;
			else if (kind === "judge") stats.judge_calls += 1;
			else if (kind === "nav") stats.nav_calls += 1;
			const reply = route(kind, index, request);
			if ("fail" in reply) return { ok: false, status: reply.fail, reason: "scripted" };
			return {
				ok: true,
				value: {
					text: reply.text,
					model: "scripted",
					finish_reason: "stop",
					usage: { tokens_in: 120, tokens_out: 30, cost_usd: 0.002 },
				},
			};
		},
	};
	return { port, stats };
}

function setup(options: { model?: ModelPort; history?: HistoryPort } = {}) {
	const { path, store } = makeStore();
	store.saveMemory(memory());
	store.upsertHotspotMembership({
		project_id: PROJECT,
		memory_id: "mem-deploy",
		admitted_seq: 1,
		last_hit_seq: 0,
		last_access_seq: 0,
		recent_hit_weight: 0,
		recent_access_weight: 0,
	});
	store.upsertProjectActivity({ project_id: PROJECT, activity_seq: 3, last_input_at: AT });
	const env =
		options.model === undefined
			? { VESTIGIO_STORE: path, VESTIGIO_PROJECT_ID: PROJECT }
			: {
					VESTIGIO_STORE: path,
					VESTIGIO_PROJECT_ID: PROJECT,
					VESTIGIO_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
					VESTIGIO_MODEL_ID: "scripted",
				};
	const state = new VestigioState(readConfig(env), new DecisionLog(null), {
		...(options.model === undefined ? {} : { create_model: () => options.model! }),
		...(options.history === undefined ? {} : { create_history: () => options.history! }),
	});
	const { sessionManager } = makeSessionManager();
	state.bindSession(sessionManager as never);
	const tools = new Map<string, CapturedTool>();
	registerMemoryTools({ registerTool: (tool: CapturedTool) => tools.set(tool.name, tool) } as never, state);
	const ctx = { cwd: "/tmp/vestigio-stale-cwd", sessionManager };
	return { store, state, tools, ctx, path };
}

async function markStale(tools: Map<string, CapturedTool>, ctx: unknown, overrides: Record<string, unknown> = {}) {
	return tools.get("memory_mark_stale")!.execute(
		"call-mark",
		{
			uri: "memory://vestigio/mem-deploy",
			observed_revision: 1,
			reason: "默认端口已从 8080 改为 18080",
			excerpt: "今天我们决定默认端口改成 18080。",
			source_message_ids: ["e-1"],
			...overrides,
		},
		undefined,
		undefined,
		ctx,
	);
}

describe("memory_mark_stale", () => {
	it("records one durable event anchored to a real session entry", async () => {
		const { store, tools, ctx } = setup();
		const result = await markStale(tools, ctx);
		expect(result.content[0]!.text).toContain("recorded");
		expect(result.details.inserted).toBe(true);
		const pending = store.listPendingStaleEvents("mem-deploy");
		expect(pending).toHaveLength(1);
		expect(pending[0]!.producer).toBe("agent");
		expect(pending[0]!.sources[0]!.message_id).toBe("e-1");
		expect(pending[0]!.sources[0]!.content_hash.startsWith("sha256:")).toBe(true);
		expect(pending[0]!.sources[0]!.locator).toBe("/tmp/vestigio-stale.jsonl#e-1");
		expect(store.readFreshness("memory://vestigio/mem-deploy")?.is_stale).toBe(true);
		store.close();
	});

	it("locates quoted evidence without caller-supplied ids and ignores abandoned branches", async () => {
		const { store, tools, ctx } = setup();
		const result = await markStale(tools, ctx, { source_message_ids: undefined, excerpt: "默认端口改成 18080" });
		expect(result.details.inserted).toBe(true);
		expect(store.listPendingStaleEvents("mem-deploy")[0]!.sources[0]!.message_id).toBe("e-1");
		const abandoned = await markStale(tools, { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [] } }, { reason: "another change" });
		expect(abandoned.content[0]!.text).toContain("rejected");
		expect(store.countPendingStaleEvents("mem-deploy")).toBe(1);
		store.close();
	});

	it("is idempotent for the same logical change", async () => {
		const { store, tools, ctx } = setup();
		await markStale(tools, ctx);
		const second = await markStale(tools, ctx);
		expect(second.content[0]!.text).toContain("already recorded");
		expect(store.listPendingStaleEvents("mem-deploy")).toHaveLength(1);
		store.close();
	});

	it("rejects a source id that is not a real session entry", async () => {
		const { store, tools, ctx } = setup();
		const result = await markStale(tools, ctx, { source_message_ids: ["made-up-id"] });
		expect(result.content[0]!.text).toContain("rejected");
		expect(store.listPendingStaleEvents("mem-deploy")).toHaveLength(0);
		store.close();
	});

	it("rejects a nonexistent memory without writing", async () => {
		const { store, tools, ctx } = setup();
		const result = await markStale(tools, ctx, { uri: "memory://vestigio/mem-missing" });
		expect(result.content[0]!.text).toContain("does not exist");
		expect(store.listPendingStaleEvents("mem-deploy")).toHaveLength(0);
		store.close();
	});

	it("rejects a reason whose value appears in no evidence text", async () => {
		const { store, tools, ctx } = setup();
		const result = await markStale(tools, ctx, { reason: "并发上限已降到 16" });
		expect(result.content[0]!.text).toContain("no evidence text contains any of them");
		expect(store.countPendingStaleEvents("mem-deploy")).toBe(0);
		store.close();
	});

	it("does not anchor a value that only appears inside a longer number", async () => {
		const { store, tools, ctx } = setup();
		const result = await markStale(tools, ctx, { reason: "默认端口已改为 1808" });
		expect(result.content[0]!.text).toContain("no evidence text contains any of them");
		expect(store.countPendingStaleEvents("mem-deploy")).toBe(0);
		store.close();
	});

	it("accepts the replaced value next to the carried one whatever the number format", async () => {
		const { store, tools, ctx } = setup();
		const result = await markStale(tools, ctx, { reason: "默认端口已从 9090 调整为 18,080" });
		expect(result.details.inserted).toBe(true);
		expect(store.countPendingStaleEvents("mem-deploy")).toBe(1);
		store.close();
	});

	it("accepts a qualitative reason with no value to anchor", async () => {
		const { store, tools, ctx } = setup();
		const result = await markStale(tools, ctx, {
			reason: "回滚顺序已经调整，摘要里的步骤需要更新",
			excerpt: "回滚顺序改为先恢复镜像，再恢复配置。",
			source_message_ids: ["e-3"],
		});
		expect(result.details.inserted).toBe(true);
		store.close();
	});
});

describe("memory_read freshness", () => {
	it("carries the stale warning and pending evidence after a mark", async () => {
		const { store, tools, ctx } = setup();
		await markStale(tools, ctx);
		const result = await tools
			.get("memory_read")!
			.execute("call-read", { uri: "memory://vestigio/mem-deploy" }, undefined, undefined, ctx);
		const text = result.content[0]!.text;
		expect(text).toContain("freshness: STALE pending=1");
		expect(text).toContain("repair: deferred (repaired when this session ends; 1 pending event(s))");
		expect(text).toContain("event ");
		expect(text).toContain("默认端口已从 8080 改为 18080");
		expect(text).toContain("sources: s-stale/e-1");
		expect(text).toContain("18080");
		store.close();
	});

	it("makes no model call when the memory is current", async () => {
		const model = scriptedModel(() => ({ text: "{}" }));
		const { store, tools, ctx } = setup({ model: model.port });
		const result = await tools
			.get("memory_read")!
			.execute("call-current", { uri: "memory://vestigio/mem-deploy" }, undefined, undefined, ctx);
		expect(result.content[0]!.text).toContain("revision=1");
		expect(model.stats.summary_calls).toBe(0);
		expect(model.stats.nav_calls).toBe(0);
		store.close();
	});

	it("shows the stale marker on a search card", async () => {
		const { store, tools, ctx } = setup();
		await markStale(tools, ctx);
		const result = await tools
			.get("memory_search")!
			.execute("call-search", { query: "部署 端口" }, undefined, undefined, ctx);
		expect(result.content[0]!.text).toContain("stale: 1 later evidence item(s) not absorbed");
		store.close();
	});
});

function judgeDecision(overrides: Record<string, unknown>): string {
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

function historyHit(): HistoryHit {
	return {
		source_ref: {
			provider: "pi",
			source_instance: "session",
			session_id: "s-stale-history",
			message_id: "h-rollback",
			parent_message_id: null,
			project_id: PROJECT,
			timestamp: AT,
			content_hash: "sha256:99",
			locator: "/tmp/vestigio-stale-history.jsonl#h-rollback",
		},
		text: body("回滚顺序改为先恢复镜像，再恢复配置；回滚前不再执行清理脚本。"),
		timestamp: AT,
		role: "user",
		evidence_complete: true,
		project_resolved: true,
	};
}

function fakeHistory(hit: HistoryHit): HistoryPort {
	return {
		async probe() {
			return { available: true, reason: null };
		},
		async search() {
			return { ok: true, value: { hits: [hit], evidence: "resolved", elapsed_ms: 1 } };
		},
		async readByAnchor() {
			return {
				ok: true,
				value: {
					anchor: hit.source_ref,
					messages: [{ source_ref: hit.source_ref, text: hit.text, role: hit.role }],
					has_more: false,
					elapsed_ms: 1,
				},
			};
		},
	};
}

async function findInStore(store: ReturnType<typeof makeStore>["store"], query: string) {
	const outcome = await layeredSearch({
		store,
		query,
		scope: { kind: "project", project_id: PROJECT },
		limit: 5,
	});
	return outcome.result.cards.map((card) => card.uri);
}

describe("memory_resolve publication", () => {
	it("publishes a memory it just saved so the next search finds it", async () => {
		let navStarted = 0;
		const model = scriptedModel((kind, index) => {
			if (kind === "judge") {
				return index === 2
					? {
							text: judgeDecision({
								sufficient: true,
								answer: "回滚顺序是先恢复镜像，再恢复配置。",
								evidence_ids: ["h-rollback"],
							}),
						}
					: { text: judgeDecision({ descend: true }) };
			}
			if (kind === "summary") {
				return { text: JSON.stringify({ body: body("回滚顺序改为先恢复镜像，再恢复配置。 [来源:e1]") }) };
			}
			navStarted = performance.now();
			return { text: JSON.stringify({ nav: "回滚顺序：先恢复镜像，再恢复配置。" }) };
		});
		const { store, tools, ctx } = setup({ model: model.port, history: fakeHistory(historyHit()) });

		const result = await tools
			.get("memory_resolve")!
			.execute("call-resolve-save", { question: "回滚顺序 镜像" }, undefined, undefined, ctx);
		const finishedAt = performance.now();
		const text = result.content[0]!.text;
		const uri = result.details.memory_uri as MemoryUri;
		const revision = result.details.revision as number;

		expect(uri).toMatch(/^memory:\/\//);
		const head = store.readMemory(uri, revision)!;
		expect(head.state).toBe("published");
		expect(head.nav?.source_revision).toBe(revision);
		expect(result.details.navigation_status).toBe("ready");
		expect(text).toContain("nav=");
		expect(text).not.toContain("nav=pending");
		expect(text).toContain("nav: 回滚顺序：先恢复镜像，再恢复配置。");
		expect(await findInStore(store, "回滚 镜像")).toContain(uri);
		expect(model.stats.nav_calls).toBe(1);
		// The publication step's share of the tool call: from the nav request to
		// the verified return. Bounded so a hung nav cannot hold the turn.
		expect(finishedAt - navStarted).toBeLessThan(5_000);
		store.close();
	});

	it("keeps the answer and reports nav_pending when the nav step returns unusable text", async () => {
		const model = scriptedModel((kind, index) => {
			if (kind === "judge") {
				return index === 2
					? {
							text: judgeDecision({
								sufficient: true,
								answer: "回滚顺序是先恢复镜像，再恢复配置。",
								evidence_ids: ["h-rollback"],
							}),
						}
					: { text: judgeDecision({ descend: true }) };
			}
			if (kind === "summary") {
				return { text: JSON.stringify({ body: body("回滚顺序改为先恢复镜像，再恢复配置。 [来源:e1]") }) };
			}
			return { text: "这不是 JSON，也没有 nav 字段。" };
		});
		const { store, tools, ctx } = setup({ model: model.port, history: fakeHistory(historyHit()) });

		const result = await tools
			.get("memory_resolve")!
			.execute("call-resolve-nav-fail", { question: "回滚顺序 镜像" }, undefined, undefined, ctx);
		const text = result.content[0]!.text;
		const uri = result.details.memory_uri as MemoryUri;

		expect(result.details.status).toBe("resolved");
		expect(result.details.persistence_status).toBe("saved");
		expect(result.details.navigation_status).toBe("pending");
		expect(text).toContain("nav pending: nav_not_generated");
		expect(text).toContain("回滚顺序");
		expect(text).toContain("answer:");
		const head = store.readMemory(uri)!;
		expect(head.state).toBe("medium_ready");
		expect(head.nav).toBeNull();
		expect(countSummaryJobs(store.database())).toBe(1);
		store.close();
	});

	it("does not publish when the resolve saves nothing", async () => {
		const model = scriptedModel((kind) => {
			expect(kind).toBe("judge");
			return {
				text: judgeDecision({
					sufficient: true,
					answer: "默认端口是 18080，部署脚本也要一起改。",
					evidence_ids: ["mem-deploy"],
				}),
			};
		});
		const { store, tools, ctx } = setup({ model: model.port });
		expect(countSummaryJobs(store.database())).toBe(0);

		const result = await tools
			.get("memory_resolve")!
			.execute("call-resolve-reuse", { question: "部署 端口" }, undefined, undefined, ctx);

		expect(result.details.persistence_status).toBe("not_attempted");
		expect(result.details.navigation_status).toBe("pending");
		expect(result.content[0]!.text).not.toContain("nav pending:");
		expect(model.stats.summary_calls).toBe(0);
		expect(model.stats.nav_calls).toBe(0);
		expect(model.stats.requests).toHaveLength(1);
		expect(countSummaryJobs(store.database())).toBe(0);
		store.close();
	});
});
