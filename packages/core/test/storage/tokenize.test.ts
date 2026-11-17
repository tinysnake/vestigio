import { describe, expect, it } from "vitest";
import { parseMemory } from "../../src/contracts/index.js";
import { buildMatchQuery, normalizeForIndex } from "../../src/storage/index.js";
import { bodyWith, navWith, openTempStore, storedMemory } from "./support.js";

const SENTENCE = "一二期服务器部署配置，pi-agent 使用 memory.search 查询。";

describe("normalizeForIndex", () => {
  it("emits CJK unigrams and overlapping bigrams", () => {
    expect(normalizeForIndex("服务器")).toEqual(["服", "务", "服务", "器", "务器"]);
    expect(normalizeForIndex("配置")).toEqual(["配", "置", "配置"]);
  });

  it("lowercases Latin and splits identifiers on - and _", () => {
    expect(normalizeForIndex("pi")).toEqual(["pi"]);
    expect(normalizeForIndex("pi-agent")).toEqual(["pi", "agent"]);
    expect(normalizeForIndex("memory_search")).toEqual(["memory", "search"]);
    expect(normalizeForIndex("memory.search")).toEqual(["memory", "search"]);
    expect(normalizeForIndex("PI-Agent")).toEqual(["pi", "agent"]);
  });

  it("normalizes full-width characters and drops punctuation-only input", () => {
    expect(normalizeForIndex("ＰＩ－Ａｇｅｎｔ")).toEqual(["pi", "agent"]);
    expect(normalizeForIndex("，。！？ ——")).toEqual([]);
  });

  it("quotes every token so query punctuation can never become FTS5 syntax", () => {
    expect(buildMatchQuery("pi-agent")).toBe('"pi" AND "agent"');
    expect(buildMatchQuery('foo" OR *')).toBe('"foo" AND "or"');
    expect(buildMatchQuery("，。")).toBeNull();
  });

  it("supports an any-token query mode", () => {
    expect(buildMatchQuery("服务器", "any")).toBe('"服" OR "务" OR "服务" OR "器" OR "务器"');
  });
});

describe("tokenization against the FTS index", () => {
  /** The six cases the store must answer without a model. */
  const cases = ["服务器", "配置", "部署", "pi", "pi-agent", "memory.search"] as const;

  it.each(cases)("matches %s in a stored medium body", (query) => {
    const store = openTempStore();
    store.saveMemory(parseMemory(storedMemory({ body: bodyWith(SENTENCE) })));
    expect(store.searchActive(query).map((hit) => hit.memory_id)).toEqual(["mem-0001"]);
    store.close();
  });

  it("does not match a word that is absent", () => {
    const store = openTempStore();
    store.saveMemory(parseMemory(storedMemory({ body: bodyWith(SENTENCE) })));
    expect(store.searchActive("数据库")).toEqual([]);
    expect(store.searchActive("zzz")).toEqual([]);
    store.close();
  });

  it("finds a two-character word, which the trigram tokenizer cannot", () => {
    const store = openTempStore();
    store.saveMemory(parseMemory(storedMemory({ body: bodyWith(SENTENCE) })));
    // '配置' is two code points; tokenize='trigram' requires at least three.
    expect(store.searchActive("配置").length).toBe(1);
    store.close();
  });

  it("ranks the memory carrying the query terms first", () => {
    const store = openTempStore();
    store.saveMemory(
      parseMemory(
        storedMemory({
          body: bodyWith("这个项目的部署配置全部集中在 deploy.sh。"),
          title: "部署配置",
          keywords: ["部署", "配置"],
        }),
      ),
    );
    store.saveMemory(
      parseMemory(
        storedMemory({
          memory_id: "mem-0002",
          uri: "memory://vestigio/mem-0002",
          body: bodyWith("无关内容：前端样式与图标资源。"),
          title: "前端样式",
          keywords: ["样式"],
          nav: navWith("图标与主题样式说明。"),
        }),
      ),
    );
    expect(store.searchActive("部署配置").map((hit) => hit.memory_id)).toEqual(["mem-0001"]);
    store.close();
  });
});
