/**
 * Shared reconstruction of what the agent had in context during a trigger run.
 *
 * `trigger.mjs` records what the agent did (tool calls, answer, delivery) but
 * not what the hotspot layer would have offered, because the run answers in a
 * real session and the plan is not part of its report. Both the usage bridge and
 * the trace reader need that missing half, and both need the same fact-to-memory
 * table for cold turns, so it lives here instead of in each script.
 *
 *   node --import ../pi/hook.mjs ./trace.mjs          # uses it, writes out/trace.json
 *   node --import ../pi/hook.mjs ./usage-from-trigger.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InjectionLedger, planInjection, recordProjectInput } from "@vestigio/core/hotspots";
import { openStore } from "@vestigio/core/storage";
import { AT, MEMORIES, PROJECT, seedStore } from "./catalog.mjs";

/** Memory bodies, so a judge or a reader sees what the agent could have read. */
const BODY = new Map(MEMORIES.map((memory) => [memory.id, memory.prefix ?? ""]));

/** Cold turns name no memory in the report; the fact is what identifies it. */
const COLD_BY_FACT = new Map([
	["20", "mem-conn-pool"],
	["14", "mem-log-retention"],
	["哈希", "mem-docker-image"],
	["90", "mem-secret-rotation"],
]);

const NAV = new Map([
	["mem-conn-pool", "连接池大小与超时参数。"],
	["mem-log-retention", "日志保留周期与清理任务的时间点。"],
	["mem-docker-image", "镜像标签与推送规则。"],
	["mem-secret-rotation", "密钥轮换周期与灰度顺序。"],
]);

/**
 * The fact each recall scenario must carry, keyed by scenario id. Kept in step
 * with `SCENARIOS` in trigger.mjs by hand: the harness owns the scenarios, this
 * table owns the mapping to the memory they exercise.
 */
export const TURN_FACTS = new Map([
	["recall-deploy-port", "18080"],
	["recall-migration-rollback", "第五步"],
	["recall-cache-invalidation", "删缓存"],
	["recall-stale-timeout", "15"],
	["cold-conn-limit", "20"],
	["cold-log-retention", "14"],
	["cold-image-tag", "哈希"],
	["cold-secret-rotation", "90"],
]);

export function compact(value) {
	return String(value).replace(/\s+/gu, "");
}

/**
 * Run `fn` against a throwaway store seeded from `catalog.mjs`, with the project
 * input already recorded so `planInjection` sees the same state the harness does.
 */
export function withSeededStore(fn) {
	const dir = mkdtempSync(join(tmpdir(), "vestigio-replay-"));
	const store = openStore({ path: join(dir, "store.sqlite") });
	seedStore(store);
	recordProjectInput(store, PROJECT, AT);
	try {
		return fn(store);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The hotspot plan for one question: what the layer would offer, and with which
 * nav text and body, so a caller can describe the injection stage of a turn.
 */
export function replayInjection(store, question, inputId) {
	const plan = planInjection({
		store,
		project_id: PROJECT,
		session_id: "replay",
		branch_ref: "root",
		input_id: inputId,
		text: question,
		source: "text",
		host_command: false,
		ledger: new InjectionLedger(),
	});
	return {
		reason: plan.reason ?? null,
		candidates: plan.matched.map((match) => match.memory_id),
		injected: plan.injected.map((match) => ({
			memory_id: match.memory_id,
			nav_text: match.nav?.text ?? "",
			body_text: BODY.get(match.memory_id) ?? "",
			stale: match.freshness?.is_stale === true,
		})),
	};
}

/** Fill in the remembered block for `mem` from the catalogue. */
export function navEntry(memoryId) {
	return { memory_id: memoryId, nav_text: NAV.get(memoryId) ?? "", body_text: BODY.get(memoryId) ?? "" };
}

export { COLD_BY_FACT };
