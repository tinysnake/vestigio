import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function runtimePaths(storePath: string) {
	const requested = resolve(storePath);
	mkdirSync(dirname(requested), { recursive: true });
	let store: string;
	try {
		store = realpathSync(requested);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		store = join(realpathSync(dirname(requested)), basename(requested));
	}
	const directory = store + ".daemon";
	return {
		store,
		directory,
		lock: join(directory, "lock.sqlite"),
		jobs: join(directory, "jobs.sqlite"),
		endpoint: join(directory, "endpoint.json"),
		log: join(directory, "daemon.log"),
	};
}
