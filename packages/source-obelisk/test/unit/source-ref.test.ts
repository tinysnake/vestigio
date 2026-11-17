import { describe, expect, it } from "vitest";
import { isObeliskError } from "../../src/errors.js";
import { mapHit } from "../../src/hit.js";
import { parseCliSearch, parseMessage, parseSession } from "../../src/parse.js";
import {
  contentHash,
  locatorFor,
  projectIdFor,
  projectSlugFor,
  toSourceRef,
  UNSCOPED_PROJECT,
} from "../../src/source-ref.js";
import { hitJson, messageJson, sessionJson, UUID_A1, UUID_A2 } from "../support/fake.js";

const message = (extra: Record<string, unknown> = {}) => parseMessage(messageJson(extra), "$.message");
const session = (extra: Record<string, unknown> = {}) =>
  parseSession(
    sessionJson({
      project_path: "/tmp/x_a",
      jsonl_path: "/tmp/x_a/.pi/agent/sessions/sessA.jsonl",
      ...extra,
    }),
    "$.session",
  );

describe("contentHash", () => {
  it("is SHA-256 over the exact text", () => {
    expect(contentHash("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("distinguishes a snippet from the full text", () => {
    expect(contentHash("zqleak alpha first user message")).not.toBe(contentHash("zqleak alpha first user…"));
  });
});

describe("projectIdFor", () => {
  it("prefers the absolute project path", () => {
    expect(projectIdFor(session())).toBe("/tmp/x_a");
  });

  it("uses a verified project hint before anything the row carries", () => {
    expect(projectIdFor(session({ project_path: null }), "/tmp/x_a")).toBe("/tmp/x_a");
  });

  it("keeps two paths apart whose slugs collide", () => {
    const a = projectIdFor(session({ project: "-tmp-x_a" }));
    const b = projectIdFor(session({ project: "-tmp-x-a", project_path: "/tmp/x-a" }));
    expect(a).not.toBe(b);
    // ...while the slugs the CLI prints for them differ only by the separator.
    expect(projectSlugFor("/tmp/x_a")).toBe("-tmp-x_a");
    expect(projectSlugFor("/tmp/x-a")).toBe("-tmp-x-a");
  });

  it("falls back to the slug, then to an explicit unscoped marker", () => {
    expect(projectIdFor(session({ project_path: null }))).toBe("-tmp-x_a");
    expect(projectIdFor(session({ project_path: null, project: null }))).toBe(UNSCOPED_PROJECT);
  });

  it("reports whether the project identity is exact", () => {
    const hit = (session: Record<string, unknown>) => parseCliSearch([hitJson({ session })])[0]!;
    expect(mapHit(hit({ project_path: "/tmp/x_a" }), "s").project_resolved).toBe(true);
    expect(mapHit(hit({}), "s").project_resolved).toBe(false);
    expect(mapHit(hit({}), "s", "/tmp/x_a").project_resolved).toBe(true);
    expect(mapHit(hit({}), "s", "/tmp/x_a").source_ref.project_id).toBe("/tmp/x_a");
  });
});

describe("locatorFor", () => {
  it("combines the source file and the message id, or is null", () => {
    expect(locatorFor("/tmp/a.jsonl", UUID_A1)).toBe(`/tmp/a.jsonl#${UUID_A1}`);
    expect(locatorFor(null, UUID_A1)).toBeNull();
  });
});

describe("toSourceRef", () => {
  it("maps every field and validates through the core contract", () => {
    const ref = toSourceRef({
      message: message(),
      session: session(),
      source_instance: "fixture",
      parent_uuid: UUID_A2,
      jsonl_path: "/tmp/x_a/.pi/agent/sessions/sessA.jsonl",
    });
    expect(ref).toMatchObject({
      provider: "pi",
      source_instance: "fixture",
      session_id: "pi:sessA:hashA",
      message_id: UUID_A1,
      parent_message_id: UUID_A2,
      project_id: "/tmp/x_a",
      timestamp: "2026-01-01T00:00:01.000Z",
      locator: `/tmp/x_a/.pi/agent/sessions/sessA.jsonl#${UUID_A1}`,
    });
    expect(ref.content_hash).toBe(contentHash("zqleak alpha first user message"));
  });

  it("carries a null parent for a root message", () => {
    expect(
      toSourceRef({ message: message(), session: session(), source_instance: "s", parent_uuid: null, jsonl_path: null })
        .parent_message_id,
    ).toBeNull();
  });

  it("rejects a message that is its own parent", () => {
    try {
      toSourceRef({
        message: message(),
        session: session(),
        source_instance: "s",
        parent_uuid: UUID_A1,
        jsonl_path: null,
      });
      throw new Error("expected a throw");
    } catch (error) {
      if (!isObeliskError(error)) throw error;
      expect(error.kind).toBe("protocol");
    }
  });

  it("rejects a row with no provider anywhere", () => {
    expect(() =>
      toSourceRef({
        message: parseMessage({ ...messageJson(), source: null }, "$"),
        session: parseSession({ ...sessionJson(), source: null }, "$"),
        source_instance: "s",
        parent_uuid: null,
        jsonl_path: null,
      }),
    ).toThrow();
  });

  it("propagates the core validator on a bad timestamp", () => {
    expect(() =>
      toSourceRef({
        message: parseMessage({ ...messageJson(), timestamp: "2026-01-01T00:00:01" }, "$"),
        session: session(),
        source_instance: "s",
        parent_uuid: null,
        jsonl_path: null,
      }),
    ).toThrow();
  });
});
