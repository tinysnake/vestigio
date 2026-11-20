/**
 * Turn a trigger run's real answers into usage-judge rows.
 *
 * `usage.mjs` grades hand-written answers, which cannot show whether the judge
 * agrees with reality. This bridge reads `out/trigger.json`, reconstructs the
 * memory each recall turn had in context (the hotspot plan for warm turns, the
 * fact-to-memory table for cold ones), and writes rows whose expectation is the
 * objective one: the answer carries the memory's fact or it does not.
 *
 *   node --import ../pi/hook.mjs ./usage-from-trigger.mjs
 *   node --import ../pi/hook.mjs ./usage.mjs --cases out/usage-from-trigger.jsonl
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { InjectionLedger, planInjection, recordProjectInput } from "@vestigio/core/hotspots";
import { openStore } from "@vestigio/core/storage";
import { AT, MEMORIES, PROJECT, seedStore } from "./catalog.mjs";

const BODY = new Map(MEMORIES.map((memory) => [memory.id, memory.prefix ?? ""]));

function argument(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? null : (process.argv[index + 1] ?? null);
}

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

const reportPath = resolve(argument("--report") ?? "out/trigger.json");
const outPath = resolve(argument("--out") ?? "out/usage-from-trigger.jsonl");
const report = JSON.parse(readFileSync(reportPath, "utf8"));

const tempDir = mkdtempSync(join(tmpdir(), "vestigio-usage-bridge-"));
const store = openStore({ path: join(tempDir, "store.sqlite") });
seedStore(store);
recordProjectInput(store, PROJECT, AT);

const FACT = new Map([
	["recall-deploy-port", "18080"],
	["recall-migration-rollback", "第五步"],
	["recall-cache-invalidation", "删缓存"],
	["recall-stale-timeout", "15"],
	["cold-conn-limit", "20"],
	["cold-log-retention", "14"],
	["cold-image-tag", "哈希"],
	["cold-secret-rotation", "90"],
]);

const rows = [];
for (const turn of report.cases) {
	const fact = FACT.get(turn.id);
	if (fact === undefined || turn.answer === undefined) continue;
	const plan = planInjection({
		store,
		project_id: PROJECT,
		session_id: "usage-bridge",
		branch_ref: "root",
		input_id: `bridge-${turn.id}`,
		text: turn.question,
		source: "text",
		host_command: false,
		ledger: new InjectionLedger(),
	});
	const warm = plan.injected.map((match) => ({
		memory_id: match.memory_id,
		nav_text: match.nav?.text ?? "",
		body_text: BODY.get(match.memory_id) ?? "",
	}));
	const coldId = COLD_BY_FACT.get(fact);
	const injected =
		warm.length > 0
			? warm
			: coldId === undefined
				? []
				: [{ memory_id: coldId, nav_text: NAV.get(coldId) ?? "", body_text: BODY.get(coldId) ?? "" }];
	if (injected.length === 0) continue;
	rows.push({
		id: `usage-${turn.id}`,
		memory_id: injected[0].memory_id,
		query: turn.question,
		injected,
		answer: turn.answer,
		expectation: compact(turn.answer).includes(compact(fact)) ? "used" : "ignored",
		note: `trigger ${turn.id}: ${turn.status}, fact=${fact}`,
	});
}

function compact(value) {
	return String(value).replace(/\s+/gu, "");
}

rmSync(tempDir, { recursive: true, force: true });
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
console.log(`${rows.length} rows -> ${outPath}`);
console.log(
	rows.map((row) => `${row.id}=${row.expectation}(${row.memory_id})`).join(" "),
);
