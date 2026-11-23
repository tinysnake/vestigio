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

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, normalize, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { MemoryUri, Scope } from "@vestigio/core";
import { layeredSearch, readMemoryResult, type HistoryPort } from "@vestigio/core/retrieval";
import type { ModelPort, ModelThinking, ResolveOutcome } from "@vestigio/core/resolver";
import { resolveMemory } from "@vestigio/core/resolver";
import { openStore, type MemoryStore } from "@vestigio/core/storage";
import { resolveProjectId, withProjectAliases } from "@vestigio/core/project";
import { createAgentModelPort, type OpenAiCompatibleOptions } from "@vestigio/model-client";
import { agentModelSettings } from "@vestigio/config";
import { formatFreshnessLines, formatReadHuman, formatSearchHuman, staleCardLine } from "./format.js";
import { createObeliskHistoryPort, obeliskIndexPath, type ObeliskHistoryOptions } from "@vestigio/source-obelisk";
import { VestigioClient } from "@vestigio/client";
import {
  DAEMON_KINDS,
  formatEventHuman,
  formatEventsHuman,
  formatJobHuman,
  formatJobListHuman,
  readJobPage,
  resolveSessionRef,
  type DaemonClient,
  type SessionKey,
  type SessionTarget,
} from "./daemon.js";

/** The plan's one configured backend; never upgraded automatically. */
export const DEFAULT_RESOLVE_MODEL_ID = "auto/deepseek-v4.1-flash";

export const USAGE = `vestigio — layered memory inspection

Usage:
  vestigio search [--db <path>] (--project <abs path> | --global) --query <text> [options]
  vestigio read   [--db <path>] --uri <memory://store/id> [--revision <n>] [--json]
  vestigio probe  [--db <path>] --obelisk-home <dir> [--json]
  vestigio resolve [--db <path>] (--project <abs path> | --global) --question <text> [options]
  vestigio jobs run [--db <path>] [--limit <1..20>] [options]
  vestigio stop   [--db <path>]
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

Resolve options:
  --model-base-url <url>   OpenAI-compatible base URL (default: VESTIGIO_MODEL_BASE_URL).
                           Without one, resolve degrades to the zero-LLM layered search.
  --model-id <id>               Model id (default auto/deepseek-v4.1-flash).
  --model-api-key <key>         Bearer key (default: VESTIGIO_MODEL_API_KEY).
  --model-thinking <level>      off|low|medium|high (default low).
  --cost-input <usd-per-1m>     Input price used to report cost; omit for null.
  --cost-output <usd-per-1m>    Output price used to report cost; omit for null.
  --obelisk-home <dir>          Optional raw history layer for the descent.

Jobs options:
  --limit <1..20>          Jobs to attempt in this batch (default 3).
  Model configuration comes from VESTIGIO_MODEL_* when the daemon starts.

Daemon jobs (compatibility adapters; the daemon owns scheduling and delivery):
  vestigio submit  --db <path> --source <s> --session-id <id>
                   --kind <maintenance|detector|search>
                   (--input <json> | --input-file <path>) [--request-id <id>] [--json]
  vestigio get     --db <path> --job <jobId> [--json]
  vestigio list    --db <path> (--session-ref <n> | --source <s> --session-id <id>)
                   [--after <cursor>] [--json]
  vestigio cancel  --db <path> --job <jobId> [--json]
  vestigio receive --db <path> (--session-ref <n> | --source <s> --session-id <id>) [--json]
  vestigio watch   --db <path> (--session-ref <n> | --source <s> --session-id <id>)
                   [--interval <ms>] [--count <n>] [--json]
  vestigio stop    --db <path> [--json]

  --source is the caller's own label for its session; nothing pins it to "cli".
  submit exits after the daemon accepts the job; the job keeps running without
  this process. receive/watch bind to this process lifetime and claim terminal
  results in relay mode: the result is marked delivered only after stdout
  accepts the full payload, so a failed write leaves it pending for a retry.
  --session-ref is the numeric ref from a previous submit/get; --source and
  --session-id reopen the same session by its stable identity instead.

--project must be a normalised absolute path: its git repository root (falling
back to the path itself outside a repository) is the store scope, and the path
itself is used as Obelisk's project_path. When --db is omitted, VESTIGIO_DB or
VESTIGIO_STORE names the store; both are filled from ~/.vestigio/config.json.`;

export type CliIo = {
  out(text: string): void;
  err(text: string): void;
  /**
   * Deliver a daemon payload and resolve only once stdout accepted it. The
   * relay commands use it so a terminal result is marked delivered after the
   * write, never before. Injected IO without it falls back to `out`.
   */
  write?(text: string): Promise<void>;
};

export type CliDeps = {
  open?: (options: { path: string }) => MemoryStore;
  createHistoryPort?: (options: ObeliskHistoryOptions) => HistoryPort;
  createModel?: (options: OpenAiCompatibleOptions) => ModelPort;
  createClient?: (storePath: string) => DaemonClient;
};

const DEFAULT_IO: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  write: (text) =>
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
    }),
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
  "question",
  "model-base-url",
  "model-id",
  "model-api-key",
  "model-thinking",
  "cost-input",
  "cost-output",
  "source",
  "session-id",
  "session-ref",
  "kind",
  "input",
  "input-file",
  "request-id",
  "job",
  "after",
  "interval",
  "count",
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

/** `--db` wins, then the variables the config file fills in. */
function databasePath(parsed: ParsedArgs): string {
  const flag = stringFlag(parsed, "db");
  if (flag !== undefined && flag.length > 0) return flag;
  const fallback = process.env["VESTIGIO_DB"] ?? process.env["VESTIGIO_STORE"];
  if (fallback !== undefined && fallback.trim().length > 0) return fallback.trim();
  throw new UsageError("--db is required unless VESTIGIO_DB or VESTIGIO_STORE names the store");
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

function numberFlag(parsed: ParsedArgs, name: string): number | undefined {
  const raw = stringFlag(parsed, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new UsageError(`--${name} must be a non-negative number`);
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
    return { kind: "project", project_id: resolveProjectId(project) };
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
  const dbPath = databasePath(context.parsed);
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
  const dbPath = databasePath(context.parsed);
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
      scope: withProjectAliases(scope, store.listProjectIds()),
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

/**
 * Stage two as a separate trigger: generate the short nav for jobs the resolve
 * path already persisted, publish, and admit. It never sees raw history and
 * never touches the medium body.
 */
async function runJobs(context: CommandContext): Promise<number> {
  const sub = context.parsed.positionals[0];
  if (sub !== "run" || context.parsed.positionals.length !== 1) {
    throw new UsageError("jobs needs exactly one subcommand: run");
  }
  const flags = ["model-base-url", "model-id", "model-api-key", "model-thinking", "cost-input", "cost-output"];
  if (flags.some((flag) => context.parsed.flags.has(flag))) {
    throw new UsageError("jobs run uses the daemon's VESTIGIO_MODEL_* configuration");
  }
  const client = daemonClient(context);
  const limit = integerFlag(context.parsed, "limit", 1, 20);
  const requestId = randomUUID();
  const { sessionRef } = await client.submit({
    session: { source: "vestigio-cli", sessionId: requestId },
    requestId,
    kind: "maintenance",
    input: { op: "nav.run", limit },
  });
  for (;;) {
    const [event] = await client.receive(sessionRef, true);
    if (!event) {
      await delay(100);
      continue;
    }
    if (event.state !== "succeeded") {
      const failure = event.result as { error?: string } | undefined;
      await deliver(context.io, `error: ${failure?.error ?? String(event.resultCode)}\n`);
      await client.relayed(sessionRef, [event.eventId]);
      return 1;
    }
    const { result } = event.result as { result: Record<string, unknown> };
    const output = context.parsed.flags.has("json") ? JSON.stringify(result, null, 2) :
      `claimed=${String(result.claimed ?? 0)} completed=${String(result.completed ?? 0)} ${String(result.reason ?? "")}`.trim();
    await deliver(context.io, `${output}\n`);
    await client.relayed(sessionRef, [event.eventId]);
    return 0;
  }
}

function daemonClient(context: CommandContext): DaemonClient {
  const storePath = databasePath(context.parsed);
  const create = context.deps.createClient ?? ((path: string) => new VestigioClient(path));
  return create(storePath);
}

function sessionKeyFor(parsed: ParsedArgs, command: string): SessionKey {
  const source = stringFlag(parsed, "source");
  const sessionId = stringFlag(parsed, "session-id");
  if (source === undefined || sessionId === undefined) {
    throw new UsageError(`${command} needs --source and --session-id`);
  }
  return { source, sessionId };
}

/** `--session-ref <n>` wins; `--source`/`--session-id` is the reopen-by-identity form. */
function sessionTargetFor(parsed: ParsedArgs, command: string): SessionTarget {
  const raw = stringFlag(parsed, "session-ref");
  const source = stringFlag(parsed, "source");
  const sessionId = stringFlag(parsed, "session-id");
  if (raw !== undefined && (source !== undefined || sessionId !== undefined)) {
    throw new UsageError(`${command} takes --session-ref or --source/--session-id, not both`);
  }
  if (raw !== undefined) {
    if (!/^\d+$/u.test(raw) || Number.parseInt(raw, 10) <= 0) {
      throw new UsageError("--session-ref must be a positive integer");
    }
    return { kind: "ref", sessionRef: Number.parseInt(raw, 10) };
  }
  if (source === undefined || sessionId === undefined) {
    throw new UsageError(`${command} needs --session-ref or both --source and --session-id`);
  }
  return { kind: "key", session: { source, sessionId } };
}

function readJobInput(parsed: ParsedArgs): unknown {
  const inline = stringFlag(parsed, "input");
  const file = stringFlag(parsed, "input-file");
  if (inline !== undefined && file !== undefined) {
    throw new UsageError("--input and --input-file are mutually exclusive");
  }
  let text: string;
  if (inline !== undefined) {
    text = inline;
  } else if (file !== undefined) {
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      throw new UsageError(`--input-file could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    throw new UsageError("--input <json> or --input-file <path> is required");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`job input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function deliver(io: CliIo, text: string): Promise<void> {
  if (io.write !== undefined) return io.write(text);
  io.out(text);
}

async function runSubmit(context: CommandContext): Promise<number> {
  noExtraPositionals(context.parsed, "submit");
  const kind = DAEMON_KINDS.find((candidate) => candidate === requireFlag(context.parsed, "kind"));
  if (kind === undefined) throw new UsageError(`--kind must be one of ${DAEMON_KINDS.join(", ")}`);
  const requestId = stringFlag(context.parsed, "request-id") ?? randomUUID();
  const accepted = await daemonClient(context).submit({
    session: sessionKeyFor(context.parsed, "submit"),
    requestId,
    kind,
    input: readJobInput(context.parsed),
  });
  emit(
    context.io,
    context.parsed,
    { ...accepted, request_id: requestId },
    `submitted ${accepted.jobId} session=${accepted.sessionRef}\nrequest_id: ${requestId}\n`,
  );
  return 0;
}

async function runGet(context: CommandContext): Promise<number> {
  noExtraPositionals(context.parsed, "get");
  const jobId = requireFlag(context.parsed, "job");
  const job = await daemonClient(context).get(jobId);
  emit(context.io, context.parsed, job, formatJobHuman(job));
  return 0;
}

async function runList(context: CommandContext): Promise<number> {
  noExtraPositionals(context.parsed, "list");
  const client = daemonClient(context);
  const sessionRef = await resolveSessionRef(client, sessionTargetFor(context.parsed, "list"));
  const page = readJobPage(await client.list(sessionRef, stringFlag(context.parsed, "after")));
  emit(context.io, context.parsed, { sessionRef, ...page }, formatJobListHuman(page));
  return 0;
}

async function runCancel(context: CommandContext): Promise<number> {
  noExtraPositionals(context.parsed, "cancel");
  const jobId = requireFlag(context.parsed, "job");
  const result = await daemonClient(context).cancel(jobId);
  emit(context.io, context.parsed, { jobId, ...result }, `cancelled=${result.cancelled} job=${jobId}\n`);
  return 0;
}

/**
 * One-shot relay claim: fetch without consuming, print, then mark delivered.
 * The claim is what makes this an explicit adapter rather than a passive tip.
 */
async function runReceive(context: CommandContext): Promise<number> {
  noExtraPositionals(context.parsed, "receive");
  const client = daemonClient(context);
  const sessionRef = await resolveSessionRef(client, sessionTargetFor(context.parsed, "receive"));
  const events = await client.receive(sessionRef, true);
  const payload =
    context.parsed.flags.get("json") === true
      ? `${JSON.stringify({ sessionRef, events }, null, 2)}\n`
      : formatEventsHuman(events);
  await deliver(context.io, payload);
  await client.relayed(sessionRef, events.map((event) => event.eventId));
  return 0;
}

/**
 * Keep claiming while this process lives. Each event is delivered to stdout
 * before its `relayed` call, so a stdout failure leaves it pending for retry.
 */
async function runWatch(context: CommandContext): Promise<number> {
  noExtraPositionals(context.parsed, "watch");
  const client = daemonClient(context);
  const sessionRef = await resolveSessionRef(client, sessionTargetFor(context.parsed, "watch"));
  const interval = integerFlag(context.parsed, "interval", 50, 3_600_000) ?? 1_000;
  const count = integerFlag(context.parsed, "count", 1, 1_000_000);
  const json = context.parsed.flags.get("json") === true;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let delivered = 0;
  try {
    while (!controller.signal.aborted) {
      const events = await client.receive(sessionRef, true);
      for (const event of events) {
        await deliver(context.io, json ? `${JSON.stringify(event)}\n` : formatEventHuman(event));
        await client.relayed(sessionRef, [event.eventId]);
        delivered += 1;
        if (count !== undefined && delivered >= count) return 0;
      }
      if (controller.signal.aborted) break;
      await delay(interval);
    }
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function runStop(context: CommandContext): Promise<number> {
  noExtraPositionals(context.parsed, "stop");
  const stopped = await daemonClient(context).stop();
  emit(context.io, context.parsed, { stopped }, `stopped=${stopped}\n`);
  return 0;
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

const THINKING_LEVELS: readonly ModelThinking[] = ["off", "low", "medium", "high"];

function thinkingFlag(parsed: ParsedArgs): ModelThinking {
  const raw = stringFlag(parsed, "model-thinking") ?? process.env["VESTIGIO_MODEL_THINKING"];
  if (raw === undefined) {
    return "low";
  }
  const trimmed = raw.trim();
  return (THINKING_LEVELS as readonly string[]).includes(trimmed) ? (trimmed as ModelThinking) : "low";
}

/**
 * The PR-06 subcommand the eval drives: one budgeted, model-backed resolve.
 *
 * The model client is only built when a base URL is configured; otherwise the
 * resolver degrades to the zero-LLM layered search with a stated reason, which
 * is exactly the unconfigured-backend behaviour. The cost table is optional
 * and, when given, is the only source of `cost_usd` — a price is never guessed.
 */
type ModelWiring = {
  model: ModelPort | null;
  info: {
    base_url: string | null;
    model_id: string;
    thinking: ModelThinking;
    cost_table: { input: number; output: number } | null;
    skip_reason: string | null;
  };
};

/**
 * One wiring for both model-backed commands: a base URL is the switch, the key
 * comes from the flag or the environment, and a cost is reported only from an
 * explicit price table. Never prints the key.
 */
function wireModel(context: CommandContext): ModelWiring {
  const agents = agentModelSettings(process.env);
  const baseUrl =
    stringFlag(context.parsed, "model-base-url") ?? process.env["VESTIGIO_MODEL_BASE_URL"] ?? null;
  const modelId =
    stringFlag(context.parsed, "model-id") ?? process.env["VESTIGIO_MODEL_ID"] ?? DEFAULT_RESOLVE_MODEL_ID;
  const apiKey = stringFlag(context.parsed, "model-api-key") ?? process.env["VESTIGIO_MODEL_API_KEY"];
  const thinking = thinkingFlag(context.parsed);
  const costInput = numberFlag(context.parsed, "cost-input");
  const costOutput = numberFlag(context.parsed, "cost-output");
  const cost =
    costInput === undefined && costOutput === undefined ? null : { input: costInput ?? 0, output: costOutput ?? 0 };
  const model =
    baseUrl === null
      ? null
      : createAgentModelPort(
          {
            base_url: baseUrl,
            model: modelId,
            api_key: apiKey,
            thinking,
            cost: cost ?? undefined,
          },
          agents,
          context.deps.createModel ?? undefined,
        );
  return {
    model,
    info: {
      base_url: baseUrl,
      // What the resolver will actually call; the per-agent override wins.
      model_id: agents.resolver?.model ?? modelId,
      thinking,
      cost_table: cost,
      skip_reason: baseUrl === null ? "not configured: --model-base-url / VESTIGIO_MODEL_BASE_URL" : null,
    },
  };
}

async function runResolve(context: CommandContext): Promise<number> {
  noExtraPositionals(context.parsed, "resolve");
  const question = requireFlag(context.parsed, "question");
  const scope = requireScope(context.parsed);
  const store = openDatabase(context);
  try {
    const wiring = wireModel(context);
    const model = wiring.model;
    const home = stringFlag(context.parsed, "obelisk-home");
    const history =
      home === undefined
        ? null
        : (context.deps.createHistoryPort ?? createObeliskHistoryPort)({
            home,
            cli_path: stringFlag(context.parsed, "obelisk-cli"),
            source_instance: stringFlag(context.parsed, "source-instance"),
          });
    const outcome = await resolveMemory({ store, question, scope: withProjectAliases(scope, store.listProjectIds()), model, history, defer_persistence: true });
    const modelInfo = {
      ...wiring.info,
      degraded: outcome.measured.degraded,
    };
    emit(
      context.io,
      context.parsed,
      {
        ...outcome,
        model_info: modelInfo,
        history_index: home === undefined ? null : historyIndexPath(home),
      },
      formatResolveHuman(question, outcome, modelInfo),
    );
    return 0;
  } finally {
    store.close();
  }
}

type ResolveModelInfo = ModelWiring["info"] & { degraded: boolean };

function formatResolveHuman(question: string, outcome: ResolveOutcome, info: ResolveModelInfo): string {
  const { measured, result } = outcome;
  const lines: string[] = [];
  lines.push(
    `resolve(${JSON.stringify(question)}) -> ${result.status} | cards=${result.cards.length} excerpts=${outcome.history.length}`,
  );
  lines.push(
    `model: ${info.base_url === null ? `degraded (${info.skip_reason})` : `${info.model_id} thinking=${info.thinking}`}`,
  );
  lines.push(
    `layers: ${outcome.layers.map((layer) => `${layer.layer}=${layer.status}(${layer.emitted}/${layer.candidates})`).join(" ")}`,
  );
  lines.push(
    `budget: calls=${measured.model_calls} in=${measured.tokens_in} out=${measured.tokens_out} ` +
      `cost=${measured.cost_usd === null ? "n/a" : `$${measured.cost_usd.toFixed(6)}`} ` +
      `elapsed=${Math.round(measured.elapsed_ms)}ms gather=${Math.round(measured.gather_ms)}ms ` +
      `model=${Math.round(measured.model_ms)}ms history_read=${Math.round(measured.history_read_ms)}ms${measured.cold ? " cold" : ""}`,
  );
  for (const card of result.cards) {
    lines.push(`card [${card.state} r${card.revision}] ${card.uri} ${card.title}`);
    const stale = staleCardLine(card.freshness);
    if (stale !== null) {
      lines.push(stale.trimStart());
    }
  }
  lines.push(...formatFreshnessLines(result.freshness));
  if (result.answer !== null) lines.push(`answer: ${result.answer}`);
  if (result.conflicts.length > 0) lines.push(`conflicts: ${result.conflicts.join("; ")}`);
  if (result.missing.length > 0) lines.push(`missing: ${result.missing.join("; ")}`);
  if (result.next_action !== null) lines.push(`next: ${result.next_action}`);
  return `${lines.join("\n")}\n`;
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
      case "resolve":
        return await runResolve(context);
      case "jobs":
        return await runJobs(context);
      case "submit":
        return await runSubmit(context);
      case "get":
        return await runGet(context);
      case "list":
        return await runList(context);
      case "cancel":
        return await runCancel(context);
      case "receive":
        return await runReceive(context);
      case "watch":
        return await runWatch(context);
      case "stop":
        return await runStop(context);
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
