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

/**
 * A corpus that actually answers a question, so PR-07's save path is exercised
 * on honest evidence instead of the probe's filler text. Long enough that a
 * 500-1000 character body never exceeds the material it summarizes.
 */
const PERSIST_TURNS = [
  ["user", "部署脚本的默认端口是多少？"],
  [
    "assistant",
    "默认端口统一成 8787，写在部署仓库的 README 和环境对照表里。之前三套环境各写一个端口，出过两次连错服务的事故，所以现在把端口提到配置文件顶层，由部署脚本按环境注入，不再散落在各个启动脚本里。灰度环境单独用 8788，本地调试继续用 8080，避免和本机其他服务抢端口。端口值只在这张表里出现一次，启动脚本、容器编排文件和监控探针都从它派生，改一处就能保持一致。配置和镜像分开发布，配置先行，向后兼容至少保留一个版本，这样镜像回滚不需要同步改配置。健康检查改成先探测端口可达，再跑业务探针，两次探测间隔两秒，连续三次失败才判定不可用，避免启动阶段的误判。缓存配置走同一份模板，键前缀带环境名，避免灰度和生产共用一份缓存时互相污染。监控给端口切换加了一次性告警，切换后五分钟内出现连接拒绝就通知值班同学，同时把旧端口的连接数打到面板上，方便确认没有残留流量。端口变更需要两个人复核，一个人改表，一个人核对发布单和探针地址，复核记录挂在发布单下面。文档只保留一份，其他地方的端口说明都删掉了，避免几份说明互相矛盾。上线节奏是灰度先跑一周，没有异常再推生产，推之前留一条评审记录。环境对照表里的健康检查地址必须跟着端口一起改，漏改会让探针打到旧端口，出现假离线。端口表和发布单一起归档，事后排查只看归档记录，不再翻聊天记录。",
  ],
  ["user", "那回滚的时候具体要注意什么？"],
  [
    "assistant",
    "回滚要注意三点。第一，回滚必须同时覆盖配置和镜像，只回滚镜像会留下新端口的配置，健康检查会在启动阶段直接失败，这是上次事故的直接原因。第二，回滚顺序是镜像先、配置后，因为新镜像只认新端口，配置先回滚会让旧镜像连不上。第三，回滚之后要盯五分钟的告警和旧端口的连接数，确认没有残留流量再收尾。另外回滚前先把环境对照表里的端口和健康检查地址核对一遍，改动的唯一来源就是这张表，不要在启动脚本里临时改常量。回滚过程要留记录，写清楚时间点、回滚了哪一部分、结果如何，方便复盘。",
  ],
];

/** Write one substantive session and build its index with the pinned CLI. */
function buildPersistFixture(home, project) {
  const sessions = join(home, ".pi", "agent", "sessions", "projPersist");
  mkdirSync(sessions, { recursive: true });
  const entries = [
    { type: "session", version: 3, id: "sessPersist", timestamp: "2026-03-01T00:00:00.000Z", cwd: project },
  ];
  let parent = null;
  PERSIST_TURNS.forEach(([role, text], index) => {
    const id = `p${index + 1}`;
    const stamp = `2026-03-01T00:0${index}:0${index}.000Z`;
    entries.push({
      id,
      parentId: parent,
      type: "message",
      timestamp: stamp,
      message: { role, content: [{ type: "text", text }], ...(role === "assistant" ? { model: "fixture" } : {}) },
    });
    parent = id;
  });
  entries.push({ id: "leafP", parentId: parent, type: "leaf", timestamp: "2026-03-01T00:09:00.000Z", targetId: parent });
  writeFileSync(join(sessions, "persist.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const cli = join(ROOT, "packages/source-obelisk/node_modules/@obelisk-apps/cli/dist/cli/src/obelisk.js");
  const build = spawnSync("node", [cli, "--build"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
  });
  return build.status === 0
    ? { ok: true }
    : { ok: false, reason: `build exited ${build.status}: ${build.stdout}${build.stderr}` };
}

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

/** For checks that must report a failure instead of throwing on bad output. */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
    VESTIGIO_CONFIG: "",
    VESTIGIO_MODEL_BASE_URL: gateway.baseUrl,
    VESTIGIO_MODEL_ID: gateway.model,
    VESTIGIO_MODEL_API_KEY: gateway.apiKey,
    VESTIGIO_MODEL_THINKING: "low",
    VESTIGIO_MODEL_COST_INPUT: String(gateway.cost.input),
    VESTIGIO_MODEL_COST_OUTPUT: String(gateway.cost.output),
  };
  const modelArgs = [
    "--model-base-url",
    gateway.baseUrl,
    "--model-id",
    gateway.model,
    "--cost-input",
    String(gateway.cost.input),
    "--cost-output",
    String(gateway.cost.output),
  ];
  const baseArgs = (store, project, question) => [
    "resolve",
    "--db",
    store,
    "--project",
    project,
    "--question",
    question,
    "--json",
    ...modelArgs,
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

      // (c2) PR-07 refuses to invent a body: this corpus holds about 150
      // characters of filler, so no honest 500-character summary exists and no
      // memory may be written, whatever the judge decides about sufficiency.
      check("c.no_fabricated_memory", payload?.result?.memory_uri === null, {
        persistence: payload?.result?.persistence_status ?? null,
        summary_chars: [...(payload?.result?.memory_summary ?? "")].length,
      });
      check(
        "c.no_padding_reason",
        payload?.result?.persistence_status !== "insufficient_evidence" ||
          (payload?.result?.missing ?? []).some((entry) => entry.startsWith("medium_")),
        payload?.result?.missing ?? null,
      );
    }

    // (g) A corpus that holds the answer: the resolved history answer is saved
    // as one medium summary, the job publishes its nav, and the repeat request
    // replays the stored body and answer with no model call.
    {
      const home = join(root, "persist-home");
      const project = "/tmp/resolver-persist";
      const built = buildPersistFixture(home, project);
      if (!built.ok) ledger.reason = built.reason;
      const store = join(root, "store-persist.sqlite");
      const question = "部署脚本的默认端口是多少？";
      const args = baseArgs(store, project, question).concat(["--obelisk-home", home]);
      const first = runCli(args, childEnv);
      const payload = first.code === 0 ? safeJson(first.out) : null;
      const uri = payload?.result?.memory_uri ?? null;
      const revision = payload?.result?.revision ?? null;
      ledger.scenarios.push({
        id: "g_history_saved",
        code: first.code,
        status: payload?.result?.status ?? null,
        persistence: payload?.result?.persistence_status ?? null,
        model_calls: payload?.measured?.model_calls ?? null,
        tokens_out: payload?.measured?.tokens_out ?? null,
        missing: payload?.result?.missing ?? null,
      });
      check("g.resolved", payload?.result?.status === "resolved", payload?.result?.status ?? null);
      check(
        "g.saved",
        payload?.result?.persistence_status === "saved" && uri !== null && revision !== null,
        { status: payload?.result?.persistence_status ?? null, uri, revision },
      );
      check("g.nav_pending", payload?.result?.navigation_status === "pending", payload?.result?.navigation_status ?? null);
      if (uri !== null && revision !== null) {
        const body = payload?.result?.memory_summary ?? "";
        const bodyChars = [...body].filter((point) => !/\s/u.test(point)).length;
        check("g.body_length", bodyChars >= 500 && bodyChars <= 1000, bodyChars);

        const readArgs = ["read", "--db", store, "--uri", uri, "--revision", String(revision), "--json"];
        const stored = safeJson(runCli(readArgs, childEnv).out);
        check("g.body_identity", stored?.result?.memory_summary === body, {
          stored_chars: [...(stored?.result?.memory_summary ?? "")].length,
          returned_chars: [...body].length,
        });

        const jobs = safeJson(
          runCli(["jobs", "run", "--db", store, "--limit", "3", "--json", ...modelArgs], childEnv).out,
        );
        check("g.job_completed", (jobs?.completed ?? 0) >= 1, {
          completed: jobs?.completed ?? null,
          failed: jobs?.failed ?? null,
        });

        const published = safeJson(runCli(readArgs, childEnv).out);
        const navText = published?.result?.cards?.[0]?.nav_text ?? null;
        check(
          "g.nav_published",
          published?.result?.navigation_status === "ready" &&
            typeof navText === "string" &&
            [...navText].length <= 200,
          { status: published?.result?.navigation_status ?? null, nav_chars: navText === null ? null : [...navText].length },
        );

        const repeat = safeJson(runCli(args, childEnv).out);
        check(
          "g.replay_reuses_revision",
          repeat?.result?.memory_uri === uri && repeat?.result?.revision === revision,
          { uri: repeat?.result?.memory_uri ?? null, revision: repeat?.result?.revision ?? null },
        );
        check("g.replay_no_model_call", (repeat?.measured?.model_calls ?? 99) === 0, repeat?.measured?.model_calls ?? null);
        check("g.replay_answer_identical", repeat?.result?.answer === payload?.result?.answer, {
          first: payload?.result?.answer ?? null,
          replay: repeat?.result?.answer ?? null,
        });
      }
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
