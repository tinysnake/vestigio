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

import { DEFAULT_TIMEOUT_MS, type ObeliskCapabilities } from "./pinned.js";
import { obeliskError } from "./errors.js";
import { optionalInteger, optionalNonEmptyString, optionalString, readOptionObject, requireAbsolutePath } from "./options.js";
import { CliRuntime } from "./runtime.js";
import { probeObelisk, type ProbeResult } from "./probe.js";
import { runSearch, type SearchOptions } from "./search.js";
import { runRead, type ReadOptions } from "./read.js";
import type { SearchResult } from "./hit.js";
import type { ReadResult } from "./read.js";

const ALLOWED_KEYS = ["home", "cli_path", "source_instance", "timeout_ms"] as const;

export type ObeliskSourceOptions = {
  /** Isolated Obelisk data directory; `<home>/.obelisk/obelisk.sqlite` is the index. */
  readonly home: string;
  /** Absolute path to a CLI entry, for tests or a vendored install. Default: the pinned dependency. */
  readonly cli_path?: string | undefined;
  /** Instance identity carried on every `SourceRef`. Default `"local"`. */
  readonly source_instance?: string | undefined;
  /** Child deadline. Default 60 s, which covers a cold search on a 6.97 GiB index. */
  readonly timeout_ms?: number | undefined;
};

export class ObeliskSource {
  readonly #runtime: CliRuntime;

  constructor(options: unknown) {
    const record = readOptionObject(options, ALLOWED_KEYS, "obelisk");
    const home = optionalString(record, "home", "obelisk");
    if (home === undefined) {
      throw obeliskError("invalid_option", "obelisk.home is required: the adapter never guesses a data directory", {
        option: "obelisk.home",
      });
    }
    const cli_path = optionalString(record, "cli_path", "obelisk");
    this.#runtime = new CliRuntime({
      home: requireAbsolutePath(home, "obelisk.home"),
      cli_path: cli_path === undefined ? undefined : requireAbsolutePath(cli_path, "obelisk.cli_path"),
      source_instance: optionalNonEmptyString(record, "source_instance", "obelisk") ?? "local",
      default_timeout_ms:
        optionalInteger(record, "timeout_ms", "obelisk", 1, Number.MAX_SAFE_INTEGER) ?? DEFAULT_TIMEOUT_MS,
    });
  }

  get home(): string {
    return this.#runtime.home;
  }

  get index_path(): string {
    return this.#runtime.index_path;
  }

  get source_instance(): string {
    return this.#runtime.source_instance;
  }

  /** Reported, never thrown for environment problems. Throws only for bad probe options. */
  probe(options: unknown = {}): Promise<ProbeResult> {
    return probeObelisk(this.#runtime, options);
  }

  /** Bounded search. Throws a typed failure; an empty `hits` is a successful call. */
  search(options: SearchOptions): Promise<SearchResult> {
    return runSearch(this.#runtime, options);
  }

  /** One bounded window, with the causal parent resolved on every message. */
  read(options: ReadOptions): Promise<ReadResult> {
    return runRead(this.#runtime, options);
  }
}

export type { ObeliskCapabilities, ProbeResult, SearchOptions, SearchResult, ReadOptions, ReadResult };
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
