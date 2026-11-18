/**
 * A layer is gathered at most twice, so the judge's `next_queries` can re-ask
 * the layer it just judged instead of only reaching the lower ones.
 */

import { afterEach, describe, expect, it } from "vitest";
import { parseBudgetUsed, parseRetrievalResult } from "../../src/contracts/index.js";
import type { ModelPort, ModelRequest, ModelResult, ResolveInput } from "../../src/resolver/index.js";
import { resolveMemory } from "../../src/resolver/index.js";
import type { MemoryStore, SearchOptions } from "../../src/storage/index.js";
import type { SearchHit } from "../../src/storage/index.js";
import { PROJECT_A, openTempStore, seedMemory } from "../retrieval/support.js";

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

/** The memory only matches on `maxWorkers` / `8787`, never on the question's own words. */
function seedDeployMemory(store: MemoryStore): void {
  seedMemory(store, {
    memory_id: "mem-active",
    title: "部署脚本默认端口",
    keywords: ["部署", "端口", "并发"],
    nav_text: "默认端口 8787，并发上限 maxWorkers=8",
  });
}

const QUESTION = "what port and worker limit does the deploy script use";

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

type FakeModel = { port: ModelPort; requests: ModelRequest[]; calls: number };

function response(text: string) {
  return {
    text,
    model: "stub",
    finish_reason: "stop",
    usage: { tokens_in: 100, tokens_out: 20, cost_usd: 0.001 },
  };
}

function makeModel(replies: string[], fallback: string = judgeJson()): FakeModel {
  return makeResponderModel((call) => replies[call] ?? fallback);
}

/** Scripted answers keyed off the layer named in the judge prompt. */
function makeResponderModel(respond: (call: number, request: ModelRequest) => string): FakeModel {
  const state: FakeModel = {
    requests: [],
    calls: 0,
    port: {
      async complete(request: ModelRequest): Promise<ModelResult> {
        const text = respond(state.calls, request);
        state.calls += 1;
        state.requests.push(request);
        return { ok: true, value: response(text) };
      },
    },
  };
  return state;
}

/** Every `searchActive` call is one gather variant, so this is the gather counter. */
function countSearches(store: MemoryStore): { queries: string[]; gathers: () => number } {
  const queries: string[] = [];
  const original = store.searchActive.bind(store);
  store.searchActive = (query: string, options?: SearchOptions): SearchHit[] => {
    queries.push(query);
    return original(query, options);
  };
  return { queries, gathers: () => queries.length };
}

function judgeMessage(request: ModelRequest | undefined): string {
  return request?.messages.find((message) => message.role === "user")?.content ?? "";
}

function judgedLayer(request: ModelRequest | undefined): string {
  return /^layer: (\w+)$/m.exec(judgeMessage(request))?.[1] ?? "";
}

async function resolve(options: ResolveInput) {
  const outcome = await resolveMemory(options);
  parseRetrievalResult(outcome.result);
  parseBudgetUsed(outcome.result.budget_used);
  return outcome;
}

describe("memory.resolve: re-gathering the judged layer", () => {
  it("re-gathers Active with the judge's phrasings and resolves from it", async () => {
    const store = newStore();
    seedDeployMemory(store);
    const searches = countSearches(store);
    const model = makeResponderModel((_call, request) => {
      // Only the Active pass ever proposes phrasings; a lower layer that sees
      // the same literal question finds nothing and keeps descending.
      const active = judgedLayer(request) === "active";
      if (!active) return judgeJson({ descend: true });
      return judgeMessage(request).includes("mem-active")
        ? judgeJson({ sufficient: true, answer: "并发上限是 8。", evidence_ids: ["mem-active"] })
        : judgeJson({ next_queries: ["maxWorkers"], descend: true });
    });

    const outcome = await resolve({ store, question: QUESTION, scope: projectA, model: model.port });

    expect(judgedLayer(model.requests[0])).toBe("active");
    expect(judgedLayer(model.requests[1])).toBe("active");
    expect(model.calls).toBe(2);
    expect(searches.queries.filter((query) => query === "maxWorkers")).toHaveLength(1);
    expect(searches.gathers()).toBe(3);
    expect(judgeMessage(model.requests[1])).toContain("mem-active");
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.cards.map((card) => card.memory_id)).toContain("mem-active");
    expect(outcome.result.answer).toBe("并发上限是 8。");
  });

  it("stops re-gathering when the judge repeats the same phrasings, and still descends", async () => {
    const store = newStore();
    seedDeployMemory(store);
    const searches = countSearches(store);
    const model = makeModel(
      [
        judgeJson({ next_queries: ["maxWorkers"], descend: true }),
        judgeJson({ next_queries: ["maxWorkers"], descend: true }),
      ],
      // Archived keeps descending, so the walk ends on the judgment-call cap.
      judgeJson({ descend: true }),
    );

    const outcome = await resolve({ store, question: QUESTION, scope: projectA, model: model.port });

    // Active twice, Archived once with the same pair, and no third Active pass.
    expect(searches.gathers()).toBe(5);
    expect(searches.queries.filter((query) => query === "maxWorkers")).toHaveLength(2);
    expect(judgeMessage(model.requests[2])).toContain("layer: archived");
    expect(model.calls).toBe(3);
    expect(outcome.result.status).not.toBe("resolved");
    expect(outcome.result.missing).toContain("model_call_cap");
  });

  it("bounds a layer to two gathers even when the judge keeps proposing new phrasings", async () => {
    const store = newStore();
    seedDeployMemory(store);
    const searches = countSearches(store);
    const model = makeModel([
      judgeJson({ next_queries: ["maxWorkers"], descend: true }),
      judgeJson({ next_queries: ["8787"], descend: true }),
    ]);

    await resolve({ store, question: QUESTION, scope: projectA, model: model.port });

    expect(searches.gathers()).toBe(5);
    // The second proposed set never reaches Active.
    expect(searches.queries.filter((query) => query === "maxWorkers")).toHaveLength(1);
    expect(searches.queries.filter((query) => query === "8787")).toHaveLength(1);
  });

  it("gathers each layer once when the judge never proposes phrasings", async () => {
    const store = newStore();
    seedDeployMemory(store);
    const searches = countSearches(store);
    const model = makeModel([
      judgeJson({ descend: true }),
      judgeJson({ descend: true }),
      judgeJson({ descend: true }),
    ]);

    const outcome = await resolve({ store, question: QUESTION, scope: projectA, model: model.port });

    // Active, Archived, history — one gather each, no re-ask.
    expect(model.calls).toBe(3);
    expect(searches.gathers()).toBe(3);
    expect(searches.queries.every((query) => query === QUESTION)).toBe(true);
    expect(outcome.result.status).toBe("not_found");
    expect(outcome.result.missing).toContain("evidence_insufficient");
  });
});
