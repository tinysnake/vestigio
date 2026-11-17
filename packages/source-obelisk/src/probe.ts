/**
 * The capability probe.
 *
 * The probe answers one question with three parts: is the pinned release the
 * one installed, is there an index to read, and what may the caller rely on.
 * It reports rather than throws, so "Obelisk is unavailable" is a stated
 * condition with a reason — never an empty result set.
 *
 * The capability list is the one measured for `OBELISK_VERSION` (see
 * docs/probes/obelisk-adapter-findings.md). It is only handed out when the
 * running release is that exact version; otherwise `capabilities` is null,
 * because a table measured on 0.3.2 says nothing about 0.3.0's ignored filters.
 */

import { existsSync } from "node:fs";
import { resolveCli, spawnCli } from "./cli.js";
import { type ObeliskError, type ObeliskErrorKind, isObeliskError, obeliskError } from "./errors.js";
import {
  DEFAULT_TIMEOUT_MS,
  type ObeliskCapabilities,
  OBELISK_VERSION,
  VERIFIED_CAPABILITIES,
} from "./pinned.js";
import { optionalInteger, readOptionObject } from "./options.js";
import type { CliRuntime } from "./runtime.js";

const PROBE_ALLOWED_KEYS = ["timeout_ms", "signal"] as const;

export type ProbeReason =
  | "cli_missing"
  | "version_mismatch"
  | "index_missing"
  | "cli_error"
  | "cli_timeout"
  | "cli_cancelled"
  | "protocol";

export type ProbeResult = {
  /** True only when the pinned release answered and an index exists. */
  readonly available: boolean;
  /** Why it is not available; null when it is. */
  readonly reason: ProbeReason | null;
  /** The typed failure behind `reason`, for callers that want the error object. */
  readonly error: { readonly kind: ObeliskErrorKind; readonly message: string } | null;
  readonly cli: {
    readonly entry: string | null;
    /** Version in the installed package.json, read without spawning. */
    readonly declared_version: string | null;
    /** Version printed by `--version`. */
    readonly reported_version: string | null;
    readonly pinned_version: string;
    readonly version_matches: boolean;
  };
  readonly data: {
    readonly home: string;
    readonly index_path: string;
    readonly index_present: boolean;
  };
  readonly capabilities: ObeliskCapabilities | null;
  readonly capabilities_source: "pinned-table" | "none";
  readonly checked_at: string;
  readonly duration_ms: number;
};

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function reasonFor(kind: ObeliskErrorKind): ProbeReason {
  switch (kind) {
    case "unavailable":
      return "cli_missing";
    case "version_mismatch":
      return "version_mismatch";
    case "index_missing":
      return "index_missing";
    case "cli_timeout":
      return "cli_timeout";
    case "cli_cancelled":
      return "cli_cancelled";
    case "protocol":
      return "protocol";
    default:
      return "cli_error";
  }
}

function reported(error: unknown): ObeliskError {
  return isObeliskError(error)
    ? error
    : obeliskError("unavailable", error instanceof Error ? error.message : String(error), {}, { cause: error });
}

export async function probeObelisk(runtime: CliRuntime, options: unknown = {}): Promise<ProbeResult> {
  const record = readOptionObject(options, PROBE_ALLOWED_KEYS, "probe");
  const timeout_ms = optionalInteger(record, "timeout_ms", "probe", 1, Number.MAX_SAFE_INTEGER) ?? DEFAULT_TIMEOUT_MS;
  const signal_value = record["signal"];
  if (signal_value !== undefined && !(signal_value instanceof AbortSignal)) {
    throw obeliskError("invalid_option", "probe.signal must be an AbortSignal", { option: "probe.signal" });
  }
  const signal = signal_value instanceof AbortSignal ? signal_value : undefined;

  const started_at = performance.now();
  const index_present = existsSync(runtime.index_path);

  const base = {
    data: { home: runtime.home, index_path: runtime.index_path, index_present },
    cli: {
      entry: null as string | null,
      declared_version: null as string | null,
      reported_version: null as string | null,
      pinned_version: OBELISK_VERSION,
      version_matches: false,
    },
    capabilities: null as ObeliskCapabilities | null,
    capabilities_source: "none" as "pinned-table" | "none",
    checked_at: new Date().toISOString(),
  };

  const finish = (
    reason: ProbeReason | null,
    error: ObeliskError | null,
  ): ProbeResult => ({
    ...base,
    available: reason === null,
    reason,
    error: error === null ? null : { kind: error.kind, message: error.message },
    duration_ms: performance.now() - started_at,
  });

  let entry: string;
  let declared_version: string | null;
  try {
    const location = resolveCli(runtime.cli_path);
    entry = location.entry;
    declared_version = location.declared_version;
  } catch (error) {
    const failure = reported(error);
    return finish(reasonFor(failure.kind), failure);
  }
  base.cli.entry = entry;
  base.cli.declared_version = declared_version;

  let reported_version: string;
  try {
    const run = await spawnCli({ entry, args: ["--version"], home: runtime.home, timeout_ms, signal });
    if (run.exit_code !== 0) {
      throw obeliskError("cli_error", `Obelisk --version exited ${run.exit_code}`, {
        exit_code: run.exit_code,
        stderr: run.stderr.trim(),
      });
    }
    const text = run.stdout.trim();
    if (!VERSION_PATTERN.test(text)) {
      throw obeliskError("protocol", `Obelisk --version printed ${JSON.stringify(text)}`, {
        expected: "a bare version number",
      });
    }
    reported_version = text;
  } catch (error) {
    const failure = reported(error);
    return finish(reasonFor(failure.kind), failure);
  }
  base.cli.reported_version = reported_version;

  const declared_matches = declared_version === null || declared_version === OBELISK_VERSION;
  base.cli.version_matches = declared_matches && reported_version === OBELISK_VERSION;

  if (!base.cli.version_matches) {
    return finish(
      "version_mismatch",
      obeliskError(
        "version_mismatch",
        `Obelisk is ${reported_version} (package ${declared_version ?? "unknown"}), the adapter is pinned to ${OBELISK_VERSION}`,
        { expected: OBELISK_VERSION },
      ),
    );
  }

  if (!index_present) {
    return finish(
      "index_missing",
      obeliskError("index_missing", `no Obelisk index at ${runtime.index_path}; nothing may be read`, {
        option: "home",
      }),
    );
  }

  return {
    ...finish(null, null),
    capabilities: VERIFIED_CAPABILITIES,
    capabilities_source: "pinned-table",
  };
}
