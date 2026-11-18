import { afterEach, describe, expect, it } from "vitest";
import { resolveMemory } from "../../src/resolver/index.js";
import type { StaleEventSummary } from "../../src/contracts/index.js";
import type { MemoryStore } from "../../src/storage/index.js";
import { bodyOfLength, makeScriptedModel, judgeScript } from "../extraction/support.js";
import {
  HISTORY_DECISION_TEXT,
  PROJECT_A,
  historyHit,
  historyMessage,
  makeHistoryPort,
  seedMemory,
} from "../retrieval/support.js";
import { navWith, openTempStore } from "../storage/support.js";
import { makeSourceRef } from "../support.js";

const stores: MemoryStore[] = [];

function newStore(): MemoryStore {
  const store = openTempStore();
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

const projectA = { kind: "project", project_id: PROJECT_A } as const;
const QUESTION = "默认端口是多少";

function staleEvent(
  store: MemoryStore,
  memory_id: string,
  messageId: string,
  excerpt: string,
  at: string,
): StaleEventSummary {
  return store.markStale({
    memory_id,
    observed_revision: 1,
    reason: "端口后来改了",
    excerpt,
    sources: [
      makeSourceRef({
        provider: "obelisk",
        source_instance: "fixture",
        session_id: "sessA",
        message_id: messageId,
        project_id: PROJECT_A,
      }),
    ],
    producer: "detector",
    at,
  }).event;
}

function summaryRequestOf(model: ReturnType<typeof makeScriptedModel>) {
  return model.requests.find((request) => request.messages[0]?.content.includes("中期摘要"));
}

describe("a stale saved request is never replayed as fresh", () => {
  it("re-runs retrieval repair on the same memory instead of returning the cached body", async () => {
    const store = newStore();
    const hit = historyHit(HISTORY_DECISION_TEXT);
    const request_id = "req-stale-replay";

    const first = await resolveMemory({
      store,
      question: QUESTION,
      scope: projectA,
      model: makeScriptedModel(judgeScript(hit.source_ref.message_id)).port,
      model_id: "scripted",
      history: makeHistoryPort({ hits: [hit] }).port,
      request_id,
    });
    const uri = first.result.memory_uri;
    if (uri === null) throw new Error("expected the first resolve to save a memory");
    const head = store.listHeads(projectA)[0];
    if (head === undefined) throw new Error("expected one head");

    store.setNavigation(uri, 1, navWith("默认端口与回滚方式，改端口前值得读。"));

    const event = staleEvent(store, head.memory_id, "m-99", "the default port changed to 9090", "2026-11-18T04:00:00Z");

    const secondModel = makeScriptedModel((kind) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(600, event.event_id) }) }
        : {
            text: JSON.stringify({
              sufficient: true,
              answer: "端口现在是 9090。",
              evidence_ids: [head.memory_id],
              read_uris: [],
              next_queries: [],
              conflicts: [],
              descend: false,
            }),
          },
    );
    const second = await resolveMemory({
      store,
      question: QUESTION,
      scope: projectA,
      model: secondModel.port,
      model_id: "scripted",
      history: makeHistoryPort({ hits: [hit] }).port,
      request_id,
    });

    // The cached replay would have spent no summary call and returned rev 1.
    expect(secondModel.summary_calls).toBe(1);
    expect(second.persistence).toBeNull();
    expect(second.result.memory_uri).toBe(uri);
    expect(second.result.revision).toBe(2);
    expect(second.result.memory_summary).toBe(bodyOfLength(600, event.event_id));
    expect(second.result.freshness?.pending_count).toBe(0);
    expect(store.countMemories()).toBe(1);
    expect(store.listHeads(projectA)).toHaveLength(1);
  });
});

describe("an unconfirmed stale top hit is repaired, not descended past", () => {
  it("returns the moved-head warning without persisting a duplicate topic", async () => {
    const store = newStore();
    const memory = seedMemory(store, { memory_id: "mem-moved-stale" });
    staleEvent(store, memory.memory_id, "m-race", "port changed", "2026-11-18T01:00:00Z");
    const model = makeScriptedModel(() => {
      store.saveMemory({ ...memory, revision: 2, state: "medium_ready", nav: null });
      return { text: JSON.stringify({ sufficient: true, answer: "读取到旧版端口。", evidence_ids: [memory.memory_id], read_uris: [], next_queries: [], conflicts: [], descend: false }) };
    });
    const result = await resolveMemory({ store, question: "端口", scope: projectA, model: model.port, model_id: "scripted" });
    expect(result.result.freshness?.revision_mismatch).toBe(true);
    expect(result.result.freshness?.head_revision).toBe(2);
    expect(result.result.next_action).toContain("memory_read");
    expect(store.countMemories()).toBe(1);
    expect(store.countPendingStaleEvents(memory.memory_id)).toBe(1);
    expect(model.summary_calls).toBe(0);
  });
  it("folds pending evidence when the judge answers sufficient:false", async () => {
    const store = newStore();
    const memory = seedMemory(store, { memory_id: "mem-insufficient-stale" });
    const event = staleEvent(store, memory.memory_id, "m-50", "the port changed to 9090", "2026-11-18T01:00:00Z");

    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(600, event.event_id) }) }
        : {
            text: JSON.stringify({
              sufficient: false,
              answer: null,
              evidence_ids: [],
              read_uris: [],
              next_queries: [],
              conflicts: [],
              descend: true,
            }),
          },
    );

    const outcome = await resolveMemory({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      model_id: "scripted",
    });

    // The stale top hit is repaired on the first pass; the walk never descends.
    expect(model.judge_calls).toBe(1);
    expect(model.summary_calls).toBe(1);
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.memory_uri).toBe(memory.uri);
    expect(outcome.result.revision).toBe(2);
    expect(outcome.result.memory_summary).toBe(bodyOfLength(600, event.event_id));
    expect(outcome.result.persistence_status).toBe("saved");
    expect(outcome.result.navigation_status).toBe("pending");
    expect(outcome.result.freshness?.pending_count).toBe(0);
    expect(outcome.calls.some((call) => call.purpose === "medium_summary")).toBe(true);
    expect(store.listHeads(projectA)).toHaveLength(1);
  });

  it("keeps the stale body and its warning when the repair model fails", async () => {
    const store = newStore();
    const memory = seedMemory(store, { memory_id: "mem-insufficient-failed" });
    const event = staleEvent(store, memory.memory_id, "m-51", "the port changed to 9090", "2026-11-18T01:00:00Z");

    const model = makeScriptedModel(
      () => ({
        text: JSON.stringify({
          sufficient: false,
          answer: null,
          evidence_ids: [],
          read_uris: [],
          next_queries: [],
          conflicts: [],
          descend: true,
        }),
      }),
      { fail_summary: true },
    );

    const outcome = await resolveMemory({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      model_id: "scripted",
    });

    expect(model.judge_calls).toBe(1);
    expect(model.summary_calls).toBe(1);
    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.revision).toBe(1);
    expect(outcome.result.memory_uri).toBe(memory.uri);
    expect(outcome.result.memory_summary).toBe(memory.medium.body);
    expect(outcome.result.freshness?.is_stale).toBe(true);
    expect(outcome.result.freshness?.pending_count).toBe(1);
    expect(store.countPendingStaleEvents(memory.memory_id)).toBe(1);
    expect(store.listHeads(projectA)).toHaveLength(1);
    void event;
  });
});

describe("repair reads the pending anchor before it summarizes", () => {
  it("reads the anchor's timeline through its locator and feeds the reply in", async () => {
    const store = newStore();
    const memory = seedMemory(store, { memory_id: "mem-locator" });
    const pendingAnchor = makeSourceRef({
      provider: "obelisk",
      source_instance: "fixture",
      session_id: "sessA",
      message_id: "m-pending",
      project_id: PROJECT_A,
    });
    const event = staleEvent(store, memory.memory_id, "m-pending", "SAVED-EXCERPT-9090", "2026-11-18T01:00:00Z");

    const history = makeHistoryPort({
      hits: [historyHit(HISTORY_DECISION_TEXT, { source_ref: pendingAnchor })],
      timeline_messages: [historyMessage("FRESH-REPLY-9090")],
    });
    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(600, event.event_id) }) }
        : {
            text: JSON.stringify({
              sufficient: false,
              answer: null,
              evidence_ids: [],
              read_uris: [],
              next_queries: [],
              conflicts: [],
              descend: true,
            }),
          },
    );

    const outcome = await resolveMemory({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      model_id: "scripted",
      history: history.port,
    });

    expect(history.calls.readByAnchor).toBe(1);
    expect(history.calls.last_read?.anchor).toBe("m-pending");
    expect(history.calls.last_read?.relation).toBe("timeline");
    expect(history.calls.last_read?.after).toBeGreaterThan(0);
    const summary = summaryRequestOf(model);
    if (summary === undefined) throw new Error("expected a summary request");
    expect(JSON.stringify(summary.messages)).toContain("FRESH-REPLY-9090");
    expect(outcome.result.revision).toBe(2);
    expect(outcome.result.memory_summary).toBe(bodyOfLength(600, event.event_id));
  });

  it("falls back to the saved excerpt when the anchor read fails", async () => {
    const store = newStore();
    const memory = seedMemory(store, { memory_id: "mem-locator-fallback" });
    const event = staleEvent(store, memory.memory_id, "m-pending", "SAVED-EXCERPT-9090", "2026-11-18T01:00:00Z");
    const history = makeHistoryPort({ read_failure: { status: "failed", reason: "down" } });
    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(600, event.event_id) }) }
        : {
            text: JSON.stringify({
              sufficient: false,
              answer: null,
              evidence_ids: [],
              read_uris: [],
              next_queries: [],
              conflicts: [],
              descend: true,
            }),
          },
    );

    const outcome = await resolveMemory({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      model_id: "scripted",
      history: history.port,
    });

    expect(history.calls.readByAnchor).toBe(1);
    const summary = summaryRequestOf(model);
    if (summary === undefined) throw new Error("expected a summary request");
    expect(JSON.stringify(summary.messages)).toContain("SAVED-EXCERPT-9090");
    expect(outcome.result.revision).toBe(2);
    expect(outcome.result.memory_summary).toBe(bodyOfLength(600, event.event_id));
  });

  it("caps the targeted reads instead of reading every pending anchor", async () => {
    const store = newStore();
    const memory = seedMemory(store, { memory_id: "mem-locator-bounded" });
    const first = staleEvent(store, memory.memory_id, "m-1", "first change", "2026-11-18T01:00:00Z");
    staleEvent(store, memory.memory_id, "m-2", "second change", "2026-11-18T02:00:00Z");
    staleEvent(store, memory.memory_id, "m-3", "third change", "2026-11-18T03:00:00Z");
    const history = makeHistoryPort({ timeline_messages: [historyMessage("FRESH-REPLY")] });
    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(600, first.event_id) }) }
        : {
            text: JSON.stringify({
              sufficient: false,
              answer: null,
              evidence_ids: [],
              read_uris: [],
              next_queries: [],
              conflicts: [],
              descend: true,
            }),
          },
    );

    const outcome = await resolveMemory({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      model_id: "scripted",
      history: history.port,
    });

    expect(history.calls.readByAnchor).toBe(2);
    expect(outcome.result.revision).toBe(2);
  });
});
