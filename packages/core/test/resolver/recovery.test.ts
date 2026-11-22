import { afterEach, describe, expect, it } from "vitest";
import { parseBudgetUsed, parseRetrievalResult } from "../../src/contracts/index.js";
import { layeredSearch } from "../../src/retrieval/index.js";
import { searchWithRecovery } from "../../src/resolver/index.js";
import type { MemoryStore } from "../../src/storage/index.js";
import { bodyOfLength, makeScriptedModel } from "../extraction/support.js";
import { PROJECT_A, PROJECT_B, makeHistoryPort, openTempStore, seedMemory } from "../retrieval/support.js";

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

const QUESTION = "打包成容器的时候名字怎么起";
const IMAGE_MEMORY = "mem-image-layers";

function seedImageMemory(store: MemoryStore, memory_id = IMAGE_MEMORY, title = "镜像中间层合并"): void {
  seedMemory(store, {
    memory_id,
    title,
    keywords: ["镜像", "中间层", "合并"],
    nav_text: "构建镜像时先合并中间层再打包成容器。",
    body: bodyOfLength(600),
  });
}

function rewriteJson(next_queries: string[] = []): string {
  return JSON.stringify({ next_queries });
}

function relevanceJson(ids: string[]): string {
  return JSON.stringify({ relevant_ids: ids });
}

function userMessage(request: { messages: readonly { role: string; content: string }[] } | undefined): string {
  return request?.messages.find((message) => message.role === "user")?.content ?? "";
}

describe("searchWithRecovery: an explicit strict miss", () => {
  it("keeps an archived match out of rewritten results unless explicitly requested", async () => {
    const store = newStore();
    seedMemory(store, {
      memory_id: "mem-image-archive",
      state: "archived",
      title: "镜像标签规则",
      keywords: ["镜像标签"],
    });
    const model = makeScriptedModel((_kind, index) => index === 0
      ? { text: rewriteJson(["镜像标签"]) }
      : { text: relevanceJson(["mem-image-archive"]) });
    const input = { store, query: QUESTION, question: QUESTION, scope: projectA, getModel: () => model.port };

    const implicit = await searchWithRecovery(input);
    expect(implicit.result.cards).toEqual([]);
    expect(implicit.recovery.model_calls).toBe(1);

    const explicitModel = makeScriptedModel((_kind, index) => index === 0
      ? { text: rewriteJson(["镜像标签"]) }
      : { text: relevanceJson(["mem-image-archive"]) });
    const explicit = await searchWithRecovery({ ...input, include_archived: true, getModel: () => explicitModel.port });
    expect(explicit.result.cards.map((card) => card.memory_id)).toEqual(["mem-image-archive"]);
  });

  it("does not submit a failed model call as a zero-call recovery", async () => {
    const store = newStore();
    // A stored memory keeps the empty-scope short-circuit out of the way, so an
    // attempted call is the only reason this can end without a model.
    seedImageMemory(store);
    const outcome = await searchWithRecovery({
      store, query: QUESTION, question: QUESTION, scope: projectA,
      getModel: () => ({ complete: async () => { throw new Error("model unavailable"); } }),
    });
    expect(outcome.recovery).toMatchObject({ status: "unavailable", model_calls: 1, cost_usd: null });
    expect(outcome.result.cards).toEqual([]);
  });

  it("recovers the image-tag card without requiring its summary to contain the answer", async () => {
    const store = newStore();
    const tag = seedMemory(store, {
      memory_id: "mem-image-tag",
      title: "镜像标签规则",
      keywords: ["镜像标签", "容器"],
      nav_text: "镜像标签与推送规则。",
      body: `镜像标签用提交短哈希。${bodyOfLength(600)}`,
    });
    const strict = await layeredSearch({ store, query: QUESTION, scope: projectA });
    expect(strict.result.status).toBe("not_found");
    expect(strict.result.cards).toHaveLength(0);

    const model = makeScriptedModel((_kind, index) =>
      index === 0 ? { text: rewriteJson(["镜像标签"]) } : { text: relevanceJson([tag.memory_id]) },
    );

    const outcome = await searchWithRecovery({
      store,
      query: QUESTION,
      question: QUESTION,
      scope: projectA,
      getModel: () => model.port,
    });
    parseRetrievalResult(outcome.result);
    parseBudgetUsed(outcome.result.budget_used);

    expect(outcome.recovery.status).toBe("recovered");
    expect(outcome.recovery.model_calls).toBe(2);
    expect(outcome.recovery.cost_usd).toBeCloseTo(0.004);
    expect(outcome.recovery.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.cards.map((card) => card.memory_id)).toEqual([tag.memory_id]);
    expect(outcome.result.cards[0]?.nav_text).not.toContain("哈希");
    expect(outcome.result.evidence.length).toBeGreaterThan(0);
    expect(outcome.result.conflicts).toEqual([]);
    expect(outcome.result.next_action).toBe("widen:history");

    const active = outcome.layers.find((layer) => layer.layer === "active");
    expect(active).toMatchObject({ status: "matched", emitted: 1 });
    expect(active?.candidates).toBeGreaterThanOrEqual(1);
    expect(outcome.measured).toMatchObject({
      card_count: 1,
      active_cards: 1,
      archived_cards: 0,
      history_excerpts: 0,
    });
    expect(outcome.history).toEqual([]);
    expect(userMessage(model.requests[1])).toContain(QUESTION);
  });

  it("verifies ranked partial matches even when the rewrite contributes no terms", async () => {
    const store = newStore();
    seedMemory(store, {
      memory_id: "mem-image-tag",
      title: "镜像标签规则",
      keywords: ["容器", "镜像标签"],
      nav_text: "容器镜像的标签规则。",
      body: bodyOfLength(600),
    });
    seedMemory(store, {
      memory_id: "mem-image-layer",
      title: "镜像中间层合并",
      keywords: ["镜像", "合并", "container image name", "命名"],
      nav_text: "如何合并镜像的中间层。",
      body: bodyOfLength(600),
    });
    const query = "容器 镜像 命名 container image name";
    const model = makeScriptedModel((_kind, index) => index === 0
      ? { text: rewriteJson([]) }
      : { text: relevanceJson(["mem-image-tag"]) });

    const outcome = await searchWithRecovery({
      store, query, question: QUESTION, scope: projectA, getModel: () => model.port,
    });

    expect(userMessage(model.requests[1])).toContain("mem-image-layer");
    expect(outcome.result.cards.map((card) => card.memory_id)).toEqual(["mem-image-tag"]);
  });

  it("never touches the history port for rewritten variants", async () => {
    const store = newStore();
    seedImageMemory(store);
    const history = makeHistoryPort({ hits: [] });
    const model = makeScriptedModel((_kind, index) =>
      index === 0
        ? { text: rewriteJson(["镜像 中间层 合并"]) }
        : { text: relevanceJson([IMAGE_MEMORY]) },
    );

    const outcome = await searchWithRecovery({
      store,
      query: QUESTION,
      question: QUESTION,
      scope: projectA,
      include_history: true,
      history: history.port,
      getModel: () => model.port,
    });

    expect(outcome.recovery.status).toBe("recovered");
    expect(history.calls.probe).toBe(1);
    expect(history.calls.search).toBe(1);
    expect(outcome.history).toEqual([]);
    expect(outcome.result.next_action?.startsWith("read:")).toBe(true);
  });

  it("keeps the deterministic conflict signal for accepted cards", async () => {
    const store = newStore();
    seedImageMemory(store, "mem-layer-a", "镜像中间层合并");
    seedImageMemory(store, "mem-layer-b", "镜像中间层合并的规则");
    const model = makeScriptedModel((_kind, index) =>
      index === 0
        ? { text: rewriteJson(["镜像 中间层"]) }
        : { text: relevanceJson(["mem-layer-a", "mem-layer-b"]) },
    );

    const outcome = await searchWithRecovery({
      store,
      query: QUESTION,
      question: QUESTION,
      scope: projectA,
      getModel: () => model.port,
    });

    expect(outcome.recovery.status).toBe("recovered");
    expect(outcome.result.status).toBe("conflicted");
    expect(outcome.result.conflicts).toEqual(["mem-layer-a", "mem-layer-b"]);
    expect(outcome.layers.find((layer) => layer.layer === "active")?.emitted).toBe(2);
  });

  it("does not let a broad variant crowd a precise one out of the relevance call", async () => {
    const store = newStore();
    for (let index = 0; index < 5; index += 1) {
      seedMemory(store, {
        memory_id: `mem-broad-${index}`,
        title: `镜像占位记录${index}`,
        keywords: ["镜像"],
        nav_text: `镜像占位记录 ${index}`,
        body: bodyOfLength(600),
      });
    }
    seedMemory(store, {
      memory_id: "mem-precise-layers",
      title: "中间层合并",
      keywords: ["中间层", "合并"],
      nav_text: "合并中间层的记录。",
      body: bodyOfLength(600),
    });
    const model = makeScriptedModel((_kind, index) =>
      index === 0
        ? { text: rewriteJson(["镜像 中间层合并"]) }
        : { text: relevanceJson(["mem-precise-layers"]) },
    );

    const outcome = await searchWithRecovery({
      store,
      query: QUESTION,
      question: QUESTION,
      scope: projectA,
      getModel: () => model.port,
    });

    expect(outcome.recovery.status).toBe("recovered");
    expect(outcome.result.cards.map((card) => card.memory_id)).toEqual(["mem-precise-layers"]);
    expect(outcome.result.evidence.length).toBeGreaterThan(0);
  });

  it("spends at most three variants and two model calls", async () => {
    const store = newStore();
    seedImageMemory(store);
    const queries: string[] = [];
    const original = store.searchActive.bind(store);
    store.searchActive = (query, options) => {
      queries.push(query);
      return original(query, options);
    };
    const model = makeScriptedModel((_kind, index) =>
      index === 0
        ? {
            text: rewriteJson(["镜像", "容器", "中间层", "合并", "打包", "镜像合并"]),
          }
        : { text: relevanceJson([IMAGE_MEMORY]) },
    );

    const outcome = await searchWithRecovery({
      store,
      query: QUESTION,
      question: QUESTION,
      scope: projectA,
      getModel: () => model.port,
    });

    expect(outcome.recovery.status).toBe("recovered");
    expect(queries).toHaveLength(5);
    expect(queries[0]).toBe(QUESTION);
    expect(queries.at(-1)).toBe(QUESTION);
    expect(outcome.recovery.model_calls).toBe(2);
    expect(outcome.result.budget_used.model_calls).toBe(2);
    expect(outcome.result.budget_used.cost_usd).toBeCloseTo(0.004);
  });
});

describe("searchWithRecovery: the fast paths", () => {
  it("returns a literal hit unchanged and never asks for a model", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-deploy" });
    let asked = false;
    const model = makeScriptedModel(() => {
      throw new Error("model must not be called on the fast path");
    });
    const outcome = await searchWithRecovery({
      store,
      query: "部署脚本默认端口",
      question: "部署脚本默认端口",
      scope: projectA,
      getModel: () => {
        asked = true;
        return model.port;
      },
    });
    const direct = await layeredSearch({ store, query: "部署脚本默认端口", scope: projectA });

    expect(asked).toBe(false);
    expect(outcome.recovery).toEqual({
      status: "skipped",
      model_calls: 0,
      cost_usd: null,
      elapsed_ms: 0,
    });
    expect(outcome.result.status).toBe(direct.result.status);
    expect(outcome.result.cards).toEqual(direct.result.cards);
    expect(outcome.result.evidence).toEqual(direct.result.evidence);
    expect(outcome.layers).toEqual(direct.layers);
    expect(outcome.measured).toMatchObject({
      card_count: direct.measured.card_count,
      active_cards: direct.measured.active_cards,
      archived_cards: direct.measured.archived_cards,
      history_excerpts: direct.measured.history_excerpts,
      history_available: direct.measured.history_available,
    });
  });

  it("does not recover a paginated page", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-deploy" });
    let asked = false;
    const model = makeScriptedModel(() => {
      throw new Error("model must not be called for a nonzero offset");
    });
    const outcome = await searchWithRecovery({
      store,
      query: "部署脚本默认端口",
      question: "部署脚本默认端口",
      scope: projectA,
      offset: 1,
      getModel: () => {
        asked = true;
        return model.port;
      },
    });

    expect(asked).toBe(false);
    expect(outcome.result.cards).toEqual([]);
    expect(outcome.recovery.status).toBe("skipped");
  });

  it("does not recover when the request was already cancelled", async () => {
    const store = newStore();
    seedImageMemory(store);
    const controller = new AbortController();
    controller.abort();
    const model = makeScriptedModel(() => ({ text: rewriteJson() }));
    const outcome = await searchWithRecovery({
      store,
      query: QUESTION,
      question: QUESTION,
      scope: projectA,
      signal: controller.signal,
      getModel: () => model.port,
    });

    expect(model.judge_calls).toBe(0);
    expect(outcome.recovery.status).toBe("skipped");
    expect(outcome.result.cards).toEqual([]);
  });
});

describe("searchWithRecovery: fail closed", () => {
  it("reports unavailable when no model is configured and keeps the strict result", async () => {
    const store = newStore();
    seedImageMemory(store);
    const outcome = await searchWithRecovery({
      store,
      query: QUESTION,
      question: QUESTION,
      scope: projectA,
      getModel: () => null,
    });

    expect(outcome.recovery).toMatchObject({ status: "unavailable", model_calls: 0, cost_usd: null });
    expect(outcome.result.status).toBe("not_found");
    expect(outcome.result.cards).toEqual([]);
  });

  it("rejects a rewrite without the required query list", async () => {
    const store = newStore();
    seedImageMemory(store);
    const model = makeScriptedModel(() => ({ text: '{"evidence_ids":["mem-forged"]}' }));
    const outcome = await searchWithRecovery({
      store,
      query: QUESTION,
      question: QUESTION,
      scope: projectA,
      getModel: () => model.port,
    });

    expect(outcome.recovery).toMatchObject({ status: "unavailable", model_calls: 1 });
    expect(outcome.result.cards).toEqual([]);
  });

  it("rejects a forged relevance id instead of filtering it out", async () => {
    const store = newStore();
    seedImageMemory(store);
    const model = makeScriptedModel((_kind, index) =>
      index === 0
        ? { text: rewriteJson(["镜像 中间层 合并"]) }
        : { text: relevanceJson(["mem-forged"]) },
    );
    const outcome = await searchWithRecovery({
      store,
      query: QUESTION,
      question: QUESTION,
      scope: projectA,
      getModel: () => model.port,
    });

    expect(outcome.recovery).toMatchObject({ status: "unavailable", model_calls: 2 });
    expect(outcome.result.cards).toEqual([]);
    expect(outcome.result.evidence).toEqual([]);
  });

  it("returns the strict miss when the relevance call accepts nothing", async () => {
    const store = newStore();
    seedImageMemory(store);
    const model = makeScriptedModel((_kind, index) =>
      index === 0
        ? { text: rewriteJson(["镜像 中间层 合并"]) }
        : { text: relevanceJson([]) },
    );
    const outcome = await searchWithRecovery({
      store,
      query: QUESTION,
      question: QUESTION,
      scope: projectA,
      getModel: () => model.port,
    });

    expect(outcome.recovery).toMatchObject({ status: "not_found", model_calls: 2 });
    expect(outcome.result.status).toBe("not_found");
    expect(outcome.result.cards).toEqual([]);
  });

  it("stops without verification when neither the rewrite nor partial matching finds candidates", async () => {
    const store = newStore();
    // An unrelated memory keeps the scope non-empty without giving the partial
    // match a candidate, which is the case this test pins.
    seedMemory(store, { memory_id: "mem-unrelated", title: "zqleak install notes", keywords: ["zqleak"], nav_text: "install notes only, no conclusion" });
    const model = makeScriptedModel(() => ({ text: rewriteJson() }));
    const outcome = await searchWithRecovery({
      store,
      query: QUESTION,
      question: QUESTION,
      scope: projectA,
      getModel: () => model.port,
    });

    expect(outcome.recovery).toMatchObject({ status: "not_found", model_calls: 1 });
    expect(outcome.result.cards).toEqual([]);
  });
});

describe("searchWithRecovery: an empty scope", () => {
  it("skips the rewrite without calling the model", async () => {
    const model = makeScriptedModel(() => {
      throw new Error("the rewrite must not run on an empty store");
    });
    const outcome = await searchWithRecovery({
      store: newStore(),
      query: QUESTION,
      question: QUESTION,
      scope: projectA,
      getModel: () => model.port,
    });

    expect(outcome.recovery).toMatchObject({ status: "skipped", model_calls: 0, cost_usd: null });
    expect(model.judge_calls).toBe(0);
    expect(outcome.result.status).toBe("not_found");
  });

  it("counts only the requested scope, so another project's memory does not pay for a rewrite", async () => {
    const store = newStore();
    seedMemory(store, {
      memory_id: "mem-other-project",
      scope: { kind: "project", project_id: PROJECT_B },
      title: "镜像标签规则",
      keywords: ["镜像标签"],
    });
    const model = makeScriptedModel(() => ({ text: rewriteJson(["镜像标签"]) }));
    const outcome = await searchWithRecovery({
      store,
      query: QUESTION,
      question: QUESTION,
      scope: projectA,
      getModel: () => model.port,
    });

    expect(model.judge_calls).toBe(0);
    expect(outcome.result.cards).toEqual([]);
  });
});
