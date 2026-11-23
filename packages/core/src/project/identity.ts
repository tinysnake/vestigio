/**
 * Project identity.
 *
 * A memory's project is resolved from the session directory by the first rule
 * that applies:
 *
 * 1. The nearest `.vestigio/settings.json` below the repository root, when it
 *    carries a `project` key.
 * 2. The git repository root, shared by every worktree of that repository.
 * 3. A submodule, named `<superproject id>/<path below the superproject>`, so
 *    the same submodule gets one id from the main checkout and from every
 *    worktree of the superproject.
 * 4. A directory outside any repository keeps its own real path as the id.
 *
 * A nested plain repository is its own root and never merges into an enclosing
 * repository, and a broken settings file is an error rather than a silently
 * different id. The superproject of a submodule is read from
 * `git rev-parse --show-superproject-working-tree`, which git reports for the
 * checkout that contains the submodule; a submodule's own `core.worktree` is
 * only a fallback for the git directory layout.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Scope } from "../contracts/types.js";

/** Runs git for a directory and returns its stdout, or null when the command fails. */
export type GitRunner = (dir: string, args: readonly string[]) => string | null;

const COMMON_DIR_ARGS = ["rev-parse", "--path-format=absolute", "--git-common-dir"] as const;
const TOP_LEVEL_ARGS = ["rev-parse", "--path-format=absolute", "--show-toplevel"] as const;
const SUPERPROJECT_ARGS = [
	"rev-parse",
	"--path-format=absolute",
	"--show-superproject-working-tree",
] as const;
const WORKTREE_ARGS = ["config", "--get", "core.worktree"] as const;

/** The per-directory settings file that can declare a project scope. */
export const PROJECT_SETTINGS_RELATIVE_PATH = join(".vestigio", "settings.json");

/** How a project id was derived, in rule order. */
export type ProjectIdSource = "settings" | "submodule" | "repository" | "path";

/** A settings file that cannot be read, parsed or honoured. */
export class ProjectSettingsError extends Error {
	readonly file: string;

	constructor(file: string, problem: string) {
		super(`${file}: ${problem}`);
		this.name = "ProjectSettingsError";
		this.file = file;
	}
}

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

function trimmed(output: string | null): string | null {
	if (output === null) return null;
	const value = output.trim();
	return value === "" ? null : value;
}

/**
 * The absolute path itself with symlinks resolved, or the absolute path when it
 * already points nowhere. `/tmp` and `/private/tmp` are one directory, and a
 * project id must not depend on which spelling reached it.
 */
function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isWithin(boundary: string, path: string): boolean {
	const below = relative(boundary, path);
	return below === "" || (!below.startsWith("..") && !isAbsolute(below));
}

/**
 * The checkout a git directory belongs to, for a git directory that is not the
 * `.git` of its own checkout. Kept as the fallback for a layout where git does
 * not report a working tree; a bare repository records no worktree and has no
 * checkout.
 */
function checkoutOfGitDir(gitDir: string, git: GitRunner): string | null {
	const raw = git(gitDir, WORKTREE_ARGS);
	if (raw === null) return null;
	const value = raw.trim();
	return value === "" ? null : resolve(gitDir, value);
}

/**
 * The git repository root that owns `dir`, or null when `dir` is not inside a
 * repository. A checkout and every linked worktree of it report `<root>/.git`
 * as the common directory, so the root is its parent. A submodule reports a
 * working tree of its own and a common directory elsewhere, and resolves to that
 * working tree, which is its own root and shared by its worktrees. A bare
 * repository reports its own directory.
 */
export function gitRepositoryRoot(dir: string, git: GitRunner = runGit): string | null {
	const common = trimmed(git(dir, COMMON_DIR_ARGS));
	if (common === null) return null;
	if (basename(common) === ".git") return dirname(common);
	const toplevel = trimmed(git(dir, TOP_LEVEL_ARGS));
	const superproject = trimmed(git(dir, SUPERPROJECT_ARGS));
	if (toplevel !== null) {
		if (superproject !== null) return toplevel;
		// A worktree of a submodule shares the submodule's git directory, and its
		// main checkout is the worktree git recorded there, not this one.
		return checkoutOfGitDir(common, git) ?? toplevel;
	}
	return checkoutOfGitDir(common, git) ?? common;
}

/**
 * The canonical identity of one directory: the id every store call must use,
 * the directory it was derived from, its repository root, and how the id was
 * derived.
 */
export type ProjectIdentity = {
	/** The directory the id was derived from, absolute and realpath'd. */
	path: string;
	/** The canonical id every store call must use. */
	project_id: string;
	/** The git repository root, or null when path is outside a repository. */
	repository_root: string | null;
	/** The rule that produced the id. */
	source: ProjectIdSource;
};

type DerivedIdentity = {
	project_id: string;
	repository_root: string | null;
	source: ProjectIdSource;
};

/**
 * The id git alone gives `path`: the submodule form when git reports a
 * superproject, else the repository root, else the path itself. A linked
 * worktree takes the canonical id of the repository root it shares, which is
 * how a worktree of a submodule resolves to that submodule's id as well.
 */
function derivedIdentity(path: string, git: GitRunner): DerivedIdentity {
	const toplevel = trimmed(git(path, TOP_LEVEL_ARGS));
	const superproject = trimmed(git(path, SUPERPROJECT_ARGS));
	if (superproject !== null && toplevel !== null) {
		const superRoot = realPath(superproject);
		const below = relative(superRoot, realPath(toplevel));
		const superIdentity = resolveIdentity(superRoot, git);
		return {
			project_id: `${superIdentity.project_id}/${below}`,
			repository_root: realPath(toplevel),
			source: "submodule",
		};
	}
	const root = gitRepositoryRoot(path, git);
	if (root === null) return { project_id: path, repository_root: null, source: "path" };
	if (root === path) return { project_id: root, repository_root: root, source: "repository" };
	const rootIdentity = resolveIdentity(root, git);
	return { project_id: rootIdentity.project_id, repository_root: root, source: rootIdentity.source };
}

function settingsFileAt(dir: string): string | null {
	const file = join(dir, PROJECT_SETTINGS_RELATIVE_PATH);
	try {
		return statSync(file).isFile() ? file : null;
	} catch {
		return null;
	}
}

/**
 * The nearest settings file from `path` up to and including the repository
 * working tree `path` belongs to. A directory outside any repository checks
 * only itself, which is why the walk never leaves that tree.
 */
function nearestSettingsFile(path: string, boundary: string): string | null {
	const start = isWithin(boundary, path) ? path : boundary;
	let dir = start;
	for (;;) {
		const file = settingsFileAt(dir);
		if (file !== null) return file;
		if (dir === boundary) return null;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * The `project` value of one settings file. An absent key means `"repo"`, and
 * every malformed file raises `ProjectSettingsError` instead of resolving to a
 * different id.
 */
function readProjectSetting(file: string): string {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		throw new ProjectSettingsError(file, `cannot read the file: ${errorMessage(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new ProjectSettingsError(file, `invalid JSON: ${errorMessage(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ProjectSettingsError(file, "settings must be a JSON object");
	}
	const settings = parsed as Record<string, unknown>;
	for (const key of Object.keys(settings)) {
		if (key !== "project") throw new ProjectSettingsError(file, `unknown key ${JSON.stringify(key)}`);
	}
	const project = settings["project"];
	if (project === undefined) return "repo";
	if (typeof project !== "string") throw new ProjectSettingsError(file, `"project" must be a string`);
	if (project.length === 0) throw new ProjectSettingsError(file, `"project" must not be an empty string`);
	return project;
}

/**
 * The id a settings `project` value declares. `repo` keeps the git-derived id,
 * `self` names the directory holding the file, and anything else names a
 * directory resolved against that one and required to exist.
 */
function applyProjectSetting(value: string, file: string, derived: DerivedIdentity): DerivedIdentity {
	if (value === "repo") return derived;
	const settingsDir = dirname(dirname(file));
	if (value === "self") {
		return {
			project_id: realPath(settingsDir),
			repository_root: derived.repository_root,
			source: "settings",
		};
	}
	const target = realPath(resolve(settingsDir, value));
	let isDirectory = false;
	try {
		isDirectory = statSync(target).isDirectory();
	} catch {
		isDirectory = false;
	}
	if (!isDirectory) {
		throw new ProjectSettingsError(file, `"project" names ${JSON.stringify(target)}, which is not an existing directory`);
	}
	return { project_id: target, repository_root: derived.repository_root, source: "settings" };
}

function resolveIdentity(path: string, git: GitRunner): DerivedIdentity {
	const derived = derivedIdentity(path, git);
	const toplevel = trimmed(git(path, TOP_LEVEL_ARGS));
	const boundary = toplevel === null ? path : realPath(toplevel);
	const file = nearestSettingsFile(path, boundary);
	if (file === null) return derived;
	return applyProjectSetting(readProjectSetting(file), file, derived);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The stable project id for `dir`, following the settings, repository,
 * submodule and path rules in order. Only absolute paths name a directory; an
 * explicit opaque id passes through.
 */
export function resolveProjectId(dir: string, git: GitRunner = runGit): string {
	if (!isAbsolute(dir)) return dir;
	return resolveIdentity(realPath(dir), git).project_id;
}

/**
 * The identity for `dir`: its absolute real path, the canonical id resolved from
 * it, the repository root (null outside a repository), and the id's source.
 */
export function describeProjectIdentity(dir: string, git: GitRunner = runGit): ProjectIdentity {
	const path = realPath(dir);
	const derived = resolveIdentity(path, git);
	return {
		path,
		project_id: derived.project_id,
		repository_root: derived.repository_root,
		source: derived.source,
	};
}

/**
 * The canonical id followed by the known ids that are stale for it: an id that
 * no longer resolves to itself and now resolves to `projectId`. Two current ids
 * of one repository are not aliases of each other, so a settings scope of the
 * directory (`self`) stays a real boundary. A known id whose settings file is
 * broken is left out rather than failing the read.
 */
export function projectAliases(projectId: string, known: readonly string[], git: GitRunner = runGit): string[] {
	const aliases = [projectId];
	for (const id of known) {
		if (id === projectId || !isAbsolute(id)) continue;
		let current: string;
		try {
			current = resolveProjectId(id, git);
		} catch (error) {
			if (error instanceof ProjectSettingsError) continue;
			throw error;
		}
		if (current !== id && current === projectId) aliases.push(id);
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
