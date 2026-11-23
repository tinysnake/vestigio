import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitRunner } from "../../src/project/identity.js";
import {
  describeProjectIdentity,
  gitRepositoryRoot,
  projectAliases,
  resolveProjectId,
  scopeProjectIds,
  withProjectAliases,
} from "../../src/project/identity.js";

function runnerFor(outputs: Record<string, string | null>): GitRunner {
  return (dir) => outputs[dir] ?? null;
}

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "vestigio-test",
      GIT_AUTHOR_EMAIL: "vestigio-test@example.com",
      GIT_COMMITTER_NAME: "vestigio-test",
      GIT_COMMITTER_EMAIL: "vestigio-test@example.com",
    },
  });
}

describe("gitRepositoryRoot", () => {
  it("drops a trailing .git segment so a checkout reports its root", () => {
    const git = runnerFor({ "/repo/sub": "/repo/.git\n" });
    expect(gitRepositoryRoot("/repo/sub", git)).toBe("/repo");
  });

  it("keeps a bare repository's own directory", () => {
    const git = runnerFor({ "/srv/repo.git": "/srv/repo.git\n" });
    expect(gitRepositoryRoot("/srv/repo.git", git)).toBe("/srv/repo.git");
  });

  it("returns null when git fails or prints nothing", () => {
    expect(gitRepositoryRoot("/plain", () => null)).toBeNull();
    expect(gitRepositoryRoot("/plain", runnerFor({ "/plain": "" }))).toBeNull();
    expect(gitRepositoryRoot("/plain", runnerFor({ "/plain": "  \n" }))).toBeNull();
  });
});

describe("resolveProjectId", () => {
  it("uses the repository root when there is one", () => {
    const git = runnerFor({ "/repo/sub": "/repo/.git" });
    expect(resolveProjectId("/repo/sub", git)).toBe("/repo");
  });

  it("falls back to the absolute directory outside a repository", () => {
    expect(resolveProjectId("/plain", () => null)).toBe(resolve("/plain"));
  });

  it("keeps an explicit opaque id that is not an absolute path", () => {
    expect(resolveProjectId("p-vestigio", () => null)).toBe("p-vestigio");
    expect(resolveProjectId("p-vestigio")).toBe("p-vestigio");
  });
});

describe("describeProjectIdentity", () => {
  it("reports the id, path and repository root for a directory inside a repository", () => {
    expect(describeProjectIdentity("/repo/sub", runnerFor({ "/repo/sub": "/repo/.git" }))).toEqual({
      path: "/repo/sub",
      project_id: "/repo",
      repository_root: "/repo",
    });
  });

  it("keeps a path outside any repository as its own id with no root", () => {
    expect(describeProjectIdentity("/plain", () => null)).toEqual({
      path: "/plain",
      project_id: "/plain",
      repository_root: null,
    });
  });

  it("resolves a relative path against the cwd", () => {
    expect(describeProjectIdentity("sub", () => null)).toEqual({
      path: resolve("sub"),
      project_id: resolve("sub"),
      repository_root: null,
    });
  });
});

describe("projectAliases", () => {
  const git = runnerFor({
    "/repo": "/repo/.git",
    "/repo-wt": "/repo/.git",
    "/other": "/other/.git",
    "/plain": null,
  });

  it("keeps the id followed by every known id in the same repository", () => {
    expect(projectAliases("/repo", ["/repo", "/repo-wt", "/other", "/plain"], git)).toEqual(["/repo", "/repo-wt"]);
  });

  it("does not alias an id that has no repository root", () => {
    expect(projectAliases("/plain", ["/repo", "/plain"], git)).toEqual(["/plain"]);
  });
});

describe("scopeProjectIds", () => {
  it("reads a global scope over no project ids", () => {
    expect(scopeProjectIds({ kind: "global" })).toEqual([]);
  });

  it("deduplicates the canonical id with its aliases", () => {
    const scope = { kind: "project", project_id: "/repo", project_ids: ["/repo", "/repo-wt"] } as const;
    expect(scopeProjectIds(scope)).toEqual(["/repo", "/repo-wt"]);
  });
});

describe("withProjectAliases", () => {
  it("passes a global scope through unchanged", () => {
    const scope = { kind: "global" } as const;
    expect(withProjectAliases(scope, ["/repo"])).toBe(scope);
  });

  it("attaches aliases without moving the canonical id", () => {
    const git = runnerFor({ "/repo": "/repo/.git", "/repo-wt": "/repo/.git" });
    const scope = withProjectAliases({ kind: "project", project_id: "/repo" }, ["/repo", "/repo-wt"], git);
    expect(scope).toEqual({ kind: "project", project_id: "/repo", project_ids: ["/repo", "/repo-wt"] });
  });
});

describe("real repositories", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "vestigio-project-")));
  const root = join(parent, "repo");
  const subdir = join(root, "packages", "core");
  const worktree = join(parent, "worktree");
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "vestigio-plain-")));
  const submoduleSource = join(parent, "submodule-source");
  const superproject = join(parent, "superproject");
  const vendored = join(superproject, "vendor", "lib");
  const vendoredWorktree = join(parent, "vendored-worktree");
  const cloneA = join(parent, "clone-a");
  const cloneB = join(parent, "clone-b");

  mkdirSync(subdir, { recursive: true });
  runGit(root, ["init", "-q"]);
  writeFileSync(join(root, "README.md"), "seed\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-qm", "init"]);
  runGit(root, ["worktree", "add", "-q", worktree]);

  mkdirSync(submoduleSource, { recursive: true });
  runGit(submoduleSource, ["init", "-q"]);
  writeFileSync(join(submoduleSource, "index.js"), "export const lib = 1;\n");
  runGit(submoduleSource, ["add", "."]);
  runGit(submoduleSource, ["commit", "-qm", "init"]);

  mkdirSync(superproject, { recursive: true });
  runGit(superproject, ["init", "-q"]);
  writeFileSync(join(superproject, "README.md"), "super\n");
  runGit(superproject, ["add", "."]);
  runGit(superproject, ["commit", "-qm", "init"]);
  runGit(superproject, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleSource, "vendor/lib"]);
  runGit(superproject, ["commit", "-qm", "vendored"]);
  runGit(vendored, ["worktree", "add", "-q", vendoredWorktree]);

  runGit(parent, ["clone", "-q", submoduleSource, cloneA]);
  runGit(parent, ["clone", "-q", submoduleSource, cloneB]);

  it("resolves a checkout, a subdirectory and a linked worktree to one id", () => {
    expect(gitRepositoryRoot(root)).toBe(root);
    expect(gitRepositoryRoot(subdir)).toBe(root);
    expect(gitRepositoryRoot(worktree)).toBe(root);
    expect(resolveProjectId(worktree)).toBe(root);
    expect(resolveProjectId(root)).toBe(resolveProjectId(worktree));
  });

  it("keeps a non-git directory as its own absolute path", () => {
    expect(gitRepositoryRoot(plain)).toBeNull();
    expect(resolveProjectId(plain)).toBe(resolve(plain));
  });

  it("resolves a submodule to its own checkout, not its git directory", () => {
    expect(gitRepositoryRoot(vendored)).toBe(vendored);
    expect(resolveProjectId(vendored)).toBe(vendored);
    expect(resolveProjectId(vendored)).not.toBe(resolveProjectId(superproject));
  });

  it("gives a submodule one id across its worktrees and one per clone", () => {
    expect(gitRepositoryRoot(vendoredWorktree)).toBe(vendored);
    expect(resolveProjectId(vendoredWorktree)).toBe(resolveProjectId(vendored));
    expect(resolveProjectId(cloneA)).toBe(cloneA);
    expect(resolveProjectId(cloneB)).toBe(cloneB);
    expect(resolveProjectId(cloneA)).not.toBe(resolveProjectId(cloneB));
  });

  it("describes a linked worktree with the shared id and its own path", () => {
    expect(describeProjectIdentity(root)).toEqual({ path: root, project_id: root, repository_root: root });
    expect(describeProjectIdentity(worktree)).toEqual({
      path: worktree,
      project_id: root,
      repository_root: root,
    });
    expect(describeProjectIdentity(subdir).project_id).toBe(root);
  });

  it("describes a non-git directory as its own id with no repository root", () => {
    expect(describeProjectIdentity(plain)).toEqual({ path: plain, project_id: plain, repository_root: null });
  });
});
