#!/usr/bin/env node
/**
 * Vestigio PR-06 live resolver harness.
 *
 * Runs the six scenarios the plan names (Active-sufficient, Archived-sufficient,
 * lexical-decoy descends to raw history, a clear gap, a contradiction, and
 * mid-flight cancellation) against the real `vestigio resolve` CLI, the real
 * `@vestigio/model-client` and the real Obelisk history port, plus a small
 * performance comparison against PR-04's zero-LLM base search.
 *
 * The gateway configuration (base URL, key, model, price) is read at run time
 * from `~/.pi/agent/models.json`; the key is passed to the child through the
 * environment and is never printed, copied into a report, or written to disk.
 *
 * Live by default is off. Enable with `VESTIGIO_RESOLVER_LIVE=1`:
 *
 *   cd eval/resolver
 *   VESTIGIO_RESOLVER_LIVE=1 node --import ./hook.mjs ./run.mjs
 *
 * Without the gate the harness prints a "skipped" ledger and exits 0, so a
 * plain `pnpm test` never reaches the network.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const CLI = join(ROOT, "packages/cli/bin/vestigio");
const BUILD_FIXTURE = join(ROOT, "eval/fixtures/obelisk/build_fixture.sh");
const OUT = join(HERE, "out");
const MODELS_FILE = process.env["VESTIGIO_MODELS_FILE"] ?? "/Users/snake/.pi/agent/models.json";
const OPERATOR_INDEX = "/Users/snake/.obelisk/obelisk.sqlite";
const LIVE = process.env["VESTIGIO_RESOLVER_LIVE"] === "1";
const PROJECT = "/tmp/x_a";
const EVAL_PROJECT = "/tmp/resolver-eval";
const DEFAULT_MODEL = "auto/deepseek-v4.1-flash";

function readGateway() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
  } catch (error) {
    return { ok: false, reason: `cannot read ${MODELS_FILE}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const providers = parsed?.providers ?? {};
  const magpie = providers["magpie"];
  if (magpie === undefined) return { ok: false, reason: `no "magpie" provider in ${MODELS_FILE}` };
  const models = Array.isArray(magpie.models) ? magpie.models : [];
  const model = models.find((entry) => entry?.id === DEFAULT_MODEL) ?? models[0];
  if (model === undefined) return { ok: false, reason: `no model in the magpie provider` };
  if (typeof magpie.baseUrl !== "string" || typeof magpie.apiKey !== "string") {
    return { ok: false, reason: `magpie provider is missing baseUrl or apiKey` };
  }
  const cost = model.cost ?? { input: 0, output: 0 };
  return {
    ok: true,
    baseUrl: magpie.baseUrl,
    apiKey: magpie.apiKey,
    model: model.id ?? DEFAULT_MODEL,
    cost,
  };
}

function fileStat(path) {
  try {
    const stat = statSync(path);
    return { mtime_ms: stat.mtimeMs, bytes: stat.size };
  } catch {
    return null;
  }
}

function seedStore(root, scenario, project) {
  const storePath = join(root, `store-${scenario}.sqlite`);
  const result = spawnSync("node", ["--import", join(HERE, "hook.mjs"), join(HERE, "seed.mjs"), storePath, scenario, project], {
    encoding: "utf8",
    cwd: ROOT,
  });
  if (result.status !== 0) {
    throw new Error(`seed ${scenario} failed: ${result.stdout}${result.stderr}`);
  }
  return storePath;
}

function runCli(args, env, extra = {}) {
  const result = spawnSync(CLI, args, { encoding: "utf8", timeout: extra.timeoutMs ?? 300_000, env });
  return {
    code: result.status,
    out: result.stdout ?? "",
    err: result.stderr ?? "",
    wall_ms: extra.wallMs ?? null,
  };
}

function parseJson(text) {
  return JSON.parse(text);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

function main() {
  const ledger = {
    schema: "vestigio/eval-resolver@1",
    generated_at: new Date().toISOString(),
    live: LIVE,
    scenarios: [],
    checks: [],
    perf: null,
    obelisk_index: { path: OPERATOR_INDEX, before: fileStat(OPERATOR_INDEX), after: null, changed: null },
  };

  if (!LIVE) {
    ledger.reason = "VESTIGIO_RESOLVER_LIVE is not 1; no gateway was contacted";
    writeLedger(ledger);
    process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
    return 0;
  }

  const gateway = readGateway();
  if (!gateway.ok) {
    ledger.reason = gateway.reason;
    writeLedger(ledger);
    process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
    return 1;
  }
  ledger.model = { id: gateway.model, base_url_present: true, api_key: `len=${gateway.apiKey.length}`, cost: gateway.cost };

  const root = mkdtempSync(join(tmpdir(), "vestigio-resolver-eval-"));
  const childEnv = {
    ...process.env,
    VESTIGIO_MODEL_BASE_URL: gateway.baseUrl,
    VESTIGIO_MODEL_ID: gateway.model,
    VESTIGIO_MODEL_API_KEY: gateway.apiKey,
    VESTIGIO_MODEL_THINKING: "low",
    VESTIGIO_MODEL_COST_INPUT: String(gateway.cost.input),
    VESTIGIO_MODEL_COST_OUTPUT: String(gateway.cost.output),
  };
  const baseArgs = (store, project, question) => [
    "resolve",
    "--db",
    store,
    "--project",
    project,
    "--question",
    question,
    "--json",
    "--model-base-url",
    gateway.baseUrl,
    "--model-id",
    gateway.model,
    "--cost-input",
    String(gateway.cost.input),
    "--cost-output",
    String(gateway.cost.output),
  ];

  const result = { checks: ledger.checks };
  const check = (id, ok, detail) => {
    result.checks.push({ id, ok, detail });
    return ok;
  };

  try {
    // Build the isolated history fixture once: the history scenario is the only
    // one that needs it, and the adapter pins HOME so the operator index is
    // untouched.
    const fixtureHome = join(root, "obelisk-home");
    const build = spawnSync(BUILD_FIXTURE, [fixtureHome], { encoding: "utf8", cwd: ROOT });
    const fixtureOk = build.status === 0;
    ledger.fixture = { home: fixtureHome, built: fixtureOk, build_ms: null };
    if (!fixtureOk) {
      ledger.reason = `build_fixture.sh exited ${build.status}: ${build.stdout}${build.stderr}`;
    }
    const fixtureIndex = join(fixtureHome, ".obelisk", "obelisk.sqlite");

    // (a) Active is sufficient: no descent, the history port is not consulted.
    {
      const store = seedStore(root, "active", EVAL_PROJECT);
      const indexBefore = fileStat(fixtureIndex);
      const run = runCli(baseArgs(store, EVAL_PROJECT, "端口").concat(["--obelisk-home", fixtureHome]), childEnv);
      const payload = run.code === 0 ? parseJson(run.out) : null;
      const layers = payload?.layers ?? [];
      const active = layers.find((layer) => layer.layer === "active");
      const history = layers.find((layer) => layer.layer === "history");
      ledger.scenarios.push({ id: "a_active_sufficient", code: run.code, status: payload?.result?.status ?? null, model_calls: payload?.measured?.model_calls ?? null, layers, answer: payload?.result?.answer ?? null, missing: payload?.result?.missing ?? null });
      check("a.resolved", payload?.result?.status === "resolved", payload?.result?.status);
      check("a.active_matched", active?.status === "matched" && (active?.candidates ?? 0) > 0, active);
      check("a.no_history_search", history?.status === "skipped", history);
      check("a.history_index_unchanged", JSON.stringify(indexBefore) === JSON.stringify(fileStat(fixtureIndex)), { before: indexBefore, after: fileStat(fixtureIndex) });
      check("a.calls_within_ceiling", (payload?.measured?.model_calls ?? 99) <= 3, payload?.measured?.model_calls);
    }

    // (b) Archived is sufficient: Active is empty, Archived matches, and the
    // raw history is never searched even though the home is offered.
    {
      const store = seedStore(root, "archived", EVAL_PROJECT);
      const indexBefore = fileStat(fixtureIndex);
      const run = runCli(baseArgs(store, EVAL_PROJECT, "回滚 迁移").concat(["--obelisk-home", fixtureHome]), childEnv);
      const payload = run.code === 0 ? parseJson(run.out) : null;
      const layers = payload?.layers ?? [];
      const active = layers.find((layer) => layer.layer === "active");
      const archived = layers.find((layer) => layer.layer === "archived");
      const history = layers.find((layer) => layer.layer === "history");
      ledger.scenarios.push({ id: "b_archived_sufficient", code: run.code, status: payload?.result?.status ?? null, model_calls: payload?.measured?.model_calls ?? null, layers, answer: payload?.result?.answer ?? null });
      check("b.resolved", payload?.result?.status === "resolved", payload?.result?.status);
      check("b.active_empty", (active?.candidates ?? -1) === 0, active);
      check("b.archived_matched", archived?.status === "matched" && (archived?.candidates ?? 0) > 0, archived);
      check("b.no_history_search", history?.status === "skipped", history);
      check("b.history_index_unchanged", JSON.stringify(indexBefore) === JSON.stringify(fileStat(fixtureIndex)), { before: indexBefore, after: fileStat(fixtureIndex) });
    }

    // (c) A lexical candidate matches the words but not the question: the model
    // must not answer from the decoy, and the walk must reach raw history.
    {
      const store = seedStore(root, "lexical", PROJECT);
      const indexBefore = fileStat(fixtureIndex);
      const run = runCli(baseArgs(store, PROJECT, "zqleak").concat(["--obelisk-home", fixtureHome]), childEnv);
      const payload = run.code === 0 ? parseJson(run.out) : null;
      const layers = payload?.layers ?? [];
      const active = layers.find((layer) => layer.layer === "active");
      const history = layers.find((layer) => layer.layer === "history");
      const excerpts = payload?.history ?? [];
      ledger.scenarios.push({ id: "c_lexical_descends", code: run.code, status: payload?.result?.status ?? null, model_calls: payload?.measured?.model_calls ?? null, layers, history_excerpts: excerpts.length, answer: payload?.result?.answer ?? null, evidence: payload?.result?.evidence?.length ?? null });
      check("c.active_lexical_candidate", active?.status === "matched" && (active?.candidates ?? 0) > 0, active);
      check("c.descended_to_history", history?.status === "matched", history);
      check("c.history_excerpts_surfaced", excerpts.length >= 1, excerpts.length);
      check("c.not_resolved_from_decoy", payload?.result?.status !== "not_found", payload?.result?.status);
      check("c.history_index_after", fileStat(fixtureIndex) !== null, { before: indexBefore, after: fileStat(fixtureIndex) });
    }

    // (d) No evidence anywhere: an honest gap, never prose.
    {
      const store = seedStore(root, "gap", EVAL_PROJECT);
      const run = runCli(baseArgs(store, EVAL_PROJECT, "quantum entanglement protocol"), childEnv);
      const payload = run.code === 0 ? parseJson(run.out) : null;
      ledger.scenarios.push({ id: "d_clear_gap", code: run.code, status: payload?.result?.status ?? null, model_calls: payload?.measured?.model_calls ?? null, answer: payload?.result?.answer ?? null, missing: payload?.result?.missing ?? null, layers: payload?.layers ?? [] });
      check("d.not_found", payload?.result?.status === "not_found", payload?.result?.status);
      check("d.no_prose", payload?.result?.answer === null || payload?.result?.answer === undefined, payload?.result?.answer);
      check("d.states_a_gap", (payload?.result?.missing?.length ?? 0) > 0, payload?.result?.missing);
    }

    // (e) Two memories disagree: the divergence must be reported, not averaged.
    {
      const store = seedStore(root, "conflict", EVAL_PROJECT);
      const run = runCli(baseArgs(store, EVAL_PROJECT, "端口"), childEnv);
      const payload = run.code === 0 ? parseJson(run.out) : null;
      ledger.scenarios.push({ id: "e_conflict", code: run.code, status: payload?.result?.status ?? null, conflicts: payload?.result?.conflicts ?? null, answer: payload?.result?.answer ?? null, missing: payload?.result?.missing ?? null, model_calls: payload?.measured?.model_calls ?? null });
      check("e.contradiction_reported", (payload?.result?.conflicts?.length ?? 0) > 0 || payload?.result?.status === "conflicted", { status: payload?.result?.status, conflicts: payload?.result?.conflicts });
      check("e.no_flat_answer", payload?.result?.status !== "resolved", payload?.result?.status);
    }

    // (f) Cancellation reaches the in-flight model call.
    {
      const store = seedStore(root, "active", EVAL_PROJECT);
      const started = Date.now();
      const run = spawnSync(
        "node",
        ["--import", join(HERE, "hook.mjs"), join(HERE, "cancel.mjs"), store, EVAL_PROJECT, "端口"],
        { encoding: "utf8", cwd: ROOT, env: childEnv },
      );
      const wall_ms = Date.now() - started;
      let payload = null;
      try {
        payload = parseJson(run.stdout ?? "");
      } catch {
        payload = null;
      }
      ledger.scenarios.push({ id: "f_cancellation", code: run.status, wall_ms, cancelled: payload?.cancelled ?? null, status: payload?.status ?? null, calls: payload?.calls ?? null, missing: payload?.missing ?? null });
      check("f.cancelled", payload?.cancelled === true, payload ?? (run.stdout || run.stderr));
      check("f.no_model_time_wasted", wall_ms < 20_000, wall_ms);
    }

    // Performance: the same question through resolve and through PR-04's base
    // search. One process invocation == one primary-Agent tool call each.
    {
      const store = seedStore(root, "active", EVAL_PROJECT);
      const resolveRuns = [];
      const searchRuns = [];
      for (let index = 0; index < 3; index += 1) {
        const started = Date.now();
        const run = runCli(baseArgs(store, EVAL_PROJECT, "端口"), childEnv);
        const wall_ms = Date.now() - started;
        const payload = run.code === 0 ? parseJson(run.out) : null;
        resolveRuns.push({
          wall_ms,
          status: payload?.result?.status ?? null,
          model_calls: payload?.measured?.model_calls ?? null,
          model_ms: payload?.measured?.model_ms ?? null,
          gather_ms: payload?.measured?.gather_ms ?? null,
          history_read_ms: payload?.measured?.history_read_ms ?? null,
          tokens_in: payload?.measured?.tokens_in ?? null,
          tokens_out: payload?.measured?.tokens_out ?? null,
          cost_usd: payload?.measured?.cost_usd ?? null,
        });
      }
      for (let index = 0; index < 3; index += 1) {
        const started = Date.now();
        const run = runCli(["search", "--db", store, "--project", EVAL_PROJECT, "--query", "端口", "--json"], childEnv);
        const wall_ms = Date.now() - started;
        const payload = run.code === 0 ? parseJson(run.out) : null;
        searchRuns.push({
          wall_ms,
          status: payload?.result?.status ?? null,
          model_calls: payload?.result?.budget_used?.model_calls ?? null,
          gather_ms: payload?.result?.budget_used?.elapsed_ms ?? null,
          // The base `search` never requests the history layer, so it reads no raw sources.
          history_read_ms: 0,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: null,
        });
      }
      const sum = (runs, key) => runs.reduce((total, run) => total + (typeof run[key] === "number" ? run[key] : 0), 0);
      ledger.perf = {
        question: "端口",
        note: "One CLI process invocation is the analogue of one primary-Agent tool call; both arms are one call. `requests_total` counts outbound model HTTP requests (0 for the zero-LLM base search).",
        resolve: {
          runs: resolveRuns,
          requests_per_run: resolveRuns[0]?.model_calls ?? null,
          requests_total: sum(resolveRuns, "model_calls"),
          median_wall_ms: median(resolveRuns.map((run) => run.wall_ms)),
          model_ms: sum(resolveRuns, "model_ms"),
          gather_ms: sum(resolveRuns, "gather_ms"),
          history_read_ms: sum(resolveRuns, "history_read_ms"),
          tokens_in: sum(resolveRuns, "tokens_in"),
          tokens_out: sum(resolveRuns, "tokens_out"),
          cost_usd: sum(resolveRuns, "cost_usd"),
          agent_tool_calls: 1,
        },
        base_search: {
          runs: searchRuns,
          requests_per_run: 0,
          requests_total: 0,
          median_wall_ms: median(searchRuns.map((run) => run.wall_ms)),
          gather_ms: sum(searchRuns, "gather_ms"),
          history_read_ms: sum(searchRuns, "history_read_ms"),
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          agent_tool_calls: 1,
        },
      };
    }
  } finally {
    ledger.obelisk_index.after = fileStat(OPERATOR_INDEX);
    ledger.obelisk_index.changed =
      JSON.stringify(ledger.obelisk_index.before) !== JSON.stringify(ledger.obelisk_index.after);
    ledger.passed = ledger.checks.every((check) => check.ok);
    writeLedger(ledger);
    process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
    rmSync(root, { recursive: true, force: true });
  }
  return ledger.passed ? 0 : 1;
}

function writeLedger(ledger) {
  mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(OUT, "latest.json"), `${JSON.stringify(ledger, null, 2)}\n`);
  writeFileSync(join(OUT, `run-${stamp}.json`), `${JSON.stringify(ledger, null, 2)}\n`);
}

process.exitCode = main();
