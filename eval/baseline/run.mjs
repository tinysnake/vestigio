#!/usr/bin/env node
/**
 * Vestigio PR-01 baseline harness.
 *
 * Runs one question through two arms and writes a resource ledger:
 *   none    - no memory at all; the arm returns nothing and reads 0 bytes
 *   obelisk - shell out to the local Obelisk CLI (`obelisk --search <question>`)
 *
 * Obelisk may be absent or fail; that arm reports status "not_run" with a
 * reason and null resource numbers. It never invents a measurement.
 *
 * Usage:
 *   node eval/baseline/run.mjs --question "..." [--mode both|none|obelisk]
 *        [--out <dir>] [--timeout-ms <n>] [--obelisk-bin <path>]
 *
 * Ledger is written to <out>/latest.json and <out>/run-<timestamp>.json, and
 * printed to stdout.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, "out");
const TOKEN_ESTIMATE_BYTES_PER_TOKEN = 4;

function usage() {
  process.stdout.write(
    "Usage: node eval/baseline/run.mjs --question \"...\" " +
      "[--mode both|none|obelisk] [--out <dir>] [--timeout-ms <n>] [--obelisk-bin <path>]\n",
  );
}

function parseArgs(argv) {
  const args = {
    question: null,
    mode: "both",
    out: DEFAULT_OUT,
    timeoutMs: 60_000,
    obeliskBin: process.env.OBELISK_BIN ?? "obelisk",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--question" || flag === "-q") {
      args.question = argv[index + 1] ?? null;
      index += 1;
    } else if (flag === "--mode") {
      args.mode = argv[index + 1] ?? "both";
      index += 1;
    } else if (flag === "--out") {
      args.out = resolve(argv[index + 1] ?? DEFAULT_OUT);
      index += 1;
    } else if (flag === "--timeout-ms") {
      args.timeoutMs = Number(argv[index + 1] ?? 60_000);
      index += 1;
    } else if (flag === "--obelisk-bin") {
      args.obeliskBin = argv[index + 1] ?? "obelisk";
      index += 1;
    } else if (flag === "--help" || flag === "-h") {
      usage();
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${flag}\n`);
      usage();
      process.exit(2);
    }
  }
  if (args.question === null || args.question.length === 0) {
    process.stderr.write("--question is required and must be non-empty\n");
    process.exit(2);
  }
  if (!["both", "none", "obelisk"].includes(args.mode)) {
    process.stderr.write(`--mode must be both, none or obelisk; got ${args.mode}\n`);
    process.exit(2);
  }
  return args;
}

function roundMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

function tokenEstimate(bytes) {
  return Math.ceil(bytes / TOKEN_ESTIMATE_BYTES_PER_TOKEN);
}

/** Sum the text of every message in an Obelisk search result array. */
function extractTextChars(parsed) {
  let chars = 0;
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      if (typeof node.text === "string") chars += node.text.length;
      for (const value of Object.values(node)) {
        if (value !== null && typeof value === "object") visit(value);
      }
    }
  };
  visit(parsed);
  return chars;
}

function runNone(question) {
  const startedAt = performance.now();
  const delivered = "";
  return {
    mode: "none",
    status: "ok",
    reason: "no memory backend configured",
    elapsed_ms: roundMs(startedAt),
    question_chars: question.length,
    bytes: Buffer.byteLength(delivered, "utf8"),
    token_estimate: 0,
    evidence_count: 0,
    answer_chars: delivered.length,
  };
}

function runObelisk(question, options) {
  const startedAt = performance.now();
  const result = spawnSync(options.obeliskBin, ["--search", question], {
    timeout: options.timeoutMs,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsed = roundMs(startedAt);
  if (result.error !== undefined && result.error !== null) {
    return {
      mode: "obelisk",
      status: "not_run",
      reason: `spawn failed: ${result.error.message}`,
      elapsed_ms: elapsed,
      question_chars: question.length,
      bytes: null,
      token_estimate: null,
      evidence_count: null,
      answer_chars: null,
    };
  }
  if (result.status !== 0) {
    const reason = (result.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
    return {
      mode: "obelisk",
      status: "not_run",
      reason: `exit ${result.status}${reason.length > 0 ? `: ${reason}` : ""}`,
      elapsed_ms: elapsed,
      question_chars: question.length,
      bytes: null,
      token_estimate: null,
      evidence_count: null,
      answer_chars: null,
    };
  }
  const stdout = result.stdout ?? "";
  const bytes = Buffer.byteLength(stdout, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return {
      mode: "obelisk",
      status: "not_run",
      reason: `unparseable output: ${error instanceof Error ? error.message : String(error)}`,
      elapsed_ms: elapsed,
      question_chars: question.length,
      bytes: null,
      token_estimate: null,
      evidence_count: null,
      answer_chars: null,
    };
  }
  const results = Array.isArray(parsed) ? parsed : [];
  return {
    mode: "obelisk",
    status: "ok",
    reason: `obelisk --search returned ${results.length} result(s)` +
      ((result.stderr ?? "").trim().length > 0 ? " with stderr warnings" : ""),
    elapsed_ms: elapsed,
    question_chars: question.length,
    bytes,
    token_estimate: tokenEstimate(bytes),
    evidence_count: results.length,
    answer_chars: extractTextChars(results),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const runs = [];
  if (options.mode === "both" || options.mode === "none") runs.push(runNone(options.question));
  if (options.mode === "both" || options.mode === "obelisk") {
    runs.push(runObelisk(options.question, options));
  }
  const ledger = {
    schema: "vestigio/eval-baseline@1",
    generated_at: new Date().toISOString(),
    question: options.question,
    token_estimate_bytes_per_token: TOKEN_ESTIMATE_BYTES_PER_TOKEN,
    runs,
  };
  mkdirSync(options.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(resolve(options.out, "latest.json"), `${JSON.stringify(ledger, null, 2)}\n`);
  writeFileSync(resolve(options.out, `run-${stamp}.json`), `${JSON.stringify(ledger, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
}

main();
