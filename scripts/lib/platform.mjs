// Cross-platform access to the CLI and the process table, so the verification
// scripts do not assume bash, symlinks or `ps`.
//
// The Windows CLI command needs no bash wrapper: `node --import <hook URL>
// <entry>` is exactly what `packages/cli/bin/vestigio` execs, so the same code
// path runs here with an interpreter that Windows has.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SHIM_MARKER = "REM vestigio command (written by scripts/deploy.mjs)";

/**
 * How to run this checkout's CLI. POSIX keeps the bash wrapper (it is exercised
 * as-is); Windows runs Node directly on the hook and entry files.
 */
export function cliCommand(root, args = []) {
	if (process.platform === "win32") {
		return {
			command: process.execPath,
			args: [
				"--import", pathToFileURL(join(root, "packages", "cli", "hook.mjs")).href,
				join(root, "packages", "cli", "src", "entry.ts"),
				...args,
			],
		};
	}
	return { command: join(root, "packages", "cli", "bin", "vestigio"), args };
}

/** The bytes of the `vestigio.cmd` shim deploy.mjs writes on Windows. */
export function windowsShim(root) {
	const hook = pathToFileURL(join(root, "packages", "cli", "hook.mjs")).href;
	const entry = join(root, "packages", "cli", "src", "entry.ts");
	return `@echo off\r\n${SHIM_MARKER}\r\nnode --import "${hook}" "${entry}" %*\r\n`;
}

/**
 * Every process command line, with `\` normalized to `/` so the callers' POSIX
 * regexes match Windows paths. Returns null when the platform has no usable
 * listing; the callers warn once and skip that check rather than crash.
 */
export function processLines() {
	const result = process.platform === "win32"
		? spawnSync(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine",
			],
			{ encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
		)
		: spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
	if (result.error || result.status !== 0) return null;
	const lines = (result.stdout ?? "")
		.split(/\r?\n/)
		.map((line) => line.replace(/\\/g, "/"))
		.filter((line) => line.trim() !== "");
	return lines.length > 0 ? lines : null;
}
