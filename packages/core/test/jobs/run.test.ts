/**
 * Stage-two runner: publish + admit only after a validated nav, keep the medium
 * body readable when the job fails, and never publish the same revision twice.
 */

import { afterEach, describe, expect, it } from "vitest";
import { runDueJobs, enqueueSummaryJob, readSummaryJob, claimDueSummaryJob } from "../../src/jobs/index.js";
import type { ModelPort } from "../../src/resolver/index.js";
import type { MemoryStore } from "../../src/storage/index.js";
import { PROJECT_A, openTempStore, seedMemory } from "../retrieval/support.js";
import { makeScriptedModel } from "../extraction/support.js";

const stores: MemoryStore[] = [];

function newStore(): MemoryStore {
  const store = openTempStore();
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

const AT = "2026-11-17T10:00:00.000Z";
const NAV = "这条记忆记录部署默认端口与回滚方式，改端口或回滚时值得读取。";

function mediumReady(store: MemoryStore, memoryId = "mem-job") {
  const memory = seedMemory(store, { memory_id: memoryId, state: "medium_ready" });
  enqueueSummaryJob(store.database(), { memory_id: memoryId, revision: 1, at: AT });
  return memory;
}

describe("runDueJobs", () => {
  it("generates a <=200 code point nav, publishes and admits the memory", async () => {
    const store = newStore();
    const memory = mediumReady(store);
    const model = makeScriptedModel((kind) =>
      kind === "nav" ? { text: JSON.stringify({ nav: NAV }) } : { text: "{}" },
    );

    const outcome = await runDueJobs({ store, model: model.port, model_id: "stub/model" });
    expect(outcome.claimed).toBe(1);
    expect(outcome.completed).toBe(1);
    expect(outcome.results[0]?.state).toBe("done");
    expect(outcome.results[0]?.admitted?.admitted).toBe(true);

    const published = store.readMemory(memory.uri, 1);
    expect(published?.state).toBe("published");
    expect(published?.nav?.text).toBe(NAV);
    expect(published?.nav?.char_count).toBeLessThanOrEqual(200);
    expect(published?.nav?.source_revision).toBe(1);
    expect(published?.medium.body).toBe(memory.medium.body);
    expect(store.readHotspotMemberships(PROJECT_A).map((row) => row.memory_id)).toContain("mem-job");
    expect(readSummaryJob(store.database(), "mem-job", 1)?.state).toBe("done");
    expect(model.requests.at(-1)?.user_agent).toBe("vestigio/nav");
  });

  it("leaves the medium summary readable while the nav call fails, then retries", async () => {
    const store = newStore();
    const memory = mediumReady(store);
    const failing = makeScriptedModel((kind) => (kind === "nav" ? { text: "{}" } : { text: "{}" }), {
      fail_nav: true,
    });

    const first = await runDueJobs({ store, model: failing.port, model_id: "stub/model" });
    expect(first.results[0]?.state).toBe("retried");
    expect(first.results[0]?.reason).toBe("nav_failed:model_unavailable:nav_down");
    expect(readSummaryJob(store.database(), "mem-job", 1)?.state).toBe("pending");
    const stillReadable = store.readMemory(memory.uri, 1);
    expect(stillReadable?.state).toBe("medium_ready");
    expect(stillReadable?.medium.body).toBe(memory.medium.body);
    expect(stillReadable?.nav).toBeNull();
    expect(store.readHotspotMemberships(PROJECT_A)).toHaveLength(0);

    const succeeding = makeScriptedModel((kind) =>
      kind === "nav" ? { text: JSON.stringify({ nav: NAV }) } : { text: "{}" },
    );
    const second = await runDueJobs({ store, model: succeeding.port, model_id: "stub/model" });
    expect(second.results[0]?.state).toBe("done");
    expect(store.readMemory(memory.uri, 1)?.state).toBe("published");
  });

  it("ends failed after the attempt ceiling and keeps the last error", async () => {
    const store = newStore();
    const memory = mediumReady(store);
    const failing = makeScriptedModel((kind) => (kind === "nav" ? { text: "{}" } : { text: "{}" }), {
      fail_nav: true,
    });
    for (let run = 0; run < 3; run += 1) {
      await runDueJobs({ store, model: failing.port, model_id: "stub/model" });
    }
    const job = readSummaryJob(store.database(), "mem-job", 1);
    expect(job?.state).toBe("failed");
    expect(job?.attempts).toBe(3);
    expect(job?.last_error).toContain("nav_down");
    expect(store.readMemory(memory.uri, 1)?.medium.body).toBe(memory.medium.body);
  });

  it("does not duplicate a nav after a lease expires", async () => {
    const store = newStore();
    const memory = mediumReady(store);
    const model = makeScriptedModel((kind) =>
      kind === "nav" ? { text: JSON.stringify({ nav: NAV }) } : { text: "{}" },
    );
    await runDueJobs({ store, model: model.port, model_id: "stub/model" });
    const published = store.readMemory(memory.uri, 1);
    expect(published?.nav?.text).toBe(NAV);
    const navCalls = model.nav_calls;

    // Simulate a worker that died holding an expired lease after it published.
    store
      .database()
      .prepare(
        "UPDATE summary_jobs SET state = 'running', lease_owner = 'dead', lease_expires_at = ?, attempts = 1 WHERE memory_id = ? AND revision = 1",
      )
      .run(Date.parse(AT), "mem-job");

    const rerun = await runDueJobs({
      store,
      model: model.port,
      model_id: "stub/model",
      now: () => Date.parse(AT) + 120_000,
    });
    expect(rerun.results[0]?.state).toBe("done");
    expect(rerun.results[0]?.reason).toBeNull();
    expect(model.nav_calls).toBe(navCalls);
    expect(store.readMemory(memory.uri, 1)?.nav?.text).toBe(NAV);
  });

  it("reports deadline_exceeded instead of publishing late output", async () => {
    const store = newStore();
    const memory = mediumReady(store);
    const slow: ModelPort = {
      async complete() {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          ok: true,
          value: {
            text: JSON.stringify({ nav: NAV }),
            model: "slow",
            finish_reason: "stop",
            usage: { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
          },
        };
      },
    };
    const outcome = await runDueJobs({
      store,
      model: slow,
      model_id: "stub/slow",
      deadline_ms: 5,
    });
    expect(outcome.results[0]?.state).toBe("retried");
    expect(outcome.results[0]?.reason).toBe("deadline_exceeded");
    expect(store.readMemory(memory.uri, 1)?.nav).toBeNull();
  });

  it("says model_not_configured and leaves every job pending", async () => {
    const store = newStore();
    mediumReady(store);
    const outcome = await runDueJobs({ store, model: null });
    expect(outcome.claimed).toBe(0);
    expect(outcome.missing).toContain("model_not_configured");
    expect(readSummaryJob(store.database(), "mem-job", 1)?.state).toBe("pending");
  });

  it("claims one job per call and leaves the rest for the next batch", async () => {
    const store = newStore();
    mediumReady(store, "mem-a");
    mediumReady(store, "mem-b");
    const model = makeScriptedModel((kind) =>
      kind === "nav" ? { text: JSON.stringify({ nav: NAV }) } : { text: "{}" },
    );
    const outcome = await runDueJobs({ store, model: model.port, model_id: "stub/model", limit: 1 });
    expect(outcome.claimed).toBe(1);
    expect(outcome.completed).toBe(1);
    const claimable = claimDueSummaryJob(store.database(), {
      now_ms: Date.parse(AT) + 1000,
      lease_ms: 1000,
      owner: "probe",
    });
    expect(claimable).not.toBeNull();
  });
});
