/**
 * Every write the daemon performs, in one place.
 *
 * The daemon runs at most one maintenance job at a time; that single slot is the
 * serialization boundary for all shared memory state. So this module holds the
 * only code that writes: stale publication (agent and detector alike), resolve
 * persistence, nav publication, repair, request intake and processing, hotspot
 * admission and usage accounting. A read or a detector reports these as
 * dependencies instead of calling them.
 *
 * Two of them need a follow-up inside the same boundary — a persisted resolve
 * still needs its nav published, a detector publication still needs its events
 * acknowledged — and those are expressed as `inline` dependencies, legal only
 * because the caller is already the maintenance slot.
 */

import {
  splitMemoryUri,
  type Freshness,
  type MemoryId,
  type MemoryUri,
  type Revision,
  type Scope,
  type StaleEventSummary,
} from "@vestigio/core";
import {
  InjectionLedger,
  commitInjection,
  planInjection,
  recordMemoryRead,
  recordProjectInput,
  recordSearchHits,
  type CommitResult,
  type InjectionPlan,
} from "@vestigio/core/hotspots";
import { runDueJobs, type RunDueJobsOutcome } from "@vestigio/core/jobs";
import { MEMORY_REQUEST_RETRY_MS, composeMemoryRequest, type MemoryRequest } from "@vestigio/core/requests";
import { persistPendingResolve, repairStaleMemory, type PendingResolvePersistence, type RepairOutcome } from "@vestigio/core/resolver";
import type { MemoryStore } from "@vestigio/core/storage";
import {
  asRecord,
  optionalInteger,
  optionalString,
  requireRecordArray,
  requireString,
  type MemoryJobInput,
} from "./contract.js";
import { dependency, outcome, parseSourceRef, stringArray, type DependencyRequest, type OpContext, type OpOutcome } from "./internal.js";
import { unanchoredValues } from "./render.js";

/** Hard ceiling for one repair attempt; matches the extension's measured tail. */
export const BACKGROUND_REPAIR_MAX_MEMORIES = 3;
export const BACKGROUND_REPAIR_MAX_ATTEMPTS = 2;
const REQUEST_BATCH_LIMIT = 2;
const REQUEST_NAV_LIMIT = 2;

export async function runMaintenanceOp(input: MemoryJobInput, ctx: OpContext): Promise<OpOutcome> {
  switch (input.op) {
    case "stale.publish":
      return publishStale(input, ctx);
    case "resolve.persist":
      return persistResolve(input, ctx);
    case "nav.run":
      return navRun(input, ctx);
    case "repair.memory":
      return repairOne(input, ctx);
    case "repair.memories":
      return repairMany(input, ctx);
    case "request.write":
      return requestWrite(input, ctx);
    case "request.process":
      return requestProcess(input, ctx);
    case "hotspot.commit":
      return hotspotCommit(input, ctx);
    case "session.input":
      return sessionInput(input, ctx);
    case "usage.search_hits":
      return usageSearchHits(input, ctx);
    case "usage.memory_read":
      return usageMemoryRead(input, ctx);
    default:
      throw new Error(`operation ${input.op} is not a maintenance operation`);
  }
}

/* ----------------------------------------------------------------- stale */

function publishStale(input: MemoryJobInput, ctx: OpContext): OpOutcome {
  const rows = requireRecordArray(input, "events", 128);
  const at = optionalString(input, "at", 64) ?? ctx.runtime.timestamp();
  const entries: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  for (const row of rows) {
    const memory_id = requireString(row, "memory_id", 256);
    const observed_revision = optionalInteger(row, "observed_revision", 0, Number.MAX_SAFE_INTEGER);
    const reason = requireString(row, "reason", 4096);
    const excerpt = requireString(row, "excerpt", 200_000);
    if (observed_revision === undefined) throw new Error("stale.publish event requires observed_revision");
    const producer = row["producer"] === "detector" ? "detector" : "agent";
    const sourceRows = Array.isArray(row["sources"]) ? (row["sources"] as unknown[]) : [];
    const sources = sourceRows.map((source) => parseSourceRef(source, ctx.project_id));
    if (sources.length === 0) {
      entries.push({ memory_id, recorded: false, reason: "no_sources" });
      continue;
    }
    const unanchored = unanchoredValues(reason, excerpt);
    if (unanchored !== null) {
      entries.push({ memory_id, recorded: false, reason: `unanchored:${unanchored.join(",")}` });
      continue;
    }
    const branch_ref = optionalString(row, "branch_ref", 1024) ?? null;
    const result = ctx.runtime.store.markStale({
      memory_id: memory_id as MemoryId,
      observed_revision: observed_revision as Revision,
      reason,
      excerpt,
      sources,
      producer,
      at,
      branch_ref,
    });
    const freshness = ctx.runtime.store.readFreshness(memoryUriFor(ctx.runtime.store, memory_id), observed_revision as Revision);
    entries.push({
      memory_id,
      recorded: true,
      inserted: result.inserted,
      event_id: result.event.event_id,
      revision_mismatch: freshness?.revision_mismatch ?? false,
      freshness,
    });
    lines.push(
      `stale.publish(${memory_id}) -> ${result.inserted ? "recorded" : "already recorded"}`,
      `event: ${result.event.event_id} observed r${result.event.observed_revision} producer=${result.event.producer}`,
    );
  }
  const repairIds = entries.filter((entry) => entry.recorded === true).map((entry) => entry.memory_id);
  const projectId = optionalString(input, "project_id", 1024) ?? ctx.project_id;
  return outcome({
    result: { status: "ok", events: entries, inserted: entries.filter((entry) => entry["inserted"] === true).length },
    deferred: input.repair === true && projectId && repairIds.length ? [dependency("repair.memories", {
      op: "repair.memories", project_id: projectId, memory_ids: repairIds, turn_leaf: input.turn_leaf,
    }, { inline: false })] : [],
    text: lines.length === 0 ? "stale.publish -> no events" : lines.join("\n"),
    notes: entries.some((entry) => entry["recorded"] === false) ? ["some events were rejected by the guard"] : [],
  });
}

/* ------------------------------------------------------------- persistence */

async function persistResolve(input: MemoryJobInput, ctx: OpContext): Promise<OpOutcome> {
  const model = ctx.runtime.model;
  if (model === null) {
    return outcome({ result: { status: "missing", reason: "model_not_configured" }, notes: ["no model configured"] });
  }
  const request = parsePendingPersistence(input["request"]);
  const persisted = await persistPendingResolve({
    store: ctx.runtime.store,
    model,
    model_id: ctx.runtime.model_id,
    request,
    signal: ctx.signal,
    wall_now: ctx.runtime.now,
    mono_now: ctx.runtime.mono,
  });
  const deferred: DependencyRequest[] = [];
  const patch = persisted.patch;
  if (patch.memory_uri !== null && patch.revision !== null && patch.navigation_status === "pending") {
    deferred.push(
      dependency(
        "nav.run",
        { op: "nav.run", memory_id: splitMemoryUri(patch.memory_uri).memoryId, revision: patch.revision, limit: 1 },
        { inline: true, key: `nav.run:${patch.memory_uri}:${patch.revision}` },
      ),
    );
  }
  return outcome({
    result: {
      status: persisted.patch.persistence_status,
      persistence_status: patch.persistence_status,
      navigation_status: patch.navigation_status,
      memory_uri: patch.memory_uri,
      revision: patch.revision,
      missing: persisted.missing,
      call: persisted.call,
      request_id: request.request_id ?? null,
    },
    deferred,
    notes: ["resolve persistence ran in the maintenance slot"],
  });
}

function parsePendingPersistence(value: unknown): PendingResolvePersistence {
  const record = asRecord(value, "request");
  const question = requireString(record, "question", 4096);
  const answer = requireString(record, "answer", 200_000);
  const scope = parseScope(record["scope"]);
  const cards = Array.isArray(record["cards"]) ? record["cards"] : [];
  const evidence = Array.isArray(record["evidence"]) ? record["evidence"] : [];
  const excerpts = Array.isArray(record["excerpts"]) ? record["excerpts"] : [];
  const request_id = optionalString(record, "request_id", 256);
  const session_id = optionalString(record, "session_id", 256);
  const call_index = optionalInteger(record, "call_index", 0, 10_000) ?? 0;
  return {
    question,
    scope,
    answer,
    evidence: evidence as PendingResolvePersistence["evidence"],
    excerpts: excerpts as PendingResolvePersistence["excerpts"],
    cards: cards as PendingResolvePersistence["cards"],
    ...(request_id === undefined ? {} : { request_id }),
    ...(session_id === undefined ? {} : { session_id }),
    call_index,
  };
}

/* -------------------------------------------------------------------- nav */

async function navRun(input: MemoryJobInput, ctx: OpContext): Promise<OpOutcome> {
  const model = ctx.runtime.model;
  if (model === null) {
    return outcome({ result: { status: "missing", reason: "model_not_configured" }, notes: ["no model configured"] });
  }
  const limit = optionalInteger(input, "limit", 1, 20);
  const memory_id = optionalString(input, "memory_id", 256);
  const revision = optionalInteger(input, "revision", 0, Number.MAX_SAFE_INTEGER);
  const runs = await runDueJobs({
    store: ctx.runtime.store,
    model,
    model_id: ctx.runtime.model_id,
    signal: ctx.signal,
    ...(limit === undefined ? {} : { limit }),
    ...(memory_id === undefined ? {} : { memory_id }),
    ...(revision === undefined ? {} : { revision }),
    deadline_ms: null,
  });
  return outcome({ result: summarizeRuns(runs), notes: [] });
}

function summarizeRuns(runs: RunDueJobsOutcome): Record<string, unknown> {
  return {
    status: "ok",
    claimed: runs.claimed,
    completed: runs.completed,
    retried: runs.retried,
    failed: runs.failed,
    elapsed_ms: runs.elapsed_ms,
    missing: runs.missing,
    results: runs.results,
  };
}

/* ----------------------------------------------------------------- repair */

async function repairOne(input: MemoryJobInput, ctx: OpContext): Promise<OpOutcome> {
  const project_id = optionalString(input, "project_id", 1024) ?? ctx.project_id;
  if (project_id === null) throw new Error("repair.memory requires project_id or a runtime default project");
  const uri = requireString(input, "uri", 1024) as MemoryUri;
  const result = await repairStaleMemoryNow({ ctx, uri, project_id });
  return outcome({ result, notes: result.status === "repaired" ? [] : [`repair ${result.status}`] });
}

async function repairMany(input: MemoryJobInput, ctx: OpContext): Promise<OpOutcome> {
  const project_id = optionalString(input, "project_id", 1024) ?? ctx.project_id;
  if (project_id === null) throw new Error("repair.memories requires project_id or a runtime default project");
  const at = optionalString(input, "at", 64) ?? ctx.runtime.timestamp();
  const max_memories = optionalInteger(input, "max_memories", 1, 24) ?? BACKGROUND_REPAIR_MAX_MEMORIES;
  const supplied = stringArray(input["memory_ids"], "memory_ids", 4096);
  const pool = ctx.runtime.store.readHotspotMemberships(project_id).map((entry) => entry.memory_id);
  const candidates = collectRepairCandidates(ctx.runtime.store, project_id, [...new Set([...supplied, ...pool])]);

  const model = ctx.runtime.model;
  if (model === null) {
    return outcome({
      result: { status: "missing", reason: "model_not_configured", candidates: 0, entries: [] },
      notes: ["no model configured"],
    });
  }

  const selected = candidates.slice(0, max_memories);
  const attempts = new Map<string, number>();
  const entries: Array<Record<string, unknown>> = [];
  let attempted = 0;
  let repaired = 0;
  for (const candidate of selected) {
    let spent = attempts.get(candidate.freshness.freshness_sig) ?? 0;
    if (spent >= BACKGROUND_REPAIR_MAX_ATTEMPTS) {
      entries.push({ memory_id: candidate.memory_id, status: "skipped", reason: "attempts_exhausted", attempts: spent });
      continue;
    }
    let entry: Record<string, unknown> | null = null;
    while (spent < BACKGROUND_REPAIR_MAX_ATTEMPTS) {
      ctx.signal.throwIfAborted();
      spent += 1;
      attempts.set(candidate.freshness.freshness_sig, spent);
      attempted += 1;
      const started = ctx.runtime.mono();
      try {
        const report = await repairStaleMemoryNow({ ctx, uri: candidate.uri, project_id, at });
        entry = { memory_id: candidate.memory_id, ...report, elapsed_ms: Math.round(ctx.runtime.mono() - started), attempts: spent };
        if (report.status === "repaired") {
          repaired += 1;
          break;
        }
        if (report.status === "nav_pending") break;
      } catch (error) {
        entry = {
          memory_id: candidate.memory_id,
          status: "repair_failed",
          reason: `repair_threw:${text(error)}`,
          attempts: spent,
        };
      }
    }
    if (entry) entries.push(entry);
  }
  return outcome({ result: { status: "ok", candidates: selected.length, attempted, repaired, entries } });
}

function collectRepairCandidates(
  store: MemoryStore,
  _project_id: string,
  memoryIds: readonly string[],
): Array<{ memory_id: string; uri: MemoryUri; freshness: Freshness }> {
  const candidates: Array<{ memory_id: string; uri: MemoryUri; freshness: Freshness }> = [];
  for (const memory_id of memoryIds) {
    const uri = memoryUriFor(store, memory_id);
    let head: ReturnType<MemoryStore["readMemory"]>;
    try {
      head = store.readMemory(uri);
    } catch {
      continue;
    }
    if (head === null) continue;
    const freshness = store.readFreshness(uri, head.revision);
    if (freshness === null) continue;
    if (freshness.pending.filter((event) => event.event_id.length > 0).length === 0) continue;
    candidates.push({ memory_id, uri, freshness });
  }
  return candidates;
}

type RepairNowReport = {
  status: "repaired" | "nav_pending" | "repair_failed";
  reason: string | null;
  from_revision: number;
  revision: number | null;
  acknowledged_event_ids: string[];
  nav_status: "published" | "pending" | null;
};

async function repairStaleMemoryNow(input: {
  ctx: OpContext;
  uri: MemoryUri;
  project_id: string;
  at?: string | undefined;
}): Promise<RepairNowReport> {
  const store = input.ctx.runtime.store;
  const head = store.readMemory(input.uri);
  const freshness = head === null ? null : store.readFreshness(input.uri, head.revision);
  if (freshness === null || head === null) {
    return { status: "repair_failed", reason: "memory_missing", from_revision: 0, revision: null, acknowledged_event_ids: [], nav_status: null };
  }
  const model = input.ctx.runtime.model;
  if (model === null) {
    return {
      status: "repair_failed",
      reason: "model_unavailable",
      from_revision: freshness.delivered_revision,
      revision: null,
      acknowledged_event_ids: [],
      nav_status: null,
    };
  }
  const pending = freshness.pending.filter((event) => event.event_id.length > 0);
  const at = input.at ?? input.ctx.runtime.timestamp();
  const signal = input.ctx.signal;
  const failed = (reason: string): RepairNowReport => ({
    status: "repair_failed",
    reason,
    from_revision: freshness.delivered_revision,
    revision: null,
    acknowledged_event_ids: [],
    nav_status: null,
  });

  let repaired: RepairOutcome;
  try {
    repaired = await repairStaleMemory({
      store,
      card: { uri: input.uri, revision: freshness.delivered_revision },
      pending,
      answer: describePending(pending),
      excerpts: [],
      expected_revision: freshness.delivered_revision,
      model,
      model_id: input.ctx.runtime.model_id,
      signal,
      at,
      project: input.project_id,
    });
  } catch (error) {
    return failed(`repair_threw:${text(error)}`);
  }
  if (repaired.status !== "repaired" || repaired.memory === null) {
    return failed(`repair_${repaired.status}${repaired.reason === null ? "" : `:${repaired.reason}`}`);
  }
  const revision = repaired.memory.revision;
  if (signal.aborted) {
    return {
      status: "nav_pending",
      reason: "cancelled",
      from_revision: freshness.delivered_revision,
      revision,
      acknowledged_event_ids: repaired.incorporated_event_ids,
      nav_status: "pending",
    };
  }
  const published = await publishRevision(input.ctx, input.uri, head.memory_id, revision, signal);
  return {
    status: published.published ? "repaired" : "nav_pending",
    reason: published.reason,
    from_revision: freshness.delivered_revision,
    revision,
    acknowledged_event_ids: repaired.incorporated_event_ids,
    nav_status: published.published ? "published" : "pending",
  };
}

async function publishRevision(
  ctx: OpContext,
  uri: MemoryUri,
  memoryId: string,
  revision: number,
  signal: AbortSignal | undefined,
): Promise<{ published: boolean; reason: string | null }> {
  const model = ctx.runtime.model;
  if (model === null) return { published: false, reason: "model_not_configured" };
  try {
    const outcome_ = await runDueJobs({
      store: ctx.runtime.store,
      model,
      model_id: ctx.runtime.model_id,
      limit: 1,
      memory_id: memoryId,
      revision,
      ...(signal === undefined ? {} : { signal }),
      deadline_ms: null,
    });
    const result = outcome_.results.find((entry) => entry.memory_id === memoryId && entry.revision === revision);
    if (result?.state !== "done") return { published: false, reason: navReason(ctx.runtime.store, uri, revision) };
  } catch {
    return { published: false, reason: navReason(ctx.runtime.store, uri, revision) };
  }
  const stored = readHead(ctx.runtime.store, uri);
  const published = stored?.state === "published" && stored.nav !== null && stored.nav.source_revision === revision;
  return { published, reason: published ? null : navReason(ctx.runtime.store, uri, revision) };
}

function navReason(store: MemoryStore, uri: MemoryUri, revision: number): string {
  const stored = readHead(store, uri);
  if (stored === null || stored.revision !== revision) return "head_moved_after_repair";
  if (stored.nav === null) return "nav_not_generated";
  if (stored.nav.source_revision !== revision) return `nav_bound_to_r${stored.nav.source_revision}`;
  return "nav_not_published";
}

function readHead(store: MemoryStore, uri: MemoryUri): ReturnType<MemoryStore["readMemory"]> {
  try {
    return store.readMemory(uri);
  } catch {
    return null;
  }
}

function describePending(pending: readonly StaleEventSummary[]): string {
  return `This memory was read while ${pending.length} later change(s) were still unabsorbed; fold them into the same summary.`;
}

/* --------------------------------------------------------------- requests */

function requestWrite(input: MemoryJobInput, ctx: OpContext): OpOutcome {
  const project_id = optionalString(input, "project_id", 1024) ?? ctx.project_id;
  if (project_id === null) throw new Error("request.write requires project_id or a runtime default project");
  const session_id = requireString(input, "session_id", 256);
  const branch_ref = optionalString(input, "branch_ref", 1024) ?? "";
  const intent = requireString(input, "intent", 4096);
  const title = optionalString(input, "title", 512) ?? intent.slice(0, 80);
  const rows = requireRecordArray(input, "evidence", 64);
  const evidence = rows.map((row) => {
    const source = parseSourceRef(row["source"], project_id);
    const excerpt = requireString(row, "excerpt", 20_000);
    return { source, excerpt };
  });
  const at = optionalString(input, "at", 64) ?? ctx.runtime.timestamp();
  const scope = input["scope"] === undefined || input["scope"] === null ? { kind: "project" as const, project_id } : parseScope(input["scope"]);
  const result = ctx.runtime.store.enqueueMemoryRequest({ scope, project_id, session_id, branch_ref, intent, title, evidence, at });
  const request = result.request;
  return outcome({
    result: {
      status: "stored",
      inserted: result.inserted,
      request_id: request.request_id,
      request_status: request.status,
      scope: request.scope,
      intent: request.intent,
      title: request.title,
      evidence_ids: request.evidence.map((entry) => entry.source.message_id),
    },
    text: result.inserted
      ? `memory_request_write -> stored ${request.request_id} [${request.status}]`
      : `memory_request_write -> already stored ${request.request_id} [${request.status}]`,
  });
}

async function requestProcess(input: MemoryJobInput, ctx: OpContext): Promise<OpOutcome> {
  const at = optionalString(input, "at", 64) ?? ctx.runtime.timestamp();
  const limit = Math.max(1, Math.min(REQUEST_BATCH_LIMIT, optionalInteger(input, "limit", 1, REQUEST_BATCH_LIMIT) ?? REQUEST_BATCH_LIMIT));
  const nav_limit = Math.max(1, Math.min(REQUEST_NAV_LIMIT, optionalInteger(input, "nav_limit", 1, REQUEST_NAV_LIMIT) ?? REQUEST_NAV_LIMIT));
  const store = ctx.runtime.store;
  const model = ctx.runtime.model;
  const owner = `daemon-requests-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const report = { claimed: 0, saved: 0, merged: 0, retried: 0, failed: 0, entries: [] as Array<Record<string, unknown>> };

  for (let index = 0; index < limit; index += 1) {
    if (ctx.signal.aborted) break;
    let request: MemoryRequest | null;
    try {
      request = store.claimDueMemoryRequest({ now_ms: ctx.runtime.now(), owner });
    } catch (error) {
      report.entries.push({ request_id: "claim", status: "failed", reason: text(error) });
      break;
    }
    if (request === null) break;
    report.claimed += 1;
    try {
      const composed = await composeMemoryRequest({
        store,
        request,
        model,
        model_id: ctx.runtime.model_id,
        signal: ctx.signal,
        at,
        project: request.project_id,
      });
      const memory = composed.memory;
      if (memory === null) {
        const terminal = composed.status === "insufficient_evidence" || composed.status === "rejected";
        const stored = store.failMemoryRequest({
          request,
          status: terminal ? "failed" : "pending",
          reason: composed.reason ?? composed.status,
          next_attempt_at: new Date(ctx.runtime.now() + MEMORY_REQUEST_RETRY_MS).toISOString(),
          at,
        });
        if (stored.status === "failed" || stored.status === "rejected") report.failed += 1;
        else report.retried += 1;
        report.entries.push({ request_id: stored.request_id, status: stored.status, reason: stored.reason });
        continue;
      }
      if (request.memory_uri !== memory.uri || request.revision !== memory.revision) {
        store.attachMemoryRequestTarget({ request_id: request.request_id, memory_uri: memory.uri, revision: memory.revision, at });
      }
      const nav = await publishRequestNavigation({ ctx, memory, at });
      const kind: "saved" | "merged" = composed.status === "merged" ? "merged" : "saved";
      const completed = store.completeMemoryRequest({
        request_id: request.request_id,
        outcome: kind,
        memory_uri: memory.uri,
        revision: memory.revision,
        navigation_status: nav.status,
        at,
      });
      if (kind === "merged") report.merged += 1;
      else report.saved += 1;
      report.entries.push({
        request_id: completed.request_id,
        status: completed.status,
        memory_uri: completed.memory_uri,
        revision: completed.revision,
        navigation_status: completed.navigation_status,
        reason: completed.reason,
      });
    } catch (error) {
      try {
        const stored = store.failMemoryRequest({
          request,
          status: "pending",
          reason: text(error),
          next_attempt_at: new Date(ctx.runtime.now() + MEMORY_REQUEST_RETRY_MS).toISOString(),
          at,
        });
        if (stored.status === "failed") report.failed += 1;
        else report.retried += 1;
        report.entries.push({ request_id: stored.request_id, status: stored.status, reason: stored.reason });
      } catch (nested) {
        report.entries.push({ request_id: request.request_id, status: "failed", reason: text(nested) });
      }
    }
  }

  if (model !== null) {
    let resumed = 0;
    for (const request of store.listMemoryRequests(200)) {
      if (resumed >= nav_limit) break;
      if ((request.status !== "saved" && request.status !== "merged") || request.navigation_status !== "pending") continue;
      if (request.memory_uri === null || request.revision === null) continue;
      resumed += 1;
      try {
        const memory = store.readMemory(request.memory_uri, request.revision);
        if (memory === null) continue;
        const runs = await runDueJobs({
          store,
          model,
          model_id: ctx.runtime.model_id,
          limit: 1,
          memory_id: memory.memory_id,
          revision: memory.revision,
          signal: ctx.signal,
          deadline_ms: null,
        });
        const result = runs.results[0];
        if (result === undefined) continue;
        store.setMemoryRequestNavigation({
          request_id: request.request_id,
          navigation_status: result.state === "failed" ? "failed" : navStatus(store, memory),
          at,
        });
      } catch {
        // The next pass retries; a nav problem must not fail the body.
      }
    }
  }

  return outcome({ result: { status: "ok", ...report } });
}

async function publishRequestNavigation(input: {
  ctx: OpContext;
  memory: ReturnType<MemoryStore["readMemory"]> & object;
  at: string;
}): Promise<{ status: "ready" | "pending" | "failed"; reason: string | null }> {
  const model = input.ctx.runtime.model;
  if (model === null) return { status: "pending", reason: "model_not_configured" };
  const memory = input.memory;
  const runs = await runDueJobs({
    store: input.ctx.runtime.store,
    model,
    model_id: input.ctx.runtime.model_id,
    limit: 1,
    memory_id: memory.memory_id,
    revision: memory.revision,
    signal: input.ctx.signal,
    deadline_ms: null,
  });
  const result = runs.results[0];
  const read = input.ctx.runtime.store.readMemory(memory.uri, memory.revision);
  const status = read === null ? "pending" : navStatus(input.ctx.runtime.store, read);
  if (result !== undefined && result.state === "failed") return { status: "failed", reason: result.reason };
  return { status, reason: result?.reason ?? null };
}

function navStatus(store: MemoryStore, memory: NonNullable<ReturnType<MemoryStore["readMemory"]>>): "pending" | "ready" {
  const read = store.readMemory(memory.uri, memory.revision);
  if (read === null || read.nav === null) return "pending";
  if (read.nav.source_revision !== memory.revision) return "pending";
  return read.nav.text.length > 0 ? "ready" : "pending";
}

/* ---------------------------------------------------------------- hotspots */

function hotspotCommit(input: MemoryJobInput, ctx: OpContext): OpOutcome {
  const plan = parsePlan(input["plan"]);
  const delivered = stringArray(input["delivered"], "delivered", 4096);
  const at = optionalString(input, "at", 64) ?? ctx.runtime.timestamp();
  const activity_seq = optionalInteger(input, "activity_seq", 0) ?? safeActivitySeq(ctx.runtime.store, plan.project_id);
  const ledger = InjectionLedger.fromIds(delivered, at);
  const commit = commitInjection({ plan, store: ctx.runtime.store, ledger, at, activity_seq });
  return outcome({ result: commit, text: commitText(commit, plan) });
}

function sessionInput(input: MemoryJobInput, ctx: OpContext): OpOutcome {
  const project_id = optionalString(input, "project_id", 1024) ?? ctx.project_id;
  if (project_id === null) throw new Error("session.input requires project_id or a runtime default project");
  const session_id = requireString(input, "session_id", 256);
  const input_id = requireString(input, "input_id", 256);
  const body = requireString(input, "text", 200_000);
  const at = ctx.runtime.timestamp();
  const activity = recordProjectInput(ctx.runtime.store, project_id, at);
  const delivered = stringArray(input["delivered"], "delivered", 4096);
  const sigs = input["freshness_sigs"] === undefined ? {} : asRecord(input["freshness_sigs"], "freshness_sigs");
  const ledger = new InjectionLedger();
  for (const id of delivered) ledger.add(id as MemoryId, at, typeof sigs[id] === "string" ? sigs[id] : "");
  const plan = planInjection({
    store: ctx.runtime.store,
    project_id,
    session_id,
    branch_ref: optionalString(input, "branch_ref", 1024) ?? "",
    input_id,
    text: body,
    ledger,
    ...(optionalString(input, "source", 256) === undefined ? {} : { source: optionalString(input, "source", 256) as string }),
    host_command: body.startsWith("/"),
    budget_bytes: optionalInteger(input, "budget_bytes", 1) ?? 4096,
    max_memories: optionalInteger(input, "max_memories", 1) ?? 3,
    min_score: optionalInteger(input, "min_score", 1) ?? 1,
    capacity: optionalInteger(input, "capacity", 1) ?? 32,
    timeout_ms: optionalInteger(input, "timeout_ms", 1) ?? 1000,
    now: ctx.runtime.now,
  });
  if (plan.status !== "injected") {
    return outcome({ result: { action: "continue", reason: plan.reason, plan }, text: null });
  }
  const commit = commitInjection({ plan, store: ctx.runtime.store, ledger, at, activity_seq: activity.activity_seq });
  if (commit.delivered.length !== plan.injected.length) {
    return outcome({
      result: { action: "continue", reason: "receipt_failed", plan, commit, errors: commit.errors },
      notes: ["commit did not deliver every injected memory"],
    });
  }
  return outcome({ result: { action: "transform", text: plan.text, plan, commit } });
}

/* ------------------------------------------------------------------ usage */

function usageSearchHits(input: MemoryJobInput, ctx: OpContext): OpOutcome {
  const session_id = requireString(input, "session_id", 256);
  const input_id = requireString(input, "input_id", 256);
  const at = optionalString(input, "at", 64) ?? ctx.runtime.timestamp();
  const rows = requireRecordArray(input, "hits", 256);
  const hits = rows.map((row) => {
    const memory_id = requireString(row, "memory_id", 256) as MemoryId;
    const revision = optionalInteger(row, "revision", 0, Number.MAX_SAFE_INTEGER) as Revision | undefined;
    if (revision === undefined) throw new Error("usage.search_hits hit requires revision");
    return { memory_id, revision };
  });
  const recorded = recordSearchHits({ store: ctx.runtime.store, session_id, input_id, at, hits });
  return outcome({ result: { status: "ok", recorded } });
}

function usageMemoryRead(input: MemoryJobInput, ctx: OpContext): OpOutcome {
  const project_id = optionalString(input, "project_id", 1024) ?? ctx.project_id;
  if (project_id === null) throw new Error("usage.memory_read requires project_id or a runtime default project");
  const session_id = requireString(input, "session_id", 256);
  const input_id = requireString(input, "input_id", 256);
  const memory_id = requireString(input, "memory_id", 256) as MemoryId;
  const revision = optionalInteger(input, "revision", 0, Number.MAX_SAFE_INTEGER) as Revision | undefined;
  if (revision === undefined) throw new Error("usage.memory_read requires revision");
  const at = optionalString(input, "at", 64) ?? ctx.runtime.timestamp();
  const result = recordMemoryRead({
    store: ctx.runtime.store,
    project_id,
    session_id,
    input_id,
    at,
    memory_id,
    revision,
    activity_seq: safeActivitySeq(ctx.runtime.store, project_id),
  });
  return outcome({ result: { status: "ok", ...result } });
}

/* ----------------------------------------------------------------- helpers */

function parseScope(value: unknown): Scope {
  const record = asRecord(value, "scope");
  const kind = record["kind"];
  if (kind === "global") return { kind: "global" };
  if (kind === "project") return { kind: "project", project_id: requireString(record, "project_id", 1024) };
  throw new Error("scope must be {kind:'project',project_id} or {kind:'global'}");
}

function parsePlan(value: unknown): InjectionPlan {
  const record = asRecord(value, "plan");
  if (record["status"] !== "injected" && record["status"] !== "not_injected") {
    throw new Error("plan must be an InjectionPlan");
  }
  if (typeof record["project_id"] !== "string" || typeof record["input_id"] !== "string") {
    throw new Error("plan is missing project_id/input_id");
  }
  return record as unknown as InjectionPlan;
}

function commitText(commit: CommitResult, plan: InjectionPlan): string {
  const errors = commit.errors.length === 0 ? "" : ` errors=${commit.errors.join("; ")}`;
  return `hotspot.commit -> delivered=${commit.delivered.length}/${plan.injected.length} receipts=${commit.receipts}${errors}`;
}

function safeActivitySeq(store: MemoryStore, projectId: string): number {
  try {
    return store.readProjectActivity(projectId)?.activity_seq ?? 0;
  } catch {
    return 0;
  }
}

function memoryUriFor(store: MemoryStore, memoryId: string): MemoryUri {
  return `memory://${store.storeId}/${memoryId}` as MemoryUri;
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
