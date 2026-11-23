import { describe, expect, it } from "vitest";
import { scopeEqual } from "../../src/resolver/resolver.js";

const repo = { kind: "project", project_id: "/repo" } as const;
const worktree = { kind: "project", project_id: "/repo/.git-worktrees/feature" } as const;
const other = { kind: "project", project_id: "/other" } as const;

describe("scopeEqual", () => {
  it("matches two global scopes and rejects a global against a project", () => {
    expect(scopeEqual({ kind: "global" }, { kind: "global" })).toBe(true);
    expect(scopeEqual({ kind: "global" }, repo)).toBe(false);
    expect(scopeEqual(repo, { kind: "global" })).toBe(false);
  });

  it("matches a project scope with itself", () => {
    expect(scopeEqual(repo, { kind: "project", project_id: "/repo" })).toBe(true);
  });

  it("matches when either side's read-only aliases intersect", () => {
    const aliasedWorktree = { kind: "project", project_id: worktree.project_id, project_ids: ["/repo"] } as const;
    expect(scopeEqual(repo, aliasedWorktree)).toBe(true);
    expect(scopeEqual(aliasedWorktree, repo)).toBe(true);
  });

  it("rejects project scopes with disjoint ids", () => {
    expect(scopeEqual(repo, other)).toBe(false);
    expect(
      scopeEqual({ kind: "project", project_id: "/repo", project_ids: ["/repo-wt"] }, other),
    ).toBe(false);
  });
});
