import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMemory,
  type Memory,
  type MemoryUri,
  type Scope,
  type SourceRef,
} from "@vestigio/core";
import type { HistoryHit, HistoryMessage, HistoryPort } from "@vestigio/core/retrieval";
import type { MemoryStore } from "@vestigio/core/storage";
import type { CliIo } from "../src/index.js";

export const PROJECT_A = "/tmp/proj-a";
export const PROJECT_B = "/tmp/proj-b";

export function tempDbPath(label = "cli"): string {
  const dir = mkdtempSync(join(tmpdir(), "vestigio-cli-"));
  return join(dir, `${label}.db`);
}

export function sourceRef(overrides: Partial<SourceRef> = {}): SourceRef {
  return {
    provider: "pi",
    source_instance: "local",
    session_id: "s-1",
    message_id: "m-1",
    parent_message_id: null,
    project_id: PROJECT_A,
    timestamp: "2026-11-17T16:21:53Z",
    content_hash: `sha256:${"0".repeat(64)}`,
    locator: null,
    ...overrides,
  };
}

function paddedBody(prefix: string, filler = "补充说明部署步骤与回滚方式。"): string {
  let body = prefix;
  while ([...body.replace(/\s/gu, "")].length < 520) {
    body += filler;
  }
  return body;
}

export type SeedOptions = {
  memory_id?: string;
  scope?: Scope;
  title?: string;
  keywords?: string[];
  nav_text?: string | null;
  body?: string;
  state?: "medium_ready" | "published" | "archived";
  sources?: SourceRef[];
};

export function seed(store: MemoryStore, options: SeedOptions = {}): Memory {
  const memoryId = options.memory_id ?? "mem-0001";
  const state = options.state ?? "published";
  const body = paddedBody(options.body ?? "默认端口配置在部署脚本里。");
  const navText =
    options.nav_text === undefined
      ? state === "medium_ready"
        ? null
        : "部署配置与默认端口，改端口前值得读取。"
      : options.nav_text;
  const memory = parseMemory({
    memory_id: memoryId,
    uri: `memory://vestigio/${memoryId}` as MemoryUri,
    scope: options.scope ?? { kind: "project", project_id: PROJECT_A },
    title: options.title ?? "部署脚本默认端口",
    keywords: options.keywords ?? ["部署", "端口"],
    revision: 1,
    state,
    medium: {
      body,
      body_char_count: [...body.replace(/\s/gu, "")].length,
      sources: options.sources ?? [sourceRef()],
    },
    nav: navText === null ? null : { text: navText, char_count: [...navText].length, source_revision: 1 },
    hit_count: 3,
    access_count: 1,
    last_access_at: "2026-11-17T16:30:00Z",
    created_at: "2026-11-17T16:21:53Z",
    updated_at: "2026-11-17T16:30:00Z",
  });
  store.saveMemory(memory);
  if (state === "archived") {
    store.setMemoryState(memory.uri, "archived");
  }
  const stored = store.readMemory(memory.uri);
  if (stored === null) {
    throw new Error(`seed could not read back ${memory.uri}`);
  }
  return stored;
}

export function historyHit(text: string, overrides: Partial<HistoryHit> = {}): HistoryHit {
  const messageId = overrides.source_ref?.message_id ?? "h-1";
  return {
    source_ref: sourceRef({
      provider: "obelisk",
      source_instance: "fixture",
      session_id: "sessA",
      message_id: messageId,
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
  messages?: HistoryMessage[];
  has_more?: boolean;
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
      return { available: options.available ?? true, reason: options.reason ?? null };
    },
    async search(input) {
      calls.search += 1;
      calls.last_search = input;
      return {
        ok: true,
        value: { hits: options.hits ?? [], evidence: "ids_only", elapsed_ms: 1 },
      };
    },
    async readByAnchor(input) {
      calls.readByAnchor += 1;
      calls.last_read = input;
      const anchor = options.hits?.[0]?.source_ref ?? historyMessage("anchor").source_ref;
      return {
        ok: true,
        value: { anchor, messages: options.messages ?? [], has_more: options.has_more ?? false, elapsed_ms: 1 },
      };
    },
  };
  return { port, calls };
}

export type CapturedIo = {
  io: CliIo;
  stdout(): string;
  stderr(): string;
};

export function captureIo(): CapturedIo {
  let out = "";
  let err = "";
  return {
    io: {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
      write: async (text) => {
        out += text;
      },
    },
    stdout: () => out,
    stderr: () => err,
  };
}
