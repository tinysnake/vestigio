/**
 * Durable daemon job store: idempotent submission, single-owner claims, attempt
 * fencing across cancel and restart, delivery retention, and deterministic expiry.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobStore, JobStoreError } from "../src/jobs.js";
import type { Claim, Kind, SessionKey } from "../src/jobs.js";

const T0 = Date.parse("2026-11-20T10:00:00.000Z");

const dirs: string[] = [];
const stores: JobStore[] = [];
let clock = T0;

function tempDbPath(label = "jobs"): string {
  const dir = mkdtempSync(join(tmpdir(), "vestigio-daemon-"));
  dirs.push(dir);
  return join(dir, `${label}.db`);
}

function open(path = tempDbPath()): JobStore {
  const store = new JobStore(path, { now: () => clock, resultTtlMs: 1000 });
  stores.push(store);
  return store;
}

/** Claim jobs of one kind until the wanted job surfaces, cancelling the rest. */
function claimJob(store: JobStore, kind: Kind, owner: string, jobId: string): Claim {
  for (let i = 0; i < 100; i += 1) {
    const claim = store.claim(kind, owner);
    if (claim === undefined) throw new Error(`job ${jobId} was never claimable`);
    if (claim.jobId === jobId) return claim;
    store.cancel(claim.jobId, "skipped");
  }
  throw new Error(`gave up claiming job ${jobId}`);
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  clock = T0;
});

describe("daemon job store", () => {
  it("accepts, claims once, and publishes the terminal result", () => {
    const store = open();
    const session: SessionKey = { source: "pi", sessionId: "sess-1" };
    const submitted = store.submit(session, "req-1", "maintenance", { action: "repair", n: 1 });

    expect(submitted.deduplicated).toBe(false);
    expect(store.get(submitted.jobId)).toMatchObject({
      visibility: "active",
      state: "queued",
      input: { action: "repair", n: 1 },
    });

    expect(store.claim("detector", "w1")).toBeUndefined();
    const claim = store.claim("maintenance", "w1");
    expect(claim).toMatchObject({ jobId: submitted.jobId, session, kind: "maintenance" });
    expect(store.get(submitted.jobId)).toMatchObject({ visibility: "active", state: "running" });
    // No leases: a running job is not offered to a second claimant.
    expect(store.claim("maintenance", "w2")).toBeUndefined();

    clock += 5;
    expect(store.finish(submitted.jobId, "att-stale", { status: "succeeded", resultCode: "x", result: null })).toBe(false);
    expect(
      store.finish(submitted.jobId, (claim as Claim).attemptId, {
        status: "succeeded",
        resultCode: "repaired",
        result: { ok: true, changes: 2 },
      }),
    ).toBe(true);
    expect(
      store.finish(submitted.jobId, (claim as Claim).attemptId, { status: "failed", resultCode: "y", result: null }),
    ).toBe(false);

    expect(store.get(submitted.jobId)).toMatchObject({
      visibility: "full",
      state: "succeeded",
      resultCode: "repaired",
      result: { ok: true, changes: 2 },
    });
    const pending = store.pending(submitted.sessionRef);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ jobId: submitted.jobId, state: "succeeded", result: { ok: true, changes: 2 } });
  });

  it("is idempotent on (session, requestId) and conflicts on different content", () => {
    const store = open();
    const session: SessionKey = { source: "pi", sessionId: "sess-1" };
    const first = store.submit(session, "req-1", "maintenance", { b: 2, a: 1 });
    const replay = store.submit(session, "req-1", "maintenance", { a: 1, b: 2 });

    expect(replay.jobId).toBe(first.jobId);
    expect(replay.deduplicated).toBe(true);
    expect(replay.sessionRef).toBe(first.sessionRef);

    let conflict: JobStoreError | null = null;
    try {
      store.submit(session, "req-1", "maintenance", { a: 1, b: 3 });
    } catch (error) {
      conflict = error instanceof JobStoreError ? error : null;
    }
    expect(conflict?.code).toBe("request_conflict");

    const other = store.submit({ source: "cli", sessionId: "sess-2" }, "req-1", "maintenance", { a: 1, b: 2 });
    expect(other.jobId).not.toBe(first.jobId);
    expect(other.sessionRef).not.toBe(first.sessionRef);
  });

  it("recovers a running job after a restart and fences the interrupted attempt", () => {
    const path = tempDbPath("restart");
    const session: SessionKey = { source: "cli", sessionId: "restart" };

    const first = open(path);
    const submitted = first.submit(session, "req-1", "maintenance", { work: true });
    const interrupted = first.claim("maintenance", "w1");
    expect(interrupted?.jobId).toBe(submitted.jobId);
    first.close();

    const second = open(path);
    expect(second.get(submitted.jobId)).toMatchObject({ visibility: "active", state: "running" });

    expect(second.recover()).toBe(1);
    expect(second.get(submitted.jobId)).toMatchObject({ state: "queued" });
    expect(second.recover()).toBe(0);
    expect(
      second.finish(submitted.jobId, (interrupted as Claim).attemptId, {
        status: "succeeded",
        resultCode: "late",
        result: null,
      }),
    ).toBe(false);

    const reclaimed = claimJob(second, "maintenance", "w2", submitted.jobId);
    expect(reclaimed.attemptId).not.toBe((interrupted as Claim).attemptId);
    expect(
      second.finish(submitted.jobId, reclaimed.attemptId, {
        status: "succeeded",
        resultCode: "ok",
        result: { done: true },
      }),
    ).toBe(true);
  });

  it("cancels atomically, notifies the session, and fences the live attempt", () => {
    const store = open();
    const session: SessionKey = { source: "pi", sessionId: "sess-1" };
    const submitted = store.submit(session, "req-1", "search", { q: "port" });
    const claim = store.claim("search", "w1");

    expect(store.cancel(submitted.jobId)).toBe(true);
    expect(store.cancel(submitted.jobId)).toBe(false);
    expect(
      store.finish(submitted.jobId, (claim as Claim).attemptId, { status: "succeeded", resultCode: "ok", result: null }),
    ).toBe(false);
    expect(store.get(submitted.jobId)).toMatchObject({
      visibility: "full",
      state: "cancelled",
      resultCode: "cancelled",
    });
    expect(store.pending(submitted.sessionRef)[0]).toMatchObject({ state: "cancelled", result: null });
  });

  it("reclaims the full result on delivery and keeps the compact record", () => {
    const store = open();
    const session: SessionKey = { source: "pi", sessionId: "sess-1" };
    const submitted = store.submit(session, "req-1", "search", { q: "port" });
    const claim = claimJob(store, "search", "w1", submitted.jobId);
    store.finish(submitted.jobId, claim.attemptId, { status: "succeeded", resultCode: "found", result: { hits: 3 } });

    const pending = store.pending(submitted.sessionRef);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ jobId: submitted.jobId, state: "succeeded", result: { hits: 3 } });

    expect(store.delivered(pending.map((event) => event.eventId))).toBe(1);
    expect(store.delivered(pending.map((event) => event.eventId))).toBe(0);
    expect(store.pending(submitted.sessionRef)).toHaveLength(0);

    const summary = store.get(submitted.jobId);
    expect(summary).toMatchObject({ visibility: "summary_only", state: "succeeded", resultCode: "found" });
    expect(summary !== undefined && "result" in summary).toBe(false);
  });

  it("expires undelivered results on the injected clock without losing the state", () => {
    const store = open();
    const session: SessionKey = { source: "cli", sessionId: "sess-1" };
    const submitted = store.submit(session, "req-1", "detector", { scan: true });
    const claim = claimJob(store, "detector", "w1", submitted.jobId);
    store.finish(submitted.jobId, claim.attemptId, { status: "failed", resultCode: "model_error", result: { err: "x" } });
    expect(store.pending(submitted.sessionRef)).toHaveLength(1);

    clock += 1001;
    expect(store.pending(submitted.sessionRef)).toHaveLength(0);
    expect(store.get(submitted.jobId)).toMatchObject({
      visibility: "summary_only",
      state: "failed",
      resultCode: "model_error",
    });
    expect(store.expire()).toBe(1);
    expect(store.expire()).toBe(0);
  });

  it("claims only the requested kind and pages a session with a stable cursor", () => {
    const store = open();
    const session: SessionKey = { source: "cli", sessionId: "page" };
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      clock += 1;
      ids.push(store.submit(session, `p-${i}`, "search", { i }).jobId);
    }
    clock += 1;
    const maintenance = store.submit(session, "m-0", "maintenance", { i: 9 });
    const sessionRef = store.ensureSession(session);

    expect(store.claim("detector", "w1")).toBeUndefined();
    expect(store.claim("search", "w1")?.jobId).toBe(ids[0]);
    // The next claimant gets the next queued job, never the running one.
    expect(store.claim("search", "w2")?.jobId).toBe(ids[1]);
    // The maintenance job is left for its own queue.
    expect(store.claim("maintenance", "w1")?.jobId).toBe(maintenance.jobId);

    const first = store.list(sessionRef, undefined, 3);
    expect(first.jobs.map((job) => job.requestId)).toEqual(["p-0", "p-1", "p-2"]);
    expect(first.nextCursor).not.toBeNull();

    const second = store.list(sessionRef, first.nextCursor as string, 3);
    expect(second.jobs.map((job) => job.requestId)).toEqual(["p-3", "p-4", "m-0"]);
    expect(second.nextCursor).toBeNull();

    expect(store.list(sessionRef).jobs).toHaveLength(6);
    expect(() => store.list(sessionRef, "not-a-cursor")).toThrowError(JobStoreError);
  });

  it("refuses work after close", () => {
    const store = open();
    store.close();
    expect(() => store.submit({ source: "pi", sessionId: "s" }, "r", "search", {})).toThrowError(JobStoreError);
    store.close();
  });
});
