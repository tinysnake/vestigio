/**
 * The `agent_end` background repair pass: the caller waits for nothing, so the
 * pass owns one budget for the whole run and gives each memory its own deadline.
 * A failed or deadline-killed attempt is retried up to
 * `BACKGROUND_REPAIR_MAX_ATTEMPTS`; a success is never retried and a memory
 * that runs out of attempts is reported, not dropped.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codePointCount, nonWhitespaceCodePointCount } from "@vestigio/core";
import type { Memory } from "@vestigio/core";
import type { ModelPort, ModelResult } from "@vestigio/core/resolver";
import { openStore } from "@vestigio/core/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
	BACKGROUND_REPAIR_MAX_ATTEMPTS,
	BACKGROUND_REPAIR_MAX_MEMORIES,
	BACKGROUND_REPAIR_TOTAL_MS,
	repairStaleMemoriesInBackground,
} from "../src/background-repair.js";
import { readConfig } from "../src/config.js";
import { DecisionLog } from "../src/decision-log.js";
import { REPAIR_DEADLINE_MS } from "../src/read-repair.js";
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

type ModelMode = "ok" | "fail" | "fail_then_ok" | "hang" | "nav_bad";

function repairModel(cited: () => string | null, mode: ModelMode = "ok") {
	const counters = { summary_calls: 0, nav_calls: 0 };
	const port: ModelPort = {
		async complete(request): Promise<ModelResult> {
			const system = request.messages[0]?.content ?? "";
			if (system.includes("You write a navigation summary")) {
				counters.nav_calls += 1;
				if (mode === "nav_bad") {
					return { ok: true, value: { text: "不是 JSON", model: "scripted", finish_reason: "stop", usage: { tokens_in: 10, tokens_out: 10, cost_usd: 0 } } };
				}
				return { ok: true, value: { text: JSON.stringify({ nav: "部署脚本的默认端口已改为 18080。" }), model: "scripted", finish_reason: "stop", usage: { tokens_in: 10, tokens_out: 10, cost_usd: 0 } } };
			}
			counters.summary_calls += 1;
			if (mode === "fail" || (mode === "fail_then_ok" && counters.summary_calls === 1)) {
				return { ok: false, status: "failed", reason: "down" };
			}
			if (mode === "hang") {
				return await new Promise<ModelResult>((resolve) => {
					request.signal.addEventListener("abort", () =>
						resolve({ ok: false, status: "cancelled", reason: "deadline" }),
					);
				});
			}
			return { ok: true, value: { text: JSON.stringify({ body: body(`默认端口现在是 18080。 [来源:${cited() ?? "unknown"}]`) }), model: "scripted", finish_reason: "stop", usage: { tokens_in: 10, tokens_out: 10, cost_usd: 0 } } };
		},
	};
	return { port, counters };
}

describe("repairStaleMemoriesInBackground", () => {
	it("names the per-memory and per-pass budgets", () => {
		expect(REPAIR_DEADLINE_MS).toBe(150_000);
		expect(BACKGROUND_REPAIR_TOTAL_MS).toBe(300_000);
		expect(BACKGROUND_REPAIR_MAX_ATTEMPTS).toBe(2);
	});

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
		expect(report.entries[0]!.attempts).toBe(0);
		store.close();
	});

	it("repairs the stale memory in one attempt and does not retry a success", async () => {
		let cited: string | null = null;
		const model = repairModel(() => cited);
		const { store, state } = setup({ model: model.port });
		cited = markStale(store, "mem-deploy", "m-9");

		const report = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });

		expect(report.candidates).toBe(1);
		expect(report.attempted).toBe(1);
		expect(report.repaired).toBe(1);
		expect(model.counters.summary_calls).toBe(1);
		expect(report.entries[0]).toEqual({
			memory_id: "mem-deploy",
			status: "repaired",
			revision: 2,
			reason: null,
			acknowledged_event_ids: [cited],
			elapsed_ms: expect.any(Number),
			attempts: 1,
		});
		expect(store.readMemory("memory://vestigio/mem-deploy")?.revision).toBe(2);
		expect(store.countPendingStaleEvents("mem-deploy")).toBe(0);

		const again = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });
		expect(again.candidates).toBe(0);
		expect(again.attempted).toBe(0);
		store.close();
	});

	it("retries a failed attempt and reports the retry under the same entry", async () => {
		let cited: string | null = null;
		const model = repairModel(() => cited, "fail_then_ok");
		const { store, state } = setup({ model: model.port });
		cited = markStale(store, "mem-deploy", "m-12");

		const report = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });

		expect(report.attempted).toBe(BACKGROUND_REPAIR_MAX_ATTEMPTS);
		expect(report.repaired).toBe(1);
		expect(model.counters.summary_calls).toBe(2);
		expect(report.entries[0]).toEqual({
			memory_id: "mem-deploy",
			status: "repaired",
			revision: 2,
			reason: null,
			acknowledged_event_ids: [cited],
			elapsed_ms: expect.any(Number),
			attempts: 2,
		});
		expect(store.countPendingStaleEvents("mem-deploy")).toBe(0);
		store.close();
	});

	it("caps the attempts per pending set and reports the exhausted memory instead of dropping it", async () => {
		const model = repairModel(() => null, "fail");
		const { store, state } = setup({ model: model.port });
		markStale(store, "mem-deploy", "m-13");

		const first = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });
		expect(first.attempted).toBe(BACKGROUND_REPAIR_MAX_ATTEMPTS);
		expect(first.repaired).toBe(0);
		expect(first.entries[0]!.status).toBe("repair_failed");
		expect(first.entries[0]!.attempts).toBe(BACKGROUND_REPAIR_MAX_ATTEMPTS);
		expect(first.entries[0]!.reason).toContain("repair_failed");
		expect(store.countPendingStaleEvents("mem-deploy")).toBe(1);

		const second = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });
		expect(second.candidates).toBe(1);
		expect(second.attempted).toBe(0);
		expect(second.entries[0]).toEqual({
			memory_id: "mem-deploy",
			status: "skipped",
			revision: null,
			reason: "attempts_exhausted",
			acknowledged_event_ids: [],
			elapsed_ms: null,
			attempts: BACKGROUND_REPAIR_MAX_ATTEMPTS,
		});
		expect(store.countPendingStaleEvents("mem-deploy")).toBe(1);
		store.close();
	});

	it("gives each memory its own deadline and retries after a deadline kill", async () => {
		const model = repairModel(() => null, "hang");
		const { store, state } = setup({ model: model.port, memoryIds: ["mem-a", "mem-b"] });
		markStale(store, "mem-a", "m-a2");
		markStale(store, "mem-b", "m-b2");

		const report = await repairStaleMemoriesInBackground({
			state,
			store,
			project_id: PROJECT,
			at: AT,
			deadline_ms: 20,
		});

		// Each memory got its own 20 ms deadline and each spent both attempts: a
		// shared remainder would have left the second memory unattempted.
		expect(report.candidates).toBe(2);
		expect(report.attempted).toBe(2 * BACKGROUND_REPAIR_MAX_ATTEMPTS);
		expect(report.repaired).toBe(0);
		expect(report.entries.map((entry) => entry.attempts)).toEqual([2, 2]);
		expect(report.entries.map((entry) => entry.status)).toEqual(["repair_failed", "repair_failed"]);
		expect(report.entries.map((entry) => entry.reason)).toEqual(["deadline_exceeded", "deadline_exceeded"]);
		expect(model.counters.summary_calls).toBe(2 * BACKGROUND_REPAIR_MAX_ATTEMPTS);
		expect(store.countPendingStaleEvents("mem-a")).toBe(1);
		expect(store.countPendingStaleEvents("mem-b")).toBe(1);
		store.close();
	});

	it("does not retry a repair whose navigation summary is still pending", async () => {
		let cited: string | null = null;
		const model = repairModel(() => cited, "nav_bad");
		const { store, state } = setup({ model: model.port });
		cited = markStale(store, "mem-deploy", "m-14");

		const report = await repairStaleMemoriesInBackground({ state, store, project_id: PROJECT, at: AT });

		// The revision was written, so a second attempt would re-repair the head it
		// just saved instead of helping publication.
		expect(report.attempted).toBe(1);
		expect(model.counters.summary_calls).toBe(1);
		expect(report.entries[0]!.status).toBe("nav_pending");
		expect(report.entries[0]!.attempts).toBe(1);
		expect(report.entries[0]!.revision).toBe(2);
		expect(store.readMemory("memory://vestigio/mem-deploy")?.revision).toBe(2);
		expect(store.countPendingStaleEvents("mem-deploy")).toBe(0);
		store.close();
	});

	it("keeps an attempt inside the pass budget even when the per-attempt ceiling is larger", async () => {
		const model = repairModel(() => null, "hang");
		const { store, state } = setup({ model: model.port });
		markStale(store, "mem-deploy", "m-15");
		const started = Date.now();

		const report = await repairStaleMemoriesInBackground({
			state,
			store,
			project_id: PROJECT,
			at: AT,
			deadline_ms: 10_000,
			total_ms: 60,
		});

		// The attempt was clamped to the 60 ms pass budget, not the 10 s ceiling.
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(report.deadline_exceeded).toBe(true);
		expect(report.entries[0]!.status).toBe("repair_failed");
		expect(report.entries[0]!.reason).toBe("deadline_exceeded");
		expect(report.entries[0]!.attempts).toBe(1);
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
		expect(second.entries[0]!.attempts).toBe(1);
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
