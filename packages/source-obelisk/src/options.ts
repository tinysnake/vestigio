/**
 * Strict option handling.
 *
 * The pinned release silently ignores search options it does not know (that is
 * exactly how 0.3.0 ignores `projectPath`), so the adapter never forwards a
 * caller's object as-is: it accepts a closed set of keys, rejects everything
 * else by name, and refuses values the pinned release cannot honour. A caller
 * that passes `project` or `cwd` gets a loud error instead of a silent
 * whole-store result.
 */

import { isAbsolute, normalize, sep } from "node:path";
import { obeliskError } from "./errors.js";

export function readOptionObject(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw obeliskError("invalid_option", `${label} must be an object`, { option: label });
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw obeliskError(
      "unsupported_option",
      `${label} does not support ${unknown.map((key) => `"${key}"`).join(", ")}; supported keys are ${allowed
        .map((key) => `"${key}"`)
        .join(", ")}`,
      { option: `${label}.${unknown[0]}` },
    );
  }
  return record;
}

export function optionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw obeliskError("invalid_option", `${label}.${key} must be a string`, { option: `${label}.${key}` });
  }
  return value;
}

export function optionalNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = optionalString(record, key, label);
  if (value === undefined) return undefined;
  if (value.length === 0) {
    throw obeliskError("invalid_option", `${label}.${key} must not be empty`, { option: `${label}.${key}` });
  }
  return value;
}

export function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw obeliskError("invalid_option", `${label}.${key} must be a boolean`, { option: `${label}.${key}` });
  }
  return value;
}

export function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
  min: number,
  max: number,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw obeliskError(
      "invalid_option",
      `${label}.${key} must be an integer from ${min} to ${max} (got ${JSON.stringify(value)})`,
      { option: `${label}.${key}` },
    );
  }
  return value;
}

/**
 * Exact project scoping is the reason this adapter exists, so a project path is
 * only accepted absolute and already normalised: `..` and a trailing slash are
 * ambiguities the pinned release does not resolve for us (its own docs call
 * relative/symlinked roots unverified).
 */
export function requireAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) {
    throw obeliskError("invalid_option", `${label} must be an absolute path (got ${JSON.stringify(value)})`, {
      option: label,
    });
  }
  if (value.includes("\0")) {
    throw obeliskError("invalid_option", `${label} must not contain a NUL byte`, { option: label });
  }
  const normalised = normalize(value);
  if (value !== normalised) {
    throw obeliskError(
      "invalid_option",
      `${label} must be a normalised path: ${JSON.stringify(value)} normalises to ${JSON.stringify(normalised)}`,
      { option: label },
    );
  }
  if (value.length > 1 && value.endsWith(sep)) {
    throw obeliskError("invalid_option", `${label} must not end with a path separator`, { option: label });
  }
  return value;
}

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function optionalTimestamp(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = optionalString(record, key, label);
  if (value === undefined) return undefined;
  if (!ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw obeliskError(
      "invalid_option",
      `${label}.${key} must be an ISO 8601 timestamp with an explicit offset (got ${JSON.stringify(value)})`,
      { option: `${label}.${key}` },
    );
  }
  return value;
}
