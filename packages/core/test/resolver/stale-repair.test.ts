import { afterEach, describe, expect, it } from "vitest";
import { resolveMemory } from "../../src/resolver/index.js";
import type { StaleEventSummary } from "../../src/contracts/index.js";
import type { MemoryStore } from "../../src/storage/index.js";
import { bodyOfLength, makeScriptedModel } from "../extraction/support.js";
import { PROJECT_A, seedMemory } from "../retrieval/support.js";
import { openTempStore } from "../storage/support.js";
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

describe("an unconfirmed stale top hit keeps its warning", () => {
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
});

function citedStaleModel(memoryId: string, eventId: string) {
  return makeScriptedModel((kind) =>
    kind === "summary"
      ? { text: JSON.stringify({ body: bodyOfLength(600, eventId) }) }
      : {
          text: JSON.stringify({
            sufficient: true,
            answer: "端口现在是 9090。",
            evidence_ids: [memoryId],
            read_uris: [],
            next_queries: [],
            conflicts: [],
            descend: false,
          }),
        },
  );
}

describe("a stale card is delivered for the background pass", () => {
  it("delivers a cited stale card with its freshness instead of folding it in", async () => {
    const store = newStore();
    const memory = seedMemory(store, { memory_id: "mem-defer-cited" });
    const event = staleEvent(store, memory.memory_id, "m-71", "port changed to 9090", "2026-11-18T01:00:00Z");
    const model = citedStaleModel(memory.memory_id, event.event_id);
    const outcome = await resolveMemory({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      model_id: "scripted",
    });

    expect(outcome.result.status).toBe("resolved");
    const card = outcome.result.cards.find((entry) => entry.memory_id === memory.memory_id);
    expect(card?.freshness?.is_stale).toBe(true);
    expect(outcome.result.revision).toBeNull();
    expect(store.readMemory(memory.uri)?.revision).toBe(1);
    expect(store.countPendingStaleEvents(memory.memory_id)).toBe(1);
    expect(model.summary_calls).toBe(0);
  });

  it("keeps the unconfirmed stale top hit, its body and every pending event", async () => {
    const store = newStore();
    const memory = seedMemory(store, { memory_id: "mem-defer-top" });
    const event = staleEvent(store, memory.memory_id, "m-72", "the port changed to 9090", "2026-11-18T01:00:00Z");
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
              descend: false,
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

    expect(outcome.result.status).toBe("partial");
    const card = outcome.result.cards.find((entry) => entry.memory_id === memory.memory_id);
    expect(card?.freshness?.is_stale).toBe(true);
    expect(model.judge_calls).toBe(1);
    expect(model.summary_calls).toBe(0);
    expect(store.readMemory(memory.uri)?.revision).toBe(1);
    expect(store.listPendingStaleEvents(memory.memory_id)).toHaveLength(1);
  });
});
