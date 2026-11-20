import { describe, expect, it } from "vitest";
import { buildKeywords, formationKeywords, MEMORY_KEYWORDS_MAX } from "../../src/resolver/index.js";

describe("formationKeywords", () => {
  it("puts a grounded alias before the question's terms for a new memory", () => {
    expect(formationKeywords("镜像标签规则", [], ["容器"])).toEqual(["容器", "镜像标签规则"]);
  });

  it("keeps existing keywords first and adds an alias on merge", () => {
    expect(formationKeywords("容器命名规则", ["镜像", "标签"], ["容器"])).toEqual([
      "镜像",
      "标签",
      "容器",
      "容器命名规则",
    ]);
  });

  it("does not duplicate a term already stored", () => {
    expect(formationKeywords("容器命名规则", ["容器"], ["容器"])).toEqual(["容器", "容器命名规则"]);
  });

  it("keeps an alias ahead of question terms at the cap", () => {
    const question = "一甲 二甲 三甲 四甲 五甲 六甲 七甲 八甲";
    expect(formationKeywords(question, [], ["别名"])).toEqual([
      "别名",
      "一甲",
      "二甲",
      "三甲",
      "四甲",
      "五甲",
      "六甲",
      "七甲",
    ]);
  });

  it(`caps the merged vocabulary at ${MEMORY_KEYWORDS_MAX}`, () => {
    const existing = ["镜像", "标签", "部署", "端口", "容器", "命名", "推送", "规则"];
    const merged = formationKeywords("新词 另一个", existing, ["别名"]);
    expect(merged).toEqual(existing);
  });

  it("retains keywords written before the cap, even if there is no room for an alias", () => {
    const existing = ["镜像", "标签", "部署", "端口", "容器", "命名", "推送", "规则", "仓库", "v"];
    expect(formationKeywords("新词", existing, ["别名"])).toEqual(existing);
  });

  it("still yields the question fallback when every input is empty", () => {
    expect(buildKeywords("")).toEqual(["memory"]);
  });
});
