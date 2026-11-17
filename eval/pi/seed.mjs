/**
 * Seed an isolated Vestigio store for the PR-05 harness.
 *
 * Usage: node --import ./hook.mjs seed.mjs <store.sqlite> <project_id> <perf_project_id>
 *
 * Everything it writes is scoped to one of the two project ids handed in. It
 * never opens, reads or lists any other store, and the harness always points
 * `VESTIGIO_STORE` at a file under /tmp/vestigio-pi.
 */

import { codePointCount, nonWhitespaceCodePointCount } from "@vestigio/core";
import { openStore } from "@vestigio/core/storage";

const [, , storePath, projectId, perfProjectId] = process.argv;
if (!storePath || !projectId || !perfProjectId) {
	console.error("usage: seed.mjs <store.sqlite> <project_id> <perf_project_id>");
	process.exit(2);
}

const AT = "2026-11-17T12:00:00.000Z";
const FILLER = "本记忆记录了当时的结论、涉及的模块、改动方式和验证办法，供后续同类工作直接参考。";

function body(prefix) {
	let text = prefix;
	while (nonWhitespaceCodePointCount(text) < 600) text += FILLER;
	return text;
}

function source(id, project, ordinal) {
	return {
		provider: "pi",
		source_instance: "local",
		session_id: `harness-session-${id}`,
		message_id: `harness-message-${id}-${ordinal}`,
		parent_message_id: null,
		project_id: project,
		timestamp: AT,
		content_hash: `sha256:${String(ordinal).padStart(4, "0")}${"0".repeat(60)}`,
		locator: `/tmp/vestigio-pi/history/${id}.jsonl#${ordinal}`,
	};
}

function memory({ id, project, title, keywords, nav, prefix }) {
	const medium = body(prefix);
	const text = nav;
	return {
		memory_id: id,
		uri: `memory://vestigio/${id}`,
		scope: { kind: "project", project_id: project },
		title,
		keywords,
		revision: 1,
		state: "published",
		medium: {
			body: medium,
			body_char_count: nonWhitespaceCodePointCount(medium),
			sources: [source(id, project, 1), source(id, project, 2)],
		},
		nav: { text, char_count: codePointCount(text), source_revision: 1 },
		hit_count: 0,
		access_count: 0,
		last_access_at: null,
		created_at: AT,
		updated_at: AT,
	};
}

const store = openStore({ path: storePath });

const functional = [
	memory({
		id: "mem-deploy-port",
		project: projectId,
		title: "部署脚本默认端口",
		keywords: ["部署", "端口", "deploy-port"],
		nav: "部署配置与默认端口，改端口前值得读取。",
		prefix: "把服务端口从 8080 改成 18080 时，部署脚本里的默认值也要一起改。",
	}),
	memory({
		id: "mem-migration",
		project: projectId,
		title: "数据库迁移回滚",
		keywords: ["迁移", "回滚", "migration"],
		nav: "数据库迁移与回滚步骤，改迁移前值得读取。",
		prefix: "迁移失败时先停写入，再按第五步回滚，不要重跑迁移。",
	}),
	memory({
		id: "mem-cache",
		project: projectId,
		title: "缓存失效策略",
		keywords: ["缓存", "cache"],
		nav: "缓存键与失效策略，改缓存前值得读取。",
		prefix: "写路径先删缓存再写库，读路径回填时带随机抖动。",
	}),
];

for (const item of functional) {
	store.saveMemory(item);
}

// An archived memory in the same project: the pool must never surface it.
const archived = memory({
	id: "mem-archived",
	project: projectId,
	title: "旧版配置格式",
	keywords: ["旧配置"],
	nav: "旧版配置格式，已被替代，仅存档。",
	prefix: "旧版配置格式已经被替代，只保留用于对照。",
});
store.saveMemory(archived);
store.setMemoryState(archived.uri, "archived");

const perf = [];
for (let index = 0; index < 32; index += 1) {
	const id = `mem-perf-${String(index).padStart(2, "0")}`;
	const token = `perftoken${String(index).padStart(2, "0")}`;
	perf.push(
		memory({
			id,
			project: perfProjectId,
			title: `性能样本 ${index} 的结论`,
			keywords: [token],
			nav: `性能样本 ${index} 的导航摘要，读取前先看这里。`,
			prefix: `性能样本 ${index}：这条记忆存在的唯一目的是让热点池满载，用来测匹配路径的 p95。`,
		}),
	);
}
for (const item of perf) {
	store.saveMemory(item);
}

// Pool membership: the whole set is admitted at seq 1 so the pool is not the
// variable under test. The archived memory is deliberately a member too, so the
// pool's archive filter is exercised.
let admitted = 0;
for (const item of [...functional, archived, ...perf]) {
	admitted += 1;
	store.upsertHotspotMembership({
		project_id: item.scope.project_id,
		memory_id: item.memory_id,
		admitted_seq: 1,
		last_hit_seq: 0,
		last_access_seq: 0,
		recent_hit_weight: 0,
		recent_access_weight: 0,
	});
}
store.upsertProjectActivity({ project_id: projectId, activity_seq: 10, last_input_at: AT });
store.upsertProjectActivity({ project_id: perfProjectId, activity_seq: 10, last_input_at: AT });

const integrity = store.integrityCheck();
store.close();

console.log(
	JSON.stringify({
		store: storePath,
		project: projectId,
		perf_project: perfProjectId,
		saved: functional.length + perf.length + 1,
		memberships: admitted,
		integrity,
	}),
);
