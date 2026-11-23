/**
 * The MCP adapter must behave as MCP 2026-07-28 requires: stateless, version
 * checked per request, and never marking a result delivered before the response
 * that carried it was written.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Submission } from "@vestigio/client";
import { createMcpServer, MCP_PROTOCOL_VERSIONS, MCP_TOOLS } from "../src/mcp.js";
import type { DaemonClient } from "../src/daemon.js";
import { fakeDaemonClient, fakeEvent } from "./fake-client.js";

type Harness = {
  server: ReturnType<typeof createMcpServer>;
  client: DaemonClient & { calls: string[] };
  lines: string[];
  call(method: string, params?: unknown, id?: unknown): Promise<void>;
  last(): Record<string, unknown>;
  lastResult(): Record<string, unknown>;
  lastError(): Record<string, unknown>;
  tool(name: string, args: Record<string, unknown>): Promise<void>;
};

function harness(client = fakeDaemonClient(), defaultStore: string | null = "/tmp/store.db"): Harness {
  const lines: string[] = [];
  const server = createMcpServer({
    clientFor: () => client,
    ...(defaultStore === null ? {} : { defaultStore }),
    write: async (text) => {
      lines.push(text);
    },
  });
  const call = (method: string, params: unknown = {}, id: unknown = 1): Promise<void> =>
    server.handle(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const last = () => JSON.parse(lines[lines.length - 1]!.trim()) as Record<string, unknown>;
  const lastResult = () => last()["result"] as Record<string, unknown>;
  const lastError = () => last()["error"] as Record<string, unknown>;
  return {
    server,
    client,
    lines,
    call,
    last,
    lastResult,
    lastError,
    tool: (name, args) => call("tools/call", { name, arguments: args }),
  };
}

function meta(): Record<string, unknown> {
  return {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSIONS[0],
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
}

function textOf(message: Record<string, unknown>): unknown {
  const result = message["result"] as { content: { type: string; text: string }[] };
  return JSON.parse(result.content[0]!.text) as unknown;
}

describe("server/discover", () => {
  it("advertises the version, tool capability and cache hints", async () => {
    const h = harness();
    await h.call("server/discover", meta());
    const result = h.lastResult();
    expect(result["resultType"]).toBe("complete");
    expect(result["supportedVersions"]).toEqual(["2026-07-28"]);
    expect(result["capabilities"]).toEqual({ tools: {} });
    expect(result["ttlMs"]).toBe(3_600_000);
    expect(result["cacheScope"]).toBe("public");
    expect((result["_meta"] as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "vestigio",
      version: "0.0.0",
    });
    // Discovery alone must not touch the daemon.
    expect(h.client.calls).toHaveLength(0);
  });

  it("rejects a version it does not serve with -32022", async () => {
    const h = harness();
    await h.call("server/discover", {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2025-06-18" },
    });
    expect(h.lastError()).toEqual({
      code: -32022,
      message: "Unsupported protocol version",
      data: { supported: ["2026-07-28"], requested: "2025-06-18" },
    });
  });
});

describe("tools/list", () => {
  it("returns the daemon tools and the local project_id, consuming nothing", async () => {
    const h = harness();
    await h.call("tools/list", meta());
    const result = h.lastResult();
    expect((result["tools"] as { name: string }[]).map((tool) => tool.name)).toEqual([
      "job_submit",
      "job_get",
      "job_list",
      "job_cancel",
      "events_receive",
      "project_id",
    ]);
    expect(result["ttlMs"]).toBe(3_600_000);
    expect(result["cacheScope"]).toBe("public");
    expect(h.client.calls).toHaveLength(0);
  });

  it("declares the same names as the exported table", () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toHaveLength(6);
  });
});

describe("project_id", () => {
  it("resolves a directory with no store and no daemon call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vestigio-mcp-project-"));
    const h = harness(fakeDaemonClient(), null);
    await h.tool("project_id", { path: dir });
    expect(textOf(h.last())).toEqual({ path: dir, project_id: dir, repository_root: null });
    expect(h.client.calls).toHaveLength(0);
  });

  it("defaults to the server process's working directory", async () => {
    const h = harness(fakeDaemonClient(), null);
    await h.tool("project_id", {});
    expect((textOf(h.last()) as { path: string }).path).toBe(process.cwd());
    expect(h.client.calls).toHaveLength(0);
  });
});

describe("tools/call", () => {
  it("submits with the invoker's session identity", async () => {
    const submissions: Submission[] = [];
    const h = harness(
      fakeDaemonClient({
        async submit(input) {
          submissions.push(input);
          return { jobId: "job-1", sessionRef: 7 };
        },
      }),
    );
    await h.tool("job_submit", {
      source: "pi",
      sessionId: "s-1",
      kind: "search",
      input: { q: "x" },
      requestId: "req-1",
      store: "/tmp/other.db",
    });
    expect(textOf(h.last())).toEqual({ jobId: "job-1", sessionRef: 7, requestId: "req-1" });
    expect(submissions[0]?.session).toEqual({ source: "pi", sessionId: "s-1" });
    expect(submissions[0]?.kind).toBe("search");
  });

  it("generates a request id when none is given", async () => {
    const h = harness();
    await h.tool("job_submit", { source: "pi", sessionId: "s-1", kind: "detector", input: {} });
    expect((textOf(h.last()) as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("resolves a session key before listing", async () => {
    const h = harness();
    await h.tool("job_list", { source: "cli", sessionId: "s-2" });
    expect(h.client.calls).toContain("session:cli/s-2");
    expect(h.client.calls).toContain("list:7:");
  });

  it("lists by sessionRef without a lookup", async () => {
    const h = harness();
    await h.tool("job_list", { sessionRef: 7 });
    expect(h.client.calls).toContain("list:7:");
    expect(h.client.calls.filter((entry) => entry.startsWith("session:"))).toHaveLength(0);
  });

  it("reads and cancels a job", async () => {
    const h = harness();
    await h.tool("job_get", { jobId: "job-1" });
    expect((textOf(h.last()) as { jobId: string }).jobId).toBe("job-1");
    await h.tool("job_cancel", { jobId: "job-1" });
    expect(textOf(h.last())).toEqual({ jobId: "job-1", cancelled: true });
  });

  it("reports a tool-level failure as isError without a JSON-RPC error", async () => {
    const h = harness();
    await h.tool("job_submit", { source: "pi", sessionId: "s-1", kind: "nope", input: {} });
    const message = h.last();
    expect(message["error"]).toBeUndefined();
    const result = message["result"] as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("kind must be one of");
  });

  it("rejects an unknown tool name with -32602", async () => {
    const h = harness();
    await h.tool("jobs_run", {});
    expect((h.lastError() as { code: number }).code).toBe(-32602);
  });

  it("requires a store when the server has no default", async () => {
    const h = harness(fakeDaemonClient(), null);
    await h.tool("job_get", { jobId: "job-1" });
    const result = h.last()["result"] as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("VESTIGIO_DB");
  });

  it("rejects mixing sessionRef with a key", async () => {
    const h = harness();
    await h.tool("job_list", { sessionRef: 7, source: "pi", sessionId: "s-1" });
    const result = h.last()["result"] as { isError: boolean; content: { text: string }[] };
    expect(result.content[0]?.text).toContain("mutually exclusive");
  });
});

describe("events_receive", () => {
  it("claims in relay mode and marks delivered only after the response is written", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const server = createMcpServer({
      clientFor: () =>
        fakeDaemonClient({
          async receive(_ref, relay) {
            order.push(`receive:${relay === true ? "relay" : "consume"}`);
            return [fakeEvent()];
          },
          async relayed(_ref, eventIds) {
            order.push(`relayed:${eventIds.join(",")}`);
          },
        }),
      defaultStore: "/tmp/store.db",
      write: async (text) => {
        order.push("write");
        lines.push(text);
      },
    });
    await server.handle(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "events_receive", arguments: { sessionRef: 7 }, ...meta() },
      }),
    );
    expect(order).toEqual(["receive:relay", "write", "relayed:ev-1"]);
    const payload = JSON.parse(
      (JSON.parse(lines[0]!.trim()) as { result: { content: { text: string }[] } }).result.content[0]!.text,
    ) as { sessionRef: number; events: unknown[] };
    expect(payload.sessionRef).toBe(7);
    expect(payload.events).toHaveLength(1);
  });

  it("keeps results pending when the client disconnects mid-response", async () => {
    const relayed: string[] = [];
    const server = createMcpServer({
      clientFor: () =>
        fakeDaemonClient({
          async receive() {
            return [fakeEvent()];
          },
          async relayed(_ref, eventIds) {
            relayed.push(...eventIds);
          },
        }),
      defaultStore: "/tmp/store.db",
      write: async () => {
        throw new Error("EPIPE");
      },
    });
    await expect(
      server.handle(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "events_receive", arguments: { sessionRef: 7 }, ...meta() },
        }),
      ),
    ).rejects.toThrow("EPIPE");
    expect(relayed).toEqual([]);
  });

  it("returns an empty claim rather than erroring", async () => {
    const h = harness();
    await h.tool("events_receive", { sessionRef: 7 });
    expect(textOf(h.last())).toEqual({ sessionRef: 7, events: [] });
  });
});

describe("protocol edge cases", () => {
  it("answers a malformed line with -32700 and no id", async () => {
    const h = harness();
    await h.server.handle("{ not json");
    expect(h.last()["id"]).toBeNull();
    expect((h.lastError() as { code: number }).code).toBe(-32700);
  });

  it("answers an unknown method with -32601", async () => {
    const h = harness();
    await h.call("resources/list", meta());
    expect((h.lastError() as { code: number }).code).toBe(-32601);
  });

  it("never answers a notification", async () => {
    const h = harness();
    await h.server.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }));
    expect(h.lines).toHaveLength(0);
  });
});
