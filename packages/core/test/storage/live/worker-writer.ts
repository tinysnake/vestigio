import { openStore } from "../../../src/storage/index.js";
import { liveMemory, liveUsageEvent, requiredArg } from "./live-memory.js";

const databasePath = requiredArg(2, "database path");
const writerIndex = Number(requiredArg(3, "writer index"));
const writeCount = Number(requiredArg(4, "write count"));

const store = openStore({ path: databasePath, storeId: "vestigio", busyTimeoutMs: 15000 });
const startedAt = Date.now();
let inserted = 0;
let events = 0;
let duplicatesRejected = 0;

for (let index = 0; index < writeCount; index += 1) {
  const memoryId = `w${writerIndex}-i${index}`;
  const saved = store.saveMemory(liveMemory(memoryId, `writer-${writerIndex}-item-${index}`));
  if (saved.inserted) {
    inserted += 1;
  }

  const dedupKey = `w${writerIndex}:${index}`;
  if (store.recordUsageEvent(liveUsageEvent(memoryId, dedupKey))) {
    events += 1;
  }
  if (!store.recordUsageEvent(liveUsageEvent(memoryId, dedupKey))) {
    duplicatesRejected += 1;
  }
}

// A second revision of every sixth memory, written while readers are running.
let revised = 0;
for (let index = 0; index < writeCount; index += 6) {
  const memoryId = `w${writerIndex}-i${index}`;
  const saved = store.saveMemory(liveMemory(memoryId, `writer-${writerIndex}-item-${index}`, 2));
  if (saved.inserted) {
    revised += 1;
  }
}


store.close();
console.log(
  JSON.stringify({
    role: "writer",
    writer: writerIndex,
    inserted,
    revised,
    events,
    duplicatesRejected,
    elapsedMs: Date.now() - startedAt,
  }),
);
