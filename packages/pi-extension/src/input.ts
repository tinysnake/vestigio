/**
 * The `input` handler: plan, commit, append.
 *
 * Only the `input` event can rewrite the user's text (measured in
 * `docs/probes/pi-input-findings.md`), and only via a `transform` result. The
 * append is all-or-nothing: any guard that fails returns `{action:"continue"}`
 * with the original text, never a partial block.
 *
 * The commit happens before the transform is returned, so a receipt exists only
 * for a block pi is actually about to deliver, and the ledger only advances for
 * the receipts that succeeded — a failed or budget-excluded turn can inject on a
 * later turn.
 */

import type { ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { commitInjection, planInjection, recordProjectInput } from "@vestigio/core/hotspots";
import type { CommitResult, InjectionPlan } from "@vestigio/core/hotspots";
import type { LedgerEntryHost } from "./ledger-store.js";
import { hashQuery } from "./decision-log.js";
import { errorText, nowIso, type VestigioState } from "./state.js";

export function handleInput(
	state: VestigioState,
	event: InputEvent,
	ctx: ExtensionContext,
	host: LedgerEntryHost,
): InputEventResult {
	const handlerStarted = performance.now();
	const source = event.source;
	const streaming = event.streamingBehavior ?? null;
	const base = {
		ts: nowIso(),
		source,
		streaming_behavior: streaming,
		session_id: state.currentSessionId,
		branch_ref: state.currentBranchRef,
		// Identity for a shadow trace without keeping the user's words.
		query_hash: hashQuery(event.text),
		query_chars: Array.from(event.text).length,
	} as const;

	// Never match a message the extension itself sent.
	if (source === "extension") {
		state.writeDecision({ ...base, kind: "input", status: "not_injected", reason: "extension_source" });
		return { action: "continue" };
	}

	// Record the real input so other hooks can read the operator's own words for
	// this turn. This handler never writes a memory request, and it never reads
	// or mutates one: saving is the agent's decision, not this pipeline's.
	state.noteUserInput(event.text);

	const store = state.ensureStore();
	if (store === null) {
		state.writeDecision({
			...base,
			kind: "input",
			status: "not_injected",
			reason: "store_unavailable",
			error: state.storeFailureReason,
		});
		return { action: "continue" };
	}

	const projectId = state.projectId(ctx.cwd);
	const inputId = state.nextInputId();
	const at = nowIso();

	let activitySeq = 0;
	try {
		activitySeq = recordProjectInput(store, projectId, at).activity_seq;
	} catch (error) {
		state.writeDecision({
			...base,
			kind: "input",
			status: "not_injected",
			reason: "store_error",
			input_id: inputId,
			project_id: projectId,
			error: errorText(error),
		});
		return { action: "continue" };
	}

	let plan: InjectionPlan;
	try {
		plan = planInjection({
			store,
			project_id: projectId,
			session_id: state.currentSessionId,
			branch_ref: state.currentBranchRef,
			input_id: inputId,
			text: event.text,
			source,
			streaming_behavior: streaming,
			// pi checks its own commands first and expands skills/templates before
			// the model sees the input, so a leading slash is never plain text.
			host_command: event.text.startsWith("/"),
			ledger: state.currentLedger,
			budget_bytes: state.config.budget_bytes,
			max_memories: state.config.max_memories,
			min_score: state.config.min_score,
			capacity: state.config.pool_capacity,
			timeout_ms: state.config.timeout_ms,
		});
	} catch (error) {
		state.writeDecision({
			...base,
			kind: "input",
			status: "not_injected",
			reason: "store_error",
			input_id: inputId,
			project_id: projectId,
			elapsed_ms: performance.now() - handlerStarted,
			error: errorText(error),
		});
		return { action: "continue" };
	}

	if (plan.status !== "injected") {
		state.writeDecision({
			...base,
			kind: "input",
			status: "not_injected",
			reason: plan.reason,
			input_id: inputId,
			project_id: projectId,
			matched: plan.matched.length,
			elapsed_ms: plan.elapsed_ms,
			handler_ms: performance.now() - handlerStarted,
		});
		return { action: "continue" };
	}

	let commit: CommitResult;
	try {
		commit = commitInjection({
			plan,
			store,
			ledger: state.currentLedger,
			at,
			activity_seq: activitySeq,
		});
	} catch (error) {
		state.writeDecision({
			...base,
			kind: "input",
			status: "not_injected",
			reason: "commit_failed",
			input_id: inputId,
			project_id: projectId,
			matched: plan.matched.length,
			elapsed_ms: plan.elapsed_ms,
			handler_ms: performance.now() - handlerStarted,
			error: errorText(error),
		});
		return { action: "continue" };
	}

	// A receipt is the durable record that this memory was delivered in this
	// branch. Without one the ledger stays untouched, so delivering the block
	// would let the same memory be appended again on the next turn. Report the
	// failure instead: a missing reminder beats a duplicate one.
	if (commit.delivered.length !== plan.injected.length) {
		state.writeDecision({
			...base,
			kind: "input",
			status: "not_injected",
			reason: "receipt_failed",
			input_id: inputId,
			project_id: projectId,
			matched: plan.matched.length,
			injected: plan.injected.length,
			detail: `receipts=${commit.receipts}/${plan.injected.length}`,
			elapsed_ms: plan.elapsed_ms,
			handler_ms: performance.now() - handlerStarted,
			error: commit.errors.length === 0 ? null : commit.errors.join("; "),
		});
		return { action: "continue" };
	}

	if (commit.delta !== null) state.recordDelta(commit.delta, host);

	state.writeDecision({
		...base,
		kind: "input",
		status: "injected",
		reason: null,
		input_id: inputId,
		project_id: projectId,
		matched: plan.matched.length,
		injected: plan.injected.length,
		// Ids, not text: a shadow run can name what was delivered and what the
		// budget dropped without reading any memory body back out of the log.
		matched_ids: plan.matched.map((match) => match.memory_id),
		memory_ids: plan.injected.map((match) => match.memory_id),
		stale_ids: plan.injected
			.filter((match) => match.freshness.is_stale)
			.map((match) => match.memory_id),
		block_bytes: plan.budget.used_bytes,
		estimated_tokens: plan.budget.estimated_tokens,
		elapsed_ms: plan.elapsed_ms,
		handler_ms: performance.now() - handlerStarted,
		ledger_added: commit.ledger_added.length,
		// Statistics failures are worth showing but did not stop the delivery.
		error: commit.errors.length === 0 ? null : commit.errors.join("; "),
	});

	return { action: "transform", text: plan.text };
}
