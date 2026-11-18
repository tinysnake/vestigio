import type { Freshness } from "@vestigio/core";
import { describe, expect, it } from "vitest";
import { formatFreshnessLines, staleCardLine } from "../src/format.js";

const FRESHNESS: Freshness = {
  memory_id: "mem-port",
  is_stale: true,
  head_revision: 2,
  delivered_revision: 1,
  revision_mismatch: true,
  pending_count: 2,
  freshness_sig: "sha256:pending",
  pending: [
    {
      event_id: "event-a",
      memory_id: "mem-port",
      observed_revision: 1,
      reason: "默认端口已改为 18080",
      excerpt: "我们决定把默认端口改成 18080。",
      excerpt_truncated: false,
      excerpt_char_count: 15,
      sources: [
        {
          provider: "pi",
          source_instance: "session",
          session_id: "s-1",
          message_id: "e-1",
          parent_message_id: null,
          project_id: "p-1",
          timestamp: "2026-11-17T12:00:00.000Z",
          content_hash: "sha256:e1",
          locator: "/tmp/s.jsonl#e-1",
        },
      ],
      source_count: 1,
      sources_truncated: false,
      branch_ref: "root",
      producer: "detector",
      created_at: "2026-11-17T12:00:01.000Z",
    },
  ],
  pending_truncated: true,
};

describe("cli freshness rendering", () => {
  it("prints the stale state, mismatch, pending evidence and truncation", () => {
    const text = formatFreshnessLines(FRESHNESS).join("\n");
    expect(text).toContain("freshness: stale pending=2 head=r2 delivered=r1");
    expect(text).toContain("pending event-a observed r1 (detector): 默认端口已改为 18080");
    expect(text).toContain("excerpt: 我们决定把默认端口改成 18080。");
    expect(text).toContain("sources: /tmp/s.jsonl#e-1");
    expect(text).toContain("… 1 more pending event(s)");
  });

  it("prints nothing for a fresh result", () => {
    expect(formatFreshnessLines(undefined)).toEqual([]);
  });

  it("warns on a stale navigation card and stays silent when fresh", () => {
    expect(staleCardLine({ is_stale: true, head_revision: 2, pending_count: 3, freshness_sig: "x" })).toContain(
      "pending 3",
    );
    expect(staleCardLine({ is_stale: false, head_revision: 2, pending_count: 0, freshness_sig: "" })).toBeNull();
    expect(staleCardLine(undefined)).toBeNull();
  });
});
