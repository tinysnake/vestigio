/**
 * Live-test support: an isolated fixture and the same CLI the adapter pins.
 *
 * The fixture is built by `eval/fixtures/obelisk/build_fixture.sh`, which sets
 * `HOME` before it runs anything. Nothing in this file can reach
 * `~/.obelisk`: every spawn gets an explicit `HOME` inside a temp directory.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);

export const BUILD_SCRIPT = join(REPO_ROOT, "eval/fixtures/obelisk/build_fixture.sh");
export const QUERIES = {
  leak: join(REPO_ROOT, "eval/fixtures/obelisk/like_leak.query.mjs"),
  rows: join(REPO_ROOT, "eval/fixtures/obelisk/evidence_rows.query.mjs"),
};

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

export type CliResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
};

/** The CLI entry of the pinned dependency, resolved from this package. */
export function pinnedEntry(): string {
  return require.resolve("@obelisk-apps/cli/dist/cli/src/obelisk.js");
}

export function runCli(home: string, args: readonly string[]): CliResult {
  const started = performance.now();
  const result = spawnSync(process.execPath, [pinnedEntry(), ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ms: performance.now() - started,
  };
}

export function runQuery<T>(home: string, script: string): T {
  const result = runCli(home, ["--query", script]);
  if (result.status !== 0) {
    throw new Error(`--query ${script} exited ${result.status}: ${result.stdout}${result.stderr}`);
  }
  return JSON.parse(result.stdout) as T;
}

export type Fixture = {
  readonly manifest: FixtureManifest;
  readonly cleanup: () => void;
};

export function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "vestigio-live-"));
  const home = join(root, "home");
  const result = spawnSync(BUILD_SCRIPT, [home], { encoding: "utf8", cwd: REPO_ROOT });
  if (result.status !== 0) {
    throw new Error(`build_fixture.sh exited ${result.status}: ${result.stdout}${result.stderr}`);
  }
  const manifest = JSON.parse(readFileSync(join(home, "fixture-manifest.json"), "utf8")) as FixtureManifest;
  return {
    manifest,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A copy of a fixture, so a rebuild test cannot disturb the shared one. */
export function copyFixture(source: Fixture): Fixture {
  const root = mkdtempSync(join(tmpdir(), "vestigio-live-copy-"));
  const home = join(root, "home");
  const result = spawnSync("cp", ["-R", source.manifest.home, home], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cp -R exited ${result.status}: ${result.stderr}`);
  const manifest = JSON.parse(readFileSync(join(home, "fixture-manifest.json"), "utf8")) as FixtureManifest;
  return { manifest, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Replace one message's text in a fixture transcript (same id, new content). */
export function rewriteMessageText(home: string, from: string, to: string): void {
  const path = join(home, ".pi/agent/sessions/projA/sessA.jsonl");
  const text = readFileSync(path, "utf8");
  if (!text.includes(from)) throw new Error(`transcript does not contain ${JSON.stringify(from)}`);
  writeFileSync(path, text.replace(from, to));
}

export function assertFile(path: string): void {
  if (!existsSync(path)) throw new Error(`missing ${path}`);
}
