import type { SourceRef } from "./types.js";
import { fail, readArray, readString } from "./primitives.js";
import { parseSourceRef } from "./parse.js";

function parseJson(text: unknown, path: string): unknown {
  const raw = readString(text, path);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fail(path, "invalid_json", "not valid JSON");
  }
}

/**
 * Canonical, key-ordered serialization. Round-trips through
 * `deserializeSourceRef` unchanged (deep equal), and the same ref always
 * serializes to the same bytes.
 */
export function serializeSourceRef(value: SourceRef, path = "$"): string {
  return JSON.stringify(parseSourceRef(value, path));
}

export function deserializeSourceRef(text: unknown, path = "$"): SourceRef {
  return parseSourceRef(parseJson(text, path), path);
}

export function serializeSourceRefs(values: readonly SourceRef[], path = "$"): string {
  return JSON.stringify(readArray(values, path).map((value, index) => parseSourceRef(value, `${path}[${index}]`)));
}

export function deserializeSourceRefs(text: unknown, path = "$"): SourceRef[] {
  return readArray(parseJson(text, path), path).map((value, index) =>
    parseSourceRef(value, `${path}[${index}]`),
  );
}
