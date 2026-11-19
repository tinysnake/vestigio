import { afterEach, describe, expect, it } from "vitest";
import { composeMemoryRequest, insertMemoryRequest } from "../../src/requests/index.js";
import { listSummaryJobs } from "../../src/jobs/index.js";
import type { MemoryRequest } from "../../src/requests/index.js";
import type { MemoryStore } from "../../src/storage/index.js";
import { bodyOfLength, makeScriptedModel } from "../extraction/support.js";
import { PROJECT_A, openTempStore, seedMemory, makeSourceRef } from "../retrieval/support.js";
import { bodyWith } from "../storage/support.js";

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

function request(store: MemoryStore, overrides: {
  intent?: string;
  title?: string;
  source_id?: string;
  source_ids?: string[];
  excerpt?: string;
} = {}): MemoryRequest {
  const { request: stored } = insertMemoryRequest(store.database(), {
    scope: { kind: "project", project_id: PROJECT_A },
    project_id: PROJECT_A,
    session_id: "s-1",
    branch_ref: "root",
    intent: overrides.intent ?? "项目统一使用 pnpm 安装依赖",
    title: overrides.title ?? "包管理器使用 pnpm",
    evidence: (overrides.source_ids ?? [overrides.source_id ?? "m-20"]).map((id) => ({
      source: makeSourceRef({ message_id: id, project_id: PROJECT_A }),
      excerpt: overrides.excerpt ?? "以后都用 pnpm，不要用 npm",
    })),
    at: AT,
  });
  return stored;
}

function input(store: MemoryStore, req: MemoryRequest, model: ReturnType<typeof makeScriptedModel>) {
  return {
    store,
    request: req,
    model: model.port,
    model_id: "scripted",
    signal: new AbortController().signal,
    at: AT,
    project: PROJECT_A,
  };
}

describe("composeMemoryRequest", () => {
  it("saves one new revision from the approved snapshot and queues its nav", async () => {
    const store = newStore();
    const req = request(store);
    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(600, "m-20") }) }
        : { text: "{}" },
    );
    const outcome = await composeMemoryRequest(input(store, req, model));
    expect(outcome.status).toBe("saved");
    expect(outcome.memory?.revision).toBe(1);
    expect(outcome.memory?.medium.sources.map((source) => source.message_id)).toEqual(["m-20"]);
    expect(store.readMemory(outcome.memory!.uri)?.medium.body).toContain("[来源:m-20]");
    expect(listSummaryJobs(store.database())).toHaveLength(1);
  });

  it("merges a request into an overlapping topic in one revision", async () => {
    const store = newStore();
    const memory = seedMemory(store, {
      scope: { kind: "project", project_id: PROJECT_A },
      title: "包管理器约定",
      body: bodyWith("项目统一使用 pnpm。 [来源:m-20]"),
      sources: [makeSourceRef({ message_id: "m-20", project_id: PROJECT_A })],
      nav_text: "包管理器的约定。",
    });
    const req = request(store, { source_ids: ["m-20", "m-21"] });
    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(600, "m-21") }) }
        : { text: "{}" },
    );
    const outcome = await composeMemoryRequest(input(store, req, model));
    expect(outcome.status).toBe("merged");
    expect(outcome.memory?.memory_id).toBe(memory.memory_id);
    expect(outcome.memory?.revision).toBe(2);
    expect(store.listRevisions(memory.uri)).toHaveLength(2);
  });

  it("absorbs an overlapping request and pending stale evidence with a single revision", async () => {
    const store = newStore();
    const memory = seedMemory(store, {
      scope: { kind: "project", project_id: PROJECT_A },
      title: "包管理器约定",
      body: bodyWith("项目统一使用 pnpm。 [来源:m-20]"),
      sources: [makeSourceRef({ message_id: "m-20", project_id: PROJECT_A })],
      nav_text: "包管理器的约定。",
    });
    const stale = store.markStale({
      memory_id: memory.memory_id,
      observed_revision: 1,
      reason: "团队后来改用 bun",
      excerpt: "团队决定改用 bun 安装依赖",
      sources: [makeSourceRef({ message_id: "m-30", project_id: PROJECT_A })],
      producer: "detector",
      at: "2026-11-19T09:00:00.000Z",
    });
    const req = request(store, { source_id: "m-20", excerpt: "以后都用 pnpm，不要用 npm" });
    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? {
            text: JSON.stringify({
              body: bodyWith(`团队改用 bun，但项目仍以 pnpm 为准。 [来源:m-20] [来源:${stale.event.event_id}]`),
            }),
          }
        : { text: "{}" },
    );
    const outcome = await composeMemoryRequest(input(store, req, model));
    expect(outcome.status).toBe("merged");
    expect(outcome.memory?.revision).toBe(2);
    expect(store.listRevisions(memory.uri)).toHaveLength(2);
    expect(store.countPendingStaleEvents(memory.memory_id)).toBe(0);
    expect(outcome.memory?.medium.sources.map((source) => source.message_id)).toEqual(
      expect.arrayContaining(["m-20", "m-30"]),
    );
  });

  it("does not record a merge when the body ignores the approved request evidence", async () => {
    const store = newStore();
    const memory = seedMemory(store, {
      scope: { kind: "project", project_id: PROJECT_A },
      title: "包管理器约定",
      body: bodyWith("项目统一使用 pnpm。 [来源:m-20]"),
      sources: [makeSourceRef({ message_id: "m-20", project_id: PROJECT_A })],
      nav_text: "包管理器的约定。",
    });
    const stale = store.markStale({
      memory_id: memory.memory_id,
      observed_revision: 1,
      reason: "团队后来改用 bun",
      excerpt: "团队决定改用 bun 安装依赖",
      sources: [makeSourceRef({ message_id: "m-30", project_id: PROJECT_A })],
      producer: "detector",
      at: "2026-11-19T09:00:00.000Z",
    });
    const req = request(store, { source_id: "m-20", excerpt: "以后都用 pnpm，不要用 npm" });
    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? {
            text: JSON.stringify({
              body: bodyWith(`团队改用 bun。 [来源:${stale.event.event_id}]`),
            }),
          }
        : { text: "{}" },
    );
    const outcome = await composeMemoryRequest(input(store, req, model));
    expect(outcome.status).toBe("retry");
    expect(outcome.reason).toBe("not_incorporated");
    expect(store.readMemory(memory.uri)?.revision).toBe(1);
    expect(store.listRevisions(memory.uri)).toHaveLength(1);
    expect(store.countPendingStaleEvents(memory.memory_id)).toBe(1);
  });

  it("writes nothing when the model fails, leaving the old revision untouched", async () => {
    const store = newStore();
    const memory = seedMemory(store, {
      scope: { kind: "project", project_id: PROJECT_A },
      title: "包管理器约定",
      body: bodyWith("项目统一使用 pnpm。 [来源:m-1]"),
      sources: [makeSourceRef({ message_id: "m-1", project_id: PROJECT_A })],
      nav_text: "包管理器的约定。",
    });
    const req = request(store, { source_id: "m-20" });
    const model = makeScriptedModel((kind) =>
      kind === "summary" ? { fail: "unavailable", reason: "down" } : { text: "{}" },
    );
    const outcome = await composeMemoryRequest(input(store, req, model));
    expect(outcome.status).toBe("retry");
    expect(outcome.memory).toBeNull();
    expect(store.readMemory(memory.uri)?.revision).toBe(1);
    expect(store.listRevisions(memory.uri)).toHaveLength(1);
  });

  it("does not accept a body that cites only unrelated evidence", async () => {
    const store = newStore();
    const req = request(store);
    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(600, "m-999") }) }
        : { text: "{}" },
    );
    const outcome = await composeMemoryRequest(input(store, req, model));
    expect(outcome.status).toBe("retry");
    expect(outcome.reason).toContain("foreign_source");
    expect(store.countMemoryRequests("saved")).toBe(0);
    expect(store.listHeads()).toHaveLength(0);
  });

  it("reuses a saved target after a crash instead of writing a twin", async () => {
    const store = newStore();
    const req = request(store);
    store.attachMemoryRequestTarget({
      request_id: req.request_id,
      memory_uri: "memory://vestigio/mem-crashed",
      revision: 1,
      at: AT,
    });
    const attached = store.readMemoryRequest(req.request_id);
    if (attached === null) throw new Error("request vanished");
    const seeded = seedMemory(store, {
      memory_id: "mem-crashed",
      scope: { kind: "project", project_id: PROJECT_A },
      title: "包管理器使用 pnpm",
      body: bodyWith("项目统一使用 pnpm。 [来源:m-20]"),
      sources: [makeSourceRef({ message_id: "m-20", project_id: PROJECT_A })],
      nav_text: "包管理器的约定。",
    });
    const model = makeScriptedModel(() => ({ text: "{}" }));
    const outcome = await composeMemoryRequest(input(store, attached, model));
    expect(outcome.status).toBe("saved");
    expect(outcome.reason).toBe("already_saved");
    expect(outcome.memory?.memory_id).toBe(seeded.memory_id);
    expect(store.listRevisions(seeded.uri)).toHaveLength(1);
    expect(model.summary_calls).toBe(0);
  });

  it("corrects a too-short body instead of dropping the request", async () => {
    const store = newStore();
    const req = request(store);
    const model = makeScriptedModel((kind, index) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(index === 0 ? 488 : 600, "m-20") }) }
        : { text: "{}" },
    );
    const outcome = await composeMemoryRequest(input(store, req, model));
    expect(outcome.status).toBe("saved");
    expect(model.summary_calls).toBe(2);
    expect(JSON.stringify(model.requests)).toContain("below the 500 floor");
    expect(store.listHeads()).toHaveLength(1);
  });

  it("leaves a persistently short body terminal instead of saving it", async () => {
    const store = newStore();
    const req = request(store);
    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(488, "m-20") }) }
        : { text: "{}" },
    );
    const outcome = await composeMemoryRequest(input(store, req, model));
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toBe("medium_below_min:488");
    expect(model.summary_calls).toBe(2);
    expect(store.listHeads()).toHaveLength(0);
  });
});
