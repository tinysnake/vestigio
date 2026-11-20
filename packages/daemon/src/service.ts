import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { JobStore, JobStoreError } from "./jobs.js";
import { type Endpoint, type Kind, KINDS, identifier, object, sessionKey, submission } from "./protocol.js";
import type { MemoryJobControl, MemoryJobInput } from "./memory/contract.js";

export type Job = NonNullable<ReturnType<JobStore["claim"]>>;
export type Handler = (job: Job, signal: AbortSignal, control: MemoryJobControl) => Promise<unknown>;
const limits = { maintenance: 1, detector: 2, search: 4 } satisfies Record<Kind, number>;

export class JobService {
	readonly instanceId = randomUUID();
	private readonly changes = new EventEmitter().setMaxListeners(0);
	private readonly running = new Map<string, { kind: Kind; short: boolean; controller: AbortController }>();
	private readonly expiry: NodeJS.Timeout;
	private stopped = false;

	readonly store: JobStore;
	private readonly handler: Handler;

	constructor(store: JobStore, handler: Handler) {
		this.store = store;
		this.handler = handler;
		store.recover();
		store.expire();
		this.expiry = setInterval(() => store.expire(), 60_000).unref();
		this.pump();
	}

	pump(): void {
		if (this.stopped) return;
		if (![...this.running.values()].some((entry) => entry.short)) {
			const job = this.store.claim("maintenance", this.instanceId, "short");
			if (job) this.start(job, true);
		}
		for (const kind of KINDS) {
			let count = [...this.running.values()].filter((entry) => entry.kind === kind && !entry.short).length;
			while (count < limits[kind]) {
				const job = this.store.claim(kind, this.instanceId, kind === "maintenance" ? "agent" : "all");
				if (!job) break;
				count++;
				this.start(job, false);
			}
		}
	}

	private start(job: Job, short: boolean): void {
		const controller = new AbortController();
		this.running.set(job.jobId, { kind: job.kind, short, controller });
		void this.execute(job, controller).catch((error) => {
			console.error("Could not persist daemon job completion", error);
			process.exit(1);
		});
	}

	private async execute(job: Job, controller: AbortController): Promise<void> {
		let outcome: Parameters<JobStore["finish"]>[2];
		const children = new Map<string, { key: string; kind: Kind; input: MemoryJobInput }>();
		try {
			const result = await this.handler(job, controller.signal, {
				defer: async (kind, input, options) => {
					controller.signal.throwIfAborted();
					const key = options?.key ?? String(children.size);
					if (children.has(key)) throw new Error(`Duplicate child key ${key}`);
					children.set(key, { key, kind, input });
					return { key, kind, op: input.op, status: "enqueued", jobId: this.store.childId(job.jobId, key), input };
				},
			});
			outcome = { status: "succeeded", resultCode: "ok", result: result ?? null };
		} catch (error) {
			outcome = { status: "failed", resultCode: "error", result: { ...turnDetails(job.input), error: error instanceof Error ? error.message : String(error) } };
		}
		if (this.stopped) return;
		if (outcome.status === "succeeded" && children.size) this.store.waitForChildren(job, outcome, [...children.values()]);
		else this.store.finish(job.jobId, job.attemptId, outcome);
		this.running.delete(job.jobId);
		this.changes.emit(String(job.sessionRef));
		this.pump();
	}

	cancel(jobId: string): boolean {
		const job = this.store.get(jobId);
		if (job?.visibility !== "active" || !this.store.cancel(jobId, "cancelled", turnDetails(job.input) ?? null)) return false;
		this.running.get(jobId)?.controller.abort();
		this.changes.emit(String(job.sessionRef));
		return true;
	}

	listen(sessionRef: number, listener: () => void): () => void {
		const key = String(sessionRef);
		this.changes.on(key, listener);
		return () => this.changes.off(key, listener);
	}

	stop(): void {
		this.stopped = true;
		clearInterval(this.expiry);
		for (const { controller } of this.running.values()) controller.abort();
	}
}

const MAX_BODY = 8 * 1024 * 1024;
const HOST = "127.0.0.1";
class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function turnDetails(input: unknown): { turnLeaf: string; op?: string } | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const { turn_leaf, op } = input as Record<string, unknown>;
	if (typeof turn_leaf !== "string" || turn_leaf.length > 1024) return undefined;
	return { turnLeaf: turn_leaf, ...(typeof op === "string" && op.length <= 128 ? { op } : {}) };
}

async function body(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY) throw new HttpError(413, "Request too large");
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "Expected JSON request body");
	}
}

function send(response: ServerResponse, status: number, data: unknown, done?: () => void): void {
	const payload = JSON.stringify(data);
	if (done) response.once("finish", done);
	response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	response.end(payload);
}

function numberParam(value: string | null, fallback: number): number {
	if (value === null) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, "Expected a positive integer");
	return parsed;
}

function stream(service: JobService, response: ServerResponse, sessionRef: number): void {
	let writing = false;
	const flush = () => {
		if (writing || response.destroyed) return;
		service.store.expire();
		const events = service.store.pending(sessionRef, 16);
		if (!events.length) return;
		writing = true;
		response.write(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), (error) => {
			writing = false;
			if (error || response.destroyed) return;
			service.store.delivered(events.map((event) => event.eventId));
			flush();
		});
	};
	response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
	response.flushHeaders();
	const unsubscribe = service.listen(sessionRef, flush);
	const keepalive = setInterval(() => {
		if (!writing && !response.destroyed) response.write(": keepalive\n\n");
	}, 15_000).unref();
	response.once("close", () => {
		unsubscribe();
		clearInterval(keepalive);
	});
	flush();
}

export function httpServer(service: JobService, endpoint: Endpoint, stop: () => void) {
	const { store } = service;
	return createServer((request, response) => {
		void route().catch((error) => {
			if (response.headersSent) return response.destroy();
			const status = error instanceof HttpError ? error.status : error instanceof TypeError ? 400 :
				error instanceof JobStoreError ? (error.code === "request_conflict" ? 409 : 400) : 500;
			if (status === 500) console.error(error);
			send(response, status, { error: status === 500 ? "Daemon request failed" : (error as Error).message });
		});
		async function route() {
			const address = `${HOST}:${endpoint.port}`;
			if (request.headers.host !== address || request.headers.origin !== undefined) throw new HttpError(403, "Local daemon request required");
			if (request.headers.authorization !== `Bearer ${endpoint.token}`) throw new HttpError(401, "Invalid daemon token");
			const url = new URL(request.url ?? "/", `http://${address}`);
			const parts = url.pathname.split("/").slice(1);
			const [version, resource, key, action] = parts;
			const method = request.method;
			if (version !== "v1" || parts.length > 4) throw new HttpError(404, "Unknown daemon route");
			if (method === "GET" && resource === "health" && key === undefined) {
				return send(response, 200, { version: endpoint.version, instanceId: endpoint.instanceId });
			}
			if (method === "POST" && resource === "stop" && key === undefined) {
				return send(response, 200, { stopped: true }, stop);
			}
			if (method === "POST" && resource === "sessions" && key === undefined) {
				return send(response, 200, { sessionRef: store.ensureSession(sessionKey(await body(request))) });
			}
			if (method === "POST" && resource === "jobs" && key === undefined) {
				const job = submission(await body(request));
				if (job.requestId.startsWith("@child:")) throw new HttpError(400, "Reserved request identifier");
				const accepted = store.submit(job.session, job.requestId, job.kind, job.input);
				send(response, 202, accepted);
				setImmediate(() => service.pump());
				return;
			}
			if (resource === "jobs" && key && method === "GET" && action === undefined) {
				store.expire();
				const job = store.get(key);
				if (!job) throw new HttpError(404, "Unknown job");
				return send(response, 200, job);
			}
			if (resource === "jobs" && key && method === "POST" && action === "cancel") {
				return send(response, 200, { cancelled: service.cancel(key) });
			}
			if (resource === "sessions" && key) {
				const sessionRef = numberParam(key, 0);
				if (method === "GET" && action === "jobs") {
					store.expire();
					return send(response, 200, store.list(sessionRef, url.searchParams.get("after") ?? undefined, Math.min(numberParam(url.searchParams.get("limit"), 32), 100)));
				}
				if (method === "GET" && action === "events") {
					if (url.searchParams.has("stream")) return stream(service, response, sessionRef);
					store.expire();
					const events = store.pending(sessionRef, Math.min(numberParam(url.searchParams.get("limit"), 16), 100));
					const done = url.searchParams.has("relay") ? undefined : () => store.delivered(events.map((event) => event.eventId));
					return send(response, 200, events, done);
				}
				if (method === "POST" && action === "delivered") {
					const { eventIds } = object(await body(request));
					if (!Array.isArray(eventIds) || eventIds.length > 100) throw new HttpError(400, "Invalid event identifiers");
					const delivered = new Set(eventIds.map((id) => identifier(id, "event id", 128)));
					store.delivered(store.pending(sessionRef, 100).filter((event) => delivered.has(event.eventId)).map((event) => event.eventId));
					return send(response, 200, { delivered: true });
				}
			}
			throw new HttpError(404, "Unknown daemon route");
		}
	});
}
