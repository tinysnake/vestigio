import { describe, expect, it } from "vitest";
import { isObeliskError } from "../../src/errors.js";
import {
  optionalBoolean,
  optionalInteger,
  optionalNonEmptyString,
  optionalTimestamp,
  readOptionObject,
  requireAbsolutePath,
} from "../../src/options.js";

function kindOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isObeliskError(error)) return error.kind;
    throw error;
  }
  throw new Error("expected a throw");
}

describe("readOptionObject", () => {
  it("rejects a non-object", () => {
    expect(kindOf(() => readOptionObject(null, [], "search"))).toBe("invalid_option");
    expect(kindOf(() => readOptionObject([], [], "search"))).toBe("invalid_option");
    expect(kindOf(() => readOptionObject("text", [], "search"))).toBe("invalid_option");
  });

  it("names the unknown field and every allowed field", () => {
    try {
      readOptionObject({ text: "x", projectPath: "/tmp/x" }, ["text", "project_path"], "search");
      throw new Error("expected a throw");
    } catch (error) {
      if (!isObeliskError(error)) throw error;
      expect(error.kind).toBe("unsupported_option");
      expect(error.message).toContain("projectPath");
      expect(error.message).toContain("project_path");
      expect(error.detail["option"]).toBe("search.projectPath");
    }
  });

  it("accepts an empty record when every field is optional", () => {
    expect(readOptionObject({}, ["text"], "search")).toEqual({});
  });
});

describe("requireAbsolutePath", () => {
  it("accepts a normalised absolute path", () => {
    expect(requireAbsolutePath("/tmp/x_a", "home")).toBe("/tmp/x_a");
    expect(requireAbsolutePath("/", "home")).toBe("/");
  });

  it.each([
    ["relative", "tmp/x"],
    ["tilde", "~/obelisk"],
    ["empty", ""],
    ["trailing separator", "/tmp/x/"],
    ["dot segment", "/tmp/./x"],
    ["double separator", "/tmp//x"],
    ["parent segment", "/tmp/../x"],
    ["NUL byte", "/tmp/x\0y"],
  ])("rejects a %s path", (_label, value) => {
    expect(kindOf(() => requireAbsolutePath(value, "home"))).toBe("invalid_option");
  });
});

describe("scalars", () => {
  it("rejects the wrong type rather than coercing", () => {
    expect(kindOf(() => optionalBoolean({ a: "true" }, "a", "p"))).toBe("invalid_option");
    expect(kindOf(() => optionalInteger({ a: "3" }, "a", "p", 0, 10))).toBe("invalid_option");
    expect(kindOf(() => optionalInteger({ a: 1.5 }, "a", "p", 0, 10))).toBe("invalid_option");
    expect(kindOf(() => optionalNonEmptyString({ a: "" }, "a", "p"))).toBe("invalid_option");
  });

  it("enforces inclusive bounds", () => {
    expect(kindOf(() => optionalInteger({ a: 11 }, "a", "p", 0, 10))).toBe("invalid_option");
    expect(optionalInteger({ a: 10 }, "a", "p", 0, 10)).toBe(10);
    expect(optionalInteger({}, "a", "p", 0, 10)).toBeUndefined();
  });

  it("requires an explicit offset on timestamps", () => {
    expect(optionalTimestamp({ a: "2026-01-01T00:00:00.000Z" }, "a", "p")).toBe("2026-01-01T00:00:00.000Z");
    expect(optionalTimestamp({ a: "2026-01-01T00:00:00+02:00" }, "a", "p")).toBe("2026-01-01T00:00:00+02:00");
    expect(kindOf(() => optionalTimestamp({ a: "2026-01-01T00:00:00" }, "a", "p"))).toBe("invalid_option");
    expect(kindOf(() => optionalTimestamp({ a: "yesterday" }, "a", "p"))).toBe("invalid_option");
  });
});
