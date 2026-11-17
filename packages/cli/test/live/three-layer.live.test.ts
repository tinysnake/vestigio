/**
 * Live three-layer proof: store Active -> store Archived -> Obelisk history.
 *
 * Runs the real CLI (`main`) with the real `@vestigio/source-obelisk` port
 * against a fixture built by `eval/fixtures/obelisk/build_fixture.sh`. The
 * fixture HOME is passed explicitly and the adapter forces `HOME=<home>` on
 * every child, so the operator's `~/.obelisk/obelisk.sqlite` is never opened;
 * its mtime is asserted unchanged around the whole suite.
 *
 * Enable with `VESTIGIO_OBELISK_LIVE=1 pnpm --filter @vestigio/cli test:live`.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { layeredSearch, type LayeredSearchOutcome, type LayerOutcome } from "@vestigio/core/retrieval";
import { openStore } from "@vestigio/core/storage";
import { main } from "../../src/index.js";
import { createObeliskHistoryPort } from "../../src/obelisk-history.js";
import { captureIo, seed, sourceRef, tempDbPath } from "../support.js";
import {
  BASELINE_RUNNER,
  FOREIGN_TEXT,
  OPERATOR_INDEX,
  OTHER_PROJECT_PATH,
  PR01_RECORDED_RUN,
  PROJECT_PATH,
  PROJECT_TEXTS,
  buildFixture,
  indexMtime,
  pinnedEntry,
  type Fixture,
} from "../support/live.js";

const LIVE = process.env["VESTIGIO_OBELISK_LIVE"] === "1";
const TOKEN = "zqleak";
/** The minimum the CLI accepts, so 2 of the 3 fixture messages are clipped. */
const EXCERPT_CAP = 32;

type RunResult = { readonly code: number; readonly out: string; readonly err: string };

let fixture: Fixture;
let dbPath: string;
let operatorMtimeBefore: number | null;

async function run(argv: readonly string[]): Promise<RunResult> {
  const captured = captureIo();
  const code = await main(argv, captured.io);
  return { code, out: captured.stdout(), err: captured.stderr() };
}

/** main() with no injected deps: the real store and the real Obelisk port. */
async function search(argv: readonly string[], query = TOKEN): Promise<LayeredSearchOutcome> {
  const result = await run([
    "search",
    "--db",
    dbPath,
    "--project",
    PROJECT_PATH,
    "--query",
    query,
    "--obelisk-home",
    fixture.manifest.home,
    ...argv,
    "--json",
  ]);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  return JSON.parse(result.out) as LayeredSearchOutcome;
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function chars(text: string): string[] {
  return [...text];
}

function layer(outcome: LayeredSearchOutcome, name: string): LayerOutcome | undefined {
  return outcome.layers.find((entry) => entry.layer === name);
}

/**
 * Ledger lines are printed and, when `VESTIGIO_LIVE_LEDGER` is set, appended to
 * that file so a run's numbers survive vitest's console handling.
 */
function record(line: string): void {
  console.log(line);
  const path = process.env["VESTIGIO_LIVE_LEDGER"];
  if (path !== undefined && path !== "") {
    appendFileSync(path, `${line}\n`, "utf8");
  }
}

function ledger(label: string, outcome: LayeredSearchOutcome, extra: Record<string, unknown> = {}): void {
  record(
    `live-ledger ${label}: ${JSON.stringify({
      status: outcome.result.status,
      elapsed_ms: outcome.result.budget_used.elapsed_ms,
      result_bytes: outcome.measured.result_bytes,
      estimated_tokens: outcome.measured.estimated_tokens,
      cards: outcome.result.cards.length,
      history: outcome.history.length,
      layers: outcome.layers.map((entry) => `${entry.layer}:${entry.status}`),
      ...extra,
    })}`,
  );
}

/** Match a fixture text by its code-point length (all three differ). */
function textOfLength(length: number): string | undefined {
  return PROJECT_TEXTS.find((text) => chars(text).length === length);
}

describe.skipIf(!LIVE)("live: three-layer retrieval against an isolated Obelisk fixture", () => {
  beforeAll(() => {
    fixture = buildFixture();
    operatorMtimeBefore = indexMtime(OPERATOR_INDEX);
    dbPath = tempDbPath("cli-live");
    const sources = [sourceRef({ project_id: PROJECT_PATH, message_id: "seed-medium" })];
    const store = openStore({ path: dbPath });
    try {
      seed(store, {
        memory_id: "mem-live-active",
        scope: { kind: "project", project_id: PROJECT_PATH },
        title: "zqleak 本地活跃笔记",
        nav_text: "本地笔记：zqleak 端口约定，与历史疑问无关。",
        body: seedBody(),
        sources,
      });
      seed(store, {
        memory_id: "mem-live-archived",
        scope: { kind: "project", project_id: PROJECT_PATH },
        state: "archived",
        title: "zqleak 本地归档笔记",
        nav_text: "归档笔记：zqleak 旧的端口约定。",
        body: seedBody(),
        sources,
      });
    } finally {
      store.close();
    }
  });

  afterAll(() => {
    const after = indexMtime(OPERATOR_INDEX);
    record(
      `live-ledger operator-index: ${JSON.stringify({
        path: OPERATOR_INDEX,
        mtime_before: operatorMtimeBefore,
        mtime_after: after,
        unchanged: operatorMtimeBefore === after,
        fixture_home: fixture.manifest.home,
        fixture_index: fixture.manifest.index,
        fixture_index_bytes: fixture.manifest.index_bytes,
      })}`,
    );
    expect(fixture.manifest.home.startsWith(tmpdir())).toBe(true);
    expect(fixture.manifest.home).not.toBe(homedir());
    expect(fixture.manifest.index).not.toBe(OPERATOR_INDEX);
    expect(fixture.manifest.index_bytes).toBeGreaterThan(0);
    expect(after).toBe(operatorMtimeBefore);
    fixture.cleanup();
  });

  it("keeps the default ranking on Active only and never calls history", async () => {
    const outcome = await search([]);
    ledger("default", outcome);
    expect(outcome.result.cards.map((card) => card.memory_id)).toEqual(["mem-live-active"]);
    expect(layer(outcome, "active")?.status).toBe("matched");
    expect(layer(outcome, "archived")?.status).toBe("skipped");
    expect(layer(outcome, "history")?.status).toBe("skipped");
    expect(layer(outcome, "history")?.reason).toBe("not_requested");
    expect(outcome.history).toEqual([]);
    expect(outcome.result.evidence.length).toBe(1);
    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.budget_used.model_calls).toBe(0);
    expect(outcome.result.next_action).toBe("widen:archived");
  });

  it("reaches Archived on explicit widening even with Active candidates present", async () => {
    const outcome = await search(["--archived"]);
    ledger("widened-archived", outcome);
    expect(outcome.result.cards.map((card) => card.memory_id)).toEqual([
      "mem-live-active",
      "mem-live-archived",
    ]);
    expect(layer(outcome, "archived")?.status).toBe("matched");
    expect(layer(outcome, "archived")?.reason).toBe("explicit");
    expect(layer(outcome, "archived")?.candidates).toBe(1);
    expect(outcome.measured.archived_cards).toBe(1);
    expect(outcome.result.next_action).toBe("widen:history");
  });

  it("returns bounded history excerpts whose SourceRefs resolve to fixture messages", async () => {
    const outcome = await search(["--archived", "--history"]);
    ledger("three-layer", outcome, { history_available: outcome.measured.history_available });
    const history = layer(outcome, "history");
    expect(history?.status).toBe("matched");
    expect(history?.evidence).toBe("ids_only");
    expect(history?.candidates).toBe(3);
    expect(history?.emitted).toBe(3);
    expect(history?.read).toBe(false);
    expect(outcome.measured.history_available).toBe(true);
    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.budget_used.model_calls).toBe(0);

    const excerpts = outcome.history.map((entry) => entry.excerpt).sort();
    expect(excerpts).toEqual([...PROJECT_TEXTS].sort());
    for (const entry of outcome.history) {
      expect(entry.truncated).toBe(false);
      expect(entry.via).toBe("search");
      expect(entry.excerpt_char_count).toBe(chars(entry.excerpt).length);
      expect(entry.full_char_count).toBe(entry.excerpt_char_count);
      expect(entry.source_ref.provider.length).toBeGreaterThan(0);
      expect(entry.source_ref.project_id).toBe(PROJECT_PATH);
      expect(entry.source_ref.message_id.length).toBeGreaterThan(0);
      expect(entry.source_ref.content_hash).toBe(sha256(entry.excerpt));
      expect(entry.evidence_complete).toBe(false);
      expect(entry.project_resolved).toBe(true);
    }
    expect(outcome.result.evidence).toHaveLength(4);
    expect(outcome.result.evidence.every((ref) => ref.project_id === PROJECT_PATH)).toBe(true);

    // No crossover into the sibling project, in the rendered output or in any ref.
    const rendered = JSON.stringify(outcome);
    expect(rendered).not.toContain(FOREIGN_TEXT);
    expect(rendered).not.toContain(OTHER_PROJECT_PATH);
  });

  it("truncates excerpts at the asked-for cap with a marker", async () => {
    const outcome = await search(["--history", "--history-excerpt-chars", String(EXCERPT_CAP)]);
    ledger("truncated", outcome, { cap: EXCERPT_CAP });
    expect(outcome.history.length).toBe(3);
    for (const entry of outcome.history) {
      const full = textOfLength(entry.full_char_count);
      expect(full, `no fixture text of ${entry.full_char_count} code points`).toBeDefined();
      const head = chars(full as string).slice(0, EXCERPT_CAP).join("");
      if (chars(full as string).length > EXCERPT_CAP) {
        const omitted = chars(full as string).length - EXCERPT_CAP;
        expect(entry.truncated).toBe(true);
        expect(entry.excerpt).toBe(`${head}…[truncated ${omitted} more characters]`);
        expect(entry.truncation_marker).toBe(`…[truncated ${omitted} more characters]`);
      } else {
        expect(entry.truncated).toBe(false);
        expect(entry.excerpt).toBe(full);
      }
      expect(entry.excerpt.startsWith(head)).toBe(true);
    }
    expect(outcome.measured.result_bytes).toBeLessThan(65536);
  });

  it("runs one bounded read-by-anchor through the CLI when asked to widen that far", async () => {
    const outcome = await search(["--history", "--history-read"]);
    ledger("history-read", outcome);
    expect(layer(outcome, "history")?.status).toBe("matched");
    expect(layer(outcome, "history")?.read).toBe(true);
    expect(outcome.result.missing).toEqual([]);
    expect(outcome.history.length).toBeLessThanOrEqual(3);
    for (const entry of outcome.history) {
      expect(entry.source_ref.project_id).toBe(PROJECT_PATH);
    }
    expect(outcome.measured.result_bytes).toBeLessThan(65536);
  });

  it("searches and reads by anchor through the port with resolvable refs", async () => {
    const port = createObeliskHistoryPort({ home: fixture.manifest.home, source_instance: "fixture" });
    const probe = await port.probe();
    expect(probe.available).toBe(true);
    expect(probe.reason).toBeNull();

    const found = await port.search({ text: TOKEN, project_path: PROJECT_PATH, limit: 3 });
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error(`search failed: ${found.status} ${found.reason}`);
    expect(found.value.hits.length).toBe(3);
    expect(found.value.evidence).toBe("ids_only");
    for (const hit of found.value.hits) {
      expect(hit.source_ref.project_id).toBe(PROJECT_PATH);
      expect(PROJECT_TEXTS).toContain(hit.text);
      expect(hit.source_ref.content_hash).toBe(sha256(hit.text));
      expect(hit.project_resolved).toBe(true);
    }

    const top = found.value.hits[0];
    if (top === undefined) throw new Error("no hits");
    const read = await port.readByAnchor({ anchor: top.source_ref.message_id, before: 2 });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(`read failed: ${read.status} ${read.reason}`);
    expect(read.value.messages.length).toBeGreaterThanOrEqual(1);
    expect(read.value.messages.length).toBeLessThanOrEqual(3);
    expect(read.value.has_more).toBe(false);
    expect(read.value.anchor.message_id).toBe(top.source_ref.message_id);
    for (const message of read.value.messages) {
      expect(message.source_ref.project_id).toBe(PROJECT_PATH);
      expect(PROJECT_TEXTS).toContain(message.text);
      expect(message.source_ref.content_hash).toBe(sha256(message.text));
      expect(message.source_ref.locator ?? "").toContain("sessA.jsonl#");
      expect((message.source_ref.locator ?? "").endsWith(message.source_ref.message_id)).toBe(true);
    }
    record(
      `live-ledger port-read: ${JSON.stringify({
        anchor: top.source_ref.message_id.slice(-24),
        messages: read.value.messages.length,
        elapsed_ms: read.value.elapsed_ms,
        pinned_cli: pinnedEntry().endsWith("dist/cli/src/obelisk.js"),
      })}`,
    );
  });

  it("compares the zero-LLM layered path against the PR-01 direct Obelisk search", async () => {
    const question = "zqleak alpha";
    const outDir = join(fixture.manifest.home, "baseline-out");
    mkdirSync(outDir, { recursive: true });
    const wrapper = join(fixture.manifest.home, "obelisk-bin");
    writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(pinnedEntry())} "$@"\n`, "utf8");
    chmodSync(wrapper, 0o755);

    const baseline = spawnSync(
      process.execPath,
      [BASELINE_RUNNER, "--question", question, "--mode", "obelisk", "--out", outDir, "--obelisk-bin", wrapper],
      { encoding: "utf8", env: { ...process.env, HOME: fixture.manifest.home }, timeout: 300000 },
    );
    expect(baseline.status).toBe(0);
    const ledger = JSON.parse(readFileSync(join(outDir, "latest.json"), "utf8")) as {
      runs: { mode: string; status: string; elapsed_ms: number; bytes: number | null; token_estimate: number | null; evidence_count: number | null }[];
    };
    const pr01Fixture = ledger.runs.find((entry) => entry.mode === "obelisk");
    expect(pr01Fixture?.status).toBe("ok");
    const pr01Recorded = JSON.parse(readFileSync(PR01_RECORDED_RUN, "utf8")) as typeof ledger;
    const pr01RealIndex = pr01Recorded.runs.find((entry) => entry.mode === "obelisk");

    const store = openStore({ path: dbPath });
    try {
      const scope = { kind: "project", project_id: PROJECT_PATH } as const;
      const port = createObeliskHistoryPort({ home: fixture.manifest.home, source_instance: "fixture" });

      const base = await layeredSearch({ store, query: "zqleak", scope });
      const three = await layeredSearch({
        store,
        query: question,
        scope,
        include_archived: true,
        include_history: true,
        history: port,
      });

      expect(base.result.budget_used.model_calls).toBe(0);
      expect(three.result.budget_used.model_calls).toBe(0);
      expect(three.measured.history_available).toBe(true);
      expect(three.measured.result_bytes).toBeLessThan(pr01Fixture?.bytes ?? 0);

      record(
        `live-ledger comparison: ${JSON.stringify({
          question,
          pr01_fixture: {
            status: pr01Fixture?.status,
            elapsed_ms: pr01Fixture?.elapsed_ms,
            bytes: pr01Fixture?.bytes,
            tokens: pr01Fixture?.token_estimate,
            evidence_count: pr01Fixture?.evidence_count,
          },
          pr01_recorded_real_index: {
            elapsed_ms: pr01RealIndex?.elapsed_ms,
            bytes: pr01RealIndex?.bytes,
            tokens: pr01RealIndex?.token_estimate,
            evidence_count: pr01RealIndex?.evidence_count,
          },
          pr04_base_medium: {
            elapsed_ms: base.result.budget_used.elapsed_ms,
            bytes: base.measured.result_bytes,
            tokens: base.measured.estimated_tokens,
            cards: base.result.cards.length,
          },
          pr04_three_layer: {
            elapsed_ms: three.result.budget_used.elapsed_ms,
            bytes: three.measured.result_bytes,
            tokens: three.measured.estimated_tokens,
            cards: three.result.cards.length,
            history: three.history.length,
          },
        })}`,
      );
    } finally {
      store.close();
    }
  });

  it("reports nothing found when neither the store nor history matches", async () => {
    const outcome = await search(["--history"], "no-such-token-zzz");
    ledger("not-found", outcome);
    expect(outcome.result.status).toBe("not_found");
    expect(outcome.result.cards).toEqual([]);
    expect(layer(outcome, "active")?.status).toBe("empty");
    expect(layer(outcome, "archived")?.reason).toBe("fall_through");
    expect(layer(outcome, "history")?.status).toBe("empty");
    expect(layer(outcome, "history")?.candidates).toBe(0);
    expect(outcome.result.missing).toEqual([]);
    expect(outcome.result.next_action).toBeNull();
    expect(outcome.result.budget_used.model_calls).toBe(0);
  });
});

/** The padded medium body the CLI live store seeds (>=520 non-whitespace cp). */
function seedBody(): string {
  return `zqleak 本地笔记正文：默认端口配置在部署脚本里。${"补充说明部署步骤与回滚方式。".repeat(40)}`;
}
