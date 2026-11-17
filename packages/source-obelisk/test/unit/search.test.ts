import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isObeliskError } from "../../src/errors.js";
import {
  argvLog,
  fakeSource,
  hitJson,
  makeTempHome,
  rejectionKind,
  resetFakeEnv,
  scriptHitJson,
  scriptSearchJson,
  setFakeEnv,
  writeIndex,
  type TempHome,
} from "../support/fake.js";

let temp: TempHome | undefined;

afterEach(() => {
  resetFakeEnv();
  temp?.cleanup();
  temp = undefined;
});

function prepared(): { home: string; log: string } {
  temp = makeTempHome();
  writeIndex(temp.home);
  const log = join(temp.home, "argv.log");
  setFakeEnv({ FAKE_OBELISK_ARGV_LOG: log });
  return { home: temp.home, log };
}

function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

describe("search — fast path", () => {
  it("passes the project by path, never by slug", async () => {
    const { home, log } = prepared();
    setFakeEnv({
      FAKE_OBELISK_ARGV_LOG: log,
      FAKE_OBELISK_SEARCH: JSON.stringify([hitJson()]),
    });

    await fakeSource(home).search({ text: "zqleak", project_path: "/tmp/x_a" });

    expect(argvLog(log)).toEqual([
      ["--search", "zqleak", "--limit", "20", "--context-limit", "0", "--project-path", "/tmp/x_a"],
    ]);
  });

  it("maps a hit to a SourceRef and says the causal parent is unresolved", async () => {
    const { home } = prepared();
    setFakeEnv({ FAKE_OBELISK_SEARCH: JSON.stringify([hitJson()]) });

    const result = await fakeSource(home).search({ text: "zqleak" });

    expect(result.evidence).toBe("ids_only");
    expect(result.query.text).toBe("zqleak");
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    expect(hit.source_ref).toMatchObject({
      provider: "pi",
      source_instance: "local",
      // `--search` carries no project_path, so an unscoped hit names the
      // derived slug and says so, rather than pretending it is exact.
      project_id: "-tmp-x_a",
      parent_message_id: null,
      locator: null,
    });
    expect(hit.project_resolved).toBe(false);
    expect(hit.source_ref.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hit.timestamp).toBe("2026-01-01T00:00:01.000Z");
    expect(result.timing.child_ms).toBeGreaterThanOrEqual(0);
  });

  it("uses the requested project path as the identity once the scope is verified", async () => {
    const { home } = prepared();
    setFakeEnv({ FAKE_OBELISK_SEARCH: JSON.stringify([hitJson()]) });

    const result = await fakeSource(home).search({ text: "zqleak", project_path: "/tmp/x_a" });

    expect(result.hits[0]?.source_ref.project_id).toBe("/tmp/x_a");
    expect(result.hits[0]?.project_resolved).toBe(true);
  });

  it("returns an empty list, not an error, when nothing matches", async () => {
    const { home } = prepared();
    setFakeEnv({ FAKE_OBELISK_SEARCH: "[]" });

    const result = await fakeSource(home).search({ text: "zzzznomatchzzz" });

    expect(result.hits).toEqual([]);
    expect(result.evidence).toBe("ids_only");
  });

  it("raises project_scope when the child returns another project's row", async () => {
    const { home } = prepared();
    setFakeEnv({
      FAKE_OBELISK_SEARCH: JSON.stringify([
        hitJson({ session: { project: "-tmp-x-a", project_path: "/tmp/x-a" } }),
      ]),
    });

    const error = await errorOf(fakeSource(home).search({ text: "zqleak", project_path: "/tmp/x_a" }));

    expect(isObeliskError(error) && error.kind).toBe("project_scope");
    expect((error as Error).message).toContain("-tmp-x-a");
  });

  it("surfaces a CLI failure as cli_error with the child's message", async () => {
    const { home } = prepared();
    setFakeEnv({
      FAKE_OBELISK_EXIT: "3",
      FAKE_OBELISK_STDOUT: JSON.stringify({ error: "SQLiteError: no such table: messages" }),
    });

    const error = await errorOf(fakeSource(home).search({ text: "zqleak" }));

    expect(isObeliskError(error) && error.kind).toBe("cli_error");
    expect((error as Error).message).toContain("no such table");
    expect(isObeliskError(error) && error.detail["exit_code"]).toBe(3);
  });

  it("does not treat stderr warnings as failure", async () => {
    const { home } = prepared();
    setFakeEnv({
      FAKE_OBELISK_SEARCH: JSON.stringify([hitJson()]),
      FAKE_OBELISK_STDERR:
        "Warning: skipped pi artifact /h/.pi/agent/sessions/observation-pack/ledger.jsonl: Unsupported or malformed Pi session header\n",
    });

    await expect(fakeSource(home).search({ text: "zqleak" })).resolves.toMatchObject({ evidence: "ids_only" });
  });
});

describe("search — script path", () => {
  it("resolves evidence through one --query call and scopes by exact project_path", async () => {
    const { home, log } = prepared();
    setFakeEnv({
      FAKE_OBELISK_ARGV_LOG: log,
      FAKE_OBELISK_QUERY: JSON.stringify(scriptSearchJson([scriptHitJson({ project_path: "/tmp/x_a" })])),
    });

    const result = await fakeSource(home).search({ text: "zqleak", project_path: "/tmp/x_a", resolve_evidence: true });

    expect(result.evidence).toBe("resolved");
    expect(result.hits[0]?.source_ref.locator).toContain("#");
    expect(result.hits[0]?.source_ref.parent_message_id).toBeNull();
    const argv = argvLog(log);
    expect(argv).toHaveLength(1);
    expect(argv[0]?.[0]).toBe("--query");
  });

  it("refuses to trust a scoped result whose project_path is missing", async () => {
    const { home } = prepared();
    setFakeEnv({
      FAKE_OBELISK_QUERY: JSON.stringify(scriptSearchJson([scriptHitJson({ project_path: null })])),
    });

    const error = await errorOf(
      fakeSource(home).search({ text: "zqleak", project_path: "/tmp/x_a", include_meta: true }),
    );

    expect(isObeliskError(error) && error.kind).toBe("protocol");
  });
});

describe("search — session scoping", () => {
  it("pays one lookup and reports session_not_found when zero hits hide an absent session", async () => {
    const { home, log } = prepared();
    setFakeEnv({
      FAKE_OBELISK_ARGV_LOG: log,
      FAKE_OBELISK_SEARCH: "[]",
      FAKE_OBELISK_QUERY: JSON.stringify({ found: false, session: null }),
    });

    const error = await errorOf(fakeSource(home).search({ text: "zqleak", session_id: "pi:absent" }));

    expect(isObeliskError(error) && error.kind).toBe("session_not_found");
    expect(argvLog(log)).toHaveLength(2);
  });

  it("does not pay the lookup when the session has hits", async () => {
    const { home, log } = prepared();
    setFakeEnv({
      FAKE_OBELISK_ARGV_LOG: log,
      FAKE_OBELISK_SEARCH: JSON.stringify([hitJson()]),
    });

    const result = await fakeSource(home).search({ text: "zqleak", session_id: "pi:sessA:hashA" });

    expect(result.hits).toHaveLength(1);
    expect(argvLog(log)).toHaveLength(1);
  });

  it("reports session_not_found from the script's own flag", async () => {
    const { home } = prepared();
    setFakeEnv({ FAKE_OBELISK_QUERY: JSON.stringify(scriptSearchJson([], false)) });

    const error = await errorOf(fakeSource(home).search({ text: "zqleak", session_id: "pi:absent", include_meta: true }));

    expect(isObeliskError(error) && error.kind).toBe("session_not_found");
  });
});

describe("search — option validation", () => {
  it("rejects unknown fields by name", async () => {
    const { home } = prepared();
    await expect(rejectionKind(fakeSource(home).search({ text: "x", projectPath: "/tmp/x_a" } as never))).resolves.toBe(
      "unsupported_option",
    );
  });

  it("rejects a blank or missing query", async () => {
    const { home } = prepared();
    const source = fakeSource(home);
    await expect(rejectionKind(source.search({ text: "   " }))).resolves.toBe("invalid_option");
    await expect(rejectionKind(source.search({} as never))).resolves.toBe("invalid_option");
  });

  it("rejects a limit or context window the pinned release cannot honour", async () => {
    const { home } = prepared();
    const source = fakeSource(home);
    await expect(rejectionKind(source.search({ text: "x", limit: 201 }))).resolves.toBe("invalid_option");
    await expect(rejectionKind(source.search({ text: "x", context_limit: 7 }))).resolves.toBe("invalid_option");
  });

  it("rejects a non-absolute project path", async () => {
    const { home } = prepared();
    await expect(rejectionKind(fakeSource(home).search({ text: "x", project_path: "tmp/x_a" }))).resolves.toBe(
      "invalid_option",
    );
  });

  it("fails before spawning when options are invalid", async () => {
    const { home, log } = prepared();
    await errorOf(fakeSource(home).search({ text: "" }));
    expect(argvLog(log)).toEqual([]);
  });

  it("reports a missing index, not an empty result", async () => {
    temp = makeTempHome();
    setFakeEnv({});

    await expect(rejectionKind(fakeSource(temp.home).search({ text: "x" }))).resolves.toBe("index_missing");
  });
});
