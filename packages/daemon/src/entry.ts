import { startDaemon } from "./bootstrap.js";

const store = process.argv[2];
if (!store) throw new Error("Expected the memory store path");
await startDaemon(store, async (path) => {
	const { createMemoryHandler } = await import("./memory/index.js");
	return createMemoryHandler(path, { recoverExclusive: true });
});
