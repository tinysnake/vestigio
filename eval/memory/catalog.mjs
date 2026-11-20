/**
 * Fixed memory catalog for the offline memory evaluation.
 *
 * One store, two projects, twenty memories (one of them carries a pending
 * stale event, so freshness is observable). The case file refers to these
 * memory ids, so a change here changes the dataset. Bump `CATALOG_VERSION`
 * whenever the catalog changes, and regenerate the baseline.
 */

import { codePointCount, nonWhitespaceCodePointCount } from "@vestigio/core";

export const CATALOG_VERSION = 5;
export const PROJECT = "p-memory-eval";
export const OTHER_PROJECT = "p-memory-eval-other";
export const AT = "2026-11-17T12:00:00.000Z";

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
		session_id: `eval-session-${id}`,
		message_id: `eval-message-${id}-${ordinal}`,
		parent_message_id: null,
		project_id: project,
		timestamp: AT,
		content_hash: `sha256:${String(ordinal).padStart(4, "0")}${"0".repeat(60)}`,
		locator: `/tmp/vestigio-memory-eval/history/${id}.jsonl#${ordinal}`,
	};
}

function memory({ id, project, title, keywords, nav, prefix, state = "published" }) {
	const medium = body(prefix);
	return {
		memory_id: id,
		uri: `memory://vestigio/${id}`,
		scope: { kind: "project", project_id: project },
		title,
		keywords,
		revision: 1,
		state,
		medium: {
			body: medium,
			body_char_count: nonWhitespaceCodePointCount(medium),
			sources: [source(id, project, 1), source(id, project, 2)],
		},
		nav: { text: nav, char_count: codePointCount(nav), source_revision: 1 },
		hit_count: 0,
		access_count: 0,
		last_access_at: null,
		created_at: AT,
		updated_at: AT,
	};
}

export const MEMORIES = [	memory({
		id: "mem-deploy-port",
		project: PROJECT,
		title: "部署脚本默认端口",
		keywords: ["部署", "端口", "deploy-port"],
		nav: "部署配置与默认端口，改端口前值得读取。",
		prefix: "把服务端口从 8080 改成 18080 时，部署脚本里的默认值也要一起改。",
	}),
	memory({
		id: "mem-migration",
		project: PROJECT,
		title: "数据库迁移回滚",
		keywords: ["迁移", "回滚", "migration"],
		nav: "数据库迁移与回滚步骤，改迁移前值得读取。",
		prefix: "迁移失败时先停写入，再按第五步回滚，不要重跑迁移。",
	}),
	memory({
		id: "mem-cache",
		project: PROJECT,
		title: "缓存失效策略",
		keywords: ["缓存", "cache"],
		nav: "缓存键与失效策略，改缓存前值得读取。",
		prefix: "写路径先删缓存再写库，读路径回填时带随机抖动。",
	}),
	memory({
		id: "mem-archived",
		project: PROJECT,
		title: "旧版配置格式",
		keywords: ["旧配置", "legacy-config"],
		nav: "旧版配置格式，已被替代，仅存档。",
		prefix: "旧版配置格式已经被替代，只保留用于对照。",
		state: "archived",
	}),
	memory({
		id: "mem-other-port",
		project: OTHER_PROJECT,
		title: "另一项目的部署端口",
		keywords: ["部署", "端口", "deploy-port"],
		nav: "另一项目的部署端口，与 p-memory-eval 无关。",
		prefix: "另一项目把部署端口改成 9090，两边的部署脚本互不共享。",
	}),
	memory({
		id: "mem-port-rule-a",
		project: PROJECT,
		title: "端口约定",
		keywords: ["端口约定", "port-rule"],
		nav: "端口约定的其中一版说法，阅读前需确认哪版有效。",
		prefix: "端口约定按 8080 开放在内网，对外只走网关，不再单独暴露。",
	}),
	memory({
		id: "mem-stale-ttl",
		project: PROJECT,
		title: "会话保活时长",
		keywords: ["会话超时", "空闲断开"],
		nav: "会话保活时长，后来改短，仅作历史参考。",
		prefix: "曾经约定空闲会话 30 分钟后自动断开，后来改成了 15 分钟。",
	}),
	memory({
		id: "mem-port-rule-b",
		project: PROJECT,
		title: "端口约定（冲突）",
		keywords: ["端口约定", "port-rule"],
		nav: "与另一条端口约定同名，两条并列时应先澄清。",
		prefix: "端口约定改成 18080，旧的 8080 只保留一周用于回滚。",
	}),
	memory({
		id: "mem-build-cache",
		project: PROJECT,
		title: "构建产物缓存",
		keywords: ["构建缓存", "build-cache"],
		nav: "构建产物缓存的位置与命中条件，改构建前值得读取。",
		prefix: "构建产物放在 .cache/build，命中条件是 lockfile 与编译参数都不变。",
	}),
	memory({
		id: "mem-flaky-test",
		project: PROJECT,
		title: "偶发失败的测试",
		keywords: ["偶发失败", "flaky"],
		nav: "已知偶发失败的测试清单与重跑方式。",
		prefix: "collector 的时序测试偶发失败，重跑单文件即可，不要整体重跑。",
	}),
	memory({
		id: "mem-auth-token",
		project: PROJECT,
		title: "访问令牌刷新",
		keywords: ["令牌刷新", "token-refresh"],
		nav: "访问令牌刷新流程与过期处理。",
		prefix: "访问令牌过期前五分钟刷新，失败时保留旧令牌一次重试。",
	}),
	memory({
		id: "mem-log-retention",
		project: PROJECT,
		title: "日志保留周期",
		keywords: ["日志保留", "log-retention"],
		nav: "日志保留周期与清理任务的时间点。",
		prefix: "应用日志保留 14 天，审计日志保留 180 天，清理任务每天凌晨三点跑。",
	}),
	memory({
		id: "mem-feature-flag",
		project: PROJECT,
		title: "灰度开关",
		keywords: ["灰度开关", "feature-flag"],
		nav: "灰度开关的默认值与关闭顺序。",
		prefix: "灰度开关默认关闭，关闭顺序是先摘流量再改配置。",
	}),
	memory({
		id: "mem-api-version",
		project: PROJECT,
		title: "接口版本策略",
		keywords: ["接口版本", "api-version"],
		nav: "接口版本兼容策略与弃用窗口。",
		prefix: "旧接口版本保留两个发布周期，弃用前必须先在响应头里标记。",
	}),
	memory({
		id: "mem-conn-pool",
		project: PROJECT,
		title: "连接池参数",
		keywords: ["连接池", "pool-size"],
		nav: "连接池大小与超时参数。",
		prefix: "连接池上限 20，空闲超时 30 秒，不要按并发数等比放大。",
	}),
	memory({
		id: "mem-docker-image",
		project: PROJECT,
		title: "镜像标签规则",
		keywords: ["镜像标签", "容器", "image-tag"],
		nav: "镜像标签与推送规则。",
		prefix: "镜像标签用提交短哈希，latest 只在主分支成功后覆盖。",
	}),
	memory({
		id: "mem-monorepo",
		project: PROJECT,
		title: "仓库目录约定",
		keywords: ["目录约定", "monorepo"],
		nav: "仓库目录与包边界约定。",
		prefix: "包放在 packages 下，跨包引用只允许走公开入口，不许深引。",
	}),
	memory({
		id: "mem-i18n",
		project: PROJECT,
		title: "文案与翻译",
		keywords: ["文案翻译", "i18n"],
		nav: "文案与翻译文件的位置和校验方式。",
		prefix: "文案在 locales 目录，缺 key 由构建期校验拦住。",
	}),
	memory({
		id: "mem-secret-rotation",
		project: PROJECT,
		title: "密钥轮换",
		keywords: ["密钥轮换", "secret-rotation"],
		nav: "密钥轮换周期与灰度顺序。",
		prefix: "密钥每 90 天轮换一次，先加新密钥再删旧密钥。",
	}),
	memory({
		id: "mem-timeout-default",
		project: PROJECT,
		title: "默认超时设置",
		keywords: ["超时"],
		nav: "默认超时设置与上层覆盖方式。",
		prefix: "默认超时 5 秒，调用方可以覆盖，但不能低于 1 秒。",
	}),
];

/**
 * Scripted history hits per scenario. The port is faked here on purpose: this
 * harness measures how the core layer bounds, filters and attributes history
 * excerpts, not what the Obelisk adapter returns (eval/pi covers that path).
 */
export const HISTORY_SCENARIOS = {
	none: [],
	"gray-release": [
		{
			source_ref: source("history-gray", PROJECT, 3),
			text: "灰度发布按 5%、25%、100% 三批放量，每批观察十分钟再决定下一步。",
			timestamp: AT,
			role: "assistant",
			evidence_complete: true,
			project_resolved: true,
		},
	],
	"foreign-only": [
		{
			source_ref: source("history-foreign", OTHER_PROJECT, 4),
			text: "这条记录属于另一个项目，查询 p-memory-eval 时应当被丢弃。",
			timestamp: AT,
			role: "assistant",
			evidence_complete: true,
			project_resolved: false,
		},
	],
};

/** A scripted HistoryPort: probe ok, one bounded search, one bounded read. */
export function scriptedHistoryPort(scenario) {
	const hits = HISTORY_SCENARIOS[scenario] ?? [];
	return {
		async probe() {
			return { available: true, reason: null };
		},
		async search() {
			return { ok: true, value: { hits, evidence: "resolved", elapsed_ms: 0 } };
		},
		async readByAnchor(input) {
			return {
				ok: true,
				value: {
					anchor: source(input.anchor, "p-memory-eval", 5),
					messages: [],
					has_more: false,
					elapsed_ms: 0,
				},
			};
		},
	};
}

/** Save every catalog memory, admit it to its project pool, and fix project activity. */
export function seedStore(store) {
	for (const item of MEMORIES) store.saveMemory(item);
	for (const item of MEMORIES) {
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
	// A pending stale event makes mem-stale-ttl report is_stale, which is what
	// the freshness assertion in cases.jsonl reads.
	store.markStale({
		memory_id: "mem-stale-ttl",
		observed_revision: 1,
		reason: "later evidence: 空闲超时从 30 分钟改成 15 分钟",
		excerpt: "2026-11-16 的配置评审把空闲会话超时改成 15 分钟。",
		sources: [source("stale-ttl", PROJECT, 6)],
		producer: "detector",
		at: AT,
	});
	for (const projectId of [PROJECT, OTHER_PROJECT]) {
		store.upsertProjectActivity({ project_id: projectId, activity_seq: 10, last_input_at: AT });
	}
	return { memories: MEMORIES.length };
}
