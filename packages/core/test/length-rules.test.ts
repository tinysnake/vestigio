import { describe, expect, it } from "vitest";
import {
  MEDIUM_BODY_ACCEPT_MAX,
  MEDIUM_BODY_MAX,
  MEDIUM_BODY_MIN,
  NAV_TEXT_MAX,
  ValidationError,
  parseMediumSummary,
  parseMemory,
  parseNavSummary,
} from "../src/contracts/index.js";
import { makeMedium, makeMemory, makeNav } from "./support.js";

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectError(run: () => unknown, code: string, pathPart: string): void {
  const error = caught(run);
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).code).toBe(code);
  expect((error as ValidationError).path).toContain(pathPart);
}

describe("medium body length: 500 to the accepted ceiling, 2000", () => {
  it("rejects 499 and accepts 500", () => {
    expectError(() => parseMediumSummary(makeMedium("a".repeat(MEDIUM_BODY_MIN - 1))), "out_of_range", "body");
    expect(parseMediumSummary(makeMedium("a".repeat(MEDIUM_BODY_MIN))).body_char_count).toBe(500);
  });

  it("accepts a body over the band up to the accepted ceiling", () => {
    expect(parseMediumSummary(makeMedium("a".repeat(MEDIUM_BODY_MAX))).body_char_count).toBe(1000);
    expect(parseMediumSummary(makeMedium("a".repeat(MEDIUM_BODY_MAX + 1))).body_char_count).toBe(1001);
  });

  it("accepts 2000 and rejects 2001", () => {
    expect(parseMediumSummary(makeMedium("a".repeat(MEDIUM_BODY_ACCEPT_MAX))).body_char_count).toBe(2000);
    expectError(
      () => parseMediumSummary(makeMedium("a".repeat(MEDIUM_BODY_ACCEPT_MAX + 1))),
      "out_of_range",
      "body",
    );
  });

  it("counts code points, not UTF-16 units", () => {
    // Each emoji is one code point but two UTF-16 units.
    const astral = "😀".repeat(MEDIUM_BODY_MIN);
    expect(astral.length).toBe(MEDIUM_BODY_MIN * 2);
    expect(parseMediumSummary(makeMedium(astral)).body_char_count).toBe(MEDIUM_BODY_MIN);
    expect(parseMediumSummary(makeMedium("记".repeat(MEDIUM_BODY_MIN))).body_char_count).toBe(MEDIUM_BODY_MIN);
  });

  it("does not let whitespace padding reach the floor", () => {
    const padded = `${"a".repeat(MEDIUM_BODY_MIN)}${" ".repeat(2000)}`;
    expect(parseMediumSummary(makeMedium(padded)).body_char_count).toBe(MEDIUM_BODY_MIN);
    expectError(() => parseMediumSummary(makeMedium(padded, { body_char_count: 2500 })), "invariant_violation", "body_char_count");
    expectError(() => parseMediumSummary(makeMedium("   ".repeat(400))), "out_of_range", "body");
  });

  it("rejects a body_char_count that does not match the measured body", () => {
    expectError(
      () => parseMediumSummary(makeMedium("a".repeat(600), { body_char_count: 601 })),
      "invariant_violation",
      "body_char_count",
    );
  });
});

describe("nav text length: at most 200 Unicode code points", () => {
  it("accepts 200 and rejects 201", () => {
    const exact = "字".repeat(NAV_TEXT_MAX);
    expect(parseNavSummary({ text: exact, char_count: NAV_TEXT_MAX, source_revision: 1 }).char_count).toBe(200);
    expectError(
      () => parseNavSummary({ text: "字".repeat(NAV_TEXT_MAX + 1), char_count: NAV_TEXT_MAX + 1, source_revision: 1 }),
      "out_of_range",
      "text",
    );
  });

  it("counts punctuation and spaces toward the limit", () => {
    const withSpaces = "a ".repeat(100);
    expect(withSpaces.length).toBe(NAV_TEXT_MAX);
    expect(parseNavSummary({ text: withSpaces, char_count: 200, source_revision: 1 }).char_count).toBe(200);
    // Declaring the whitespace-stripped count fails.
    expectError(
      () => parseNavSummary({ text: withSpaces, char_count: 100, source_revision: 1 }),
      "invariant_violation",
      "char_count",
    );
  });

  it("rejects empty nav text and mismatched counts", () => {
    expectError(() => parseNavSummary({ text: "", char_count: 0, source_revision: 1 }), "out_of_range", "text");
    expectError(
      () => parseNavSummary({ text: "abc", char_count: 4, source_revision: 1 }),
      "invariant_violation",
      "char_count",
    );
  });
});

describe("nav revision match", () => {
  it("requires nav.source_revision to equal the memory revision", () => {
    expect(() => parseMemory(makeMemory())).not.toThrow();
    expectError(
      () => parseMemory(makeMemory({ revision: 3, nav: makeNav({ source_revision: 2 }) })),
      "invariant_violation",
      "nav.source_revision",
    );
    expect(() =>
      parseMemory(makeMemory({ revision: 3, state: "medium_ready", nav: null })),
    ).not.toThrow();
  });
});
