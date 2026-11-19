/**
 * The extraction call's outcome mapping: a validated body is `ok`, a shorter
 * honest body is `insufficient_evidence` (returned, never stored), and every
 * other failure names itself instead of throwing.
 */

import { describe, expect, it } from "vitest";
import { extractMediumSummary } from "../../src/extraction/index.js";
import type { MediumEvidence } from "../../src/extraction/index.js";
import type { ModelRequest } from "../../src/resolver/index.js";
import { bodyOfLength, makeScriptedModel } from "./support.js";

const evidence: MediumEvidence[] = [
  {
    id: "h-1",
    kind: "history",
    provider: "obelisk",
    source_instance: "fixture",
    session_id: "sess-a",
    timestamp: "2026-11-17T10:00:00.000Z",
    text: "决定保持端口 8787",
  },
];

function extractWith(text: string, allowed = ["h-1"]) {
  const model = makeScriptedModel(() => ({ text }));
  const requests: ModelRequest[] = model.requests;
  return {
    run: extractMediumSummary({
      model: model.port,
      model_id: "stub/model",
      evidence: { question: "默认端口是多少", project: "/tmp/proj-a", evidence },
      allowed_ids: allowed,
      max_output_tokens: 1600,
      signal: new AbortController().signal,
    }),
    requests,
    model,
  };
}

describe("extractMediumSummary", () => {
  it("returns the validated body with its count and citations", async () => {
    const body = bodyOfLength(600, "h-1");
    const { run } = extractWith(JSON.stringify({ body }));
    const result = await run;
    expect(result.status).toBe("ok");
    expect(result.body).toBe(body);
    expect(result.body_char_count).toBe(600);
    expect(result.cited_ids).toEqual(["h-1"]);
    expect(result.call.outcome).toBe("ok");
  });

  it("reports a shorter honest body as insufficient evidence and keeps it readable", async () => {
    const body = bodyOfLength(499, "h-1");
    const result = await extractWith(JSON.stringify({ body })).run;
    expect(result.status).toBe("insufficient_evidence");
    expect(result.body).toBe(body);
    expect(result.body_char_count).toBe(499);
    expect(result.reason).toBe("medium_below_min:499");
  });

  it("rejects malformed output without inventing a body", async () => {
    const result = await extractWith("not json at all").run;
    expect(result.status).toBe("invalid");
    expect(result.body).toBeNull();
    expect(result.call.outcome).toBe("malformed");
  });

  it("rejects a foreign citation id", async () => {
    const result = await extractWith(JSON.stringify({ body: bodyOfLength(520, "h-9") })).run;
    expect(result.status).toBe("invalid");
    expect(result.reason).toContain("medium_foreign_source");
  });

  it("maps a port failure to failed and an abort to cancelled", async () => {
    const failing = makeScriptedModel(() => ({ fail: "unavailable", reason: "down" }));
    const failed = await extractMediumSummary({
      model: failing.port,
      model_id: "stub/model",
      evidence: { question: "q", project: null, evidence },
      allowed_ids: ["h-1"],
      max_output_tokens: 1600,
      signal: new AbortController().signal,
    });
    expect(failed.status).toBe("failed");
    expect(failed.reason).toBe("model_unavailable:down");

    const cancelled = makeScriptedModel(() => ({ fail: "cancelled", reason: "aborted" }));
    const outcome = await extractMediumSummary({
      model: cancelled.port,
      model_id: "stub/model",
      evidence: { question: "q", project: null, evidence },
      allowed_ids: ["h-1"],
      max_output_tokens: 1600,
      signal: new AbortController().signal,
    });
    expect(outcome.status).toBe("cancelled");
  });

  it("sends bounded evidence and the length rule to the model", async () => {
    const { run, requests } = extractWith(JSON.stringify({ body: bodyOfLength(600) }));
    await run;
    const user = requests[0]?.messages[1]?.content ?? "";
    expect(user).toContain("id=h-1");
    expect(user).toContain("500-660");
    expect(requests[0]?.max_output_tokens).toBe(1600);
  });
});
