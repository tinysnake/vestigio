import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codePointCount, nonWhitespaceCodePointCount } from "@vestigio/core";
import type { Memory } from "@vestigio/core";
import type { ModelPort } from "@vestigio/core/resolver";
import { openStore } from "@vestigio/core/storage";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { DecisionLog } from "../src/decision-log.js";
import { VestigioState } from "../src/state.js";
import { buildDetectorCandidates, evidenceForDetector, runStaleDetector, stripInjectedNote } from "../src/stale-detector.js";

const AT = "2026-11-17T12:00:00.000Z";
const PROJECT = "p-detector";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeStore() {
	const dir = mkdtempSync(join(tmpdir(), "vestigio-detector-"));
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

function memory(memoryId: string, projectId: string): Memory {
	const medium = body(`关于 ${memoryId} 的当前结论，默认端口是 8080。`);
	const nav = `关于 ${memoryId} 的短摘要。`;
	return {
		memory_id: memoryId,
		uri: `memory://vestigio/${memoryId}`,
		scope: { kind: "project", project_id: projectId },
		title: `${memoryId} 记忆`,
		keywords: ["端口"],
		revision: 1,
		state: "published",
		medium: {
			body: medium,
			body_char_count: nonWhitespaceCodePointCount(medium),
			sources: [
				{
					provider: "pi",
					source_instance: "session",
					session_id: "s-detector",
					message_id: "orig-1",
					parent_message_id: null,
					project_id: projectId,
					timestamp: AT,
					content_hash: "sha256:orig",
					locator: null,
				},
			],
		},
		nav: { text: nav, char_count: codePointCount(nav), source_revision: 1 },
		hit_count: 0,
		access_count: 0,
		last_access_at: null,
		created_at: AT,
		updated_at: AT,
	};
}

function entry(id: string, text: string, parentId: string | null) {
	return {
		type: "message" as const,
		id,
		parentId,
		timestamp: AT,
		message: { role: "user", content: [{ type: "text", text }], timestamp: AT },
	};
}

function sessionManager(sessionId = "s-detector", entries: ReturnType<typeof entry>[] = []) {
	return {
		getSessionId: () => sessionId,
		getBranch: () => entries,
		getSessionFile: () => "/tmp/vestigio-detector.jsonl",
		getLeafId: () => entries[entries.length - 1]?.id ?? null,
	};
}

function finding(memoryId: string, evidenceId: string, reason = "默认端口已改为 18080"): string {
	return JSON.stringify({
		findings: [
			{ memory_id: memoryId, reason, excerpt: "我们决定把默认端口改成 18080。", evidence_ids: [evidenceId] },
		],
	});
}

function fakeModel(replies: readonly unknown[]): { port: ModelPort; requests: unknown[] } {
	const requests: unknown[] = [];
	let index = 0;
	const port: ModelPort = {
		async complete(request) {
			requests.push(request);
			const reply = replies[Math.min(index, replies.length - 1)] ?? JSON.stringify({ findings: [] });
			index += 1;
			if (typeof reply === "object" && reply !== null && "ok" in reply) return reply as never;
			return {
				ok: true,
				value: { text: String(reply), usage: { tokens_in: 50, tokens_out: 10, cost_usd: 0 }, model: "fake", finish_reason: "stop" },
			};
		},
	};
	return { port, requests };
}

function setup(options: { entries?: ReturnType<typeof entry>[]; memoryId?: string; projectId?: string } = {}) {
	const { path, store } = makeStore();
	const memoryId = options.memoryId ?? "mem-port";
	const projectId = options.projectId ?? PROJECT;
	store.saveMemory(memory(memoryId, projectId));
	const entries = options.entries ?? [
		entry("e-1", "今天我们决定默认端口改成 18080。", null),
		entry("e-2", "已同步部署脚本。", "e-1"),
	];
	const state = new VestigioState(readConfig({ VESTIGIO_STORE: path, VESTIGIO_PROJECT_ID: PROJECT }), new DecisionLog(null));
	state.bindSession(sessionManager("s-detector", entries) as never);
	state.noteMemorySeen(memoryId);
	return { path, store, state, entries, memoryId };
}

describe("runStaleDetector", () => {
	it("restores a durable checkpoint only from the active branch", async () => {
		const { store, state, entries } = setup();
		const checkpoint = { type: "custom", id: "checkpoint", parentId: "e-2", timestamp: AT, customType: "vestigio.detector-checkpoint", data: { entry_id: "e-2" } };
		const manager = { ...sessionManager("s-detector", entries), getBranch: () => [...entries, checkpoint] };
		state.bindSession(manager as never);
		expect(state.detectorCheckpointId).toBe("e-2");
		state.bindSession(sessionManager("s-detector", [entries[0]!]) as never);
		expect(state.detectorCheckpointId).toBeNull();
		store.close();
	});

	it("does not advance after invalid output so the evidence can be retried", async () => {
		const { store, state, entries } = setup();
		const invalid = '{"findings":[{"memory_id":"foreign"}]}';
		const model = fakeModel([invalid, invalid, finding("mem-port", "e-1")]);
		const input = { state, store, sessionManager: sessionManager("s-detector", entries) as never, cwd: PROJECT, model: model.port };
		expect((await runStaleDetector(input)).status).toBe("failed");
		expect(state.detectorCheckpointId).toBeNull();
		expect(model.requests).toHaveLength(2);
		expect((await runStaleDetector(input)).recorded).toBe(1);
		expect(model.requests).toHaveLength(3);
		store.close();
	});

	it("retries once when the detector response cannot be parsed", async () => {
		const { store, state, entries } = setup();
		const model = fakeModel([{ ok: false, status: "invalid_response", reason: "response has no string choices[0].message.content" }, finding("mem-port", "e-1")]);
		const result = await runStaleDetector({
			state,
			store,
			sessionManager: sessionManager("s-detector", entries) as never,
			cwd: "/tmp/detector-cwd",
			model: model.port,
		});
		expect(result.status).toBe("ok");
		expect(result.recorded).toBe(1);
		expect(model.requests).toHaveLength(2);
		expect(state.detectorCheckpointId).toBe("e-2");
		expect(store.countPendingStaleEvents("mem-port")).toBe(1);
		store.close();
	});

	it("does not retry a transport failure or a cancellation", async () => {
		const { store, state, entries } = setup();
		const model = fakeModel([{ ok: false, status: "failed", reason: "boom" }, finding("mem-port", "e-1")]);
		const result = await runStaleDetector({
			state,
			store,
			sessionManager: sessionManager("s-detector", entries) as never,
			cwd: "/tmp/detector-cwd",
			model: model.port,
		});
		expect(result.status).toBe("failed");
		expect(model.requests).toHaveLength(1);
		expect(state.detectorCheckpointId).toBeNull();
		store.close();
	});
	it("records a finding as a durable event anchored to the cited entry", async () => {
		const { store, state, entries } = setup();
		const model = fakeModel([finding("mem-port", "e-1")]);
		const result = await runStaleDetector({
			state,
			store,
			sessionManager: sessionManager("s-detector", entries) as never,
			cwd: "/tmp/detector-cwd",
			model: model.port,
		});
		expect(result.status).toBe("ok");
		expect(result.recorded).toBe(1);
		expect(model.requests).toHaveLength(1);
		const pending = store.listPendingStaleEvents("mem-port");
		expect(pending).toHaveLength(1);
		expect(pending[0]!.producer).toBe("detector");
		expect(pending[0]!.sources[0]!.message_id).toBe("e-1");
		expect(pending[0]!.sources[0]!.content_hash.startsWith("sha256:")).toBe(true);
		store.close();
	});

	it("does not run again for a checkpointed turn and makes no recursive call", async () => {
		const { store, state, entries } = setup();
		const model = fakeModel([finding("mem-port", "e-1"), finding("mem-port", "e-2")]);
		const first = await runStaleDetector({
			state,
			store,
			sessionManager: sessionManager("s-detector", entries) as never,
			cwd: "/tmp/detector-cwd",
			model: model.port,
		});
		expect(first.status).toBe("ok");
		const before = model.requests.length;
		const second = await runStaleDetector({
			state,
			store,
			sessionManager: sessionManager("s-detector", entries) as never,
			cwd: "/tmp/detector-cwd",
			model: model.port,
		});
		expect(second.status).toBe("skipped");
		expect(second.reason).toBe("no_new_entries");
		expect(model.requests.length).toBe(before);
		store.close();
	});

	it("keeps an already-stale memory eligible and passes its pending events to the model", async () => {
		const { store, state, entries } = setup();
		store.markStale({
			memory_id: "mem-port",
			observed_revision: 1,
			reason: "第一次改动",
			excerpt: "旧证据。",
			sources: [
				{
					provider: "pi",
					source_instance: "session",
					session_id: "s-detector",
					message_id: "e-1",
					parent_message_id: null,
					project_id: PROJECT,
					timestamp: AT,
					content_hash: "sha256:e1",
					locator: null,
				},
			],
			producer: "agent",
			at: AT,
			branch_ref: "root",
		});
		const candidates = buildDetectorCandidates(store, ["mem-port"], PROJECT);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]!.freshness.is_stale).toBe(true);
		expect(candidates[0]!.pending[0]!.reason).toBe("第一次改动");
		const model = fakeModel([finding("mem-port", "e-2", "第二次改动")]);
		const result = await runStaleDetector({
			state,
			store,
			sessionManager: sessionManager("s-detector", entries) as never,
			cwd: "/tmp/detector-cwd",
			model: model.port,
		});
		expect(result.recorded).toBe(1);
		expect(store.countPendingStaleEvents("mem-port")).toBe(2);
		const promptKey = JSON.stringify(model.requests[0]);
		expect(promptKey).toContain("第一次改动");
		store.close();
	});

	it("excludes memories from another project", () => {
		const { store, state } = setup({ projectId: "p-other" });
		expect(buildDetectorCandidates(store, ["mem-port"], PROJECT)).toHaveLength(0);
		expect(state.seenMemoryIds()).toEqual(["mem-port"]);
		store.close();
	});

	it("does not write when the session switches during the model call", async () => {
		const { store, state, entries } = setup();
		const other = sessionManager("s-other", []);
		const port: ModelPort = {
			async complete() {
				state.bindSession(other as never);
				return {
					ok: true,
					value: {
						text: finding("mem-port", "e-1"),
						usage: { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
						model: "fake",
						finish_reason: "stop",
					},
				};
			},
		};
		const result = await runStaleDetector({
			state,
			store,
			sessionManager: sessionManager("s-detector", entries) as never,
			cwd: "/tmp/detector-cwd",
			model: port,
		});
		expect(result.status).toBe("skipped");
		expect(result.reason).toBe("session_switched");
		expect(store.countPendingStaleEvents("mem-port")).toBe(0);
		store.close();
	});

	it("logs a model failure and retries later without corrupting the checkpoint", async () => {
		const { store, state, entries } = setup();
		const failing = fakeModel([{ ok: false, status: "failed", reason: "boom" }]);
		const first = await runStaleDetector({
			state,
			store,
			sessionManager: sessionManager("s-detector", entries) as never,
			cwd: "/tmp/detector-cwd",
			model: failing.port,
		});
		expect(first.status).toBe("failed");
		expect(store.countPendingStaleEvents("mem-port")).toBe(0);
		expect(state.detectorCheckpointId).toBeNull();
		const working = fakeModel([finding("mem-port", "e-1")]);
		const second = await runStaleDetector({
			state,
			store,
			sessionManager: sessionManager("s-detector", entries) as never,
			cwd: "/tmp/detector-cwd",
			model: working.port,
		});
		expect(second.status).toBe("ok");
		expect(store.countPendingStaleEvents("mem-port")).toBe(1);
		store.close();
	});

	it("does not call the model when none is configured", async () => {
		const { store, state, entries } = setup();
		const result = await runStaleDetector({
			state,
			store,
			sessionManager: sessionManager("s-detector", entries) as never,
			cwd: "/tmp/detector-cwd",
			model: null,
		});
		expect(result.status).toBe("skipped");
		expect(result.reason).toBe("no_model");
		store.close();
	});

	it("rejects an unknown memory id without writing", async () => {
		const { store, state, entries } = setup();
		const model = fakeModel([finding("mem-unknown", "e-1")]);
		const result = await runStaleDetector({
			state,
			store,
			sessionManager: sessionManager("s-detector", entries) as never,
			cwd: "/tmp/detector-cwd",
			model: model.port,
		});
		expect(result.detected).toBe(0);
		expect(store.countPendingStaleEvents("mem-port")).toBe(0);
		store.close();
	});
});

describe("evidence hygiene", () => {
	it("strips an injected memory note from a turn's text", () => {
		const raw = "帮我看看端口。\n<vestigio_memory_note>\n[1] 记忆 URI：memory://x/y\n</vestigio_memory_note>";
		expect(stripInjectedNote(raw)).toBe("帮我看看端口。\n");
	});

	it("never offers a control entry as evidence", () => {
		const control = {
			type: "custom_message" as const,
			id: "c-1",
			parentId: null,
			timestamp: AT,
			customType: "vestigio.injection-ledger",
			content: "ledger payload",
			display: true,
		};
		const rows = evidenceForDetector([control as never, entry("e-1", "真实内容。", null) as never], null, "s-detector", PROJECT);
		expect(rows.map((row) => row.evidence.id)).toEqual(["e-1"]);
	});
});
