/**
 * The daemon memory wire contract.
 *
 * This module is the stable surface between a client (a pi session, the CLI, an
 * MCP caller) and the daemon's memory worker. It is deliberately runtime-free:
 * every import here is `import type`, so a client can load the schema without
 * pulling in a SQLite driver, a model client or a history adapter. The daemon
 * loads the same file and adds behaviour in `handler.ts`.
 *
 * Three job kinds exist, and the kind is not cosmetic: the daemon runs at most
 * one `maintenance` job at a time, while `search` and `detector` run their own
 * concurrency. So the rule is absolute — a read is a read and never writes, and
 * a write is a `maintenance` operation even when the caller reached it through a
 * detector or a retrieval. When a read-only operation needs a write to complete
 * its meaning (recording a search hit, publishing a detector finding, persisting
 * a resolved answer), it does not perform it: it returns the write as a
 * `deferred` child, and the daemon's control plane schedules it inside the
 * maintenance slot.
 */

import type { Kind, SessionKey } from "../protocol.js";

export const MEMORY_OPS = [
  // Read-only retrieval surface.
  "memory.search",
  "memory.read",
  "memory.resolve",
  "request.status",
  "hotspot.plan",
  // Turn-evidence detector: one bounded model call, no storage write.
  "detector.run",
  // Every write, serialized behind the maintenance slot.
  "stale.publish",
  "resolve.persist",
  "nav.run",
  "repair.memory",
  "repair.memories",
  "request.write",
  "request.process",
  "hotspot.commit",
  "session.input",
  "usage.search_hits",
  "usage.memory_read",
] as const;

export type MemoryOp = typeof MEMORY_OPS[number];

/** The job kind each operation must be submitted as. */
export const OP_KINDS: Readonly<Record<MemoryOp, Kind>> = {
  "memory.search": "search",
  "memory.read": "search",
  "memory.resolve": "search",
  "request.status": "search",
  "hotspot.plan": "search",
  "detector.run": "detector",
  "stale.publish": "maintenance",
  "resolve.persist": "maintenance",
  "nav.run": "maintenance",
  "repair.memory": "maintenance",
  "repair.memories": "maintenance",
  "request.write": "maintenance",
  "request.process": "maintenance",
  "hotspot.commit": "maintenance",
  "session.input": "maintenance",
  "usage.search_hits": "maintenance",
  "usage.memory_read": "maintenance",
};

export function isMemoryOp(value: unknown): value is MemoryOp {
  return typeof value === "string" && (MEMORY_OPS as readonly string[]).includes(value);
}

export function kindOfOp(op: MemoryOp): Kind {
  return OP_KINDS[op];
}

/** The `input` a memory job carries: the operation name plus its parameters. */
export type MemoryJobInput = { op: MemoryOp } & Record<string, unknown>;

/** The job shape the daemon hands a handler; structurally `protocol.Job`. */
export type MemoryJobShape = {
  jobId: string;
  kind: Kind;
  session: SessionKey;
  input: unknown;
};

export type MemoryJobHandler = (
  job: MemoryJobShape,
  signal: AbortSignal,
  control?: MemoryJobControl,
) => Promise<MemoryJobResult>;

/**
 * Durable dependency scheduling handed to a handler as its optional third
 * argument. A handler that must not perform a write itself (because it is a
 * read or a detector) calls `defer` with the maintenance operation, and the
 * child runs in the maintenance slot after the parent has yielded. Without a
 * control the handler still reports the dependency in its result, so callers
 * can enqueue it or observe that it was not scheduled.
 */
export type MemoryJobControl = {
  defer(kind: Kind, input: MemoryJobInput, options?: { key?: string; mandatory?: boolean }): Promise<DeferredMemoryJob>;
};

export type DeferredStatus =
  /** A durable child job was submitted to the daemon. */
  | "enqueued"
  /** Executed inline; only legal inside an already-serialized maintenance job. */
  | "inline"
  /** Reported to the caller unscheduled; no control plane was provided. */
  | "pending";

export type DeferredMemoryJob = {
  key: string;
  kind: Kind;
  op: MemoryOp;
  status: DeferredStatus;
  jobId: string | null;
  input: MemoryJobInput;
  /** False when the parent's answer does not depend on this write succeeding. */
  mandatory: boolean;
};

export type MemoryJobResult = {
  turnLeaf?: string;
  op: MemoryOp;
  kind: Kind;
  result: unknown;
  /** Legacy pi tool text, when the operation maps to a tool; else `null`. */
  text: string | null;
  deferred: DeferredMemoryJob[];
  notes: string[];
};

/* ---------------------------------------------------------------- operations */

/** Wire-safe mirror of the store `SourceRef`. */
export type WireSourceRef = {
  provider: string;
  source_instance: string;
  session_id: string;
  message_id: string;
  parent_message_id: string | null;
  project_id: string;
  timestamp: string;
  content_hash: string;
  locator: string | null;
};

export type MemorySearchInput = {
  op: "memory.search";
  project_id: string;
  query: string;
  /** Opts into miss recovery using the original user question. */
  question?: string | undefined;
  include_archived?: boolean | undefined;
  include_history?: boolean | undefined;
  include_history_read?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  /** When set with `input_id`, a `usage.search_hits` child is surfaced. */
  session_id?: string | undefined;
  input_id?: string | undefined;
};

export type MemoryReadInput = {
  op: "memory.read";
  uri: string;
  revision?: number | undefined;
  project_id?: string | undefined;
  session_id?: string | undefined;
  input_id?: string | undefined;
};

export type MemoryResolveInput = {
  op: "memory.resolve";
  project_id: string;
  question: string;
  include_history?: boolean | undefined;
  session_id?: string | undefined;
  input_id?: string | undefined;
  /** Surface a `resolve.persist` child (default true). Never persists inline. */
  persist?: boolean | undefined;
  context_handle?: string | undefined;
};

export type RequestStatusInput = {
  op: "request.status";
  request_id?: string | undefined;
  uri?: string | undefined;
  project_id?: string | undefined;
  limit?: number | undefined;
};

export type HotspotPlanInput = {
  op: "hotspot.plan";
  project_id: string;
  session_id: string;
  input_id: string;
  text: string;
  branch_ref?: string | undefined;
  source?: string | undefined;
  budget_bytes?: number | undefined;
  min_score?: number | undefined;
  max_memories?: number | undefined;
  capacity?: number | undefined;
  timeout_ms?: number | undefined;
  /** Memory ids already delivered this session; rebuilds the injection ledger. */
  delivered?: string[] | undefined;
};

export type DetectorEvidenceInput = {
  id: string;
  kind: "history" | "memory";
  provider: string;
  source_instance: string;
  session_id: string;
  timestamp: string;
  text: string;
  source: WireSourceRef;
  /** True for entries that are new since the last checkpoint. */
  is_new?: boolean | undefined;
};

export type DetectorRunInput = {
  op: "detector.run";
  project_id: string;
  session_id: string;
  /** Seen-session ids; unioned with the project's hotspot pool. */
  memory_ids?: string[] | undefined;
  evidence: DetectorEvidenceInput[];
  model_id?: string | undefined;
  max_candidates?: number | undefined;
};

export type StalePublishEvent = {
  memory_id: string;
  observed_revision: number;
  reason: string;
  excerpt: string;
  sources: WireSourceRef[];
  producer: "detector" | "agent";
  at?: string | undefined;
  branch_ref?: string | null | undefined;
};

export type StalePublishInput = {
  op: "stale.publish";
  project_id?: string | undefined;
  repair?: boolean | undefined;
  events: StalePublishEvent[];
};

export type ResolvePersistInput = {
  op: "resolve.persist";
  /** The deferred persistence request carried on the resolve outcome. */
  request: unknown;
};

export type NavRunInput = {
  op: "nav.run";
  limit?: number | undefined;
  memory_id?: string | undefined;
  revision?: number | undefined;
};

export type RepairMemoryInput = {
  op: "repair.memory";
  project_id: string;
  uri: string;
  at?: string | undefined;
};

export type RepairMemoriesInput = {
  op: "repair.memories";
  project_id: string;
  /** Seen ids; unioned with the project's hotspot pool. */
  memory_ids?: string[] | undefined;
  at?: string | undefined;
  max_memories?: number | undefined;
};

export type RequestWriteInput = {
  op: "request.write";
  project_id?: string | undefined;
  session_id: string;
  branch_ref?: string | undefined;
  /** Defaults to the project scope the job is running in. */
  scope?: { kind: "project"; project_id: string } | { kind: "global" } | undefined;
  intent: string;
  /** Defaults to the first 80 characters of `intent`. */
  title?: string | undefined;
  evidence: { source: WireSourceRef; excerpt: string }[];
  at?: string | undefined;
};

export type RequestProcessInput = {
  op: "request.process";
  project_id?: string | undefined;
  at?: string | undefined;
  limit?: number | undefined;
  nav_limit?: number | undefined;
};

export type HotspotCommitInput = {
  op: "hotspot.commit";
  project_id: string;
  session_id: string;
  input_id: string;
  /** The exact `InjectionPlan` returned by `hotspot.plan`. */
  plan: unknown;
  /** Memory ids already delivered before this commit; rebuilds the ledger. */
  delivered?: string[] | undefined;
  at?: string | undefined;
  activity_seq?: number | undefined;
};

export type SessionInputInput = {
  op: "session.input";
  project_id: string;
  session_id: string;
  input_id: string;
  text: string;
  source?: string | undefined;
  branch_ref?: string | undefined;
  budget_bytes?: number | undefined;
  min_score?: number | undefined;
  max_memories?: number | undefined;
  capacity?: number | undefined;
  timeout_ms?: number | undefined;
  delivered?: string[] | undefined;
};

export type UsageSearchHitsInput = {
  op: "usage.search_hits";
  session_id: string;
  input_id: string;
  hits: { memory_id: string; revision: number }[];
  at?: string | undefined;
};

export type UsageMemoryReadInput = {
  op: "usage.memory_read";
  project_id: string;
  session_id: string;
  input_id: string;
  memory_id: string;
  revision: number;
  at?: string | undefined;
};

export type MemoryOpInput =
  | MemorySearchInput
  | MemoryReadInput
  | MemoryResolveInput
  | RequestStatusInput
  | HotspotPlanInput
  | DetectorRunInput
  | StalePublishInput
  | ResolvePersistInput
  | NavRunInput
  | RepairMemoryInput
  | RepairMemoriesInput
  | RequestWriteInput
  | RequestProcessInput
  | HotspotCommitInput
  | SessionInputInput
  | UsageSearchHitsInput
  | UsageMemoryReadInput;

/* ---------------------------------------------------------------- validation */

export class MemoryContractError extends TypeError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MemoryContractError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new MemoryContractError(code, message);
}

export function asRecord(value: unknown, label = "input"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("not_object", `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Validates the shared envelope and returns the op-discriminated input. */
export function parseMemoryJobInput(value: unknown): MemoryJobInput {
  const record = asRecord(value);
  if (!isMemoryOp(record["op"])) {
    fail("unknown_op", `input.op must be one of ${MEMORY_OPS.join(", ")}`);
  }
  return record as MemoryJobInput;
}

export function requireString(input: Record<string, unknown>, field: string, max = 8192): string {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail("invalid_field", `${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

export function optionalString(input: Record<string, unknown>, field: string, max = 8192): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail("invalid_field", `${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

export function optionalBoolean(input: Record<string, unknown>, field: string): boolean | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") fail("invalid_field", `${field} must be a boolean`);
  return value;
}

export function optionalInteger(input: Record<string, unknown>, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail("invalid_field", `${field} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

export function requireRecord(input: Record<string, unknown>, field: string): Record<string, unknown> {
  return asRecord(input[field], field);
}

export function requireRecordArray(input: Record<string, unknown>, field: string, max = 64): Record<string, unknown>[] {
  const value = input[field];
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    fail("invalid_field", `${field} must be a non-empty array of at most ${max} objects`);
  }
  return value.map((item, index) => asRecord(item, `${field}[${index}]`));
}
