/**
 * Parsing of what the pinned CLI prints.
 *
 * Two rules:
 * - a required field that is missing or of the wrong type is a `protocol`
 *   failure, never a defaulted value, because defaulting is how an ignored
 *   filter becomes plausible-looking evidence;
 * - an *extra* field is surfaced in `unrecognised` instead of being dropped, so
 *   a release that starts returning something new is visible rather than
 *   silently absorbed.
 */

import { obeliskError } from "./errors.js";

export type CliSession = {
  readonly id: string;
  readonly title: string | null;
  readonly project: string | null;
  readonly project_path: string | null;
  readonly started_at: string | null;
  readonly jsonl_path: string | null;
  readonly source: string | null;
  readonly unrecognised: readonly string[];
};

export type CliMessage = {
  readonly uuid: string;
  readonly session_id: string | null;
  readonly parent_uuid: string | null;
  readonly text: string;
  readonly role: string | null;
  readonly timestamp: string;
  readonly visibility: string;
  readonly is_meta: boolean;
  readonly cwd: string | null;
  readonly source: string | null;
  readonly unrecognised: readonly string[];
};

export type CliHit = {
  readonly message: CliMessage;
  readonly session: CliSession;
  readonly rank: number;
  readonly context: readonly CliMessage[];
  /** Present only on the script path; `--search` omits the parent entirely. */
  readonly parent_uuid: string | null;
  readonly jsonl_path: string | null;
  readonly project_path: string | null;
  readonly parent_resolved: boolean;
  readonly unrecognised: readonly string[];
};

export type CliPage = {
  readonly messages: readonly CliMessage[];
  readonly session: CliSession | null;
  readonly has_more: boolean;
  readonly next_cursor: string | null;
  readonly unrecognised: readonly string[];
};

function fail(path: string, detail: string): never {
  throw obeliskError("protocol", `${path}: ${detail}`, { expected: "the pinned release's documented shape" });
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(path, "expected an array");
  }
  return value;
}

function str(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") fail(`${path}.${key}`, `expected a string, got ${typeof value}`);
  if (value.length === 0) fail(`${path}.${key}`, "expected a non-empty string");
  return value;
}

function nullableStr(record: Record<string, unknown>, key: string, path: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`${path}.${key}`, `expected a string or null, got ${typeof value}`);
  return value;
}

/**
 * A window row with no flat text is still part of the conversation: an
 * assistant turn that only called a tool reports `text: null`. Rejecting the
 * row would fail the whole window over one tool call, so it contributes an
 * empty text and the caller's own filtering decides what to keep.
 */
function messageText(record: Record<string, unknown>, path: string): string {
  const value = record["text"];
  if (value === null) return "";
  if (typeof value !== "string") fail(`${path}.text`, `expected a string or null, got ${typeof value}`);
  return value;
}

function num(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path}.${key}`, `expected a finite number, got ${typeof value}`);
  }
  return value;
}

function boolish(record: Record<string, unknown>, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  fail(`${path}.${key}`, `expected a boolean or 0/1, got ${typeof value}`);
}

function unknown(record: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(record)
    .filter((key) => !known.includes(key))
    .sort();
}

const MESSAGE_KEYS = [
  "uuid",
  "session_id",
  "parent_uuid",
  "text",
  "role",
  "timestamp",
  "visibility",
  "is_meta",
  "cwd",
  "source",
  "model",
  "type",
  "content_type",
  "is_sidechain",
  "agent_id",
  "input_tokens",
  "output_tokens",
  "skill",
  "turn_duration_ms",
] as const;

const SESSION_KEYS = [
  "id",
  "title",
  "project",
  "project_path",
  "started_at",
  "ended_at",
  "jsonl_path",
  "source",
  "git_branch",
  "version",
  "message_count",
] as const;

export function parseMessage(value: unknown, path: string): CliMessage {
  const record = asRecord(value, path);
  return {
    uuid: str(record, "uuid", path),
    session_id: nullableStr(record, "session_id", path),
    parent_uuid: nullableStr(record, "parent_uuid", path),
    text: messageText(record, path),
    role: nullableStr(record, "role", path),
    timestamp: str(record, "timestamp", path),
    visibility: (record["visibility"] === undefined ? "visible" : str(record, "visibility", path)) as string,
    is_meta: record["is_meta"] === undefined ? false : boolish(record, "is_meta", path),
    cwd: nullableStr(record, "cwd", path),
    source: nullableStr(record, "source", path),
    unrecognised: unknown(record, MESSAGE_KEYS),
  };
}

export function parseSession(value: unknown, path: string): CliSession {
  const record = asRecord(value, path);
  return {
    id: str(record, "id", path),
    title: nullableStr(record, "title", path),
    project: nullableStr(record, "project", path),
    project_path: nullableStr(record, "project_path", path),
    started_at: nullableStr(record, "started_at", path),
    jsonl_path: nullableStr(record, "jsonl_path", path),
    source: nullableStr(record, "source", path),
    unrecognised: unknown(record, SESSION_KEYS),
  };
}

/** `--search` output: an array of hits whose session object is a projection. */
export function parseCliSearch(value: unknown): CliHit[] {
  return asArray(value, "search").map((entry, index) => {
    const path = `search[${index}]`;
    const record = asRecord(entry, path);
    const context = record["context"] === undefined ? [] : asArray(record["context"], `${path}.context`);
    return {
      message: parseMessage(record["message"], `${path}.message`),
      session: parseSession(record["session"], `${path}.session`),
      rank: num(record, "rank", path),
      context: context.map((item, at) => parseMessage(item, `${path}.context[${at}]`)),
      parent_uuid: null,
      jsonl_path: null,
      project_path: null,
      parent_resolved: false,
      unrecognised: unknown(record, ["message", "session", "rank", "context"]),
    };
  });
}

/** Script search output: hits plus the per-hit causal parent and source file. */
export function parseScriptSearch(value: unknown): { hits: CliHit[]; session_found: boolean | null } {
  const record = asRecord(value, "search");
  const hits = asArray(record["hits"], "search.hits").map((entry, index) => {
    const path = `search.hits[${index}]`;
    const hit = asRecord(entry, path);
    const context = hit["context"] === undefined ? [] : asArray(hit["context"], `${path}.context`);
    return {
      message: parseMessage(hit["message"], `${path}.message`),
      session: parseSession(hit["session"], `${path}.session`),
      rank: num(hit, "rank", path),
      context: context.map((item, at) => parseMessage(item, `${path}.context[${at}]`)),
      parent_uuid: nullableStr(hit, "parent_uuid", path),
      jsonl_path: nullableStr(hit, "jsonl_path", path),
      project_path: nullableStr(hit, "project_path", path),
      parent_resolved: true,
      unrecognised: unknown(hit, [
        "message",
        "session",
        "rank",
        "context",
        "parent_uuid",
        "jsonl_path",
        "project_path",
      ]),
    } satisfies CliHit;
  });

  const found = record["session_found"];
  return {
    hits,
    session_found: typeof found === "boolean" ? found : null,
  };
}

/** `messages.query.mjs` output: one bounded window, or `found: false`. */
export function parseScriptPage(value: unknown): { found: false } | ({ found: true } & CliPage) {
  const record = asRecord(value, "messages");
  if (record["found"] !== true) {
    return { found: false };
  }
  const rows = asArray(record["messages"], "messages.messages").map((entry, index) =>
    parseMessage(entry, `messages.messages[${index}]`),
  );
  const session = record["session"] === null || record["session"] === undefined
    ? null
    : parseSession(record["session"], "messages.session");
  const cursor = record["next_cursor"];
  return {
    found: true,
    messages: rows,
    session,
    has_more: record["has_more"] === true,
    next_cursor: typeof cursor === "string" ? cursor : null,
    unrecognised: unknown(record, ["found", "anchor", "messages", "session", "has_more", "next_cursor"]),
  };
}

/** `session.query.mjs` output: exact-id lookup. */
export function parseSessionLookup(value: unknown): { found: boolean; session: CliSession | null } {
  const record = asRecord(value, "session");
  if (record["found"] !== true) return { found: false, session: null };
  return { found: true, session: parseSession(record["session"], "session.session") };
}

/** A singular JSON value printed by `--version`. */
export function parseVersion(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw obeliskError("protocol", "Obelisk --version did not print a version", {
    expected: "a bare version string",
  });
}
