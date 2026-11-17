import { describe, expect, it } from "vitest";
import { makeFakeMemory } from "./support.js";
import {
  InjectionLedger,
  commitInjection,
  planInjection,
  recordMemoryRead,
  recordSearchHits,
  type PlanInjectionInput,
} from "../../src/hotspots/index.js";
import { FakeStore, NOW, PROJECT, newStore, seedMemory, setActivity } from "./support.js";

const INPUT_ID = "input-1";

function plan(
  overrides: Partial<PlanInjectionInput> & Pick<PlanInjectionInput, "store" | "text" | "ledger">,
): ReturnType<typeof planInjection> {
  return planInjection({
    project_id: PROJECT,
    session_id: "s-1",
    branch_ref: "main",
    input_id: INPUT_ID,
    ...overrides,
  });
}

function seedPair() {
  const store = newStore();
  seedMemory(store, { memory_id: "mem-a" });
  seedMemory(store, {
    memory_id: "mem-b",
    title: "流水线并发上限",
    keywords: ["流水线"],
    nav: "流水线并发上限与排队策略，改并发时需要读取。",
  });
  setActivity(store, PROJECT, 4);
  return store;
}

describe("planInjection", () => {
  it("appends the block to the end of the same user input", () => {
    const store = seedPair();
    const text = "部署 端口 改了";
    const result = plan({ store, text, ledger: new InjectionLedger() });
    expect(result.status).toBe("injected");
    expect(result.reason).toBeNull();
    expect(result.text.startsWith(text)).toBe(true);
    expect(result.text).toBe(`${text}\n\n${result.block}`);
    expect(result.block?.endsWith("</vestigio_memory_note>")).toBe(true);
    expect(result.injected.map((it) => it.memory_id)).toEqual(["mem-a"]);
    expect(result.budget.used_bytes).toBeLessThanOrEqual(result.budget.limit_bytes);
    expect(result.elapsed_ms).toBeLessThan(result.timeout_ms);
    store.close();
  });

  it("notes a host command instead of rewriting it", () => {
    const store = seedPair();
    const text = "/skill:probe-skill 部署 端口";
    const result = plan({ store, text, ledger: new InjectionLedger(), host_command: true });
    expect(result.status).toBe("not_injected");
    expect(result.reason).toBe("slash_command");
    expect(result.text).toBe(text);
    expect(result.block).toBeNull();
    store.close();
  });

  it("treats a leading slash as plain text when the host does not declare a command", () => {
    const store = seedPair();
    const result = plan({ store, text: "/部署 端口", ledger: new InjectionLedger() });
    expect(result.status).toBe("injected");
    expect(result.text?.startsWith("/部署 端口\n")).toBe(true);
    store.close();
  });

  it("refuses to match its own extension message", () => {
    const store = seedPair();
    const result = plan({ store, text: "部署 端口", ledger: new InjectionLedger(), source: "extension" });
    expect(result.reason).toBe("extension_source");
    store.close();
  });

  it("is a clean no-op for empty input, a missing store and a missing pool", () => {
    const store = seedPair();
    expect(plan({ store, text: "   ", ledger: new InjectionLedger() }).reason).toBe("empty_input");
    expect(plan({ store: null, text: "部署 端口", ledger: new InjectionLedger() }).reason).toBe(
      "store_unavailable",
    );
    const empty = newStore();
    setActivity(empty, PROJECT, 1);
    expect(plan({ store: empty, text: "部署 端口", ledger: new InjectionLedger() }).reason).toBe(
      "no_pool_members",
    );
    expect(plan({ store, text: "完全无关的一句话", ledger: new InjectionLedger() }).reason).toBe("no_match");
    store.close();
    empty.close();
  });
});

describe("Session dedup", () => {
  it("injects one memory at most once per turn even when several aliases hit", () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-a", keywords: ["部署", "端口", "deploy"] });
    setActivity(store, PROJECT, 3);
    const result = plan({ store, text: "deploy 部署 端口", ledger: new InjectionLedger() });
    expect(result.matched).toHaveLength(1);
    expect(result.injected).toHaveLength(1);
    expect(result.block?.match(/\[1\]/gu)).toHaveLength(1);
    store.close();
  });

  it("does not re-inject a memory already delivered in this Session", () => {
    const store = seedPair();
    const ledger = new InjectionLedger();
    const first = plan({ store, text: "部署 端口", ledger });
    commitInjection({ plan: first, store, ledger, at: NOW, activity_seq: 4 });
    expect(ledger.has("mem-a")).toBe(true);

    const second = plan({ store, text: "部署 端口", ledger, input_id: "input-2" });
    expect(second.status).toBe("not_injected");
    expect(second.reason).toBe("all_deduped");
    expect(second.matched.map((it) => it.memory_id)).toEqual(["mem-a"]);
    store.close();
  });

  it("survives a restart by replaying the persisted deltas, with the receipt durable", () => {
    const store = seedPair();
    const ledger = new InjectionLedger();
    const first = plan({ store, text: "部署 端口", ledger });
    const committed = commitInjection({ plan: first, store, ledger, at: NOW, activity_seq: 4 });
    expect(committed.receipts).toBe(1);
    expect(committed.ledger_added).toEqual(["mem-a"]);
    expect(committed.delta).toEqual({ at: NOW, input_id: INPUT_ID, memory_ids: ["mem-a"] });

    // Restart: the ledger is rebuilt from the deltas the host persisted.
    const restored = InjectionLedger.replay([committed.delta!]);
    const afterRestart = plan({ store, text: "部署 端口", ledger: restored, input_id: "input-2" });
    expect(afterRestart.reason).toBe("all_deduped");
    expect(store.hasInjectionReceipt("s-1", "main", INPUT_ID, "mem-a")).toBe(true);
    store.close();
  });

  it("keeps a deduped match visible for statistics while injecting only the fresh one", () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-a" });
    seedMemory(store, {
      memory_id: "mem-b",
      title: "流水线并发上限",
      keywords: ["流水线"],
      nav: "流水线并发上限与排队策略，改并发时需要读取。",
    });
    setActivity(store, PROJECT, 2);
    const ledger = InjectionLedger.fromIds(["mem-a"], NOW);
    const result = plan({ store, text: "部署 端口 流水线", ledger });
    expect(result.matched.map((it) => it.memory_id).sort()).toEqual(["mem-a", "mem-b"]);
    expect(result.injected.map((it) => it.memory_id)).toEqual(["mem-b"]);
    const commit = commitInjection({ plan: result, store, ledger, at: NOW, activity_seq: 2 });
    expect(commit.hit_events).toBe(2);
    expect(commit.receipts).toBe(1);
    expect(commit.ledger_added).toEqual(["mem-b"]);
    expect(commit.delta).toEqual({ at: NOW, input_id: INPUT_ID, memory_ids: ["mem-b"] });
    store.close();
  });
});

describe("commit failures", () => {
  it("does not suppress a later injection when the receipt write fails", () => {
    const fake = new FakeStore();
    const memory = makeFakeMemory({ memory_id: "mem-a" });
    fake.memories.set(memory.uri, memory);
    fake.upsertHotspotMembership({
      project_id: PROJECT,
      memory_id: "mem-a",
      admitted_seq: 1,
      last_hit_seq: 0,
      last_access_seq: 0,
      recent_hit_weight: 0,
      recent_access_weight: 0,
    });
    fake.receiptError = new Error("send failed");

    const ledger = new InjectionLedger();
    const first = plan({ store: fake, text: "部署 端口", ledger });
    const commit = commitInjection({ plan: first, store: fake, ledger, at: NOW, activity_seq: 1 });
    expect(commit.receipts).toBe(0);
    expect(commit.ledger_added).toEqual([]);
    expect(commit.delta).toBeNull();
    expect(commit.delivered).toEqual([]);
    expect(commit.errors[0]).toContain("send failed");
    expect(ledger.has("mem-a")).toBe(false);

    fake.receiptError = null;
    const retry = plan({ store: fake, text: "部署 端口", ledger, input_id: "input-2" });
    expect(retry.status).toBe("injected");
    expect(retry.injected.map((it) => it.memory_id)).toEqual(["mem-a"]);
  });

  it("counts a duplicate event id instead of failing the turn", () => {
    const fake = new FakeStore();
    const memory = makeFakeMemory({ memory_id: "mem-a" });
    fake.memories.set(memory.uri, memory);
    fake.upsertHotspotMembership({
      project_id: PROJECT,
      memory_id: "mem-a",
      admitted_seq: 1,
      last_hit_seq: 0,
      last_access_seq: 0,
      recent_hit_weight: 0,
      recent_access_weight: 0,
    });
    const firstPlan = plan({ store: fake, text: "部署 端口", ledger: new InjectionLedger() });
    const first = commitInjection({
      plan: firstPlan,
      store: fake,
      ledger: new InjectionLedger(),
      at: NOW,
      activity_seq: 1,
    });
    expect(first.hit_events).toBe(1);
    expect(first.duplicate_hit_events).toBe(0);

    const second = commitInjection({
      plan: firstPlan,
      store: fake,
      ledger: new InjectionLedger(),
      at: NOW,
      activity_seq: 1,
    });
    expect(second.hit_events).toBe(0);
    expect(second.duplicate_hit_events).toBe(1);
    expect(second.receipts).toBe(0);
    expect(second.errors.join(" ")).toContain("duplicate_injection_receipt");
  });

  it("commits nothing for a budget exclusion and still injects on the next turn", () => {
    const store = seedPair();
    const ledger = new InjectionLedger();
    const excluded = plan({ store, text: "部署 端口", ledger, budget_bytes: 1 });
    expect(excluded.status).toBe("not_injected");
    expect(excluded.reason).toBe("over_budget");
    expect(excluded.matched).toHaveLength(1);
    const commit = commitInjection({ plan: excluded, store, ledger, at: NOW, activity_seq: 4 });
    expect(commit).toEqual({
      hit_events: 0,
      duplicate_hit_events: 0,
      receipts: 0,
      membership_hits: 0,
      ledger_added: [],
      delivered: [],
      delta: null,
      errors: [],
    });
    const next = plan({ store, text: "部署 端口", ledger, input_id: "input-2" });
    expect(next.status).toBe("injected");
    store.close();
  });
});

describe("the one second ceiling", () => {
  it("abandons the turn and records the reason when a read blows the deadline", () => {
    const fake = new FakeStore();
    const memory = makeFakeMemory({ memory_id: "mem-a" });
    fake.memories.set(memory.uri, memory);
    fake.upsertHotspotMembership({
      project_id: PROJECT,
      memory_id: "mem-a",
      admitted_seq: 1,
      last_hit_seq: 0,
      last_access_seq: 0,
      recent_hit_weight: 0,
      recent_access_weight: 0,
    });
    let clock = 0;
    fake.onReadMemory = () => {
      clock += 1500;
    };
    const text = "部署 端口";
    const result = plan({ store: fake, text, ledger: new InjectionLedger(), now: () => clock });
    expect(result.status).toBe("not_injected");
    expect(result.reason).toBe("timeout");
    expect(result.text).toBe(text);
    expect(result.block).toBeNull();
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(result.timeout_ms);

    // Positive control: the same pool with a clock that does not advance injects.
    const ok = plan({ store: fake, text, ledger: new InjectionLedger(), now: () => 0 });
    expect(ok.status).toBe("injected");
  });
});

describe("statistics writers", () => {
  it("records search hits and one access per successful read", () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-a" });
    const searchHits = recordSearchHits({
      store,
      session_id: "s-1",
      input_id: "tool-1",
      at: NOW,
      hits: [{ memory_id: "mem-a", revision: 1 }],
    });
    expect(searchHits).toBe(1);
    expect(recordSearchHits({
      store,
      session_id: "s-1",
      input_id: "tool-1",
      at: NOW,
      hits: [{ memory_id: "mem-a", revision: 1 }],
    })).toBe(0);

    const read = recordMemoryRead({
      store,
      project_id: PROJECT,
      session_id: "s-1",
      input_id: "tool-2",
      at: NOW,
      memory_id: "mem-a",
      revision: 1,
      activity_seq: 9,
    });
    expect(read.recorded).toBe(true);
    expect(read.membership).toBe(true);
    const memory = store.readMemory("memory://vestigio/mem-a");
    expect(memory?.hit_count).toBe(1);
    expect(memory?.access_count).toBe(1);
    expect(memory?.last_access_at).toBe(NOW);
    store.close();
  });
});
