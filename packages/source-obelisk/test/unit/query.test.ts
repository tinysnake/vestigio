import { describe, expect, it } from "vitest";
import { PREFIX_MIN_CODEPOINTS, expandFtsQuery } from "../../src/query.js";

describe("expandFtsQuery — prefix expansion for the unicode61 tokenizer", () => {
  it("prefixes a multi-character Chinese term, which is the whole point", () => {
    const expanded = expandFtsQuery("灰度发布");
    expect(expanded.text).toBe("灰度发布*");
    expect(expanded.expanded).toBe(true);
    expect(expanded.original).toBe("灰度发布");
    expect(expanded.terms).toEqual(["灰度发布*"]);
  });

  it("prefixes every term and collapses whitespace", () => {
    expect(expandFtsQuery("灰度发布   缓存").text).toBe("灰度发布* 缓存*");
  });

  it("prefixes an ASCII term too, because Chinese glues it into a longer token", () => {
    // `itgc后50条悬空引用清零` is one token, so plain `itgc` matches nothing.
    expect(expandFtsQuery("itgc").text).toBe("itgc*");
  });

  it("keeps an internal hyphen: the tokenizer splits it, and `*` binds to the last piece", () => {
    expect(expandFtsQuery("Cache-Control").text).toBe("Cache-Control*");
  });

  it(`leaves a single token character alone (PREFIX_MIN_CODEPOINTS is ${PREFIX_MIN_CODEPOINTS})`, () => {
    expect(expandFtsQuery("灰").expanded).toBe(false);
    expect(expandFtsQuery("灰 缓存").text).toBe("灰 缓存*");
  });

  it("trims punctuation the tokenizer would treat as a separator anyway", () => {
    expect(expandFtsQuery("端口？").text).toBe("端口*");
    expect(expandFtsQuery("（部署）").text).toBe("部署*");
  });

  it("passes a query that already speaks FTS5 through untouched", () => {
    for (const query of [
      '"灰度发布"',
      "灰度发布*",
      "灰度 OR 缓存",
      "灰度 AND 缓存",
      "灰度 NOT 缓存",
      "NEAR(灰度 缓存)",
      "-缓存",
      "+缓存",
      "error: ENOENT",
      "(灰度 缓存)",
      "^灰度",
    ]) {
      const expanded = expandFtsQuery(query);
      expect(expanded.expanded, query).toBe(false);
      expect(expanded.text, query).toBe(query);
      expect(expanded.terms, query).toEqual([]);
    }
  });

  it("is idempotent: its own output counts as explicit syntax", () => {
    const once = expandFtsQuery("灰度发布 缓存");
    const twice = expandFtsQuery(once.text);
    expect(twice.expanded).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  it("returns the input unchanged when there is nothing to expand", () => {
    for (const query of ["", "   ", "？。", "灰"]) {
      const expanded = expandFtsQuery(query);
      expect(expanded.expanded, JSON.stringify(query)).toBe(false);
      expect(expanded.text).toBe(query);
    }
  });
});
