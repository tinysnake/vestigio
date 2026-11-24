/**
 * Interface counters and `GET /v1/stats` (OBS-04).
 *
 * The server is built in-process so the counters can be read at the same time
 * as they are exercised. Every test passes an explicit observability directory,
 * so the default `<store>.observability` derivation never runs here.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { JobStore } from "../src/jobs.js";
import { PROTOCOL_VERSION, type Endpoint } from "../src/protocol.js";
import { JobService, httpServer, type IfaceStatsOptions, type IfaceStatsSummary } from "../src/service.js";

type Running = {
	readonly endpoint: Endpoint;
	readonly obsDir: string;
	readonly stopped: Promise<void>;
	request: (path: string, method?: string, body?: unknown) => Promise<Response>;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function listen(options: IfaceStatsOptions = {}): Promise<Running> {
	const directory = mkdtempSync(join(tmpdir(), "vestigio-stats-"));
	const obsDir = options.obsDir ?? join(directory, "observability");
	const jobs = new JobStore(join(directory, "jobs.sqlite"));
	const service = new JobService(jobs, async () => null);
	const endpoint: Endpoint = { version: PROTOCOL_VERSION, instanceId: "stats-test", port: 0, token: "0".repeat(64) };
	let markStopped: () => void = () => undefined;
	const stopped = new Promise<void>((resolve) => {
		markStopped = resolve;
	});
	const server = httpServer(service, endpoint, markStopped, { ...options, obsDir });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	endpoint.port = typeof address === "object" && address !== null ? address.port : 0;
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		service.stop();
		jobs.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return {
		endpoint,
		obsDir,
		stopped,
		request: (path, method = "GET", body) => fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${endpoint.token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	};
}

function wrongHostStatus(endpoint: Endpoint, path: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const request = httpRequest({ host: "127.0.0.1", port: endpoint.port, path, method: "GET", headers: { host: "not-the-daemon", authorization: `Bearer ${endpoint.token}` } }, (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode ?? 0));
		});
		request.on("error", reject);
		request.end();
	});
}

function records(path: string): Array<Record<string, unknown>> {
	return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("counts matched routes by status class and merges path ids into one template", async () => {
	const running = await listen();
	expect((await running.request("/v1/health")).status).toBe(200);
	expect((await running.request("/v1/sessions", "POST", { source: "test", sessionId: "one" })).status).toBe(200);
	const accepted = await (await running.request("/v1/jobs", "POST", { session: { source: "test", sessionId: "one" }, requestId: "r1", kind: "search", input: {} })).json() as { jobId: string };
	expect((await running.request(`/v1/jobs/${accepted.jobId}`)).status).toBe(200);
	expect((await running.request(`/v1/jobs/${accepted.jobId}`)).status).toBe(200);
	expect((await running.request("/v1/jobs/missing-job")).status).toBe(404);
	expect((await running.request("/v1/nope")).status).toBe(404);

	const summary = await (await running.request("/v1/stats")).json() as IfaceStatsSummary;
	expect(summary.routes["GET /v1/health"]).toEqual({ "2xx": 1, "4xx": 0, "5xx": 0, total: 1 });
	expect(summary.routes["POST /v1/sessions"]).toEqual({ "2xx": 1, "4xx": 0, "5xx": 0, total: 1 });
	expect(summary.routes["POST /v1/jobs"]).toEqual({ "2xx": 1, "4xx": 0, "5xx": 0, total: 1 });
	// Both real ids and the missing one land on the same template.
	expect(summary.routes["GET /v1/jobs/:key"]).toEqual({ "2xx": 2, "4xx": 1, "5xx": 0, total: 3 });
	// A path no route claims is counted without inventing a template.
	expect(summary.routes["unknown"]).toEqual({ "2xx": 0, "4xx": 1, "5xx": 0, total: 1 });
	expect(summary.since).toBe(new Date(summary.since).toISOString());
});

test("counts host and token rejections as reasons and never counts its own endpoint", async () => {
	const running = await listen();
	expect((await fetch(`http://127.0.0.1:${running.endpoint.port}/v1/health`)).status).toBe(401);
	expect(await wrongHostStatus(running.endpoint, "/v1/health")).toBe(403);

	const first = await (await running.request("/v1/stats")).json() as IfaceStatsSummary;
	expect(first.reasons).toEqual({ "403_host": 1, "401_token": 1 });
	// Fixed choice: the stats read does not count itself, so reading once or
	// twice leaves both status totals and reasons untouched.
	expect(first.routes["GET /v1/stats"]).toBeUndefined();
	const second = await (await running.request("/v1/stats")).json() as IfaceStatsSummary;
	expect(second.routes["GET /v1/stats"]).toBeUndefined();
	expect(second.routes).toEqual(first.routes);
	expect(second.reasons).toEqual(first.reasons);
	// The token is the authorization proof, never a payload.
	expect(JSON.stringify(first)).not.toContain(running.endpoint.token);
});

test("keeps every concurrent update and writes a shutdown snapshot equal to the counters", async () => {
	const running = await listen();
	const parallel = 60;
	const responses = await Promise.all(Array.from({ length: parallel }, () => running.request("/v1/health")));
	expect(responses.filter((response) => response.status === 200)).toHaveLength(parallel);

	const summary = await (await running.request("/v1/stats")).json() as IfaceStatsSummary;
	expect(summary.routes["GET /v1/health"]).toEqual({ "2xx": parallel, "4xx": 0, "5xx": 0, total: parallel });

	expect((await running.request("/v1/stop", "POST")).status).toBe(200);
	await running.stopped;
	const snapshot = records(join(running.obsDir, "iface.jsonl")).find((record) => record["scope"] === "daemon");
	expect(snapshot).toBeDefined();
	expect(snapshot?.["routes"]).toEqual(summary.routes);
	expect(snapshot?.["reasons"]).toEqual(summary.reasons);
});

test("appends one request line per counted request only when the switch is on", async () => {
	const running = await listen({ logRequests: true });
	await running.request("/v1/health");
	await running.request("/v1/stats");
	await running.request("/v1/stop", "POST");
	await running.stopped;

	const lines = records(join(running.obsDir, "iface.jsonl"));
	const details = lines.filter((record) => record["scope"] === "request");
	const snapshots = lines.filter((record) => record["scope"] === "daemon");
	// Only the health request is counted, so only it produced a detail line.
	expect(details).toHaveLength(1);
	expect(details[0]?.["routes"]).toEqual({ "GET /v1/health": { "2xx": 1, "4xx": 0, "5xx": 0, total: 1 } });
	expect(snapshots).toHaveLength(1);
});
