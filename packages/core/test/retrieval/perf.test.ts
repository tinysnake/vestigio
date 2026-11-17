/**
 * The plan's performance bound for PR-04: a base medium query over a fixed
 * synthetic corpus must stay inside 200 ms at p95, on the zero-LLM path.
 *
 * Not gated: this is the regression guard for the bound. The corpus is built
 * deterministically (no clock, no randomness) so the numbers are comparable
 * across runs, and the measured result bytes/tokens are reported next to the
 * latency so the comparison with PR-01's direct Obelisk search has units.
 */

import { afterAll, describe, expect, it } from "vitest";
import { type MemoryStore } from "../../src/storage/index.js";
import { layeredSearch } from "../../src/retrieval/index.js";
import { PROJECT_A, openTempStore, seedMemory } from "./support.js";

const PROJECTS = 24;
const PER_PROJECT = 8;
const ITERATIONS = 120;
const BASE_MEDIUM_QUERY = "部署脚本默认端口配置说明";
const P95_BUDGET_MS = 200;

const FILLER = "补充说明部署步骤与回滚方式，默认端口可以在环境变量里覆盖。";

function bodyFor(project: number, index: number): string {
  let body = `项目 ${project} 的第 ${index} 条记忆：部署脚本默认端口配置说明。`;
  let pad = 0;
  while ([...body.replace(/\s/gu, "")].length < 560) {
    body += `${FILLER}${pad === 0 ? "" : `（第 ${pad} 段）`}`;
    pad += 1;
  }
  return body;
}

const store: MemoryStore = openTempStore();
const scope = { kind: "project", project_id: `${PROJECT_A}-0` } as const;

for (let project = 0; project < PROJECTS; project += 1) {
  for (let index = 0; index < PER_PROJECT; index += 1) {
    const id = `mem-${project}-${index}`;
    seedMemory(store, {
      memory_id: id,
      scope: { kind: "project", project_id: `${PROJECT_A}-${project}` },
      title: `部署脚本默认端口 ${project}-${index}`,
      keywords: ["部署", "端口", "记忆"],
      nav_text: `项目 ${project} 记忆 ${index}：部署脚本默认端口配置说明。`,
      body: bodyFor(project, index),
    });
  }
}

afterAll(() => {
  store.close();
});

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? 0;
}

describe("layered search performance", () => {
  it("keeps the base medium query inside 200 ms at p95", async () => {
    expect(store.integrityCheck().headCount).toBe(PROJECTS * PER_PROJECT);

    const elapsed: number[] = [];
    let bytes = 0;
    let tokens = 0;
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const outcome = await layeredSearch({ store, query: BASE_MEDIUM_QUERY, scope });
      elapsed.push(outcome.result.budget_used.elapsed_ms);
      bytes = outcome.measured.result_bytes;
      tokens = outcome.measured.estimated_tokens;
    }

    const p50 = percentile(elapsed, 0.5);
    const p95 = percentile(elapsed, 0.95);
    const max = Math.max(...elapsed);
    console.log(
      `perf-ledger base-medium-query: ${JSON.stringify({
        corpus_memories: PROJECTS * PER_PROJECT,
        iterations: ITERATIONS,
        p50_ms: Number(p50.toFixed(3)),
        p95_ms: Number(p95.toFixed(3)),
        max_ms: Number(max.toFixed(3)),
        budget_ms: P95_BUDGET_MS,
        result_bytes: bytes,
        estimated_tokens: tokens,
      })}`,
    );

    expect(p50).toBeLessThanOrEqual(P95_BUDGET_MS);
    expect(p95).toBeLessThanOrEqual(P95_BUDGET_MS);
    expect(bytes).toBeLessThanOrEqual(65536);
    expect(tokens).toBe(Math.ceil(bytes / 4));
  });

  it("p95 also holds for a query that reaches the Archived index", async () => {
    const archivedScope = { kind: "project", project_id: `${PROJECT_A}-0` } as const;
    // Archive one project's rows so the fall-through and the explicit widening
    // both have real work to do.
    for (let index = 0; index < PER_PROJECT; index += 1) {
      store.setMemoryState(`memory://vestigio/mem-0-${index}`, "archived");
    }
    const samples: number[] = [];
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const outcome = await layeredSearch({
        store,
        query: BASE_MEDIUM_QUERY,
        scope: archivedScope,
        include_archived: true,
      });
      samples.push(outcome.result.budget_used.elapsed_ms);
    }
    const p95 = percentile(samples, 0.95);
    console.log(
      `perf-ledger archived-widening: ${JSON.stringify({
        iterations: ITERATIONS,
        p95_ms: Number(p95.toFixed(3)),
        budget_ms: P95_BUDGET_MS,
      })}`,
    );
    expect(p95).toBeLessThanOrEqual(P95_BUDGET_MS);
  });
});
