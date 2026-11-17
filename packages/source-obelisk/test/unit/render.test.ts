import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnCli } from "../../src/cli.js";
import { encodeInput, renderScript } from "../../src/scripts.js";
import { argvLog, fakeSource, FAKE_CLI, resetFakeEnv, setFakeEnv, writeIndex } from "../support/fake.js";

/** A directory name with everything a shell would mangle. */
const NASTY_DIR = join(tmpdir(), `vestigio $() ' "\` ; & | test`);

/** Text that would be code if it were ever spliced into a program. */
const NASTY_TEXT = [
  'quotes " \' backtick ` dollar ${process.exit(1)} semicolon ; rm -rf /',
  "newline\nand\ttab",
  "line-separator \u2028 paragraph \u2029 done",
].join(" | ");

let cleanup: (() => void) | undefined;

afterEach(() => {
  resetFakeEnv();
  cleanup?.();
  cleanup = undefined;
});

/** The JSON literal the template's first line carries, read without assuming its content. */
function literalOf(script: string): unknown {
  const marker = "const input = ";
  const at = script.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = at + marker.length;
  let depth = 0;
  let in_string = false;
  let escaped = false;
  for (let i = start; i < script.length; i += 1) {
    const ch = script[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      in_string = !in_string;
    } else if (!in_string && (ch === "{" || ch === "[")) {
      depth += 1;
    } else if (!in_string && (ch === "}" || ch === "]")) {
      depth -= 1;
      if (depth === 0) return JSON.parse(script.slice(start, i + 1));
    }
  }
  throw new Error("no complete literal in the rendered script");
}

describe("renderScript", () => {
  it("substitutes exactly one JSON literal and leaves no token behind", () => {
    const script = renderScript("search", { text: NASTY_TEXT, limit: 5 });
    expect(script).not.toContain("__OBELISK_INPUT__");
    expect(literalOf(script)).toMatchObject({ text: NASTY_TEXT, limit: 5 });
    expect(new Function(`return (function () { ${script} })`)).not.toThrow();
  });

  it("escapes line separators so the literal survives a re-parse", () => {
    const json = encodeInput({ text: "a\u2028b\u2029c" });
    expect(json).not.toContain("\u2028");
    expect(JSON.parse(json)).toEqual({ text: "a\u2028b\u2029c" });
  });

  it("fails loudly for a script name it does not own", () => {
    expect(() => renderScript("nope" as "search", {})).toThrow();
  });
});

describe("hostile paths", () => {
  it("passes a hostile script path as one argv element and the payload as data", async () => {
    mkdirSync(NASTY_DIR, { recursive: true });
    const home = mkdtempSync(join(NASTY_DIR, "home-"));
    writeIndex(home);
    cleanup = () => rmSync(NASTY_DIR, { recursive: true, force: true });

    const script = renderScript("search", {
      text: NASTY_TEXT,
      limit: 20,
      context_limit: 0,
      include_meta: false,
      include_inactive: false,
      project_path: NASTY_DIR,
      session_id: null,
      after: null,
      before: null,
      source: null,
      session_lookup_limit: 11,
    });
    const scriptDir = mkdtempSync(join(NASTY_DIR, "obelisk-query-"));
    const scriptPath = join(scriptDir, "query.mjs");
    writeFileSync(scriptPath, script);

    setFakeEnv({ FAKE_OBELISK_ECHO_SCRIPT: "1" });
    const run = await spawnCli({
      entry: FAKE_CLI,
      args: ["--query", scriptPath],
      home,
      timeout_ms: 5_000,
      signal: undefined,
    });

    const echoed = JSON.parse(run.stdout) as { argv: string[]; script: string; home: string };
    expect(echoed.argv).toEqual(["--query", scriptPath]);
    expect(echoed.argv[1]).toContain("vestigio $() ' \"` ; & | test");
    expect(echoed.script).toBe(script);
    expect(echoed.home).toBe(home);
    expect(literalOf(echoed.script)).toMatchObject({ text: NASTY_TEXT, project_path: NASTY_DIR });
  });

  it("keeps the payload as one --search argument", async () => {
    const home = mkdtempSync(join(tmpdir(), "vestigio-argv-"));
    cleanup = () => rmSync(home, { recursive: true, force: true });
    const log = join(home, "argv.log");
    writeIndex(home);
    setFakeEnv({ FAKE_OBELISK_ARGV_LOG: log, FAKE_OBELISK_SEARCH: "[]" });

    await fakeSource(home).search({ text: NASTY_TEXT });

    const argv = argvLog(log)[0] ?? [];
    expect(argv[0]).toBe("--search");
    expect(argv[1]).toBe(NASTY_TEXT);
    expect(argv.filter((value) => value === "--search")).toHaveLength(1);
  });
});
