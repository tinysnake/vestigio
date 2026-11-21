#!/usr/bin/env node
/**
 * Walk the daemon path an operator takes: a store is created by the CLI, the
 * daemon starts on first use, its state directory and log appear, and `stop`
 * shuts it down. Everything runs against a temporary store so no real project
 * memory is involved.
 *
 *   node scripts/daemon-smoke.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "packages/cli/bin/vestigio");
const dir = mkdtempSync(join(tmpdir(), "vestigio-smoke-"));
const store = join(dir, "store.sqlite");
const project = join(dir, "project");
const run = (...args) => spawnSync(CLI, args, { encoding: "utf8", env: { ...process.env, VESTIGIO_CONFIG: "" } });

try {
	const search = run("search", "--db", store, "--project", project, "--query", "部署 端口");
	assert.equal(search.status, 0, search.stderr);
	assert.match(search.stdout, /^layers:$/m, search.stdout);
	assert.match(search.stdout, /^ {2}active: /m, search.stdout);
	assert.ok(existsSync(store), `search did not create ${store}`);

	const missing = run("get", "--db", store, "--job", "smoke-missing-job");
	assert.equal(missing.status, 1, missing.stdout + missing.stderr);
	assert.match(missing.stderr, /Unknown job/, missing.stderr);
	const runtime = `${store}.daemon`;
	assert.ok(existsSync(join(runtime, "endpoint.json")), "the daemon did not publish an endpoint");
	assert.ok(existsSync(join(runtime, "daemon.log")), "the daemon did not write a log");

	const stop = run("stop", "--db", store);
	assert.equal(stop.status, 0, stop.stderr);
	assert.match(stop.stdout, /stopped=true/, stop.stdout);
	assert.ok(!existsSync(join(runtime, "endpoint.json")), "stop left the endpoint behind");

	console.log(`daemon smoke passed: ${store}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	const stop = run("stop", "--db", store);
	if (stop.status !== 0) console.error(stop.stderr);
	rmSync(dir, { recursive: true, force: true });
}
