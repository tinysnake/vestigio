/**
 * The `agent_end` detector: the only place Vestigio makes a model call on its
 * own. It runs after a completed turn, looks at the memories the agent actually
 * met this session, plus the ones the store already flags, and records at most one
 * stale event per distinct change the summary has not absorbed.
 *
 * It is deliberately bounded and best-effort: one model call, one deadline,
 * candidates capped by the core, evidence capped by the core. It never starts a
 * user turn, never rewrites a summary, and any failure is logged without
 * breaking the completed turn. The checkpoint only advances after a clean run,
 * so a failure is retried later — and a retry is a no-op because the event id is
 * derived from the canonical anchors, not from the attempt.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { INJECTION_BLOCK_CLOSE, INJECTION_BLOCK_OPEN } from "@vestigio/core/hotspots";
import type { FreshnessBrief, SourceRef } from "@vestigio/core";
import { DETECTOR_MAX_EVIDENCE, detectStale } from "@vestigio/core/stale";
import type { DetectorEvidence, DetectorResult, StaleCandidate } from "@vestigio/core/stale";
import type { MemoryStore } from "@vestigio/core/storage";
import { errorText, nowIso, type VestigioState } from "./state.js";
import { memoryUriOf, sessionEntryText, sourceRefForEntry } from "./session-source.js";

export const DETECTOR_TIMEOUT_MS = 15_000;
export const DETECTOR_MAX_ENTRIES = 200;

export type DetectorSessionManager = {
	getBranch(): SessionEntry[];
	getLeafId(): string | null;
	getSessionId(): string;
	getSessionFile(): string | null | undefined;
};

export type DetectorSkipReason =
	| "no_model"
	| "no_new_entries"
	| "no_candidates"
	| "no_evidence"
	| "session_switched"
	| "running";

export type DetectorRunOutcome = {
	status: "ok" | "none" | "skipped" | "failed";
	reason: DetectorSkipReason | null;
	/** Events actually written (new rows). */
	recorded: number;
	/** Events the model reported that already existed. */
	duplicates: number;
	/** Findings the model returned. */
	detected: number;
	/** Whether a model call was made. */
	called: boolean;
	detail: string | null;
};

const IDLE: DetectorRunOutcome = {
	status: "skipped",
	reason: "running",
	recorded: 0,
	duplicates: 0,
	detected: 0,
	called: false,
	detail: null,
};

/** Remove an injected memory note before a turn is treated as evidence. */
export function stripInjectedNote(text: string): string {
	const open = text.indexOf(INJECTION_BLOCK_OPEN);
	if (open < 0) return text;
	const close = text.indexOf(INJECTION_BLOCK_CLOSE, open);
	if (close < 0) return text.slice(0, open);
	return `${text.slice(0, open)}${text.slice(close + INJECTION_BLOCK_CLOSE.length)}`;
}

function isControlEntry(entry: SessionEntry): boolean {
	if (entry.type !== "custom_message") return false;
	return entry.customType.startsWith("vestigio");
}

function freshBrief(head: number): FreshnessBrief {
	return { is_stale: false, head_revision: head, pending_count: 0, freshness_sig: "" };
}

/** Candidate memories the detector may name, restricted to this project. */
export function buildDetectorCandidates(
	store: MemoryStore,
	memoryIds: readonly string[],
	projectId: string,
): StaleCandidate[] {
	const candidates: StaleCandidate[] = [];
	for (const memoryId of memoryIds) {
		const uri = memoryUriOf(store.storeId, memoryId);
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
			freshness: store.readFreshness(uri) ?? freshBrief(memory.revision),
			pending: pending.map((event) => ({ event_id: event.event_id, reason: event.reason })),
		});
	}
	return candidates;
}

export type DetectorEvidenceRow = {
	evidence: DetectorEvidence;
	/** The canonical ref written next to the event if the model cites it. */
	source_ref: SourceRef;
};

/**
 * The evidence rows for one pass: the newest entries, each paired with its real
 * canonical ref. Injected notes and control entries are excluded, so the model
 * never sees its own instructions as evidence.
 */
export function evidenceForDetector(
	entries: readonly SessionEntry[],
	sessionFile: string | null,
	sessionId: string,
	projectId: string,
): DetectorEvidenceRow[] {
	const rows: DetectorEvidenceRow[] = [];
	for (const entry of entries) {
		if (isControlEntry(entry)) continue;
		if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "toolResult")) continue;
		const text = stripInjectedNote(sessionEntryText(entry) ?? "").trim();
		if (text.length === 0) continue;
		const sourceRef = sourceRefForEntry(entry, {
			session_id: sessionId,
			session_file: sessionFile,
			project_id: projectId,
		});
		if (sourceRef === null) continue;
		rows.push({
			evidence: {
				id: entry.id,
				kind: "history",
				provider: sourceRef.provider,
				source_instance: sourceRef.source_instance,
				session_id: sourceRef.session_id,
				timestamp: sourceRef.timestamp,
				text,
			},
			source_ref: sourceRef,
		});
	}
	return rows.slice(-DETECTOR_MAX_EVIDENCE);
}

export type DetectorRunInput = {
	state: VestigioState;
	store: MemoryStore;
	sessionManager: DetectorSessionManager;
	cwd: string;
	/** Test seam: overrides the model port. `null` forces "no_model". */
	model?: ReturnType<VestigioState["modelPort"]>;
};

/**
 * Run one detector pass. Captures the session identity before the first await
 * and refuses to write if the session, branch or project moved underneath it.
 */
export async function runStaleDetector(input: DetectorRunInput): Promise<DetectorRunOutcome> {
	const { state } = input;
	const captured = {
		session_id: state.currentSessionId,
		branch_ref: state.currentBranchRef,
		project_id: state.projectId(input.cwd),
		leaf_id: safeLeafId(input.sessionManager),
	};
	const poolIds = input.store.readHotspotMemberships(captured.project_id).map((entry) => entry.memory_id);
	const candidates = buildDetectorCandidates(input.store, [...new Set([...state.seenMemoryIds(), ...poolIds])].slice(-24), captured.project_id);
	const entries = safeEntries(input.sessionManager);
	const checkpoint = state.detectorCheckpointId;
	const fresh = checkpoint === null ? entries : entriesAfter(entries, checkpoint);
	if (checkpoint !== null && fresh.length === 0) {
		state.advanceDetectorCheckpoint(captured.leaf_id);
		return { ...IDLE, status: "skipped", reason: "no_new_entries" };
	}
	const firstNew = checkpoint === null ? 0 : Math.max(0, entries.findIndex((entry) => entry.id === checkpoint) + 1);
	const window = entries.slice(Math.max(0, firstNew - 10));
	const rows = evidenceForDetector(
		window.slice(-DETECTOR_MAX_ENTRIES),
		safeSessionFile(input.sessionManager),
		captured.session_id,
		captured.project_id,
	);
	const newIds = new Set(fresh.map((entry) => entry.id));
	const evidence = rows.map((row) => ({ ...row.evidence, text: `${newIds.has(row.evidence.id) ? "[new activity]" : "[prior context only]"} ${row.evidence.text}` }));
	if (candidates.length === 0) {
		state.advanceDetectorCheckpoint(captured.leaf_id);
		return { ...IDLE, status: "skipped", reason: "no_candidates" };
	}
	if (evidence.length === 0) {
		state.advanceDetectorCheckpoint(captured.leaf_id);
		return { ...IDLE, status: "skipped", reason: "no_evidence" };
	}
	const model = input.model !== undefined ? input.model : state.modelPort();
	if (model === null || model === undefined) {
		return { ...IDLE, status: "skipped", reason: "no_model", detail: state.modelSkipReason() };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DETECTOR_TIMEOUT_MS);
	const call = () =>
		detectStale({
			model,
			model_id: state.config.model_id,
			candidates,
			evidence,
			signal: controller.signal,
		});
	let result: DetectorResult;
	try {
		result = await call();
		// A single retry when the reply could not be parsed. The deadline is
		// shared, so the retry costs only the time left; a cancellation or a
		// transport failure is not retried, and the checkpoint still only
		// advances after a clean run.
		if (!controller.signal.aborted && unparseableReply(result)) {
			result = await call();
		}
	} catch (error) {
		state.writeDecision({
			ts: nowIso(),
			kind: "error",
			status: "detector_threw",
			session_id: captured.session_id,
			branch_ref: captured.branch_ref,
			project_id: captured.project_id,
			error: errorText(error),
		});
		return { ...IDLE, status: "failed", reason: null, detail: errorText(error) };
	} finally {
		clearTimeout(timer);
	}

	if (controller.signal.aborted || switchedAway(state, input.cwd, captured)) {
		return {
			...IDLE,
			status: "skipped",
			reason: "session_switched",
			detected: result.findings.length,
			called: true,
		};
	}

	if (result.status === "invalid" || result.status === "failed" || result.status === "cancelled") {
		state.writeDecision({
			ts: nowIso(),
			kind: "error",
			status: "detector_failed",
			session_id: captured.session_id,
			branch_ref: captured.branch_ref,
			project_id: captured.project_id,
			error: result.reason ?? result.status,
		});
		return {
			...IDLE,
			status: "failed",
			reason: null,
			detected: 0,
			called: true,
			detail: result.reason ?? result.status,
		};
	}

	const byEvidenceId = new Map(rows.map((row) => [row.evidence.id, row]));
	const candidateById = new Map(candidates.map((candidate) => [candidate.memory_id, candidate]));
	let recorded = 0;
	let duplicates = 0;
	let markFailed = false;
	const at = nowIso();
	for (const finding of result.findings) {
		const candidate = candidateById.get(finding.memory_id);
		if (candidate === undefined) continue;
		const sources: SourceRef[] = [];
		for (const evidenceId of finding.evidence_ids) {
			const row = byEvidenceId.get(evidenceId);
			if (row !== undefined) sources.push(row.source_ref);
		}
		const excerpt = firstExcerpt(finding.evidence_ids, byEvidenceId);
		if (sources.length === 0 || excerpt.trim().length === 0) continue;
		try {
			const marked = input.store.markStale({
				memory_id: finding.memory_id,
				observed_revision: candidate.revision,
				reason: finding.reason,
				excerpt,
				sources,
				producer: "detector",
				at,
				branch_ref: captured.branch_ref,
			});
			if (marked.inserted) recorded += 1;
			else duplicates += 1;
		} catch (error) {
			markFailed = true;
			state.writeDecision({
				ts: at,
				kind: "error",
				status: "detector_mark_failed",
				session_id: captured.session_id,
				branch_ref: captured.branch_ref,
				project_id: captured.project_id,
				detail: `${finding.memory_id}: ${errorText(error)}`,
			});
		}
	}

	if (!markFailed) state.advanceDetectorCheckpoint(captured.leaf_id);
	state.writeDecision({
		ts: at,
		kind: "tool_read",
		status: "detector_run",
		session_id: captured.session_id,
		branch_ref: captured.branch_ref,
		project_id: captured.project_id,
		detail: `status=${result.status} candidates=${candidates.length} evidence=${evidence.length} detected=${result.findings.length} recorded=${recorded} duplicates=${duplicates}`,
	});
	return {
		status: result.status === "ok" ? "ok" : "none",
		reason: null,
		recorded,
		duplicates,
		detected: result.findings.length,
		called: true,
		detail: result.reason,
	};
}

/**
 * True when the detector's model reply could not be turned into findings: an
 * unparseable body (`invalid`) or a client error naming a bad response shape.
 * A cancellation, a timeout or a transport failure is not retried.
 */
function unparseableReply(result: DetectorResult): boolean {
	if (result.status === "invalid") return true;
	return result.status === "failed" && (result.reason ?? "").includes("invalid_response");
}

function firstExcerpt(ids: readonly string[], byId: Map<string, DetectorEvidenceRow>): string {
	for (const id of ids) {
		const row = byId.get(id);
		if (row !== undefined) return row.evidence.text;
	}
	return "";
}

function switchedAway(
	state: VestigioState,
	cwd: string,
	captured: { session_id: string; branch_ref: string; project_id: string },
): boolean {
	return (
		state.currentSessionId !== captured.session_id ||
		state.currentBranchRef !== captured.branch_ref ||
		state.projectId(cwd) !== captured.project_id
	);
}

function entriesAfter(entries: readonly SessionEntry[], checkpoint: string): SessionEntry[] {
	const index = entries.findIndex((entry) => entry.id === checkpoint);
	if (index < 0) return [...entries];
	return entries.slice(index + 1);
}

function safeEntries(sessionManager: DetectorSessionManager): SessionEntry[] {
	try {
		return sessionManager.getBranch();
	} catch {
		return [];
	}
}

function safeLeafId(sessionManager: DetectorSessionManager): string | null {
	try {
		return sessionManager.getLeafId();
	} catch {
		return null;
	}
}

function safeSessionFile(sessionManager: DetectorSessionManager): string | null {
	try {
		const file = sessionManager.getSessionFile();
		return typeof file === "string" ? file : null;
	} catch {
		return null;
	}
}
