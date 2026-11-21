import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { runtimePaths } from "../src/runtime.js";
import type { Accepted, Endpoint } from "../src/protocol.js";

const trace = "/tmp/vestigio-lock-trace.log";

function launch(store: string) {
	const hook = fileURLToPath(new URL("../hook.mjs", import.meta.url));
	const fixture = fileURLToPath(new URL("./fixtures/daemon.ts", import.meta.url));
	const child = spawn(process.execPath, ["--import", hook, fixture, store], { stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (stderr) appendFileSync(trace, `child ${child.pid} stderr: ${stderr.slice(0, 2000)}\n`);
			resolve({ code, signal, stderr });
		});
	});
	return { child, exited };
}

function request(endpoint: Endpoint, path: string, data?: unknown) {
	return fetch(`http://127.0.0.1:${endpoint.port}/v1${path}`, {
		headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
		...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }),
		signal: AbortSignal.timeout(2_000),
	});
}

async function ready(path: string, previous?: Endpoint): Promise<Endpoint> {
	let endpoint: Endpoint | undefined;
	await expect.poll(async () => {
		try {
			endpoint = JSON.parse(await readFile(path, "utf8"));
			return Boolean(endpoint && endpoint.instanceId !== previous?.instanceId && (await request(endpoint, "/health")).ok);
		} catch {
			return false;
		}
	}, { timeout: 3_000 }).toBe(true);
	return endpoint!;
}

const step = (label: string) => appendFileSync(trace, `${performance.now().toFixed(0)} ${label}\n`);

test("a live owner excludes other processes, while a crash releases the lock and resumes accepted jobs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "vestigio-daemon-"));
	const path = join(directory, "memory.sqlite");
	const paths = runtimePaths(path);
	const owner = launch(path);
	const children = [owner];
	try {
		const endpoint = await ready(paths.endpoint);
		step(`owner ready on ${endpoint.port}`);
		step("launching contender");
		const contender = launch(path);
		children.push(contender);
		const contenderExit = await contender.exited;
		step(`contender exited ${JSON.stringify(contenderExit)}`);
		expect(contenderExit).toMatchObject({ code: 0, signal: null });
		expect(await ready(paths.endpoint)).toEqual(endpoint);
		step("endpoint unchanged after contender");

		const marker = join(directory, "attempt");
		const data = { session: { source: "test", sessionId: "one" }, requestId: "request", kind: "search", input: { marker, wait: 1_000, value: "complete" } };
		const accepted = await request(endpoint, "/jobs", data);
		step(`job accepted ${accepted.status}`);
		expect(accepted.status).toBe(202);
		const { jobId, sessionRef } = await accepted.json() as Accepted;
		await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe(String(owner.child.pid));
		step("owner marker written, killing owner");
		owner.child.kill("SIGKILL");
		const ownerExit = await owner.exited;
		step(`owner exited ${JSON.stringify(ownerExit)}`);
		expect(ownerExit).toMatchObject({ signal: "SIGKILL" });

		step("launching successor");
		const successor = launch(path);
		children.push(successor);
		const recovered = await ready(paths.endpoint, endpoint);
		step(`successor ready on ${recovered.port}`);
		expect(await (await request(recovered, "/jobs", data)).json()).toMatchObject({ jobId, sessionRef });
		step("successor accepted the job");
		await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe(String(successor.child.pid));
		step("successor marker written");
		await expect.poll(async () => ((await (await request(recovered, `/jobs/${jobId}`)).json()) as { state: string }).state, { timeout: 3_000 }).toBe("succeeded");
		step("job succeeded");
		expect(await (await request(recovered, `/sessions/${sessionRef}/events`)).json()).toMatchObject([{ jobId, result: "complete" }]);
		expect(await (await request(recovered, `/jobs/${jobId}`)).json()).toMatchObject({ visibility: "summary_only", state: "succeeded" });
		expect(await (await request(recovered, "/stop", {})).json()).toEqual({ stopped: true });
		step("stop answered");
		const successorExit = await successor.exited;
		step(`successor exited ${JSON.stringify(successorExit)}`);
		expect(successorExit).toMatchObject({ code: 0, signal: null });
	} finally {
		for (const { child } of children) child.kill("SIGKILL");
		await Promise.allSettled(children.map(({ exited }) => exited));
		await rm(directory, { recursive: true, force: true });
	}
	// Three daemons start in sequence; a cold CI runner needs more than the local 2s.
}, 30_000);

test("a running maintenance agent leaves foreground transactions available", async () => {
	const directory = await mkdtemp(join(tmpdir(), "vestigio-foreground-"));
	const store = join(directory, "memory.sqlite");
	const owner = launch(store);
	try {
		const endpoint = await ready(runtimePaths(store).endpoint);
		const session = { source: "test", sessionId: "foreground" };
		const submit = async (requestId: string, input: unknown) =>
			(await (await request(endpoint, "/jobs", { session, requestId, kind: "maintenance", input })).json()) as Accepted;
		const slow = await submit("slow", { op: "nav.run", wait: 60_000 });
		const next = await submit("next", { op: "nav.run", value: "next" });
		const input = await submit("input", { op: "session.input", value: "ready" });
		const get = async (job: Accepted) => (await request(endpoint, `/jobs/${job.jobId}`)).json();
		await expect.poll(get.bind(null, input)).toMatchObject({ state: "succeeded", result: "ready" });
		expect(await get(slow)).toMatchObject({ state: "running" });
		expect(await get(next)).toMatchObject({ state: "queued" });
	} finally {
		owner.child.kill("SIGKILL");
		await owner.exited;
		await rm(directory, { recursive: true, force: true });
	}
});

test("a waiting job releases its search slot and retains the maintenance outcome for delivery", async () => {
	const directory = await mkdtemp(join(tmpdir(), "vestigio-dependencies-"));
	const store = join(directory, "memory.sqlite");
	const owner = launch(store);
	try {
		const endpoint = await ready(runtimePaths(store).endpoint);
		const session = { source: "test", sessionId: "dependencies" };
		const submit = async (requestId: string, input: unknown) =>
			(await (await request(endpoint, "/jobs", { session, requestId, kind: "search", input })).json()) as Accepted;
		const parents = await Promise.all(Array.from({ length: 4 }, (_, index) => submit(`parent:${index}`, { child: 250, value: index })));
		const independent = await submit("independent", { value: "ready" });
		await expect.poll(async () => (await (await request(endpoint, `/jobs/${independent.jobId}`)).json() as { state: string }).state).toBe("succeeded");
		expect(await (await request(endpoint, `/jobs/${parents[3]!.jobId}`)).json()).toMatchObject({ state: "waiting" });
		await expect.poll(async () => (await (await request(endpoint, `/jobs/${parents[3]!.jobId}`)).json() as { state: string }).state, { timeout: 3_000 }).toBe("succeeded");
		expect(await (await request(endpoint, `/jobs/${parents[3]!.jobId}`)).json()).toMatchObject({ result: { value: 3, children: [{ status: "succeeded", result: "child" }] } });
	} finally {
		owner.child.kill("SIGKILL");
		await owner.exited;
		await rm(directory, { recursive: true, force: true });
	}
}, 10_000);
