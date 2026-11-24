/**
 * Record contracts for the rotating observability log (OBS-01).
 *
 * Five logical records share one JSONL shape: a `type` discriminant plus
 * `v` for forward compatibility. The shapes are the plan's section 2, so
 * OBS-02 (agent runs), OBS-04 (interface snapshots) and OBS-05 (internal model
 * calls) can write and read them without reinterpretation. Nothing here reads
 * a log back; these are contracts and diagnosis aids.
 */

import type { AgentName } from "../resolver/types.js";

export const OBS_RECORD_VERSION = 1 as const;

export type AgentRunOutcome = "completed" | "aborted" | "error";
export type ModelCallOutcome = "ok" | "error";
export type ModelCallPurpose = "judge_expand" | "medium_summary" | "detector" | "nav";
export type ModelInvocationOutcome = "ok" | "sufficient" | "insufficient" | "failed" | "cancelled";

export type AgentRunTokens = {
	readonly input: number;
	readonly output: number;
	readonly cache_read: number;
	readonly cache_write: number;
	readonly total: number;
	readonly cost_usd: number | null;
	/** False when at least one assistant message carried no `usage`; `total` is then a lower bound. */
	readonly complete: boolean;
};

export type AgentRunContext = {
	readonly start_tokens: number | null;
	readonly end_tokens: number | null;
	readonly context_window: number;
};

export type AgentRunTools = {
	readonly calls: Readonly<Record<string, number>>;
	readonly status: Readonly<Record<string, Readonly<Record<string, number>>>>;
};

export type AgentRunInjection = {
	readonly delivered_turns: number;
	readonly injected: number;
	readonly matched: number;
	readonly stale: number;
	readonly outcome_counts: Readonly<Record<string, number>>;
};

export type AgentRunRecord = {
	readonly type: "agent_run";
	readonly v: typeof OBS_RECORD_VERSION;
	readonly run_id: string;
	readonly session_id: string;
	readonly session_file: string;
	readonly project_id: string;
	readonly project_path: string;
	readonly branch_ref: string;
	readonly started_at: string;
	readonly ended_at: string;
	readonly duration_ms: number;
	readonly models: readonly string[];
	readonly turns: number;
	readonly outcome: AgentRunOutcome;
	readonly tokens: AgentRunTokens;
	readonly context: AgentRunContext;
	readonly tools: AgentRunTools;
	readonly injection: AgentRunInjection;
	readonly error: string | null;
};

export type ModelInvocationStartRecord = {
	readonly type: "model_invocation_start";
	readonly v: typeof OBS_RECORD_VERSION;
	readonly invocation_id: string;
	readonly agent: AgentName;
	readonly project_id: string;
	readonly session_id: string;
	readonly input_id: string;
	readonly at: string;
	readonly question: string;
};

export type ModelCallRequest = {
	readonly messages: readonly unknown[];
	readonly max_output_tokens: number;
	readonly expect_json: boolean;
	readonly thinking: string;
};

export type ModelUsageTokens = {
	readonly tokens_in: number;
	readonly tokens_out: number;
	readonly cost_usd: number | null;
};

export type ModelCallResponse = {
	readonly text: string;
	readonly finish_reason: string;
	readonly usage: ModelUsageTokens;
};

export type ModelCallRecord = {
	readonly type: "model_call";
	readonly v: typeof OBS_RECORD_VERSION;
	readonly call_id: string;
	readonly invocation_id: string;
	readonly round: number;
	readonly purpose: ModelCallPurpose;
	readonly layer: string;
	readonly model: string;
	readonly at: string;
	readonly elapsed_ms: number;
	readonly request: ModelCallRequest;
	readonly response: ModelCallResponse;
	readonly outcome: ModelCallOutcome;
};

export type ModelInvocationEndRecord = {
	readonly type: "model_invocation_end";
	readonly v: typeof OBS_RECORD_VERSION;
	readonly invocation_id: string;
	readonly at: string;
	readonly calls: number;
	readonly tokens: { readonly in: number; readonly out: number };
	readonly cost_usd: number | null;
	readonly outcome: ModelInvocationOutcome;
};

export type IfaceRouteCounts = {
	readonly "2xx": number;
	readonly "4xx": number;
	readonly "5xx": number;
	readonly total: number;
};

export type IfaceSnapshotRecord = {
	readonly type: "iface_snapshot";
	readonly v: typeof OBS_RECORD_VERSION;
	readonly at: string;
	readonly since: string;
	readonly window_ms: number;
	readonly scope: string;
	readonly routes: Readonly<Record<string, IfaceRouteCounts>>;
	readonly reasons: Readonly<Record<string, number>>;
};

export type ObsRecord =
	| AgentRunRecord
	| ModelInvocationStartRecord
	| ModelCallRecord
	| ModelInvocationEndRecord
	| IfaceSnapshotRecord;
