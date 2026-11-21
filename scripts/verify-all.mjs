#!/usr/bin/env node
/**
 * Run the local verification gates in the order that keeps them honest. The pi
 * harness asserts the real Obelisk index is untouched, so this refuses to start
 * it while another Obelisk process is alive.
 *
 *   node scripts/verify-all.mjs            # every gate
 *   node scripts/verify-all.mjs --fast     # skip the pi harness
 *   node scripts/verify-all.mjs --only test,smoke
 *   node scripts/verify-all.mjs --pi-filter stale
 *
 * Logs land in a fresh directory under the system temp dir and survive the run.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const fast = args.includes("--fast");
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? new Set(args[onlyIndex + 1].split(",")) : null;
const filterIndex = args.indexOf("--pi-filter");
const piFilter = filterIndex >= 0 ? args[filterIndex + 1] : null;

const gate = (name, cwd, command, commandArgs) => ({ name, cwd, command, commandArgs });
const gates = [
	gate("typecheck", ROOT, "pnpm", ["typecheck"]),
	gate("test", ROOT, "pnpm", ["test"]),
	gate("memory", join(ROOT, "eval/memory"), process.execPath, ["--import", "../pi/hook.mjs", "./run.mjs"]),
	gate("compare", join(ROOT, "eval/memory"), process.execPath, ["./compare.mjs", "baseline.json", "out/report.json"]),
	gate("smoke", ROOT, process.execPath, ["scripts/daemon-smoke.mjs"]),
	gate("pi", join(ROOT, "eval/pi"), process.execPath, ["--import", "./hook.mjs", "./run.mjs", ...(piFilter ? ["--only", piFilter] : [])]),
];

const selected = gates.filter((item) => {
	if (only) return only.has(item.name);
	if (fast && item.name === "pi") return false;
	return true;
});
if (selected.length === 0) {
	console.error(`no gate matched; known: ${gates.map((item) => item.name).join(", ")}`);
	process.exit(2);
}
if (selected.some((item) => item.name === "compare") && !selected.some((item) => item.name === "memory")) {
	console.error("compare reads out/report.json from the memory gate; include it or run it after a memory run");
	process.exit(2);
}

if (selected.some((item) => item.name === "pi")) {
	const ps = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" });
	const obelisk = ps.status === 0 && ps.stdout.split("\n").some((line) => /(^|[\s/])obelisk(\s|$)/.test(line) && !/verify-all/.test(line));
	if (obelisk) {
		console.error("an obelisk process is running; the pi gate asserts the real index is untouched, so wait for it to exit");
		process.exit(2);
	}
}

const logs = mkdtempSync(join(tmpdir(), "vestigio-verify-"));
console.log(`logs: ${logs}`);
const results = [];
let failed = 0;

for (const [index, item] of selected.entries()) {
	const label = `[${index + 1}/${selected.length}] ${item.name}`;
	process.stdout.write(`${label} ... `);
	const started = performance.now();
	const result = spawnSync(item.command, item.commandArgs, {
		cwd: item.cwd,
		env: { ...process.env, VESTIGIO_CONFIG: "" },
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const seconds = ((performance.now() - started) / 1000).toFixed(1);
	const logPath = join(logs, `${item.name}.log`);
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	writeFileSync(logPath, output);
	if (result.status === 0) {
		console.log(`ok  ${seconds}s`);
		results.push({ name: item.name, ok: true, seconds, logPath });
	} else {
		console.log(`FAIL  ${seconds}s  exit ${result.status ?? result.signal}`);
		failed += 1;
		results.push({ name: item.name, ok: false, seconds, logPath });
		const tail = output.trim().split("\n").slice(-20).join("\n");
		console.log(tail);
	}
}

console.log("\ngate       result  time     log");
for (const item of results) console.log(`${item.name.padEnd(10)} ${item.ok ? "ok" : "FAIL"}    ${item.seconds.padStart(6)}s  ${item.logPath}`);
console.log(failed === 0 ? `\nall ${results.length} gates passed` : `\n${failed} of ${results.length} gates failed`);
process.exitCode = failed === 0 ? 0 : 1;
