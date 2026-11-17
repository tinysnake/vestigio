import { afterEach, describe, expect, it } from "vitest";
import { parseMemory } from "../../src/contracts/index.js";
import { readMemoryResult } from "../../src/retrieval/index.js";
import type { MemoryStore } from "../../src/storage/index.js";
import { bodyWith, openTempStore, seedMemory } from "./support.js";
import { navWith, storedMemory } from "../storage/support.js";

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

describe("readMemoryResult", () => {
  it("resolves a named memory with its full summary and no model call", () => {
    const store = newStore();
    const memory = seedMemory(store, { memory_id: "mem-0001", nav_text: "部署配置与默认端口。" });

    const outcome = readMemoryResult({ store, uri: memory.uri });
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.memory_summary).toBe(memory.medium.body);
    expect(outcome.result.memory_uri).toBe(memory.uri);
    expect(outcome.result.revision).toBe(1);
    expect(outcome.result.navigation_status).toBe("ready");
    expect(outcome.result.persistence_status).toBe("not_attempted");
    expect(outcome.result.cards.length).toBe(1);
    expect(outcome.result.cards[0]?.nav_text).toBe("部署配置与默认端口。");
    expect(outcome.result.cards[0]?.score).toBe(0);
    expect(outcome.result.evidence.length).toBe(1);
    expect(outcome.result.budget_used.model_calls).toBe(0);
    expect(outcome.measured.estimated_tokens).toBe(Math.ceil(outcome.measured.result_bytes / 4));
    expect(outcome.memory_uri).toBe(memory.uri);
  });

  it("reads a named revision while the head has moved on", () => {
    const store = newStore();
    const first = seedMemory(store, { memory_id: "mem-0001", nav_text: "第一版端口约定。" });
    const second = parseMemory(
      storedMemory({
        memory_id: "mem-0001",
        revision: 2,
        body: bodyWith("第二版端口约定。"),
        nav: navWith("第二版端口约定。", 2),
        updated_at: "2026-11-17T17:00:00Z",
      }),
    );
    store.saveMemory(second);

    const atOne = readMemoryResult({ store, uri: first.uri, revision: 1 });
    expect(atOne.result.revision).toBe(1);
    expect(atOne.result.memory_summary).toBe(first.medium.body);

    const head = readMemoryResult({ store, uri: first.uri });
    expect(head.result.revision).toBe(2);
    expect(head.result.memory_summary).toBe(second.medium.body);
  });

  it("resolves a medium_ready memory with its summary and a pending navigation", () => {
    const store = newStore();
    const memory = seedMemory(store, { memory_id: "mem-draft", nav_text: null, state: "medium_ready" });

    const outcome = readMemoryResult({ store, uri: memory.uri });
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.navigation_status).toBe("pending");
    expect(outcome.result.cards).toEqual([]);
    expect(outcome.result.memory_summary).toBe(memory.medium.body);
  });

  it("reports not_found for an unknown memory without inventing cards", () => {
    const store = newStore();
    const outcome = readMemoryResult({ store, uri: "memory://vestigio/mem-9999" });
    expect(outcome.result.status).toBe("not_found");
    expect(outcome.result.memory_summary).toBeNull();
    expect(outcome.result.memory_uri).toBeNull();
    expect(outcome.result.revision).toBeNull();
    expect(outcome.result.cards).toEqual([]);
    expect(outcome.result.missing).toEqual(["memory_not_found:memory://vestigio/mem-9999"]);
    expect(outcome.memory_uri).toBeNull();
  });

  it("reads an archived memory by name and says which layer it came from", () => {
    const store = newStore();
    const memory = seedMemory(store, {
      memory_id: "mem-archived",
      nav_text: "归档的端口约定。",
      state: "archived",
    });

    const outcome = readMemoryResult({ store, uri: memory.uri });
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.cards[0]?.state).toBe("archived");
    expect(outcome.measured.archived_cards).toBe(1);
    expect(outcome.measured.active_cards).toBe(0);
  });
});
