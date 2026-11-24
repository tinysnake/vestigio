#!/usr/bin/env node
/**
 * Fails a file that can start a vestigio daemon without also stopping one.
 * Production `src/` is out of scope: a library may build a client it does not own.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".ts"]);

const STARTER_PATTERNS = [
	/ensureDaemon\(/,
	/openDaemon\(/,
	/new VestigioClient\(/,
	/daemon\/src\/entry\.ts/,
];
const EXTENSION_STORE_PATTERN = /VESTIGIO_STORE/;
const EXTENSION_SOURCE_PATTERN = /src\/extension\.|pi-extension\/src\/extension/;

const STOP_PATTERN = /\.stop\(\)/;
const RUNNING_PATTERN = /daemonRunning\(/;

const SKIP_DIRECTORIES = new Set(["node_modules", "out", ".git", "dist", "coverage"]);

function collectFiles(directory, files) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRECTORIES.has(entry.name)) continue;
			collectFiles(path, files);
			continue;
		}
		if (entry.isFile() && SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
			files.push(path);
		}
	}
}

function scanRoots() {
	const root = resolve(ROOT);
	const files = [];
	for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		collectIfDirectory(join(root, "packages", entry.name, "test"), files);
	}
	for (const name of ["eval", "scripts"]) collectIfDirectory(join(root, name), files);
	return files;
}

function collectIfDirectory(directory, files) {
	try {
		if (statSync(directory).isDirectory()) collectFiles(directory, files);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}

function locations(lines, pattern) {
	const found = [];
	lines.forEach((line, index) => {
		if (pattern.test(line)) found.push(index + 1);
	});
	return found;
}

function starterLinesFor(lines, text) {
	const starterLines = [];
	for (const pattern of STARTER_PATTERNS) {
		for (const line of locations(lines, pattern)) starterLines.push({ line, pattern });
	}
	if (EXTENSION_STORE_PATTERN.test(text) && EXTENSION_SOURCE_PATTERN.test(text)) {
		for (const line of locations(lines, EXTENSION_STORE_PATTERN)) {
			starterLines.push({ line, pattern: EXTENSION_STORE_PATTERN });
		}
	}
	return starterLines;
}

function main() {
	const files = scanRoots().sort();
	const offenders = [];
	let filesScanned = 0;
	let starters = 0;

	for (const file of files) {
		filesScanned += 1;
		const lines = readFileSync(file, "utf8").split("\n");
		const text = lines.join("\n");
		const starterLines = starterLinesFor(lines, text);
		if (starterLines.length === 0) continue;
		starters += starterLines.length;

		const missing = [];
		if (!STOP_PATTERN.test(text)) missing.push(".stop()");
		if (!RUNNING_PATTERN.test(text)) missing.push("daemonRunning(");
		if (missing.length === 0) continue;
		const path = relative(fileURLToPath(new URL("..", import.meta.url)), file);
		offenders.push({ path, starterLines: starterLines.sort((a, b) => a.line - b.line), missing });
	}

	if (offenders.length > 0) {
		console.error("daemon lifecycle lint failed:");
		for (const offender of offenders) {
			for (const starter of offender.starterLines) {
				console.error(`  ${offender.path}:${starter.line}  starts a daemon (${starter.pattern.source})  missing ${offender.missing.join(" and ")}`);
			}
		}
		console.error("");
		console.error("Every file that can start a daemon must also call .stop() on the client");
		console.error("it created and assert daemonRunning(store) is false afterwards.");
		return 1;
	}

	console.log(`${filesScanned} files scanned, ${starters} starters, all closed`);
	return 0;
}

process.exitCode = main();
