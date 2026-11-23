/**
 * Stateless MCP adapter (protocol 2026-07-28) over stdio.
 *
 * MCP 2026-07-28 removed the `initialize` handshake: every request carries its
 * protocol version and client capabilities in `_meta`, and a server must treat
 * each request independently. This adapter therefore holds no per-connection
 * state but the process's default store path. It marks a result delivered only
 * after the JSON-RPC response that carries it was accepted by stdout.
 *
 * Capability surface (see packages/cli/COMPAT.md): tools are supported; this
 * adapter advertises no resources, prompts, or server-initiated subscriptions,
 * so a client claims terminal results with `events_receive` instead of waiting
 * for a push. A bare `tools/list` never consumes a notification.
 */
import { randomUUID } from "node:crypto";
import type { Kind, SessionKey } from "@vestigio/client";
import { describeProjectIdentity, ProjectSettingsError } from "@vestigio/core/project";
import { DAEMON_KINDS, type DaemonClient, resolveSessionRef } from "./daemon.js";

export const MCP_PROTOCOL_VERSIONS = ["2026-07-28"] as const;
export const MCP_SERVER_INFO = { name: "vestigio", version: "0.0.0" } as const;
const TOOL_CACHE_TTL_MS = 3_600_000;

type JsonSchema = Record<string, unknown>;

export type McpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
};

const STORE_PROPERTY = {
  type: "string",
  description: "Memory store path. Defaults to the server's --db/--store or VESTIGIO_DB.",
};
const SESSION_IDENTITY = {
  sessionRef: { type: "integer", description: "Numeric session ref from a previous submit/get." },
  source: { type: "string", description: "Session source label; pair with sessionId." },
  sessionId: { type: "string", description: "Session id; pair with source." },
};

export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: "job_submit",
    title: "Submit a daemon job",
    description:
      "Accept a daemon job and return its jobId and sessionRef. The job keeps running after this call returns.",
    inputSchema: {
      type: "object",
      properties: {
        ...SESSION_IDENTITY,
        kind: { type: "string", enum: [...DAEMON_KINDS] },
        input: { description: "Job input, interpreted by the daemon handler for the kind." },
        requestId: { type: "string", description: "Idempotency key. Omit to generate one." },
        store: STORE_PROPERTY,
      },
      required: ["source", "sessionId", "kind", "input"],
      additionalProperties: false,
    },
  },
  {
    name: "job_get",
    title: "Read one daemon job",
    description: "Read a job's active state, full result, or compact summary_only record after delivery cleanup.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" }, store: STORE_PROPERTY },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "job_list",
    title: "List a session's daemon jobs",
    description: "Page the compact job records for one session, oldest first, using the cursor from the previous page.",
    inputSchema: {
      type: "object",
      properties: { ...SESSION_IDENTITY, after: { type: "string" }, store: STORE_PROPERTY },
      additionalProperties: false,
    },
  },
  {
    name: "job_cancel",
    title: "Cancel a daemon job",
    description: "Request cancellation. Committed effects are not undone; the job reaches a cancelled terminal state.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" }, store: STORE_PROPERTY },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "events_receive",
    title: "Claim pending job results",
    description:
      "Claim the session's undelivered terminal results in relay mode. The response carries the full results; the daemon marks them delivered only after this response is written, so a failed write leaves them for retry.",
    inputSchema: {
      type: "object",
      properties: { ...SESSION_IDENTITY, store: STORE_PROPERTY },
      additionalProperties: false,
    },
  },
  {
    name: "project_id",
    title: "Resolve a project id",
    description:
      "Resolve the canonical project id for a directory. Pass the printed id verbatim to any call that needs a project id; never construct one by hand. It resolves to the git repository root, so every worktree of one repository shares one id.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to resolve. Defaults to the server process's working directory.",
        },
      },
      additionalProperties: false,
    },
  },
];

class McpToolError extends Error {}

export type McpServerOptions = {
  clientFor(store: string): DaemonClient;
  /** Store used when a tool call does not carry its own `store`. */
  defaultStore?: string | undefined;
  /** Write one JSON-RPC line. Resolves only once the line was accepted. */
  write(text: string): Promise<void>;
  serverInfo?: { name: string; version: string };
};

export type McpServer = {
  handle(line: string): Promise<void>;
  tools(): readonly McpTool[];
};

export function createMcpServer(options: McpServerOptions): McpServer {
  const serverInfo = options.serverInfo ?? MCP_SERVER_INFO;

  async function sendResult(id: unknown, payload: Record<string, unknown>): Promise<void> {
    await options.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          resultType: "complete",
          _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
          ...payload,
        },
      })}\n`,
    );
  }

  async function sendError(id: unknown, code: number, message: string, data?: unknown): Promise<void> {
    const error = data === undefined ? { code, message } : { code, message, data };
    await options.write(`${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error })}\n`);
  }

  async function callTool(id: unknown, params: unknown): Promise<void> {
    const request = asRecord(params ?? {});
    const name = stringArg(request, "name", true);
    const args = asRecord(request["arguments"] ?? {});
    if (!MCP_TOOLS.some((tool) => tool.name === name)) {
      await sendError(id, -32602, `Unknown tool: ${String(name)}`);
      return;
    }
    let outcome: ToolOutcome;
    try {
      outcome = await runTool(name!, args);
    } catch (error) {
      if (error instanceof McpToolError) {
        await sendResult(id, { content: [{ type: "text", text: error.message }], isError: true });
        return;
      }
      throw error;
    }
    await sendResult(id, { content: [{ type: "text", text: outcome.text }], isError: false });
    if (outcome.afterWrite !== undefined) {
      try {
        await outcome.afterWrite();
      } catch (error) {
        // The response already went out; the notification stays pending and a
        // later events_receive retries it. Never write this to stdout.
        process.stderr.write(`vestigio mcp: could not mark results delivered: ${String(error)}\n`);
      }
    }
  }

  async function handle(line: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      await sendError(null, -32700, "Parse error");
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      await sendError(null, -32600, "Invalid request");
      return;
    }
    const request = message as Record<string, unknown>;
    const method = request["method"];
    const id = request["id"];
    if (typeof method !== "string") {
      await sendError(id, -32600, "Invalid request");
      return;
    }
    // Notifications carry no id and get no response; MCP 2026-07-28 removed
    // ping and logging/setLevel, so the only ones seen are cancellations.
    if (id === undefined || id === null) return;
    const requested = readMeta(request["params"])?.["io.modelcontextprotocol/protocolVersion"];
    if (typeof requested === "string" && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
      await sendError(id, -32022, "Unsupported protocol version", {
        supported: [...MCP_PROTOCOL_VERSIONS],
        requested,
      });
      return;
    }
    try {
      switch (method) {
        case "server/discover":
          await sendResult(id, {
            supportedVersions: [...MCP_PROTOCOL_VERSIONS],
            capabilities: { tools: {} },
            instructions:
              "vestigio daemon jobs: submit work, read or list jobs, cancel, and claim terminal results with events_receive. Results are marked delivered only after the claim response is written, so an interrupted caller can retry. Use project_id to resolve the canonical project id for a directory; pass the printed id verbatim to any call that needs one and never construct one by hand.",
            ttlMs: TOOL_CACHE_TTL_MS,
            cacheScope: "public",
          });
          return;
        case "tools/list":
          await sendResult(id, { tools: MCP_TOOLS, ttlMs: TOOL_CACHE_TTL_MS, cacheScope: "public" });
          return;
        case "tools/call":
          await callTool(id, request["params"]);
          return;
        default:
          await sendError(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      await sendError(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  async function runTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    if (name === "project_id") {
      const path = stringArg(args, "path", false) ?? process.cwd();
      try {
        return { text: JSON.stringify(describeProjectIdentity(path), null, 2) };
      } catch (error) {
        if (error instanceof ProjectSettingsError) throw new McpToolError(error.message);
        throw error;
      }
    }
    const store = stringArg(args, "store", false) ?? options.defaultStore;
    if (store === undefined) {
      throw new McpToolError(
        "No store path. Pass `store`, or launch the adapter with --db <path> or VESTIGIO_DB.",
      );
    }
    const client = options.clientFor(store);
    switch (name) {
      case "job_submit": {
        const kindRaw = stringArg(args, "kind", true);
        const kind: Kind | undefined = DAEMON_KINDS.find((candidate) => candidate === kindRaw);
        if (kind === undefined) throw new McpToolError(`kind must be one of ${DAEMON_KINDS.join(", ")}`);
        if (!("input" in args)) throw new McpToolError("input is required");
        const session: SessionKey = {
          source: stringArg(args, "source", true)!,
          sessionId: stringArg(args, "sessionId", true)!,
        };
        const requestId = stringArg(args, "requestId", false) ?? randomUUID();
        const accepted = await client.submit({ session, requestId, kind, input: args["input"] });
        return { text: JSON.stringify({ ...accepted, requestId }, null, 2) };
      }
      case "job_get": {
        const jobId = stringArg(args, "jobId", true)!;
        return { text: JSON.stringify(await client.get(jobId), null, 2) };
      }
      case "job_list": {
        const sessionRef = await sessionRefFor(client, args);
        const page = await client.list(sessionRef, stringArg(args, "after", false));
        return { text: JSON.stringify({ sessionRef, ...readPage(page) }, null, 2) };
      }
      case "job_cancel": {
        const jobId = stringArg(args, "jobId", true)!;
        const cancelled = await client.cancel(jobId);
        return { text: JSON.stringify({ jobId, ...cancelled }, null, 2) };
      }
      case "events_receive": {
        const sessionRef = await sessionRefFor(client, args);
        const events = await client.receive(sessionRef, true);
        return {
          text: JSON.stringify({ sessionRef, events }, null, 2),
          afterWrite: async () => {
            await client.relayed(sessionRef, events.map((event) => event.eventId));
          },
        };
      }
      default:
        throw new McpToolError(`Unknown tool: ${name}`);
    }
  }

  return {
    handle,
    tools: () => MCP_TOOLS,
  };
}

type ToolOutcome = {
  text: string;
  /** Runs only after the response carrying `text` was accepted by the transport. */
  afterWrite?: () => Promise<void>;
};

function readPage(value: unknown): { jobs: unknown[]; nextCursor: string | null } {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const jobs = Array.isArray(record["jobs"]) ? record["jobs"] : [];
  return { jobs, nextCursor: typeof record["nextCursor"] === "string" ? record["nextCursor"] : null };
}

async function sessionRefFor(client: DaemonClient, args: Record<string, unknown>): Promise<number> {
  const raw = args["sessionRef"];
  const source = stringArg(args, "source", false);
  const sessionId = stringArg(args, "sessionId", false);
  if (raw !== undefined && (source !== undefined || sessionId !== undefined)) {
    throw new McpToolError("sessionRef and source/sessionId are mutually exclusive");
  }
  if (raw !== undefined) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
      throw new McpToolError("sessionRef must be a positive integer");
    }
    return raw;
  }
  if (source === undefined || sessionId === undefined) {
    throw new McpToolError("sessionRef, or both source and sessionId, are required");
  }
  return resolveSessionRef(client, { kind: "key", session: { source, sessionId } });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpToolError("expected an object");
  }
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, name: string, required: boolean): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new McpToolError(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) throw new McpToolError(`${name} must be a non-empty string`);
  return value;
}

function readMeta(params: unknown): Record<string, unknown> | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  const meta = (params as Record<string, unknown>)["_meta"];
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  return meta as Record<string, unknown>;
}

/** One line per message, newline-delimited, per the stdio transport. */
export function stdoutWriter(): (text: string) => Promise<void> {
  return (text) =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        process.stdout.off("error", onError);
        error ? reject(error) : resolve();
      };
      const onError = (error: Error): void => done(error);
      process.stdout.once("error", onError);
      process.stdout.write(text, (error: Error | null | undefined) => done(error ?? null));
    });
}

/** Read newline-delimited messages until the input stream ends. */
export async function serveStdio(server: McpServer, input: AsyncIterable<string | Buffer>): Promise<void> {
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/u, "");
      buffer = buffer.slice(index + 1);
      if (line.trim() !== "") await server.handle(line);
    }
  }
  if (buffer.trim() !== "") await server.handle(buffer);
}
