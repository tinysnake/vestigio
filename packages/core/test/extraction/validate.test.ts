/**
 * PR-07 length, citation and action-claim rules, at the exact boundaries.
 *
 * 499/500, 1000 and 2000 are the interesting points: the floor cannot be padded,
 * a body over the band is still accepted up to the ceiling the repair path
 * tolerates, and whitespace never counts toward either.
 */

import { describe, expect, it } from "vitest";
import { describeMediumFailure, validateMediumBody } from "../../src/extraction/index.js";
import { bodyOfLength, nonWhitespace } from "./support.js";

const allowed = ["h-1", "h-2"];

describe("medium body length", () => {
  it("rejects 499 non-whitespace points and accepts 500", () => {
    const below = validateMediumBody(bodyOfLength(499), allowed);
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.failure).toEqual({ kind: "too_short", measured: 499 });
    expect(describeMediumFailure({ kind: "too_short", measured: 499 })).toBe("medium_below_min:499");

    const atFloor = validateMediumBody(bodyOfLength(500), allowed);
    expect(atFloor.ok).toBe(true);
    if (atFloor.ok) expect(atFloor.body_char_count).toBe(500);
  });

  it("accepts a body over the band up to the accepted ceiling, and rejects beyond it", () => {
    const atBand = validateMediumBody(bodyOfLength(1000), allowed);
    expect(atBand.ok).toBe(true);
    if (atBand.ok) expect(atBand.body_char_count).toBe(1000);

    // Over the band, inside the accepted ceiling: the repair path asks for a
    // rewrite while its corrections last, then stores this body.
    const overBand = validateMediumBody(bodyOfLength(1389), allowed);
    expect(overBand.ok).toBe(true);
    if (overBand.ok) expect(overBand.body_char_count).toBe(1389);

    const atAccepted = validateMediumBody(bodyOfLength(2000), allowed);
    expect(atAccepted.ok).toBe(true);

    const beyond = validateMediumBody(bodyOfLength(2001), allowed);
    expect(beyond.ok).toBe(false);
    if (!beyond.ok) expect(beyond.failure).toEqual({ kind: "too_long", measured: 2001 });
    expect(describeMediumFailure({ kind: "too_long", measured: 2001 })).toBe("medium_above_max:2001");
  });

  it("does not count whitespace as padding", () => {
    const short = `${bodyOfLength(480)}\n\n    `;
    expect(nonWhitespace(short)).toBe(480);
    const padded = validateMediumBody(`${short}${" ".repeat(200)}`, allowed);
    expect(padded.ok).toBe(false);
    if (!padded.ok) expect(padded.failure.kind).toBe("too_short");

    const honest = bodyOfLength(500);
    const spaced = `\n\n   ${honest}\n\n\t `;
    const accepted = validateMediumBody(spaced, allowed);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.body_char_count).toBe(500);
  });
});

describe("medium body citations", () => {
  it("requires at least one citation", () => {
    const validation = validateMediumBody(bodyOfLength(520).replace(/\[来源:[^\]]+\]/u, ""), allowed);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.failure.kind).toBe("missing_citation");
  });

  it("rejects a citation whose id was not evidence", () => {
    const validation = validateMediumBody(bodyOfLength(520, "made-up"), allowed);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.failure).toEqual({ kind: "foreign_source", ids: ["made-up"] });
  });

  it("accepts both bracket styles and returns the cited ids once", () => {
    const body = `${bodyOfLength(520, "h-1")}【来源：h-2】[来源:h-1]`;
    const validation = validateMediumBody(body, allowed);
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(validation.cited_ids.sort()).toEqual(["h-1", "h-2"]);
  });
});

describe("medium body action claims", () => {
  it("rejects a claim that the summarizer performed the action", () => {
    const body = `${bodyOfLength(520)}我已保存了这条记忆。`;
    const validation = validateMediumBody(body, allowed);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.failure.kind).toBe("action_claim");
  });

  it("allows reporting what the user did, which is the point of the summary", () => {
    const body = `${bodyOfLength(520)}用户把默认端口改成了8787，并保留了回滚步骤。`;
    expect(validateMediumBody(body, allowed).ok).toBe(true);
  });
});
