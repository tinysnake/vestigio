import { afterEach, describe, expect, it } from "vitest";
import { composeMemoryRequest, insertMemoryRequest, requestTitle } from "../../src/requests/index.js";
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

/** A daemon-shaped request: the title is the framed form the composer persists. */
function writeRequest(
  store: MemoryStore,
  input: { intent: string; message_id: string; session_id: string; excerpt: string },
): MemoryRequest {
  const { request } = insertMemoryRequest(store.database(), {
    scope: { kind: "project", project_id: PROJECT_A },
    project_id: PROJECT_A,
    session_id: input.session_id,
    branch_ref: "root",
    intent: input.intent,
    title: requestTitle(input.intent),
    evidence: [
      {
        source: makeSourceRef({
          session_id: input.session_id,
          message_id: input.message_id,
          project_id: PROJECT_A,
        }),
        excerpt: input.excerpt,
      },
    ],
    at: AT,
  });
  return request;
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

function cites(messageId: string) {
  return makeScriptedModel((kind) =>
    kind === "summary" ? { text: JSON.stringify({ body: bodyOfLength(600, messageId) }) } : { text: "{}" },
  );
}

describe("paraphrase fold", () => {
  it("folds a paraphrased save into a legacy-framed subject instead of writing a second head", async () => {
    const store = newStore();
    const seed = seedMemory(store, {
      scope: { kind: "project", project_id: PROJECT_A },
      title: "关于「部署脚本的默认端口」",
      keywords: ["部署脚本默认端口保持 18080", "部署脚本端口约定"],
      body: bodyWith("部署脚本默认端口保持 18080，项目继续使用 pnpm"),
      sources: [
        makeSourceRef({ session_id: "seed-legacy", message_id: "seed-legacy-1", project_id: PROJECT_A }),
      ],
      nav_text: "部署脚本默认端口的约定。",
    });
    const req = writeRequest(store, {
      intent: "部署脚本默认端口保持 18080",
      message_id: "m-99",
      session_id: "s-later",
      excerpt: "部署脚本默认端口保持 18080，项目继续使用 pnpm",
    });
    const outcome = await composeMemoryRequest(input(store, req, cites("m-99")));
    expect(outcome.status).toBe("merged");
    expect(outcome.memory?.memory_id).toBe(seed.memory_id);
    expect(outcome.memory?.revision).toBe(2);
    expect(store.listHeads()).toHaveLength(1);
    expect(store.listHeads()[0]?.uri).toBe(seed.uri);
    expect(store.readMemory(seed.uri)?.revision).toBe(2);
  });

  it("folds a reordered paraphrase that shares no wording prefix with its head", async () => {
    const store = newStore();
    const seed = seedMemory(store, {
      scope: { kind: "project", project_id: PROJECT_A },
      title: "部署脚本默认端口",
      keywords: ["部署", "端口"],
      body: bodyWith("部署脚本默认端口保持 18080。"),
      sources: [makeSourceRef({ session_id: "s-seed", message_id: "seed-1", project_id: PROJECT_A })],
      nav_text: "部署脚本默认端口的约定。",
    });
    const req = writeRequest(store, {
      intent: "默认端口写在部署脚本里",
      message_id: "m-99",
      session_id: "s-later",
      excerpt: "默认端口写在部署脚本里",
    });
    const outcome = await composeMemoryRequest(input(store, req, cites("m-99")));
    expect(outcome.status).toBe("merged");
    expect(outcome.memory?.memory_id).toBe(seed.memory_id);
    expect(outcome.memory?.revision).toBe(2);
    expect(store.listHeads()).toHaveLength(1);
    expect(store.readMemory(seed.uri)?.revision).toBe(2);
  });

  it("still writes a second head for a genuinely different subject", async () => {
    const store = newStore();
    const seed = seedMemory(store, {
      scope: { kind: "project", project_id: PROJECT_A },
      title: requestTitle("部署脚本默认端口保持 18080"),
      keywords: ["部署脚本默认端口保持 18080"],
      body: bodyWith("部署脚本默认端口保持 18080。"),
      sources: [makeSourceRef({ session_id: "s-seed", message_id: "seed-1", project_id: PROJECT_A })],
      nav_text: "部署脚本默认端口的约定。",
    });
    const req = writeRequest(store, {
      intent: "包管理器统一用 pnpm 安装依赖",
      message_id: "m-99",
      session_id: "s-later",
      excerpt: "包管理器统一用 pnpm 安装依赖",
    });
    const outcome = await composeMemoryRequest(input(store, req, cites("m-99")));
    expect(outcome.status).toBe("saved");
    expect(outcome.memory?.memory_id).not.toBe(seed.memory_id);
    expect(store.listHeads()).toHaveLength(2);
    expect(store.readMemory(seed.uri)?.revision).toBe(1);
  });

  it("does not fold a shared title frame into an unrelated subject", async () => {
    const store = newStore();
    const seed = seedMemory(store, {
      scope: { kind: "project", project_id: PROJECT_A },
      title: requestTitle("部署脚本默认端口"),
      keywords: ["部署脚本默认端口"],
      body: bodyWith("部署脚本默认端口保持 18080。"),
      sources: [makeSourceRef({ session_id: "s-seed", message_id: "seed-1", project_id: PROJECT_A })],
      nav_text: "部署脚本默认端口的约定。",
    });
    const req = writeRequest(store, {
      intent: "部署脚本发布流程",
      message_id: "m-99",
      session_id: "s-later",
      excerpt: "部署脚本发布流程按环境分三步走",
    });
    const outcome = await composeMemoryRequest(input(store, req, cites("m-99")));
    expect(outcome.status).toBe("saved");
    expect(outcome.memory?.memory_id).not.toBe(seed.memory_id);
    expect(store.listHeads()).toHaveLength(2);
    expect(store.readMemory(seed.uri)?.revision).toBe(1);
  });
});
