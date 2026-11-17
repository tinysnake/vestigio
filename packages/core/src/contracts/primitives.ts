import type { MemoryId, MemoryUri, Revision, StoreId } from "./types.js";

export type ValidationCode =
  | "invalid_json"
  | "invalid_type"
  | "missing_field"
  | "unknown_variant"
  | "invalid_format"
  | "out_of_range"
  | "invariant_violation";

export class ValidationError extends Error {
  readonly code: ValidationCode;
  readonly path: string;

  constructor(path: string, code: ValidationCode, detail: string) {
    super(`${path}: ${detail} (${code})`);
    this.name = "ValidationError";
    this.code = code;
    this.path = path;
  }
}

export function fail(path: string, code: ValidationCode, detail: string): never {
  throw new ValidationError(path, code, detail);
}

/** Unicode code points, so astral characters count once. */
export function codePointCount(text: string): number {
  return [...text].length;
}

/**
 * Non-whitespace Unicode code points. Whitespace is stripped before counting, so
 * padding a body with whitespace can never reach the medium length floor.
 */
export function nonWhitespaceCodePointCount(text: string): number {
  return [...text.replace(/\s/gu, "")].length;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const URI_PATTERN = /^memory:\/\/([^/\s]+)\/([^/\s]+)$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "invalid_type", "expected an object");
  }
  return value as Record<string, unknown>;
}

export function readField(record: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.hasOwn(record, key)) {
    fail(`${path}.${key}`, "missing_field", "required field is absent");
  }
  return record[key];
}

export function readString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    fail(path, "invalid_type", "expected a string");
  }
  return value;
}

export function readNonEmptyString(value: unknown, path: string): string {
  const text = readString(value, path);
  if (text.length === 0) {
    fail(path, "invalid_type", "expected a non-empty string");
  }
  return text;
}

export function readNullableString(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }
  return readNonEmptyString(value, path);
}

export function readInteger(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(path, "invalid_type", "expected an integer");
  }
  if (value < minimum) {
    fail(path, "out_of_range", `expected an integer >= ${minimum}`);
  }
  return value;
}

export function readNumber(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "invalid_type", "expected a finite number");
  }
  if (value < minimum) {
    fail(path, "out_of_range", `expected a number >= ${minimum}`);
  }
  return value;
}

export function readNumberOrNull(value: unknown, path: string, minimum = 0): number | null {
  if (value === null) {
    return null;
  }
  return readNumber(value, path, minimum);
}

export function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(path, "invalid_type", "expected an array");
  }
  return value;
}

export function readUnion<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(path, "unknown_variant", `expected one of ${allowed.join(" | ")}; unknown values are rejected, not coerced`);
  }
  return value as T;
}

export function readNullable<T>(
  value: unknown,
  path: string,
  parse: (value: unknown, path: string) => T,
): T | null {
  if (value === null) {
    return null;
  }
  return parse(value, path);
}

export function parseStoreId(value: unknown, path = "$"): StoreId {
  const text = readNonEmptyString(value, path);
  if (!ID_PATTERN.test(text)) {
    fail(path, "invalid_format", "store id must match [A-Za-z0-9][A-Za-z0-9._~-]*");
  }
  return text;
}

export function parseMemoryId(value: unknown, path = "$"): MemoryId {
  const text = readNonEmptyString(value, path);
  if (!ID_PATTERN.test(text)) {
    fail(path, "invalid_format", "memory id must match [A-Za-z0-9][A-Za-z0-9._~-]*");
  }
  return text;
}

export function memoryUri(storeId: StoreId, memoryId: MemoryId): MemoryUri {
  return `memory://${parseStoreId(storeId)}/${parseMemoryId(memoryId)}`;
}

export function parseMemoryUri(value: unknown, path = "$"): MemoryUri {
  const text = readNonEmptyString(value, path);
  const match = URI_PATTERN.exec(text);
  if (match === null) {
    fail(path, "invalid_format", "expected memory://<store-id>/<memory-id>");
  }
  const storeId = parseStoreId(match[1], path);
  const memoryId = parseMemoryId(match[2], path);
  return `memory://${storeId}/${memoryId}`;
}

export function splitMemoryUri(uri: unknown, path = "$"): { storeId: StoreId; memoryId: MemoryId } {
  const text = parseMemoryUri(uri, path);
  const match = URI_PATTERN.exec(text);
  const storeId = match?.[1];
  const memoryId = match?.[2];
  if (storeId === undefined || memoryId === undefined) {
    fail(path, "invalid_format", "expected memory://<store-id>/<memory-id>");
  }
  return { storeId, memoryId };
}

export function parseRevision(value: unknown, path = "$"): Revision {
  return readInteger(value, path, 1);
}

export function parseTimestamp(value: unknown, path = "$"): string {
  const text = readNonEmptyString(value, path);
  if (!ISO_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    fail(path, "invalid_format", "expected an ISO 8601 timestamp with an explicit offset");
  }
  return text;
}
