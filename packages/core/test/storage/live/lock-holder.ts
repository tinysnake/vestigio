import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { requiredArg } from "./live-memory.js";

const databasePath = requiredArg(2, "database path");
const holdMs = Number(requiredArg(3, "hold duration in ms"));

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA busy_timeout = 20000");
db.exec("BEGIN IMMEDIATE");
db.prepare(
  "INSERT INTO usage_events (event_id, memory_id, revision, kind, channel, session_id, input_id, at, dedup_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
).run(
  `lock-${process.pid}-${Date.now()}`,
  "bench-0",
  1,
  "hit",
  "search",
  "lock-holder",
  "lock-holder",
  "2026-11-17T16:00:00Z",
  `lock-${process.pid}`,
);

writeSync(1, "READY\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, holdMs);
