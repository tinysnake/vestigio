import { describe, expect, it } from "vitest";
import { detectStale, parseDetectorDecision, type StaleCandidate } from "../../src/stale/index.js";
import type { ModelPort, ModelRequest, ModelResult } from "../../src/resolver/index.js";

function model(text: string, outcome: "ok" | "fail" | "cancel" = "ok"): { port: ModelPort; calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    port: {
      async complete(request: ModelRequest): Promise<ModelResult> {
        calls.push(request);
        if (outcome === "fail") return { ok: false, status: "unavailable", reason: "down" };
        if (outcome === "cancel") return { ok: false, status: "cancelled", reason: "aborted" };
        return {
          ok: true,
          value: {
            text,
            model: "scripted",
            finish_reason: "stop",
            usage: { tokens_in: 10, tokens_out: 5, cost_usd: null },
          },
        };
      },
    },
  };
}

function candidate(overrides: Partial<StaleCandidate> = {}): StaleCandidate {
  return {
    memory_id: "mem-active",
    uri: "memory://vestigio/mem-active",
    title: "部署脚本默认端口",
    revision: 1,
    freshness: { is_stale: false, head_revision: 1, pending_count: 0, freshness_sig: "" },
    pending: [],
    ...overrides,
  };
}

const EVIDENCE = [
  {
    id: "entry-3",
    kind: "history" as const,
    provider: "pi",
    source_instance: "session",
    session_id: "s-1",
    timestamp: "2026-11-18T01:00:00Z",
    text: "the default port changed to 9090",
  },
];

const signal = new AbortController().signal;

describe("detectStale", () => {
  it("returns ok with a validated finding and makes exactly one call", async () => {
    const text = JSON.stringify({
      findings: [
        {
          memory_id: "mem-active",
          reason: "端口改成 9090",
          excerpt: "the default port changed to 9090",
          evidence_ids: ["entry-3"],
        },
      ],
    });
    const scripted = model(text);
    const result = await detectStale({
      model: scripted.port,
      model_id: "scripted",
      candidates: [candidate()],
      evidence: EVIDENCE,
      signal,
    });
    expect(result.status).toBe("ok");
    expect(result.findings).toEqual([
      {
        memory_id: "mem-active",
        reason: "端口改成 9090",
        excerpt: "the default port changed to 9090",
        evidence_ids: ["entry-3"],
      },
    ]);
    expect(scripted.calls).toHaveLength(1);
  });

  it("keeps an already-stale candidate eligible and passes its pending events to the model", async () => {
    const scripted = model(
      JSON.stringify({
        findings: [
          {
            memory_id: "mem-active",
            reason: "回滚顺序也变了",
            excerpt: "rollback now reverts the image first",
            evidence_ids: ["entry-3"],
          },
        ],
      }),
    );
    const stale = candidate({
      freshness: { is_stale: true, head_revision: 2, pending_count: 1, freshness_sig: "sig" },
      pending: [{ event_id: "evt-1", reason: "端口已改" }],
    });
    const result = await detectStale({
      model: scripted.port,
      model_id: "scripted",
      candidates: [stale],
      evidence: EVIDENCE,
      signal,
    });
    expect(result.status).toBe("ok");
    const user = scripted.calls[0]?.messages[1]?.content ?? "";
    expect(user).toContain("pending event: 端口已改");
    expect(user).toContain("stale=yes");
  });

  it("returns none without calling the model when there is nothing to inspect", async () => {
    const scripted = model("{}");
    const noEvidence = await detectStale({
      model: scripted.port,
      model_id: "scripted",
      candidates: [candidate()],
      evidence: [],
      signal,
    });
    const noCandidates = await detectStale({
      model: scripted.port,
      model_id: "scripted",
      candidates: [],
      evidence: EVIDENCE,
      signal,
    });
    expect(noEvidence.status).toBe("none");
    expect(noCandidates.status).toBe("none");
    expect(scripted.calls).toHaveLength(0);
  });

  it("rejects an unknown memory id and an unknown evidence id", async () => {
    const unknownMemory = model(
      JSON.stringify({ findings: [{ memory_id: "ghost", reason: "x", excerpt: "y", evidence_ids: ["entry-3"] }] }),
    );
    const unknownEvidence = model(
      JSON.stringify({
        findings: [{ memory_id: "mem-active", reason: "x", excerpt: "y", evidence_ids: ["ghost-entry"] }],
      }),
    );
    expect(
      (await detectStale({
        model: unknownMemory.port,
        model_id: "scripted",
        candidates: [candidate()],
        evidence: EVIDENCE,
        signal,
      })).status,
    ).toBe("invalid");
    expect(
      (await detectStale({
        model: unknownEvidence.port,
        model_id: "scripted",
        candidates: [candidate()],
        evidence: EVIDENCE,
        signal,
      })).status,
    ).toBe("invalid");
  });

  it("reports a failing or cancelled model without findings", async () => {
    const failing = await detectStale({
      model: model("", "fail").port,
      model_id: "scripted",
      candidates: [candidate()],
      evidence: EVIDENCE,
      signal,
    });
    const cancelled = await detectStale({
      model: model("", "cancel").port,
      model_id: "scripted",
      candidates: [candidate()],
      evidence: EVIDENCE,
      signal,
    });
    expect(failing.status).toBe("failed");
    expect(failing.findings).toEqual([]);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("parseDetectorDecision", () => {
  it("accepts an empty findings array and rejects malformed payloads", () => {
    expect(parseDetectorDecision('{"findings":[]}', ["mem-active"], ["entry-3"])).toEqual({ status: "accepted", findings: [] });
    expect(parseDetectorDecision("not json", ["mem-active"], ["entry-3"]).status).toBe("rejected");
    expect(parseDetectorDecision('{"findings":[{"memory_id":"mem-active"}]}', ["mem-active"], ["entry-3"]).status).toBe("rejected");
  });

  it("keeps an accepted empty reply apart from a rejected one", () => {
    const empty = parseDetectorDecision('{"findings":[]}', [], []);
    const rejected = parseDetectorDecision("not json", [], []);
    expect(empty.status).toBe("accepted");
    expect(rejected.status).toBe("rejected");
    if (rejected.status !== "rejected") return;
    expect(rejected.failure).toBe("malformed_json");
  });

  it("normalizes the reason and bounds the excerpt", () => {
    const long = "x".repeat(900);
    const parsed = parseDetectorDecision(
      JSON.stringify({
        findings: [{ memory_id: "mem-active", reason: "  many   spaces  ", excerpt: long, evidence_ids: ["entry-3"] }],
      }),
      ["mem-active"],
      ["entry-3"],
    );
    expect(parsed.status).toBe("accepted");
    if (parsed.status !== "accepted") return;
    expect(parsed.findings[0]?.reason).toBe("many spaces");
    expect(parsed.findings[0]!.excerpt.length).toBeLessThan(900);
  });
});
