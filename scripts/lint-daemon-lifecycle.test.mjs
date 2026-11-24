#!/usr/bin/env node
/**
 * Proves the daemon lifecycle lint still fails what it claims to fail.
 *
 * Each case writes a throwaway tree, runs the lint against it with `--root`,
 * and checks the exit code. The cases the first version missed are the ones
 * that matter: a probe outside the scanned directories, a CLI invocation that
 * ensures a daemon, and a shell script that starts one.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const LINT = fileURLToPath(new URL("./lint-daemon-lifecycle.mjs", import.meta.url));

function lint(files) {
	const root = mkdtempSync(join(tmpdir(), "daemon-lint-"));
	try {
		for (const [path, contents] of Object.entries(files)) {
			const target = join(root, path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, contents);
		}
		const result = spawnSync(process.execPath, [LINT, "--root", root], { encoding: "utf8" });
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("a file that starts a daemon and never stops it fails", () => {
	const result = lint({ "probe.mjs": "await openDaemon(store);\n" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /probe\.mjs:1\s+starts a daemon \(openDaemon\(/);
});

test("a file that stops and proves it passes", () => {
	const result = lint({ "probe.mjs": "await openDaemon(store);\nawait new VestigioClient(store).stop();\nassert.equal(await daemonRunning(store), false);\n" });
	assert.equal(result.status, 0, result.stderr);
});

test("a closer without a proof fails", () => {
	const result = lint({ "probe.mjs": "await openDaemon(store);\nawait new VestigioClient(store).stop();\n" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /missing daemonRunning\(\), an endpoint-file check, or stopProbeDaemons\(\)/);
});

test("a probe outside the old scan directories is still seen", () => {
	const result = lint({ "tools/scratch/probe.mjs": "spawn(node, [\"/repo/packages/daemon/src/entry.ts\", store]);\n" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /tools\/scratch\/probe\.mjs/);
});

test("a raw spawn through the daemon import hook is a starter", () => {
	const result = lint({ "probe.mjs": "spawn(node, [\"--import\", \"packages/daemon/hook.mjs\", entry, store]);\n" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /spawns the daemon through its import hook/);
});

test("a CLI invocation with a daemon-ensuring subcommand is a starter", () => {
	const result = lint({ "probe.mjs": "const { command, args } = cliCommand(ROOT, argv);\nrun(\"search\");\n" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /runs the CLI, which ensures a daemon/);
});

test("a CLI stop plus a proof closes a CLI invocation", () => {
	const result = lint({ "probe.mjs": "const { command, args } = cliCommand(ROOT, argv);\nrun(\"search\");\nrun(\"stop\");\nassert.equal(await daemonRunning(store), false);\n" });
	assert.equal(result.status, 0, result.stderr);
});

test("a CLI invocation of --help is not a starter", () => {
	const result = lint({ "probe.mjs": "const cli = cliCommand(ROOT, [\"--help\"]);\n" });
	assert.equal(result.status, 0, result.stderr);
});

test("a shell script that runs a daemon-ensuring subcommand fails", () => {
	const result = lint({ "probe.sh": "#!/bin/sh\nvestigio search --db \"$store\" --query x\n" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /a CLI subcommand that ensures a daemon/);
});

test("--once plus an endpoint check closes a shell script", () => {
	const result = lint({ "probe.sh": "#!/bin/sh\nvestigio submit --db \"$store\" --once --text x\ntest ! -e \"$store.daemon/endpoint.json\"\n" });
	assert.equal(result.status, 0, result.stderr);
});

test("the extension binding a store is a starter in a test file", () => {
	const result = lint({ "packages/pi-extension/test/probe.test.ts": "const env = { VESTIGIO_STORE: store };\nimport vestigio from \"../src/extension.js\";\n" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /binds the extension to a store/);
});

test("production package source is out of scope", () => {
	const result = lint({ "packages/client/src/index.ts": "export async function openDaemon(store) {}\n" });
	assert.equal(result.status, 0, result.stderr);
});

test("node_modules is not scanned", () => {
	const result = lint({ "node_modules/pkg/index.mjs": "await openDaemon(store);\n" });
	assert.equal(result.status, 0, result.stderr);
});

test("a file that does not touch a daemon is ignored", () => {
	const result = lint({ "helper.mjs": "export const answer = 42;\n" });
	assert.equal(result.status, 0, result.stderr);
});

test("delegating the stop to stopProbeDaemons closes a probe", () => {
	const result = lint({ "probe.mjs": "const { command, args } = cliCommand(ROOT, argv);\nawait run(\"search\");\nconst leaked = await stopProbeDaemons(stores);\n" });
	assert.equal(result.status, 0, result.stderr);
});

test("importing the helper without calling it does not close a probe", () => {
	const result = lint({ "probe.mjs": "import { stopProbeDaemons } from \"../lib/daemon.mjs\";\nspawn(node, [\"packages/daemon/src/entry.ts\", store]);\n" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /missing a stop/);
});

test("the command builder is exempt", () => {
	const result = lint({ "scripts/lib/platform.mjs": "export function cliCommand(root, args) {\n  return { command: \"node\", args };\n}\n" });
	assert.equal(result.status, 0, result.stderr);
});
