/**
 * The layer line is the one place a reader sees what a search actually looked
 * at. The read stage adds excerpts that were never candidates, so the printed
 * counts must name what they count instead of showing an inverted fraction.
 */

import { describe, expect, it } from "vitest";
import { layerSummary } from "../../src/memory/render.js";

const base = { reason: null, evidence: null, read: false } as const;

describe("layerSummary", () => {
  it("names the two counts when a read added excerpts beyond the candidates", () => {
    expect(
      layerSummary([
        { ...base, layer: "active", status: "empty", candidates: 0, emitted: 0 },
        { ...base, layer: "archived", status: "empty", candidates: 0, emitted: 0 },
        { ...base, layer: "history", status: "matched", candidates: 3, emitted: 5 },
      ]),
    ).toBe("active=empty(0 hit(s)) archived=empty(0 hit(s)) history=matched(3 hit(s) → 5 excerpt(s))");
  });

  it("does not invent an excerpt count when the layer emitted exactly its candidates", () => {
    expect(
      layerSummary([{ ...base, layer: "active", status: "matched", candidates: 1, emitted: 1 }]),
    ).toBe("active=matched(1 hit(s))");
  });
});
