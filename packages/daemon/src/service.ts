import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import { createObsLog, OBS_RECORD_VERSION, type IfaceRouteCounts, type IfaceSnapshotRecord, type ObsLog } from "@vestigio/core/observability";
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
		const children = new Map<string, { key: string; kind: Kind; input: MemoryJobInput; mandatory: boolean }>();
		try {
			const result = await this.handler(job, controller.signal, {
				defer: async (kind, input, options) => {
					controller.signal.throwIfAborted();
					const key = options?.key ?? String(children.size);
					if (children.has(key)) throw new Error(`Duplicate child key ${key}`);
					const mandatory = options?.mandatory !== false;
					children.set(key, { key, kind, input, mandatory });
					return { key, kind, op: input.op, status: "enqueued", jobId: this.store.childId(job.jobId, key), input, mandatory };
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

export type IfaceStatsOptions = {
	/** Directory for `iface.jsonl`. Defaults to `VESTIGIO_OBS_DIR`, else `<store>.observability`. */
	readonly obsDir?: string;
	/** Append one per-request detail line. Defaults to `VESTIGIO_IFACE_LOG=1`. */
	readonly logRequests?: boolean;
	/** Directory-wide byte cap for the observability log. Defaults to `VESTIGIO_OBS_MAX_BYTES`. */
	readonly maxBytes?: number;
};

/** What `GET /v1/stats` returns: the counters and when they started. */
export type IfaceStatsSummary = {
	readonly since: string;
	readonly window_ms: number;
	readonly scope: string;
	readonly routes: Readonly<Record<string, IfaceRouteCounts>>;
	readonly reasons: Readonly<Record<string, number>>;
};

type RouteCounts = { "2xx": number; "4xx": number; "5xx": number; total: number };

/** Route key for a request that never identified a route (bad version, method or path). */
const UNMATCHED_ROUTE = "unknown";
/**
 * Control endpoints are lifecycle, not memory traffic. Leaving them out keeps a
 * stats read from changing the counters it reports and lets the shutdown
 * snapshot match the last read exactly.
 */
const UNCOUNTED_ROUTES: ReadonlySet<string> = new Set(["GET /v1/stats", "POST /v1/stop"]);
/** The rejection causes section 7 asks for; seeded at zero so the shape is stable. */
const REJECTION_REASONS = ["403_host", "401_token"] as const;

function emptyCounts(): RouteCounts {
	return { "2xx": 0, "4xx": 0, "5xx": 0, total: 0 };
}

function statusClass(status: number): "2xx" | "4xx" | "5xx" | undefined {
	if (status >= 200 && status < 300) return "2xx";
	if (status >= 400 && status < 500) return "4xx";
	if (status >= 500 && status < 600) return "5xx";
	return undefined;
}

function rejectionReason(status: number): string | undefined {
	if (status === 403) return "403_host";
	if (status === 401) return "401_token";
	return undefined;
}

function observabilityDir(options: IfaceStatsOptions): string | undefined {
	if (options.obsDir !== undefined) return options.obsDir;
	const override = process.env["VESTIGIO_OBS_DIR"];
	if (override !== undefined && override.length > 0) return override;
	// The daemon is launched with the store path as its first argument (entry.ts).
	// It is always absolute, so a stray relative argument is not read as a store.
	const store = process.argv[2];
	return store !== undefined && isAbsolute(store) ? `${store}.observability` : undefined;
}

function observabilityMaxBytes(options: IfaceStatsOptions): number | undefined {
	if (options.maxBytes !== undefined) return options.maxBytes;
	const parsed = Number(process.env["VESTIGIO_OBS_MAX_BYTES"]);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function logEveryRequest(options: IfaceStatsOptions): boolean {
	return options.logRequests ?? (process.env["VESTIGIO_IFACE_LOG"] === "1");
}

/**
 * In-process interface counters (OBS-04). Every request that reaches a route
 * contributes one status class and one route total; a 401/403 also bumps a
 * reason. Updates are plain synchronous map writes, so concurrent requests
 * cannot lose one. `GET /v1/stats` and `POST /v1/stop` are not counted.
 */
class IfaceStats {
	private readonly sinceMs = Date.now();
	private readonly since = new Date(this.sinceMs).toISOString();
	private readonly routes = new Map<string, RouteCounts>();
	private readonly reasons = new Map<string, number>();
	private readonly log: ObsLog | undefined;
	private readonly logRequests: boolean;
	private flushed = false;

	constructor(dir: string | undefined, maxBytes: number | undefined, logRequests: boolean) {
		this.logRequests = logRequests;
		this.log = dir === undefined ? undefined : createObsLog(maxBytes === undefined ? { dir, kind: "iface" } : { dir, kind: "iface", maxBytes });
		for (const reason of REJECTION_REASONS) this.reasons.set(reason, 0);
	}

	record(route: string, status: number, durationMs: number): void {
		if (UNCOUNTED_ROUTES.has(route)) return;
		const counts = this.countsFor(route);
		const bucket = statusClass(status);
		if (bucket !== undefined) counts[bucket] += 1;
		counts.total += 1;
		const reason = rejectionReason(status);
		if (reason !== undefined) this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
		if (this.logRequests && this.log !== undefined) this.log.append(this.requestRecord(route, bucket, reason, durationMs));
	}

	/** The counters `GET /v1/stats` returns; never carries the token or the store path. */
	summary(): IfaceStatsSummary {
		return {
			since: this.since,
			window_ms: Date.now() - this.sinceMs,
			scope: "daemon",
			routes: this.routesSnapshot(),
			reasons: this.reasonsSnapshot(),
		};
	}

	/** Write the `iface_snapshot` once: the stop route and the process exit share it. */
	flushSnapshot(): void {
		if (this.flushed) return;
		this.flushed = true;
		if (this.log === undefined) return;
		this.log.append({
			type: "iface_snapshot",
			v: OBS_RECORD_VERSION,
			at: new Date().toISOString(),
			since: this.since,
			window_ms: Date.now() - this.sinceMs,
			scope: "daemon",
			routes: this.routesSnapshot(),
			reasons: this.reasonsSnapshot(),
		});
		this.log.close();
	}

	private countsFor(route: string): RouteCounts {
		let counts = this.routes.get(route);
		if (counts === undefined) {
			counts = emptyCounts();
			this.routes.set(route, counts);
		}
		return counts;
	}

	/**
	 * One line per request when `VESTIGIO_IFACE_LOG=1`. It reuses the snapshot
	 * shape with `scope: "request"` and a one-request `routes` map, so it stays a
	 * validated record the rotating writer accepts.
	 */
	private requestRecord(route: string, bucket: "2xx" | "4xx" | "5xx" | undefined, reason: string | undefined, durationMs: number): IfaceSnapshotRecord {
		const counts = emptyCounts();
		if (bucket !== undefined) counts[bucket] = 1;
		counts.total = 1;
		const at = Date.now();
		return {
			type: "iface_snapshot",
			v: OBS_RECORD_VERSION,
			at: new Date(at).toISOString(),
			since: new Date(at - durationMs).toISOString(),
			window_ms: durationMs,
			scope: "request",
			routes: { [route]: counts },
			reasons: reason === undefined ? {} : { [reason]: 1 },
		};
	}

	private routesSnapshot(): Record<string, IfaceRouteCounts> {
		const snapshot: Record<string, IfaceRouteCounts> = {};
		for (const [route, counts] of this.routes) snapshot[route] = { ...counts };
		return snapshot;
	}

	private reasonsSnapshot(): Record<string, number> {
		return Object.fromEntries(this.reasons);
	}
}

export function httpServer(service: JobService, endpoint: Endpoint, stop: () => void, options: IfaceStatsOptions = {}) {
	const { store } = service;
	const stats = new IfaceStats(observabilityDir(options), observabilityMaxBytes(options), logEveryRequest(options));
	const server = createServer((request, response) => {
		const startedAt = Date.now();
		let routeKey: string = UNMATCHED_ROUTE;
		const finish = (status: number): void => {
			stats.record(routeKey, status, Date.now() - startedAt);
		};
		void route().then(
			() => finish(response.statusCode ?? 200),
			(error) => {
				if (response.headersSent) {
					response.destroy();
					finish(response.statusCode ?? 500);
					return;
				}
				const status = error instanceof HttpError ? error.status : error instanceof TypeError ? 400 :
					error instanceof JobStoreError ? (error.code === "request_conflict" ? 409 : 400) : 500;
				if (status === 500) console.error(error);
				send(response, status, { error: status === 500 ? "Daemon request failed" : (error as Error).message });
				finish(status);
			},
		);
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
				routeKey = "GET /v1/health";
				return send(response, 200, { version: endpoint.version, instanceId: endpoint.instanceId });
			}
			if (method === "GET" && resource === "stats" && key === undefined) {
				routeKey = "GET /v1/stats";
				return send(response, 200, stats.summary());
			}
			if (method === "POST" && resource === "stop" && key === undefined) {
				routeKey = "POST /v1/stop";
				return send(response, 200, { stopped: true }, () => {
					stats.flushSnapshot();
					stop();
				});
			}
			if (method === "POST" && resource === "sessions" && key === undefined) {
				routeKey = "POST /v1/sessions";
				return send(response, 200, { sessionRef: store.ensureSession(sessionKey(await body(request))) });
			}
			if (method === "POST" && resource === "jobs" && key === undefined) {
				routeKey = "POST /v1/jobs";
				const job = submission(await body(request));
				if (job.requestId.startsWith("@child:")) throw new HttpError(400, "Reserved request identifier");
				const accepted = store.submit(job.session, job.requestId, job.kind, job.input);
				send(response, 202, accepted);
				setImmediate(() => service.pump());
				return;
			}
			if (resource === "jobs" && key && method === "GET" && action === undefined) {
				routeKey = "GET /v1/jobs/:key";
				store.expire();
				const job = store.get(key);
				if (!job) throw new HttpError(404, "Unknown job");
				return send(response, 200, job);
			}
			if (resource === "jobs" && key && method === "POST" && action === "cancel") {
				routeKey = "POST /v1/jobs/:key/cancel";
				return send(response, 200, { cancelled: service.cancel(key) });
			}
			if (resource === "sessions" && key) {
				const sessionRef = numberParam(key, 0);
				if (method === "GET" && action === "jobs") {
					routeKey = "GET /v1/sessions/:ref/jobs";
					store.expire();
					return send(response, 200, store.list(sessionRef, url.searchParams.get("after") ?? undefined, Math.min(numberParam(url.searchParams.get("limit"), 32), 100)));
				}
				if (method === "GET" && action === "events") {
					routeKey = "GET /v1/sessions/:ref/events";
					if (url.searchParams.has("stream")) return stream(service, response, sessionRef);
					store.expire();
					const events = store.pending(sessionRef, Math.min(numberParam(url.searchParams.get("limit"), 16), 100));
					const done = url.searchParams.has("relay") ? undefined : () => store.delivered(events.map((event) => event.eventId));
					return send(response, 200, events, done);
				}
				if (method === "POST" && action === "delivered") {
					routeKey = "POST /v1/sessions/:ref/delivered";
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
	const flushOnExit = (): void => stats.flushSnapshot();
	process.once("exit", flushOnExit);
	server.once("close", () => process.off("exit", flushOnExit));
	return server;
}
