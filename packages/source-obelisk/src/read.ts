/**
 * `read()`: one bounded message window.
 *
 * This is the only path that can resolve a causal parent, so it is the path
 * evidence chains are built from. A window over 500, or `after` on the
 * `parents` relation, is rejected here with a typed failure instead of being
 * discovered by the child; those are the pinned release's own limits.
 *
 * An anchor that is missing, hidden, or inactive without `include_inactive`
 * comes back from the CLI as `null`. That is reported as `message_not_visible`,
 * never as a page with no messages.
 */

import {
  MESSAGES_WINDOW_MAX,
  DEFAULT_TIMEOUT_MS,
} from "./pinned.js";
import { obeliskError } from "./errors.js";
import { isWindowNoise } from "./evidence.js";
import {
  optionalBoolean,
  optionalInteger,
  optionalNonEmptyString,
  readOptionObject,
} from "./options.js";
import { parseScriptPage } from "./parse.js";
import type { CliRuntime } from "./runtime.js";
import type { CallTiming, HitSession } from "./hit.js";
import { sessionOf } from "./hit.js";
import { toSourceRef } from "./source-ref.js";
import type { SourceRef } from "@vestigio/core";

const ALLOWED_KEYS = [
  "anchor",
  "relation",
  "before",
  "after",
  "include_inactive",
  "timeout_ms",
  "signal",
] as const;

export const READ_RELATIONS = ["timeline", "parents"] as const;
export type ReadRelation = (typeof READ_RELATIONS)[number];

export type ReadOptions = {
  /** Message uuid from a search hit or an earlier read. */
  readonly anchor: string;
  /** Default `timeline`: neighbours by timestamp. `parents`: the causal chain. */
  readonly relation?: ReadRelation | undefined;
  /** Predecessors, 0..500. Default 0. */
  readonly before?: number | undefined;
  /** Successors, 0..500. Default 0; must be 0 for `parents`. */
  readonly after?: number | undefined;
  readonly include_inactive?: boolean | undefined;
  readonly timeout_ms?: number | undefined;
  readonly signal?: AbortSignal | undefined;
};

export type ReadMessage = {
  readonly source_ref: SourceRef;
  readonly text: string;
  readonly role: string | null;
  readonly visibility: string;
  readonly is_meta: boolean;
  readonly content_type: string | null;
  readonly unrecognised: readonly string[];
};

export type ReadResult = {
  readonly anchor: SourceRef;
  readonly messages: readonly ReadMessage[];
  readonly session: HitSession | null;
  readonly has_more: boolean;
  readonly next_cursor: string | null;
  readonly timing: CallTiming;
};

export type NormalisedRead = {
  anchor: string;
  relation: ReadRelation;
  before: number;
  after: number;
  include_inactive: boolean;
  timeout_ms: number;
  signal: AbortSignal | undefined;
};

export function normaliseReadOptions(options: unknown): NormalisedRead {
  const record = readOptionObject(options, ALLOWED_KEYS, "read");
  const anchor = optionalNonEmptyString(record, "anchor", "read");
  if (anchor === undefined) {
    throw obeliskError("invalid_option", "read.anchor is required", { option: "read.anchor" });
  }
  if (anchor.includes("\0")) {
    throw obeliskError("invalid_option", "read.anchor must not contain a NUL byte", { option: "read.anchor" });
  }

  const relation = record["relation"] === undefined ? "timeline" : record["relation"];
  if (relation !== "timeline" && relation !== "parents") {
    throw obeliskError(
      "unsupported_option",
      `read.relation must be one of ${READ_RELATIONS.join(" | ")}; the pinned release supports exactly those`,
      { option: "read.relation" },
    );
  }

  const before = optionalInteger(record, "before", "read", 0, MESSAGES_WINDOW_MAX) ?? 0;
  const after = optionalInteger(record, "after", "read", 0, MESSAGES_WINDOW_MAX) ?? 0;
  if (relation === "parents" && after !== 0) {
    throw obeliskError(
      "unsupported_option",
      "read.after must be 0 with relation 'parents': the pinned release rejects a causal chain with followers",
      { option: "read.after" },
    );
  }
  if (before + after + 1 > MESSAGES_WINDOW_MAX) {
    throw obeliskError(
      "unsupported_option",
      `read window is ${before + after + 1} messages; the pinned release caps a window at ${MESSAGES_WINDOW_MAX} including the anchor`,
      { option: "read.before" },
    );
  }

  const signal = record["signal"];
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw obeliskError("invalid_option", "read.signal must be an AbortSignal", { option: "read.signal" });
  }

  return {
    anchor,
    relation,
    before,
    after,
    include_inactive: optionalBoolean(record, "include_inactive", "read") ?? false,
    timeout_ms: optionalInteger(record, "timeout_ms", "read", 1, Number.MAX_SAFE_INTEGER) ?? DEFAULT_TIMEOUT_MS,
    signal: signal instanceof AbortSignal ? signal : undefined,
  };
}

export async function runRead(runtime: CliRuntime, options: unknown): Promise<ReadResult> {
  const normalised = normaliseReadOptions(options);
  const started_at = performance.now();
  runtime.ensureIndex();

  const ran = await runtime.runScript(
    "messages",
    {
      anchor: normalised.anchor,
      relation: normalised.relation,
      before_count: normalised.before,
      after_count: normalised.after,
      include_inactive: normalised.include_inactive,
    },
    { timeout_ms: normalised.timeout_ms, signal: normalised.signal },
  );

  const page = parseScriptPage(ran.value);
  if (!page.found) {
    throw obeliskError(
      "message_not_visible",
      `message ${normalised.anchor} is not queryable: missing, hidden, or inactive without include_inactive`,
      { option: "read.anchor" },
    );
  }

  const cli_payload = page.session;
  if (cli_payload === null) {
    throw obeliskError("protocol", "messages() returned rows without their session", {
      expected: "includeSession",
    });
  }
  const session = sessionOf(cli_payload);
  const messages: ReadMessage[] = page.messages.map((message, index) => ({
    source_ref: toSourceRef(
      {
        message,
        session: cli_payload,
        source_instance: runtime.source_instance,
        parent_uuid: message.parent_uuid,
        jsonl_path: cli_payload.jsonl_path,
        project_path_hint: cli_payload.project_path,
      },
      `read.messages[${index}]`,
    ),
    text: message.text,
    role: message.role,
    visibility: message.visibility,
    is_meta: message.is_meta,
    content_type: message.content_type,
    unrecognised: message.unrecognised,
  }));

  const anchor_index = page.messages.findIndex((message) => message.uuid === normalised.anchor);
  const anchor_message = page.messages[anchor_index];
  if (anchor_index < 0 || anchor_message === undefined) {
    throw obeliskError("protocol", `the window returned no row for anchor ${normalised.anchor}`, {
      expected: "the anchor is always inside its own window",
    });
  }

  return {
    anchor: messages[anchor_index]!.source_ref,
    // Reasoning and the bare tool call stay out of evidence. `anchor` keeps
    // naming the row the window was built around even when it is one of them.
    messages: messages.filter((message) => !isWindowNoise(message.content_type)),
    session,
    has_more: page.has_more,
    next_cursor: page.next_cursor,
    timing: { child_ms: ran.child_ms, total_ms: performance.now() - started_at },
  };
}
