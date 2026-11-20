/**
 * The handler the daemon calls for every memory job.
 *
 * One entry point, three kinds. Read-only operations answer from the store and
 * never write; the detector makes its one model call and stops at the write
 * boundary; maintenance operations are the only ones that write. Every write a
 * read or detector needs is reported as a deferred dependency, which the handler
 * either hands to the daemon's control plane (a durable child job, the parent
 * yields) or, when no control plane exists, executes inline if it was raised
 * from inside the maintenance slot, or reports unscheduled.
 */

import {
  MemoryContractError,
  kindOfOp,
  optionalString,
  parseMemoryJobInput,
  type DeferredMemoryJob,
  type MemoryJobControl,
  type MemoryJobHandler,
  type MemoryJobInput,
  type MemoryJobResult,
  type MemoryOp,
} from "./contract.js";
import { runDetectorOp } from "./detector.js";
import { deferredRef, type DependencyRequest, type OpContext, type OpOutcome } from "./internal.js";
import { runMaintenanceOp } from "./maintenance.js";
import type { MemoryRuntime } from "./runtime.js";
import { runReadOp } from "./search.js";

export function createMemoryJobHandler(runtime: MemoryRuntime): MemoryJobHandler {
  return async (job, signal, control) => {
    const input = parseMemoryJobInput(job.input);
    const kind = kindOfOp(input.op);
    if (job.kind !== kind) {
      throw new MemoryContractError("kind_mismatch", `job kind ${job.kind} cannot carry operation ${input.op}`);
    }
    const ctx: OpContext = {
      runtime,
      job: { jobId: job.jobId, kind: job.kind, session: job.session, input: job.input },
      signal,
      project_id: optionalString(input, "project_id", 1024) ?? runtime.project_id,
      session: job.session,
    };
    const turnLeaf = optionalString(input, "turn_leaf", 1024);
    const op = await execute(input, ctx);
    const deferred = await schedule(op.deferred, ctx, control);
    const result: MemoryJobResult = {
      ...(turnLeaf === undefined ? {} : { turnLeaf }),
      op: input.op,
      kind,
      result: op.result,
      text: op.text,
      deferred,
      notes: op.notes,
    };
    return result;
  };
}

function execute(input: MemoryJobInput, ctx: OpContext): Promise<OpOutcome> {
  switch (kindOfOp(input.op)) {
    case "search":
      return runReadOp(input, ctx);
    case "detector":
      return runDetectorOp(input, ctx);
    case "maintenance":
      return runMaintenanceOp(input, ctx);
  }
}

async function schedule(
  requests: readonly DependencyRequest[],
  ctx: OpContext,
  control: MemoryJobControl | undefined,
): Promise<DeferredMemoryJob[]> {
  const scheduled: DeferredMemoryJob[] = [];
  for (const request of requests) {
    const kind = kindOfOp(request.op);
    if (control !== undefined) {
      const child = await control.defer(kind, request.input, request.key === undefined ? {} : { key: request.key });
      scheduled.push(deferredRef(request, "enqueued", child.jobId, kind));
      continue;
    }
    // No control plane: a dependency raised inside the maintenance slot may run
    // in place, because that slot is already the serialization boundary. One
    // raised from a read or a detector stays unscheduled and is reported.
    if (request.inline && ctx.job.kind === "maintenance") {
      await execute(request.input, { ...ctx, job: { ...ctx.job } });
      scheduled.push(deferredRef(request, "inline", null, kind));
      continue;
    }
    scheduled.push(deferredRef(request, "pending", null, kind));
  }
  return scheduled;
}

/** The operation each kind routes to, for the compatibility report and tests. */
export function routeOf(op: MemoryOp): "search" | "detector" | "maintenance" {
  return kindOfOp(op);
}
