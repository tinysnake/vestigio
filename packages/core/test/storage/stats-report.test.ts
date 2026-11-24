/**
 * The operator-facing report the stats functions exist for (OBS-03).
 *
 * Skipped unless `VESTIGIO_STATS_STORE` names a store, so the suite stays
 * hermetic while the same file can print the numbers against a real one:
 *
 *   VESTIGIO_STATS_STORE=<path> VESTIGIO_STATS_PROJECT=<project id> \
 *   VESTIGIO_STATS_OUT=<file> \
 *   pnpm --filter @vestigio/core exec vitest run test/storage/stats-report.test.ts
 *
 * Opening an existing store applies any pending migration and records it, so a
 * second open is also the migration idempotence check: a re-run of `CREATE TABLE
 * turn_events` would fail.
 */

import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { readMemoryStats, readRuntimeStats } from "../../src/observability/stats.js";
import { openStore } from "../../src/storage/index.js";

const target = process.env.VESTIGIO_STATS_STORE;

it.runIf(target !== undefined && target !== "")("prints the memory-side report for a store", () => {
  const path = target as string;
  const projectId = process.env.VESTIGIO_STATS_PROJECT ?? "";
  const store = openStore({ path });
  const report = {
    store_id: store.storeId,
    migrations: store.listMigrations().map((migration) => `${migration.version}:${migration.name}`),
    project_id: projectId,
    memory: readMemoryStats(store, projectId),
    runtime: readRuntimeStats(store, projectId),
  };
  store.close();

  const reopened = openStore({ path });
  const applied = reopened.listMigrations().filter((migration) => migration.version === 7);
  reopened.close();

  expect(applied).toHaveLength(1);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const outPath = process.env.VESTIGIO_STATS_OUT;
  if (outPath !== undefined && outPath !== "") writeFileSync(outPath, text);
  process.stdout.write(text);
});
