#!/usr/bin/env node
/**
 * Fails a file that can start a vestigio daemon without also closing one.
 *
 * Scope is the whole tree rather than a list of probe directories, because a
 * throwaway probe left in an unscanned corner is exactly how a detached daemon
 * outlives its run: the probe owns the process, nothing reaps it, and `ps` then
 * shows a node process nobody can name.
 *
 * A file can start one through the client helpers, a raw spawn of the daemon
 * entry or its `--import` hook, or a CLI invocation that runs a subcommand
 * ensuring a daemon (`--help` does not). A shell script counts when it runs
 * such a subcommand directly.
 *
 * The closer may be `.stop()`, a CLI `stop`, or `--once`: `--once` stops the
 * daemon that invocation started and never one another invocation started.
 * Alongside it the file must prove the daemon is gone, with `daemonRunning(`
 * or a check on the endpoint file. A probe that delegates to
 * `eval/lib/daemon.mjs`'s `stopProbeDaemons()` gets both halves from that call:
 * it stops every store it is handed and returns the stores still running.
 *
 * Production `packages/<name>/src` stays out of scope: a library may build or
 * return a client it does not own. Its tests are in scope.
 *
 *   node scripts/lint-daemon-lifecycle.mjs [--root <dir>]
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".sh"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "out", "coverage", ".git", ".t3", ".next", ".turbo"]);
/** Files whose daemon-looking strings are fixtures or the patterns themselves. */
const EXEMPT_FILES = new Set(["scripts/lint-daemon-lifecycle.mjs", "scripts/lint-daemon-lifecycle.test.mjs"]);

const STARTER_PATTERNS = [
	{ pattern: /ensureDaemon\(/, label: "ensureDaemon(" },
	{ pattern: /openDaemon\(/, label: "openDaemon(" },
	{ pattern: /new VestigioClient\(/, label: "new VestigioClient(" },
	{ pattern: /daemon\/src\/entry\.ts/, label: "spawns the daemon entry" },
	{ pattern: /daemon\/hook\.mjs/, label: "spawns the daemon through its import hook" },
];

/** A CLI invocation only starts a daemon for a subcommand that needs one. */
const CLI_BUILDER_PATTERN = /cliCommand\(/;
const CLI_SUBCOMMAND_PATTERN = /["'`](search|gc|submit|stats|prune|get|projects|daemon)["'`]/;

const SHELL_STARTER_PATTERNS = [
	{ pattern: /\bvestigio\s+daemon\s+start\b/, label: "vestigio daemon start" },
	{ pattern: /\bvestigio\s+(search|gc|submit|stats|prune|get|projects)\b/, label: "a CLI subcommand that ensures a daemon" },
];

const EXTENSION_STORE_PATTERN = /VESTIGIO_STORE/;
const EXTENSION_SOURCE_PATTERN = /src\/extension\.|pi-extension\/src\/extension/;

const CLOSER_PATTERNS = [
	{ pattern: /\.stop\(\)/, label: ".stop()" },
	{ pattern: /["'`]stop["'`]/, label: "the CLI stop subcommand" },
	{ pattern: /\bdaemon\s+stop\b/, label: "daemon stop" },
	{ pattern: /--once\b/, label: "--once" },
];

const PROOF_PATTERNS = [
	{ pattern: /daemonRunning\(/, label: "daemonRunning(" },
	{ pattern: /endpoint\.json/, label: "an endpoint-file check" },
];

/**
 * The one helper a probe may delegate to. It stops every daemon it is handed
 * and reports the survivors, so calling it both closes a probe and proves the
 * close happened.
 */
const SHARED_STOP_PATTERN = { pattern: /stopProbeDaemons\(/, label: "stopProbeDaemons(" };

function rootFromArguments(argv) {
	const index = argv.indexOf("--root");
	if (index === -1) return resolve(REPO_ROOT);
	const value = argv[index + 1];
	if (value === undefined) {
		console.error("--root needs a directory");
		process.exit(2);
	}
	return resolve(value);
}

function isProductionSource(display) {
	return /^packages\/[^/]+\/src\//.test(display);
}

function collectFiles(directory, files, root) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (SKIP_DIRECTORIES.has(entry.name)) continue;
		const path = join(directory, entry.name);
		const display = relative(root, path);
		if (isProductionSource(display)) continue;
		if (entry.isDirectory()) {
			collectFiles(path, files, root);
			continue;
		}
		if (!entry.isFile()) continue;
		const extension = entry.name.slice(entry.name.lastIndexOf("."));
		if (SOURCE_EXTENSIONS.has(extension)) files.push(path);
	}
}

function locations(lines, pattern) {
	const found = [];
	lines.forEach((line, index) => {
		if (pattern.test(line)) found.push(index + 1);
	});
	return found;
}

function startersFor(file, lines, text) {
	const starters = [];
	const shell = file.endsWith(".sh");
	const patterns = shell ? [...STARTER_PATTERNS, ...SHELL_STARTER_PATTERNS] : [...STARTER_PATTERNS];
	for (const { pattern, label } of patterns) {
		for (const line of locations(lines, pattern)) starters.push({ line, label });
	}
	if (!shell && CLI_BUILDER_PATTERN.test(text) && CLI_SUBCOMMAND_PATTERN.test(text)) {
		for (const line of locations(lines, CLI_BUILDER_PATTERN)) starters.push({ line, label: "runs the CLI, which ensures a daemon" });
	}
	if (!shell && EXTENSION_STORE_PATTERN.test(text) && EXTENSION_SOURCE_PATTERN.test(text)) {
		for (const line of locations(lines, EXTENSION_STORE_PATTERN)) starters.push({ line, label: "binds the extension to a store" });
	}
	return starters.sort((a, b) => a.line - b.line);
}

function main() {
	const root = rootFromArguments(process.argv.slice(2));
	if (!existsSync(root) || !statSync(root).isDirectory()) {
		console.error(`not a directory: ${root}`);
		return 2;
	}

	const files = [];
	collectFiles(root, files, root);
	files.sort();

	const offenders = [];
	let scanned = 0;
	let starters = 0;

	for (const file of files) {
		const display = relative(root, file);
		if (EXEMPT_FILES.has(display)) continue;
		scanned += 1;

		const lines = readFileSync(file, "utf8").split("\n");
		const text = lines.join("\n");
		const startersHere = startersFor(file, lines, text);
		if (startersHere.length === 0) continue;
		starters += startersHere.length;

		const shared = SHARED_STOP_PATTERN.pattern.test(text);
		const closer = shared ? SHARED_STOP_PATTERN : CLOSER_PATTERNS.find((entry) => entry.pattern.test(text));
		const proof = shared ? SHARED_STOP_PATTERN : PROOF_PATTERNS.find((entry) => entry.pattern.test(text));

		const missing = [];
		if (closer === undefined) missing.push("a stop (.stop(), a CLI stop, --once, or stopProbeDaemons())");
		if (proof === undefined) missing.push("daemonRunning(), an endpoint-file check, or stopProbeDaemons()");
		if (missing.length === 0) continue;

		offenders.push({ display, startersHere, missing });
	}

	if (offenders.length > 0) {
		console.error("daemon lifecycle lint failed:");
		for (const offender of offenders) {
			for (const starter of offender.startersHere) {
				console.error(`  ${offender.display}:${starter.line}  starts a daemon (${starter.label})  missing ${offender.missing.join(" and ")}`);
			}
		}
		console.error("");
		console.error("Every file that can start a daemon must stop the one it started and assert it is gone");
		console.error("(daemonRunning(store) is false, or the endpoint file removed). `--once` counts as the stop");
		console.error("for a CLI invocation that owns the daemon.");
		return 1;
	}

	console.log(`${scanned} files scanned, ${starters} starters, all closed`);
	return 0;
}

process.exitCode = main();
