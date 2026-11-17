import { describe, expect, it } from "vitest";
import { NAV_TEXT_MAX } from "../../src/contracts/index.js";
import {
  MAX_INJECTED_NAV_CHARS,
  clampSummary,
  renderInjectionBlock,
} from "../../src/hotspots/index.js";
import { makeMatch } from "./support.js";

describe("clampSummary", () => {
  it("leaves a compliant summary untouched", () => {
    const text = "部署配置与默认端口，改端口前值得读取。";
    expect(clampSummary(text)).toBe(text);
  });

  it("cuts a long summary to the short-summary ceiling and marks the cut", () => {
    const text = "长".repeat(300);
    const clamped = clampSummary(text);
    expect([...clamped]).toHaveLength(NAV_TEXT_MAX);
    expect([...clamped]).toHaveLength(MAX_INJECTED_NAV_CHARS);
    expect(clamped.endsWith("…")).toBe(true);
  });
});

describe("renderInjectionBlock", () => {
  it("renders the title, URI, short summary, source and the real read syntax", () => {
    const match = makeMatch({ nav_text: "部署配置与默认端口。", source_label: "pi/local", source_count: 1 });
    const rendered = renderInjectionBlock({ matches: [match] });
    expect(rendered.included).toHaveLength(1);
    expect(rendered.block).toContain("部署脚本默认端口");
    expect(rendered.block).toContain("memory://vestigio/mem-0001");
    expect(rendered.block).toContain("部署配置与默认端口。");
    expect(rendered.block).toContain("pi/local");
    expect(rendered.block).toContain(`memory_read(uri="memory://vestigio/mem-0001")`);
    expect(rendered.used_bytes).toBe(Buffer.byteLength(rendered.block ?? "", "utf8"));
  });

  it("never leaks the medium body", () => {
    const match = makeMatch();
    const rendered = renderInjectionBlock({ matches: [match] });
    expect(rendered.block).not.toContain("补充说明部署步骤与回滚方式");
  });

  it("keeps the whole block inside the byte budget and drops the overflow", () => {
    const a = makeMatch({ memory_id: "mem-a" });
    const b = makeMatch({ memory_id: "mem-b" });
    const c = makeMatch({ memory_id: "mem-c" });
    const one = renderInjectionBlock({ matches: [a] });
    const budget = one.used_bytes + 10;
    const rendered = renderInjectionBlock({ matches: [a, b, c], budget_bytes: budget });
    expect(rendered.included).toHaveLength(1);
    expect(rendered.dropped).toEqual(["mem-b", "mem-c"]);
    expect(Buffer.byteLength(rendered.block ?? "", "utf8")).toBeLessThanOrEqual(budget);
  });

  it("returns no block at all when not even one entry fits", () => {
    const rendered = renderInjectionBlock({ matches: [makeMatch()], budget_bytes: 40 });
    expect(rendered.block).toBeNull();
    expect(rendered.included).toEqual([]);
    expect(rendered.dropped).toEqual(["mem-0001"]);
  });

  it("reports which summaries had to be clamped", () => {
    const rendered = renderInjectionBlock({
      matches: [makeMatch({ memory_id: "mem-long", nav_text: "长".repeat(240) })],
    });
    expect(rendered.truncated).toEqual(["mem-long"]);
    expect(rendered.block).toContain("…");
  });
});
