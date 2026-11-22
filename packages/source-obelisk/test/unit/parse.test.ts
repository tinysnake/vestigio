import { describe, expect, it } from "vitest";
import { isObeliskError } from "../../src/errors.js";
import {
  parseCliSearch,
  parseScriptPage,
  parseScriptSearch,
  parseSessionLookup,
  parseVersion,
} from "../../src/parse.js";
import { hitJson, messageJson, pageJson, scriptHitJson, scriptSearchJson, sessionJson, UUID_A1 } from "../support/fake.js";

function kindOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isObeliskError(error)) return error.kind;
    throw error;
  }
  throw new Error("expected a throw");
}

describe("parseCliSearch", () => {
  it("reads a --search hit and leaves the causal fields unresolved", () => {
    const [hit] = parseCliSearch([hitJson()]);
    expect(hit?.message.uuid).toBe(UUID_A1);
    expect(hit?.session.project).toBe("-tmp-x_a");
    expect(hit?.parent_uuid).toBeNull();
    expect(hit?.jsonl_path).toBeNull();
    expect(hit?.project_path).toBeNull();
    expect(hit?.parent_resolved).toBe(false);
  });

  it("records fields this adapter does not know instead of dropping them", () => {
    const [hit] = parseCliSearch([
      hitJson({
        message: { extra: { future_field: 7 } },
        session: { extra: { another_field: "x" } },
      }),
    ]);
    expect(hit?.message.unrecognised).toContain("future_field");
    expect(hit?.session.unrecognised).toContain("another_field");
  });

  it("records unknown hit-level fields", () => {
    const [hit] = parseCliSearch([{ ...hitJson(), weight: 3 }]);
    expect(hit?.unrecognised).toEqual(["weight"]);
  });

  it("rejects a payload that is not an array", () => {
    expect(kindOf(() => parseCliSearch({ hits: [] }))).toBe("protocol");
  });

  it("names the offending path when a required field is missing", () => {
    const broken = hitJson();
    const message = broken["message"] as Record<string, unknown>;
    delete message["uuid"];
    try {
      parseCliSearch([broken]);
      throw new Error("expected a throw");
    } catch (error) {
      if (!isObeliskError(error)) throw error;
      expect(error.kind).toBe("protocol");
      expect(error.message).toContain("search[0].message.uuid");
    }
  });

  it("rejects is_meta values that are not boolean-ish", () => {
    expect(kindOf(() => parseCliSearch([hitJson({ message: { extra: { is_meta: "yes" } } })]))).toBe("protocol");
  });
});

describe("parseScriptSearch", () => {
  it("keeps the per-hit parent and project path when the script resolved them", () => {
    const parsed = parseScriptSearch(
      scriptSearchJson([scriptHitJson({ parent_uuid: UUID_A1, project_path: "/tmp/x_a" })], false),
    );
    expect(parsed.hits[0]?.parent_resolved).toBe(true);
    expect(parsed.hits[0]?.parent_uuid).toBe(UUID_A1);
    expect(parsed.hits[0]?.project_path).toBe("/tmp/x_a");
    expect(parsed.session_found).toBe(false);
  });

  it("treats a missing session_found as unknown rather than false", () => {
    expect(parseScriptSearch({ hits: [] }).session_found).toBeNull();
  });
});

describe("parseScriptPage", () => {
  it("returns found:false without inventing an empty window", () => {
    expect(parseScriptPage({ found: false })).toEqual({ found: false });
  });

  it("keeps a window row whose only content is a tool call", () => {
    const toolCall = messageJson({ role: "assistant", extra: { content_type: "tool_use" } });
    toolCall["text"] = null;
    const parsed = parseScriptPage(pageJson([messageJson(), toolCall]));
    if (!parsed.found) throw new Error("expected a page");
    expect(parsed.messages.map((message) => message.text)).toEqual([
      "zqleak alpha first user message",
      "",
    ]);
  });

  it("still rejects a window row whose text is neither a string nor null", () => {
    const broken = messageJson();
    broken["text"] = { blocks: [] };
    expect(kindOf(() => parseScriptPage(pageJson([broken])))).toBe("protocol");
  });

  it("keeps has_more and the cursor", () => {
    const parsed = parseScriptPage(pageJson([messageJson()], { has_more: true, next_cursor: "c1" }));
    expect(parsed.found).toBe(true);
    if (!parsed.found) throw new Error("unreachable");
    expect(parsed.has_more).toBe(true);
    expect(parsed.next_cursor).toBe("c1");
    expect(parsed.messages).toHaveLength(1);
  });

  it("rejects a page whose messages is not an array", () => {
    expect(kindOf(() => parseScriptPage({ found: true, messages: {}, session: sessionJson() }))).toBe("protocol");
  });
});

describe("parseSessionLookup", () => {
  it("distinguishes not-found from found", () => {
    expect(parseSessionLookup({ found: false, session: null })).toEqual({ found: false, session: null });
    const found = parseSessionLookup({ found: true, session: sessionJson() });
    expect(found.found).toBe(true);
    expect(found.session?.id).toBe("pi:sessA:hashA");
  });
});

describe("parseVersion", () => {
  it("accepts a bare version and trims it", () => {
    expect(parseVersion("0.3.2\n")).toBe("0.3.2");
  });

  it("rejects anything else", () => {
    expect(kindOf(() => parseVersion({ version: "0.3.2" }))).toBe("protocol");
    expect(kindOf(() => parseVersion("   "))).toBe("protocol");
  });
});
