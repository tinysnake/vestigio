import { afterEach, describe, expect, it } from "vitest";
import type { MemoryStore } from "../../src/storage/index.js";
import { layeredSearch, truncationMarker } from "../../src/retrieval/index.js";
import {
  PROJECT_A,
  PROJECT_B,
  historyHit,
  historyMessage,
  makeHistoryPort,
  makeSourceRef,
  openTempStore,
  seedMemory,
} from "./support.js";

const stores: MemoryStore[] = [];

function newStore(): MemoryStore {
  const store = openTempStore();
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

const projectA = { kind: "project", project_id: PROJECT_A } as const;

function hit(text: string, messageId: string, projectId = PROJECT_A) {
  return historyHit(text, {
    source_ref: makeSourceRef({
      provider: "obelisk",
      source_instance: "fixture",
      session_id: "sessA",
      message_id: messageId,
      project_id: projectId,
      locator: `/sessions/projA/sessA.jsonl#${messageId}`,
    }),
  });
}

describe("history layer: reached only on an explicit ask", () => {
  it("bounds excerpts and marks every truncation", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "端口约定：8787。" });
    const long = `zqleak ${"长".repeat(300)}`;
    const fake = makeHistoryPort({ hits: [hit(long, "h-1"), hit("zqleak short message", "h-2")] });

    const outcome = await layeredSearch({
      store,
      query: "端口",
      scope: projectA,
      include_history: true,
      history_excerpt_chars: 64,
      history: fake.port,
    });

    const history = outcome.layers.find((layer) => layer.layer === "history");
    expect(history?.status).toBe("matched");
    expect(history?.candidates).toBe(2);
    expect(history?.emitted).toBe(2);
    expect(history?.evidence).toBe("resolved");
    expect(history?.read).toBe(false);
    expect(fake.calls.last_search).toEqual({ text: "端口", project_path: PROJECT_A, limit: 3 });

    const [first, second] = outcome.history;
    expect(first?.truncated).toBe(true);
    expect(first?.full_char_count).toBe([...long].length);
    expect(first?.excerpt_char_count).toBeGreaterThan(64);
    expect(first?.truncation_marker).toBe(truncationMarker([...long].length - 64));
    expect(first?.excerpt.includes("…[truncated")).toBe(true);
    expect(first?.source_ref.message_id).toBe("h-1");
    expect(first?.source_ref.project_id).toBe(PROJECT_A);
    expect(first?.via).toBe("search");
    expect(second?.truncated).toBe(false);
    expect(second?.excerpt).toBe("zqleak short message");
    expect(second?.truncation_marker).toBeNull();

    // The refs are also on the frozen result, so a caller that only reads
    // RetrievalResult can still resolve the evidence.
    expect(outcome.result.evidence.map((ref) => ref.message_id)).toEqual(["m-1", "h-1", "h-2"]);
    expect(outcome.measured.history_excerpts).toBe(2);
    expect(outcome.result.status).toBe("partial");
  });

  it("drops a history hit whose project is not the project that was asked for", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "端口约定：8787。" });
    const fake = makeHistoryPort({ hits: [hit("zqleak A", "h-a"), hit("zqleak B", "h-b", PROJECT_B)] });

    const outcome = await layeredSearch({
      store,
      query: "端口",
      scope: projectA,
      include_history: true,
      history: fake.port,
    });

    expect(outcome.history.map((entry) => entry.source_ref.message_id)).toEqual(["h-a"]);
    expect(outcome.result.missing).toContain("history:project_mismatch:h-b");
    expect(outcome.layers.find((layer) => layer.layer === "history")?.emitted).toBe(1);
  });

  it("skips history for a global scope because there is no project path to compare", async () => {
    const store = newStore();
    seedMemory(store, {
      memory_id: "mem-global",
      scope: { kind: "global" },
      title: "全局端口约定",
      nav_text: "全局端口约定。",
    });
    const fake = makeHistoryPort({ hits: [hit("zqleak A", "h-a")] });

    const outcome = await layeredSearch({
      store,
      query: "端口",
      scope: { kind: "global" },
      include_history: true,
      history: fake.port,
    });

    const history = outcome.layers.find((layer) => layer.layer === "history");
    expect(history?.status).toBe("skipped");
    expect(history?.reason).toBe("history_requires_project_scope");
    expect(fake.calls.probe).toBe(0);
    expect(outcome.result.missing).toContain("history:requires_project_scope");
  });
});

describe("history layer: degraded sources", () => {
  it("reports an unavailable source without failing the search", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "端口约定：8787。" });
    const fake = makeHistoryPort({ available: false, reason: "index_missing" });

    const outcome = await layeredSearch({
      store,
      query: "端口",
      scope: projectA,
      include_history: true,
      history: fake.port,
    });

    const history = outcome.layers.find((layer) => layer.layer === "history");
    expect(history?.status).toBe("unavailable");
    expect(history?.reason).toBe("index_missing");
    expect(outcome.result.missing).toContain("history:unavailable:index_missing");
    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.cards.length).toBe(1);
    expect(outcome.measured.history_available).toBe(false);
    expect(fake.calls.search).toBe(0);
  });

  it("reports a failed search", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "端口约定：8787。" });
    const fake = makeHistoryPort({ search_failure: { status: "failed", reason: "cli_timeout" } });

    const outcome = await layeredSearch({
      store,
      query: "端口",
      scope: projectA,
      include_history: true,
      history: fake.port,
    });

    const history = outcome.layers.find((layer) => layer.layer === "history");
    expect(history?.status).toBe("failed");
    expect(history?.reason).toBe("cli_timeout");
    expect(outcome.result.missing).toContain("history:search_failed:cli_timeout");
  });

  it("contains a throwing port instead of letting the search fail", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "端口约定：8787。" });
    const fake = makeHistoryPort({ search_throws: "boom" });

    const outcome = await layeredSearch({
      store,
      query: "端口",
      scope: projectA,
      include_history: true,
      history: fake.port,
    });

    const history = outcome.layers.find((layer) => layer.layer === "history");
    expect(history?.status).toBe("failed");
    expect(outcome.result.missing).toContain("history:search_failed:boom");
  });

  it("reports a missing port instead of pretending history was searched", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "端口约定：8787。" });

    const outcome = await layeredSearch({ store, query: "端口", scope: projectA, include_history: true });
    const history = outcome.layers.find((layer) => layer.layer === "history");
    expect(history?.status).toBe("skipped");
    expect(history?.reason).toBe("history_port_missing");
    expect(outcome.result.missing).toContain("history:port_missing");
  });
});

describe("history layer: byte ceiling and the one bounded read", () => {
  it("stops adding excerpts at the byte ceiling and says so", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "端口约定：8787。" });
    const fake = makeHistoryPort({
      hits: [hit("a".repeat(200), "h-1"), hit("a".repeat(200), "h-2"), hit("a".repeat(200), "h-3")],
    });

    const outcome = await layeredSearch({
      store,
      query: "端口",
      scope: projectA,
      include_history: true,
      max_history_bytes: 500,
      history: fake.port,
    });

    expect(outcome.history.length).toBe(2);
    expect(outcome.result.missing).toContain("history:byte_cap_reached");
    const history = outcome.layers.find((layer) => layer.layer === "history");
    expect(history?.reason).toContain("history_byte_cap");
    expect(history?.candidates).toBe(3);
    expect(history?.emitted).toBe(2);
  });

  it("runs one bounded read-by-anchor only when asked and deduplicates", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "端口约定：8787。" });
    const top = hit("zqleak first message", "h-1");
    const fake = makeHistoryPort({
      hits: [top, hit("zqleak second message", "h-2")],
      messages: [historyMessage("zqleak first message", { source_ref: top.source_ref }), historyMessage("zqleak parent message", { source_ref: makeSourceRef({ message_id: "h-0", project_id: PROJECT_A }) })],
    });

    const outcome = await layeredSearch({
      store,
      query: "端口",
      scope: projectA,
      include_history: true,
      include_history_read: true,
      history: fake.port,
    });

    expect(fake.calls.readByAnchor).toBe(1);
    expect(fake.calls.last_read).toEqual({ anchor: "h-1", before: 2 });
    const read = outcome.history.filter((entry) => entry.via === "read");
    expect(read.map((entry) => entry.source_ref.message_id)).toEqual(["h-0"]);
    expect(outcome.layers.find((layer) => layer.layer === "history")?.read).toBe(true);
    expect(outcome.result.evidence.map((ref) => ref.message_id)).toEqual(["m-1", "h-1", "h-2", "h-0"]);
  });

  it("does not read when the search found nothing", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "端口约定：8787。" });
    const fake = makeHistoryPort({ hits: [] });

    const outcome = await layeredSearch({
      store,
      query: "端口",
      scope: projectA,
      include_history: true,
      include_history_read: true,
      history: fake.port,
    });

    expect(fake.calls.readByAnchor).toBe(0);
    const history = outcome.layers.find((layer) => layer.layer === "history");
    expect(history?.status).toBe("empty");
    expect(history?.read).toBe(false);
    expect(outcome.result.status).toBe("partial");
  });

  it("keeps the search result when only the read fails", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "端口约定：8787。" });
    const fake = makeHistoryPort({
      hits: [hit("zqleak first message", "h-1")],
      read_failure: { status: "failed", reason: "message_not_visible" },
    });

    const outcome = await layeredSearch({
      store,
      query: "端口",
      scope: projectA,
      include_history: true,
      include_history_read: true,
      history: fake.port,
    });

    const history = outcome.layers.find((layer) => layer.layer === "history");
    expect(history?.status).toBe("matched");
    expect(history?.read).toBe(true);
    expect(outcome.result.missing).toContain("history:read_failed:message_not_visible");
    expect(outcome.history.length).toBe(1);
  });
});
