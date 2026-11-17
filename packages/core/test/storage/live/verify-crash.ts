import { existsSync, readFileSync } from "node:fs";
import { openStore } from "../../../src/storage/index.js";
import { requiredArg } from "./live-memory.js";

const databasePath = requiredArg(2, "database path");
const walPath = `${databasePath}-wal`;
const walBytesBeforeOpen = existsSync(walPath) ? readFileSync(walPath).byteLength : 0;

const store = openStore({ path: databasePath, storeId: "vestigio" });
const uri = "memory://vestigio/crash-target";
const head = store.readMemory(uri);
const revisions = store.listRevisions(uri);
const report = store.integrityCheck();
const searchV1 = store.searchActive("crashv1", { limit: 10 });
const searchV2 = store.searchActive("crashv2", { limit: 10 });
store.close();

const result = {
  phase: "crash-verify",
  walBytesBeforeOpen,
  headRevision: head?.revision ?? null,
  revisions,
  bodyContainsV1: head?.medium.body.includes("crashv1") ?? false,
  bodyContainsV2: head?.medium.body.includes("crashv2") ?? false,
  sources: head?.medium.sources.length ?? 0,
  searchCrashv1: searchV1.map((hit) => hit.memory_id),
  searchCrashv2: searchV2.map((hit) => hit.memory_id),
  integrity: report,
};
console.log(JSON.stringify(result, null, 2));

if (
  head?.revision !== 1 ||
  revisions.length !== 1 ||
  result.bodyContainsV1 !== true ||
  result.bodyContainsV2 !== false ||
  searchV2.length !== 0 ||
  !report.ok
) {
  process.exitCode = 1;
}
