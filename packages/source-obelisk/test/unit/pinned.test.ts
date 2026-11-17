import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_LIMIT_MAX,
  CONTEXT_LIMIT_MIN,
  MESSAGES_WINDOW_MAX,
  OBELISK_PACKAGE,
  OBELISK_TARBALL_INTEGRITY,
  OBELISK_VERSION,
  QUERY_NONCE_WAIT_MS,
  VERIFIED_CAPABILITIES,
} from "../../src/pinned.js";

const PACKAGE_JSON = fileURLToPath(new URL("../../package.json", import.meta.url));
const LOCKFILE = fileURLToPath(new URL("../../../../pnpm-lock.yaml", import.meta.url));
const require = createRequire(import.meta.url);

describe("the pin", () => {
  it("is one exact version in the dependency spec and in the code", () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies[OBELISK_PACKAGE]).toBe(OBELISK_VERSION);
    expect(OBELISK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is the installed package, not whatever is on PATH", () => {
    const installed = require(`${OBELISK_PACKAGE}/package.json`) as { version: string };
    expect(installed.version).toBe(OBELISK_VERSION);
  });

  it("records the tarball integrity the lockfile resolved", () => {
    const lock = readFileSync(LOCKFILE, "utf8");
    expect(lock).toContain(`'${OBELISK_PACKAGE}@${OBELISK_VERSION}':`);
    expect(lock).toContain(OBELISK_TARBALL_INTEGRITY);
  });
});

describe("the capability table", () => {
  it("describes exactly the pinned release's measured limits", () => {
    expect(VERIFIED_CAPABILITIES.exact_project_path).toBe(true);
    expect(VERIFIED_CAPABILITIES.project_and_cwd_are_like_patterns).toBe(true);
    expect(VERIFIED_CAPABILITIES.context_limit).toEqual({ min: CONTEXT_LIMIT_MIN, max: CONTEXT_LIMIT_MAX });
    expect(VERIFIED_CAPABILITIES.messages_window_max).toBe(MESSAGES_WINDOW_MAX);
    expect(VERIFIED_CAPABILITIES.messages_relations).toEqual(["timeline", "parents"]);
    expect(VERIFIED_CAPABILITIES.parents_requires_after_count_zero).toBe(true);
    expect(VERIFIED_CAPABILITIES.hidden_rows_never_returned).toBe(true);
    expect(VERIFIED_CAPABILITIES.inactive_rows_require_include_inactive).toBe(true);
    expect(VERIFIED_CAPABILITIES.unknown_messages_option_is_an_error).toBe(true);
    expect(VERIFIED_CAPABILITIES.search_and_query_refresh_query_index).toBe(true);
    expect(VERIFIED_CAPABILITIES.parent_uuid_available_for_reads).toBe(true);
    expect(VERIFIED_CAPABILITIES.query_nonce_wait_ms).toBe(QUERY_NONCE_WAIT_MS);
  });

  it("keeps the bounded-read numbers from drifting", () => {
    expect(CONTEXT_LIMIT_MIN).toBe(0);
    expect(CONTEXT_LIMIT_MAX).toBe(6);
    expect(MESSAGES_WINDOW_MAX).toBe(500);
    expect(QUERY_NONCE_WAIT_MS).toBe(4_000);
  });
});
