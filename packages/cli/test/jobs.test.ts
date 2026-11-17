/**
 * `vestigio jobs run` wiring: it publishes a pending job with a configured
 * model, and says `model_not_configured` (exit 0, job still pending) without
 * one. Both are the truth the operator needs; neither is a silent skip.
 */

import { afterEach, describe, expect, it } from "vitest";
import { countSummaryJobs, enqueueSummaryJob, readSummaryJob } from "@vestigio/core/jobs";
import type { ModelPort } from "@vestigio/core/resolver";
import { openStore, type MemoryStore } from "@vestigio/core/storage";
import { main } from "../src/index.js";
import { PROJECT_A, captureIo, seed, tempDbPath } from "./support.js";

const stores: MemoryStore[] = [];
const NAV = "这条记忆记录默认端口与回滚方式，改端口前值得读。";

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function seedPendingJob(): { path: string; memory: ReturnType<typeof seed> } {
  const path = tempDbPath("jobs");
  const store = openStore({ path });
  stores.push(store);
  const memory = seed(store, { memory_id: "mem-job", state: "medium_ready" });
  enqueueSummaryJob(store.database(), { memory_id: memory.memory_id, revision: 1, at: "2026-11-17T10:00:00.000Z" });
  expect(countSummaryJobs(store.database())).toBe(1);
  return { path, memory };
}

function navModel(): ModelPort {
  return {
    async complete() {
      return {
        ok: true,
        value: {
          text: JSON.stringify({ nav: NAV }),
          model: "fake",
          finish_reason: "stop",
          usage: { tokens_in: 50, tokens_out: 10, cost_usd: 0.0002 },
        },
      };
    },
  };
}

async function run(argv: readonly string[], model?: ModelPort): Promise<{ code: number; out: string; err: string }> {
  const captured = captureIo();
  const code = await main(argv, captured.io, {
    open: (options) => openStore(options),
    ...(model === undefined ? {} : { createModel: () => model }),
  });
  return { code, out: captured.stdout(), err: captured.stderr() };
}

describe("vestigio jobs run", () => {
  it("publishes and admits with a configured model", async () => {
    const { path, memory } = seedPendingJob();
    const result = await run(
      [
        "jobs",
        "run",
        "--db",
        path,
        "--model-base-url",
        "http://127.0.0.1:9",
        "--model-id",
        "stub/nav",
        "--json",
      ],
      navModel(),
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out) as {
      claimed: number;
      completed: number;
      results: { nav: string | null; admitted: { admitted: boolean } | null }[];
      model_info: { model_id: string };
    };
    expect(payload.claimed).toBe(1);
    expect(payload.completed).toBe(1);
    expect(payload.results[0]?.nav).toBe(NAV);
    expect(payload.results[0]?.admitted?.admitted).toBe(true);
    expect(payload.model_info.model_id).toBe("stub/nav");

    const store = stores[0];
    if (store === undefined) throw new Error("store closed");
    expect(store.readMemory(memory.uri, 1)?.state).toBe("published");
    expect(store.readHotspotMemberships(PROJECT_A).map((row) => row.memory_id)).toContain("mem-job");
    expect(readSummaryJob(store.database(), "mem-job", 1)?.state).toBe("done");
  });

  it("says model_not_configured and leaves the job pending", async () => {
    const { path } = seedPendingJob();
    const result = await run(["jobs", "run", "--db", path]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("model_not_configured");
    expect(result.out).toContain("claimed=0");
    const store = stores[0];
    if (store === undefined) throw new Error("store closed");
    expect(readSummaryJob(store.database(), "mem-job", 1)?.state).toBe("pending");
  });

  it("rejects a missing subcommand as a usage error", async () => {
    const { path } = seedPendingJob();
    const result = await run(["jobs", "--db", path]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("jobs needs exactly one subcommand: run");
  });
});
