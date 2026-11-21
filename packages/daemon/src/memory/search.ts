/**
 * Read-only operations: they answer from the store, the model and the history
 * adapter, and they never write. Every write they would otherwise perform
 * (recording hits, persisting a resolved answer) comes back as a maintenance
 * dependency for the control plane to schedule.
 */

import { ValidationError, splitMemoryUri, type MemoryUri } from "@vestigio/core";
import { InjectionLedger, planInjection } from "@vestigio/core/hotspots";
import type { MemoryRequest } from "@vestigio/core/requests";
import { layeredSearch, readMemoryResult, type LayeredSearchInput } from "@vestigio/core/retrieval";
import { resolveMemory, searchWithRecovery } from "@vestigio/core/resolver";
import {
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireString,
  type MemoryJobInput,
  type RequestStatusInput,
} from "./contract.js";
import { dependency, outcome, type DependencyRequest, type OpContext, type OpOutcome } from "./internal.js";
import { renderRead, renderResolve, renderSearch, staleCards } from "./render.js";

/** A missing history adapter is reported the way the extension reported it. */
const NO_HISTORY = "no history adapter configured";
const NO_MODEL = "no model configured";

const INJECTION_DEFAULTS = {
  budget_bytes: 4096,
  max_memories: 3,
  min_score: 1,
  capacity: 32,
  timeout_ms: 1000,
};

export async function runReadOp(input: MemoryJobInput, ctx: OpContext): Promise<OpOutcome> {
  switch (input.op) {
    case "memory.search":
      return search(input, ctx);
    case "memory.read":
      return read(input, ctx);
    case "memory.resolve":
      return resolve(input, ctx);
    case "request.status":
      return requestStatus(input as RequestStatusInput, ctx);
    case "hotspot.plan":
      return plan(input, ctx);
    default:
      return invalid(`operation ${input.op} is not read-only`);
  }
}

function projectOf(input: Record<string, unknown>, ctx: OpContext): string {
  const value = optionalString(input, "project_id", 1024) ?? ctx.project_id;
  if (value === null) {
    return invalid("project_id is required: the job carries no default project");
  }
  return value;
}

function invalid(message: string): never {
  throw new ValidationError("memory", "invalid_type", message);
}

async function search(input: MemoryJobInput, ctx: OpContext): Promise<OpOutcome> {
  const project_id = projectOf(input, ctx);
  const query = requireString(input, "query", 4096);
  const wantHistory = input["include_history"] === true;
  const history = wantHistory ? ctx.runtime.history : null;
  const limit = optionalInteger(input, "limit", 1, 10);
  const offset = optionalInteger(input, "offset", 0, 100_000);
  const include_archived = optionalBoolean(input, "include_archived");
  const include_history_read = optionalBoolean(input, "include_history_read");
  const options: LayeredSearchInput = {
    store: ctx.runtime.store,
    query,
    scope: { kind: "project", project_id },
    include_history: history !== null,
    ...(history === null ? {} : { history }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
    ...(include_archived === undefined ? {} : { include_archived }),
    ...(include_history_read === undefined ? {} : { include_history_read }),
  };
  const question = optionalString(input, "question", 8192);
  const recovered = question === undefined ? null : await searchWithRecovery({
    ...options,
    question,
    getModel: () => ctx.runtime.model,
    signal: ctx.signal,
  });
  const result = recovered ?? await layeredSearch(options);
  const note = wantHistory && history === null ? NO_HISTORY : null;
  const deferred: DependencyRequest[] = [];
  const session_id = optionalString(input, "session_id");
  const input_id = optionalString(input, "input_id");
  if (session_id !== undefined && input_id !== undefined && result.result.cards.length > 0) {
    deferred.push(
      dependency(
        "usage.search_hits",
        {
          op: "usage.search_hits",
          session_id,
          input_id,
          hits: result.result.cards.map((card) => ({ memory_id: card.memory_id, revision: card.revision })),
        },
        { inline: false, key: `usage.search_hits:${input_id}` },
      ),
    );
  }
  return outcome({
    result: {
      status: result.result.status,
      project_id,
      cards: result.result.cards,
      layers: result.layers,
      missing: result.result.missing,
      conflicts: result.result.conflicts,
      next_action: result.result.next_action,
      history_note: note,
      // Recorded by the deferred `usage.search_hits` child, not here.
      hits_recorded: null,
      stale_cards: staleCards(result.result),
      measured: result.measured,
      ...(recovered === null ? {} : { recovery: recovered.recovery }),
    },
    text: renderSearch(query, project_id, result, note, recovered?.recovery),
    deferred,
  });
}

function read(input: MemoryJobInput, ctx: OpContext): OpOutcome {
  const uri = requireString(input, "uri", 1024);
  const revision = optionalInteger(input, "revision", 0, Number.MAX_SAFE_INTEGER);
  let ids: { storeId: string; memoryId: string };
  try {
    ids = splitMemoryUri(uri);
  } catch (error) {
    const reason = error instanceof ValidationError ? error.message : text(error);
    return outcome({ result: { status: "rejected", reason }, text: `memory_read rejected the URI: ${reason}` });
  }
  if (ids.storeId !== ctx.runtime.store.storeId) {
    const reason = `${uri} belongs to store ${ids.storeId}, not ${ctx.runtime.store.storeId}.`;
    return outcome({ result: { status: "refused", reason }, text: `memory_read refused: ${reason}` });
  }
  const result = readMemoryResult({
    store: ctx.runtime.store,
    uri: uri as MemoryUri,
    ...(revision === undefined ? {} : { revision }),
  });
  let deferredPending: number | null = null;
  if (revision === undefined && result.result.status === "resolved" && result.result.freshness?.is_stale === true) {
    deferredPending = result.result.freshness.pending.filter((event) => event.event_id.length > 0).length;
  }
  const deferred: DependencyRequest[] = [];
  const session_id = optionalString(input, "session_id");
  const input_id = optionalString(input, "input_id");
  const project_id = optionalString(input, "project_id", 1024) ?? ctx.project_id;
  const memory_revision = result.result.revision;
  if (session_id !== undefined && input_id !== undefined && project_id !== null && memory_revision !== null) {
    deferred.push(
      dependency(
        "usage.memory_read",
        {
          op: "usage.memory_read",
          project_id,
          session_id,
          input_id,
          memory_id: ids.memoryId,
          revision: memory_revision,
        },
        { inline: false, key: `usage.memory_read:${input_id}` },
      ),
    );
  }
  return outcome({
    result: {
      status: result.result.status,
      memory_uri: result.memory_uri,
      revision: result.result.revision,
      persistence_status: result.result.persistence_status,
      missing: result.result.missing,
      conflicts: result.result.conflicts,
      next_action: result.result.next_action,
      access_recorded: null,
      freshness: result.result.freshness ?? null,
      measured: result.measured,
    },
    text: renderRead(uri, result, deferredPending),
    deferred,
  });
}

async function resolve(input: MemoryJobInput, ctx: OpContext): Promise<OpOutcome> {
  const project_id = projectOf(input, ctx);
  const question = requireString(input, "question", 4096);
  const wantHistory = input["include_history"] !== false;
  const history = wantHistory ? ctx.runtime.history : null;
  const model = ctx.runtime.model;
  const modelNote = model === null ? NO_MODEL : null;
  const handle = optionalString(input, "context_handle", 1024) ?? project_id;
  const context = ctx.runtime.resolves.begin(ctx.session, ctx.job.jobId, handle, ctx.runtime.now());
  const result = await resolveMemory({
    store: ctx.runtime.store,
    question,
    scope: { kind: "project", project_id },
    model,
    history,
    signal: ctx.signal,
    request_id: ctx.job.jobId,
    session_id: ctx.session.sessionId,
    session_resolves_used: context.used,
    continuation: context.continuation,
    // Classification, not convenience: persistence is a maintenance write.
    defer_persistence: true,
    unbounded_time: true,
  });
  ctx.signal.throwIfAborted();
  context.commit(result.continuation);
  const historyNote = wantHistory && history === null ? NO_HISTORY : null;
  const deferred: DependencyRequest[] = [];
  const session_id = optionalString(input, "session_id");
  const input_id = optionalString(input, "input_id");
  if (session_id !== undefined && input_id !== undefined) {
    deferred.push(
      dependency(
        "usage.search_hits",
        {
          op: "usage.search_hits",
          session_id,
          input_id,
          hits: result.result.cards.map((card) => ({ memory_id: card.memory_id, revision: card.revision })),
        },
        { inline: false, key: `usage.search_hits:${input_id}` },
      ),
    );
  }
  const persist = input["persist"] !== false;
  const pending = result.pending_persistence;
  if (persist && pending != null) {
    deferred.push(
      dependency(
        "resolve.persist",
        { op: "resolve.persist", request: pending },
        { inline: false, key: `resolve.persist:${pending.request_id}` },
      ),
    );
  }
  return outcome({
    result: {
      status: result.result.status,
      project_id,
      cards: result.result.cards,
      layers: result.layers,
      history: result.history,
      calls: result.calls,
      measured: result.measured,
      degraded: result.measured.degraded,
      degraded_reason: result.measured.degraded ? (modelNote ?? result.result.missing[0] ?? null) : null,
      budget_used: result.result.budget_used,
      continuation_id: result.continuation?.id ?? null,
      missing: result.result.missing,
      conflicts: result.result.conflicts,
      next_action: result.result.next_action,
      history_note: historyNote,
      hits_recorded: null,
      persistence: result.persistence,
      pending_persistence: pending ?? null,
      memory_summary: result.result.memory_summary,
      memory_uri: result.result.memory_uri,
      revision: result.result.revision,
      persistence_status: result.result.persistence_status,
      navigation_status: result.result.navigation_status,
      freshness: result.result.freshness ?? null,
      stale_cards: staleCards(result.result),
    },
    text: renderResolve(question, project_id, result, modelNote, historyNote, null),
    deferred,
    notes: persist && pending != null ? ["persistence deferred to the maintenance slot"] : [],
  });
}

function requestStatus(input: RequestStatusInput, ctx: OpContext): OpOutcome {
  const request_id = optionalString(input, "request_id");
  const uri = optionalString(input, "uri", 1024);
  const limit = optionalInteger(input, "limit", 1, 200) ?? 50;
  let requests: MemoryRequest[];
  try {
    if (request_id !== undefined) {
      const found = ctx.runtime.store.readMemoryRequest(request_id);
      requests = found === null ? [] : [found];
    } else if (uri !== undefined) {
      requests = ctx.runtime.store.listMemoryRequests(200).filter((request) => request.memory_uri === uri);
    } else {
      const project_id = projectOf(input, ctx);
      requests = ctx.runtime.store
        .listMemoryRequests(200)
        .filter((request) => request.project_id === project_id)
        .slice(0, limit);
    }
  } catch (error) {
    return outcome({
      result: { status: "failed", reason: text(error) },
      text: `memory_request_status failed: ${text(error)}`,
    });
  }
  return outcome({
    result: {
      status: requests.length === 0 ? "missing" : "ok",
      requests: requests.map((request) => ({
        request_id: request.request_id,
        status: request.status,
        scope: request.scope,
        intent: request.intent,
        title: request.title,
        evidence_ids: request.evidence.map((entry) => entry.source.message_id),
        attempts: request.attempts,
        memory_uri: request.memory_uri,
        revision: request.revision,
        navigation_status: request.navigation_status,
        reason: request.reason,
        updated_at: request.updated_at,
      })),
    },
    text: statusText(requests),
  });
}

function plan(input: MemoryJobInput, ctx: OpContext): OpOutcome {
  const project_id = projectOf(input, ctx);
  const session_id = requireString(input, "session_id", 256);
  const input_id = requireString(input, "input_id", 256);
  const body = requireString(input, "text", 200_000);
  const source = optionalString(input, "source", 256);
  const ledger = InjectionLedger.fromIds(stringArray(input, "delivered", 4096), ctx.runtime.timestamp());
  const planned = planInjection({
    store: ctx.runtime.store,
    project_id,
    session_id,
    branch_ref: optionalString(input, "branch_ref", 1024) ?? "",
    input_id,
    text: body,
    ledger,
    ...(source === undefined ? {} : { source }),
    budget_bytes: optionalInteger(input, "budget_bytes", 1) ?? INJECTION_DEFAULTS.budget_bytes,
    max_memories: optionalInteger(input, "max_memories", 1) ?? INJECTION_DEFAULTS.max_memories,
    min_score: optionalInteger(input, "min_score", 1) ?? INJECTION_DEFAULTS.min_score,
    capacity: optionalInteger(input, "capacity", 1) ?? INJECTION_DEFAULTS.capacity,
    timeout_ms: optionalInteger(input, "timeout_ms", 1) ?? INJECTION_DEFAULTS.timeout_ms,
    now: ctx.runtime.now,
  });
  return outcome({
    result: planned,
    text: `hotspot.plan -> ${planned.status} (${planned.reason}) matched=${planned.matched.length} injected=${planned.injected.length}`,
  });
}

function statusText(requests: readonly MemoryRequest[]): string {
  if (requests.length === 0) return "memory_request_status: no matching request";
  return [`memory_request_status: ${requests.length} request(s)`, ...requests.map((request) => `- ${describeStatus(request)}`)].join("\n");
}

function describeStatus(request: MemoryRequest): string {
  const where =
    request.memory_uri === null
      ? "no memory URI yet"
      : `${request.memory_uri} r${request.revision ?? "?"} nav=${request.navigation_status ?? "none"}`;
  const reason = request.reason === null ? "" : ` reason=${request.reason}`;
  return `${request.request_id} [${request.status}] attempts=${request.attempts} | ${where}${reason}`;
}

function stringArray(input: Record<string, unknown>, field: string, max: number): string[] {
  const value = input[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new ValidationError("memory", "invalid_type", `${field} must be an array of at most ${max} strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new ValidationError("memory", "invalid_type", `${field}[${index}] must be a non-empty string`);
    }
    return item;
  });
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
