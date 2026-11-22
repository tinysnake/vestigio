/**
 * The extension carries its own copy of the layer line so a locally served
 * search reads exactly like a daemon one. This pins the shared wording; the
 * daemon has the same test against its own copy.
 */

import { describe, expect, it } from "vitest";
import { layerSummary } from "../src/tools.js";

const base = { reason: null, evidence: null, read: false } as const;

describe("layerSummary", () => {
  it("names the two counts when a read added excerpts beyond the candidates", () => {
    expect(
      layerSummary([
        { ...base, layer: "active", status: "empty", candidates: 0, emitted: 0 },
        { ...base, layer: "history", status: "matched", candidates: 3, emitted: 5 },
      ]),
    ).toBe("active=empty(0 hit(s)) history=matched(3 hit(s) → 5 excerpt(s))");
  });
});
