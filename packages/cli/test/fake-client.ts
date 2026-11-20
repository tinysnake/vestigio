import type { Event } from "@vestigio/client";
import type { DaemonClient } from "../src/daemon.js";

/** A structural daemon client for unit tests: no process, no HTTP, one call log. */
export type FakeDaemonClient = DaemonClient & { calls: string[] };

export function fakeDaemonClient(overrides: Partial<DaemonClient> = {}): FakeDaemonClient {
  const calls: string[] = [];
  const client: FakeDaemonClient = {
    calls,
    async session(session) {
      calls.push(`session:${session.source}/${session.sessionId}`);
      return { sessionRef: 7 };
    },
    async submit(input) {
      calls.push(`submit:${input.kind}`);
      return { jobId: "job-1", sessionRef: 7 };
    },
    async get(jobId) {
      calls.push(`get:${jobId}`);
      return { jobId, sessionRef: 7, kind: "search", state: "queued", visibility: "active" };
    },
    async list(sessionRef, after) {
      calls.push(`list:${sessionRef}:${after ?? ""}`);
      return { jobs: [], nextCursor: null };
    },
    async cancel(jobId) {
      calls.push(`cancel:${jobId}`);
      return { cancelled: true };
    },
    async receive(sessionRef, relay) {
      calls.push(`receive:${sessionRef}:${relay === true ? "relay" : "consume"}`);
      return [];
    },
    async relayed(sessionRef, eventIds) {
      calls.push(`relayed:${sessionRef}:${eventIds.join(",")}`);
    },
    async stop() {
      calls.push("stop");
      return true;
    },
    ...overrides,
  };
  return client;
}

export function fakeEvent(overrides: Partial<Event> = {}): Event {
  return {
    eventId: "ev-1",
    jobId: "job-1",
    kind: "search",
    state: "succeeded",
    resultCode: "ok",
    result: { ok: true },
    ...overrides,
  } as Event;
}
