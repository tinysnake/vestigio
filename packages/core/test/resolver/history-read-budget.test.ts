/**
 * The history read allowance is the only part of the resolve budget whose spend
 * is decided by an external process. These cases pin the two refusals and the
 * ceiling so a slow source can never hold the judgment's time.
 */

import { describe, expect, it } from "vitest";
import { createHistoryReadBudget } from "../../src/resolver/budget.js";

describe("createHistoryReadBudget", () => {
  it("refuses while the time left is inside the reserve judgment needs", () => {
    const budget = createHistoryReadBudget({ remaining_ms: () => 500, max_reads: 2, reserve_ms: 8000 });

    expect(budget.take()).toEqual({ ok: false, reason: "deadline" });
  });

  it("caps one read, then refuses on the allowance rather than on time", () => {
    const budget = createHistoryReadBudget({
      remaining_ms: () => 600_000,
      max_reads: 1,
      reserve_ms: 8000,
      timeout_cap_ms: 20_000,
    });

    expect(budget.take()).toEqual({ ok: true, timeout_ms: 20_000 });
    expect(budget.take()).toEqual({ ok: false, reason: "reads" });
  });

  it("never grants a non-positive timeout", () => {
    const budget = createHistoryReadBudget({ remaining_ms: () => 8_001, max_reads: 2, reserve_ms: 8000 });

    expect(budget.take()).toEqual({ ok: true, timeout_ms: 1 });
  });

  it("treats an unbounded deadline as the cap", () => {
    const budget = createHistoryReadBudget({ remaining_ms: () => Infinity, max_reads: 1, reserve_ms: 8000 });

    expect(budget.take()).toEqual({ ok: true, timeout_ms: 20_000 });
  });
});
