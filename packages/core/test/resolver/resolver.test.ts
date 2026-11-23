/**
 * PR-06 unit tests for `memory.resolve`.
 *
 * The store is real (a temp SQLite file) and the history port is the shared fake
 * pattern; only the chat port is a stub, so the tests exercise the real
 * orchestration, the real layered search and the real contract validation.
 *
 * Covered on purpose:
 * - Active sufficiency stops before Archived and before the history port.
 * - Archived sufficiency stops before the history port.
 * - The three-call ceiling, the input/output token ceilings and the evidence
 *   ceiling stop the work and say why.
 * - A malformed structured answer gets exactly one retry, then stops.
 * - A continuation is reused only for the same scope and question, and only
 *   before it expires.
 * - Insufficient evidence never becomes a confident answer.
 * - Cancellation reaches the in-flight model call.
 * - The warm deadline binds, and a cold history refresh earns the longer one.
 */

import { afterEach, describe, expect, it } from "vitest";
import { parseBudgetUsed, parseRetrievalResult } from "../../src/contracts/index.js";
import type { HistoryHit, HistoryPort } from "../../src/retrieval/index.js";
import type { ModelPort, ModelRequest, ModelResult, ResolveInput } from "../../src/resolver/index.js";
import { resolveMemory, RESOLVE_MAX_OUTPUT_TOKENS_PER_CALL } from "../../src/resolver/index.js";
import type { MemoryStore } from "../../src/storage/index.js";
import { PROJECT_A, PROJECT_B, historyHit, makeHistoryPort, openTempStore, seedMemory } from "../retrieval/support.js";

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
const projectB = { kind: "project", project_id: PROJECT_B } as const;

// ---- fake chat port ---------------------------------------------------------

type Reply =
  | { text: string }
  | { fail: "unavailable" | "failed" | "cancelled"; reason: string }
  | { throw: string }
  | { delay_ms: number; text: string };

type FakeModel = {
  port: ModelPort;
  requests: ModelRequest[];
  calls: number;
  saw_abort: boolean;
};

function judgeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sufficient: false,
    answer: null,
    evidence_ids: [],
    read_uris: [],
    next_queries: [],
    conflicts: [],
    descend: false,
    ...overrides,
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function makeModel(replies: Reply[], fallback: Reply = { text: judgeJson() }): FakeModel {
  const state: FakeModel = {
    requests: [],
    calls: 0,
    saw_abort: false,
    port: {
      async complete(request: ModelRequest): Promise<ModelResult> {
        const reply = replies[state.calls] ?? fallback;
        state.calls += 1;
        state.requests.push(request);
        if ("throw" in reply) throw new Error(reply.throw);
        if ("fail" in reply) return { ok: false, status: reply.fail, reason: reply.reason };
        if ("delay_ms" in reply) {
          await sleep(reply.delay_ms, request.signal);
          if (request.signal.aborted) {
            state.saw_abort = true;
            return { ok: false, status: "cancelled", reason: "aborted" };
          }
          return { ok: true, value: response(reply.text) };
        }
        if (request.signal.aborted) {
          state.saw_abort = true;
          return { ok: false, status: "cancelled", reason: "aborted" };
        }
        return { ok: true, value: response(reply.text) };
      },
    },
  };
  return state;
}

function response(text: string): { text: string; model: string; finish_reason: string; usage: { tokens_in: number; tokens_out: number; cost_usd: number } } {
  return { text, model: "stub", finish_reason: "stop", usage: { tokens_in: 100, tokens_out: 20, cost_usd: 0.001 } };
}

// ---- fake history port ------------------------------------------------------

function makeTimedHistoryPort(elapsedMs: number, hits: HistoryHit[] = []): { port: HistoryPort; searches: number; reads: number; texts: string[] } {
  let searches = 0;
  let reads = 0;
  const texts: string[] = [];
  const port: HistoryPort = {
    async probe() {
      return { available: true, reason: null };
    },
    async search(input) {
      searches += 1;
      texts.push(input.text);
      return { ok: true, value: { hits, evidence: "resolved", elapsed_ms: elapsedMs } };
    },
    async readByAnchor(_input) {
      reads += 1;
      const anchor = hits[0]?.source_ref ?? historyHit("anchor").source_ref;
      return {
        ok: true,
        value: { anchor, messages: [], has_more: false, elapsed_ms: elapsedMs },
      };
    },
  };
  return {
    port,
    get searches() {
      return searches;
    },
    get reads() {
      return reads;
    },
    texts,
  };
}

async function resolve(options: ResolveInput) {
  const outcome = await resolveMemory(options);
  // Every result must be a frozen-contract-valid object.
  parseRetrievalResult(outcome.result);
  parseBudgetUsed(outcome.result.budget_used);
  return outcome;
}

describe("memory.resolve: descent and sufficiency", () => {
  it("resolves from Active and never consults Archived or the history port", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active", title: "deploy default port", keywords: ["deploy", "port"], nav_text: "deploy default port is 8787" });
    const model = makeModel([{ text: judgeJson({ sufficient: true, answer: "The default port is 8787.", evidence_ids: ["mem-active"] }) }]);
    const history = makeTimedHistoryPort(1);

    const outcome = await resolve({ store, question: "deploy default port", scope: projectA, model: model.port, history: history.port });

    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.answer).toContain("8787");
    expect(outcome.calls).toHaveLength(1);
    expect(model.calls).toBe(1);
    expect(history.searches).toBe(0);
    expect(outcome.layers.find((layer) => layer.layer === "archived")?.status).toBe("skipped");
    expect(outcome.measured.model_calls).toBe(1);
    expect(outcome.result.evidence.length).toBeGreaterThan(0);
  });

  it("resolves from Archived and never searches raw history", async () => {
    const store = newStore();
    seedMemory(store, {
      memory_id: "mem-archived",
      title: "archived port agreement",
      keywords: ["port"],
      nav_text: "archived port agreement says 9090",
      state: "archived",
    });
    const model = makeModel([
      { text: judgeJson({ descend: true }) },
      { text: judgeJson({ sufficient: true, answer: "The archived agreement says 9090.", evidence_ids: ["mem-archived"] }) },
    ]);
    const history = makeTimedHistoryPort(1, [historyHit("raw history filler")]);

    const outcome = await resolve({ store, question: "port", scope: projectA, model: model.port, history: history.port });

    expect(outcome.result.status).toBe("resolved");
    expect(model.calls).toBe(2);
    expect(history.searches).toBe(0);
    expect(outcome.measured.cold).toBe(false);
  });

  it("stops at the three-call ceiling and says why", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口，改端口前值得读取。" });
    const model = makeModel([
      { text: "not json" },
      { text: judgeJson({ descend: true, next_queries: ["端口"] }) },
      { text: judgeJson({ descend: true }) },
    ]);

    const outcome = await resolve({ store, question: "端口", scope: projectA, model: model.port });

    expect(outcome.calls).toHaveLength(3);
    expect(outcome.result.budget_used.model_calls).toBe(3);
    expect(outcome.result.status).not.toBe("resolved");
    expect(outcome.result.missing).toContain("model_call_cap");
    expect(outcome.layers.find((layer) => layer.layer === "history")?.status).toBe("skipped");
  });

  it("blames the model's stop rather than the ceiling when a layer is still left", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口，改端口前值得读取。" });
    const model = makeModel([
      { text: judgeJson({ descend: true }) },
      { text: "not json" },
      { text: judgeJson({ descend: false }) },
    ]);

    const outcome = await resolve({ store, question: "端口", scope: projectA, model: model.port });

    expect(model.calls).toBe(3);
    expect(outcome.result.missing).toContain("evidence_insufficient");
    expect(outcome.result.missing).not.toContain("model_call_cap");
    expect(outcome.layers.find((layer) => layer.layer === "history")?.status).toBe("skipped");
  });

  it("reports a walk that covered every layer as an evidence gap, not as a truncated budget", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const model = makeModel([], { text: judgeJson({ descend: true }) });

    const outcome = await resolve({ store, question: "nothing here", scope: projectA, model: model.port });

    expect(model.calls).toBe(3);
    expect(outcome.result.status).toBe("not_found");
    expect(outcome.result.missing).toContain("evidence_insufficient");
    expect(outcome.result.missing).not.toContain("model_call_cap");
  });

  it("reports an honest gap without calling the model when the scope holds nothing", async () => {
    const store = newStore();
    const model = makeModel([{ text: judgeJson({}) }]);

    const outcome = await resolve({ store, question: "nothing here", scope: projectA, model: model.port });

    expect(model.calls).toBe(0);
    expect(outcome.result.status).toBe("not_found");
    expect(outcome.result.cards).toEqual([]);
    expect(outcome.result.answer).toBeNull();
    expect(outcome.result.missing).toContain("empty_scope");
    expect(outcome.result.missing).toContain("no_candidates_gathered");
    expect(outcome.layers).toEqual([]);
  });

  it("still walks when raw history can answer without a stored memory", async () => {
    const history = makeTimedHistoryPort(1, [historyHit("the raw decision was to keep port 8787")]);
    const model = makeModel([], { text: judgeJson({ descend: true }) });

    const outcome = await resolve({ store: newStore(), question: "deploy port", scope: projectA, model: model.port, history: history.port });

    expect(history.searches).toBe(1);
    expect(outcome.result.missing).not.toContain("empty_scope");
    // The memory layers held no candidate to judge, so the only model call is
    // the history layer's.
    expect(model.calls).toBe(1);
    expect(outcome.calls.map((call) => call.layer)).toEqual(["history"]);
  });

  it("retries an unreadable answer instead of leaving the last layer unjudged", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口，改端口前值得读取。" });
    const hit = historyHit("the raw decision was to keep port 8787");
    const history = makeTimedHistoryPort(1, [hit]);
    const model = makeModel([
      { text: judgeJson({ descend: true, next_queries: ["部署", "并发"] }) },
      { text: judgeJson({ descend: true }) },
      // A long reply cut off at the token ceiling. The ledger is now at its
      // three-call limit, and this is exactly the case where the retry used to
      // be refused before it could replace a judgement that never happened.
      { text: '{"sufficient": true, "answer": "the port is 87' },
      { text: judgeJson({ sufficient: true, answer: "8787", evidence_ids: [hit.source_ref.message_id] }) },
    ]);

    const outcome = await resolve({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      history: history.port,
      defer_persistence: true,
    });

    expect(outcome.calls.map((call) => `${call.layer}/${call.outcome}`)).toEqual([
      "active/ok",
      "active/ok",
      "history/malformed",
      "history/ok",
    ]);
    expect(model.calls).toBe(4);
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.answer).toBe("8787");
  });

  it("retries an unreadable answer once, never twice", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口，改端口前值得读取。" });
    const model = makeModel([
      { text: judgeJson({ descend: true }) },
      { text: judgeJson({ descend: true }) },
      { text: '{"sufficient": true, "answer": "cut' },
      { text: '{"sufficient": true, "answer": "cut ag' },
      { text: judgeJson({ sufficient: true, answer: "8787", evidence_ids: ["h-1"] }) },
    ]);
    const history = makeTimedHistoryPort(1, [historyHit("the raw decision was to keep port 8787")]);

    const outcome = await resolve({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      history: history.port,
      defer_persistence: true,
    });

    expect(model.calls).toBe(4);
    expect(outcome.calls.map((call) => call.outcome)).toEqual(["ok", "ok", "malformed", "malformed"]);
  });

  it("reaches raw history when the judge stops descending at a stored layer", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口，改端口前值得读取。" });
    const hit = historyHit("the raw decision was to keep port 8787");
    const history = makeTimedHistoryPort(1, [hit]);
    const model = makeModel([
      { text: judgeJson({ descend: false }) },
      { text: judgeJson({ descend: true }) },
      { text: judgeJson({ sufficient: true, answer: "8787", evidence_ids: [hit.source_ref.message_id] }) },
    ]);

    const outcome = await resolve({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      history: history.port,
      defer_persistence: true,
    });

    // The stored layer held a card the judge could not use. That used to end the
    // walk and report a gap the history layer was never asked about.
    expect(history.searches).toBe(1);
    expect(outcome.calls.map((call) => call.layer)).toEqual(["active", "archived", "history"]);
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.answer).toBe("8787");
  });

  it("keeps a ledger call for history instead of judging an empty archived layer", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口，改端口前值得读取。" });
    const hit = historyHit("the raw decision was to keep port 8787");
    const history = makeTimedHistoryPort(1, [hit]);
    const model = makeModel([
      { text: judgeJson({ descend: true, next_queries: ["部署", "并发"] }) },
      { text: judgeJson({ descend: true }) },
      { text: judgeJson({ sufficient: true, answer: "8787", evidence_ids: [hit.source_ref.message_id] }) },
    ]);

    const outcome = await resolve({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      history: history.port,
      defer_persistence: true,
    });

    // Two calls are already spent on Active. Archived holds nothing, so its
    // judge call would leave History unvisited under the three-call ceiling.
    expect(outcome.calls.map((call) => call.layer)).toEqual(["active", "active", "history"]);
    expect(model.calls).toBe(3);
    expect(outcome.layers.find((layer) => layer.layer === "archived")?.candidates).toBe(0);
    expect(outcome.result.status).toBe("resolved");
  });

  it("names the missing history adapter instead of reporting it as unrequested", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口，改端口前值得读取。" });
    const model = makeModel([{ text: judgeJson({ descend: true }) }, { text: judgeJson({ descend: true }) }]);

    const outcome = await resolve({ store, question: "端口", scope: projectA, model: model.port });

    const historyLayer = outcome.layers.find((layer) => layer.layer === "history");
    expect(historyLayer?.status).toBe("skipped");
    expect(historyLayer?.reason).toBe("history_port_missing");
  });

  it("does not call an empty store a candidate the judge rejected", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口，改端口前值得读取。" });
    const model = makeModel([{ text: judgeJson({ descend: false }) }]);

    const outcome = await resolve({ store, question: "端口", scope: projectA, model: model.port });

    expect(outcome.result.missing).toContain("evidence_insufficient");
    expect(outcome.result.missing).not.toContain("no_candidates_gathered");
  });

  it("keeps the caller's question when the model expands the query", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-decoy", title: "zqleak install notes", keywords: ["zqleak"], nav_text: "install notes only, no conclusion" });
    const history = makeTimedHistoryPort(1, [historyHit("zqleak alpha first user message")]);
    // Active's judge proposes an expansion, so Active is re-gathered and judged
    // again before the walk descends; the four-call ceiling leaves the later
    // layers their own judge.
    const model = makeModel([
      { text: judgeJson({ next_queries: ["deployment default port"], descend: true }) },
      { text: judgeJson({ descend: true }) },
      { text: judgeJson({ descend: true }) },
      { text: judgeJson({ descend: false }) },
    ]);

    const outcome = await resolve({
      store,
      question: "zqleak",
      scope: projectA,
      model: model.port,
      history: history.port,
      budget: { max_model_calls: 4 },
    });

    // The expansion supplements the question; it must never replace it, or the
    // lower layers would be searched only for the model's own paraphrase.
    expect(history.texts[0]).toBe("zqleak");
    expect(history.texts).toContain("deployment default port");
    expect(outcome.history.length).toBe(1);
  });

  it("reports the layer records of the whole walk, not only the last gather", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-decoy", title: "zqleak install notes", keywords: ["zqleak"], nav_text: "install notes only, no conclusion" });
    const history = makeTimedHistoryPort(1, [historyHit("zqleak alpha first user message")]);
    const model = makeModel([
      { text: judgeJson({ next_queries: ["unrelated paraphrase"], descend: true }) },
      { text: judgeJson({ descend: true }) },
      { text: judgeJson({ descend: true }) },
      { text: judgeJson({ descend: false }) },
    ]);

    const outcome = await resolve({
      store,
      question: "zqleak",
      scope: projectA,
      model: model.port,
      history: history.port,
      budget: { max_model_calls: 4 },
    });

    const active = outcome.layers.find((layer) => layer.layer === "active");
    const archived = outcome.layers.find((layer) => layer.layer === "archived");
    const historyLayer = outcome.layers.find((layer) => layer.layer === "history");
    expect(active?.status).toBe("matched");
    expect(active?.candidates).toBeGreaterThan(0);
    expect(historyLayer?.status).toBe("matched");
    expect(archived?.status).toBe("empty");
    expect(outcome.measured.layers).toEqual(outcome.layers);
  });
});

describe("memory.resolve: malformed structured output", () => {
  it("retries once and accepts the corrected answer", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const model = makeModel([
      { text: "I think the port is 8787." },
      { text: judgeJson({ sufficient: true, answer: "The default port is 8787.", evidence_ids: ["mem-active"] }) },
    ]);

    const outcome = await resolve({ store, question: "端口", scope: projectA, model: model.port });

    expect(outcome.calls.map((call) => call.outcome)).toEqual(["malformed", "ok"]);
    expect(outcome.result.status).toBe("resolved");
  });

  it("stops after a second malformed answer instead of guessing", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const model = makeModel([{ text: "not json" }, { text: judgeJson({ sufficient: true, answer: "x", evidence_ids: ["ghost"] }) }]);

    const outcome = await resolve({ store, question: "端口", scope: projectA, model: model.port });

    expect(model.calls).toBe(2);
    expect(outcome.result.status).not.toBe("resolved");
    expect(outcome.result.answer).toBeNull();
    expect(outcome.result.missing.some((entry) => entry.startsWith("model_malformed_output"))).toBe(true);
  });
});

describe("memory.resolve: budgets", () => {
  it("stops before the first call when the input token ceiling cannot fit it", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const model = makeModel([{ text: judgeJson({}) }]);

    const outcome = await resolve({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      budget: { max_input_tokens: 10 },
    });

    expect(model.calls).toBe(0);
    expect(outcome.result.budget_used.model_calls).toBe(0);
    expect(outcome.result.missing).toContain("input_token_cap");
  });

  it("asks the judgement call for room above the ceiling that used to truncate it", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active", nav_text: "deploy default port is 8787" });
    const model = makeModel([{ text: judgeJson({ sufficient: true, answer: "8787", evidence_ids: ["mem-active"] }) }]);

    await resolve({ store, question: "端口", scope: projectA, model: model.port });

    // The per-call cap, not the request total: the first call gets room for a short
    // answer plus the reasoning this backend emits before it. 1200 is the ceiling
    // where judge replies were measured to be cut mid-JSON.
    expect(RESOLVE_MAX_OUTPUT_TOKENS_PER_CALL).toBeGreaterThan(1200);
    expect(model.requests[0]?.max_output_tokens).toBe(RESOLVE_MAX_OUTPUT_TOKENS_PER_CALL);
  });

  it("stops when accumulated output tokens reach the ceiling", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const model = makeModel([{ text: judgeJson({ descend: true }) }]);

    const outcome = await resolve({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      budget: { max_output_tokens: 1 },
    });

    expect(model.calls).toBe(1);
    expect(outcome.result.missing).toContain("output_token_cap");
  });

  it("drops evidence that does not fit the evidence budget and reports the gap", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const model = makeModel([{ text: judgeJson({ sufficient: true, answer: "The port is 8787.", evidence_ids: ["mem-active"] }) }]);

    const outcome = await resolve({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      budget: { max_evidence_bytes: 64 },
    });

    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.answer).toBeNull();
    expect(outcome.result.missing).toContain("evidence_insufficient");
    expect(outcome.measured.evidence_messages).toBe(0);
  });

  it("leaves the thinking level to the configured model port", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const model = makeModel([{ text: judgeJson({}) }]);

    await resolve({ store, question: "端口", scope: projectA, model: model.port });

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.thinking).toBeUndefined();
  });
});

describe("memory.resolve: insufficient evidence stays insufficient", () => {
  it("never returns prose as an answer when the model says the evidence is not enough", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const model = makeModel([
      { text: judgeJson({ sufficient: false, answer: "The port is probably 8787.", evidence_ids: ["mem-active"] }) },
    ]);

    const outcome = await resolve({ store, question: "端口", scope: projectA, model: model.port });

    expect(outcome.result.answer).toBeNull();
    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.cards.length).toBeGreaterThan(0);
  });

  it("records a divergence as conflicted, not as a resolved answer", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-a", title: "port agreement", keywords: ["port"], nav_text: "port agreement says 8080" });
    seedMemory(store, { memory_id: "mem-b", title: "port agreement", keywords: ["port"], nav_text: "port agreement says 9090" });
    const model = makeModel([
      {
        text: judgeJson({
          sufficient: true,
          answer: "Ports differ.",
          evidence_ids: ["mem-a", "mem-b"],
          conflicts: ["8080 vs 9090"],
        }),
      },
    ]);

    const outcome = await resolve({ store, question: "port agreement", scope: projectA, model: model.port });

    expect(outcome.result.status).toBe("conflicted");
    expect(outcome.result.answer).toBeNull();
    expect(outcome.result.conflicts).toContain("8080 vs 9090");
  });

  it("does not let a model-held resolved outrank a contested subject it did not cite", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-a", title: "部署脚本默认端口", keywords: ["端口"], nav_text: "默认端口 8080" });
    seedMemory(store, { memory_id: "mem-b", title: "部署脚本默认端口（新）", keywords: ["端口"], nav_text: "默认端口 18080" });
    const model = makeModel([
      { text: judgeJson({ sufficient: true, answer: "默认端口是 8080。", evidence_ids: ["mem-a"] }) },
    ]);

    const outcome = await resolve({ store, question: "端口", scope: projectA, model: model.port });

    expect(outcome.result.status).toBe("conflicted");
    expect(outcome.result.answer).toBeNull();
    expect(outcome.result.conflicts).toContain("mem-a");
    expect(outcome.result.conflicts).toContain("mem-b");
  });
});

describe("memory.resolve: continuation scope", () => {
  async function partial(store: MemoryStore, scope: typeof projectA) {
    const model = makeModel([{ text: judgeJson({}) }]);
    const outcome = await resolve({ store, question: "端口", scope, model: model.port });
    if (outcome.continuation === null) throw new Error("expected a continuation");
    return outcome.continuation;
  }

  it("reuses candidates for the same scope and question before expiry", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const continuation = await partial(store, projectA);
    const model = makeModel([{ text: judgeJson({}) }]);

    const outcome = await resolve({ store, question: "端口", scope: projectA, model: model.port, continuation });

    expect(outcome.measured.reused_continuation).toBe(true);
    expect(outcome.measured.gather_ms).toBe(0);
    expect(model.calls).toBe(1);
  });

  it("refuses a continuation from another scope", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const continuation = await partial(store, projectA);
    const model = makeModel([{ text: judgeJson({}) }]);

    const outcome = await resolve({ store, question: "端口", scope: projectB, model: model.port, continuation });

    expect(outcome.measured.reused_continuation).toBe(false);
  });

  it("refuses an expired continuation", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const continuation = await partial(store, projectA);
    const model = makeModel([{ text: judgeJson({}) }]);

    const outcome = await resolve({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      continuation: { ...continuation, expires_at_ms: Date.now() - 1 },
    });

    expect(outcome.measured.reused_continuation).toBe(false);
  });
});

describe("memory.resolve: deadline, cold allowance and cancellation", () => {
  it("propagates a caller cancellation to the in-flight model call", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const model = makeModel([{ delay_ms: 500, text: judgeJson({}) }]);
    const controller = new AbortController();
    const pending = resolve({ store, question: "端口", scope: projectA, model: model.port, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const outcome = await pending;

    expect(model.saw_abort).toBe(true);
    expect(outcome.result.status).not.toBe("resolved");
    expect(outcome.result.answer).toBeNull();
    expect(outcome.calls[0]?.outcome).toBe("cancelled");
    expect(outcome.result.missing).toContain("cancelled");
  });

  it("enforces the warm deadline", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const model = makeModel([{ delay_ms: 300, text: judgeJson({}) }]);

    const outcome = await resolve({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      budget: { warm_deadline_ms: 40, cold_deadline_ms: 40 },
    });

    expect(outcome.result.status).not.toBe("resolved");
    expect(outcome.result.missing).toContain("deadline_exceeded");
    expect(outcome.calls[0]?.outcome).toBe("cancelled");
    expect(outcome.measured.cold).toBe(false);
  });

  it("grants the cold allowance after a history refresh", async () => {
    const store = newStore();
    const hit = historyHit("the raw decision was to keep port 8787");
    const history = makeTimedHistoryPort(6000, [hit]);
    // An empty scope goes straight to the history layer, so the first judge
    // call is history's and it is the one that answers.
    const model = makeModel([
      {
        delay_ms: 80,
        text: judgeJson({ sufficient: true, answer: "History says 8787.", evidence_ids: [hit.source_ref.message_id] }),
      },
    ]);

    const outcome = await resolve({
      store,
      question: "port decision",
      scope: projectA,
      model: model.port,
      history: history.port,
      budget: { warm_deadline_ms: 40, cold_deadline_ms: 2000 },
    });

    expect(outcome.measured.cold).toBe(true);
    expect(outcome.measured.history_read_ms).toBeGreaterThanOrEqual(6000);
    expect(outcome.result.status).toBe("resolved");
  });

  it("spends one read allowance on the first anchor, not once per query variant", async () => {
    const store = newStore();
    const hit = historyHit("zqleak alpha first user message");
    const history = makeTimedHistoryPort(1, [hit]);
    const model = makeModel([
      {
        text: judgeJson({
          sufficient: false,
          answer: null,
          evidence_ids: [],
          read_uris: [],
          next_queries: ["zqleak beta", "zqleak gamma"],
          conflicts: [],
          descend: true,
        }),
      },
      {
        text: judgeJson({
          sufficient: false,
          answer: null,
          evidence_ids: [],
          read_uris: [],
          next_queries: [],
          conflicts: [],
          descend: true,
        }),
      },
    ]);

    const outcome = await resolve({
      store,
      question: "zqleak alpha",
      scope: projectA,
      model: model.port,
      history: history.port,
      budget: { max_history_reads: 1, warm_deadline_ms: 5000, cold_deadline_ms: 5000 },
    });

    // The anchor has two windows (parents, then the reply timeline); the second
    // is refused rather than paid for again on the next variant.
    expect(history.reads).toBe(1);
    expect(outcome.result.missing).toContain("history:read_skipped:reads");
  });

  it("bounds a slow read with the timeout the allowance granted", async () => {
    const store = newStore();
    const hit = historyHit("zqleak slow read question");
    const history = makeHistoryPort({ hits: [hit], read_delay_ms: 5000 });
    const model = makeModel([
      {
        text: judgeJson({
          sufficient: false,
          answer: null,
          evidence_ids: [],
          read_uris: [],
          next_queries: [],
          conflicts: [],
          descend: false,
        }),
      },
    ]);

    const started = performance.now();
    const outcome = await resolve({
      store,
      question: "zqleak slow read",
      scope: projectA,
      model: model.port,
      history: history.port,
      budget: { max_history_reads: 1, warm_deadline_ms: 3000, cold_deadline_ms: 3000 },
    });
    const elapsed = performance.now() - started;

    // The port was told to give up before the warm deadline, so the read fails
    // fast instead of holding the resolve until its own 5 s.
    expect(outcome.result.missing).toContain("history:read_failed:test_timeout");
    expect(elapsed).toBeLessThan(4500);
  });

  it("surfaces the bounded history excerpts it gathered", async () => {
    const store = newStore();
    const hit = historyHit("the raw decision was to keep port 8787");
    const history = makeTimedHistoryPort(1, [hit]);
    const model = makeModel([
      {
        text: judgeJson({ sufficient: true, answer: "8787", evidence_ids: [hit.source_ref.message_id] }),
      },
    ]);

    const outcome = await resolve({
      store,
      question: "port decision",
      scope: projectA,
      model: model.port,
      history: history.port,
    });

    expect(outcome.result.status).toBe("resolved");
    expect(outcome.history).toHaveLength(1);
    expect(outcome.history[0]?.excerpt).toContain("8787");
    expect(outcome.history[0]?.source_ref.message_id).toBe(hit.source_ref.message_id);
    expect(outcome.measured.history_excerpts).toBe(1);
  });

  it("still enforces the warm deadline when history was warm", async () => {
    const store = newStore();
    const hit = historyHit("warm history read");
    const history = makeTimedHistoryPort(1, [hit]);
    const model = makeModel([
      { delay_ms: 300, text: judgeJson({}) },
    ]);

    const outcome = await resolve({
      store,
      question: "port decision",
      scope: projectA,
      model: model.port,
      history: history.port,
      budget: { warm_deadline_ms: 60, cold_deadline_ms: 2000 },
    });

    expect(outcome.measured.cold).toBe(false);
    expect(outcome.result.missing).toContain("deadline_exceeded");
  });
});

describe("memory.resolve: degradation", () => {
  it("degrades to the zero-LLM layered search when no model is configured", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const outcome = await resolve({ store, question: "端口", scope: projectA, model: null });

    expect(outcome.measured.degraded).toBe(true);
    expect(outcome.result.budget_used.model_calls).toBe(0);
    expect(outcome.result.missing).toContain("model_not_configured");
  });

  it("degrades after the per-Session resolve ceiling is reached", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    const model = makeModel([{ text: judgeJson({}) }]);

    const outcome = await resolve({
      store,
      question: "端口",
      scope: projectA,
      model: model.port,
      session_resolves_used: 40,
    });

    expect(model.calls).toBe(0);
    expect(outcome.measured.degraded).toBe(true);
    expect(outcome.result.missing).toContain("session_resolve_budget_exhausted");
  });

  it("refuses a zero-length question", async () => {
    const store = newStore();
    const model = makeModel([]);
    await expect(resolve({ store, question: "  ", scope: projectA, model: model.port })).rejects.toThrow();
  });
});

describe("memory.resolve: scope safety", () => {
  it("rejects evidence the model invents outside the gathered candidates", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active" });
    seedMemory(store, { memory_id: "mem-foreign", scope: { kind: "project", project_id: PROJECT_B } });
    const model = makeModel([
      { text: judgeJson({ sufficient: true, answer: "stolen", evidence_ids: ["mem-foreign"] }) },
      { text: judgeJson({ sufficient: true, answer: "stolen", evidence_ids: ["mem-foreign"] }) },
    ]);

    const outcome = await resolve({ store, question: "端口", scope: projectA, model: model.port });

    expect(outcome.result.status).not.toBe("resolved");
    expect(outcome.result.cards.map((card) => card.memory_id)).not.toContain("mem-foreign");
  });
});
