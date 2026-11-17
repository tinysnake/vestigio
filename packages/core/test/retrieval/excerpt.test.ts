import { describe, expect, it } from "vitest";
import {
  boundExcerpt,
  findConflictingMemoryIds,
  subjectKey,
  truncationMarker,
} from "../../src/retrieval/index.js";
import { makeMemoryCard } from "../support.js";

describe("boundExcerpt", () => {
  it("leaves text at or under the cap untouched", () => {
    expect(boundExcerpt("abcde", 5)).toEqual({
      excerpt: "abcde",
      truncated: false,
      full_char_count: 5,
      excerpt_char_count: 5,
      truncation_marker: null,
    });
    expect(boundExcerpt("端口约定", 4).truncated).toBe(false);
  });

  it("truncates with a marker that names how much was dropped", () => {
    const bounded = boundExcerpt("abcdef", 5);
    expect(bounded.truncated).toBe(true);
    expect(bounded.excerpt).toBe(`abcde${truncationMarker(1)}`);
    expect(bounded.truncation_marker).toBe("…[truncated 1 more characters]");
    expect(bounded.full_char_count).toBe(6);
    expect(bounded.excerpt_char_count).toBe(bounded.excerpt.length);
  });

  it("counts code points, not UTF-16 units", () => {
    const bounded = boundExcerpt("👍👍👍", 2);
    expect(bounded.full_char_count).toBe(3);
    expect(bounded.truncated).toBe(true);
    expect(bounded.excerpt).toBe(`👍👍${truncationMarker(1)}`);
    expect([...bounded.excerpt].length).toBe(bounded.excerpt_char_count);
  });
});

describe("subjectKey", () => {
  it("drops separators, qualifiers and case", () => {
    expect(subjectKey("端口约定（冲突）")).toBe("端口约定冲突");
    expect(subjectKey(" Port-A ")).toBe("porta");
    expect(subjectKey("---")).toBe("");
  });
});

describe("findConflictingMemoryIds", () => {
  it("flags a shared subject inside one scope", () => {
    const cards = [
      makeMemoryCard({ memory_id: "mem-a", title: "端口约定", scope: { kind: "project", project_id: "/tmp/a" } }),
      makeMemoryCard({
        memory_id: "mem-b",
        title: "端口约定（冲突）",
        scope: { kind: "project", project_id: "/tmp/a" },
      }),
    ];
    expect(findConflictingMemoryIds(cards)).toEqual(["mem-a", "mem-b"]);
  });

  it("never flags the same title across two scopes", () => {
    const cards = [
      makeMemoryCard({ memory_id: "mem-a", title: "端口约定", scope: { kind: "project", project_id: "/tmp/a" } }),
      makeMemoryCard({ memory_id: "mem-b", title: "端口约定", scope: { kind: "project", project_id: "/tmp/b" } }),
      makeMemoryCard({ memory_id: "mem-c", title: "端口约定", scope: { kind: "global" } }),
    ];
    expect(findConflictingMemoryIds(cards)).toEqual([]);
  });

  it("ignores a one-code-point subject as too weak to mean the same thing", () => {
    const cards = [
      makeMemoryCard({ memory_id: "mem-a", title: "端", scope: { kind: "global" } }),
      makeMemoryCard({ memory_id: "mem-b", title: "端口", scope: { kind: "global" } }),
    ];
    expect(findConflictingMemoryIds(cards)).toEqual([]);
  });

  it("does not flag unrelated subjects", () => {
    const cards = [
      makeMemoryCard({ memory_id: "mem-a", title: "端口约定", scope: { kind: "global" } }),
      makeMemoryCard({ memory_id: "mem-b", title: "回滚步骤", scope: { kind: "global" } }),
    ];
    expect(findConflictingMemoryIds(cards)).toEqual([]);
  });
});
