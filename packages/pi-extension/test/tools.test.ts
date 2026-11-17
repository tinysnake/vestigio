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
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { DecisionLog } from "../src/decision-log.js";
import { VestigioState } from "../src/state.js";
import { registerMemoryTools } from "../src/tools.js";

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

function setup() {
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
		readConfig({ VESTIGIO_STORE: path, VESTIGIO_PROJECT_ID: PROJECT }),
		new DecisionLog(null),
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

	it("reports no match without writing a hit", async () => {
		const { store, tools, ctx } = setup();
		const result = await tools.get("memory_search")!.execute("call-2", { query: "量子力学" }, undefined, undefined, ctx);
		expect(result.content[0]!.text).toContain("(no matching memory)");
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
});
