import { spawn } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../../../src/storage/index.js";
import { liveMemory, liveUri } from "./live-memory.js";

const liveDir = fileURLToPath(new URL(".", import.meta.url));
const corpusSize = Number(process.env["CORPUS"] ?? "2000");
const readRepeats = Number(process.env["READS"] ?? "500");
const writeRepeats = Number(process.env["WRITES"] ?? "200");
const lockRounds = Number(process.env["LOCK_ROUNDS"] ?? "20");

const dir = mkdtempSync(join(tmpdir(), "vestigio-bench-"));
const databasePath = join(dir, "bench.db");
const store = openStore({ path: databasePath, storeId: "vestigio", busyTimeoutMs: 20000 });

const buildStarted = performance.now();
for (let index = 0; index < corpusSize; index += 1) {
  store.saveMemory(liveMemory(`bench-${index}`, `benchitem${index}`));
}
const buildMs = performance.now() - buildStarted;

let seed = 42;
function nextRandom(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

const readSamples: number[] = [];
for (let index = 0; index < readRepeats; index += 1) {
  const memoryId = `bench-${Math.floor(nextRandom() * corpusSize)}`;
  const uri = liveUri(memoryId);
  const started = performance.now();
  const memory = store.readMemory(uri);
  readSamples.push(performance.now() - started);
  if (memory === null) {
    throw new Error(`read returned null for ${uri}`);
  }
}

const writeSamples: number[] = [];
for (let index = 0; index < writeRepeats; index += 1) {
  const memory = liveMemory(`bench-write-${index}`, `writemarker${index}`);
  const started = performance.now();
  store.saveMemory(memory);
  writeSamples.push(performance.now() - started);
}

const busyWaitSamples: number[] = [];
for (let round = 0; round < lockRounds; round += 1) {
  const holdMs = 40 + round * 8;
  const child = spawn(
    process.execPath,
    ["--import", join(liveDir, "hook.mjs"), join(liveDir, "lock-holder.ts"), databasePath, String(holdMs)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.includes("READY")) {
        resolve();
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!buffer.includes("READY")) {
        reject(new Error(`lock holder exited before READY with code ${String(code)}`));
      }
    });
  });
  const started = performance.now();
  store.saveMemory(liveMemory(`bench-lock-${round}`, `lockround${round}`));
  busyWaitSamples.push(performance.now() - started);
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
}

const report = store.integrityCheck();
const memories = store.countMemories();
store.close();

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function summary(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const pick = (quantile: number): number => {
    const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
    return round(sorted[index] ?? Number.NaN);
  };
  return {
    count: sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    max: round(sorted[sorted.length - 1] ?? Number.NaN),
  };
}

const read = summary(readSamples);
const machine = {
  platform: platform(),
  release: release(),
  arch: process.arch,
  cpu: cpus()[0]?.model ?? "unknown",
  totalMemoryGb: round(totalmem() / 1024 ** 3),
  node: process.version,
};

console.log(
  JSON.stringify(
    {
      machine,
      corpusMemories: corpusSize,
      dbBytes: statSync(databasePath).size,
      buildMs: round(buildMs),
      repeats: { reads: readRepeats, writes: writeRepeats, busyWaits: lockRounds },
      mediumSummaryReadMs: read,
      writeMs: summary(writeSamples),
      busyWaitWriteMs: summary(busyWaitSamples),
      readBudgetMs: 200,
      readWithinBudget: read.p95 <= 200,
      memories,
      integrity: report,
      databasePath,
    },
    null,
    2,
  ),
);
if (!report.ok) {
  process.exitCode = 1;
}
