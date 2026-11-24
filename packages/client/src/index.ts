import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PROTOCOL_VERSION, type Accepted, type Endpoint, type Event, type SessionKey, type Submission } from "@vestigio/daemon/protocol";
import { runtimePaths } from "@vestigio/daemon/runtime";

export type { Accepted, Event, Kind, SessionKey, Submission } from "@vestigio/daemon/protocol";

const startupMs = 8_000;
const pendingStarts = new Map<string, Promise<DaemonStart>>();

/**
 * The result of asking a store for a daemon. `started` is true only when this
 * call spawned the process, so a caller can stop exactly the daemon it owns
 * and never one another invocation owns.
 */
export type DaemonStart = {
	endpoint: Endpoint;
	started: boolean;
};

async function liveEndpoint(path: string): Promise<Endpoint | undefined> {
	let endpoint: Endpoint;
	try {
		endpoint = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
		throw error;
	}
	if (!endpoint || !Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535 || !/^[0-9a-f]{64}$/.test(endpoint.token)) return undefined;
	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/health`, {
			headers: { authorization: `Bearer ${endpoint.token}` },
			signal: AbortSignal.timeout(500),
			redirect: "error",
		});
	} catch {
		return undefined;
	}
	if (!response.ok) {
		await response.body?.cancel();
		return undefined;
	}
	const health = await response.json().catch(() => undefined) as Partial<Endpoint> | undefined;
	if (health?.instanceId !== endpoint.instanceId || health?.version !== endpoint.version) return undefined;
	if (endpoint.version !== PROTOCOL_VERSION) throw new Error("Incompatible vestigio daemon version. Stop the running daemon before upgrading.");
	return endpoint;
}

async function start(paths: ReturnType<typeof runtimePaths>): Promise<DaemonStart> {
	const existing = await liveEndpoint(paths.endpoint);
	if (existing) return { endpoint: existing, started: false };
	mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	const log = openSync(paths.log, "a", 0o600);
	let spawnError: Error | undefined;
	try {
		const child = spawn(process.execPath, [
			// Node rejects a bare Windows path ("D:\\...") for --import: only a
			// file:// URL is accepted there, and the URL form works on every platform.
			"--import", import.meta.resolve("@vestigio/daemon/hook"),
			fileURLToPath(import.meta.resolve("@vestigio/daemon/entry")), paths.store,
		], { stdio: ["ignore", log, log], detached: true, windowsHide: true });
		child.once("error", (error) => { spawnError = error; });
		child.unref();
	} finally {
		closeSync(log);
	}
	const deadline = Date.now() + startupMs;
	while (Date.now() < deadline) {
		if (spawnError) throw spawnError;
		const endpoint = await liveEndpoint(paths.endpoint);
		if (endpoint) return { endpoint, started: true };
		await delay(50);
	}
	throw new Error(`Vestigio daemon did not become ready. See ${paths.log}`);
}

export async function openDaemon(storePath: string): Promise<DaemonStart> {
	const paths = runtimePaths(storePath);
	const pending = pendingStarts.get(paths.store);
	if (pending) return pending;
	const starting = start(paths);
	pendingStarts.set(paths.store, starting);
	try {
		return await starting;
	} finally {
		pendingStarts.delete(paths.store);
	}
}

export async function ensureDaemon(storePath: string): Promise<Endpoint> {
	return (await openDaemon(storePath)).endpoint;
}

export async function daemonRunning(storePath: string): Promise<boolean> {
	return (await liveEndpoint(runtimePaths(storePath).endpoint)) !== undefined;
}

export class DaemonError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export class VestigioClient {
	readonly storePath: string;
	private readonly endpoint: Endpoint | undefined;
	/**
	 * A pre-resolved endpoint skips per-request discovery, so a one-shot run that
	 * already owns a daemon keeps talking to that exact instance.
	 */
	constructor(storePath: string, endpoint?: Endpoint) {
		this.storePath = storePath;
		this.endpoint = endpoint;
	}

	private async request(path: string, options: RequestInit = {}, endpoint?: Endpoint): Promise<Response> {
		const active = endpoint ?? this.endpoint ?? await ensureDaemon(this.storePath);
		const response = await fetch(`http://127.0.0.1:${active.port}/v1${path}`, {
			...options,
			redirect: "error",
			headers: { authorization: `Bearer ${active.token}`, ...(options.body ? { "content-type": "application/json" } : {}) },
		});
		if (!response.ok) {
			const data = await response.json().catch(() => undefined) as { error?: string } | undefined;
			throw new DaemonError(response.status, data?.error ?? response.statusText);
		}
		return response;
	}

	async session(session: SessionKey): Promise<{ sessionRef: number }> {
		return await (await this.request("/sessions", { method: "POST", body: JSON.stringify(session) })).json() as { sessionRef: number };
	}

	async submit(input: Submission): Promise<Accepted> {
		return await (await this.request("/jobs", { method: "POST", body: JSON.stringify(input) })).json() as Accepted;
	}

	async get(jobId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return await (await this.request(`/jobs/${encodeURIComponent(jobId)}`, signal ? { signal } : {})).json() as Record<string, unknown>;
	}

	async list(sessionRef: number, after?: string): Promise<unknown> {
		return (await this.request(`/sessions/${sessionRef}/jobs${after ? `?after=${encodeURIComponent(after)}` : ""}`)).json();
	}

	async cancel(jobId: string): Promise<{ cancelled: boolean }> {
		return await (await this.request(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" })).json() as { cancelled: boolean };
	}

	async receive(sessionRef: number, relay = false): Promise<Event[]> {
		return await (await this.request(`/sessions/${sessionRef}/events${relay ? "?relay" : ""}`)).json() as Event[];
	}

	async relayed(sessionRef: number, eventIds: string[]): Promise<void> {
		if (!eventIds.length) return;
		const response = await this.request(`/sessions/${sessionRef}/delivered`, { method: "POST", body: JSON.stringify({ eventIds }) });
		await response.json();
	}

	async *events(sessionRef: number, signal?: AbortSignal): AsyncGenerator<Event> {
		const response = await this.request(`/sessions/${sessionRef}/events?stream`, signal ? { signal } : {});
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				let index: number;
				while ((index = buffer.indexOf("\n\n")) !== -1) {
					const frame = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6)) as Event;
				}
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	}

	async stop(): Promise<boolean> {
		const endpoint = await liveEndpoint(runtimePaths(this.storePath).endpoint);
		if (!endpoint) return false;
		const response = await this.request("/stop", { method: "POST" }, endpoint);
		await response.json();
		return true;
	}
}
