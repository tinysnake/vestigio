/**
 * `@vestigio/source-obelisk` — the read-only history source.
 *
 * ```ts
 * const source = new ObeliskSource({ home: "/tmp/obelisk-fixture-home" });
 * const probe = await source.probe();          // unavailable is reported, not thrown
 * const found = await source.search({ text: "deploy port", project_path: "/work/app" });
 * const page = await source.read({ anchor: found.hits[0].source_ref.message_id, relation: "parents", before: 5 });
 * ```
 *
 * `home` is required and has no default: the adapter reads
 * `<home>/.obelisk/obelisk.sqlite` and nothing else, so pointing it at an
 * isolated fixture is a decision the caller makes, not a fallback.
 *
 * Read-only: the adapter runs `--version`, `--search`, and `--query` with the
 * fixed templates in `src/scripts/`. It never runs `--build`, `install`, or
 * `--attune`, so it never writes provider history or memory. `--search` and
 * `--query` do refresh the derived query index; that is the tool's normal read
 * path (capability table: `search_and_query_refresh_query_index`).
 */

export { ObeliskSource } from "./source.js";
export type { ObeliskSourceOptions } from "./source.js";
export { createObeliskHistoryPort, obeliskIndexPath } from "./history-port.js";
export type { ObeliskHistoryOptions } from "./history-port.js";

export type { ObeliskCapabilities } from "./pinned.js";
export type { ProbeResult } from "./probe.js";
export type { SearchOptions } from "./search.js";
export type { ReadOptions, ReadResult } from "./read.js";
export type { SearchResult } from "./hit.js";
export type { SearchHit, HitSession, ContextMessage, CallTiming } from "./hit.js";
export type { ReadMessage, ReadRelation } from "./read.js";
export { READ_RELATIONS } from "./read.js";
export { ObeliskError, isObeliskError, isUnavailable, UNAVAILABLE_KINDS } from "./errors.js";
export type { ObeliskErrorKind, ObeliskErrorDetail } from "./errors.js";
export {
  CONTEXT_LIMIT_MAX,
  CONTEXT_LIMIT_MIN,
  DEFAULT_TIMEOUT_MS,
  INDEX_RELATIVE_PATH,
  MESSAGES_WINDOW_MAX,
  OBELISK_CLI_ENTRY,
  OBELISK_PACKAGE,
  OBELISK_TARBALL_INTEGRITY,
  OBELISK_VERSION,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  VERIFIED_CAPABILITIES,
} from "./pinned.js";
export { contentHash, projectIdFor, projectSlugFor, locatorFor, UNSCOPED_PROJECT } from "./source-ref.js";
