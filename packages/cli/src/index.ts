/**
 * `vestigio` — the maintenance and inspection CLI.
 *
 * It exists for two reasons: a human needs to run a layered search and read one
 * memory without writing TypeScript, and the layered path needs a real wiring
 * proof with a real history source. It is the only place that puts
 * `@vestigio/source-obelisk` behind core's `HistoryPort`.
 *
 * Exit codes: 0 success, 1 unexpected failure, 2 usage error. A history layer
 * that reports `unavailable` or `failed` is still exit 0: that state is part of
 * the answer (it is what the caller is supposed to see and report), not a
 * failure of the command.
 */

import { isAbsolute, normalize, sep } from "node:path";
import type { MemoryUri, Scope } from "@vestigio/core";
import { layeredSearch, readMemoryResult, type HistoryPort } from "@vestigio/core/retrieval";
import { openStore, type MemoryStore } from "@vestigio/core/storage";
import { formatReadHuman, formatSearchHuman } from "./format.js";
import { createObeliskHistoryPort, obeliskIndexPath, type ObeliskHistoryOptions } from "./obelisk-history.js";

export const USAGE = `vestigio — layered memory inspection

Usage:
  vestigio search --db <path> (--project <abs path> | --global) --query <text> [options]
  vestigio read   --db <path> --uri <memory://store/id> [--revision <n>] [--json]
  vestigio probe  --db <path> --obelisk-home <dir> [--json]
  vestigio --help

Search options:
  --limit <1..10>                Cards to return (default 5).
  --offset <n>                   Page the Active ranking (default 0).
  --archived                     Widen to Archived even when Active matched.
  --history                      Widen to the raw history source.
  --history-read                 Also read one bounded causal chain (implies --history).
  --history-limit <1..10>        History hits to ask for (default 3).
  --history-excerpt-chars <n>    Per-excerpt code-point cap (default 400, min 32).
  --max-history-bytes <n>        Byte ceiling on the history payload (default 8192).
  --obelisk-home <dir>           Obelisk data directory. Required with --history,
                                 --history-read or probe.
  --obelisk-cli <path>           Pinned CLI entry to run instead of the dependency.
  --source-instance <id>         SourceRef instance label (default "local").
  --json                         Print machine-readable JSON.

--project must be a normalised absolute path: it is used verbatim as the store
scope and as Obelisk's project_path, so a typo is a different project, not a
convenience.`;

export type CliIo = {
  out(text: string): void;
  err(text: string): void;
};

export type CliDeps = {
  open?: (options: { path: string }) => MemoryStore;
  createHistoryPort?: (options: ObeliskHistoryOptions) => HistoryPort;
};

const DEFAULT_IO: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const VALUE_FLAGS = new Set([
  "db",
  "query",
  "project",
  "limit",
  "offset",
  "history-limit",
  "history-excerpt-chars",
  "max-history-bytes",
  "obelisk-home",
  "obelisk-cli",
  "source-instance",
  "uri",
  "revision",
]);

const BOOLEAN_FLAGS = new Set(["global", "archived", "history", "history-read", "json", "help"]);

type ParsedArgs = {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      const name = equals === -1 ? body : body.slice(0, equals);
      if (BOOLEAN_FLAGS.has(name)) {
        if (equals !== -1) {
          throw new UsageError(`--${name} does not take a value`);
        }
        flags.set(name, true);
      } else if (VALUE_FLAGS.has(name)) {
        if (equals !== -1) {
          flags.set(name, body.slice(equals + 1));
        } else {
          const value = argv[index + 1];
          if (value === undefined || value.startsWith("--")) {
            throw new UsageError(`--${name} needs a value`);
          }
          flags.set(name, value);
          index += 1;
        }
      } else {
        throw new UsageError(`unknown option --${name}`);
      }
    } else if (token.startsWith("-") && token !== "-") {
      throw new UsageError(`unknown option ${token}`);
    } else {
      positionals.push(token);
    }
    index += 1;
  }
  const command = positionals[0] ?? "help";
  return { command, positionals: positionals.slice(1), flags };
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function requireFlag(parsed: ParsedArgs, name: string): string {
  const value = stringFlag(parsed, name);
  if (value === undefined || value.length === 0) {
    throw new UsageError(`--${name} is required`);
  }
  return value;
}

function integerFlag(parsed: ParsedArgs, name: string, min: number, max: number): number | undefined {
  const raw = stringFlag(parsed, name);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new UsageError(`--${name} must be an integer from ${min} to ${max}`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new UsageError(`--${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function requireScope(parsed: ParsedArgs): Scope {
  const project = stringFlag(parsed, "project");
  const global = parsed.flags.get("global") === true;
  if (project !== undefined && global) {
    throw new UsageError("--project and --global are mutually exclusive");
  }
  if (project !== undefined) {
    if (!isAbsolute(project)) {
      throw new UsageError(`--project must be an absolute path (got ${JSON.stringify(project)})`);
    }
    if (project.includes("\0")) {
      throw new UsageError("--project must not contain a NUL byte");
    }
    if (normalize(project) !== project) {
      throw new UsageError(
        `--project must be a normalised path: ${JSON.stringify(project)} normalises to ${JSON.stringify(normalize(project))}`,
      );
    }
    if (project.length > 1 && project.endsWith(sep)) {
      throw new UsageError("--project must not end with a path separator");
    }
    return { kind: "project", project_id: project };
  }
  if (global) {
    return { kind: "global" };
  }
  throw new UsageError("--project <absolute path> or --global is required");
}

function noExtraPositionals(parsed: ParsedArgs, command: string): void {
  if (parsed.positionals.length > 0) {
    throw new UsageError(`${command} takes no positional arguments (got ${parsed.positionals.join(" ")})`);
  }
}

function emit(io: CliIo, parsed: ParsedArgs, payload: unknown, human: string): void {
  if (parsed.flags.get("json") === true) {
    io.out(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    io.out(human);
  }
}

type CommandContext = {
  io: CliIo;
  parsed: ParsedArgs;
  deps: CliDeps;
};

function openDatabase(context: CommandContext): MemoryStore {
  const dbPath = requireFlag(context.parsed, "db");
  const open = context.deps.open ?? openStore;
  return open({ path: dbPath });
}

function obeliskOptions(context: CommandContext): ObeliskHistoryOptions {
  const home = stringFlag(context.parsed, "obelisk-home");
  if (home === undefined) {
    throw new UsageError(
      "--obelisk-home <dir> is required by --history, --history-read and probe: it is the data " +
        "directory holding the Obelisk index that will be read. There is no default, because " +
        "reading it can refresh a derived index inside it, and a test or script must not be able " +
        "to reach the real one by omission.",
    );
  }
  const cliPath = stringFlag(context.parsed, "obelisk-cli");
  const sourceInstance = stringFlag(context.parsed, "source-instance");
  return {
    home,
    cli_path: cliPath,
    source_instance: sourceInstance,
  };
}

function historyIndexPath(home: string): string {
  return obeliskIndexPath(home);
}

async function runSearch(context: CommandContext): Promise<number> {
  noExtraPositionals(context.parsed, "search");
  const dbPath = requireFlag(context.parsed, "db");
  const query = requireFlag(context.parsed, "query");
  const scope = requireScope(context.parsed);
  const wantsHistory =
    context.parsed.flags.get("history") === true || context.parsed.flags.get("history-read") === true;
  const obelisk = wantsHistory ? obeliskOptions(context) : null;
  const open = context.deps.open ?? openStore;
  const store = open({ path: dbPath });
  try {
    const history = obelisk === null
      ? undefined
      : (context.deps.createHistoryPort ?? createObeliskHistoryPort)(obelisk);
    const outcome = await layeredSearch({
      store,
      query,
      scope,
      limit: integerFlag(context.parsed, "limit", 1, 10),
      offset: integerFlag(context.parsed, "offset", 0, 1_000_000),
      include_archived: context.parsed.flags.get("archived") === true,
      include_history: wantsHistory,
      include_history_read: context.parsed.flags.get("history-read") === true,
      history,
      history_limit: integerFlag(context.parsed, "history-limit", 1, 10),
      history_excerpt_chars: integerFlag(context.parsed, "history-excerpt-chars", 32, 4000),
      max_history_bytes: integerFlag(context.parsed, "max-history-bytes", 256, 1024 * 1024),
    });
    emit(
      context.io,
      context.parsed,
      outcome,
      formatSearchHuman(outcome, {
        history_index: obelisk === null ? null : historyIndexPath(obelisk.home),
      }),
    );
    return 0;
  } finally {
    store.close();
  }
}

function runRead(context: CommandContext): number {
  noExtraPositionals(context.parsed, "read");
  const uri = requireFlag(context.parsed, "uri");
  const revision = integerFlag(context.parsed, "revision", 1, Number.MAX_SAFE_INTEGER);
  const store = openDatabase(context);
  try {
    const outcome = readMemoryResult({
      store,
      uri: uri as MemoryUri,
      ...(revision === undefined ? {} : { revision }),
    });
    emit(context.io, context.parsed, outcome, formatReadHuman(outcome));
    return 0;
  } finally {
    store.close();
  }
}

async function runProbe(context: CommandContext): Promise<number> {
  noExtraPositionals(context.parsed, "probe");
  const store = openDatabase(context);
  try {
    const report = store.integrityCheck();
    const obelisk = obeliskOptions(context);
    const port = (context.deps.createHistoryPort ?? createObeliskHistoryPort)(obelisk);
    const availability = await port.probe();
    const payload = {
      store: {
        path: store.path,
        store_id: store.storeId,
        integrity_ok: report.ok,
        problems: report.problems,
        heads: report.headCount,
        active_index_rows: report.activeIndexCount,
        archived_index_rows: report.archivedIndexCount,
      },
      history: {
        home: obelisk.home,
        index: historyIndexPath(obelisk.home),
        available: availability.available,
        reason: availability.reason,
      },
    };
    const human =
      `store: ${payload.store.path} (${payload.store.store_id})\n` +
      `store integrity: ${report.ok ? "ok" : "PROBLEMS"} heads=${report.headCount} ` +
      `active=${report.activeIndexCount} archived=${report.archivedIndexCount}\n` +
      (report.problems.length > 0 ? `problems: ${report.problems.join(", ")}\n` : "") +
      `history: ${availability.available ? "available" : "unavailable"}` +
      `${availability.reason === null ? "" : ` (${availability.reason})`}\n` +
      `history_index: ${payload.history.index}\n`;
    emit(context.io, context.parsed, payload, human);
    return 0;
  } finally {
    store.close();
  }
}

export async function main(
  argv: readonly string[],
  io: CliIo = DEFAULT_IO,
  deps: CliDeps = {},
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }
  if (parsed.command === "help" || parsed.flags.get("help") === true) {
    io.out(`${USAGE}\n`);
    return 0;
  }

  const context: CommandContext = { io, parsed, deps };
  try {
    switch (parsed.command) {
      case "search":
        return await runSearch(context);
      case "read":
        return runRead(context);
      case "probe":
        return await runProbe(context);
      default:
        throw new UsageError(`unknown command ${JSON.stringify(parsed.command)}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    io.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
