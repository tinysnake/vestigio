import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nonWhitespaceCodePointCount } from "@vestigio/core";
import type { ModelPort, ModelRequest } from "@vestigio/core/resolver";
import { openStore } from "@vestigio/core/storage";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { DecisionLog } from "../src/decision-log.js";
import { processMemoryRequests } from "../src/request-background.js";
import { registerRequestTools } from "../src/request-tools.js";
import { classifySaveDirective } from "../src/request-consent.js";
import { VestigioState } from "../src/state.js";

const AT = "2026-11-19T12:00:00.000Z";
const PROJECT = "p-requests";

type CapturedTool = {
	name: string;
	description: string;
	parameters: { properties?: Record<string, unknown> };
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
	const dir = mkdtempSync(join(tmpdir(), "vestigio-request-tools-"));
	const path = join(dir, "store.sqlite");
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return { path, store: openStore({ path }) };
}

function makeEntry(id: string, text: string, parentId: string | null, role = "user") {
	return {
		type: "message" as const,
		id,
		parentId,
		timestamp: AT,
		message: { role, content: [{ type: "text", text }], timestamp: AT },
	};
}

function body(prefix: string): string {
	let text = prefix;
	while (nonWhitespaceCodePointCount(text) < 600) {
		text += "本记忆记录了当时的结论、适用范围和验证办法，供后续同类工作参考。";
	}
	return text;
}

type Reply = { text: string } | { fail: "cancelled" | "unavailable" };

function scriptedModel(route: (kind: "summary" | "nav" | "other") => Reply) {
	const stats = { summary_calls: 0, nav_calls: 0, requests: [] as ModelRequest[] };
	const port: ModelPort = {
		async complete(request) {
			stats.requests.push(request);
			const system = request.messages[0]?.content ?? "";
			const kind = system.includes("中期摘要")
				? "summary"
				: system.includes("导航短摘要")
					? "nav"
					: "other";
			if (kind === "summary") stats.summary_calls += 1;
			if (kind === "nav") stats.nav_calls += 1;
			const reply = route(kind);
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

function setup(options: {
	entries?: ReturnType<typeof makeEntry>[];
	input?: string;
	model?: ModelPort;
} = {}) {
	const { path, store } = makeStore();
	const input = options.input ?? "记住：项目统一使用 pnpm，不要用 npm";
	const entries = options.entries ?? [makeEntry("e-10", input, null)];
	const sessionManager = {
		getSessionId: () => "s-requests",
		getBranch: () => entries,
		getEntries: () => entries,
		getSessionFile: () => "/tmp/vestigio-requests.jsonl",
		getLeafId: () => entries.at(-1)?.id ?? null,
	};
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
	});
	state.bindSession(sessionManager as never);
	state.noteUserInput(input);
	const ctx = {
		cwd: "/tmp/vestigio-requests-cwd",
		sessionManager,
	};
	const tools = new Map<string, CapturedTool>();
	registerRequestTools({ registerTool: (tool: CapturedTool) => tools.set(tool.name, tool) } as never, state);
	return { path, store, state, entries, tools, ctx };
}

async function write(
	tools: Map<string, CapturedTool>,
	ctx: unknown,
	params: Record<string, unknown> = {},
) {
	return tools.get("memory_request_write")!.execute(
		"call-write",
		{
			intent: "项目统一使用 pnpm，不要用 npm",
			...params,
		},
		undefined,
		undefined,
		ctx,
	);
}

describe("memory_request_write", () => {
	it("accepts an explicit save command in the same turn, with no question", async () => {
		const { store, tools, ctx } = setup();
		const result = await write(tools, ctx);
		expect(result.details.status).toBe("accepted");
		expect(result.details).not.toHaveProperty("question");
		expect(result.content[0]!.text).toContain("accepted");
		expect(result.content[0]!.text).toContain("Not saved yet");
		expect(result.content[0]!.text).not.toContain("Append the question");
		const rows = store.listMemoryRequests();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("pending");
		expect(rows[0]!.evidence.map((entry) => entry.source.message_id)).toEqual(["e-10"]);
		store.close();
	});

	it("accepts a proactive call the operator agreed to, with no question in the response", async () => {
		// The turn produced a durable conclusion; the operator's next message
		// agreed. The tool itself only records a pending request.
		const { store, tools, ctx } = setup({ input: "以后发布前先跑测试" });
		const result = await write(tools, ctx, { intent: "发布前必须先运行完整测试" });
		expect(result.details.status).toBe("accepted");
		expect(result.details).not.toHaveProperty("question");
		expect(result.content[0]!.text).not.toContain("Append the question");
		const rows = store.listMemoryRequests();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("pending");
		expect(rows[0]!.evidence.map((entry) => entry.source.message_id)).toEqual(["e-10"]);
		store.close();
	});

	it("returns the same row when the same scope, intent and evidence are requested twice", async () => {
		const { store, tools, ctx } = setup();
		const first = await write(tools, ctx);
		const second = await write(tools, ctx);
		expect(second.details.request_id).toBe(first.details.request_id);
		expect(second.content[0]!.text).toContain("already recorded");
		expect(store.listMemoryRequests()).toHaveLength(1);
		store.close();
	});

	it("refuses a session-only preference as temporary_not_durable", async () => {
		const { store, state, tools, ctx } = setup({ input: "这次先记住：发布脚本可以跳过测试" });
		state.noteUserInput("这次先记住：发布脚本可以跳过测试");
		const result = await write(tools, ctx, { intent: "发布脚本可以跳过测试" });
		expect(result.details.status).toBe("rejected");
		expect(result.details.reason).toBe("temporary_not_durable");
		expect(store.listMemoryRequests()).toHaveLength(0);
		store.close();
	});

	it("refuses a negated save", async () => {
		const { store, state, tools, ctx } = setup({ input: "不要记住这个决定。" });
		state.noteUserInput("不要记住这个决定。");
		const result = await write(tools, ctx, { intent: "项目统一使用 pnpm" });
		expect(result.details.status).toBe("rejected");
		expect(result.details.reason).toBe("operator_declined");
		expect(store.listMemoryRequests()).toHaveLength(0);
		store.close();
	});

	it("refuses invented evidence and never exposes a confirmed flag", async () => {
		const { store, tools, ctx } = setup();
		const tool = tools.get("memory_request_write")!;
		expect(tool.parameters.properties).not.toHaveProperty("confirmed");
		expect(tool.parameters.properties).not.toHaveProperty("status");
		const result = await write(tools, ctx, { source_message_ids: ["made-up"] });
		expect(result.details.status).toBe("rejected");
		expect(result.details.reason).toContain("unknown_or_future_source");
		expect(store.listMemoryRequests()).toHaveLength(0);
		store.close();
	});

	it("does not let a quote resolve outside the operator's own user entries", async () => {
		const entries = [
			makeEntry("e-10", "记住这个", null),
			makeEntry(
				"e-11",
				'tool_call memory_request_write {"intent":"部署脚本默认端口改为 18080"}',
				"e-10",
				"assistant",
			),
		];
		const { store, tools, ctx } = setup({ entries, input: "记住这个" });
		const result = await write(tools, ctx, {
			intent: "部署脚本默认端口改为 18080",
			quotes: ["部署脚本默认端口改为 18080"],
		});
		expect(result.details.status).toBe("rejected");
		expect(result.details.reason).toBe("quote_not_found_in_branch");
		expect(store.listMemoryRequests()).toHaveLength(0);
		store.close();
	});

	it("does not treat the injected memory note as operator evidence", async () => {
		const input = [
			"记住这个",
			"",
			"<vestigio_memory_note>",
			"部署脚本默认端口改为 18080",
			"</vestigio_memory_note>",
		].join("\n");
		const { store, tools, ctx } = setup({ input });
		const result = await write(tools, ctx, {
			intent: "部署脚本默认端口改为 18080",
			quotes: ["部署脚本默认端口改为 18080"],
		});
		expect(result.details.status).toBe("rejected");
		expect(result.details.reason).toBe("quote_not_found_in_branch");
		expect(store.listMemoryRequests()).toHaveLength(0);
		store.close();
	});

	it("reports the pending row and then the saved URI through the status tool", async () => {
		const { store, tools, ctx } = setup();
		await write(tools, ctx);
		const statusTool = tools.get("memory_request_status")!;
		expect(statusTool.description).not.toContain("human-confirmed");
		const pending = await statusTool.execute("call-status", {}, undefined, undefined, ctx);
		expect(pending.content[0]!.text).toContain("[pending]");
		const row = store.listMemoryRequests()[0]!;
		store.completeMemoryRequest({
			request_id: row.request_id,
			outcome: "saved",
			memory_uri: "memory://vestigio/mem-request",
			revision: 1,
			navigation_status: "ready",
			at: AT,
		});
		const saved = await statusTool.execute(
			"call-status",
			{ request_id: row.request_id },
			undefined,
			undefined,
			ctx,
		);
		expect(saved.content[0]!.text).toContain("[saved]");
		expect(saved.content[0]!.text).toContain("memory://vestigio/mem-request r1 nav=ready");
		expect(saved.details.requests).toHaveLength(1);
		store.close();
	});
});

describe("classifySaveDirective", () => {
	it("does not treat a negated temporary phrase as session-only", () => {
		expect(classifySaveDirective("记住：这不是临时方案，是项目的长期约定。").kind).toBe("self_contained");
		expect(classifySaveDirective("记住：这次先这样做，之后再说。").kind).toBe("temporary");
	});
});

describe("bounded request background", () => {
	it("composes, publishes navigation, and records a proactive request as saved", async () => {
		const model = scriptedModel((kind) =>
			kind === "summary"
				? { text: JSON.stringify({ body: body("项目统一使用 pnpm 安装依赖，不使用 npm。 [来源:e-10]") }) }
				: kind === "nav"
					? { text: JSON.stringify({ nav: "包管理器约定：项目使用 pnpm。" }) }
					: { text: "{}" },
		);
		const { store, state, tools, ctx } = setup({ input: "以后发布前先跑测试", model: model.port });
		const accepted = await write(tools, ctx, { intent: "发布前必须先运行完整测试" });
		expect(accepted.details.status).toBe("accepted");
		const report = await processMemoryRequests({
			state,
			store,
			model: model.port,
			model_id: "scripted",
			project: PROJECT,
			at: AT,
		});
		expect(report.claimed).toBe(1);
		expect(report.saved).toBe(1);
		const request = store.readMemoryRequest(accepted.details.request_id as string)!;
		expect(request.status).toBe("saved");
		expect(request.memory_uri).not.toBeNull();
		expect(request.revision).toBe(1);
		expect(request.navigation_status).toBe("ready");
		const memory = store.readMemory(request.memory_uri!);
		expect(memory?.state).toBe("published");
		expect(memory?.nav?.text).toContain("pnpm");
		store.close();
	});
});
