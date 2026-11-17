/**
 * Unit-test support: a deterministic stand-in for the pinned CLI.
 *
 * Unit tests must pass with no Obelisk installed, so every one of them runs
 * `test/fixtures/fake-obelisk.mjs` as the child. The real CLI is exercised only
 * by `test/live`, against the fixture built by `eval/fixtures/obelisk/`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isObeliskError } from "../../src/errors.js";
import { ObeliskSource } from "../../src/index.js";

export const FAKE_CLI = fileURLToPath(new URL("../fixtures/fake-obelisk.mjs", import.meta.url));

export const FAKE_KEYS = [
  "FAKE_OBELISK_VERSION",
  "FAKE_OBELISK_SEARCH",
  "FAKE_OBELISK_QUERY",
  "FAKE_OBELISK_STDOUT",
  "FAKE_OBELISK_EXIT",
  "FAKE_OBELISK_STDERR",
  "FAKE_OBELISK_SLEEP_MS",
  "FAKE_OBELISK_IGNORE_TERM",
  "FAKE_OBELISK_ARGV_LOG",
  "FAKE_OBELISK_ECHO_SCRIPT",
] as const;

export type FakeKey = (typeof FAKE_KEYS)[number];

export function setFakeEnv(env: Partial<Record<FakeKey, string>>): void {
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
}

export function resetFakeEnv(): void {
  for (const key of FAKE_KEYS) delete process.env[key];
}

export type TempHome = {
  readonly home: string;
  readonly cleanup: () => void;
};

export function makeTempHome(prefix = "vestigio-unit-"): TempHome {
  const home = mkdtempSync(join(tmpdir(), prefix));
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** A file where `<home>/.obelisk/obelisk.sqlite` is expected; contents never read. */
export function writeIndex(home: string): string {
  mkdirSync(join(home, ".obelisk"), { recursive: true });
  const index = join(home, ".obelisk", "obelisk.sqlite");
  writeFileSync(index, "fixture");
  return index;
}

export function fakeSource(home: string, overrides: { source_instance?: string; timeout_ms?: number } = {}): ObeliskSource {
  return new ObeliskSource({ home, cli_path: FAKE_CLI, ...overrides });
}

export function argvLog(path: string): string[][] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

export const UUID_A1 = "pi:sessA:hashA:entry:000001:message:block:0000";
export const UUID_A2 = "pi:sessA:hashA:entry:000002:message:block:0000";
export const UUID_A3 = "pi:sessA:hashA:entry:000003:message:block:0000";

export type MessageFields = {
  uuid?: string;
  text?: string;
  role?: string;
  timestamp?: string;
  is_meta?: number;
  visibility?: string;
  session_id?: string;
  parent_uuid?: string | null;
  extra?: Record<string, unknown>;
};

/** A row as `messages()` / `--search` print it. */
export function messageJson(fields: MessageFields = {}): Record<string, unknown> {
  return {
    uuid: fields.uuid ?? UUID_A1,
    text: fields.text ?? "zqleak alpha first user message",
    content_type: "text",
    is_meta: fields.is_meta ?? 0,
    role: fields.role ?? "user",
    timestamp: fields.timestamp ?? "2026-01-01T00:00:01.000Z",
    model: null,
    cwd: "/tmp/x_a",
    visibility: fields.visibility ?? "visible",
    source: "pi",
    ...(fields.session_id === undefined ? {} : { session_id: fields.session_id }),
    ...(fields.parent_uuid === undefined ? {} : { parent_uuid: fields.parent_uuid }),
    ...fields.extra,
  };
}

export type SessionFields = {
  id?: string;
  project?: string | null;
  project_path?: string | null;
  jsonl_path?: string | null;
  extra?: Record<string, unknown>;
};

export function sessionJson(fields: SessionFields = {}): Record<string, unknown> {
  return {
    id: fields.id ?? "pi:sessA:hashA",
    title: "zqleak alpha",
    project: fields.project === undefined ? "-tmp-x_a" : fields.project,
    // `--search` does not project this column; only the script path does.
    project_path: fields.project_path === undefined ? null : fields.project_path,
    started_at: "2026-01-01T00:00:00.000Z",
    source: "pi",
    ...(fields.jsonl_path === undefined ? {} : { jsonl_path: fields.jsonl_path }),
    ...fields.extra,
  };
}

/** A `--search` hit. */
export function hitJson(
  fields: { message?: MessageFields; session?: SessionFields } = {},
): Record<string, unknown> {
  return {
    message: messageJson(fields.message),
    session: sessionJson(fields.session),
    rank: -1.5,
    context: [],
  };
}

/** A `messages()` page as `src/scripts/messages.query.mjs` reports it. */
export function pageJson(
  messages: readonly Record<string, unknown>[],
  extras: { session?: Record<string, unknown> | null; has_more?: boolean; next_cursor?: string | null } = {},
): Record<string, unknown> {
  return {
    found: true,
    anchor: messages[0]?.["uuid"] ?? UUID_A1,
    messages,
    session:
      extras.session === undefined
        ? sessionJson({ jsonl_path: "/tmp/x_a/.pi/agent/sessions/sessA.jsonl" })
        : extras.session,
    has_more: extras.has_more ?? false,
    next_cursor: extras.next_cursor ?? null,
  };
}

/** A script-mode search result as `src/scripts/search.query.mjs` reports it. */
export function scriptSearchJson(
  hits: readonly Record<string, unknown>[],
  session_found: boolean | null = null,
): Record<string, unknown> {
  return { hits, session_found };
}

export function scriptHitJson(
  fields: { message?: MessageFields; session?: SessionFields; project_path?: string | null; parent_uuid?: string | null } = {},
): Record<string, unknown> {
  return {
    message: messageJson(fields.message),
    session: sessionJson(fields.session),
    rank: -1.5,
    context: [],
    parent_uuid: fields.parent_uuid === undefined ? null : fields.parent_uuid,
    jsonl_path: "/tmp/x_a/.pi/agent/sessions/sessA.jsonl",
    // `--search` does not project this column; only the script path does.
    project_path: fields.project_path === undefined ? null : fields.project_path,
  };
}

/** Await a promise that must reject with a typed adapter error. */
export async function rejectionKind(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isObeliskError(error)) return error.kind;
    throw error;
  }
  throw new Error("expected a rejection");
}
