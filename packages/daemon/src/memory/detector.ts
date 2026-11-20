/**
 * The turn-evidence detector, moved into the daemon.
 *
 * The daemon owns the one model call; the client owns the session identity and
 * the checkpoint. The client submits the bounded evidence it gathered from the
 * completed turn (each row carrying its canonical `SourceRef`), and the daemon
 * hydrates the candidate memories from the store. The detector never writes a
 * stale event: it returns findings and a `stale.publish` maintenance dependency,
 * because publication is a write and writes belong to the maintenance slot.
 */

import { memoryUri, type MemoryId, type SourceRef } from "@vestigio/core";
import {
  DETECTOR_MAX_CANDIDATES,
  detectStale,
  type DetectorEvidence,
  type DetectorResult,
  type StaleCandidate,
} from "@vestigio/core/stale";
import type { MemoryStore } from "@vestigio/core/storage";
import {
  optionalInteger,
  optionalString,
  requireRecordArray,
  requireString,
  type MemoryJobInput,
  type StalePublishEvent,
  type WireSourceRef,
} from "./contract.js";
import {
  dependency,
  outcome,
  parseSourceRef,
  stringArray,
  type DependencyRequest,
  type OpContext,
  type OpOutcome,
} from "./internal.js";

type PreparedEvidence = { evidence: DetectorEvidence; source_ref: SourceRef; is_new: boolean };

export async function runDetectorOp(input: MemoryJobInput, ctx: OpContext): Promise<OpOutcome> {
  const project_id = optionalString(input, "project_id", 1024) ?? ctx.project_id;
  if (project_id === null) throw new Error("detector.run requires project_id or a runtime default project");
  const rows = prepareEvidence(input, ctx);
  const evidence: DetectorEvidence[] = rows.map((row) => ({
    ...row.evidence,
    text: `${row.is_new ? "[new activity]" : "[prior context only]"} ${row.evidence.text}`,
  }));
  const candidateIds = candidateIdsFor(input, ctx, project_id);
  const candidates = buildDetectorCandidates(ctx.runtime.store, candidateIds, project_id);
  if (candidates.length === 0) {
    return outcome({ result: { status: "skipped", reason: "no_candidates", detected: 0 }, notes: ["no candidates"] });
  }
  if (evidence.length === 0) {
    return outcome({ result: { status: "skipped", reason: "no_evidence", detected: 0 }, notes: ["no evidence"] });
  }
  const model = ctx.runtime.model;
  if (model === null) {
    return outcome({ result: { status: "skipped", reason: "no_model", detected: 0 }, notes: ["no model configured"] });
  }

  const signal = ctx.signal;
  const call = (): Promise<DetectorResult> =>
    detectStale({
      model,
      model_id: optionalString(input, "model_id", 256) ?? ctx.runtime.model_id,
      candidates,
      evidence,
      signal,
    });

  let result: DetectorResult;
  try {
    result = await call();
    if (!signal.aborted && unparseableReply(result)) result = await call();
  } catch (error) {
    return outcome({
      result: { status: "failed", reason: text(error), detected: 0 },
      notes: [`detector threw: ${text(error)}`],
    });
  }
  signal.throwIfAborted();
  if (result.status === "invalid" || result.status === "failed" || result.status === "cancelled") {
    return outcome({
      result: {
        status: "failed",
        reason: result.reason ?? result.status,
        failure_status: result.failure_status,
        detected: 0,
      },
      notes: [`detector ${result.status}`],
    });
  }

  const byEvidenceId = new Map(rows.map((row) => [row.evidence.id, row]));
  const candidateById = new Map(candidates.map((candidate) => [candidate.memory_id, candidate]));
  const events: StalePublishEvent[] = [];
  for (const finding of result.findings) {
    const candidate = candidateById.get(finding.memory_id);
    if (candidate === undefined) continue;
    const sources: WireSourceRef[] = [];
    for (const evidenceId of finding.evidence_ids) {
      const row = byEvidenceId.get(evidenceId);
      if (row !== undefined) sources.push(row.source_ref as WireSourceRef);
    }
    const excerpt = firstExcerpt(finding.evidence_ids, byEvidenceId);
    if (sources.length === 0 || excerpt.trim().length === 0) continue;
    events.push({
      memory_id: finding.memory_id,
      observed_revision: candidate.revision,
      reason: finding.reason,
      excerpt,
      sources,
      producer: "detector",
      branch_ref: optionalString(input, "branch_ref", 1024) ?? null,
    });
  }

  const deferred: DependencyRequest[] = [];
  if (events.length > 0) {
    deferred.push(
      dependency("stale.publish", { op: "stale.publish", events, project_id, repair: true, turn_leaf: input.turn_leaf }, { inline: false, key: `stale.publish:${ctx.job.jobId}` }),
    );
  }
  return outcome({
    result: {
      status: result.status === "ok" ? "ok" : "none",
      reason: result.reason,
      detected: result.findings.length,
      subscription: events.length,
      candidates: candidates.length,
      evidence: evidence.length,
      call: result.call,
      findings: result.findings,
      // Publication is a write; the count here is what will be published, not
      // what has been. The `deferred` entry carries the durable job.
      publish_pending: events.length,
    },
    deferred,
    notes: events.length > 0 ? [`${events.length} detector finding(s) deferred to the maintenance slot`] : [],
  });
}

function candidateIdsFor(input: MemoryJobInput, ctx: OpContext, project_id: string): string[] {
  const pool = ctx.runtime.store.readHotspotMemberships(project_id).map((entry) => entry.memory_id);
  const supplied = stringArray(input["memory_ids"], "memory_ids", DETECTOR_MAX_CANDIDATES * 4);
  const max = optionalInteger(input, "max_candidates", 1, DETECTOR_MAX_CANDIDATES) ?? DETECTOR_MAX_CANDIDATES;
  return [...new Set([...supplied, ...pool])].slice(-max);
}

/** Candidate memories the detector may name, restricted to this project. */
export function buildDetectorCandidates(
  store: MemoryStore,
  memoryIds: readonly string[],
  projectId: string,
): StaleCandidate[] {
  const candidates: StaleCandidate[] = [];
  for (const memoryId of memoryIds) {
    const uri = memoryUri(store.storeId, memoryId as MemoryId);
    let memory: ReturnType<MemoryStore["readMemory"]>;
    try {
      memory = store.readMemory(uri);
    } catch {
      continue;
    }
    if (memory === null) continue;
    if (memory.scope.kind === "project" && memory.scope.project_id !== projectId) continue;
    const pending = store.listPendingStaleEvents(memoryId);
    candidates.push({
      memory_id: memory.memory_id,
      uri: memory.uri,
      title: memory.title,
      revision: memory.revision,
      summary: memory.medium.body,
      freshness: store.readFreshness(uri) ?? { is_stale: false, head_revision: memory.revision, pending_count: 0, freshness_sig: "" },
      pending: pending.map((event) => ({ event_id: event.event_id, reason: event.reason })),
    });
  }
  return candidates;
}

function prepareEvidence(input: MemoryJobInput, ctx: OpContext): PreparedEvidence[] {
  const rows = requireRecordArray(input, "evidence", 512);
  const prepared: PreparedEvidence[] = [];
  for (const row of rows) {
    const is_new = row["is_new"] === true;
    prepared.push({
      evidence: {
        id: requireString(row, "id", 256),
        kind: row["kind"] === "memory" ? "memory" : "history",
        provider: requireString(row, "provider", 256),
        source_instance: requireString(row, "source_instance", 256),
        session_id: requireString(row, "session_id", 256),
        timestamp: requireString(row, "timestamp", 256),
        text: requireString(row, "text", 200_000),
      },
      source_ref: parseSourceRef(row["source"], ctx.project_id),
      is_new,
    });
  }
  return prepared;
}

function firstExcerpt(ids: readonly string[], byId: Map<string, PreparedEvidence>): string {
  for (const id of ids) {
    const row = byId.get(id);
    if (row !== undefined) return row.evidence.text;
  }
  return "";
}

function unparseableReply(result: DetectorResult): boolean {
  return result.status === "invalid" || result.failure_status === "invalid_response";
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
