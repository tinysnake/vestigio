/**
 * The one place the adapter reads the Obelisk pin and the capability list that
 * release was verified to have.
 *
 * `packages/source-obelisk/package.json` carries the same exact version as a
 * dependency specifier; `test/pinned.test.ts` asserts the two never diverge.
 * Bumping either without re-running the probe (and editing this table) fails
 * `test/capabilities.test.ts` because the table is asserted to be the probe's.
 *
 * Evidence for every entry: `docs/probes/obelisk-adapter-findings.md` and
 * `eval/probes/obelisk/` (measured against 0.3.2 on an isolated fixture).
 */

export const OBELISK_PACKAGE = "@obelisk-apps/cli";

/** Exact, pinned release. 0.3.0/0.3.1 ignore `projectPath`; never widen this. */
export const OBELISK_VERSION = "0.3.2";

/** Entry point inside the installed package (the package has no `exports` map). */
export const OBELISK_CLI_ENTRY = "dist/cli/src/obelisk.js";

/** tarball integrity of `OBELISK_VERSION`, as recorded by pnpm-lock.yaml. */
export const OBELISK_TARBALL_INTEGRITY =
  "sha512-qFK8eSO7eHXhl3WDBt3Lp193A/0iLfE+yMcYmWRpu6hg6PLzPYMRYMhpusfUOceL3P3Xu+nY7kJjR0AOK81q8g==";

/** `os.homedir()` honours $HOME, so this is the whole isolation boundary. */
export const INDEX_RELATIVE_PATH = ".obelisk/obelisk.sqlite";

/** `messages()` refuses a window larger than this, anchor included. */
export const MESSAGES_WINDOW_MAX = 500;

/** `search()` rejects `contextLimit` outside this range. */
export const CONTEXT_LIMIT_MIN = 0;
export const CONTEXT_LIMIT_MAX = 6;

/** `search()` rejects `snippetTokens` outside this range (unused by the adapter). */
export const SNIPPET_TOKENS_MIN = 1;
export const SNIPPET_TOKENS_MAX = 64;

/** Adapter-side ceiling; the CLI itself has none beyond non-negative. */
export const SEARCH_LIMIT_MAX = 200;
export const SEARCH_LIMIT_DEFAULT = 20;

/**
 * `--query` waits this long for an invocation nonce to show up in a transcript,
 * then runs the script anyway. The adapter therefore treats every script-based
 * call as a multi-second call and keeps them off the default search path.
 */
export const QUERY_NONCE_WAIT_MS = 4_000;

/**
 * Default child-process deadline.
 *
 * Measured on the operator's 6.97 GiB index: 59.9 s for a cold `--search`
 * (including the incremental refresh), then effectively instant while warm. A
 * deadline below a minute would turn a legitimate cold call into a timeout.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

export type ObeliskCapabilities = {
  /** `--project-path` / `opts.projectPath` is `sessions.project_path = ?` (exact). */
  readonly exact_project_path: true;
  /** `opts.project` and `opts.cwd` are SQL `LIKE` patterns; the adapter does not expose them. */
  readonly project_and_cwd_are_like_patterns: true;
  readonly context_limit: { readonly min: number; readonly max: number };
  readonly snippet_tokens: { readonly min: number; readonly max: number };
  readonly messages_window_max: number;
  readonly messages_relations: readonly string[];
  readonly parents_requires_after_count_zero: true;
  readonly hidden_rows_never_returned: true;
  readonly inactive_rows_require_include_inactive: true;
  readonly unknown_messages_option_is_an_error: true;
  readonly search_and_query_refresh_query_index: true;
  readonly message_uuid_stable_under_append: true;
  readonly message_uuid_not_content_stable: true;
  readonly parent_uuid_available_for_reads: true;
  readonly query_nonce_wait_ms: number;
};

/**
 * What 0.3.2 was measured to do. Anything not listed here is not relied on.
 * `test/capabilities.test.ts` pins this object and the live suite re-checks the
 * behaviours it promises.
 */
export const VERIFIED_CAPABILITIES: ObeliskCapabilities = {
  exact_project_path: true,
  project_and_cwd_are_like_patterns: true,
  context_limit: { min: CONTEXT_LIMIT_MIN, max: CONTEXT_LIMIT_MAX },
  snippet_tokens: { min: SNIPPET_TOKENS_MIN, max: SNIPPET_TOKENS_MAX },
  messages_window_max: MESSAGES_WINDOW_MAX,
  messages_relations: ["timeline", "parents"],
  parents_requires_after_count_zero: true,
  hidden_rows_never_returned: true,
  inactive_rows_require_include_inactive: true,
  unknown_messages_option_is_an_error: true,
  search_and_query_refresh_query_index: true,
  message_uuid_stable_under_append: true,
  message_uuid_not_content_stable: true,
  parent_uuid_available_for_reads: true,
  query_nonce_wait_ms: QUERY_NONCE_WAIT_MS,
};
