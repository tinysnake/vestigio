/**
 * `search()`: one bounded query, exact project scoping, typed failures.
 *
 * Two paths to the same pinned release:
 * - the fast path (`--search`, ~0.2 s) whenever the caller's options fit the
 *   CLI flags, which is the normal retrieval case;
 * - one `search()` script (~4.2 s, the CLI's invocation-nonce wait) when the
 *   caller needs `include_inactive` / `include_meta`, or asks for complete
 *   evidence (causal parent + source file), neither of which `--search` prints.
 *
 * Whatever the path, a hit that does not belong to the requested project is a
 * `project_scope` failure, never a filtered-out hit: a silently ignored filter
 * is the one outcome this adapter must never produce.
 */

import { obeliskError } from "./errors.js";
import { isSearchNoise } from "./evidence.js";
import {
  type CliHit,
  parseCliSearch,
  parseScriptSearch,
  parseSessionLookup,
} from "./parse.js";
import {
  CONTEXT_LIMIT_MAX,
  CONTEXT_LIMIT_MIN,
  DEFAULT_TIMEOUT_MS,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
} from "./pinned.js";
import {
  optionalBoolean,
  optionalInteger,
  optionalNonEmptyString,
  optionalString,
  optionalTimestamp,
  readOptionObject,
  requireAbsolutePath,
} from "./options.js";
import { expandFtsQuery } from "./query.js";
import type { CliRuntime } from "./runtime.js";
import { type SearchHit, type SearchResult, mapHit } from "./hit.js";

const ALLOWED_KEYS = [
  "text",
  "prefix_expand",
  "limit",
  "project_path",
  "session_id",
  "after",
  "before",
  "source",
  "include_meta",
  "include_inactive",
  "context_limit",
  "resolve_evidence",
  "timeout_ms",
  "signal",
] as const;

const SESSION_LOOKUP_LIMIT = 50;

/** Extra rows requested so dropping tool traffic still fills the caller's window. */
const OVERSCAN = 3;

export type SearchOptions = {
  /** FTS5 query text. Never spliced: it is one argv element or one JSON value. */
  readonly text: string;
  /**
   * Rewrite every term into a prefix match before the query is sent. Default
   * true, because the pinned index tokenizes with unicode61 and a
   * multi-character term otherwise matches only a token that is that exact run
   * (see `query.ts`). Set false to send the caller's text verbatim, which is
   * what an A/B measurement does.
   */
  readonly prefix_expand?: boolean | undefined;
  /** Default 20, capped at 200 so a result set stays bounded. */
  readonly limit?: number | undefined;
  /** Absolute, normalised project root; matched with `sessions.project_path = ?`. */
  readonly project_path?: string | undefined;
  readonly session_id?: string | undefined;
  readonly after?: string | undefined;
  readonly before?: string | undefined;
  readonly source?: string | undefined;
  readonly include_meta?: boolean | undefined;
  readonly include_inactive?: boolean | undefined;
  /** 0..6, default 0: only the matching message, no neighbours. */
  readonly context_limit?: number | undefined;
  /** Resolve each hit's causal parent and source file (script path). */
  readonly resolve_evidence?: boolean | undefined;
  readonly timeout_ms?: number | undefined;
  readonly signal?: AbortSignal | undefined;
};

export type NormalisedSearch = {
  text: string;
  prefix_expand: boolean;
  limit: number;
  project_path: string | undefined;
  session_id: string | undefined;
  after: string | undefined;
  before: string | undefined;
  source: string | undefined;
  include_meta: boolean;
  include_inactive: boolean;
  context_limit: number;
  resolve_evidence: boolean;
  timeout_ms: number;
  signal: AbortSignal | undefined;
};

export function normaliseSearchOptions(options: unknown): NormalisedSearch {
  const record = readOptionObject(options, ALLOWED_KEYS, "search");
  const text = optionalNonEmptyString(record, "text", "search");
  if (text === undefined) {
    throw obeliskError("invalid_option", "search.text is required", { option: "search.text" });
  }
  if (text.trim().length === 0) {
    throw obeliskError("invalid_option", "search.text must not be blank", { option: "search.text" });
  }
  if (text.includes("\0")) {
    throw obeliskError("invalid_option", "search.text must not contain a NUL byte", { option: "search.text" });
  }
  const project_path = optionalString(record, "project_path", "search");
  const session_id = optionalNonEmptyString(record, "session_id", "search");
  const source = optionalNonEmptyString(record, "source", "search");
  const signal = record["signal"];
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw obeliskError("invalid_option", "search.signal must be an AbortSignal", { option: "search.signal" });
  }
  return {
    text,
    prefix_expand: optionalBoolean(record, "prefix_expand", "search") ?? true,
    limit: optionalInteger(record, "limit", "search", 0, SEARCH_LIMIT_MAX) ?? SEARCH_LIMIT_DEFAULT,
    project_path: project_path === undefined ? undefined : requireAbsolutePath(project_path, "search.project_path"),
    session_id,
    after: optionalTimestamp(record, "after", "search"),
    before: optionalTimestamp(record, "before", "search"),
    source,
    include_meta: optionalBoolean(record, "include_meta", "search") ?? false,
    include_inactive: optionalBoolean(record, "include_inactive", "search") ?? false,
    context_limit:
      optionalInteger(record, "context_limit", "search", CONTEXT_LIMIT_MIN, CONTEXT_LIMIT_MAX) ?? CONTEXT_LIMIT_MIN,
    resolve_evidence: optionalBoolean(record, "resolve_evidence", "search") ?? false,
    timeout_ms: optionalInteger(record, "timeout_ms", "search", 1, Number.MAX_SAFE_INTEGER) ?? DEFAULT_TIMEOUT_MS,
    signal: signal instanceof AbortSignal ? signal : undefined,
  };
}

/**
 * Every hit must belong to the requested project. Exact mode compares the
 * session's `project_path` (script path); slug mode compares the derived
 * project slug the CLI prints on `--search` hits.
 */
export function verifyProjectScope(
  hits: readonly CliHit[],
  project_path: string,
  mode: "exact" | "slug",
): void {
  const expected_slug = `-${project_path.replace(/^[\\/]+/, "").replace(/[\\/]+/g, "-")}`;
  for (const hit of hits) {
    if (mode === "exact") {
      if (hit.project_path === null) {
        throw obeliskError(
          "protocol",
          `hit ${hit.message.uuid} arrived without a project_path while the query was project-scoped`,
          { expected: "project_path on every hit" },
        );
      }
      if (hit.project_path !== project_path) {
        throw obeliskError(
          "project_scope",
          `hit ${hit.message.uuid} belongs to ${hit.project_path}, not ${project_path}: the project filter was not applied`,
          { expected: project_path },
        );
      }
      continue;
    }
    if (hit.session.project !== expected_slug) {
      throw obeliskError(
        "project_scope",
        `hit ${hit.message.uuid} belongs to project ${JSON.stringify(hit.session.project)}, not ${JSON.stringify(
          expected_slug,
        )} for ${project_path}: the project filter was not applied`,
        { expected: expected_slug },
      );
    }
  }
}

export async function runSearch(
  runtime: CliRuntime,
  options: unknown,
): Promise<SearchResult> {
  const normalised = normaliseSearchOptions(options);
  const started_at = performance.now();
  runtime.ensureIndex();

  const query = normalised.prefix_expand
    ? expandFtsQuery(normalised.text)
    : { text: normalised.text, original: normalised.text, expanded: false, terms: [] as readonly string[] };

  const run_options = { timeout_ms: normalised.timeout_ms, signal: normalised.signal };
  const use_script = normalised.include_meta || normalised.include_inactive || normalised.resolve_evidence;

  let hits: CliHit[];
  let child_ms = 0;
  let session_found: boolean | null = null;
  // Ask for more rows than the caller wants: the filter below can drop most of
  // a window on a tool-heavy index, and the CLI's limit is a plain LIMIT.
  const fetch_limit = Math.min(normalised.limit * OVERSCAN, SEARCH_LIMIT_MAX);

  if (use_script) {
    const ran = await runtime.runScript(
      "search",
      {
        text: query.text,
        limit: fetch_limit,
        context_limit: normalised.context_limit,
        include_meta: normalised.include_meta,
        include_inactive: normalised.include_inactive,
        project_path: normalised.project_path ?? null,
        session_id: normalised.session_id ?? null,
        after: normalised.after ?? null,
        before: normalised.before ?? null,
        source: normalised.source ?? null,
        session_lookup_limit: SESSION_LOOKUP_LIMIT,
      },
      run_options,
    );
    child_ms += ran.child_ms;
    const parsed = parseScriptSearch(ran.value);
    hits = parsed.hits;
    session_found = parsed.session_found;
    if (normalised.session_id !== undefined && session_found === null) {
      throw obeliskError("protocol", "session lookup result is missing for a session-scoped search", {
        expected: "session_found",
      });
    }
  } else {
    const args = [
      "--search",
      query.text,
      "--limit",
      String(fetch_limit),
      "--context-limit",
      String(normalised.context_limit),
    ];
    if (normalised.project_path !== undefined) args.push("--project-path", normalised.project_path);
    if (normalised.session_id !== undefined) args.push("--session-id", normalised.session_id);
    if (normalised.after !== undefined) args.push("--after", normalised.after);
    if (normalised.before !== undefined) args.push("--before", normalised.before);
    if (normalised.source !== undefined) args.push("--source", normalised.source);
    const ran = await runtime.run(args, run_options);
    child_ms += ran.child_ms;
    hits = parseCliSearch(ran.value);
  }

  if (normalised.project_path !== undefined) {
    verifyProjectScope(hits, normalised.project_path, use_script ? "exact" : "slug");
  }

  if (normalised.session_id !== undefined && session_found === false) {
    throw obeliskError(
      "session_not_found",
      `session ${normalised.session_id} is not in this index; an absent session is not an empty result`,
      { option: "search.session_id" },
    );
  }

  if (normalised.session_id !== undefined && session_found === null && hits.length === 0) {
    // The fast path cannot tell "no matching text" from "no such session".
    const ran = await runtime.runScript(
      "session",
      { session_id: normalised.session_id, lookup_limit: SESSION_LOOKUP_LIMIT },
      run_options,
    );
    child_ms += ran.child_ms;
    if (!parseSessionLookup(ran.value).found) {
      throw obeliskError(
        "session_not_found",
        `session ${normalised.session_id} is not in this index; an absent session is not an empty result`,
        { option: "search.session_id" },
      );
    }
  }

  // Filter after the session checks: an empty window still means "no matching
  // text", which must stay distinguishable from "no such session".
  hits = hits.filter((hit) => !isSearchNoise(hit.message.content_type)).slice(0, normalised.limit);

  return {
    hits: hits.map((hit) => mapHit(hit, runtime.source_instance, normalised.project_path ?? null)),
    query: {
      text: normalised.text,
      fts_text: query.text,
      limit: normalised.limit,
      project_path: normalised.project_path ?? null,
      session_id: normalised.session_id ?? null,
      after: normalised.after ?? null,
      before: normalised.before ?? null,
      source: normalised.source ?? null,
      include_meta: normalised.include_meta,
      include_inactive: normalised.include_inactive,
      context_limit: normalised.context_limit,
    },
    evidence: use_script ? "resolved" : "ids_only",
    timing: { child_ms, total_ms: performance.now() - started_at },
  };
}

export type { SearchHit, SearchResult };
