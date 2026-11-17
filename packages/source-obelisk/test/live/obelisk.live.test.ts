/**
 * Live suite: the real pinned CLI against an isolated index.
 *
 * Gated on `VESTIGIO_OBELISK_LIVE=1` so `pnpm test` stays hermetic. Every test
 * here spawns the pinned 0.3.2 CLI with `HOME` pointing inside a temp fixture
 * built by `eval/fixtures/obelisk/build_fixture.sh`; the operator's
 * `~/.obelisk` is never addressed.
 *
 * The commands and their output are printed as the suite runs, which is what
 * makes these assertions reviewable rather than just green.
 */

import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isObeliskError } from "../../src/errors.js";
import { ObeliskSource, OBELISK_VERSION } from "../../src/index.js";
import {
  buildFixture,
  copyFixture,
  pinnedEntry,
  QUERIES,
  rewriteMessageText,
  runCli,
  runQuery,
  type Fixture,
} from "../support/live.js";

const LIVE = process.env["VESTIGIO_OBELISK_LIVE"] === "1";

type Row = {
  uuid: string;
  session_id: string;
  parent_uuid: string | null;
  text: string;
  visibility: string;
  is_meta: number;
};

type LeakRow = { uuid: string; project: string; cwd: string };

function say(label: string, detail: unknown): void {
  console.log(`[live] ${label}: ${JSON.stringify(detail)}`);
}

describe.skipIf(!LIVE)("obelisk live — isolated fixture", () => {
  let fixture: Fixture;
  let home: string;
  let source: ObeliskSource;
  let rows: Row[];

  beforeAll(() => {
    fixture = buildFixture();
    home = fixture.manifest.home;
    source = new ObeliskSource({ home, source_instance: "fixture" });
    rows = runQuery<Row[]>(home, QUERIES.rows);
    say("fixture", {
      home,
      index_bytes: fixture.manifest.index_bytes,
      cli_version: fixture.manifest.cli_version,
      cli_entry: pinnedEntry(),
      build_ms: fixture.manifest.build_ms,
    });
    say("rows", rows.map((row) => ({ uuid: row.uuid.slice(-24), text: row.text, visibility: row.visibility, is_meta: row.is_meta })));
  });

  afterAll(() => {
    fixture?.cleanup();
  });

  it("probes the pinned release as available", async () => {
    const probe = await source.probe();
    say("probe", {
      available: probe.available,
      reason: probe.reason,
      reported: probe.cli.reported_version,
      declared: probe.cli.declared_version,
      index_present: probe.data.index_present,
    });
    expect(probe.available).toBe(true);
    expect(probe.cli.reported_version).toBe(OBELISK_VERSION);
    expect(probe.capabilities?.exact_project_path).toBe(true);
  });

  it("scopes to one project exactly, and the LIKE pattern the probe found leaks across both", async () => {
    const scoped = await source.search({ text: "zqleak", project_path: "/tmp/x_a" });
    const other = await source.search({ text: "zqleak", project_path: "/tmp/x-a" });
    const direct = runCli(home, ["--search", "zqleak", "--limit", "20", "--context-limit", "0", "--project-path", "/tmp/x_a"]);
    const leak = runQuery<LeakRow[]>(home, QUERIES.leak);

    say("--search --project-path /tmp/x_a", { hits: scoped.hits.length, projects: [...new Set(scoped.hits.map((h) => h.source_ref.project_id))], ms: Math.round(scoped.timing.total_ms) });
    say("--search --project-path /tmp/x-a", { hits: other.hits.length, projects: [...new Set(other.hits.map((h) => h.source_ref.project_id))] });
    say("LIKE evidence (sql project='-tmp-x_a')", { hits: leak.length, projects: [...new Set(leak.map((row) => row.project))] });

    expect(scoped.hits).toHaveLength(3);
    expect(new Set(scoped.hits.map((hit) => hit.source_ref.project_id))).toEqual(new Set(["/tmp/x_a"]));
    expect(scoped.hits.every((hit) => hit.source_ref.locator === null)).toBe(true);
    expect(scoped.evidence).toBe("ids_only");

    expect(other.hits).toHaveLength(1);
    expect(other.hits[0]?.source_ref.project_id).toBe("/tmp/x-a");

    // Unscoped: the CLI gives no project_path, so the identity is the derived
    // slug and the hit says it is not exact instead of inventing a path.
    const unscoped = await source.search({ text: "zqleak" });
    say("--search zqleak (unscoped)", {
      hits: unscoped.hits.length,
      projects: [...new Set(unscoped.hits.map((hit) => hit.source_ref.project_id))],
      project_resolved: [...new Set(unscoped.hits.map((hit) => hit.project_resolved))],
    });
    expect(unscoped.hits).toHaveLength(4);
    expect(new Set(unscoped.hits.map((hit) => hit.source_ref.project_id))).toEqual(
      new Set(["-tmp-x_a", "-tmp-x-a"]),
    );
    expect(unscoped.hits.every((hit) => hit.project_resolved === false)).toBe(true);
    expect(scoped.hits.every((hit) => hit.project_resolved)).toBe(true);

    // The CLI itself is exact on this fixture...
    expect(JSON.parse(direct.stdout)).toHaveLength(3);
    // ...while the slug-as-LIKE filter returns a row from the other project.
    expect(leak).toHaveLength(4);
    expect(new Set(leak.map((row) => row.project))).toEqual(new Set(["-tmp-x_a", "-tmp-x-a"]));
    expect(leak.some((row) => scoped.hits.some((hit) => hit.source_ref.message_id === row.uuid))).toBe(true);
  });

  it("hides the inactive branch by default and shows it only when asked", async () => {
    const by_default = await source.search({ text: "abandoned branch", project_path: "/tmp/x_a" });
    const with_inactive = await source.search({
      text: "abandoned branch",
      project_path: "/tmp/x_a",
      include_inactive: true,
    });

    say("inactive", {
      default_hits: by_default.hits.length,
      include_inactive_hits: with_inactive.hits.length,
      evidence: with_inactive.evidence,
    });

    expect(by_default.hits).toEqual([]);
    expect(with_inactive.hits).toHaveLength(1);
    expect(with_inactive.hits[0]?.text).toContain("abandoned branch");
    expect(with_inactive.evidence).toBe("resolved");
  });

  it("never returns the hidden row, by search or by read", async () => {
    const hidden = rows.find((row) => row.text.includes("hidden marker"));
    expect(hidden).toBeDefined();
    expect(hidden?.visibility).toBe("hidden");

    const searched = await source.search({
      text: "hidden marker",
      include_meta: true,
      include_inactive: true,
    });

    const read = await source.read({ anchor: hidden!.uuid }).then(
      () => "resolved",
      (error: unknown) => (isObeliskError(error) ? error.kind : String(error)),
    );

    say("hidden row", { uuid: hidden?.uuid, stored_visibility: hidden?.visibility, search_hits: searched.hits.length, read: read });

    expect(searched.hits).toEqual([]);
    expect(read).toBe("message_not_visible");
  });

  it("resolves the causal parent path, not just the timeline", async () => {
    const a3 = rows.find((row) => row.text.includes("second user message"));
    const a1 = rows.find((row) => row.text.includes("first user message"));

    const parents = await source.read({ anchor: a3!.uuid, relation: "parents", before: 5, after: 0 });
    const timeline = await source.read({ anchor: a3!.uuid, before: 1, after: 0 });
    const rejected = await source.read({ anchor: a3!.uuid, relation: "parents", after: 1 }).then(
      () => "accepted",
      (error: unknown) => (isObeliskError(error) ? error.kind : String(error)),
    );

    say("read relation=parents", {
      ids: parents.messages.map((row) => row.source_ref.message_id.slice(-18)),
      parents: parents.messages.map((row) => row.source_ref.parent_message_id?.slice(-18) ?? null),
      seconds: parents.timing.total_ms / 1000,
    });
    say("read relation=timeline before=1", { ids: timeline.messages.map((row) => row.source_ref.message_id.slice(-18)) });
    say("read relation=parents after=1", { result: rejected });

    expect(parents.messages.map((row) => row.source_ref.message_id)).toEqual([a1!.uuid, expect.any(String), a3!.uuid]);
    expect(parents.messages[0]?.source_ref.parent_message_id).toBeNull();
    expect(parents.messages[1]?.source_ref.parent_message_id).toBe(a1!.uuid);
    expect(parents.messages[2]?.source_ref.parent_message_id).toBe(parents.messages[1]?.source_ref.message_id);
    expect(parents.anchor.message_id).toBe(a3!.uuid);
    expect(timeline.messages).toHaveLength(2);
    expect(rejected).toBe("unsupported_option");
    expect(parents.timing.total_ms).toBeGreaterThan(3_000); // the pinned --query nonce wait
  });

  it("re-verifies a SourceRef after a rebuild, and detects text that changed under a stable id", async () => {
    const copy = copyFixture(fixture);
    try {
      const before = await new ObeliskSource({ home: copy.manifest.home, source_instance: "fixture" }).search({
        text: "zqleak alpha first user message",
      });
      const original = before.hits[0]!;

      const rebuild = runCli(copy.manifest.home, ["--build"]);
      const after = await new ObeliskSource({ home: copy.manifest.home, source_instance: "fixture" }).search({
        text: "zqleak alpha first user message",
      });
      const re_derived = after.hits[0]!;

      say("rebuild", {
        rebuild_exit: rebuild.status,
        rebuild_ms: Math.round(rebuild.ms),
        message_id_stable: original.source_ref.message_id === re_derived.source_ref.message_id,
        content_hash_stable: original.source_ref.content_hash === re_derived.source_ref.content_hash,
      });

      expect(re_derived.source_ref.message_id).toBe(original.source_ref.message_id);
      expect(re_derived.source_ref.content_hash).toBe(original.source_ref.content_hash);
      expect(re_derived.source_ref.locator).toBe(original.source_ref.locator);

      rewriteMessageText(copy.manifest.home, "zqleak alpha first user message", "zqleak alpha first user message v2");
      const rewrite_build = runCli(copy.manifest.home, ["--build"]);
      const rewritten = await new ObeliskSource({ home: copy.manifest.home, source_instance: "fixture" }).search({
        text: "zqleak alpha first user message v2",
      });
      const changed = rewritten.hits[0]!;

      say("rebuild after rewrite", {
        rebuild_exit: rewrite_build.status,
        same_message_id: changed.source_ref.message_id === original.source_ref.message_id,
        content_hash_changed: changed.source_ref.content_hash !== original.source_ref.content_hash,
      });

      expect(changed.source_ref.message_id).toBe(original.source_ref.message_id);
      expect(changed.source_ref.content_hash).not.toBe(original.source_ref.content_hash);
    } finally {
      copy.cleanup();
    }
  });

  it("reports an empty index as unavailable, never as no results", async () => {
    const empty_home = mkdtempSync(join(tmpdir(), "vestigio-live-empty-"));
    try {
      const empty_source = new ObeliskSource({ home: empty_home });
      const probe = await empty_source.probe();
      const searched = await empty_source.search({ text: "zqleak" }).then(
        () => "resolved",
        (error: unknown) => (isObeliskError(error) ? error.kind : String(error)),
      );
      say("empty home", { available: probe.available, reason: probe.reason, search: searched });
      expect(probe.available).toBe(false);
      expect(probe.reason).toBe("index_missing");
      expect(searched).toBe("index_missing");
    } finally {
      rmSync(empty_home, { recursive: true, force: true });
    }
  });

  it("keeps same-timestamp messages distinct and stably ordered", async () => {
    const own = buildFixture();
    try {
      const home = own.manifest.home;
      const transcript = join(home, ".pi/agent/sessions/projA/sessT.jsonl");
      const stamp = "2026-01-01T00:02:00.000Z";
      const rows = [
        { type: "session", version: 3, id: "sessT", timestamp: stamp, cwd: "/tmp/x_a" },
        {
          id: "t1",
          parentId: null,
          type: "message",
          timestamp: stamp,
          message: { role: "user", content: [{ type: "text", text: "zqleak twin timestamp one" }] },
        },
        {
          id: "t2",
          parentId: "t1",
          type: "message",
          timestamp: stamp,
          message: { role: "assistant", model: "probe-model", content: [{ type: "text", text: "zqleak twin timestamp two" }] },
        },
        { id: "leafT", parentId: "t2", type: "leaf", timestamp: stamp, targetId: "t2" },
      ];
      writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

      const build = runCli(home, ["--build"]);
      expect(build.status).toBe(0);

      const source = new ObeliskSource({ home, source_instance: "live" });
      const first = await source.search({ text: "zqleak", project_path: "/tmp/x_a" });
      const twins = first.hits.filter((hit) => hit.text.includes("twin timestamp"));
      const second = await source.search({ text: "zqleak", project_path: "/tmp/x_a" });
      const twins_again = second.hits.filter((hit) => hit.text.includes("twin timestamp"));

      say("same timestamp", {
        hits: twins.length,
        timestamps: [...new Set(twins.map((hit) => hit.timestamp))],
        ids: twins.map((hit) => hit.source_ref.message_id.split(":").slice(3, 6).join(":")),
        order_stable: twins.map((hit) => hit.source_ref.message_id).join("|") ===
          twins_again.map((hit) => hit.source_ref.message_id).join("|"),
      });

      // Two messages, one instant: the id has to separate them, and repeated
      // queries must not reshuffle them.
      expect(twins).toHaveLength(2);
      expect(new Set(twins.map((hit) => hit.timestamp)).size).toBe(1);
      expect(new Set(twins.map((hit) => hit.source_ref.message_id)).size).toBe(2);
      expect(twins.map((hit) => hit.source_ref.message_id)).toEqual(
        twins_again.map((hit) => hit.source_ref.message_id),
      );
    } finally {
      own.cleanup();
    }
  });

  it("re-verifies a SourceRef after its source file moves", async () => {
    const own = buildFixture();
    try {
      const home = own.manifest.home;
      const rows = runQuery<Row[]>(home, QUERIES.rows);
      const anchor = rows.find((row) => row.text === "zqleak alpha first user message")?.uuid;
      if (anchor === undefined) throw new Error("fixture has no alpha first message");

      const source = new ObeliskSource({ home, source_instance: "live" });
      const before = await source.read({ anchor });
      const old_locator = before.anchor.locator;
      expect(old_locator).toContain("sessA.jsonl");

      const from = join(home, ".pi/agent/sessions/projA/sessA.jsonl");
      const to = join(home, ".pi/agent/sessions/projA/sessA-moved.jsonl");
      renameSync(from, to);
      const build = runCli(home, ["--build"]);
      expect(build.status).toBe(0);

      const after = await source.read({ anchor });
      say("source moved", {
        message_id_stable: after.anchor.message_id === anchor,
        content_hash_stable:
          after.anchor.content_hash === before.anchor.content_hash,
        locator_before: old_locator,
        locator_after: after.anchor.locator,
      });

      // The id and the content hash survive; the locator has to follow the file,
      // or the evidence would point at a path that no longer exists.
      expect(after.anchor.message_id).toBe(anchor);
      expect(after.anchor.content_hash).toBe(before.anchor.content_hash);
      expect(after.anchor.locator).toBe(`${to}#${anchor}`);
      expect(existsSync(from)).toBe(false);
    } finally {
      own.cleanup();
    }
  });

  it("adds under 100 ms at p95 over a direct CLI call", async () => {
    const args = ["--search", "zqleak", "--limit", "20", "--context-limit", "0", "--project-path", "/tmp/x_a"];
    const samples: { adapter: number; direct: number; overhead: number; internal: number }[] = [];

    // Warm both paths once so neither pays the first query-index refresh.
    await source.search({ text: "zqleak", project_path: "/tmp/x_a" });
    runCli(home, args);

    // The order alternates: whichever call runs second would otherwise collect
    // any warmth left by the first, and that bias would land on the adapter.
    const RUNS = 41;
    for (let i = 0; i < RUNS; i += 1) {
      const directFirst = i % 2 === 0;
      let direct_ms = 0;
      if (directFirst) direct_ms = runCli(home, args).ms;

      const started = performance.now();
      const result = await source.search({
        text: "zqleak",
        project_path: "/tmp/x_a",
        limit: 20,
        context_limit: 0,
      });
      const adapter_ms = performance.now() - started;
      const internal_ms = result.timing.total_ms - result.timing.child_ms;

      if (!directFirst) direct_ms = runCli(home, args).ms;
      samples.push({
        adapter: adapter_ms,
        direct: direct_ms,
        overhead: adapter_ms - direct_ms,
        internal: internal_ms,
      });
    }

    const quantile = (values: number[], q: number): number => {
      const sorted = [...values].sort((a, b) => a - b);
      const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
      return sorted[index] ?? 0;
    };
    const round = (value: number): number => Math.round(value * 100) / 100;
    const direct = samples.map((sample) => sample.direct);
    const adapter = samples.map((sample) => sample.adapter);
    const overhead = samples.map((sample) => sample.overhead);
    const internal = samples.map((sample) => sample.internal);
    const summary = {
      samples: samples.length,
      direct_median_ms: round(quantile(direct, 0.5)),
      direct_p95_ms: round(quantile(direct, 0.95)),
      adapter_median_ms: round(quantile(adapter, 0.5)),
      adapter_p95_ms: round(quantile(adapter, 0.95)),
      overhead_median_ms: round(quantile(overhead, 0.5)),
      overhead_p90_ms: round(quantile(overhead, 0.9)),
      overhead_p95_ms: round(quantile(overhead, 0.95)),
      overhead_min_ms: round(Math.min(...overhead)),
      overhead_max_ms: round(Math.max(...overhead)),
      adapter_internal_median_ms: round(quantile(internal, 0.5)),
      adapter_internal_p95_ms: round(quantile(internal, 0.95)),
    };
    say("overhead (adapter search minus the same direct --search, alternating order)", summary);

    expect(summary.overhead_p95_ms).toBeLessThan(100);
    expect(summary.adapter_internal_p95_ms).toBeLessThan(100);
  });
})
;
