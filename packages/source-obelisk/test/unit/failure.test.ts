import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isObeliskError } from "../../src/errors.js";
import { spawnCli } from "../../src/cli.js";
import {
  argvLog,
  FAKE_CLI,
  fakeSource,
  makeTempHome,
  rejectionKind,
  resetFakeEnv,
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

function prepared(): string {
  temp = makeTempHome();
  writeIndex(temp.home);
  return temp.home;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

describe("timeouts and cancellation", () => {
  it("kills a child that exceeds the deadline and reports cli_timeout", async () => {
    const home = prepared();
    setFakeEnv({ FAKE_OBELISK_SLEEP_MS: "5000", FAKE_OBELISK_SEARCH: "[]" });

    const started = performance.now();
    await expect(rejectionKind(fakeSource(home).search({ text: "x", timeout_ms: 150 }))).resolves.toBe(
      "cli_timeout",
    );
    expect(performance.now() - started).toBeLessThan(2_500);
  });

  it("reports cli_cancelled when the signal aborts mid-call", async () => {
    const home = prepared();
    setFakeEnv({ FAKE_OBELISK_SLEEP_MS: "5000", FAKE_OBELISK_SEARCH: "[]" });
    const controller = new AbortController();

    const started = performance.now();
    const call = fakeSource(home).search({ text: "x", signal: controller.signal });
    setTimeout(() => controller.abort(new Error("user cancelled")), 50);

    await expect(rejectionKind(call)).resolves.toBe("cli_cancelled");
    expect(performance.now() - started).toBeLessThan(2_500);
  });

  it("reports cli_cancelled for an already-aborted signal without spawning", async () => {
    const home = prepared();
    const log = join(home, "argv.log");
    setFakeEnv({ FAKE_OBELISK_ARGV_LOG: log });
    const controller = new AbortController();
    controller.abort();

    await expect(rejectionKind(fakeSource(home).search({ text: "x", signal: controller.signal }))).resolves.toBe(
      "cli_cancelled",
    );
    expect(argvLog(log)).toEqual([]);
  });
});

describe("CLI exit failures", () => {
  it("uses the child's reported error text", async () => {
    const home = prepared();
    setFakeEnv({ FAKE_OBELISK_EXIT: "1", FAKE_OBELISK_STDOUT: JSON.stringify({ error: "Unknown --search option" }) });

    const error = await errorOf(fakeSource(home).search({ text: "x" }));
    expect(isObeliskError(error)).toBe(true);
    if (!isObeliskError(error)) return;
    expect(error.kind).toBe("cli_error");
    expect(error.message).toBe("Unknown --search option");
    expect(error.detail["exit_code"]).toBe(1);
  });

  it("falls back to the exit code when stdout is empty but stderr is not", async () => {
    const home = prepared();
    setFakeEnv({ FAKE_OBELISK_EXIT: "7", FAKE_OBELISK_STDERR: "Warning: skipped pi artifact ledger.jsonl\n" });

    const error = await errorOf(fakeSource(home).search({ text: "x" }));
    expect(isObeliskError(error)).toBe(true);
    if (!isObeliskError(error)) return;
    expect(error.kind).toBe("cli_error");
    expect(error.message).toContain("exited 7");
    expect(String(error.detail["stderr"])).toContain("skipped pi artifact");
  });

  it("reports empty stdout on a zero exit as protocol, not as an empty result", async () => {
    const home = prepared();
    setFakeEnv({ FAKE_OBELISK_STDOUT: "" });

    await expect(rejectionKind(fakeSource(home).search({ text: "x" }))).resolves.toBe("protocol");
  });

  it("reports truncated JSON as protocol", async () => {
    const home = prepared();
    setFakeEnv({ FAKE_OBELISK_STDOUT: '[{"message":' });

    await expect(rejectionKind(fakeSource(home).search({ text: "x" }))).resolves.toBe("protocol");
  });

  it("reports a missing index as index_missing", async () => {
    temp = makeTempHome();
    setFakeEnv({});

    await expect(rejectionKind(fakeSource(temp.home).search({ text: "x" }))).resolves.toBe("index_missing");
  });
});

describe("spawn", () => {
  it("pins HOME and drops Obelisk's state-directory overrides", async () => {
    const home = prepared();
    const log = join(home, "argv.log");
    setFakeEnv({ FAKE_OBELISK_ARGV_LOG: log, FAKE_OBELISK_ECHO_SCRIPT: "1" });
    process.env["OBELISK_DIR"] = "/should/not/matter";
    try {
      const run = await spawnCli({
        entry: FAKE_CLI,
        args: ["--query", "/tmp/x.query.mjs"],
        home,
        timeout_ms: 5_000,
        signal: undefined,
      });
      expect(run.exit_code).toBe(0);
      const echoed = JSON.parse(run.stdout) as { home: string };
      expect(echoed.home).toBe(home);
    } finally {
      delete process.env["OBELISK_DIR"];
    }
  });
});
