import { describe, expect, it } from "vitest";
import type {
  MemoryState,
  NavigationStatus,
  PersistenceStatus,
  RetrievalStatus,
  UsageChannel,
  UsageEventKind,
} from "../src/contracts/index.js";
import {
  MEMORY_STATES,
  NAVIGATION_STATUSES,
  PERSISTENCE_STATUSES,
  RETRIEVAL_STATUSES,
  USAGE_CHANNELS,
  USAGE_EVENT_KINDS,
  ValidationError,
  memoryUri,
  parseMemory,
  parseMemoryCard,
  parseMemoryState,
  parseMemoryUri,
  parseNavigationStatus,
  parsePersistenceStatus,
  parseRetrievalResult,
  parseRetrievalStatus,
  parseRevision,
  parseScope,
  parseSourceRef,
  parseTimestamp,
  parseUsageChannel,
  parseUsageEventKind,
  serializeSourceRef,
  splitMemoryUri,
} from "../src/contracts/index.js";
import {
  makeMemory,
  makeMemoryCard,
  makeNav,
  makeRetrievalResult,
  makeSourceRef,
} from "./support.js";

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectError(run: () => unknown, code: string, pathPart?: string): void {
  const error = caught(run);
  expect(error).toBeInstanceOf(ValidationError);
  const validation = error as ValidationError;
  expect(validation.code).toBe(code);
  if (pathPart !== undefined) {
    expect(validation.path).toContain(pathPart);
  }
}

describe("union exhaustiveness", () => {
  it("keeps the runtime member lists complete", () => {
    const states: Record<MemoryState, true> = {
      medium_ready: true,
      published: true,
      archived: true,
    };
    const retrieval: Record<RetrievalStatus, true> = {
      resolved: true,
      partial: true,
      conflicted: true,
      not_found: true,
    };
    const persistence: Record<PersistenceStatus, true> = {
      saved: true,
      failed: true,
      not_attempted: true,
    };
    const navigation: Record<NavigationStatus, true> = {
      pending: true,
      ready: true,
      failed: true,
    };
    const kinds: Record<UsageEventKind, true> = { hit: true, access: true };
    const channels: Record<UsageChannel, true> = { hotspot: true, search: true, read: true };
    expect(Object.keys(states).sort()).toEqual([...MEMORY_STATES].sort());
    expect(Object.keys(retrieval).sort()).toEqual([...RETRIEVAL_STATUSES].sort());
    expect(Object.keys(persistence).sort()).toEqual([...PERSISTENCE_STATUSES].sort());
    expect(Object.keys(navigation).sort()).toEqual([...NAVIGATION_STATUSES].sort());
    expect(Object.keys(kinds).sort()).toEqual([...USAGE_EVENT_KINDS].sort());
    expect(Object.keys(channels).sort()).toEqual([...USAGE_CHANNELS].sort());
  });

  it("accepts every declared member", () => {
    for (const state of MEMORY_STATES) expect(parseMemoryState(state)).toBe(state);
    for (const status of RETRIEVAL_STATUSES) expect(parseRetrievalStatus(status)).toBe(status);
    for (const status of PERSISTENCE_STATUSES) expect(parsePersistenceStatus(status)).toBe(status);
    for (const status of NAVIGATION_STATUSES) expect(parseNavigationStatus(status)).toBe(status);
    for (const kind of USAGE_EVENT_KINDS) expect(parseUsageEventKind(kind)).toBe(kind);
    for (const channel of USAGE_CHANNELS) expect(parseUsageChannel(channel)).toBe(channel);
  });

  it("rejects unknown strings instead of coercing them", () => {
    expectError(() => parseMemoryState("ready"), "unknown_variant");
    expectError(() => parseRetrievalStatus("found"), "unknown_variant");
    expectError(() => parsePersistenceStatus("pending"), "unknown_variant");
    expectError(() => parseNavigationStatus("done"), "unknown_variant");
    expectError(() => parseUsageEventKind("view"), "unknown_variant");
    expectError(() => parseUsageChannel("hot"), "unknown_variant");
    expectError(() => parseMemoryState(1), "unknown_variant");
    expectError(() => parseMemoryState(null), "unknown_variant");
  });
});

describe("primitive boundary validation", () => {
  it("parses scope as a discriminated union", () => {
    expect(parseScope({ kind: "global" })).toEqual({ kind: "global" });
    expect(parseScope({ kind: "project", project_id: "p-1" })).toEqual({
      kind: "project",
      project_id: "p-1",
    });
    expectError(() => parseScope({ kind: "team", project_id: "p-1" }), "unknown_variant", "kind");
    expectError(() => parseScope({ kind: "project" }), "missing_field", "project_id");
    expectError(() => parseScope(null), "invalid_type");
  });

  it("rejects malformed revisions", () => {
    expect(parseRevision(1)).toBe(1);
    expect(parseRevision(42)).toBe(42);
    expectError(() => parseRevision(0), "out_of_range");
    expectError(() => parseRevision(-1), "out_of_range");
    expectError(() => parseRevision(1.5), "invalid_type");
    expectError(() => parseRevision("1"), "invalid_type");
    expectError(() => parseRevision(Number.NaN), "invalid_type");
  });

  it("accepts only ISO timestamps with an explicit offset", () => {
    expect(parseTimestamp("2026-11-17T16:21:53Z")).toBe("2026-11-17T16:21:53Z");
    expect(parseTimestamp("2026-11-17T16:21:53.123Z")).toBe("2026-11-17T16:21:53.123Z");
    expect(parseTimestamp("2026-11-17T16:21:53+08:00")).toBe("2026-11-17T16:21:53+08:00");
    expectError(() => parseTimestamp("2026-11-17"), "invalid_format");
    expectError(() => parseTimestamp("2026-11-17T16:21:53"), "invalid_format");
    expectError(() => parseTimestamp("not-a-date"), "invalid_format");
    expectError(() => parseTimestamp(123), "invalid_type");
    expectError(() => parseTimestamp(""), "invalid_type");
  });

  it("round-trips memory URIs and rejects malformed ones", () => {
    expect(memoryUri("vestigio", "mem-0001")).toBe("memory://vestigio/mem-0001");
    expect(parseMemoryUri("memory://vestigio/mem-0001")).toBe("memory://vestigio/mem-0001");
    expect(splitMemoryUri("memory://vestigio/mem-0001")).toEqual({
      storeId: "vestigio",
      memoryId: "mem-0001",
    });
    expectError(() => parseMemoryUri("memory://vestigio"), "invalid_format");
    expectError(() => parseMemoryUri("memory:///mem-0001"), "invalid_format");
    expectError(() => parseMemoryUri("memory://vest igio/mem-0001"), "invalid_format");
    expectError(() => parseMemoryUri("memory://vestigio/mem-0001/extra"), "invalid_format");
    expectError(() => parseMemoryUri("http://vestigio/mem-0001"), "invalid_format");
    expectError(() => parseMemoryUri(42), "invalid_type");
  });
});

describe("SourceRef boundary validation", () => {
  it("accepts a well-formed ref and both nullable fields", () => {
    expect(parseSourceRef(makeSourceRef())).toEqual(makeSourceRef());
    expect(parseSourceRef(makeSourceRef({ parent_message_id: null, locator: null }))).toEqual(
      makeSourceRef(),
    );
    expect(
      parseSourceRef(makeSourceRef({ parent_message_id: "m-0", locator: "obelisk:uuid-1" })),
    ).toEqual(makeSourceRef({ parent_message_id: "m-0", locator: "obelisk:uuid-1" }));
  });

  it("rejects missing, mistyped and self-parented refs", () => {
    const missing = { ...makeSourceRef() } as Record<string, unknown>;
    delete missing.provider;
    expectError(() => parseSourceRef(missing), "missing_field", "provider");
    expectError(() => parseSourceRef({ ...makeSourceRef(), timestamp: 123 }), "invalid_type");
    expectError(() => parseSourceRef({ ...makeSourceRef(), content_hash: "" }), "invalid_type");
    expectError(
      () => parseSourceRef(makeSourceRef({ parent_message_id: "m-1" })),
      "invariant_violation",
      "parent_message_id",
    );
    expectError(() => parseSourceRef([]), "invalid_type");
  });
});

describe("Memory boundary validation", () => {
  it("accepts a well-formed memory", () => {
    expect(parseMemory(makeMemory())).toEqual(makeMemory());
    expect(parseMemory(makeMemory({ state: "archived" }))).toEqual(makeMemory({ state: "archived" }));
  });

  it("ties the navigation summary to the state", () => {
    const pending = makeMemory({ state: "medium_ready", nav: null });
    expect(parseMemory(pending)).toEqual(pending);
    const recovered = makeMemory({ state: "archived", nav: null });
    expect(parseMemory(recovered)).toEqual(recovered);
    expectError(() => parseMemory(makeMemory({ state: "medium_ready" })), "invariant_violation", "nav");
    expectError(() => parseMemory(makeMemory({ state: "published", nav: null })), "invariant_violation", "nav");
  });

  it("requires a 1-based revision", () => {
    expectError(() => parseMemory(makeMemory({ revision: 0 })), "out_of_range", "revision");
    expectError(() => parseRevision(0), "out_of_range");
  });

  it("rejects URI/memory_id mismatch and bad counters", () => {
    expectError(
      () => parseMemory(makeMemory({ uri: "memory://vestigio/other" })),
      "invariant_violation",
      "uri",
    );
    expectError(() => parseMemory(makeMemory({ hit_count: -1 })), "out_of_range");
    expectError(() => parseMemory(makeMemory({ keywords: [""] })), "invalid_type");
    expectError(() => parseMemory(makeMemory({ state: "ready" as MemoryState })), "unknown_variant");
    expectError(
      () =>
        parseMemory(
          makeMemory({ created_at: "2026-11-17T17:00:00Z", updated_at: "2026-11-17T16:00:00Z" }),
        ),
      "invariant_violation",
      "updated_at",
    );
  });

  it("rejects a nav whose source revision disagrees with the memory revision", () => {
    expect(() => parseMemory(makeMemory({ revision: 2, nav: makeNav({ source_revision: 1 }) }))).toThrow(
      ValidationError,
    );
    expectError(
      () => parseMemory(makeMemory({ revision: 2, nav: makeNav({ source_revision: 1 }) })),
      "invariant_violation",
      "nav.source_revision",
    );
    expect(() => parseMemory(makeMemory({ revision: 2, nav: makeNav({ source_revision: 2 }) }))).not.toThrow();
  });

  it("validates memory cards", () => {
    expect(parseMemoryCard(makeMemoryCard())).toEqual(makeMemoryCard());
    expect(parseMemoryCard(makeMemoryCard({ score: -99.5, last_access_at: null }))).toEqual(
      makeMemoryCard({ score: -99.5, last_access_at: null }),
    );
    expectError(() => parseMemoryCard(makeMemoryCard({ uri: "memory://vestigio/other" })), "invariant_violation");
    expectError(() => parseMemoryCard(makeMemoryCard({ nav_text: "" })), "out_of_range");
  });
});

describe("RetrievalResult boundary validation", () => {
  it("accepts a coherent result", () => {
    expect(parseRetrievalResult(makeRetrievalResult())).toEqual(makeRetrievalResult());
  });

  it("rejects incoherent persistence and retrieval combinations", () => {
    expectError(
      () => parseRetrievalResult(makeRetrievalResult({ revision: null })),
      "invariant_violation",
      "memory_uri",
    );
    expectError(
      () => parseRetrievalResult(makeRetrievalResult({ memory_summary: null })),
      "invariant_violation",
      "persistence_status",
    );
    expectError(
      () => parseRetrievalResult(makeRetrievalResult({ status: "not_found" })),
      "invariant_violation",
      "status",
    );
    expectError(
      () => parseRetrievalResult(makeRetrievalResult({ status: "unknown" as never })),
      "unknown_variant",
    );
    expect(() =>
      parseRetrievalResult(
        makeRetrievalResult({
          status: "not_found",
          cards: [],
          memory_summary: null,
          memory_uri: null,
          revision: null,
          persistence_status: "not_attempted",
        }),
      ),
    ).not.toThrow();
  });
});

describe("SourceRef serialization", () => {
  it("round-trips through its canonical form", () => {
    const ref = makeSourceRef({ parent_message_id: "m-0", locator: "obelisk:uuid-1" });
    const text = serializeSourceRef(ref);
    expect(JSON.parse(text)).toEqual(ref);
    expect(serializeSourceRef(JSON.parse(text) as never)).toBe(text);
  });

  it("rejects invalid refs on serialize", () => {
    expectError(() => serializeSourceRef({ ...makeSourceRef(), message_id: "" }), "invalid_type");
  });
});
