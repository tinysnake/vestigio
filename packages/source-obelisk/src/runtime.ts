/**
 * Per-adapter runtime: where the CLI is, where the isolated index is, and the
 * only way to run either. Nothing here caches history; the only cache is the
 * resolved CLI location, which is filesystem metadata.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliLocation, type SpawnResult, parseCliJson, resolveCli, spawnCli } from "./cli.js";
import { obeliskError } from "./errors.js";
import { INDEX_RELATIVE_PATH, OBELISK_PACKAGE, OBELISK_VERSION } from "./pinned.js";
import { type ScriptName, renderScript } from "./scripts.js";

export type RunOptions = {
  readonly timeout_ms: number;
  readonly signal: AbortSignal | undefined;
};

export type Ran = {
  readonly value: unknown;
  readonly child_ms: number;
};

const SCRIPT_DIR_PREFIX = "obelisk-query-";

export class CliRuntime {
  readonly home: string;
  readonly index_path: string;
  readonly source_instance: string;
  readonly default_timeout_ms: number;
  readonly cli_path: string | undefined;
  #location: CliLocation | undefined;

  constructor(options: {
    home: string;
    source_instance: string;
    default_timeout_ms: number;
    cli_path: string | undefined;
  }) {
    this.home = options.home;
    this.index_path = join(options.home, INDEX_RELATIVE_PATH);
    this.source_instance = options.source_instance;
    this.default_timeout_ms = options.default_timeout_ms;
    this.cli_path = options.cli_path;
  }

  /**
   * The pinned release, or a typed failure. The declared version is checked
   * from the installed package before any spawn, so a different release can
   * never quietly serve reads with this capability table.
   */
  location(): CliLocation {
    if (this.#location !== undefined) return this.#location;
    const location = resolveCli(this.cli_path);
    if (location.declared_version !== null && location.declared_version !== OBELISK_VERSION) {
      throw obeliskError(
        "version_mismatch",
        `installed ${OBELISK_PACKAGE} is ${location.declared_version}, the adapter is pinned to ${OBELISK_VERSION}`,
        { expected: OBELISK_VERSION },
      );
    }
    this.#location = location;
    return location;
  }

  /** A missing index is a distinct failure: the CLI would otherwise create one and report no hits. */
  ensureIndex(): string {
    if (!existsSync(this.index_path)) {
      throw obeliskError("index_missing", `no Obelisk index at ${this.index_path}; nothing may be read`, {
        option: "home",
      });
    }
    return this.index_path;
  }

  async run(args: readonly string[], options: RunOptions): Promise<Ran> {
    const location = this.location();
    const run: SpawnResult = await spawnCli({
      entry: location.entry,
      args,
      home: this.home,
      timeout_ms: options.timeout_ms,
      signal: options.signal,
    });
    return { value: parseCliJson(run, args), child_ms: run.child_ms };
  }

  /**
   * Run one of the fixed templates. The script is written to a private temp
   * file because that is the only way `--query` accepts a program; its content
   * is the reviewed template plus one JSON literal.
   */
  async runScript(
    name: ScriptName,
    input: Record<string, unknown>,
    options: RunOptions,
  ): Promise<Ran> {
    const dir = mkdtempSync(join(tmpdir(), SCRIPT_DIR_PREFIX));
    try {
      const file = join(dir, "query.mjs");
      writeFileSync(file, renderScript(name, input), { encoding: "utf8", mode: 0o600 });
      return await this.run(["--query", file], options);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
