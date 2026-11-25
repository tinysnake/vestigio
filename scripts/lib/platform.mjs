// Cross-platform access to the CLI, the process table and the way a program
// must be spawned, so the scripts do not assume bash, symlinks or `ps`.
//
// The Windows CLI command needs no bash wrapper: `node --import <hook URL>
// <entry>` is exactly what `packages/cli/bin/vestigio` execs, so the same code
// path runs here with an interpreter that Windows has.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SHIM_MARKER = "REM vestigio command (written by scripts/deploy.mjs)";

/**
 * The specifier `node --import` needs for this checkout's CLI hook. A bare
 * `packages/cli/hook.mjs` reads as a package name, and an absolute path reads as
 * an unknown URL scheme, so the file URL is the only form that loads everywhere.
 */
export function hookUrl(root) {
	return pathToFileURL(join(root, "packages", "cli", "hook.mjs")).href;
}

/**
 * How to run this checkout's CLI. POSIX keeps the bash wrapper (it is exercised
 * as-is); Windows runs Node directly on the hook and entry files.
 */
export function cliCommand(root, args = []) {
	if (process.platform === "win32") {
		return {
			command: process.execPath,
			args: [
				"--import", hookUrl(root),
				join(root, "packages", "cli", "src", "entry.ts"),
				...args,
			],
		};
	}
	return { command: join(root, "packages", "cli", "bin", "vestigio"), args };
}

const DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

/**
 * Windows resolves a bare program name through PATH and PATHEXT, while libuv
 * appends only `.exe`. A tool installed as a `.cmd` shim, which is how pnpm
 * reaches a CI runner, therefore looks missing until it is resolved here.
 */
function findProgram(program, env) {
	if (/[\\/]/.test(program) || /\.[^\\/.]*$/.test(program)) return program;
	const extensions = (env.PATHEXT ? env.PATHEXT.split(";") : DEFAULT_PATHEXT).filter((extension) => extension !== "");
	for (const entry of (env.PATH ?? env.Path ?? "").split(";")) {
		if (entry.trim() === "") continue;
		const base = join(entry.trim().replace(/^"(.*)"$/, "$1"), program);
		for (const extension of extensions) {
			const candidate = base + extension.toLowerCase();
			if (existsSync(candidate)) return candidate;
		}
	}
	return program;
}

/**
 * The argv that runs `program`, resolved against `env` on Windows. A `.cmd` or
 * `.bat` cannot be spawned directly, so it goes through the command interpreter
 * with the whole line wrapped in quotes: `/s` strips that outer pair and leaves
 * `"<program>" <args>`.
 */
export function commandFor(program, args = [], env = process.env) {
	const resolved = process.platform === "win32" ? findProgram(program, env) : program;
	if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args };
	// Node backslash-escapes an embedded quote unless the arguments reach cmd verbatim.
	const quote = (value) => (/\s/.test(value) ? `"${value}"` : value);
	const line = [`"${resolved}"`, ...args.map(quote)].join(" ");
	return {
		command: env.ComSpec ?? process.env.ComSpec ?? "cmd.exe",
		args: ["/d", "/s", "/c", `"${line}"`],
		windowsVerbatimArguments: true,
	};
}

/** The bytes of the `vestigio.cmd` shim deploy.mjs writes on Windows. */
export function windowsShim(root) {
	const hook = hookUrl(root);
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
