import { DatabaseSync } from "node:sqlite";
import { openStore } from "../../../src/storage/index.js";
import { requiredArg } from "./live-memory.js";

const databasePath = requiredArg(2, "database path");
const store = openStore({ path: databasePath, storeId: "vestigio" });

const report = store.integrityCheck();
const memories = store.countMemories();
const published = store.countMemories("published");
const archived = store.countMemories("archived");
const events = store.countUsageEvents();
const receipts = store.countInjectionReceipts();

const raw = new DatabaseSync(databasePath, { readOnly: true });
const withoutSources = raw
  .prepare(
    "SELECT COUNT(*) AS n FROM memories m LEFT JOIN sources s ON s.memory_id = m.memory_id AND s.revision = m.revision WHERE s.memory_id IS NULL",
  )
  .get() as { n: number };
const withoutHead = raw
  .prepare(
    "SELECT COUNT(*) AS n FROM memories m LEFT JOIN memory_heads h ON h.memory_id = m.memory_id WHERE h.memory_id IS NULL",
  )
  .get() as { n: number };
raw.close();

const hits = store.searchActive("部署", { limit: 500 });
let unreadable = 0;
for (const hit of hits) {
  if (store.readMemory(hit.uri) === null) {
    unreadable += 1;
  }
}

store.close();
const result = {
  phase: "concurrent-verify",
  integrity: report,
  memories,
  published,
  archived,
  events,
  receipts,
  memoriesWithoutSources: withoutSources.n,
  memoriesWithoutHead: withoutHead.n,
  activeSearchHits: hits.length,
  unreadableHits: unreadable,
};
console.log(JSON.stringify(result, null, 2));
if (
  !report.ok ||
  withoutSources.n > 0 ||
  withoutHead.n > 0 ||
  unreadable > 0
) {
  process.exitCode = 1;
}
