import { openStore } from "../../../src/storage/index.js";
import { requiredArg } from "./live-memory.js";

const databasePath = requiredArg(2, "database path");
const durationMs = Number(requiredArg(3, "duration in ms"));

const store = openStore({ path: databasePath, storeId: "vestigio", busyTimeoutMs: 15000 });
const deadline = Date.now() + durationMs;
let iterations = 0;
let hits = 0;
let reads = 0;
let failures = 0;
const problems: string[] = [];

while (Date.now() < deadline) {
  iterations += 1;
  for (const hit of store.searchActive("writer", { limit: 25 })) {
    hits += 1;
    const memory = store.readMemory(hit.uri);
    if (memory === null) {
      failures += 1;
      problems.push(`missing memory for hit ${hit.memory_id}`);
      continue;
    }
    if (memory.memory_id !== hit.memory_id) {
      failures += 1;
      problems.push(`hit ${hit.memory_id} read back as ${memory.memory_id}`);
      continue;
    }
    if (memory.medium.sources.length === 0) {
      failures += 1;
      problems.push(`memory ${hit.memory_id} has no sources`);
      continue;
    }
    if (!memory.medium.body.includes(`第${memory.revision}版正文`)) {
      failures += 1;
      problems.push(`memory ${hit.memory_id} head revision ${memory.revision} does not match its body`);
      continue;
    }
    if (memory.nav === null) {
      failures += 1;
      problems.push(`memory ${hit.memory_id} is published without a nav`);
      continue;
    }
    if (memory.nav.source_revision !== memory.revision) {
      failures += 1;
      problems.push(`memory ${hit.memory_id} nav points at revision ${memory.nav.source_revision}`);
      continue;
    }
    reads += 1;
  }
  await new Promise((resolve) => setTimeout(resolve, 2));
}

const report = store.integrityCheck();
store.close();
console.log(
  JSON.stringify({
    role: "reader",
    iterations,
    hits,
    reads,
    failures,
    integrityOk: report.ok,
    problems: problems.slice(0, 5),
  }),
);
if (failures > 0 || !report.ok || reads === 0) {
  process.exitCode = 1;
}
