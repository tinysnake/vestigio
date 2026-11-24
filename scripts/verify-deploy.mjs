#!/usr/bin/env node
/**
 * Proves deploy.mjs leaves a runnable `vestigio` command behind, against a
 * throwaway layout: a temp bin dir, config and pi settings only. No network,
 * no pi, no model. On Windows this is the repro for the symlink-based link
 * step, which cannot link a bash wrapper into a runnable command.
 *
 *   node scripts/verify-deploy.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const runCommand = () => (process.platform === "win32"
	// A .cmd cannot be spawned directly (EINVAL), and the quotes must reach cmd verbatim.
	? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${command}" --help`], {
		encoding: "utf8",
		windowsVerbatimArguments: true,
		env: { ...process.env, VESTIGIO_CONFIG: "" },
	})
	: spawnSync(command, ["--help"], { encoding: "utf8", env: { ...process.env, VESTIGIO_CONFIG: "" } }));

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

	console.log(`deploy link passed: ${command}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	rmSync(dir, { recursive: true, force: true });
}
