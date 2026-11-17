import {
  usageEventId,
  type Memory,
  type MemoryUri,
  type SourceRef,
  type UsageEvent,
} from "../../../src/contracts/index.js";

const FILLER = "部署步骤包含预检查、切换、健康检查与回滚验证，任何一步失败都回到旧版本。";

export function bodyWith(prefix: string): string {
  let body = prefix;
  while ([...body.replace(/\s/gu, "")].length < 520) {
    body += FILLER;
  }
  return body;
}

export function liveUri(memoryId: string): MemoryUri {
  return `memory://vestigio/${memoryId}`;
}

export function sourceRef(messageId: string): SourceRef {
  return {
    provider: "pi",
    source_instance: "local",
    session_id: "live-session",
    message_id: messageId,
    parent_message_id: null,
    project_id: "p-live",
    timestamp: "2026-11-17T16:00:00Z",
    content_hash: `sha256:${"a".repeat(64)}`,
    locator: null,
  };
}

export function liveMemory(memoryId: string, marker: string, revision = 1): Memory {
  const body = bodyWith(`${marker} 第${revision}版正文：${marker} 是这一版独有的检索词。`);
  const navText = `${marker} 第${revision}版摘要：部署与回滚说明。`;
  return {
    memory_id: memoryId,
    uri: `memory://vestigio/${memoryId}`,
    scope: { kind: "project", project_id: "p-live" },
    title: `${marker} 部署记录`,
    keywords: ["部署", marker],
    revision,
    state: "published",
    medium: {
      body,
      body_char_count: [...body.replace(/\s/gu, "")].length,
      sources: [sourceRef(`msg-${memoryId}-${revision}`)],
    },
    nav: { text: navText, char_count: [...navText].length, source_revision: revision },
    hit_count: 0,
    access_count: 0,
    last_access_at: null,
    created_at: "2026-11-17T16:00:00Z",
    updated_at: "2026-11-17T16:00:00Z",
  };
}

export function liveUsageEvent(memoryId: string, dedupKey: string, at = "2026-11-17T16:00:00Z"): UsageEvent {
  const fields = {
    memory_id: memoryId,
    revision: 1,
    kind: "hit" as const,
    channel: "search" as const,
    session_id: "live-session",
    input_id: dedupKey,
    at,
    dedup_key: dedupKey,
  };
  return { event_id: usageEventId(fields), ...fields };
}

export function requiredArg(index: number, name: string): string {
  const value = process.argv[index];
  if (value === undefined || value === "") {
    throw new Error(`missing argument: ${name}`);
  }
  return value;
}
