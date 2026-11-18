/**
 * Queue mechanics: idempotent enqueue, one owner per claim, lease expiry as a
 * retry (same row, incremented attempts), and exhausted attempts ending failed
 * with the last error kept.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  SUMMARY_JOB_MAX_ATTEMPTS,
  claimDueSummaryJob,
  completeSummaryJob,
  countSummaryJobs,
  enqueueSummaryJob,
  failSummaryJob,
  readSummaryJob,
} from "../../src/jobs/index.js";
import type { MemoryStore } from "../../src/storage/index.js";
import { openTempStore } from "../retrieval/support.js";

const stores: MemoryStore[] = [];

function newStore(): MemoryStore {
  const store = openTempStore();
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

const T0 = Date.parse("2026-11-17T10:00:00.000Z");
const AT = new Date(T0).toISOString();

describe("summary job queue", () => {
  it("enqueues one row per (memory, revision)", () => {
    const store = newStore();
    const db = store.database();
    const first = enqueueSummaryJob(db, { memory_id: "mem-a", revision: 1, at: AT });
    const second = enqueueSummaryJob(db, { memory_id: "mem-a", revision: 1, at: AT });
    expect(second.job_id).toBe(first.job_id);
    expect(countSummaryJobs(db)).toBe(1);
    expect(readSummaryJob(db, "mem-a", 1)?.state).toBe("pending");
  });

  it("claims only the job scoped to one memory and revision", () => {
    const store = newStore();
    const db = store.database();
    enqueueSummaryJob(db, { memory_id: "mem-a", revision: 1, at: AT });
    enqueueSummaryJob(db, { memory_id: "mem-b", revision: 1, at: AT });

    expect(claimDueSummaryJob(db, { now_ms: T0, owner: "w1", memory_id: "mem-a", revision: 2 })).toBeNull();
    const scoped = claimDueSummaryJob(db, { now_ms: T0, owner: "w1", memory_id: "mem-b", revision: 1 });
    expect(scoped?.memory_id).toBe("mem-b");
    expect(readSummaryJob(db, "mem-a", 1)?.state).toBe("pending");
    expect(readSummaryJob(db, "mem-b", 1)?.state).toBe("running");
  });

  it("gives a job to one owner, and hands it to another only after the lease expires", () => {
    const store = newStore();
    const db = store.database();
    enqueueSummaryJob(db, { memory_id: "mem-a", revision: 1, at: AT });

    const first = claimDueSummaryJob(db, { now_ms: T0, lease_ms: 1000, owner: "w1" });
    expect(first?.attempts).toBe(1);
    expect(first?.lease_owner).toBe("w1");
    expect(claimDueSummaryJob(db, { now_ms: T0 + 10, lease_ms: 1000, owner: "w2" })).toBeNull();

    const second = claimDueSummaryJob(db, { now_ms: T0 + 1001, lease_ms: 1000, owner: "w2" });
    expect(second?.job_id).toBe(first?.job_id);
    expect(second?.attempts).toBe(2);
    expect(countSummaryJobs(db)).toBe(1);
  });

  it("retries below the ceiling and fails at it, keeping last_error", () => {
    const store = newStore();
    const db = store.database();
    enqueueSummaryJob(db, { memory_id: "mem-a", revision: 1, at: AT });

    let job = claimDueSummaryJob(db, { now_ms: T0, lease_ms: 1000, owner: "w1" });
    expect(job).not.toBeNull();
    if (job === null) return;
    job = failSummaryJob(db, { job, at: AT, error: "nav_down" });
    expect(job.state).toBe("pending");
    expect(job.last_error).toBe("nav_down");

    job = claimDueSummaryJob(db, { now_ms: T0 + 2000, lease_ms: 1000, owner: "w1" });
    if (job === null) throw new Error("expected a second claim");
    job = failSummaryJob(db, { job, at: AT, error: "nav_down_again" });
    expect(job.state).toBe("pending");

    job = claimDueSummaryJob(db, { now_ms: T0 + 4000, lease_ms: 1000, owner: "w1" });
    if (job === null) throw new Error("expected a third claim");
    expect(job.attempts).toBe(SUMMARY_JOB_MAX_ATTEMPTS);
    job = failSummaryJob(db, { job, at: AT, error: "still_down" });
    expect(job.state).toBe("failed");
    expect(job.last_error).toBe("still_down");
    expect(claimDueSummaryJob(db, { now_ms: T0 + 9000, lease_ms: 1000, owner: "w2" })).toBeNull();
  });

  it("completing a job clears its lease and never re-claims it", () => {
    const store = newStore();
    const db = store.database();
    enqueueSummaryJob(db, { memory_id: "mem-a", revision: 1, at: AT });
    const job = claimDueSummaryJob(db, { now_ms: T0, lease_ms: 1000, owner: "w1" });
    if (job === null) throw new Error("expected a claim");
    completeSummaryJob(db, job, AT);
    expect(readSummaryJob(db, "mem-a", 1)?.state).toBe("done");
    expect(claimDueSummaryJob(db, { now_ms: T0 + 60_000, lease_ms: 1000, owner: "w2" })).toBeNull();
  });
});
