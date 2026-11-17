import { describe, expect, it } from "vitest";
import { PHRASE_BONUS, matchHotspots, matchTokens } from "../../src/hotspots/index.js";
import { makeEntry } from "./support.js";

describe("matchTokens", () => {
  it("drops single code points and function words but keeps content tokens", () => {
    expect(matchTokens("")).toEqual([]);
    expect(matchTokens("the and for")).toEqual([]);
    expect(matchTokens("服")).toEqual([]);
    expect(matchTokens("部署端口")).toContain("部署");
    expect(matchTokens("deploy-port")).toContain("deploy");
  });
});

describe("matchHotspots", () => {
  it("matches once per memory even when several aliases hit", () => {
    const entry = makeEntry({
      keywords: ["部署", "端口", "deploy"],
      nav_text: "部署配置与默认端口，改端口前值得读取。",
    });
    const matches = matchHotspots({ entries: [entry], text: "deploy 部署 端口 都要检查" });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.memory_id).toBe("mem-0001");
    expect(matches[0]?.matched_tokens.length).toBeGreaterThanOrEqual(3);
  });

  it("bonuses a multi-word alias that occurs as a contiguous phrase", () => {
    const entry = makeEntry({ keywords: ["deploy port"], nav_text: "改端口前值得读取的一条记忆。" });
    const phrase = matchHotspots({ entries: [entry], text: "we should deploy port now" });
    expect(phrase).toHaveLength(1);
    expect(phrase[0]?.phrase_matched).toBe(true);
    expect(phrase[0]?.score).toBeGreaterThanOrEqual(PHRASE_BONUS);

    const single = matchHotspots({
      entries: [makeEntry({ keywords: ["deploy port"], nav_text: "改端口前值得读取的一条记忆。" })],
      text: "we deploy everything",
    });
    expect(single[0]?.phrase_matched).toBe(false);
  });

  it("never matches a short English identifier inside an unrelated word", () => {
    const entry = makeEntry({ keywords: ["id"], nav_text: "无" });
    expect(matchHotspots({ entries: [entry], text: "identity provided" })).toEqual([]);
    expect(matchHotspots({ entries: [entry], text: "id provided" })).toHaveLength(1);
  });

  it("never treats a lone CJK character as a signal, even as an alias", () => {
    expect(matchHotspots({ entries: [makeEntry({ keywords: ["端口"] })], text: "服" })).toEqual([]);
    expect(matchHotspots({ entries: [makeEntry({ keywords: ["服"] })], text: "服" })).toEqual([]);
  });

  it("accepts a short Latin token only when it is an explicit alias", () => {
    const alias = makeEntry({ keywords: ["ci"], nav_text: "流水线配置" });
    expect(matchHotspots({ entries: [alias], text: "ci 挂了" })).toHaveLength(1);
    const prose = makeEntry({ keywords: ["部署"], nav_text: "ci 说明" });
    expect(matchHotspots({ entries: [prose], text: "ci 挂了" })).toEqual([]);
  });

  it("ranks a stronger token overlap ahead of a weaker one", () => {
    const strong = makeEntry({ memory_id: "mem-strong", keywords: ["部署", "端口", "回滚"], nav_text: "部署 端口 回滚" });
    const weak = makeEntry({ memory_id: "mem-weak", keywords: ["部署"], nav_text: "部署" });
    const matches = matchHotspots({ entries: [weak, strong], text: "部署 端口 回滚 步骤" });
    expect(matches.map((it) => it.memory_id)).toEqual(["mem-strong", "mem-weak"]);
  });

  it("caps the number of memories per turn", () => {
    const entries = ["mem-a", "mem-b", "mem-c", "mem-d", "mem-e"].map((memory_id) =>
      makeEntry({ memory_id, keywords: ["端口"], nav_text: "端口" }),
    );
    expect(matchHotspots({ entries, text: "端口", max_matches: 3 })).toHaveLength(3);
    expect(matchHotspots({ entries, text: "端口" })).toHaveLength(3);
  });

  it("returns nothing when the input carries no signal", () => {
    expect(matchHotspots({ entries: [makeEntry()], text: "the and for" })).toEqual([]);
  });
});
