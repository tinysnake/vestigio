import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseMemory } from "../../src/contracts/index.js";
import type { GitRunner } from "../../src/project/identity.js";
import {
  ProjectSettingsError,
  describeProjectIdentity,
  gitRepositoryRoot,
  projectAliases,
  resolveProjectId,
  scopeProjectIds,
  withProjectAliases,
} from "../../src/project/identity.js";
import { bodyWith, openTempStore, storedMemory } from "../storage/support.js";

type FakeRepo = {
  common?: string;
  toplevel?: string;
  superproject?: string;
  core_worktree?: string;
};

function fakeGit(repos: Record<string, FakeRepo>): GitRunner {
  return (dir, args) => {
    const repo = repos[dir];
    if (repo === undefined) return null;
    const field = args[args.length - 1];
    if (field === "--git-common-dir") return repo.common ?? null;
    if (field === "--show-toplevel") return repo.toplevel ?? null;
    if (field === "--show-superproject-working-tree") return repo.superproject ?? null;
    if (field === "core.worktree") return repo.core_worktree ?? null;
    return null;
  };
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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function writeSettings(dir: string, contents: unknown): string {
  const file = join(dir, ".vestigio", "settings.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

type RepoFixture = {
  parent: string;
  root: string;
  nested: string;
  worktree: string;
  git: GitRunner;
  track: (dir: string) => void;
};

/** A fake repository with a nested directory and a linked worktree. */
function repoFixture(): RepoFixture {
  const parent = tempDir("vestigio-settings-");
  const root = join(parent, "repo");
  const nested = join(root, "nested", "dir");
  const worktree = join(parent, "worktree");
  mkdirSync(nested, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const repositories: Record<string, FakeRepo> = {};
  const common = join(root, ".git");
  const track = (dir: string): void => {
    repositories[dir] = { common, toplevel: dir === worktree ? worktree : root };
  };
  track(root);
  track(nested);
  track(worktree);
  return { parent, root, nested, worktree, git: fakeGit(repositories), track };
}

function settingsFailure(run: () => unknown): ProjectSettingsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectSettingsError);
    return error as ProjectSettingsError;
  }
  throw new Error("expected a ProjectSettingsError");
}

describe("gitRepositoryRoot", () => {
  it("drops a trailing .git segment so a checkout reports its root", () => {
    const git = fakeGit({ "/repo/sub": { common: "/repo/.git", toplevel: "/repo/sub" } });
    expect(gitRepositoryRoot("/repo/sub", git)).toBe("/repo");
  });

  it("keeps a bare repository's own directory", () => {
    const git = fakeGit({ "/srv/repo.git": { common: "/srv/repo.git" } });
    expect(gitRepositoryRoot("/srv/repo.git", git)).toBe("/srv/repo.git");
  });

  it("returns null when git fails or prints nothing", () => {
    expect(gitRepositoryRoot("/plain", () => null)).toBeNull();
    expect(gitRepositoryRoot("/plain", fakeGit({ "/plain": { common: "" } }))).toBeNull();
    expect(gitRepositoryRoot("/plain", fakeGit({ "/plain": { common: "  \n" } }))).toBeNull();
  });

  it("keeps a submodule's own checkout when git reports a superproject", () => {
    const git = fakeGit({
      "/super/vendor/lib": {
        common: "/super/.git/modules/vendor/lib",
        toplevel: "/super/vendor/lib",
        superproject: "/super",
      },
      "/super": { common: "/super/.git", toplevel: "/super" },
    });
    expect(gitRepositoryRoot("/super/vendor/lib", git)).toBe("/super/vendor/lib");
  });
});

describe("resolveProjectId", () => {
  it("uses the repository root when there is one", () => {
    const git = fakeGit({ "/repo/sub": { common: "/repo/.git", toplevel: "/repo/sub" } });
    expect(resolveProjectId("/repo/sub", git)).toBe("/repo");
  });

  it("falls back to the absolute directory outside a repository", () => {
    expect(resolveProjectId("/plain", () => null)).toBe(resolve("/plain"));
  });

  it("keeps an explicit opaque id that is not an absolute path", () => {
    expect(resolveProjectId("p-vestigio", () => null)).toBe("p-vestigio");
    expect(resolveProjectId("p-vestigio")).toBe("p-vestigio");
  });

  it("names a submodule below its superproject", () => {
    const git = fakeGit({
      "/super": { common: "/super/.git", toplevel: "/super" },
      "/super/vendor/lib": {
        common: "/super/.git/modules/vendor/lib",
        toplevel: "/super/vendor/lib",
        superproject: "/super",
      },
    });
    expect(resolveProjectId("/super/vendor/lib", git)).toBe("/super/vendor/lib");
    expect(resolveProjectId("/super/vendor/lib", git)).not.toContain("/.git/");
  });

  it("gives a worktree of a submodule the submodule's id", () => {
    const git = fakeGit({
      "/super": { common: "/super/.git", toplevel: "/super" },
      "/super/vendor/lib": {
        common: "/super/.git/modules/vendor/lib",
        toplevel: "/super/vendor/lib",
        superproject: "/super",
      },
      "/vendor-wt": { common: "/super/vendor/lib/.git", toplevel: "/vendor-wt" },
    });
    expect(resolveProjectId("/vendor-wt", git)).toBe("/super/vendor/lib");
  });
});

describe("describeProjectIdentity", () => {
  it("reports the id, path, repository root and source inside a repository", () => {
    const git = fakeGit({
      "/repo/sub": { common: "/repo/.git", toplevel: "/repo/sub" },
      "/repo": { common: "/repo/.git", toplevel: "/repo" },
    });
    expect(describeProjectIdentity("/repo/sub", git)).toEqual({
      path: "/repo/sub",
      project_id: "/repo",
      repository_root: "/repo",
      source: "repository",
    });
  });

  it("keeps a path outside any repository as its own id with no root", () => {
    expect(describeProjectIdentity("/plain", () => null)).toEqual({
      path: "/plain",
      project_id: "/plain",
      repository_root: null,
      source: "path",
    });
  });

  it("resolves a relative path against the cwd", () => {
    expect(describeProjectIdentity("sub", () => null)).toEqual({
      path: resolve("sub"),
      project_id: resolve("sub"),
      repository_root: null,
      source: "path",
    });
  });
});

describe("project settings", () => {
  it("uses a repo declaration as the repository root", () => {
    const fixture = repoFixture();
    writeSettings(fixture.root, { project: "repo" });
    expect(resolveProjectId(fixture.nested, fixture.git)).toBe(fixture.root);
    expect(describeProjectIdentity(fixture.nested, fixture.git).source).toBe("repository");
  });

  it("uses self from a nested subdirectory", () => {
    const fixture = repoFixture();
    writeSettings(fixture.root, { project: "self" });
    const identity = describeProjectIdentity(fixture.nested, fixture.git);
    expect(identity.project_id).toBe(fixture.root);
    expect(identity.source).toBe("settings");
  });

  it("resolves a relative path against the settings directory", () => {
    const fixture = repoFixture();
    const shared = join(fixture.parent, "shared");
    mkdirSync(shared);
    writeSettings(fixture.root, { project: "../shared" });
    expect(resolveProjectId(fixture.nested, fixture.git)).toBe(shared);
  });

  it("treats an absent project key as repo", () => {
    const fixture = repoFixture();
    writeSettings(fixture.root, {});
    expect(resolveProjectId(fixture.nested, fixture.git)).toBe(fixture.root);
  });

  it("falls back to the path when repo is declared outside a repository", () => {
    const parent = tempDir("vestigio-outside-");
    writeSettings(parent, { project: "repo" });
    expect(describeProjectIdentity(parent, () => null)).toEqual({
      path: parent,
      project_id: parent,
      repository_root: null,
      source: "path",
    });
  });

  it("accepts self outside a repository", () => {
    const parent = tempDir("vestigio-outside-");
    const plain = join(parent, "plain");
    mkdirSync(plain);
    writeSettings(plain, { project: "self" });
    expect(describeProjectIdentity(plain, () => null).project_id).toBe(plain);
    expect(describeProjectIdentity(plain, () => null).source).toBe("settings");
  });

  const invalid: [string, unknown][] = [
    ["unknown key", { project: "repo", scope: "x" }],
    ["wrong type", { project: 42 }],
    ["empty string", { project: "" }],
    ["bad JSON", "{"],
    ["missing target", { project: "../absent" }],
  ];

  for (const [problem, contents] of invalid) {
    it(`rejects ${problem} naming the file`, () => {
      const fixture = repoFixture();
      const file = writeSettings(fixture.root, contents);
      const error = settingsFailure(() => resolveProjectId(fixture.nested, fixture.git));
      expect(error.file).toBe(file);
      expect(error.message).toContain(file);
    });
  }
});

describe("settings discovery", () => {
  it("prefers the nearest settings file", () => {
    const fixture = repoFixture();
    writeSettings(fixture.root, { project: "self" });
    writeSettings(fixture.nested, { project: "self" });
    expect(resolveProjectId(fixture.nested, fixture.git)).toBe(fixture.nested);
    expect(resolveProjectId(fixture.root, fixture.git)).toBe(fixture.root);
  });

  it("ignores a settings file above the repository root", () => {
    const fixture = repoFixture();
    writeSettings(fixture.parent, { project: "self" });
    expect(resolveProjectId(fixture.root, fixture.git)).toBe(fixture.root);
    expect(resolveProjectId(fixture.nested, fixture.git)).toBe(fixture.root);
  });

  it("checks only the directory itself outside any repository", () => {
    const parent = tempDir("vestigio-outside-");
    const plain = join(parent, "plain");
    mkdirSync(plain);
    writeSettings(parent, { project: "self" });
    expect(resolveProjectId(plain, () => null)).toBe(plain);
    writeSettings(plain, { project: "self" });
    expect(resolveProjectId(plain, () => null)).toBe(plain);
    expect(describeProjectIdentity(plain, () => null).source).toBe("settings");
  });
});

describe("projectAliases", () => {
  it("aliases a stale worktree id and nothing else", () => {
    const fixture = repoFixture();
    expect(projectAliases(fixture.root, [fixture.root, fixture.worktree, "/other", "/plain"], fixture.git)).toEqual([
      fixture.root,
      fixture.worktree,
    ]);
  });

  it("keeps a root and a self scope apart in both directions", () => {
    const fixture = repoFixture();
    const scoped = join(fixture.root, "packages", "core");
    mkdirSync(scoped, { recursive: true });
    fixture.track(scoped);
    writeSettings(scoped, { project: "self" });
    const known = [fixture.root, fixture.worktree, scoped];
    expect(projectAliases(fixture.root, known, fixture.git)).toEqual([fixture.root, fixture.worktree]);
    expect(projectAliases(scoped, known, fixture.git)).toEqual([scoped]);
  });

  it("reads a self scope over only its own rows", () => {
    const fixture = repoFixture();
    const scoped = join(fixture.root, "packages", "core");
    mkdirSync(scoped, { recursive: true });
    fixture.track(scoped);
    writeSettings(scoped, { project: "self" });
    const store = openTempStore();
    store.saveMemory(
      parseMemory(
        storedMemory({
          body: bodyWith("仓库级端口是 8787。"),
          scope: { kind: "project", project_id: fixture.root },
        }),
      ),
    );
    store.saveMemory(
      parseMemory(
        storedMemory({
          memory_id: "mem-0002",
          uri: "memory://vestigio/mem-0002",
          body: bodyWith("包级端口是 9090。"),
          scope: { kind: "project", project_id: scoped },
        }),
      ),
    );

    const scope = withProjectAliases(
      { kind: "project", project_id: scoped },
      [fixture.root, fixture.worktree, scoped],
      fixture.git,
    );
    expect(scopeProjectIds(scope)).toEqual([scoped]);
    expect(store.listHeads(scope).map((memory) => memory.uri)).toEqual(["memory://vestigio/mem-0002"]);
    store.close();
  });

  it("does not alias an id that has no repository root", () => {
    const fixture = repoFixture();
    expect(projectAliases("/plain", [fixture.root, "/plain"], fixture.git)).toEqual(["/plain"]);
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
    const fixture = repoFixture();
    const scope = withProjectAliases(
      { kind: "project", project_id: fixture.root },
      [fixture.root, fixture.worktree],
      fixture.git,
    );
    expect(scope).toEqual({
      kind: "project",
      project_id: fixture.root,
      project_ids: [fixture.root, fixture.worktree],
    });
  });
});

describe("real repositories", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "vestigio-project-")));
  const root = join(parent, "repo");
  const subdir = join(root, "packages", "core");
  const worktree = join(parent, "worktree");
  const nestedRepository = join(root, "inner");
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "vestigio-plain-")));
  const submoduleSource = join(parent, "submodule-source");
  const superproject = join(parent, "superproject");
  const vendored = join(superproject, "vendor", "lib");
  const superWorktree = join(parent, "super-worktree");
  const superWorktreeVendored = join(superWorktree, "vendor", "lib");
  const vendoredWorktree = join(parent, "vendored-worktree");
  const cloneA = join(parent, "clone-a");
  const cloneB = join(parent, "clone-b");

  mkdirSync(subdir, { recursive: true });
  runGit(root, ["init", "-q"]);
  writeFileSync(join(root, "README.md"), "seed\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-qm", "init"]);
  runGit(root, ["worktree", "add", "-q", worktree]);

  mkdirSync(nestedRepository, { recursive: true });
  runGit(nestedRepository, ["init", "-q"]);
  writeFileSync(join(nestedRepository, "package.json"), "{}\n");
  runGit(nestedRepository, ["add", "."]);
  runGit(nestedRepository, ["commit", "-qm", "init"]);

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
  runGit(superproject, ["worktree", "add", "-q", superWorktree]);
  runGit(superWorktree, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
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

  it("keeps a nested plain repository out of its enclosing repository", () => {
    expect(gitRepositoryRoot(nestedRepository)).toBe(nestedRepository);
    expect(resolveProjectId(nestedRepository)).toBe(nestedRepository);
    expect(resolveProjectId(nestedRepository)).not.toBe(resolveProjectId(root));
  });

  it("names a submodule below its superproject instead of its git directory", () => {
    expect(gitRepositoryRoot(vendored)).toBe(vendored);
    expect(resolveProjectId(vendored)).toBe(join(superproject, "vendor", "lib"));
    expect(resolveProjectId(vendored)).not.toBe(resolveProjectId(superproject));
    expect(resolveProjectId(vendored)).not.toContain("/.git/");
  });

  it("gives a submodule one id from the main checkout and a superproject worktree", () => {
    expect(resolveProjectId(superWorktreeVendored)).toBe(join(superproject, "vendor", "lib"));
    expect(resolveProjectId(superWorktreeVendored)).toBe(resolveProjectId(vendored));
  });

  it("gives a submodule one id across its own worktrees and one per clone", () => {
    expect(gitRepositoryRoot(vendoredWorktree)).toBe(vendored);
    expect(resolveProjectId(vendoredWorktree)).toBe(resolveProjectId(vendored));
    expect(resolveProjectId(cloneA)).toBe(cloneA);
    expect(resolveProjectId(cloneB)).toBe(cloneB);
    expect(resolveProjectId(cloneA)).not.toBe(resolveProjectId(cloneB));
  });

  it("describes a linked worktree with the shared id and its own path", () => {
    expect(describeProjectIdentity(root)).toEqual({
      path: root,
      project_id: root,
      repository_root: root,
      source: "repository",
    });
    expect(describeProjectIdentity(worktree)).toEqual({
      path: worktree,
      project_id: root,
      repository_root: root,
      source: "repository",
    });
    expect(describeProjectIdentity(subdir).project_id).toBe(root);
  });

  it("describes a submodule with the derived id and a submodule source", () => {
    expect(describeProjectIdentity(vendored)).toEqual({
      path: vendored,
      project_id: join(superproject, "vendor", "lib"),
      repository_root: vendored,
      source: "submodule",
    });
  });

  it("describes a non-git directory as its own id with no repository root", () => {
    expect(describeProjectIdentity(plain)).toEqual({
      path: plain,
      project_id: plain,
      repository_root: null,
      source: "path",
    });
  });
});
