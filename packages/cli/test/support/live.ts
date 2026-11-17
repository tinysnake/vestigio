/**
 * Live support for the CLI's three-layer proof.
 *
 * The fixture is built by `eval/fixtures/obelisk/build_fixture.sh`, which sets
 * `HOME` before it runs anything. The adapter additionally forces
 * `HOME=<home>` on every child and deletes `OBELISK_DIR`/`OBELISK_DB`/
 * `OBELISK_DB_PATH`, so pointing the port at this fixture cannot reach
 * `~/.obelisk`.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);

export const BUILD_SCRIPT = join(REPO_ROOT, "eval/fixtures/obelisk/build_fixture.sh");
/** PR-01's baseline harness, run as a subprocess with HOME pinned to the fixture. */
export const BASELINE_RUNNER = join(REPO_ROOT, "eval/baseline/run.mjs");
/** PR-01's recorded real-index run, for the scale comparison in the ledger. */
export const PR01_RECORDED_RUN = join(
  REPO_ROOT,
  "eval/baseline/out/run-2026-11-17T08-29-33-476Z.json",
);
export const OPERATOR_INDEX = "/Users/snake/.obelisk/obelisk.sqlite";

/** Fixture project paths and the exact message corpus the fixture writes. */
export const PROJECT_PATH = "/tmp/x_a";
export const OTHER_PROJECT_PATH = "/tmp/x-a";
/** Full texts of every project-A message the fixture indexes (order: a1, a2, a3). */
export const PROJECT_TEXTS = [
  "zqleak alpha first user message",
  "zqleak alpha first assistant reply",
  "zqleak alpha second user message",
];
/** The sibling project's only message; it must never surface for project A. */
export const FOREIGN_TEXT = "zqleak beta message in another project";

export type FixtureManifest = {
  readonly home: string;
  readonly index: string;
  readonly index_bytes: number;
  readonly cli_entry: string;
  readonly cli_version: string;
  readonly build_ms: number;
  readonly like_query_ms: number;
  readonly observed: {
    readonly exact_project_x_a_count: number;
    readonly exact_project_x_a_slugs: readonly string[];
    readonly like_leak_count: number;
    readonly like_leak_projects: readonly string[];
  };
};

export type Fixture = {
  readonly manifest: FixtureManifest;
  readonly cleanup: () => void;
};

export function pinnedEntry(): string {
  return require.resolve("@obelisk-apps/cli/dist/cli/src/obelisk.js");
}

export function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "vestigio-cli-live-"));
  const home = join(root, "home");
  const result = spawnSync(BUILD_SCRIPT, [home], { encoding: "utf8", cwd: REPO_ROOT });
  if (result.status !== 0) {
    throw new Error(`build_fixture.sh exited ${result.status}: ${result.stdout}${result.stderr}`);
  }
  const manifest = JSON.parse(readFileSync(join(home, "fixture-manifest.json"), "utf8")) as FixtureManifest;
  return { manifest, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** mtime in ms, or null when the file is not present on this machine. */
export function indexMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
