import { startDaemon } from "../../src/bootstrap.js";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

await startDaemon(process.argv[2]!, () => async (job, signal, control) => {
	const input = job.input as { marker?: string; wait?: number; value?: unknown; child?: number };
	if (input.child) {
		await control.defer("maintenance", { op: "nav.run", wait: input.child, value: "child" });
		return { value: input.value };
	}
	if (input.marker) await writeFile(input.marker, String(process.pid));
	if (input.wait) await delay(input.wait, undefined, { signal });
	return input.value ?? null;
});
