import { VestigioClient } from "@vestigio/client";
import { applyConfigToEnv } from "@vestigio/config";
import { createMcpServer, serveStdio, stdoutWriter } from "./mcp.js";

/**
 * MCP stdio entry point. The store path is server-wide config; a tool call may
 * override it with its own `store` argument. Nothing here reads stdin while a
 * request is in flight, and nothing is remembered between requests.
 */
applyConfigToEnv();

function option(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

const store =
	option("--db") ?? option("--store") ?? process.env["VESTIGIO_DB"] ?? process.env["VESTIGIO_STORE"];

const server = createMcpServer({
  clientFor: (path) => new VestigioClient(path),
  defaultStore: store,
  write: stdoutWriter(),
});

await serveStdio(server, process.stdin);
