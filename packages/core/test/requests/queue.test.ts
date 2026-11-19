import { afterEach, describe, expect, it } from "vitest";
import {
  MEMORY_REQUEST_MAX_ATTEMPTS,
  memoryRequestCandidateKey,
  memoryRequestDedupKey,
  readMemoryRequest,
} from "../../src/requests/index.js";
import type { EnqueueMemoryRequestInput } from "../../src/requests/index.js";
import type { MemoryStore } from "../../src/storage/index.js";
import { openTempStore } from "../retrieval/support.js";
import { makeSourceRef } from "../support.js";

const stores: MemoryStore[] = [];

function newStore(): MemoryStore {
  const store = openTempStore();
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

const AT = "2026-11-19T10:00:00.000Z";
const T0 = Date.parse(AT);

function input(overrides: Partial<EnqueueMemoryRequestInput> = {}): EnqueueMemoryRequestInput {
  return {
    scope: { kind: "project", project_id: "p-vestigio" },
    project_id: "p-vestigio",
    session_id: "s-1",
    branch_ref: "root",
    intent: "项目统一使用 pnpm 安装依赖",
    title: "包管理器使用 pnpm",
    evidence: [{ source: makeSourceRef({ message_id: "m-10" }), excerpt: "以后都用 pnpm，不要用 npm" }],
    at: AT,
    ...overrides,
  };
}

describe("memory request queue", () => {
  it("stores one durable row per identical scope, intent and evidence", () => {
    const store = newStore();
    const first = store.enqueueMemoryRequest(input());
    const second = store.enqueueMemoryRequest(input());
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.request.request_id).toBe(first.request.request_id);
    expect(store.countMemoryRequests()).toBe(1);
    expect(first.request.status).toBe("pending");
    expect(first.request.evidence[0]?.excerpt).toContain("pnpm");
  });

  it("uses one identity for candidate and dedup keys, and mints a new row only on a real difference", () => {
    const store = newStore();
    const first = store.enqueueMemoryRequest(input());
    // Whitespace-only intent differences are normalized away: same row.
    const normalized = store.enqueueMemoryRequest(input({ intent: "项目统一使用  pnpm   安装依赖" }));
    expect(normalized.inserted).toBe(false);
    expect(normalized.request.request_id).toBe(first.request.request_id);

    const candidateKey = memoryRequestCandidateKey({
      scope: first.request.scope,
      intent: first.request.intent,
      evidence: first.request.evidence,
    });
    const dedupKey = memoryRequestDedupKey({
      scope: first.request.scope,
      intent: first.request.intent,
      evidence: first.request.evidence,
    });
    expect(candidateKey).toBe(dedupKey);
    expect(dedupKey).toBe(first.request.dedup_key);

    const otherEvidence = store.enqueueMemoryRequest(
      input({ evidence: [{ source: makeSourceRef({ message_id: "m-11" }), excerpt: "以后都用 pnpm" }] }),
    );
    expect(otherEvidence.inserted).toBe(true);
    const otherIntent = store.enqueueMemoryRequest(input({ intent: "另一个约定" }));
    expect(otherIntent.inserted).toBe(true);
    expect(store.countMemoryRequests()).toBe(3);
  });

  it("trims, bounds, and dedupes evidence by source identity", () => {
    const store = newStore();
    const source = makeSourceRef({ message_id: "m-11" });
    const enqueued = store.enqueueMemoryRequest(
      input({
        evidence: [
          { source, excerpt: ` ${"x".repeat(5000)} ` },
          { source, excerpt: "duplicate" },
        ],
      }),
    );
    expect(enqueued.request.evidence).toHaveLength(1);
    expect([...enqueued.request.evidence[0]!.excerpt].length).toBeLessThanOrEqual(2000);
  });

  it("claims one row per owner and hands it over only when the lease expires", () => {
    const store = newStore();
    const enqueued = store.enqueueMemoryRequest(input());
    const first = store.claimDueMemoryRequest({ now_ms: T0, owner: "w1", lease_ms: 1000 });
    expect(first?.request_id).toBe(enqueued.request.request_id);
    expect(first?.attempts).toBe(1);
    expect(store.claimDueMemoryRequest({ now_ms: T0 + 10, owner: "w2", lease_ms: 1000 })).toBeNull();
    const second = store.claimDueMemoryRequest({ now_ms: T0 + 1001, owner: "w2", lease_ms: 1000 });
    expect(second?.request_id).toBe(first?.request_id);
    expect(second?.attempts).toBe(2);
    expect(store.countMemoryRequests()).toBe(1);
  });

  it("completes with the saved URI and navigation state, clearing the lease", () => {
    const store = newStore();
    const enqueued = store.enqueueMemoryRequest(input());
    const claimed = store.claimDueMemoryRequest({ now_ms: T0, owner: "w1" });
    expect(claimed).not.toBeNull();
    store.attachMemoryRequestTarget({
      request_id: enqueued.request.request_id,
      memory_uri: "memory://vestigio/mem-abc",
      revision: 1,
      at: AT,
    });
    store.setMemoryRequestNavigation({ request_id: enqueued.request.request_id, navigation_status: "ready", at: AT });
    const completed = store.completeMemoryRequest({
      request_id: enqueued.request.request_id,
      outcome: "saved",
      memory_uri: "memory://vestigio/mem-abc",
      revision: 1,
      navigation_status: "ready",
      at: AT,
    });
    expect(completed.status).toBe("saved");
    expect(completed.memory_uri).toBe("memory://vestigio/mem-abc");
    expect(completed.revision).toBe(1);
    expect(completed.lease_owner).toBeNull();
    expect(store.claimDueMemoryRequest({ now_ms: T0 + 60_000, owner: "w2" })).toBeNull();
  });

  it("retries below the ceiling and fails at it, preserving the reason", () => {
    const store = newStore();
    const enqueued = store.enqueueMemoryRequest(input());
    let request = store.claimDueMemoryRequest({ now_ms: T0, owner: "w1" });
    if (request === null) throw new Error("expected claim");
    for (let attempt = 1; attempt <= MEMORY_REQUEST_MAX_ATTEMPTS; attempt += 1) {
      request = store.failMemoryRequest({
        request,
        status: "pending",
        reason: `down_${attempt}`,
        next_attempt_at: new Date(T0 + attempt * 1000).toISOString(),
        at: AT,
      });
      if (attempt < MEMORY_REQUEST_MAX_ATTEMPTS) {
        expect(request.status).toBe("pending");
        expect(request.reason).toBe(`down_${attempt}`);
        expect(store.claimDueMemoryRequest({ now_ms: T0 + attempt * 1000 - 1, owner: "w1" })).toBeNull();
        request = store.claimDueMemoryRequest({ now_ms: T0 + attempt * 1000, owner: "w1" });
        if (request === null) throw new Error(`expected claim ${attempt + 1}`);
      }
    }
    expect(request.status).toBe("failed");
    expect(request.reason).toBe(`down_${MEMORY_REQUEST_MAX_ATTEMPTS}`);
    expect(readMemoryRequest(store.database(), enqueued.request.request_id)?.status).toBe("failed");
  });

  it("drains a lease that expired after the final attempt instead of stranding it", () => {
    const store = newStore();
    const enqueued = store.enqueueMemoryRequest(input());
    let request = store.claimDueMemoryRequest({ now_ms: T0, owner: "w1", lease_ms: 1000 });
    if (request === null) throw new Error("expected first claim");
    for (let attempt = 1; attempt < MEMORY_REQUEST_MAX_ATTEMPTS; attempt += 1) {
      request = store.failMemoryRequest({
        request,
        status: "pending",
        reason: `down_${attempt}`,
        next_attempt_at: new Date(T0 + attempt * 1000).toISOString(),
        at: AT,
      });
      request = store.claimDueMemoryRequest({
        now_ms: T0 + attempt * 1000,
        owner: "w1",
        lease_ms: 1000,
      });
      if (request === null) throw new Error(`expected claim ${attempt + 1}`);
    }
    expect(request.attempts).toBe(MEMORY_REQUEST_MAX_ATTEMPTS);
    expect(store.claimDueMemoryRequest({ now_ms: T0 + 10_000, owner: "w2" })).toBeNull();
    const drained = readMemoryRequest(store.database(), enqueued.request.request_id);
    expect(drained?.status).toBe("failed");
    expect(drained?.reason).toContain("attempt ceiling");
    expect(drained?.lease_owner).toBeNull();
  });
});
