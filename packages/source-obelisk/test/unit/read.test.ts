import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  argvLog,
  fakeSource,
  makeTempHome,
  messageJson,
  pageJson,
  rejectionKind,
  resetFakeEnv,
  sessionJson,
  setFakeEnv,
  writeIndex,
  UUID_A1,
  UUID_A2,
  UUID_A3,
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

const chain = [
  messageJson({ uuid: UUID_A1, parent_uuid: null }),
  messageJson({ uuid: UUID_A2, parent_uuid: UUID_A1, role: "assistant" }),
  messageJson({ uuid: UUID_A3, parent_uuid: UUID_A2 }),
];

describe("read", () => {
  it("maps a window into SourceRefs with the causal parent resolved", async () => {
    const { home, log } = prepared();
    setFakeEnv({ FAKE_OBELISK_ARGV_LOG: log, FAKE_OBELISK_QUERY: JSON.stringify(pageJson(chain)) });

    const result = await fakeSource(home).read({ anchor: UUID_A2, relation: "parents", before: 2 });

    expect(argvLog(log)[0]?.[0]).toBe("--query");
    expect(result.messages).toHaveLength(3);
    expect(result.anchor.message_id).toBe(UUID_A2);
    expect(result.messages.map((row) => row.source_ref.parent_message_id)).toEqual([null, UUID_A1, UUID_A2]);
    expect(result.messages[1]?.source_ref.locator).toContain("#");
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
    expect(result.timing.child_ms).toBeGreaterThanOrEqual(0);
  });

  it("reports has_more and the cursor when the window is truncated", async () => {
    const { home } = prepared();
    setFakeEnv({ FAKE_OBELISK_QUERY: JSON.stringify(pageJson(chain, { has_more: true, next_cursor: "c2" })) });

    const result = await fakeSource(home).read({ anchor: UUID_A1, after: 2 });

    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBe("c2");
  });

  it("reports a hidden, inactive or missing anchor as message_not_visible", async () => {
    const { home } = prepared();
    setFakeEnv({ FAKE_OBELISK_QUERY: JSON.stringify({ found: false }) });

    await expect(rejectionKind(fakeSource(home).read({ anchor: UUID_A1 }))).resolves.toBe("message_not_visible");
  });

  it("does not accept a page that omits its own anchor", async () => {
    const { home } = prepared();
    setFakeEnv({ FAKE_OBELISK_QUERY: JSON.stringify(pageJson(chain.slice(1))) });

    await expect(rejectionKind(fakeSource(home).read({ anchor: UUID_A1 }))).resolves.toBe("protocol");
  });

  it("does not accept rows without their session", async () => {
    const { home } = prepared();
    setFakeEnv({
      FAKE_OBELISK_QUERY: JSON.stringify({ ...pageJson(chain), session: null }),
    });

    await expect(rejectionKind(fakeSource(home).read({ anchor: UUID_A1 }))).resolves.toBe("protocol");
  });

  it("fills session details from the page", async () => {
    const { home } = prepared();
    setFakeEnv({
      FAKE_OBELISK_QUERY: JSON.stringify(
        pageJson([messageJson()], { session: sessionJson({ jsonl_path: "/tmp/x_a/sessA.jsonl" }) }),
      ),
    });

    const result = await fakeSource(home).read({ anchor: UUID_A1 });
    expect(result.session?.id).toBe("pi:sessA:hashA");
    expect(result.session?.project).toBe("-tmp-x_a");
  });
});

describe("read — bounded by the pinned release's limits", () => {
  it("rejects afterCount on the parents relation before spawning", async () => {
    const { home, log } = prepared();
    await expect(
      rejectionKind(fakeSource(home).read({ anchor: UUID_A1, relation: "parents", after: 1 })),
    ).resolves.toBe("unsupported_option");
    expect(argvLog(log)).toEqual([]);
  });

  it("rejects a window over 500 messages including the anchor", async () => {
    const { home } = prepared();
    const source = fakeSource(home);
    await expect(rejectionKind(source.read({ anchor: UUID_A1, before: 500 }))).resolves.toBe("unsupported_option");
    await expect(rejectionKind(source.read({ anchor: UUID_A1, before: 499 }))).resolves.not.toBe(
      "unsupported_option",
    );
  });

  it("rejects an unknown relation explicitly", async () => {
    const { home } = prepared();
    await expect(rejectionKind(fakeSource(home).read({ anchor: UUID_A1, relation: "children" } as never))).resolves.toBe(
      "unsupported_option",
    );
  });

  it("rejects unknown fields, a missing anchor and a NUL anchor", async () => {
    const { home } = prepared();
    const source = fakeSource(home);
    await expect(rejectionKind(source.read({ anchor: UUID_A1, window: 3 } as never))).resolves.toBe("unsupported_option");
    await expect(rejectionKind(source.read({} as never))).resolves.toBe("invalid_option");
    await expect(rejectionKind(source.read({ anchor: "a\0b" }))).resolves.toBe("invalid_option");
  });
});
