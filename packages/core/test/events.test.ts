import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../src/contracts/index.js";
import {
  ValidationError,
  assertUniqueInjectionReceipts,
  injectionReceiptKey,
  parseUsageEvent,
  usageEventId,
} from "../src/contracts/index.js";
import { makeInjectionReceipt, makeUsageEvent, makeUsageFields } from "./support.js";

describe("deterministic usage event ids", () => {
  it("hashes the same fields to the same id", () => {
    const base = makeUsageFields();
    const baseId = usageEventId(base);
    expect(usageEventId({ ...base })).toBe(baseId);
    const reordered: Omit<UsageEvent, "event_id"> = {
      dedup_key: base.dedup_key,
      at: base.at,
      input_id: base.input_id,
      session_id: base.session_id,
      channel: base.channel,
      kind: base.kind,
      revision: base.revision,
      memory_id: base.memory_id,
    };
    expect(usageEventId(reordered)).toBe(baseId);
    expect(parseUsageEvent(makeUsageEvent()).event_id).toBe(baseId);
  });

  it("changes the id when any field changes", () => {
    const base = makeUsageFields();
    const baseId = usageEventId(base);
    const mutations: Array<Omit<UsageEvent, "event_id">> = [
      { ...base, memory_id: "mem-0002" },
      { ...base, revision: 2 },
      { ...base, kind: "access" },
      { ...base, channel: "read" },
      { ...base, session_id: "s-2" },
      { ...base, input_id: "input-2" },
      { ...base, at: "2026-11-17T16:32:00Z" },
      { ...base, dedup_key: "other-key" },
    ];
    for (const mutated of mutations) {
      expect(usageEventId(mutated)).not.toBe(baseId);
    }
  });

  it("rejects a retried event whose id was invented rather than derived", () => {
    const event = makeUsageEvent();
    expect(() => parseUsageEvent({ ...event, event_id: "not-the-derived-id" })).toThrow(ValidationError);
    try {
      parseUsageEvent({ ...event, event_id: "not-the-derived-id" });
    } catch (error) {
      expect((error as ValidationError).code).toBe("invariant_violation");
      expect((error as ValidationError).path).toContain("event_id");
    }
    expect(() => parseUsageEvent({ ...event, kind: "view" })).toThrow(ValidationError);
  });
});

describe("injection receipt uniqueness", () => {
  it("keys on session, branch, input and memory, ignoring revision", () => {
    const first = makeInjectionReceipt({ revision: 1 });
    const revised = makeInjectionReceipt({ revision: 2 });
    expect(injectionReceiptKey(first)).toBe(injectionReceiptKey(revised));
    expect(injectionReceiptKey(makeInjectionReceipt({ input_id: "input-2" }))).not.toBe(
      injectionReceiptKey(first),
    );
  });

  it("accepts distinct receipts and rejects a repeated memory across revisions", () => {
    const first = makeInjectionReceipt({ revision: 1 });
    const revised = makeInjectionReceipt({ revision: 2 });
    const other = makeInjectionReceipt({ memory_id: "mem-0002" });
    expect(() => assertUniqueInjectionReceipts([first, other])).not.toThrow();
    expect(() => assertUniqueInjectionReceipts([first, revised])).toThrow(ValidationError);
    try {
      assertUniqueInjectionReceipts([first, revised]);
    } catch (error) {
      expect((error as ValidationError).code).toBe("invariant_violation");
    }
  });
});
