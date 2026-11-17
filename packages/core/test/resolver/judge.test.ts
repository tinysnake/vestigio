import { describe, expect, it } from "vitest";
import { judgeAllowList, parseJudgeDecision } from "../../src/resolver/index.js";
import { makeMemoryCard } from "../support.js";

const allowed = judgeAllowList({
  cards: [makeMemoryCard({ memory_id: "mem-a", uri: "memory://vestigio/mem-a" })],
  excerpts: [],
});

describe("parseJudgeDecision", () => {
  it("accepts a fenced JSON object", () => {
    const parsed = parseJudgeDecision(
      '```json\n{"sufficient":true,"answer":"8080","evidence_ids":["mem-a"],"read_uris":[],"next_queries":[],"conflicts":[],"descend":false}\n```',
      allowed,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.evidence_ids).toEqual(["mem-a"]);
  });

  it("rejects an evidence id that was not gathered", () => {
    const parsed = parseJudgeDecision(
      JSON.stringify({ sufficient: true, answer: "x", evidence_ids: ["mem-ghost"], read_uris: [], next_queries: [], conflicts: [], descend: false }),
      allowed,
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects a read uri that was not offered", () => {
    const parsed = parseJudgeDecision(
      JSON.stringify({ sufficient: false, answer: null, evidence_ids: [], read_uris: ["memory://vestigio/mem-ghost"], next_queries: [], conflicts: [], descend: true }),
      allowed,
    );
    expect(parsed.ok).toBe(false);
  });

  it("requires an answer and evidence when sufficient", () => {
    expect(parseJudgeDecision(JSON.stringify({ sufficient: true, answer: null, evidence_ids: ["mem-a"], read_uris: [], next_queries: [], conflicts: [], descend: false }), allowed).ok).toBe(false);
    expect(parseJudgeDecision(JSON.stringify({ sufficient: true, answer: "x", evidence_ids: [], read_uris: [], next_queries: [], conflicts: [], descend: false }), allowed).ok).toBe(false);
  });

  it("treats expanded queries as a request to descend", () => {
    const parsed = parseJudgeDecision(
      JSON.stringify({ sufficient: false, answer: null, evidence_ids: [], read_uris: [], next_queries: ["other"], conflicts: [], descend: false }),
      allowed,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.descend).toBe(true);
  });

  it("reports the reason for a non-object", () => {
    const parsed = parseJudgeDecision("just prose", allowed);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("JSON");
  });
});
