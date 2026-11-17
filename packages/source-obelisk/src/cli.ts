/**
 * The process boundary.
 *
 * Everything the adapter knows about history comes from a child process running
 * the pinned CLI with `HOME` pointed at an isolated directory. The adapter never
 * imports Obelisk internals, never opens the index itself, and never runs a
 * command that writes provider history or memory: only `--version`, `--search`
 * and `--query` with the fixed read-only scripts in `src/scripts/`.
 *
 * `--search` and `--query` do refresh the derived query index; that is the
 * tool's normal read path and is recorded in the capability table, not worked
 * around.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { obeliskError } from "./errors.js";
import { OBELISK_CLI_ENTRY, OBELISK_PACKAGE } from "./pinned.js";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export type CliLocation = {
  /** Absolute path to the CLI's JS entry point. */
  readonly entry: string;
  /** Version declared by the installed package, when it can be read without spawning. */
  readonly declared_version: string | null;
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the CLI. With no explicit path this is the pinned dependency resolved
 * from this package's own `node_modules`, which is what makes the pin real: the
 * operator's global 0.3.0 is never used.
 */
export function resolveCli(explicit_entry?: string): CliLocation {
  if (explicit_entry !== undefined) {
    if (!isFile(explicit_entry)) {
      throw obeliskError("unavailable", `Obelisk CLI entry not found: ${explicit_entry}`, {
        option: "cli_path",
      });
    }
    return { entry: explicit_entry, declared_version: null };
  }

  const require = createRequire(import.meta.url);
  let entry: string;
  try {
    entry = require.resolve(`${OBELISK_PACKAGE}/${OBELISK_CLI_ENTRY}`);
  } catch (error) {
    throw obeliskError(
      "unavailable",
      `cannot resolve ${OBELISK_PACKAGE} from this package; run the workspace install`,
      {},
      { cause: error },
    );
  }
  if (!isFile(entry)) {
    throw obeliskError("unavailable", `resolved ${OBELISK_PACKAGE} entry is not a file: ${entry}`);
  }

  let declared_version: string | null = null;
  try {
    const package_json = require.resolve(`${OBELISK_PACKAGE}/package.json`);
    const parsed: unknown = JSON.parse(readFileSync(package_json, "utf8"));
    if (parsed !== null && typeof parsed === "object" && "version" in parsed) {
      const version = (parsed as { version: unknown }).version;
      declared_version = typeof version === "string" ? version : null;
    }
  } catch {
    declared_version = null;
  }

  return { entry, declared_version };
}

export type SpawnRequest = {
  readonly entry: string;
  readonly args: readonly string[];
  readonly home: string;
  readonly timeout_ms: number;
  readonly signal: AbortSignal | undefined;
};

export type SpawnResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code: number;
  /** Wall time from spawn to exit: the direct-CLI baseline for overhead accounting. */
  readonly child_ms: number;
};

function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
  // Nothing outside `home` may redirect Obelisk's state directory.
  delete env["OBELISK_DIR"];
  delete env["OBELISK_DB"];
  delete env["OBELISK_DB_PATH"];
  return env;
}

/** Spawn the pinned CLI and settle once, on exit, timeout or abort. */
export function spawnCli(request: SpawnRequest): Promise<SpawnResult> {
  const { entry, args, home, timeout_ms, signal } = request;

  if (signal?.aborted === true) {
    return Promise.reject(obeliskError("cli_cancelled", "Obelisk call was cancelled before it started"));
  }

  const started_at = performance.now();
  const cwd = existsSync(home) ? home : tmpdir();

  return new Promise<SpawnResult>((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env: childEnv(home),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer =
      timeout_ms > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
            finish(
              () =>
                reject(
                  obeliskError("cli_timeout", `Obelisk CLI exceeded ${timeout_ms} ms and was killed`, {
                    stderr: Buffer.concat(stderr).toString("utf8").trim(),
                  }),
                ),
            );
          }, timeout_ms)
        : undefined;

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      action();
    }

    function onAbort(): void {
      child.kill("SIGKILL");
      finish(() => reject(obeliskError("cli_cancelled", "Obelisk call was cancelled")));
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            obeliskError("protocol", `Obelisk CLI wrote more than ${MAX_OUTPUT_BYTES} bytes to stdout`, {
              expected: "a bounded result set",
            }),
          ),
        );
        return;
      }
      stdout.push(chunk);
    });
    // stderr is diagnostic only. The CLI warns about skipped pi artifacts
    // (observation-pack ledgers) on every build, so a non-empty stderr says
    // nothing about the call's success: only the exit code and stdout JSON do.
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });

    child.once("error", (error) => {
      finish(() =>
        reject(obeliskError("unavailable", `cannot start the Obelisk CLI: ${error.message}`, {}, { cause: error })),
      );
    });

    child.once("close", (code) => {
      finish(() =>
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exit_code: code ?? -1,
          child_ms: performance.now() - started_at,
        }),
      );
    });
  });
}

/** One parsed JSON value printed by the CLI, or a typed failure. */
export function parseCliJson(run: SpawnResult, args: readonly string[]): unknown {
  const text = run.stdout.trim();
  if (run.exit_code !== 0) {
    const reported = readReportedError(text);
    throw obeliskError("cli_error", reported ?? `Obelisk exited ${run.exit_code} for ${args.join(" ")}`, {
      exit_code: run.exit_code,
      stderr: run.stderr.trim(),
    });
  }
  if (text.length === 0) {
    throw obeliskError("protocol", "Obelisk printed no JSON", {
      expected: "one JSON value on stdout",
      exit_code: 0,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw obeliskError(
      "protocol",
      `Obelisk printed something that is not JSON: ${text.slice(0, 200)}`,
      { expected: "one JSON value on stdout" },
      { cause: error },
    );
  }
}

function readReportedError(text: string): string | null {
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
      const message = (parsed as { error: unknown }).error;
      if (typeof message === "string" && message.length > 0) return message;
    }
    return null;
  } catch {
    return null;
  }
}
