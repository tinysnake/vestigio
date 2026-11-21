import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { JobStore } from "./jobs.js";
import { tryLock } from "./lock.js";
import { PROTOCOL_VERSION, type Endpoint } from "./protocol.js";
import { runtimePaths } from "./runtime.js";
import { JobService, httpServer, type Handler } from "./service.js";

export async function startDaemon(requested: string, createHandler: (store: string) => Handler | Promise<Handler>): Promise<void> {
	const paths = runtimePaths(requested);
	mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	const lock = tryLock(paths.lock);
	if (!lock) return;
	// The connection behind this lock is the exclusion. It must stay reachable for the
	// daemon's lifetime; a local that V8 collects is closed and lets a second daemon
	// adopt the same store.
	const heldLock = lock;

	const handler = await createHandler(paths.store);
	const store = new JobStore(paths.jobs);
	const service = new JobService(store, handler);
	const endpoint: Endpoint = {
		version: PROTOCOL_VERSION,
		instanceId: service.instanceId,
		port: 0,
		token: randomBytes(32).toString("hex"),
	};
	let stopping = false;
	function stop() {
		if (stopping) return;
		stopping = true;
		service.stop();
		server.close();
		rmSync(paths.endpoint, { force: true });
		heldLock.close();
		process.exit(0);
	}
	const server = httpServer(service, endpoint, stop);
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected a TCP endpoint");
		endpoint.port = address.port;
		const temporary = paths.endpoint + ".tmp";
		rmSync(temporary, { force: true });
		writeFileSync(temporary, JSON.stringify(endpoint), { mode: 0o600, flag: "wx" });
		renameSync(temporary, paths.endpoint);
	});
}

