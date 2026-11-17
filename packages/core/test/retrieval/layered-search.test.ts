import { afterEach, describe, expect, it } from "vitest";
import type { MemoryStore } from "../../src/storage/index.js";
import {
  DEFAULT_CARD_LIMIT,
  MAX_CARD_LIMIT,
  RetrievalError,
  layeredSearch,
} from "../../src/retrieval/index.js";
import { PROJECT_A, PROJECT_B, bodyWith, makeHistoryPort, makeSourceRef, openTempStore, seedMemory } from "./support.js";

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

describe("layered search: Active first, Archived only on purpose", () => {
  it("returns Active cards and never ranks an Archived row in a default search", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口，改端口前值得读取。" });
    seedMemory(store, {
      memory_id: "mem-archived",
      nav_text: "归档的端口约定，仅在被点名时读取。",
      state: "archived",
    });

    const outcome = await layeredSearch({ store, query: "端口", scope: projectA });
    const ids = outcome.result.cards.map((card) => card.memory_id);
    expect(ids).toEqual(["mem-active"]);
    expect(ids).not.toContain("mem-archived");
    expect(outcome.layers.find((layer) => layer.layer === "active")?.status).toBe("matched");
    const archived = outcome.layers.find((layer) => layer.layer === "archived");
    expect(archived?.status).toBe("skipped");
    expect(archived?.reason).toBe("not_consulted");
    // A lexical score is not evidence that the question is answered.
    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.budget_used.model_calls).toBe(0);
    expect(outcome.result.next_action).toBe("widen:archived");
  });

  it("does not let an Archived candidate displace an irrelevant Active one", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-active", title: "端口配置草稿", nav_text: "端口配置草稿，尚未定稿。" });
    seedMemory(store, {
      memory_id: "mem-archived",
      title: "端口最终约定",
      nav_text: "端口最终约定，权威归档。",
      state: "archived",
    });

    const withoutWidening = await layeredSearch({ store, query: "端口", scope: projectA });
    expect(withoutWidening.result.cards.map((card) => card.memory_id)).toEqual(["mem-active"]);

    const widened = await layeredSearch({
      store,
      query: "端口",
      scope: projectA,
      include_archived: true,
    });
    expect(widened.result.cards.map((card) => card.memory_id)).toEqual(["mem-active", "mem-archived"]);
    const archived = widened.layers.find((layer) => layer.layer === "archived");
    expect(archived?.reason).toBe("explicit");
    expect(archived?.emitted).toBe(1);
  });

  it("falls through to Archived only when Active returns nothing", async () => {
    const store = newStore();
    seedMemory(store, {
      memory_id: "mem-archived",
      nav_text: "归档的端口约定。",
      state: "archived",
    });

    const outcome = await layeredSearch({ store, query: "端口", scope: projectA });
    expect(outcome.result.cards.map((card) => card.memory_id)).toEqual(["mem-archived"]);
    expect(outcome.layers.find((layer) => layer.layer === "active")?.status).toBe("empty");
    const archived = outcome.layers.find((layer) => layer.layer === "archived");
    expect(archived?.status).toBe("matched");
    expect(archived?.reason).toBe("fall_through");
  });

  it("treats a medium_ready hit as a match that cannot become a card", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-draft", nav_text: null, state: "medium_ready" });
    seedMemory(store, { memory_id: "mem-archived", nav_text: "归档的端口约定。", state: "archived" });

    const outcome = await layeredSearch({ store, query: "端口", scope: projectA });
    expect(outcome.result.cards).toEqual([]);
    expect(outcome.layers.find((layer) => layer.layer === "active")?.status).toBe("matched");
    // Active genuinely matched, so Archived is still not consulted.
    expect(outcome.layers.find((layer) => layer.layer === "archived")?.status).toBe("skipped");
    expect(outcome.result.missing).toContain("nav_missing:memory://vestigio/mem-draft");
    expect(outcome.result.status).toBe("partial");
  });

  it("keeps the evidence list to the cards it actually returns", async () => {
    const store = newStore();
    seedMemory(store, {
      memory_id: "mem-active",
      nav_text: "部署配置与默认端口。",
      sources: [makeSourceRef({ message_id: "src-active" })],
    });
    seedMemory(store, {
      memory_id: "mem-archived",
      nav_text: "归档的端口约定。",
      state: "archived",
      sources: [makeSourceRef({ message_id: "src-archived" })],
    });

    // One Active card already fills the card budget, so the Archived hit is
    // found (the layer still reports how many candidates exist) but no Archived
    // card is emitted. Its source must not survive into the answer.
    const outcome = await layeredSearch({
      store,
      query: "端口",
      scope: projectA,
      limit: 1,
      include_archived: true,
    });

    expect(outcome.result.cards.map((card) => card.memory_id)).toEqual(["mem-active"]);
    const archived = outcome.layers.find((layer) => layer.layer === "archived");
    expect(archived?.candidates).toBe(1);
    expect(archived?.emitted).toBe(0);
    const evidence = outcome.result.evidence.map((source) => source.message_id);
    expect(evidence).toContain("src-active");
    expect(evidence).not.toContain("src-archived");
  });
});

describe("layered search: scope precedes Top K", () => {
  it("returns only the requested project's cards even when another project ranks better", async () => {
    const store = newStore();
    for (let index = 0; index < 8; index += 1) {
      seedMemory(store, {
        memory_id: `mem-b-${index}`,
        scope: { kind: "project", project_id: PROJECT_B },
        title: `端口约定 B ${index}`,
        nav_text: `端口约定 B ${index}，属于另一个项目。`,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      seedMemory(store, {
        memory_id: `mem-a-${index}`,
        scope: { kind: "project", project_id: PROJECT_A },
        title: `端口约定 A ${index}`,
        nav_text: `端口约定 A ${index}，属于本项目。`,
      });
    }

    const outcome = await layeredSearch({ store, query: "端口", scope: projectA, limit: 5 });
    expect(outcome.result.cards.length).toBe(3);
    for (const card of outcome.result.cards) {
      expect(card.scope).toEqual({ kind: "project", project_id: PROJECT_A });
      expect(card.memory_id.startsWith("mem-a-")).toBe(true);
    }
    expect(outcome.measured.active_cards).toBe(3);
  });

  it("keeps the same memory title in two projects from crossing over", async () => {
    const store = newStore();
    seedMemory(store, {
      memory_id: "mem-a",
      scope: { kind: "project", project_id: PROJECT_A },
      title: "部署脚本默认端口",
      nav_text: "项目 A 的部署脚本默认端口。",
    });
    seedMemory(store, {
      memory_id: "mem-b",
      scope: { kind: "project", project_id: PROJECT_B },
      title: "部署脚本默认端口",
      nav_text: "项目 B 的部署脚本默认端口。",
    });

    const a = await layeredSearch({ store, query: "部署脚本默认端口", scope: projectA });
    expect(a.result.cards.map((card) => card.memory_id)).toEqual(["mem-a"]);
    expect(a.result.status).toBe("partial");

    const b = await layeredSearch({
      store,
      query: "部署脚本默认端口",
      scope: { kind: "project", project_id: PROJECT_B },
    });
    expect(b.result.cards.map((card) => card.memory_id)).toEqual(["mem-b"]);

    const global = await layeredSearch({ store, query: "部署脚本默认端口", scope: { kind: "global" } });
    expect(global.result.cards).toEqual([]);
    expect(global.result.status).toBe("not_found");
  });

  it("filters a global scope to global memories only", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-project", nav_text: "项目内的端口约定。" });
    seedMemory(store, {
      memory_id: "mem-global",
      scope: { kind: "global" },
      title: "全局端口约定",
      nav_text: "全局端口约定，跨项目可见。",
    });

    const outcome = await layeredSearch({ store, query: "端口", scope: { kind: "global" } });
    expect(outcome.result.cards.map((card) => card.memory_id)).toEqual(["mem-global"]);
    expect(outcome.result.cards[0]?.scope).toEqual({ kind: "global" });
  });
});

describe("layered search: Chinese short words and FTS5 input", () => {
  it("matches one- and two-character Chinese queries", async () => {
    const store = newStore();
    seedMemory(store, {
      memory_id: "mem-port",
      title: "端口记录",
      keywords: ["端口"],
      nav_text: "默认端口是 8787。",
      body: bodyWith("默认端口是 8787，改之前先读回滚章节。", "补充说明回滚方式与验证步骤。"),
    });
    seedMemory(store, {
      memory_id: "mem-deploy",
      title: "回滚步骤",
      keywords: ["部署"],
      nav_text: "部署失败时的回滚步骤。",
      body: bodyWith("部署失败时的回滚步骤与验证方式。"),
    });

    const one = await layeredSearch({ store, query: "端", scope: projectA });
    expect(one.result.cards.map((card) => card.memory_id)).toEqual(["mem-port"]);

    const two = await layeredSearch({ store, query: "端口", scope: projectA });
    expect(two.result.cards.map((card) => card.memory_id)).toEqual(["mem-port"]);

    const twoOther = await layeredSearch({ store, query: "部署", scope: projectA });
    expect(twoOther.result.cards.map((card) => card.memory_id)).toEqual(["mem-deploy"]);
    const absent = await layeredSearch({ store, query: "鳍", scope: projectA });
    expect(absent.result.status).toBe("not_found");
    expect(absent.result.cards).toEqual([]);
  });

  it("survives quotes, wildcards, NEAR, minus and caret without breaking the match query", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "部署配置与默认端口约定。" });

    const operatorish = [
      '"',
      "*",
      "NEAR",
      "NEAR/2",
      "-",
      "^",
      "AND",
      "OR",
      "NOT",
      'x" OR "1"="1',
      "-端口",
      "^端口$",
      "*端口*",
      "端口 NEAR 部署",
      '"端口 部署"',
      "a-b",
      "foo_bar",
      "端口*",
    ];
    for (const query of operatorish) {
      expect(() => store.searchActive(query, { scope: projectA })).not.toThrow();
      expect(() => store.searchArchived(query, { scope: projectA })).not.toThrow();
      const outcome = await layeredSearch({ store, query, scope: projectA });
      expect(outcome.result.status === "conflicted").toBe(false);
    }

    // The punctuation is stripped, the tokens still match.
    const quoted = await layeredSearch({ store, query: '"端口"', scope: projectA });
    expect(quoted.result.cards.map((card) => card.memory_id)).toEqual(["mem-port"]);

    const wildcard = await layeredSearch({ store, query: "端口*", scope: projectA });
    expect(wildcard.result.cards.map((card) => card.memory_id)).toEqual(["mem-port"]);

    const anchored = await layeredSearch({ store, query: "^端口$", scope: projectA });
    expect(anchored.result.cards.map((card) => card.memory_id)).toEqual(["mem-port"]);

    // An injection attempt is just tokens that do not match.
    const injected = await layeredSearch({ store, query: 'x" OR "1"="1', scope: projectA });
    expect(injected.result.cards).toEqual([]);
    expect(injected.result.status).toBe("not_found");
  });
});

describe("layered search: conflict status", () => {
  it("reports conflicted when two candidates in scope claim the same subject", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-old", title: "端口约定", nav_text: "端口约定：8787。" });
    seedMemory(store, {
      memory_id: "mem-new",
      title: "端口约定（冲突）",
      nav_text: "端口约定：9090，与旧约定冲突。",
    });

    const outcome = await layeredSearch({ store, query: "端口", scope: projectA });
    expect(outcome.result.status).toBe("conflicted");
    expect(outcome.result.conflicts.sort()).toEqual(["mem-new", "mem-old"]);
    expect(outcome.result.cards.length).toBe(2);
  });

  it("stays partial when the candidates do not share a subject", async () => {
    const store = newStore();
    seedMemory(store, {
      memory_id: "mem-port",
      title: "端口约定",
      nav_text: "端口约定：8787。",
    });
    seedMemory(store, {
      memory_id: "mem-rollback",
      title: "回滚步骤",
      nav_text: "回滚步骤：回滚前先确认端口。",
      body: bodyWith("回滚步骤：回滚前先确认端口。"),
    });

    const outcome = await layeredSearch({ store, query: "端口", scope: projectA });
    expect(outcome.result.cards.length).toBe(2);
    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.conflicts).toEqual([]);
  });

  it("does not report a conflict across two projects with the same title", async () => {
    const store = newStore();
    seedMemory(store, {
      memory_id: "mem-a",
      scope: { kind: "project", project_id: PROJECT_A },
      title: "端口约定",
      nav_text: "项目 A 端口约定。",
    });
    seedMemory(store, {
      memory_id: "mem-b",
      scope: { kind: "project", project_id: PROJECT_B },
      title: "端口约定",
      nav_text: "项目 B 端口约定。",
    });

    const a = await layeredSearch({ store, query: "端口约定", scope: projectA });
    expect(a.result.conflicts).toEqual([]);
    expect(a.result.status).toBe("partial");
  });
});

describe("layered search: card cap and pagination", () => {
  it("caps cards at the default and at the hard maximum", async () => {
    const store = newStore();
    for (let index = 0; index < 12; index += 1) {
      seedMemory(store, {
        memory_id: `mem-${index}`,
        title: `端口约定 ${index}`,
        nav_text: `端口约定 ${index}，部署端口记录。`,
      });
    }

    const defaulted = await layeredSearch({ store, query: "端口", scope: projectA });
    expect(defaulted.result.cards.length).toBe(DEFAULT_CARD_LIMIT);

    const full = await layeredSearch({ store, query: "端口", scope: projectA, limit: MAX_CARD_LIMIT });
    expect(full.result.cards.length).toBe(MAX_CARD_LIMIT);

    await expect(layeredSearch({ store, query: "端口", scope: projectA, limit: 11 })).rejects.toThrow(
      RetrievalError,
    );
    await expect(layeredSearch({ store, query: "端口", scope: projectA, limit: 0 })).rejects.toThrow(
      /limit must be an integer from 1 to 10/u,
    );
  });

  it("pages the Active ranking without repeating a card", async () => {
    const store = newStore();
    for (let index = 0; index < 12; index += 1) {
      seedMemory(store, {
        memory_id: `mem-${String(index).padStart(2, "0")}`,
        title: `端口约定 ${index}`,
        nav_text: `端口约定 ${index}，部署端口记录。`,
      });
    }

    const seen: string[] = [];
    for (const offset of [0, 5, 10]) {
      const page = await layeredSearch({ store, query: "端口", scope: projectA, limit: 5, offset });
      seen.push(...page.result.cards.map((card) => card.memory_id));
    }
    expect(seen.length).toBe(12);
    expect(new Set(seen).size).toBe(12);
  });

  it("reports not_found with no cards and no next action when nothing matches", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "端口约定。" });

    const outcome = await layeredSearch({ store, query: "完全不存在的词", scope: projectA });
    expect(outcome.result.status).toBe("not_found");
    expect(outcome.result.cards).toEqual([]);
    expect(outcome.result.memory_summary).toBeNull();
    expect(outcome.result.next_action).toBeNull();
    expect(outcome.result.missing).toEqual([]);
    expect(outcome.measured.result_bytes).toBeGreaterThan(0);
  });
});

describe("layered search: measurement and budget", () => {
  it("records zero model calls and a bounded payload", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "部署配置与默认端口。" });

    const outcome = await layeredSearch({ store, query: "端口", scope: projectA });
    expect(outcome.result.budget_used.model_calls).toBe(0);
    expect(outcome.result.budget_used.tokens_in).toBe(0);
    expect(outcome.result.budget_used.tokens_out).toBe(0);
    expect(outcome.result.budget_used.cost_usd).toBeNull();
    expect(outcome.result.budget_used.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(outcome.measured.estimated_tokens).toBe(Math.ceil(outcome.measured.result_bytes / 4));
    expect(outcome.measured.result_bytes).toBeLessThanOrEqual(64 * 1024);
    expect(outcome.result.persistence_status).toBe("not_attempted");
    expect(outcome.result.answer).toBeNull();
  });

  it("rejects a blank query", async () => {
    const store = newStore();
    await expect(layeredSearch({ store, query: "   ", scope: projectA })).rejects.toThrow(RetrievalError);
  });

  it("never touches the history port without an explicit ask", async () => {
    const store = newStore();
    seedMemory(store, { memory_id: "mem-port", nav_text: "端口约定。" });
    const fake = makeHistoryPort({ hits: [] });

    const outcome = await layeredSearch({
      store,
      query: "端口",
      scope: projectA,
      history: fake.port,
    });
    expect(fake.calls.probe).toBe(0);
    expect(fake.calls.search).toBe(0);
    const history = outcome.layers.find((layer) => layer.layer === "history");
    expect(history?.status).toBe("skipped");
    expect(history?.reason).toBe("not_requested");
    expect(outcome.measured.history_available).toBe(false);
  });
});
