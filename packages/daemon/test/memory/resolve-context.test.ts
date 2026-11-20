import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { RESOLVE_MAX_SESSION_RESOLVES, type ResolveContinuation } from "@vestigio/core/resolver";
import { openResolveContexts } from "../../src/memory/resolve-context.js";

const session = { source: "pi", sessionId: "session" };

it("rejects a late continuation for the same handle and isolates other handles", () => {
  using db = new DatabaseSync(":memory:");
  const contexts = openResolveContexts(db);
  const older = contexts.begin(session, "one", "main", 0);
  const newer = contexts.begin(session, "two", "main", 0);
  const next = { id: "kept", expires_at_ms: 100 } as ResolveContinuation;
  newer.commit(next);
  older.commit(null);
  expect(contexts.begin(session, "three", "main", 1).continuation).toEqual(next);
  expect(contexts.begin(session, "four", "fork", 1).continuation).toBeNull();
  expect(contexts.begin(session, "five", "main", 100).continuation).toBeNull();
});

it("charges each job once and enforces the shared session budget across handles", () => {
  using db = new DatabaseSync(":memory:");
  const contexts = openResolveContexts(db);
  const limit = RESOLVE_MAX_SESSION_RESOLVES;
  for (let i = 0; i <= limit; i++) {
    expect(contexts.begin(session, `job-${i}`, i % 2 ? "a" : "b", 0).used).toBe(i);
  }
  expect(contexts.begin(session, "job-0", "a", 0).used).toBe(0);
  expect(contexts.begin({ ...session, source: "cli" }, "job-0", "a", 0).used).toBe(0);
});
