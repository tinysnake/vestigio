/**
 * The rendered `messages` template decides between two paging shapes. These
 * cases pin that decision and the window it builds, because the difference is
 * 46 s against 0 ms on a large index and the adapter requires the anchor to be
 * the first row either way.
 */

import { describe, expect, it } from "vitest";
import { renderScript } from "../../src/scripts.js";

type Call = Record<string, unknown>;

async function run(script: string, messages: (input: Call) => unknown): Promise<Record<string, unknown>> {
  const fn = new Function("messages", `return (async () => {${script}})();`) as (
    messages: (input: Call) => unknown,
  ) => Promise<Record<string, unknown>>;
  return await fn(messages);
}

const anchorRow = {
  uuid: "m-1",
  session_id: "s-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  role: "user",
  text: "where is the port configured",
};

describe("messages query template", () => {
  it("pages a forward-only timeline window with a cursor, anchor first", async () => {
    const calls: Call[] = [];
    const page = await run(
      renderScript("messages", {
        anchor: "m-1",
        relation: "timeline",
        before_count: 0,
        after_count: 2,
        include_inactive: false,
      }),
      (input) => {
        calls.push(input);
        if (input["uuid"] !== undefined) {
          return { anchor: anchorRow, messages: [anchorRow], session: { id: "s-1" }, hasMore: false, nextCursor: null };
        }
        return {
          anchor: null,
          messages: [{ uuid: "m-2", timestamp: "2026-01-01T00:00:01.000Z", role: "assistant", text: "in the env file" }],
          session: { id: "s-1" },
          hasMore: true,
          nextCursor: { timestamp: "2026-01-01T00:00:01.000Z", uuid: "m-2" },
        };
      },
    );

    expect(calls[0]).toEqual({ uuid: "m-1", includeInactive: false, includeSession: true });
    expect(calls[1]).toMatchObject({
      sessionId: "s-1",
      cursor: { timestamp: anchorRow.timestamp, uuid: "m-1" },
      limit: 2,
      includeInactive: false,
    });
    expect(page["found"]).toBe(true);
    expect(page["messages"]).toHaveLength(2);
    expect((page["messages"] as { uuid: string }[])[0]?.uuid).toBe("m-1");
    expect(page["has_more"]).toBe(true);
    expect(page["session"]).toEqual({ id: "s-1" });
  });

  it("keeps the causal-parent window on the around form", async () => {
    const calls: Call[] = [];
    const page = await run(
      renderScript("messages", {
        anchor: "m-2",
        relation: "parents",
        before_count: 2,
        after_count: 0,
        include_inactive: false,
      }),
      (input) => {
        calls.push(input);
        return {
          anchor: anchorRow,
          messages: [{ uuid: "m-1" }, anchorRow],
          session: { id: "s-1" },
          hasMore: false,
          nextCursor: null,
        };
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ around: "m-2", relation: "parents", beforeCount: 2, afterCount: 0 });
    expect(page["messages"]).toHaveLength(2);
  });

  it("reports a missing anchor instead of an empty window", async () => {
    const page = await run(
      renderScript("messages", {
        anchor: "gone",
        relation: "timeline",
        before_count: 0,
        after_count: 2,
        include_inactive: false,
      }),
      () => null,
    );

    expect(page["found"]).toBe(false);
  });
});
