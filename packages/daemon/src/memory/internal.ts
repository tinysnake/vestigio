/**
 * Internal glue shared by the operation modules. Not part of the wire contract:
 * `contract.ts` is what a client may import; this file speaks in the runtime
 * types the daemon owns.
 */

import type { Kind, SessionKey } from "../protocol.js";
import type { SourceRef } from "@vestigio/core";
import { asRecord, optionalString, requireString, MemoryContractError } from "./contract.js";
import type { DeferredStatus, MemoryJobInput, MemoryJobShape, MemoryOp } from "./contract.js";
import type { MemoryRuntime } from "./runtime.js";

/**
 * A write an operation will not perform itself. `inline` is the handler's
 * classification: only a dependency raised from inside an already-serialized
 * maintenance job may run in place, so a read or a detector never widens its own
 * concurrency by writing.
 */
export type DependencyRequest = {
  op: MemoryOp;
  input: MemoryJobInput;
  inline: boolean;
  key?: string | undefined;
};

export type OpContext = {
  runtime: MemoryRuntime;
  job: MemoryJobShape;
  signal: AbortSignal;
  /** Project the operation is scoped to; the input's, else the runtime default. */
  project_id: string | null;
  session: SessionKey;
};

export type OpOutcome = {
  result: unknown;
  text: string | null;
  deferred: DependencyRequest[];
  notes: string[];
};

export function outcome(partial: Partial<OpOutcome> = {}): OpOutcome {
  return {
    result: partial.result ?? null,
    text: partial.text ?? null,
    deferred: partial.deferred ?? [],
    notes: partial.notes ?? [],
  };
}

export function dependency(
  op: MemoryOp,
  input: MemoryJobInput,
  options: { inline: boolean; key?: string | undefined },
): DependencyRequest {
  const request: DependencyRequest = { op, input, inline: options.inline };
  if (options.key !== undefined) request.key = options.key;
  return request;
}

export function deferredRef(
  request: DependencyRequest,
  status: DeferredStatus,
  jobId: string | null,
  kind: Kind,
): { key: string; kind: Kind; op: MemoryOp; status: DeferredStatus; jobId: string | null; input: MemoryJobInput } {
  return { key: request.key ?? request.op, kind, op: request.op, status, jobId, input: request.input };
}

/** Validate a wire `SourceRef`; every anchor a stale event stores must be real. */
export function parseSourceRef(value: unknown, defaultProjectId: string | null): SourceRef {
  const record = asRecord(value, "source");
  if (record["project_id"] === undefined && defaultProjectId !== null) record["project_id"] = defaultProjectId;
  try {
    return {
      provider: requireString(record, "provider", 256),
      source_instance: requireString(record, "source_instance", 256),
      session_id: requireString(record, "session_id", 256),
      message_id: requireString(record, "message_id", 1024),
      parent_message_id: record.parent_message_id === null ? null : optionalString(record, "parent_message_id", 1024) ?? null,
      project_id: optionalString(record, "project_id", 1024) ?? "",
      timestamp: requireString(record, "timestamp", 256),
      content_hash: optionalString(record, "content_hash", 256) ?? "",
      locator: record.locator === null ? null : optionalString(record, "locator", 1024) ?? null,
    };
  } catch (error) {
    if (error instanceof MemoryContractError) throw error;
    throw new MemoryContractError("invalid_source", error instanceof Error ? error.message : String(error));
  }
}

/** A non-empty string array with an explicit ceiling, for repeated `string[]` fields. */
export function stringArray(value: unknown, field: string, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new MemoryContractError("invalid_field", `${field} must be an array of at most ${max} strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new MemoryContractError("invalid_field", `${field}[${index}] must be a non-empty string`);
    }
    return item;
  });
}
