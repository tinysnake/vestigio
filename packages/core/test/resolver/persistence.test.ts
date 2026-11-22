/**
 * PR-07 integration through the real resolver walk and a real store.
 *
 * Each case proves one contract line: the returned body is the stored body, a
 * repeated version writes nothing, a changed version is a new revision with no
 * nav, a reused Active answer does not trigger a write, a save failure never
 * claims `saved`, and the delivery access is recorded once per request.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { countSummaryJobs, readSummaryJob } from "../../src/jobs/index.js";
import { evidenceVersionKey, replaySavedRequest, requestKeyOf, resolveMemory, RESOLVE_REPLAY_MAX_AGE_MS } from "../../src/resolver/index.js";
import type { ResolveInput, ResolveOutcome } from "../../src/resolver/index.js";
import type { MemoryStore } from "../../src/storage/index.js";
import { bodyWith, makeHistoryPort, PROJECT_A, historyHit, openTempStore, seedMemory } from "../retrieval/support.js";
import { HISTORY_DECISION_TEXT, HISTORY_PORT_CHANGE_TEXT } from "../retrieval/support.js";
import { makeSourceRef } from "../support.js";
import { bodyOfLength, judgeScript, makeScriptedModel } from "../extraction/support.js";

const stores: MemoryStore[] = [];

function newStore(): MemoryStore {
  const store = openTempStore();
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

const projectA = { kind: "project", project_id: PROJECT_A } as const;
const QUESTION = "默认端口是多少";

function baseInput(store: MemoryStore, overrides: Partial<ResolveInput>): ResolveInput {
  return {
    store,
    question: QUESTION,
    scope: projectA,
    ...overrides,
  };
}

function oneHistoryHit(text = HISTORY_DECISION_TEXT): ReturnType<typeof historyHit> {
  return historyHit(text);
}

/**
 * An empty scope judges only the history layer, so the first judge call is the
 * one that answers. A test that seeds a memory needs the layered script instead.
 */
function historyOnly(messageId: string) {
  return judgeScript(messageId, { layers_before_history: 0 });
}

function countAccess(store: MemoryStore): number {
  const row = store.database().prepare("SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'access'").get();
  return typeof row?.["n"] === "number" ? row["n"] : 0;
}

async function resolveWithHistory(
  store: MemoryStore,
  hit: ReturnType<typeof historyHit>,
  model: ReturnType<typeof makeScriptedModel>,
  overrides: Partial<ResolveInput> = {},
): Promise<ResolveOutcome> {
  const history = makeHistoryPort({ hits: [hit] });
  return resolveMemory(baseInput(store, { model: model.port, history: history.port, ...overrides }));
}

describe("resolved history is written as one medium summary", () => {
  it("returns the stored body at a readable revision with a pending nav job", async () => {
    const store = newStore();
    const hit = oneHistoryHit();
    const model = makeScriptedModel(historyOnly(hit.source_ref.message_id));

    const outcome = await resolveWithHistory(store, hit, model);
    const result = outcome.result;

    expect(result.status).toBe("resolved");
    expect(result.persistence_status).toBe("saved");
    expect(result.navigation_status).toBe("pending");
    expect(result.memory_uri).not.toBeNull();
    expect(result.revision).toBe(1);
    expect(result.memory_summary).not.toBeNull();
    expect(outcome.persistence?.stage).toBe("returned");
    expect(outcome.persistence?.reused).toBe(false);

    const uri = result.memory_uri;
    if (uri === null || result.revision === null) throw new Error("expected a saved memory");
    const stored = store.readMemory(uri, result.revision);
    expect(stored).not.toBeNull();
    expect(stored?.medium.body).toBe(result.memory_summary);
    expect(stored?.state).toBe("medium_ready");
    expect(stored?.nav).toBeNull();
    expect(stored?.medium.sources.map((ref) => ref.message_id)).toEqual(
      result.evidence.map((ref) => ref.message_id),
    );
    expect(stored?.medium.body_char_count).toBeGreaterThanOrEqual(500);
    expect(stored?.medium.body_char_count).toBeLessThanOrEqual(1000);

    expect(readSummaryJob(store.database(), stored?.memory_id ?? "", 1)?.state).toBe("pending");
    expect(store.readMemory(uri, 1)?.access_count).toBe(1);
    expect(countAccess(store)).toBe(1);
    expect(model.summary_calls).toBe(1);

    const version = store
      .database()
      .prepare("SELECT stage FROM resolve_versions WHERE version_key = ?")
      .get(evidenceVersionKey(result.evidence));
    expect(version?.["stage"]).toBe("returned");
  });

  it("stores a grounded question alias so a later search by that wording finds the memory", async () => {
    const store = newStore();
    const hit = oneHistoryHit();
    const base = historyOnly(hit.source_ref.message_id);
    const model = makeScriptedModel((kind, index) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(600, "e1"), aliases: ["容器", "镜像"] }) }
        : base(kind, index),
    );

    const outcome = await resolveWithHistory(store, hit, model, {
      question: "打包成容器的时候名字怎么起",
    });
    const uri = outcome.result.memory_uri;
    if (uri === null) throw new Error("expected a saved memory");
    const stored = store.readMemory(uri);
    expect(stored).not.toBeNull();
    expect(stored?.medium.body).not.toContain("容器");
    expect(stored?.keywords).toContain("容器");
    expect(stored?.keywords).not.toContain("镜像");
    expect(store.searchActive("容器").map((entry) => entry.memory_id)).toContain(stored?.memory_id);
  });

  it("reuses the same revision and makes no summary call on a repeat request", async () => {
    const store = newStore();
    const hit = oneHistoryHit();
    const first = await resolveWithHistory(store, hit, makeScriptedModel(historyOnly(hit.source_ref.message_id)), {
      request_id: "req-repeat",
    });
    const uri = first.result.memory_uri;
    if (uri === null) throw new Error("expected a saved memory");

    const secondModel = makeScriptedModel(historyOnly(hit.source_ref.message_id));
    const second = await resolveWithHistory(store, hit, secondModel, { request_id: "req-repeat" });

    expect(secondModel.summary_calls).toBe(0);
    expect(second.result.memory_uri).toBe(uri);
    expect(second.result.revision).toBe(1);
    expect(second.result.memory_summary).toBe(first.result.memory_summary);
    expect(second.persistence?.reused).toBe(true);
    expect(second.persistence?.delivery_recorded).toBe(false);
    expect(store.countMemories()).toBe(1);
    expect(store.readMemory(uri, 1)?.access_count).toBe(1);
    expect(countSummaryJobs(store.database())).toBe(1);
  });

  it("records one access for a retried delivery of the same request and a second for a new one", async () => {
    const store = newStore();
    const hit = oneHistoryHit();
    await resolveWithHistory(store, hit, makeScriptedModel(historyOnly(hit.source_ref.message_id)), {
      request_id: "req-1",
    });
    const uri = store.listHeads()[0]?.uri;
    if (uri === undefined) throw new Error("expected a saved memory");

    // The client saw no response and retried the identical request: the body
    // reaches it again, but the access was already recorded.
    const retry = await resolveWithHistory(store, hit, makeScriptedModel(historyOnly(hit.source_ref.message_id)), {
      request_id: "req-1",
    });
    expect(retry.persistence?.delivery_recorded).toBe(false);
    expect(store.readMemory(uri, 1)?.access_count).toBe(1);

    // The saved memory gives Active a layer to judge, so this resolve needs the
    // layered script: descend through Active, then answer from history.
    const fresh = await resolveWithHistory(store, hit, makeScriptedModel(judgeScript(hit.source_ref.message_id)), {
      request_id: "req-2",
    });
    expect(fresh.persistence?.delivery_recorded).toBe(true);
    expect(store.readMemory(uri, 1)?.access_count).toBe(2);
  });

  it("creates a new revision with nav null when the evidence version changes", async () => {
    const store = newStore();
    const firstHit = oneHistoryHit();
    const first = await resolveWithHistory(
      store,
      firstHit,
      makeScriptedModel(historyOnly(firstHit.source_ref.message_id)),
    );
    const uri = first.result.memory_uri;
    if (uri === null) throw new Error("expected a saved memory");

    const secondHit = historyHit(HISTORY_PORT_CHANGE_TEXT, {
      source_ref: makeSourceRef({
        provider: "obelisk",
        source_instance: "fixture",
        session_id: "sessA",
        message_id: "h-2",
        project_id: PROJECT_A,
        timestamp: "2026-11-17T16:20:00Z",
        content_hash: `sha256:${"a".repeat(64)}`,
        locator: "/sessions/projA/sessA.jsonl#h-2",
      }),
    });
    const second = await resolveWithHistory(
      store,
      secondHit,
      makeScriptedModel((kind, index) =>
        kind === "summary"
          ? { text: JSON.stringify({ body: `${bodyOfLength(600, "e1")}第二版补充。` }) }
          : judgeScript("h-2")(kind, index),
      ),
      // A new evidence version arrives with a new question; an identical
      // request is replayed from the store and never rewrites the revision.
      { question: "端口后来改成多少" },
    );

    expect(second.result.memory_uri).toBe(uri);
    expect(second.result.revision).toBe(2);
    expect(store.listRevisions(uri)).toEqual([1, 2]);
    const head = store.readMemory(uri);
    expect(head?.revision).toBe(2);
    expect(head?.state).toBe("medium_ready");
    expect(head?.nav).toBeNull();
    expect(head?.medium.body).toBe(second.result.memory_summary);
    expect(head?.medium.body).not.toBe(first.result.memory_summary);
    expect(store.readMemory(uri, 1)?.medium.body).toBe(first.result.memory_summary);
    expect(countSummaryJobs(store.database(), "pending")).toBe(2);
  });
});

describe("the repeat path", () => {
  it("returns the stored answer, never the generated title", async () => {
    const store = newStore();
    const hit = oneHistoryHit();
    const first = await resolveWithHistory(store, hit, makeScriptedModel(historyOnly(hit.source_ref.message_id)), {
      request_id: "req-answer",
    });

    const recall = replaySavedRequest({
      store,
      scope: projectA,
      question: QUESTION,
      request_id: "req-answer",
      mono_now: () => 0,
      wall_now: () => Date.now(),
    });

    expect(recall).not.toBeNull();
    expect(recall?.answer).toBe(first.result.answer);
    expect(recall?.answer).not.toBe(recall?.memory.title);
  });

  it("ages out a question-keyed replay so a later re-ask searches again", async () => {
    const store = newStore();
    const hit = oneHistoryHit();
    await resolveWithHistory(store, hit, makeScriptedModel(historyOnly(hit.source_ref.message_id)), {});
    const savedAt = Date.now();
    const replayAt = (wall: number) =>
      replaySavedRequest({ store, scope: projectA, question: QUESTION, mono_now: () => 0, wall_now: () => wall });

    expect(replayAt(savedAt)).not.toBeNull();
    expect(replayAt(savedAt + RESOLVE_REPLAY_MAX_AGE_MS + 1)).toBeNull();
  });

  it("keys an explicit request id by its question as well", () => {
    const ports = requestKeyOf({ scope: projectA, question: "端口是多少", request_id: "turn-7" });
    const rollback = requestKeyOf({ scope: projectA, question: "回滚怎么做", request_id: "turn-7" });
    const again = requestKeyOf({ scope: projectA, question: "端口是多少", request_id: "turn-7" });

    expect(ports).not.toBe(rollback);
    expect(again).toBe(ports);
  });
});

describe("when the write must not happen", () => {
  it("does not trigger on an Active-only answer (reuse, not new history)", async () => {
    const store = newStore();
    const seeded = seedMemory(store, { memory_id: "mem-active" });
    const model = makeScriptedModel((kind) => {
      if (kind !== "judge") return { text: JSON.stringify({ body: bodyOfLength(600) }) };
      return {
        text: JSON.stringify({
          sufficient: true,
          answer: "种子记忆里是 8787。",
          evidence_ids: [seeded.memory_id],
          read_uris: [],
          next_queries: [],
          conflicts: [],
          descend: false,
        }),
      };
    });

    const outcome = await resolveMemory(
      baseInput(store, { model: model.port, question: "部署脚本默认端口" }),
    );
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.persistence).toBeNull();
    expect(outcome.result.persistence_status).toBe("not_attempted");
    expect(outcome.result.memory_summary).toBeNull();
    expect(store.countMemories()).toBe(1);
    expect(countSummaryJobs(store.database())).toBe(0);
    expect(model.summary_calls).toBe(0);
  });

  it("refuses to summarize evidence shorter than the minimum body, and spends no call", async () => {
    const store = newStore();
    const hit = historyHit("决定保持端口 8787，回滚时恢复旧配置");
    const model = makeScriptedModel(historyOnly(hit.source_ref.message_id));

    const outcome = await resolveWithHistory(store, hit, model);
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.persistence_status).toBe("insufficient_evidence");
    expect(outcome.result.memory_summary).toBeNull();
    expect(outcome.result.memory_uri).toBeNull();
    expect(outcome.result.missing.some((entry) => entry.startsWith("medium_evidence_too_short"))).toBe(true);
    expect(model.summary_calls).toBe(0);
    expect(store.countMemories()).toBe(0);
  });

  it("rejects a body longer than the evidence it claims to summarize", async () => {
    const store = newStore();
    const hit = oneHistoryHit();
    const judge = historyOnly(hit.source_ref.message_id);
    const model = makeScriptedModel((kind, index) =>
      kind === "summary" ? { text: JSON.stringify({ body: bodyOfLength(1000, "e1") }) } : judge(kind, index),
    );

    const outcome = await resolveWithHistory(store, hit, model);
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.persistence_status).toBe("failed");
    expect(outcome.result.memory_summary).not.toBeNull();
    expect(outcome.result.memory_uri).toBeNull();
    expect(outcome.result.missing.some((entry) => entry.startsWith("medium_longer_than_evidence"))).toBe(true);
    expect(store.countMemories()).toBe(0);
  });

  it("reports insufficient_evidence and saves nothing when the honest body is too short", async () => {
    const store = newStore();
    const hit = oneHistoryHit();
    const judge = historyOnly(hit.source_ref.message_id);
    const model = makeScriptedModel((kind, index) =>
      kind === "summary"
        ? { text: JSON.stringify({ body: bodyOfLength(499, "e1") }) }
        : judge(kind, index),
    );

    const outcome = await resolveWithHistory(store, hit, model);
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.persistence_status).toBe("insufficient_evidence");
    expect(outcome.result.memory_summary).not.toBeNull();
    expect(outcome.result.memory_uri).toBeNull();
    expect(outcome.result.missing.some((entry) => entry.startsWith("medium_insufficient_evidence"))).toBe(
      true,
    );
    expect(store.countMemories()).toBe(0);
    expect(countSummaryJobs(store.database())).toBe(0);
  });

  it("reports budget_exhausted when the ledger has no summary slot", async () => {
    const store = newStore();
    const hit = oneHistoryHit();
    const model = makeScriptedModel(historyOnly(hit.source_ref.message_id));

    const outcome = await resolveWithHistory(store, hit, model, {
      // One judge call is all an empty scope spends, so the output ceiling that
      // leaves no room for a summary must sit at its cost.
      budget: { max_model_calls: 3, max_output_tokens: 1 },
    });
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.persistence_status).toBe("budget_exhausted");
    expect(outcome.result.missing).toContain("budget:output_token_cap");
    expect(outcome.persistence?.stage).toBe("searched");
    expect(store.countMemories()).toBe(0);
    expect(model.summary_calls).toBe(0);
  });

  it("reports a save failure as failed and never claims saved", async () => {
    const store = newStore();
    const hit = oneHistoryHit();
    const versionKey = evidenceVersionKey([hit.source_ref]);
    const collidingId = `mem-${createHash("sha256").update(versionKey, "utf8").digest("hex").slice(0, 16)}`;
    // Same memory id and revision, different content: the store refuses it.
    const existing = seedMemory(store, {
      memory_id: collidingId,
      title: "另一段记忆",
      body: bodyWith("这段记忆与本次写入口径不同，保存时必须被拒绝。"),
    });
    // The seeded memory gives Active a layer to judge before history.
    const model = makeScriptedModel(judgeScript(hit.source_ref.message_id));

    const outcome = await resolveWithHistory(store, hit, model);
    expect(outcome.result.persistence_status).toBe("failed");
    expect(outcome.result.memory_uri).toBeNull();
    expect(outcome.result.revision).toBeNull();
    expect(outcome.result.memory_summary).not.toBeNull();
    expect(outcome.result.missing.some((entry) => entry.startsWith("persist_failed"))).toBe(true);
    expect(store.readMemory(existing.uri)?.medium.body).toBe(existing.medium.body);
    expect(store.countMemories()).toBe(1);
    expect(countSummaryJobs(store.database())).toBe(0);
  });

  it("reports a model failure as failed without a body or a row", async () => {
    const store = newStore();
    const hit = oneHistoryHit();
    const model = makeScriptedModel(historyOnly(hit.source_ref.message_id), { fail_summary: true });

    const outcome = await resolveWithHistory(store, hit, model);
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.persistence_status).toBe("failed");
    expect(outcome.result.memory_summary).toBeNull();
    expect(outcome.result.missing.some((entry) => entry.startsWith("medium_failed"))).toBe(true);
    expect(store.countMemories()).toBe(0);
  });
});
