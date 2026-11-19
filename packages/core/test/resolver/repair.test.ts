import { afterEach, describe, expect, it } from "vitest";
import { parseMemory } from "../../src/contracts/index.js";
import { REPAIR_MAX_CORRECTIONS, repairStaleMemory, resolveMemory } from "../../src/resolver/index.js";
import type { StaleEventSummary } from "../../src/contracts/index.js";
import type { MemoryStore } from "../../src/storage/index.js";
import { bodyWith, openTempStore, storedMemory } from "../storage/support.js";
import { PROJECT_A, seedMemory } from "../retrieval/support.js";
import { makeMemoryCard, makeSourceRef, measuredNonWhitespace } from "../support.js";
import { bodyOfLength, makeScriptedModel } from "../extraction/support.js";

const stores: MemoryStore[] = [];

function newStore(): MemoryStore {
  const store = openTempStore();
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function anchor(id: string) {
  return makeSourceRef({ message_id: id });
}

function seed() {
  const store = newStore();
  const source = anchor("m-1");
  const base = storedMemory();
  const body = bodyWith("原始记录端口 8787。 [来源:m-1]");
  const memory = {
    ...base,
    medium: { body, body_char_count: measuredNonWhitespace(body), sources: [source] },
  };
  store.saveMemory(memory);
  const first = store.markStale({
    memory_id: memory.memory_id,
    observed_revision: 1,
    reason: "端口后来改了",
    excerpt: "the port changed to 9090",
    sources: [anchor("m-20")],
    producer: "detector",
    at: "2026-11-18T01:00:00Z",
  });
  const second = store.markStale({
    memory_id: memory.memory_id,
    observed_revision: 1,
    reason: "回滚方式也变了",
    excerpt: "the rollback procedure changed",
    sources: [anchor("m-21")],
    producer: "detector",
    at: "2026-11-18T02:00:00Z",
  });
  const freshness = store.readFreshness(memory.uri, 1)!;
  const card = makeMemoryCard({
    memory_id: memory.memory_id,
    uri: memory.uri,
    scope: memory.scope,
    revision: 1,
    state: memory.state,
    freshness: {
      is_stale: true,
      head_revision: 1,
      pending_count: 2,
      freshness_sig: freshness.freshness_sig,
    },
  });
  return { store, memory, first: first.event, second: second.event, pending: freshness.pending, card };
}

function repairInput(
  fixture: ReturnType<typeof seed>,
  model: ReturnType<typeof makeScriptedModel>,
  overrides: Record<string, unknown> = {},
) {
  return {
    store: fixture.store,
    card: fixture.card,
    pending: fixture.pending as StaleEventSummary[],
    answer: "端口现在是 9090，回滚方式也变了。",
    excerpts: [],
    expected_revision: 1,
    model: model.port,
    model_id: "scripted",
    signal: new AbortController().signal,
    at: "2026-11-18T03:00:00Z",
    project: "p-vestigio",
    ...overrides,
  };
}

describe("repairStaleMemory", () => {
  it("folds cited pending events into the same memory and advances the head", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(600, fixture.first.event_id) }) }
        : { text: "{}" },
    );
    const outcome = await repairStaleMemory(repairInput(fixture, model));

    expect(outcome.status).toBe("repaired");
    expect(outcome.incorporated_event_ids).toEqual([fixture.first.event_id]);
    expect(outcome.memory?.memory_id).toBe(fixture.memory.memory_id);
    expect(outcome.memory?.revision).toBe(2);
    expect(outcome.memory?.state).toBe("medium_ready");
    expect(outcome.memory?.nav).toBeNull();

    const head = fixture.store.readMemory(fixture.memory.uri)!;
    expect(head.revision).toBe(2);
    expect(head.medium.body).toBe(bodyOfLength(600, fixture.first.event_id));
    expect(head.medium.sources.map((ref) => ref.message_id)).toContain("m-20");
    const freshness = fixture.store.readFreshness(fixture.memory.uri, 2)!;
    expect(freshness.pending_count).toBe(1);
    expect(freshness.pending[0]?.event_id).toBe(fixture.second.event_id);
  });

  it("acknowledges every cited snapshot event and leaves the uncited one pending", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? {
            text: JSON.stringify({
              body: bodyWith(`端口 9090，回滚方式与旧版不同 [来源:${fixture.first.event_id}]`),
            }),
          }
        : { text: "{}" },
    );
    const outcome = await repairStaleMemory(repairInput(fixture, model));
    expect(outcome.status).toBe("repaired");
    expect(outcome.incorporated_event_ids).toEqual([fixture.first.event_id]);
    expect(fixture.store.countPendingStaleEvents(fixture.memory.memory_id)).toBe(1);
  });

  it("writes nothing when the model call fails, keeping the old body and every event pending", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind) =>
      kind === "summary" ? { fail: "unavailable", reason: "down" } : { text: "{}" },
    );
    const outcome = await repairStaleMemory(repairInput(fixture, model));
    expect(outcome.status).toBe("failed");
    expect(outcome.memory).toBeNull();
    expect(fixture.store.readMemory(fixture.memory.uri)?.revision).toBe(1);
    expect(fixture.store.readMemory(fixture.memory.uri)?.medium.body).toContain("原始记录端口 8787");
    expect(fixture.store.countPendingStaleEvents(fixture.memory.memory_id)).toBe(2);
  });

  it("writes nothing when the model cannot fill a valid body", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind) =>
      kind === "summary" ? { text: JSON.stringify({ body: "太短了 [来源:e1]" }) } : { text: "{}" },
    );
    const outcome = await repairStaleMemory(repairInput(fixture, model));
    expect(outcome.status).toBe("insufficient_evidence");
    expect(fixture.store.readMemory(fixture.memory.uri)?.revision).toBe(1);
    expect(fixture.store.countPendingStaleEvents(fixture.memory.memory_id)).toBe(2);
  });

  it("writes nothing when the body cites an unknown source", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind) =>
      kind === "summary" ? { text: JSON.stringify({ body: bodyOfLength(600, "not-allowed") }) } : { text: "{}" },
    );
    const outcome = await repairStaleMemory(repairInput(fixture, model));
    expect(outcome.status).toBe("invalid");
    expect(fixture.store.countPendingStaleEvents(fixture.memory.memory_id)).toBe(2);
  });

  it("does not write a body that cites no pending event", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(600, fixture.memory.memory_id) }) }
        : { text: "{}" },
    );
    const outcome = await repairStaleMemory(repairInput(fixture, model));
    expect(outcome.status).toBe("not_incorporated");
    expect(fixture.store.readMemory(fixture.memory.uri)?.revision).toBe(1);
  });

  it("reports a conflict and writes nothing when the head moved under it", async () => {
    const fixture = seed();
    const head = fixture.store.readMemory(fixture.memory.uri)!;
    fixture.store.saveMemory(
      parseMemory({
        ...head,
        revision: 2,
        state: "medium_ready",
        nav: null,
        medium: { ...head.medium, body: bodyWith("另一个会话写入的新版本 [来源:m-1]") },
        updated_at: "2026-11-18T02:30:00Z",
      }),
    );
    const model = makeScriptedModel((kind) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(600, fixture.first.event_id) }) }
        : { text: "{}" },
    );
    const outcome = await repairStaleMemory(repairInput(fixture, model));
    expect(outcome.status).toBe("conflict");
    expect(fixture.store.readMemory(fixture.memory.uri)?.revision).toBe(2);
    expect(fixture.store.countPendingStaleEvents(fixture.memory.memory_id)).toBe(2);
  });

  it("retries a malformed answer once with a correction and writes the corrected body", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind, index) => {
      if (kind !== "summary") return { text: "{}" };
      if (index === 0) return { text: "不是 JSON，只写了一半" };
      return { text: JSON.stringify({ body: bodyOfLength(600, fixture.first.event_id) }) };
    });
    const outcome = await repairStaleMemory(repairInput(fixture, model));

    expect(outcome.status).toBe("repaired");
    expect(model.summary_calls).toBe(2);
    expect(outcome.calls).toHaveLength(2);
    const retry = model.requests[1]!;
    expect(retry.messages.at(-1)?.content).toContain("correction:");
    expect(retry.messages.at(-1)?.content).toContain(fixture.first.event_id);
    expect(fixture.store.readMemory(fixture.memory.uri)?.revision).toBe(2);
    expect(fixture.store.countPendingStaleEvents(fixture.memory.memory_id)).toBe(1);
  });

  it("tells the first attempt how to fit several pending events into the limit", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind) =>
      kind === "summary" ? { text: JSON.stringify({ body: bodyOfLength(600, fixture.first.event_id) }) } : { text: "{}" },
    );
    await repairStaleMemory(repairInput(fixture, model));

    const first = model.requests[0]!.messages.at(-1)?.content ?? "";
    expect(first).toContain("this rewrite:");
    expect(first).toContain("folds 2 pending change(s)");
    expect(first).toContain("500-660");
    expect(first).not.toContain("correction:");
  });

  it("asks for a rewrite while the body is over the band, then stores it", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind) =>
      kind === "summary" ? { text: JSON.stringify({ body: bodyOfLength(1389, fixture.first.event_id) }) } : { text: "{}" },
    );
    const outcome = await repairStaleMemory(repairInput(fixture, model));

    expect(model.summary_calls).toBe(REPAIR_MAX_CORRECTIONS + 1);
    expect(model.requests[1]!.messages.at(-1)?.content).toContain("over the 1000 ceiling");
    expect(outcome.status).toBe("repaired");
    expect(fixture.store.readMemory(fixture.memory.uri)?.medium.body_char_count).toBe(1389);
    // The body cites the first event only, so the second one stays pending.
    expect(fixture.store.countPendingStaleEvents(fixture.memory.memory_id)).toBe(1);
  });

  it("writes nothing when the body stays beyond the accepted ceiling", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind) =>
      kind === "summary" ? { text: JSON.stringify({ body: bodyOfLength(2001, fixture.first.event_id) }) } : { text: "{}" },
    );
    const outcome = await repairStaleMemory(repairInput(fixture, model));

    expect(outcome.status).toBe("invalid");
    expect(outcome.reason).toBe("medium_above_max:2001");
    expect(fixture.store.readMemory(fixture.memory.uri)?.revision).toBe(1);
    expect(fixture.store.countPendingStaleEvents(fixture.memory.memory_id)).toBe(2);
  });

  it("gives up after the correction budget and leaves every event pending", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind) =>
      kind === "summary" ? { text: JSON.stringify({ body: bodyOfLength(600, "not-allowed") }) } : { text: "{}" },
    );
    const outcome = await repairStaleMemory(repairInput(fixture, model));

    expect(outcome.status).toBe("invalid");
    expect(model.summary_calls).toBe(REPAIR_MAX_CORRECTIONS + 1);
    expect(outcome.calls).toHaveLength(REPAIR_MAX_CORRECTIONS + 1);
    expect(fixture.store.readMemory(fixture.memory.uri)?.revision).toBe(1);
    expect(fixture.store.readMemory(fixture.memory.uri)?.medium.body).toContain("原始记录端口 8787");
    expect(fixture.store.countPendingStaleEvents(fixture.memory.memory_id)).toBe(2);
  });

  it("does not retry a cancelled call and leaves the body and every event pending", async () => {
    const fixture = seed();
    const controller = new AbortController();
    const model = makeScriptedModel((kind) =>
      kind === "summary" ? { fail: "cancelled", reason: "deadline" } : { text: "{}" },
    );
    const outcome = await repairStaleMemory(
      repairInput(fixture, model, { signal: controller.signal }),
    );

    expect(outcome.status).toBe("cancelled");
    expect(model.summary_calls).toBe(1);
    expect(fixture.store.readMemory(fixture.memory.uri)?.revision).toBe(1);
    expect(fixture.store.countPendingStaleEvents(fixture.memory.memory_id)).toBe(2);
  });

  it("retries once after a gateway 5xx and writes the corrected body", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind, index) => {
      if (kind !== "summary") return { text: "{}" };
      if (index === 0) return { fail: "failed", reason: "http 502: bad gateway" };
      return { text: JSON.stringify({ body: bodyOfLength(600, fixture.first.event_id) }) };
    });
    const outcome = await repairStaleMemory(repairInput(fixture, model));

    expect(outcome.status).toBe("repaired");
    expect(model.summary_calls).toBe(2);
    expect(model.requests[1]!.messages.at(-1)?.content).toContain("correction:");
  });

  it("retries an unparseable answer the port reported as invalid_response", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind, index) => {
      if (kind !== "summary") return { text: "{}" };
      if (index === 0) return { fail: "invalid_response", reason: "response is not JSON: <html>" };
      return { text: JSON.stringify({ body: bodyOfLength(600, fixture.first.event_id) }) };
    });
    const outcome = await repairStaleMemory(repairInput(fixture, model));

    expect(outcome.status).toBe("repaired");
    expect(model.summary_calls).toBe(2);
  });

  it("does not retry a 4xx failure that the next ask cannot fix", async () => {
    const fixture = seed();
    const model = makeScriptedModel((kind) =>
      kind === "summary" ? { fail: "failed", reason: "http 400: bad request" } : { text: "{}" },
    );
    const outcome = await repairStaleMemory(repairInput(fixture, model));

    expect(outcome.status).toBe("failed");
    expect(model.summary_calls).toBe(1);
    expect(fixture.store.countPendingStaleEvents(fixture.memory.memory_id)).toBe(2);
  });

  it("is not applicable when there is nothing pending", async () => {
    const fixture = seed();
    const model = makeScriptedModel(() => ({ text: "{}" }));
    const outcome = await repairStaleMemory(repairInput(fixture, model, { pending: [] }));
    expect(outcome.status).toBe("not_applicable");
    expect(model.requests).toHaveLength(0);
  });
});

describe("resolver walk repairs the memory it cites", () => {
  it("updates the same memory instead of writing a second one", async () => {
    const store = newStore();
    const memory = seedMemory(store, { memory_id: "mem-active" });
    const first = store.markStale({
      memory_id: memory.memory_id,
      observed_revision: 1,
      reason: "端口后来改成 9090",
      excerpt: "the default port changed to 9090",
      sources: [anchor("m-30")],
      producer: "detector",
      at: "2026-11-18T01:00:00Z",
    });
    store.markStale({
      memory_id: memory.memory_id,
      observed_revision: 1,
      reason: "回滚顺序变了",
      excerpt: "rollback now reverts the image first",
      sources: [anchor("m-31")],
      producer: "detector",
      at: "2026-11-18T02:00:00Z",
    });

    const model = makeScriptedModel((kind, index) => {
      if (kind === "summary") {
        return { text: JSON.stringify({ body: bodyOfLength(600, first.event.event_id) }) };
      }
      if (index === 0) {
        return {
          text: JSON.stringify({
            sufficient: true,
            answer: "The default port is now 9090.",
            evidence_ids: [memory.memory_id],
            read_uris: [],
            next_queries: [],
            conflicts: [],
            descend: false,
          }),
        };
      }
      return {
        text: JSON.stringify({
          sufficient: false,
          answer: null,
          evidence_ids: [],
          read_uris: [],
          next_queries: [],
          conflicts: [],
          descend: true,
        }),
      };
    });

    const outcome = await resolveMemory({
      store,
      question: "端口",
      scope: { kind: "project", project_id: PROJECT_A },
      model: model.port,
      model_id: "scripted",
    });

    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.memory_uri).toBe(memory.uri);
    expect(outcome.result.revision).toBe(2);
    expect(outcome.result.persistence_status).toBe("saved");
    expect(outcome.result.memory_summary).toBe(bodyOfLength(600, first.event.event_id));
    expect(outcome.result.freshness?.pending_count).toBe(1);
    expect(outcome.calls.some((call) => call.purpose === "medium_summary")).toBe(true);
    expect(store.listHeads({ kind: "project", project_id: PROJECT_A })).toHaveLength(1);
    expect(store.readMemory(memory.uri)?.revision).toBe(2);
  });

  it("keeps the old body and pending events when the repair call fails", async () => {
    const store = newStore();
    const memory = seedMemory(store, { memory_id: "mem-active" });
    const event = store.markStale({
      memory_id: memory.memory_id,
      observed_revision: 1,
      reason: "端口后来改成 9090",
      excerpt: "the default port changed to 9090",
      sources: [anchor("m-30")],
      producer: "detector",
      at: "2026-11-18T01:00:00Z",
    });

    const model = makeScriptedModel((kind, index) => {
      if (kind === "summary") return { fail: "unavailable", reason: "down" };
      if (index === 0) {
        return {
          text: JSON.stringify({
            sufficient: true,
            answer: "The default port is now 9090.",
            evidence_ids: [memory.memory_id],
            read_uris: [],
            next_queries: [],
            conflicts: [],
            descend: false,
          }),
        };
      }
      return {
        text: JSON.stringify({
          sufficient: false,
          answer: null,
          evidence_ids: [],
          read_uris: [],
          next_queries: [],
          conflicts: [],
          descend: true,
        }),
      };
    });

    const outcome = await resolveMemory({
      store,
      question: "端口",
      scope: { kind: "project", project_id: PROJECT_A },
      model: model.port,
      model_id: "scripted",
    });

    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.revision).toBe(1);
    expect(outcome.result.memory_uri).toBe(memory.uri);
    expect(outcome.result.memory_summary).toBe(memory.medium.body);
    expect(outcome.result.persistence_status).toBe("not_attempted");
    expect(outcome.result.freshness?.pending_count).toBe(1);
    expect(store.readMemory(memory.uri)?.revision).toBe(1);
    expect(store.countPendingStaleEvents(memory.memory_id)).toBe(1);
    expect(store.listHeads({ kind: "project", project_id: PROJECT_A })).toHaveLength(1);
    expect(event.inserted).toBe(true);
  });
});
