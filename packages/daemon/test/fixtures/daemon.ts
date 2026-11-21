import { startDaemon } from "../../src/bootstrap.js";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { appendFileSync } from "node:fs";
const trace = "/tmp/vestigio-lock-trace.log";

appendFileSync(trace, `fixture ${process.pid} start ${process.argv[2]}\n`);
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
appendFileSync(trace, `fixture ${process.pid} startDaemon returned\n`);
