#!/usr/bin/env node
/**
 * Read-only preflight for driving vestigio. Answers "is this checkout worth
 * verifying" without starting anything or touching a store.
 *
 *   node scripts/verify-doctor.mjs
 *
 * Exit 0 when every hard requirement holds; warnings alone keep it at 0.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliCommand, commandFor, processLines } from "./lib/platform.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = process.platform === "win32"
	? join(ROOT, "packages/cli/src/entry.ts")
	: join(ROOT, "packages/cli/bin/vestigio");
const LOCAL_PI = join(ROOT, "packages/pi-extension/node_modules/.bin", process.platform === "win32" ? "pi.CMD" : "pi");
const MIN_NODE = [22, 5];

let failures = 0;
const ok = (label, detail) => console.log(`ok    ${label}${detail ? `  ${detail}` : ""}`);
const warn = (label, detail) => console.log(`warn  ${label}${detail ? `  ${detail}` : ""}`);
const fail = (label, detail) => {
	failures += 1;
	console.log(`fail  ${label}${detail ? `  ${detail}` : ""}`);
};

const capture = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options });
// A failed spawn sets `error` and leaves `stderr` undefined, so read whichever exists.
const firstLine = (result) => (result.error?.message ?? result.stderr ?? result.stdout ?? "no output").trim().split("\n")[0] || "no output";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) {
	ok("node", process.versions.node);
} else {
	fail("node", `${process.versions.node} < ${MIN_NODE.join(".")}`);
}

const pnpm = capture("pnpm", ["--version"]);
if (pnpm.status === 0) ok("pnpm", pnpm.stdout.trim());
else fail("pnpm", pnpm.error?.message ?? pnpm.stderr.trim());

const cli = cliCommand(ROOT, ["--help"]);
const help = capture(cli.command, cli.args);
if (help.status === 0) ok("cli", CLI);
else fail("cli", firstLine(help));

const pi = existsSync(LOCAL_PI) ? LOCAL_PI : "pi";
const launcher = commandFor(pi, ["--version"]);
const version = capture(launcher.command, launcher.args, { windowsVerbatimArguments: launcher.windowsVerbatimArguments });
if (version.status === 0) ok("pi", `${version.stdout.trim()}  ${pi}`);
else fail("pi", version.error?.message ?? version.stderr.trim());

const store = process.env.VESTIGIO_STORE;
if (!store) {
	warn("VESTIGIO_STORE", "unset; the CLI will create the default store on first write");
} else if (existsSync(store)) {
	ok("VESTIGIO_STORE", store);
} else {
	warn("VESTIGIO_STORE", `${store} does not exist yet`);
}

const lines = processLines();
if (lines === null) warn("processes", "no process listing on this platform; the daemon and obelisk checks below see nothing");
const processes = lines ?? [];
const daemons = processes
	.map((line) => line.match(/(\S+)\/packages\/daemon\/src\/entry\.ts/))
	.filter(Boolean)
	.map((match) => match[1]);
const checkouts = [...new Set(daemons)];
if (daemons.length > 0) {
	const here = checkouts.includes(ROOT.replace(/\\/g, "/").replace(/\/$/, ""));
	warn("live daemon", `${daemons.length} process(es) across ${checkouts.length} checkout(s)${here ? ", including this one" : ""}`);
	for (const root of checkouts.slice(0, 3)) console.log(`      ${root}`);
	if (checkouts.length > 3) console.log(`      and ${checkouts.length - 3} more`);
} else {
	ok("live daemon", "none");
}

if (store && existsSync(`${store}.daemon/endpoint.json`)) {
	warn("daemon endpoint", `${store}.daemon/endpoint.json exists; stop it before a clean run`);
}

const obelisk = processes.filter((line) => /(^|[\s/])obelisk(\s|$)/.test(line) && !/verify-(all|doctor)/.test(line));
if (obelisk.length > 0) warn("obelisk running", "the pi harness asserts the real index is untouched; wait for it to exit");
else ok("obelisk", "idle");

const status = capture("git", ["status", "--porcelain"]);
if (status.status === 0) {
	const dirty = status.stdout.split("\n").filter(Boolean).length;
	if (dirty > 0) warn("worktree", `${dirty} changed paths`);
	else ok("worktree", "clean");
}

console.log(failures === 0 ? "\ndoctor passed" : `\ndoctor failed (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
