/**
 * Seed one isolated Vestigio store for one resolver scenario.
 *
 * Usage: node --import ./hook.mjs seed.mjs <store.sqlite> <scenario> <project_id>
 *
 * Each scenario gets its own store file under the harness temp dir, so a
 * contradiction in one scenario cannot bleed into another. Nothing else is
 * opened: the store path is the only thing this script touches.
 */

import { codePointCount, nonWhitespaceCodePointCount } from "@vestigio/core";
import { openStore } from "@vestigio/core/storage";

const [, , storePath, scenario, projectId] = process.argv;
if (!storePath || !scenario || !projectId) {
  console.error("usage: seed.mjs <store.sqlite> <scenario> <project_id>");
  process.exit(2);
}

const AT = "2026-11-17T12:00:00.000Z";
const FILLER =
  "以下段落只用于满足正文长度要求，重复说明本条记忆的适用范围与阅读方式，不引入任何新的事实、结论或改动。";

function body(prefix) {
  let text = prefix;
  while (nonWhitespaceCodePointCount(text) < 600) text += FILLER;
  return text;
}

function source(id, ordinal) {
  return {
    provider: "pi",
    source_instance: "local",
    session_id: `resolver-eval-${id}`,
    message_id: `resolver-eval-${id}-${ordinal}`,
    parent_message_id: null,
    project_id: projectId,
    timestamp: AT,
    content_hash: `sha256:${String(ordinal).padStart(4, "0")}${"0".repeat(60)}`,
    locator: null,
  };
}

function memory({ id, title, keywords, nav, prefix }) {
  const medium = body(prefix);
  return {
    memory_id: id,
    uri: `memory://vestigio/${id}`,
    scope: { kind: "project", project_id: projectId },
    title,
    keywords,
    revision: 1,
    state: "published",
    medium: { body: medium, body_char_count: nonWhitespaceCodePointCount(medium), sources: [source(id, 1)] },
    nav: { text: nav, char_count: codePointCount(nav), source_revision: 1 },
    hit_count: 0,
    access_count: 0,
    last_access_at: null,
    created_at: AT,
    updated_at: AT,
  };
}

const SCENARIOS = {
  active: [
    memory({
      id: "mem-port",
      title: "部署脚本默认端口",
      keywords: ["端口", "部署"],
      nav: "部署脚本默认端口与回滚步骤。",
      prefix: "部署脚本的默认端口是 18080；回滚时先停写入，再恢复旧端口。",
    }),
  ],
  archived: [
    memory({
      id: "mem-port-active",
      title: "部署脚本默认端口",
      keywords: ["端口", "部署"],
      nav: "部署脚本默认端口。",
      prefix: "部署脚本的默认端口是 18080。",
    }),
    memory({
      id: "mem-archived-rollback",
      title: "迁移失败的回滚步骤",
      keywords: ["回滚", "迁移"],
      nav: "归档：迁移失败时先停写入，再按第五步回滚，不能重跑迁移。",
      prefix: "迁移失败时先停写入，再按第五步回滚，不要重跑迁移。",
    }),
  ],
  lexical: [
    memory({
      id: "mem-decoy",
      title: "zqleak 安装说明",
      keywords: ["zqleak"],
      nav: "zqleak 的依赖安装说明。",
      prefix: "本条只讲依赖安装，不含任何会话记录，也没有可依据的结论。",
    }),
  ],
  gap: [
    memory({
      id: "mem-unrelated",
      title: "主题颜色约定",
      keywords: ["颜色", "主题"],
      nav: "界面颜色与主题变量。",
      prefix: "界面颜色使用主题变量，不再硬编码色值。",
    }),
  ],
  conflict: [
    memory({
      id: "mem-port-old",
      title: "部署脚本默认端口",
      keywords: ["端口", "部署"],
      nav: "部署脚本默认端口（旧）。",
      prefix: "部署脚本的默认端口是 8080，写在部署脚本里。",
    }),
    memory({
      id: "mem-port-new",
      title: "部署脚本默认端口",
      keywords: ["端口", "部署"],
      nav: "部署脚本默认端口（新）。",
      prefix: "部署脚本的默认端口是 18080，旧的 8080 已经废弃。",
    }),
  ],
};

const items = SCENARIOS[scenario];
if (items === undefined) {
  console.error(`unknown scenario ${JSON.stringify(scenario)}; expected one of ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}

const store = openStore({ path: storePath });
for (const item of items) {
  store.saveMemory(item);
}
if (scenario === "archived") {
  store.setMemoryState("memory://vestigio/mem-archived-rollback", "archived");
}
store.upsertProjectActivity({ project_id: projectId, activity_seq: 5, last_input_at: AT });
const integrity = store.integrityCheck();
store.close();

console.log(JSON.stringify({ store: storePath, scenario, project: projectId, saved: items.length, integrity }));
