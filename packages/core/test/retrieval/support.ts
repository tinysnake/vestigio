import type { Memory, MemoryUri, Scope, SourceRef } from "../../src/contracts/index.js";
import { parseMemory } from "../../src/contracts/index.js";
import type { MemoryStore } from "../../src/storage/index.js";
import { bodyWith, navWith } from "../storage/support.js";
import { measuredNonWhitespace, makeMemory, makeSourceRef } from "../support.js";
import type {
  HistoryHit,
  HistoryMessage,
  HistoryPort,
  HistorySearchOutput,
} from "../../src/retrieval/index.js";

export { bodyWith, openTempStore, tempDbPath } from "../storage/support.js";
export { makeSourceRef } from "../support.js";

export type SeedState = "medium_ready" | "published" | "archived";

export type SeedOptions = {
  memory_id?: string;
  scope?: Scope;
  title?: string;
  keywords?: string[];
  /** `null` seeds a memory that has no navigation summary yet. */
  nav_text?: string | null;
  body?: string;
  state?: SeedState;
  sources?: SourceRef[];
};

export const PROJECT_A = "/tmp/proj-a";
export const PROJECT_B = "/tmp/proj-b";

/** Save one memory and return its head row as the store gives it back. */
export function seedMemory(store: MemoryStore, options: SeedOptions = {}): Memory {
  const memoryId = options.memory_id ?? "mem-0001";
  const state = options.state ?? "published";
  const body = options.body ?? bodyWith("默认端口配置在部署脚本里。");
  const navText =
    options.nav_text === undefined
      ? state === "medium_ready"
        ? null
        : "部署配置与默认端口，改端口前值得读取。"
      : options.nav_text;
  const memory = parseMemory(
    makeMemory({
      memory_id: memoryId,
      uri: `memory://vestigio/${memoryId}` as MemoryUri,
      scope: options.scope ?? { kind: "project", project_id: PROJECT_A },
      title: options.title ?? "部署脚本默认端口",
      keywords: options.keywords ?? ["部署", "端口"],
      state,
      nav: navText === null ? null : navWith(navText, 1),
      medium: {
        body,
        body_char_count: measuredNonWhitespace(body),
        sources: options.sources ?? [makeSourceRef()],
      },
    }),
  );
  store.saveMemory(memory);
  if (state === "archived") {
    store.setMemoryState(memory.uri, "archived");
  }
  const stored = store.readMemory(memory.uri);
  if (stored === null) {
    throw new Error(`seedMemory could not read back ${memory.uri}`);
  }
  return stored;
}

export function historyHit(text: string, overrides: Partial<HistoryHit> = {}): HistoryHit {
  const messageId = overrides.source_ref?.message_id ?? "h-1";
  return {
    source_ref: makeSourceRef({
      provider: "obelisk",
      source_instance: "fixture",
      session_id: "sessA",
      message_id: messageId,
      project_id: PROJECT_A,
      timestamp: "2026-11-17T16:20:00Z",
      content_hash: `sha256:${"a".repeat(64)}`,
      locator: `/sessions/projA/sessA.jsonl#${messageId}`,
    }),
    text,
    timestamp: "2026-11-17T16:20:00Z",
    role: "user",
    evidence_complete: true,
    project_resolved: true,
    ...overrides,
  };
}

export function historyMessage(text: string, overrides: Partial<HistoryMessage> = {}): HistoryMessage {
  const hit = historyHit(text, overrides);
  return { source_ref: hit.source_ref, text: hit.text, role: hit.role };
}

export type FakeHistoryOptions = {
  available?: boolean;
  reason?: string | null;
  hits?: HistoryHit[];
  evidence?: HistorySearchOutput["evidence"];
  messages?: HistoryMessage[];
  /** What a `timeline` read returns, i.e. the replies after the anchor. */
  timeline_messages?: HistoryMessage[];
  has_more?: boolean;
  probe_throws?: string;
  search_throws?: string;
  search_failure?: { status: "unavailable" | "failed"; reason: string };
  read_throws?: string;
  read_failure?: { status: "unavailable" | "failed"; reason: string };
};

export type FakeHistory = {
  port: HistoryPort;
  calls: {
    probe: number;
    search: number;
    readByAnchor: number;
    last_search: { text: string; project_path: string; limit: number } | null;
    last_read: { anchor: string; before: number; relation?: "parents" | "timeline" | undefined; after?: number | undefined } | null;
  };
};

/** A port that answers from memory, so the core behaviour is testable alone. */
export function makeHistoryPort(options: FakeHistoryOptions = {}): FakeHistory {
  const calls: FakeHistory["calls"] = {
    probe: 0,
    search: 0,
    readByAnchor: 0,
    last_search: null,
    last_read: null,
  };
  const port: HistoryPort = {
    async probe() {
      calls.probe += 1;
      if (options.probe_throws !== undefined) {
        throw new Error(options.probe_throws);
      }
      return { available: options.available ?? true, reason: options.reason ?? null };
    },
    async search(input) {
      calls.search += 1;
      calls.last_search = input;
      if (options.search_throws !== undefined) {
        throw new Error(options.search_throws);
      }
      if (options.search_failure !== undefined) {
        return { ok: false, status: options.search_failure.status, reason: options.search_failure.reason };
      }
      return {
        ok: true,
        value: {
          hits: options.hits ?? [],
          evidence: options.evidence ?? "resolved",
          elapsed_ms: 1,
        },
      };
    },
    async readByAnchor(input) {
      calls.readByAnchor += 1;
      calls.last_read = input;
      if (options.read_throws !== undefined) {
        throw new Error(options.read_throws);
      }
      if (options.read_failure !== undefined) {
        return { ok: false, status: options.read_failure.status, reason: options.read_failure.reason };
      }
      const anchor = options.hits?.[0]?.source_ref ?? historyMessage("anchor").source_ref;
      return {
        ok: true,
        value: {
          anchor,
          messages: input.relation === "timeline" ? (options.timeline_messages ?? []) : (options.messages ?? []),
          has_more: options.has_more ?? false,
          elapsed_ms: 1,
        },
      };
    },
  };
  return { port, calls };
}

/**
 * A history excerpt long enough to honestly support a 500-character body.
 * PR-07 refuses to summarize fewer than `MEDIUM_BODY_MIN` characters of
 * evidence, so a two-sentence excerpt would exercise the refusal path instead
 * of the save path.
 */
export const HISTORY_DECISION_TEXT = [
  "这次把部署脚本的默认端口统一成 8787。之前三套环境各写一个端口，出过两次连错服务的事故，所以端口提到配置文件的顶层，由部署脚本按环境注入，不再散落在各个启动脚本里。",
  "灰度环境的端口单独保留 8788，避免和本地调试常用的 8080 冲突。回滚路径必须同时覆盖配置和镜像两部分，只回滚镜像会留下新端口的配置，健康检查会在启动阶段直接失败，这是上次事故的直接原因。",
  "健康检查改成先探测端口可达再跑业务探针，两次探测间隔两秒，连续三次失败才算不可用。缓存配置继续走同一份模板，键前缀加上环境名，避免灰度与生产共用一份缓存时互相污染。",
  "上线顺序是配置先行、镜像随后，配置向后兼容至少保留一个版本，这样镜像回滚不需要同步改配置。监控给端口切换加一次性告警，切换后五分钟内出现连接拒绝就通知值班同学，同时把旧端口的连接数打到面板上，确认没有残留流量。",
  "文档只保留一份，写在部署仓库的 README 里，其他地方的端口说明一律删掉，避免再出现几份互相矛盾的说明。推进节奏是先在灰度验证一周，没有异常再推生产，推之前留一条评审记录。",
  "端口、环境名和健康检查地址统一写进一张环境对照表，部署、回滚和排查都只查这张表，不再各处翻启动脚本，改动的唯一来源就是它，对照表本身也进版本库并且需要评审。",
].join("\n");

/** The follow-up excerpt: the same discussion, with the port decision changed. */
export const HISTORY_PORT_CHANGE_TEXT = [
  "复核之后决定把默认端口从 8787 改成 9090。原因是 8787 在几台新开发机上已经被别的服务占用，启动时报地址已占用，排查成本很高。",
  "改动范围仍然是配置文件顶层加部署脚本注入，灰度单独保留 9091，本地调试继续用 8080。健康检查、缓存键前缀和环境名隔离这些约束都不变。",
  "回滚仍然要同时覆盖配置和镜像，但这次先回滚镜像再回滚配置，因为新镜像只认 9090，配置先回滚会让健康检查在启动阶段失败。",
  "监控告警同步改到 9090，切换后五分钟内出现连接拒绝就通知值班同学，旧端口 8787 的连接数保留一周便于确认没有残留流量。",
  "文档同样只保留一份，写在部署仓库的 README 里，同时把这次变更的原因和复核结论补进评审记录，方便下次别人问起为什么改端口时有据可查。",
  "环境对照表同步改到 9090 和 9091，部署、回滚和排查仍然只查这张表，改动的唯一来源就是它。这一轮先在灰度跑一周，观察连接拒绝告警和旧端口残留流量，没有问题再推生产。",
  "另外约定：以后新增环境必须先在这张对照表里登记端口和健康检查地址，不允许在启动脚本里直接写常量，这一条写进评审清单，评审时逐项确认。",
  "这次改端口也顺势把对照表补全，把每一套环境的端口、健康检查地址和负责人都写清楚，后续新增环境先登记再动启动脚本，避免又回到散落多处的状态。",
].join("\n");
