import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseMemory, type Memory, type SourceRef } from "../../src/contracts/index.js";
import { MIGRATIONS } from "../../src/storage/migrations.js";
import { openStore, StorageError } from "../../src/storage/index.js";
import { bodyWith, openTempStore, storedMemory, tempDbPath } from "./support.js";
import { makeSourceRef, measuredNonWhitespace } from "../support.js";

function anchor(overrides: Partial<SourceRef> = {}): SourceRef {
  return makeSourceRef({ message_id: `m-${Math.random().toString(16).slice(2, 10)}`, ...overrides });
}

/** A body that validates: 500-660 non-whitespace chars, at least one citation. */
function repairableBody(prefix: string, source: SourceRef): string {
  return bodyWith(`${prefix} [来源:${source.message_id}]`);
}

function nextRevision(head: Memory, body: string, at: string, sources = head.medium.sources): Memory {
  return parseMemory({
    ...head,
    revision: head.revision + 1,
    state: "medium_ready",
    nav: null,
    medium: { body, body_char_count: measuredNonWhitespace(body), sources },
    updated_at: at,
  });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof StorageError) return error.code;
    throw error;
  }
  throw new Error("expected the call to throw");
}

describe("stale events: durability and identity", () => {
  it("migrates a pre-existing version-2 database forward without losing data", () => {
    const path = tempDbPath("upgrade");
    const legacy = new DatabaseSync(path);
    for (const migration of MIGRATIONS.slice(0, 2)) {
      legacy.exec(migration.sql);
    }
    legacy.exec(
      `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`,
    );
    for (const migration of MIGRATIONS.slice(0, 2)) {
      legacy
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, "2026-11-01T00:00:00Z");
    }
    legacy.close();

    const store = openStore({ path });
    try {
      expect(store.listMigrations().map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const memory = storedMemory({ body: repairableBody("旧库迁移", anchor()) });
      store.saveMemory(memory);
      const marked = store.markStale({
        memory_id: memory.memory_id,
        observed_revision: 1,
        reason: "later activity",
        excerpt: "a later log line",
        sources: [anchor()],
        producer: "agent",
      });
      expect(marked.inserted).toBe(true);
      expect(store.readMemory(memory.uri)?.medium.body).toBe(memory.medium.body);
    } finally {
      store.close();
    }
  });

  it("is idempotent for the same logical event and leaves the body untouched", () => {
    const store = openTempStore();
    try {
      const memory = storedMemory({ body: repairableBody("幂等", anchor()) });
      store.saveMemory(memory);
      const source = anchor();
      const first = store.markStale({
        memory_id: memory.memory_id,
        observed_revision: 1,
        reason: "端口已改变",
        excerpt: "the port moved to 8080",
        sources: [source],
        producer: "agent",
        at: "2026-11-18T01:00:00Z",
      });
      const retry = store.markStale({
        memory_id: memory.memory_id,
        observed_revision: 1,
        reason: "端口已改变",
        excerpt: "the port moved to 8080",
        sources: [source],
        producer: "detector",
        at: "2026-11-18T02:00:00Z",
        branch_ref: "main",
      });
      expect(retry.inserted).toBe(false);
      expect(retry.event.event_id).toBe(first.event.event_id);
      expect(store.countPendingStaleEvents(memory.memory_id)).toBe(1);
      expect(store.readMemory(memory.uri)?.medium.body).toBe(memory.medium.body);
    } finally {
      store.close();
    }
  });

  it("rejects a reused identity that carries different evidence, even after it is acknowledged", () => {
    const store = openTempStore();
    try {
      const memory = storedMemory({ body: repairableBody("冲突", anchor()) });
      store.saveMemory(memory);
      const source = anchor();
      const first = store.markStale({
        memory_id: memory.memory_id,
        observed_revision: 1,
        reason: "端口已改变",
        excerpt: "the port moved to 8080",
        sources: [source],
        producer: "agent",
      });
      expect(
        codeOf(() =>
          store.markStale({
            memory_id: memory.memory_id,
            observed_revision: 1,
            reason: "端口已改变",
            excerpt: "a completely different excerpt",
            sources: [source],
            producer: "agent",
          }),
        ),
      ).toBe("stale_event_conflict");
      expect(store.listPendingStaleEvents(memory.memory_id)[0]?.event_id).toBe(first.event.event_id);
      expect(store.listPendingStaleEvents(memory.memory_id)[0]?.excerpt).toBe("the port moved to 8080");

      const head = store.readMemory(memory.uri)!;
      store.updateSummary({
        memory: nextRevision(head, bodyWith(`吸收 [来源:${first.event.event_id}]`), "2026-11-18T09:00:00Z"),
        expected_revision: 1,
        acknowledge_event_ids: [first.event.event_id],
        at: "2026-11-18T09:00:00Z",
      });
      expect(store.countPendingStaleEvents(memory.memory_id)).toBe(0);
      expect(
        codeOf(() =>
          store.markStale({
            memory_id: memory.memory_id,
            observed_revision: 1,
            reason: "端口已改变",
            excerpt: "a completely different excerpt",
            sources: [source],
            producer: "agent",
          }),
        ),
      ).toBe("stale_event_conflict");
    } finally {
      store.close();
    }
  });

  it("accepts an old-revision mark with an explicit mismatch and rejects nonexistent/future revisions", () => {
    const store = openTempStore();
    try {
      const memory = storedMemory({ body: repairableBody("旧修订", anchor()) });
      store.saveMemory(memory);
      store.saveMemory(
        nextRevision(memory, bodyWith("第二版正文 [来源:m-1]"), "2026-11-18T03:00:00Z"),
      );
      const source = anchor();
      const marked = store.markStale({
        memory_id: memory.memory_id,
        observed_revision: 1,
        reason: "基于旧版观察",
        excerpt: "evidence seen before the head moved",
        sources: [source],
        producer: "agent",
      });
      expect(marked.event.observed_revision).toBe(1);
      expect(marked.event.sources).toHaveLength(1);

      const freshness = store.readFreshness(memory.uri, 1);
      expect(freshness?.head_revision).toBe(2);
      expect(freshness?.delivered_revision).toBe(1);
      expect(freshness?.revision_mismatch).toBe(true);
      expect(freshness?.is_stale).toBe(true);
      expect(freshness?.pending[0]?.event_id).toBe(marked.event.event_id);

      expect(
        codeOf(() =>
          store.markStale({
            memory_id: "mem-missing",
            observed_revision: 1,
            reason: "x",
            excerpt: "y",
            sources: [source],
            producer: "agent",
          }),
        ),
      ).toBe("not_found");

      expect(
        codeOf(() =>
          store.markStale({
            memory_id: memory.memory_id,
            observed_revision: 9,
            reason: "x",
            excerpt: "y",
            sources: [source],
            producer: "agent",
          }),
        ),
      ).toBe("stale_future_revision");
    } finally {
      store.close();
    }
  });
});

describe("stale events: summary update transaction", () => {
  function setup() {
    const store = openTempStore();
    const memory = storedMemory({ body: repairableBody("更新", anchor()) });
    store.saveMemory(memory);
    const marks = ["alpha", "beta", "gamma"].map((label, index) =>
      store.markStale({
        memory_id: memory.memory_id,
        observed_revision: 1,
        reason: `change ${label}`,
        excerpt: `excerpt ${label}`,
        sources: [anchor()],
        producer: "detector",
        at: `2026-11-18T0${index + 4}:00:00Z`,
      }),
    );
    return { store, memory, marks };
  }

  it("acknowledges exactly the listed events and advances the head in one write", () => {
    const { store, memory, marks } = setup();
    try {
      const head = store.readMemory(memory.uri)!;
      const outcome = store.updateSummary({
        memory: nextRevision(head, bodyWith(`吸收 [来源:${marks[0]!.event.event_id}]`), "2026-11-18T09:00:00Z"),
        expected_revision: 1,
        acknowledge_event_ids: [marks[0]!.event.event_id, marks[1]!.event.event_id],
        at: "2026-11-18T09:00:00Z",
      });
      expect(outcome.saved).toBe(true);
      expect(outcome.memory?.revision).toBe(2);
      expect(outcome.acknowledged_event_ids).toEqual([marks[0]!.event.event_id, marks[1]!.event.event_id]);
      expect(outcome.job?.state).toBe("pending");
      expect(outcome.job?.revision).toBe(2);
      const freshness = store.readFreshness(memory.uri, 2);
      expect(freshness?.head_revision).toBe(2);
      expect(freshness?.is_stale).toBe(true);
      expect(freshness?.pending_count).toBe(1);
      expect(freshness?.pending[0]?.event_id).toBe(marks[2]!.event.event_id);
    } finally {
      store.close();
    }
  });

  it("keeps an event that arrives during the update pending on the new head", () => {
    const { store, memory, marks } = setup();
    try {
      const head = store.readMemory(memory.uri)!;
      store.updateSummary({
        memory: nextRevision(head, bodyWith(`吸收一 [来源:${marks[0]!.event.event_id}]`), "2026-11-18T09:00:00Z"),
        expected_revision: 1,
        acknowledge_event_ids: [marks[0]!.event.event_id],
        at: "2026-11-18T09:00:00Z",
      });
      const racing = store.markStale({
        memory_id: memory.memory_id,
        observed_revision: 2,
        reason: "racing change",
        excerpt: "arrived while the summary was being repaired",
        sources: [anchor()],
        producer: "detector",
        at: "2026-11-18T09:30:00Z",
      });
      expect(racing.inserted).toBe(true);
      const freshness = store.readFreshness(memory.uri, 2);
      expect(freshness?.head_revision).toBe(2);
      expect(freshness?.is_stale).toBe(true);
      expect(freshness?.pending.map((event) => event.event_id)).toEqual(
        expect.arrayContaining([marks[1]!.event.event_id, marks[2]!.event.event_id, racing.event.event_id]),
      );
    } finally {
      store.close();
    }
  });

  it("rolls back a stale expected revision and an unknown event id, leaving everything pending", () => {
    const { store, memory, marks } = setup();
    try {
      const head = store.readMemory(memory.uri)!;
      const candidate = nextRevision(head, bodyWith(`吸收 [来源:${marks[0]!.event.event_id}]`), "2026-11-18T09:00:00Z");
      expect(
        codeOf(() =>
          store.updateSummary({
            memory: candidate,
            expected_revision: 5,
            acknowledge_event_ids: [],
            at: "2026-11-18T09:00:00Z",
          }),
        ),
      ).toBe("stale_revision");
      expect(
        codeOf(() =>
          store.updateSummary({
            memory: candidate,
            expected_revision: 1,
            acknowledge_event_ids: [marks[0]!.event.event_id, "evt-not-real"],
            at: "2026-11-18T09:00:00Z",
          }),
        ),
      ).toBe("stale_unknown_event");
      expect(store.readMemory(memory.uri)?.revision).toBe(1);
      expect(store.countPendingStaleEvents(memory.memory_id)).toBe(3);
    } finally {
      store.close();
    }
  });

  it("rejects an id already acknowledged, even after a successful update", () => {
    const { store, memory, marks } = setup();
    try {
      const head = store.readMemory(memory.uri)!;
      store.updateSummary({
        memory: nextRevision(head, bodyWith(`吸收 [来源:${marks[0]!.event.event_id}]`), "2026-11-18T09:00:00Z"),
        expected_revision: 1,
        acknowledge_event_ids: [marks[0]!.event.event_id],
        at: "2026-11-18T09:00:00Z",
      });
      const head2 = store.readMemory(memory.uri)!;
      expect(
        codeOf(() =>
          store.updateSummary({
            memory: nextRevision(head2, bodyWith(`再次 [来源:${marks[0]!.event.event_id}]`), "2026-11-18T10:00:00Z"),
            expected_revision: 2,
            acknowledge_event_ids: [marks[0]!.event.event_id],
            at: "2026-11-18T10:00:00Z",
          }),
        ),
      ).toBe("stale_unknown_event");
      expect(store.readMemory(memory.uri)?.revision).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("stale events: bounded delivery snapshot", () => {
  it("bounds the pending list and the source list while reporting the true counts", () => {
    const store = openTempStore();
    try {
      const memory = storedMemory({ body: repairableBody("边界", anchor()) });
      store.saveMemory(memory);
      for (let index = 0; index < 11; index += 1) {
        store.markStale({
          memory_id: memory.memory_id,
          observed_revision: 1,
          reason: `change ${index}`,
          excerpt: `excerpt ${index}`,
          sources: [
            anchor({ message_id: `m-a-${index}` }),
            anchor({ message_id: `m-b-${index}` }),
            anchor({ message_id: `m-c-${index}` }),
            anchor({ message_id: `m-d-${index}` }),
            anchor({ message_id: `m-e-${index}` }),
          ],
          producer: "detector",
          at: `2026-11-18T${String(index).padStart(2, "0")}:00:00Z`,
        });
      }
      const freshness = store.readFreshness(memory.uri, 1);
      expect(freshness?.pending_count).toBe(11);
      expect(freshness?.pending).toHaveLength(8);
      expect(freshness?.pending_truncated).toBe(true);
      expect(freshness?.pending[0]?.sources).toHaveLength(4);
      expect(freshness?.pending[0]?.source_count).toBe(5);
      expect(freshness?.pending[0]?.sources_truncated).toBe(true);
      expect(freshness?.is_stale).toBe(true);
    } finally {
      store.close();
    }
  });

  it("keys the freshness signature on the sorted event id set, not the count", () => {
    const store = openTempStore();
    try {
      const memory = storedMemory({ body: repairableBody("签名", anchor()) });
      store.saveMemory(memory);
      const fresh = store.readFreshness(memory.uri, 1);
      expect(fresh?.freshness_sig).not.toBe("");

      const first = store.markStale({
        memory_id: memory.memory_id,
        observed_revision: 1,
        reason: "one",
        excerpt: "one",
        sources: [anchor()],
        producer: "detector",
      });
      const afterFirst = store.readFreshness(memory.uri, 1)!.freshness_sig;
      expect(afterFirst).not.toBe("");

      const second = store.markStale({
        memory_id: memory.memory_id,
        observed_revision: 1,
        reason: "two",
        excerpt: "two",
        sources: [anchor()],
        producer: "detector",
      });
      const afterSecond = store.readFreshness(memory.uri, 1)!.freshness_sig;
      expect(afterSecond).not.toBe(afterFirst);

      const head = store.readMemory(memory.uri)!;
      store.updateSummary({
        memory: nextRevision(head, bodyWith(`吸收 [来源:${first.event.event_id}]`), "2026-11-18T09:00:00Z"),
        expected_revision: 1,
        acknowledge_event_ids: [first.event.event_id],
        at: "2026-11-18T09:00:00Z",
      });
      const afterAck = store.readFreshness(memory.uri, 2)!.freshness_sig;
      expect(afterAck).not.toBe(afterSecond);
      // Same one-event set as `afterFirst`, but on a different head: the head is
      // part of the signature, so a changed summary is never deduped away.
      expect(afterAck).not.toBe(afterFirst);
      expect(store.readFreshness(memory.uri, 2)!.pending[0]?.event_id).toBe(second.event.event_id);
    } finally {
      store.close();
    }
  });
});
