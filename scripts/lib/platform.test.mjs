#!/usr/bin/env node
/**
 * Rejects a filesystem path where `node --import` needs a specifier.
 *
 * Node reads a bare `packages/cli/hook.mjs` as a package name and an absolute
 * path as an unknown URL scheme, so both fail before the hook loads. A script
 * that builds the specifier out of a path with `join(`, `resolve(` or
 * `fileURLToPath(` therefore breaks on Windows while looking correct on the
 * machine it was written on.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { hookUrl } from "./platform.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPTS = join(REPO_ROOT, "scripts");
/** This file names the patterns it looks for, so it never scans itself. */
const SELF = "scripts/lib/platform.test.mjs";

function sourceFiles(directory, files = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			sourceFiles(path, files);
			continue;
		}
		if (/\.(mjs|js|cjs|ts)$/.test(entry.name)) files.push(path);
	}
	return files;
}

function display(path) {
	return relative(REPO_ROOT, path).split(sep).join("/");
}

/** The expression that follows a quoted `"--import"` in an argument list. */
function importArguments(text) {
	const found = [];
	for (const match of text.matchAll(/"--import"\s*,\s*([^,\]\n]+)/g)) found.push(match[1].trim());
	return found;
}

function offender(value) {
	if (/hookUrl\(|pathToFileURL\(/.test(value)) return undefined;
	const literal = /^["'`]([\s\S]*)["'`]$/.exec(value);
	if (literal === null) {
		// An expression such as join(root, "packages/cli/hook.mjs").
		return /\b(join|resolve|fileURLToPath)\s*\(|\b(HERE|ROOT)\b/.test(value) ? value : undefined;
	}
	const specifier = literal[1];
	if (!specifier.includes("/")) return undefined; // a bare package name
	return /^(\.\.?\/|file:|node:|@)/.test(specifier) ? undefined : value;
}

test("every --import argument in scripts/ is a specifier Node accepts", () => {
	const offenders = [];
	for (const file of sourceFiles(SCRIPTS)) {
		if (display(file) === SELF) continue;
		for (const value of importArguments(readFileSync(file, "utf8"))) {
			const found = offender(value);
			if (found !== undefined) offenders.push(`${display(file)}  --import ${found}`);
		}
	}
	assert.deepEqual(offenders, []);
});

test("hookUrl is the file URL for this checkout's CLI hook", () => {
	const url = hookUrl(REPO_ROOT);
	assert.match(url, /^file:\/\//);
	assert.ok(url.endsWith("/packages/cli/hook.mjs"), url);
	assert.doesNotMatch(url, /\\/);
});
