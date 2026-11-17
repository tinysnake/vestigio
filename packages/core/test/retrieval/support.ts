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
    last_read: { anchor: string; before: number } | null;
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
          messages: options.messages ?? [],
          has_more: options.has_more ?? false,
          elapsed_ms: 1,
        },
      };
    },
  };
  return { port, calls };
}
