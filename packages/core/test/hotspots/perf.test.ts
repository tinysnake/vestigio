import { describe, expect, it } from "vitest";
import { InjectionLedger, planInjection } from "../../src/hotspots/index.js";
import { DEFAULT_HOTSPOT_POOL_CAPACITY } from "../../src/hotspots/index.js";
import { PROJECT, newStore, seedMemory, setActivity } from "./support.js";

const POOL_SIZE = DEFAULT_HOTSPOT_POOL_CAPACITY;
const TURNS = 400;

function navFor(index: number): string {
  const base = `第 ${index} 条记忆：记录模块 ${index} 的配置项、默认值、变更历史与回滚步骤，涉及该模块的改动前值得读取。`;
  let text = base;
  while ([...text].length < 150) {
    text += `补充：模块 ${index} 的依赖、注意事项与排障结论。`;
  }
  return [...text].slice(0, 200).join("");
}

function queryFor(index: number): string {
  switch (index % 5) {
    case 0:
      return `模块 ${index % POOL_SIZE} 的配置要怎么改`;
    case 1:
      return `mod-${index % POOL_SIZE} 回滚步骤在哪里`;
    case 2:
      return "今天天气不错，顺便看看日志";
    case 3:
      return `请检查 ${index} 号流水线的排队策略`;
    default:
      return "the deployment pipeline is green";
  }
}

describe("hotspot match path performance", () => {
  it(`stays under the one second ceiling across ${TURNS} turns on a full pool`, () => {
    const store = newStore();
    for (let index = 0; index < POOL_SIZE; index += 1) {
      seedMemory(store, {
        memory_id: `mem-${String(index).padStart(4, "0")}`,
        title: `模块 ${index} 配置与回滚`,
        keywords: [`模块${index}`, `mod-${index}`, "配置", "回滚"],
        nav: navFor(index),
        admitted_seq: index + 1,
      });
    }
    setActivity(store, PROJECT, 50);

    const times: number[] = [];
    const elapsed: number[] = [];
    const addedBytes: number[] = [];
    const reasons = new Map<string, number>();
    let injectedTurns = 0;

    for (let turn = 0; turn < TURNS; turn += 1) {
      const text = queryFor(turn);
      const started = performance.now();
      const result = planInjection({
        store,
        project_id: PROJECT,
        session_id: "s-perf",
        branch_ref: "main",
        input_id: `input-${turn}`,
        text,
        ledger: new InjectionLedger(),
      });
      times.push(performance.now() - started);
      elapsed.push(result.elapsed_ms);
      reasons.set(result.reason ?? "injected", (reasons.get(result.reason ?? "injected") ?? 0) + 1);
      if (result.status === "injected") {
        injectedTurns += 1;
        addedBytes.push(result.budget.used_bytes);
        expect(result.budget.used_bytes).toBeLessThanOrEqual(result.budget.limit_bytes);
      }
    }

    const sorted = [...times].sort((left, right) => left - right);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;
    const averageBytes =
      addedBytes.length === 0
        ? 0
        : addedBytes.reduce((sum, value) => sum + value, 0) / addedBytes.length;

    // eslint-disable-next-line no-console
    console.log(
      `hotspot perf: pool=${POOL_SIZE} turns=${TURNS} injected=${injectedTurns} ` +
        `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms ` +
        `avg_block_bytes=${averageBytes.toFixed(1)} avg_added_tokens=${(averageBytes / 4).toFixed(1)} ` +
        `reasons=${JSON.stringify(Object.fromEntries(reasons))}`,
    );

    expect(reasons.get("timeout")).toBeUndefined();
    expect(p95).toBeLessThan(1000);
    expect(max).toBeLessThan(1000);
    expect(Math.max(...elapsed)).toBeLessThan(1000);
    expect(injectedTurns).toBeGreaterThan(0);
    store.close();
  });
});
