#!/usr/bin/env node
/**
 * Restarts the local vestigio daemon from the checkout that runs this file.
 *
 * The daemon loads TypeScript straight from the checkout, so a running process
 * keeps the version it started with no matter what a merge does to the files
 * under it. `.git/hooks/post-merge` and `.git/hooks/post-checkout` call this
 * when `main` moves, so the merge is not finished until the daemon the operator
 * talks to is the code just merged.
 *
 * The store comes from `~/.vestigio/config.json` through the same resolver the
 * CLI uses, so the hook never hardcodes a path. The restart is skipped when the
 * recorded checkout commit already matches HEAD and the daemon is running, which
 * keeps a repeated checkout from restarting it twice and still heals a daemon
 * that died.
 *
 *   node --import ./packages/cli/hook.mjs scripts/restart-local-vestigio.mjs
 *   … --store <path>   target another store
 *   … --hook           never exit nonzero; a git operation must not fail here
 *   … --dry-run        print what it would do and touch nothing
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonRunning, ensureDaemon, VestigioClient } from "../packages/client/src/index.ts";
import { applyConfigToEnv } from "../packages/config/src/index.ts";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
};

const hookMode = flag("--hook");
const dryRun = flag("--dry-run");

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function git(root, ...args) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function resolveStore() {
	const explicit = option("--store");
	if (explicit !== undefined) return explicit;
	const env = { ...process.env };
	applyConfigToEnv(env);
	return env.VESTIGIO_STORE ?? env.VESTIGIO_DB;
}

async function main() {
	const store = resolveStore();
	if (store === undefined) {
		console.error("restart-local-vestigio: no store. Pass --store, or set store in ~/.vestigio/config.json");
		return 1;
	}

	const root = git(process.cwd(), "rev-parse", "--show-toplevel");
	const commit = git(root, "rev-parse", "--short", "HEAD");
	const branch = git(root, "symbolic-ref", "--quiet", "--short", "HEAD") || "(detached)";
	const daemonDir = `${store}.daemon`;
	const recordPath = join(daemonDir, "checkout.json");
	const logPath = join(daemonDir, "restart.log");
	const record = readJson(recordPath);
	const before = readJson(join(daemonDir, "endpoint.json"));
	const running = await daemonRunning(store);

	const log = (line) => {
		mkdirSync(daemonDir, { recursive: true });
		appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
	};

	if (running && record?.commit === commit) {
		log(`kept ${branch}@${commit} (instance ${record.instanceId ?? "?"}); daemon already runs it`);
		if (!dryRun) console.log(`vestigio daemon already runs ${branch}@${commit}`);
		return 0;
	}

	if (dryRun) {
		log(`would restart for ${branch}@${commit} (running=${running}, recorded=${record?.commit ?? "none"}) from ${root}`);
		console.log(`would restart from ${root} for ${branch}@${commit}; store ${store}`);
		return 0;
	}

	await new VestigioClient(store).stop();
	const endpoint = await ensureDaemon(store);
	const alive = await daemonRunning(store);
	if (!alive) throw new Error(`daemon for ${store} did not answer after the restart`);

	writeFileSync(
		recordPath,
		`${JSON.stringify({ commit, branch, root, instanceId: endpoint.instanceId, port: endpoint.port, startedAt: new Date().toISOString() }, null, "\t")}\n`,
	);
	log(`restarted ${branch}@${commit} from ${root}: ${before?.instanceId ?? "none"} -> ${endpoint.instanceId}, port ${endpoint.port}`);
	console.log(`vestigio daemon restarted: ${before?.instanceId ?? "none"} -> ${endpoint.instanceId} (${branch}@${commit}, port ${endpoint.port})`);
	return 0;
}

try {
	process.exitCode = await main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	const store = resolveStore();
	if (store !== undefined) {
		try {
			mkdirSync(`${store}.daemon`, { recursive: true });
			appendFileSync(`${store}.daemon/restart.log`, `${new Date().toISOString()} FAILED ${message}\n`);
		} catch {
			// The log is a convenience; losing it must not change the outcome.
		}
	}
	console.error(`restart-local-vestigio: ${message}`);
	process.exitCode = hookMode ? 0 : 1;
}
