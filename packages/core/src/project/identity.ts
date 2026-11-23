/**
 * Project identity.
 *
 * A memory's project is the git repository that owns the session directory, not
 * the directory itself: every worktree of one repository resolves to the same
 * id, so a memory written from one worktree is readable from another. An
 * explicit project id still wins, and a directory outside any repository keeps
 * its own absolute path as the id.
 *
 * The repository root is derived from `git rev-parse --git-common-dir`, which
 * every linked worktree shares, rather than from `--show-toplevel`, which is the
 * worktree's own checkout. A submodule's common directory lives inside the
 * parent's `.git/modules`, so its checkout is read back from `core.worktree`.
 */

import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { Scope } from "../contracts/types.js";

/** Runs git for a directory and returns its stdout, or null when the command fails. */
export type GitRunner = (dir: string, args: readonly string[]) => string | null;

const COMMON_DIR_ARGS = ["rev-parse", "--path-format=absolute", "--git-common-dir"] as const;
const WORKTREE_ARGS = ["config", "--get", "core.worktree"] as const;

/**
 * One spawn per directory and argument list per process. The lookup is a
 * synchronous `git` call that measures at about 6 ms here, and the extension
 * asks on every input event, so the answer is memoized: the repository owning a
 * directory does not change while a session runs.
 */
const gitOutput = new Map<string, string | null>();

function runGit(dir: string, args: readonly string[]): string | null {
	const key = `${dir}\u0000${args.join("\u0000")}`;
	const cached = gitOutput.get(key);
	if (cached !== undefined) return cached;
	let output: string | null;
	try {
		output = execFileSync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		output = null;
	}
	gitOutput.set(key, output);
	return output;
}

/**
 * The checkout a git directory belongs to, for a git directory that is not the
 * `.git` of its own checkout. A submodule keeps its git directory inside the
 * parent's `.git/modules` and records its checkout in `core.worktree`, relative
 * to that directory; every worktree of that submodule shares both. A bare
 * repository records no worktree and has no checkout.
 */
function checkoutOfGitDir(gitDir: string, git: GitRunner): string | null {
	const raw = git(gitDir, WORKTREE_ARGS);
	if (raw === null) return null;
	const value = raw.trim();
	return value === "" ? null : resolve(gitDir, value);
}

/**
 * The git repository root that owns `dir`, or null when `dir` is not inside a
 * repository. A checkout and every linked worktree of it report `<root>/.git`,
 * so the root is its parent; a submodule reports a git directory under the
 * parent's `.git/modules` and resolves to its own checkout, which every worktree
 * of that submodule shares; a bare repository reports its own directory.
 */
export function gitRepositoryRoot(dir: string, git: GitRunner = runGit): string | null {
	const raw = git(dir, COMMON_DIR_ARGS);
	if (raw === null) return null;
	const common = raw.trim();
	if (common === "") return null;
	if (basename(common) === ".git") return dirname(common);
	return checkoutOfGitDir(common, git) ?? common;
}

/**
 * The stable project id for `dir`: the repository root, else its absolute path.
 * Only absolute paths name a directory; an explicit opaque id passes through.
 */
export function resolveProjectId(dir: string, git: GitRunner = runGit): string {
	if (!isAbsolute(dir)) return dir;
	return gitRepositoryRoot(dir, git) ?? resolve(dir);
}

/**
 * The canonical identity of one directory: the id every store call must use,
 * the directory it was derived from, and its repository root.
 */
export type ProjectIdentity = {
	/** The directory the id was derived from, absolute. */
	path: string;
	/** The canonical id every store call must use. */
	project_id: string;
	/** The git repository root, or null when path is outside a repository. */
	repository_root: string | null;
};

/**
 * The identity for `dir`: its absolute path, the canonical id resolved from it,
 * and the repository root (null outside a repository).
 */
export function describeProjectIdentity(dir: string, git: GitRunner = runGit): ProjectIdentity {
	const path = resolve(dir);
	const repository_root = gitRepositoryRoot(path, git);
	return { path, project_id: repository_root ?? path, repository_root };
}

/**
 * The canonical id followed by every known id that shares its repository root.
 * Known ids outside a repository, or from another repository, are not aliases.
 */
export function projectAliases(projectId: string, known: readonly string[], git: GitRunner = runGit): string[] {
	const root = gitRepositoryRoot(projectId, git);
	const aliases = [projectId];
	if (root === null) return aliases;
	for (const id of known) {
		if (id === projectId) continue;
		if (gitRepositoryRoot(id, git) === root) aliases.push(id);
	}
	return aliases;
}

/**
 * The project ids a scope reads over: the canonical id plus its read-only
 * aliases. A global scope reads over no project ids.
 */
export function scopeProjectIds(scope: Scope): readonly string[] {
	if (scope.kind === "global") return [];
	return [...new Set([scope.project_id, ...(scope.project_ids ?? [])])];
}

/**
 * A read-side copy of a project scope widened with its aliases. Global scopes
 * pass through untouched, and the canonical id stays first so labels do not
 * change.
 */
export function withProjectAliases(scope: Scope, known: readonly string[], git: GitRunner = runGit): Scope {
	if (scope.kind === "global") return scope;
	return {
		kind: "project",
		project_id: scope.project_id,
		...(scope.history_path === undefined ? {} : { history_path: scope.history_path }),
		project_ids: projectAliases(scope.project_id, known, git),
	};
}
