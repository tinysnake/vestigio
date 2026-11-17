import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObeliskSource, VERIFIED_CAPABILITIES } from "../../src/index.js";
import {
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

function home(): TempHome {
  temp = makeTempHome();
  return temp;
}

describe("probe", () => {
  it("reports available and hands out the verified capability table", async () => {
    const { home: dir } = home();
    const index = writeIndex(dir);
    setFakeEnv({ FAKE_OBELISK_VERSION: "0.3.2" });

    const probe = await fakeSource(dir).probe();

    expect(probe.available).toBe(true);
    expect(probe.reason).toBeNull();
    expect(probe.error).toBeNull();
    expect(probe.cli.entry).toBe(FAKE_CLI);
    expect(probe.cli.declared_version).toBeNull();
    expect(probe.cli.reported_version).toBe("0.3.2");
    expect(probe.cli.version_matches).toBe(true);
    expect(probe.data).toEqual({ home: dir, index_path: index, index_present: true });
    expect(probe.capabilities).toEqual(VERIFIED_CAPABILITIES);
    expect(probe.capabilities_source).toBe("pinned-table");
    expect(Number.isFinite(probe.duration_ms)).toBe(true);
    expect(new Date(probe.checked_at).toISOString()).toBe(probe.checked_at);
  });

  it("reports a version mismatch instead of pretending the table still applies", async () => {
    const { home: dir } = home();
    writeIndex(dir);
    setFakeEnv({ FAKE_OBELISK_VERSION: "0.3.1" });

    const probe = await fakeSource(dir).probe();

    expect(probe.available).toBe(false);
    expect(probe.reason).toBe("version_mismatch");
    expect(probe.capabilities).toBeNull();
    expect(probe.capabilities_source).toBe("none");
    expect(probe.cli.reported_version).toBe("0.3.1");
    expect(probe.cli.version_matches).toBe(false);
    expect(probe.error?.kind).toBe("version_mismatch");
    expect(probe.error?.message).toContain("0.3.1");
  });

  it("reports a missing index, with the path it looked at", async () => {
    const { home: dir } = home();
    setFakeEnv({ FAKE_OBELISK_VERSION: "0.3.2" });

    const probe = await fakeSource(dir).probe();

    expect(probe.available).toBe(false);
    expect(probe.reason).toBe("index_missing");
    expect(probe.data.index_present).toBe(false);
    expect(probe.data.index_path).toBe(join(dir, ".obelisk", "obelisk.sqlite"));
    expect(probe.error?.kind).toBe("index_missing");
  });

  it("reports a missing binary rather than an empty history", async () => {
    const { home: dir } = home();
    writeIndex(dir);

    const probe = await new ObeliskSource({ home: dir, cli_path: join(dir, "absent.mjs") }).probe();

    expect(probe.available).toBe(false);
    expect(probe.reason).toBe("cli_missing");
    expect(probe.cli.entry).toBeNull();
    expect(probe.error?.kind).toBe("unavailable");
  });

  it("reports a failing --version as cli_error", async () => {
    const { home: dir } = home();
    writeIndex(dir);
    setFakeEnv({ FAKE_OBELISK_VERSION: "0.3.2", FAKE_OBELISK_EXIT: "3" });

    const probe = await fakeSource(dir).probe();

    expect(probe.available).toBe(false);
    expect(probe.reason).toBe("cli_error");
    expect(probe.error?.kind).toBe("cli_error");
  });

  it("treats unparseable version output as a protocol failure", async () => {
    const { home: dir } = home();
    writeIndex(dir);
    setFakeEnv({ FAKE_OBELISK_VERSION: "obelisk, probably" });

    const probe = await fakeSource(dir).probe();

    expect(probe.reason).toBe("protocol");
    expect(probe.error?.kind).toBe("protocol");
  });

  it("ignores stderr noise: the pi artifact warning is not a failure", async () => {
    const { home: dir } = home();
    writeIndex(dir);
    setFakeEnv({
      FAKE_OBELISK_VERSION: "0.3.2",
      FAKE_OBELISK_STDERR: "Warning: skipped pi artifact /x/observation-pack/ledger.jsonl: Unsupported or malformed Pi session header\n",
    });

    await expect(fakeSource(dir).probe()).resolves.toMatchObject({ available: true });
  });

  it("throws only for its own bad options", async () => {
    const { home: dir } = home();
    writeIndex(dir);
    await expect(rejectionKind(fakeSource(dir).probe({ project: "/tmp/x" }))).resolves.toBe("unsupported_option");
  });
});
