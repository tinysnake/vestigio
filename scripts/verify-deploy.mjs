#!/usr/bin/env node
/**
 * Proves deploy.mjs leaves a runnable `vestigio` command behind and can start
 * its pi launcher, against a throwaway layout: a temp bin dir, config and pi
 * settings only. No network, no real pi, no model. On Windows this is the
 * repro for the symlink-based link step, which cannot link a bash wrapper into
 * a runnable command.
 *
 *   node scripts/verify-deploy.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandFor } from "./lib/platform.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "vestigio-deploy-"));
const binDir = join(dir, "bin");
const settings = join(dir, "pi-settings.json");
const config = join(dir, "config.json");
const extension = join(ROOT, "packages", "pi-extension");
const command = join(binDir, process.platform === "win32" ? "vestigio.cmd" : "vestigio");
// The deploy run must see its own bin dir on PATH, or the on-PATH report is a warn.
const deployEnv = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` };

const deploy = () => spawnSync(process.execPath, [
	"scripts/deploy.mjs",
	"--skip-install",
	"--bin-dir", binDir,
	"--config", config,
	"--pi-settings", settings,
], { cwd: ROOT, encoding: "utf8", env: deployEnv });

const runCommand = () => {
	const launcher = commandFor(command, ["--help"]);
	return spawnSync(launcher.command, launcher.args, {
		encoding: "utf8",
		windowsVerbatimArguments: launcher.windowsVerbatimArguments,
		env: { ...process.env, VESTIGIO_CONFIG: "" },
	});
};

try {
	mkdirSync(binDir, { recursive: true });
	writeFileSync(settings, `${JSON.stringify({ packages: [extension] }, null, 2)}\n`);

	const first = deploy();
	assert.equal(first.status, 0, first.stdout + first.stderr);
	assert.match(first.stdout, /^ok\s+vestigio command/m, first.stdout);
	assert.match(first.stdout, /^skip\s+pi install/m, first.stdout);
	assert.ok(existsSync(command), `deploy did not write ${command}`);

	const help = runCommand();
	assert.equal(help.status, 0, help.stdout + help.stderr);
	assert.match(help.stdout, /^vestigio — layered memory inspection$/m, help.stdout);

	const second = deploy();
	assert.equal(second.status, 0, second.stdout + second.stderr);
	assert.match(second.stdout, /^skip\s+vestigio command/m, second.stdout);

	// deploy spawns whatever --pi names, and on Windows that is usually a .cmd
	// launcher Node cannot spawn directly. The fake launcher writes a marker, then
	// deploy reports that it did not register the extension.
	const piDir = join(dir, "fake pi");
	mkdirSync(piDir, { recursive: true });
	const fakePi = join(piDir, process.platform === "win32" ? "pi.cmd" : "pi");
	const marker = join(dir, "launcher-ran.txt");
	writeFileSync(fakePi, process.platform === "win32"
		? `@echo off\r\necho ran > "${marker}"\r\n`
		: `#!/bin/sh\necho ran > "${marker}"\n`);
	if (process.platform !== "win32") chmodSync(fakePi, 0o755);
	const unregistered = join(dir, "unregistered.json");
	writeFileSync(unregistered, "{}\n");

	const routed = spawnSync(process.execPath, [
		"scripts/deploy.mjs",
		"--skip-install",
		"--skip-link",
		"--pi", fakePi,
		"--config", config,
		"--pi-settings", unregistered,
	], { cwd: ROOT, encoding: "utf8" });

	assert.ok(existsSync(marker), `the --pi launcher did not run: ${routed.stdout}${routed.stderr}`);
	assert.doesNotMatch(routed.stdout + routed.stderr, /EINVAL/, "the launcher was spawned instead of run");
	assert.match(routed.stdout, /^FAIL\s+pi install/m, routed.stdout);

	// pi and pnpm arrive as `.cmd` shims on a Windows runner, and a bare name
	// does not reach one: Node only appends `.exe` when it searches PATH.
	if (process.platform === "win32") {
		const shimDir = join(dir, "shim only");
		mkdirSync(shimDir, { recursive: true });
		const shimMarker = join(dir, "shim-ran.txt");
		writeFileSync(join(shimDir, "vestigio-probe.cmd"), `@echo off\r\necho ran > "${shimMarker}"\r\n`);

		const shim = commandFor("vestigio-probe", ["--version"], { PATH: shimDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" });
		const shimRun = spawnSync(shim.command, shim.args, {
			encoding: "utf8",
			windowsVerbatimArguments: shim.windowsVerbatimArguments,
		});

		assert.ok(existsSync(shimMarker), `a .cmd on PATH did not run: ${shimRun.error?.message ?? shimRun.stdout ?? shimRun.stderr}`);
		assert.equal(shimRun.status, 0);
	}

	console.log(`deploy checks passed: ${command}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	rmSync(dir, { recursive: true, force: true });
}
