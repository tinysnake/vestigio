import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Memory, NavSummary } from "../../src/contracts/index.js";
import { openStore, type MemoryStore, type OpenStoreOptions } from "../../src/storage/index.js";
import { makeMemory, makeNav, makeSourceRef } from "../support.js";

/** A fresh, isolated SQLite file under the OS temp dir. */
export function tempDbPath(label = "store"): string {
  const dir = mkdtempSync(join(tmpdir(), "vestigio-store-"));
  return join(dir, `${label}.db`);
}

export function openTempStore(options: Partial<OpenStoreOptions> = {}): MemoryStore {
  return openStore({ path: options.path ?? tempDbPath(), ...options });
}

/**
 * A body that actually contains the words a query will look for, padded with
 * filler text until it clears the frozen 500 non-whitespace code point floor.
 */
export function bodyWith(prefix: string, filler = "补充说明部署步骤与回滚方式。"): string {
  let body = prefix;
  while ([...body.replace(/\s/gu, "")].length < 520) {
    body += filler;
  }
  return body;
}

type MemoryOverrides = Partial<Memory> & { body?: string; memory_id?: string };

export function storedMemory({ body, memory_id: memoryId = "mem-0001", ...rest }: MemoryOverrides = {}): Memory {
  const base = makeMemory({
    memory_id: memoryId,
    uri: `memory://vestigio/${memoryId}`,
    ...rest,
  });
  if (body === undefined) {
    return base;
  }
  return {
    ...base,
    medium: {
      body,
      body_char_count: [...body.replace(/\s/gu, "")].length,
      sources: rest.medium?.sources ?? [makeSourceRef()],
    },
  };
}

export function navWith(text: string, sourceRevision = 1): NavSummary {
  return { text, char_count: [...text].length, source_revision: sourceRevision };
}

export function memoryAtRevision(revision: number, overrides: MemoryOverrides = {}): Memory {
  const base = storedMemory(overrides);
  return {
    ...base,
    revision,
    nav: base.nav === null ? null : { ...base.nav, source_revision: revision },
    updated_at: overrides.updated_at ?? `2026-11-17T17:0${Math.min(revision, 9)}:00Z`,
  };
}

export { makeNav, makeSourceRef };
