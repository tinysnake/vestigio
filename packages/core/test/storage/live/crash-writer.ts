import { writeFileSync, writeSync } from "node:fs";
import { openStore } from "../../../src/storage/index.js";
import { liveMemory, requiredArg } from "./live-memory.js";

const databasePath = requiredArg(2, "database path");
const markerPath = requiredArg(3, "marker path");

const store = openStore({ path: databasePath, storeId: "vestigio", busyTimeoutMs: 15000 });
const uri = "memory://vestigio/crash-target";

store.saveMemory(liveMemory("crash-target", "crashv1", 1));

store.saveMemory(liveMemory("crash-target", "crashv2", 2), {
  beforeCommit: () => {
    writeFileSync(markerPath, "in-transaction\n");
    writeSync(1, "IN_TRANSACTION\n");
    for (;;) {
      // Hold the write transaction open until the harness kills this process.
    }
  },
});

console.log(`unexpected: ${uri} committed revision 2`);
