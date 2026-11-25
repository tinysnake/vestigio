#!/usr/bin/env node
/**
 * Fast-forwards this checkout to the remote branch and runs the new code.
 *
 * The hooks in `.git/hooks` only see local merges, so a merge made on GitHub
 * reaches this machine whenever somebody remembers to pull. This script is the
 * half that polls: `launchd` runs it on a timer, it fetches, and when the
 * remote is ahead it fast-forwards, installs dependencies if the lockfile
 * moved, and restarts the daemon from the new tree.
 *
 * It never rewrites anything. A dirty tree, a local commit on the branch (the
 * fast-forward is impossible), or a fetch that fails all end in a log line and
 * exit 0. Hooks are disabled for the pull so this script, not `post-merge`,
 * owns the order: dependencies first, daemon second.
 *
 *   node scripts/sync-local-vestigio.mjs [--branch main] [--store <path>]
 *   … --dry-run    say what it would do and change nothing
 *   … --verbose    also print the "up to date" case
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hookUrl } from "./lib/platform.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
};

const branch = option("--branch") ?? "main";
const store = option("--store");
const dryRun = flag("--dry-run");
const verbose = flag("--verbose");

const stamp = () => new Date().toISOString();
const say = (line) => console.log(`${stamp()} ${line}`);

function git(root, ...args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(root, ...args) {
	try {
		return { ok: true, out: git(root, ...args) };
	} catch (error) {
		return { ok: false, out: `${error.stderr ?? ""}${error.message ?? error}`.trim() };
	}
}

function main() {
	const root = git(process.cwd(), "rev-parse", "--show-toplevel");
	const current = tryGit(root, "symbolic-ref", "--quiet", "--short", "HEAD").out;
	if (current !== branch) {
		say(`skipped: this checkout is on ${current || "(detached)"}, not ${branch}`);
		return 0;
	}

	const fetched = tryGit(root, "fetch", "--quiet", "origin", branch);
	if (!fetched.ok) {
		say(`fetch failed, nothing changed: ${fetched.out.split("\n")[0]}`);
		return 0;
	}

	const before = git(root, "rev-parse", "HEAD");
	const remote = git(root, "rev-parse", `origin/${branch}`);
	if (before === remote) {
		if (verbose) say(`up to date at ${before.slice(0, 7)}`);
		return 0;
	}

	const ancestor = tryGit(root, "merge-base", "--is-ancestor", before, remote);
	if (!ancestor.ok) {
		say(`skipped: ${branch} has local commits the remote does not (${before.slice(0, 7)} vs ${remote.slice(0, 7)})`);
		return 0;
	}

	const dirty = git(root, "status", "--porcelain", "--untracked-files=no");
	if (dirty !== "") {
		say(`skipped: ${dirty.split("\n").length} tracked file(s) modified; commit or stash them`);
		return 0;
	}

	if (dryRun) {
		say(`would fast-forward ${before.slice(0, 7)} -> ${remote.slice(0, 7)} and restart from there`);
		return 0;
	}

	const changed = tryGit(root, "diff", "--name-only", `${before}..${remote}`).out.split("\n");
	const pulled = tryGit(root, "-c", "core.hooksPath=/dev/null", "pull", "--ff-only", "--quiet", "origin", branch);
	if (!pulled.ok) {
		say(`fast-forward failed, checkout unchanged: ${pulled.out.split("\n")[0]}`);
		return 0;
	}
	say(`fast-forwarded ${before.slice(0, 7)} -> ${remote.slice(0, 7)}`);

	const dependencies = changed.some((path) => /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(path));
	if (dependencies) {
		say("installing dependencies: the lockfile or a package manifest moved");
		execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" });
	}

	const restart = join(root, "scripts/restart-local-vestigio.mjs");
	if (!existsSync(restart)) {
		say(`no ${restart}; the pull landed but no daemon was restarted`);
		return 0;
	}
	const args = ["--import", hookUrl(root), restart, "--hook"];
	if (store !== undefined) args.push("--store", store);
	execFileSync(process.execPath, args, { cwd: root, stdio: "inherit" });
	return 0;
}

try {
	process.exitCode = main();
} catch (error) {
	say(`failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 0;
}
