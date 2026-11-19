/**
 * The `agent_end` background repair pass: the caller waits for nothing, so the
 * pass owns its own budget and consumes at most one attempt per pending set.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codePointCount, nonWhitespaceCodePointCount } from "@vestigio/core";
import type { Memory } from "@vestigio/core";
import type { ModelPort } from "@vestigio/core/resolver";
import { openStore } from "@vestigio/core/storage";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_REPAIR_MAX_MEMORIES, repairStaleMemoriesInBackground } from "../src/background-repair.js";
import { readConfig } from "../src/config.js";
import { DecisionLog } from "../src/decision-log.js";
import { VestigioState } from "../src/state.js";

const AT = "2026-11-17T12:00:00.000Z";
const PROJECT = "p-bg";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function body(prefix: string): string {
	let text = prefix;
	while (nonWhitespaceCodePointCount(text) < 600) {
		text += "本记忆记录了当时的结论、改动方式和验证办法，供后续同类工作参考。";
	}
	return text;
}

function memory(memoryId: string): Memory {
	const medium = body("把服务端口从 8080 改成 18080 时，部署脚本里的默认值也要一起改。");
	return {
		memory_id: memoryId,
		uri: `memory://vestigio/${memoryId}`,
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
					source_instance: "local",
					session_id: "s-bg",
					message_id: "m-0",
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

function setup(options: { model?: ModelPort; memoryIds?: readonly string[]; membership?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "vestigio-bg-"));
	const path = join(dir, "store.sqlite");
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const store = openStore({ path });
	const ids = options.memoryIds ?? ["mem-deploy"];
	for (const [index, memoryId] of ids.entries()) {
		store.saveMemory(memory(memoryId));
		if (options.membership === false) continue;
		store.upsertHotspotMembership({
			project_id: PROJECT,
			memory_id: memoryId,
			admitted_seq: index + 1,
			last_hit_seq: 0,
			last_access_seq: 0,
			recent_hit_weight: 0,
			recent_access_weight: 0,
		});
	}
	const env =
		options.model === undefined
			? { VESTIGIO_STORE: path, VESTIGIO_PROJECT_ID: PROJECT }
			: { VESTIGIO_STORE: path, VESTIGIO_PROJECT_ID: PROJECT, VESTIGIO_MODEL_BASE_URL: "http://127.0.0.1:9/v1" };
	const state = new VestigioState(readConfig(env), new DecisionLog(null), {
		...(options.model === undefined ? {} : { create_model: () => options.model! }),
	});
	return { store, state };
}

function markStale(store: ReturnType<typeof setup>["store"], memoryId: string, messageId: string): string {
	return store.markStale({
		memory_id: memoryId,
		observed_revision: 1,
		reason: "默认端口已从 8080 改为 18080",
		excerpt: "今天我们决定默认端口改成 18080。",
		sources: [
			{
				provider: "pi",
				source_instance: "local",
				session_id: "s-bg",
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
	const port: ModelPort = {
		async complete(request) {
			const system = request.messages[0]?.content ?? "";
			const text = system.includes("导航短摘要")
				? JSON.stringify({ nav: "部署脚本的默认端口已改为 18080。" })
				: JSON.stringify({ body: body(`默认端口现在是 18080。 [来源:${cited() ?? "unknown"}]`) });
			return { ok: true, value: { text, model: "scripted", finish_reason: "stop", usage: { tokens_in: 10, tokens_out: 10, cost_usd: 0 } } };
		},
	};
	return { port };
}

describe("repairStaleMemoriesInBackground", () => {
	it("skips every candidate when no model is configured", async () => {
		const { store, state } = setup({ memoryIds: ["mem-a", "mem-b"] });
		markStale(store, "mem-a", "m-a1");
		markStale(store, "mem-b", "m-b1");

		const report = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });

		expect(report.candidates).toBe(2);
		expect(report.attempted).toBe(0);
		expect(report.repaired).toBe(0);
		expect(report.deadline_exceeded).toBe(false);
		expect(report.entries.map((entry) => entry.status)).toEqual(["skipped", "skipped"]);
		expect(report.entries[0]!.reason).toContain("model_unavailable:");
		store.close();
	});

	it("repairs the stale memory and consumes its one attempt", async () => {
		let cited: string | null = null;
		const model = repairModel(() => cited);
		const { store, state } = setup({ model: model.port });
		cited = markStale(store, "mem-deploy", "m-9");

		const report = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });

		expect(report.candidates).toBe(1);
		expect(report.attempted).toBe(1);
		expect(report.repaired).toBe(1);
		expect(report.entries[0]).toEqual({
			memory_id: "mem-deploy",
			status: "repaired",
			revision: 2,
			reason: null,
			acknowledged_event_ids: [cited],
			elapsed_ms: expect.any(Number),
		});
		expect(store.readMemory("memory://vestigio/mem-deploy")?.revision).toBe(2);
		expect(store.countPendingStaleEvents("mem-deploy")).toBe(0);

		const again = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });
		expect(again.candidates).toBe(0);
		expect(again.attempted).toBe(0);
		store.close();
	});

	it("attempts a memory again when a later change arrives in the same session", async () => {
		let cited: string | null = null;
		const model = repairModel(() => cited);
		const { store, state } = setup({ model: model.port });
		cited = markStale(store, "mem-deploy", "m-9");
		const first = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });
		expect(first.repaired).toBe(1);

		cited = markStale(store, "mem-deploy", "m-10");
		const second = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });

		expect(second.candidates).toBe(1);
		expect(second.attempted).toBe(1);
		expect(second.repaired).toBe(1);
		expect(store.readMemory("memory://vestigio/mem-deploy")?.revision).toBe(3);
		expect(store.countPendingStaleEvents("mem-deploy")).toBe(0);
		store.close();
	});

	it("repairs a memory the session saw even when no hotspot lists it", async () => {
		let cited: string | null = null;
		const model = repairModel(() => cited);
		const { store, state } = setup({ model: model.port, membership: false });
		cited = markStale(store, "mem-deploy", "m-11");

		const unseen = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });
		expect(unseen.candidates).toBe(0);

		state.noteMemorySeen("mem-deploy");
		const report = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });

		expect(report.candidates).toBe(1);
		expect(report.repaired).toBe(1);
		expect(store.countPendingStaleEvents("mem-deploy")).toBe(0);
		store.close();
	});

	it("caps the pass at the configured number of memories", async () => {
		const { store, state } = setup({ memoryIds: ["mem-a", "mem-b", "mem-c", "mem-d"] });
		for (const [index, memoryId] of ["mem-a", "mem-b", "mem-c", "mem-d"].entries()) {
			markStale(store, memoryId, `m-${index}`);
		}

		const report = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });

		expect(report.candidates).toBe(BACKGROUND_REPAIR_MAX_MEMORIES);
		expect(report.entries).toHaveLength(BACKGROUND_REPAIR_MAX_MEMORIES);
		store.close();
	});
});
