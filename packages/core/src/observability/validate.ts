/**
 * Write-time validation for observability records (OBS-01).
 *
 * The writer runs this before touching disk so a malformed record is rejected
 * with a reason and nothing is written. It is deliberately a shape check, not
 * a semantic one: timestamps only have to parse, counters only have to be
 * finite numbers. `validateObsRecord` never throws and never mutates.
 */

import { AGENT_NAMES } from "../resolver/types.js";
import { OBS_RECORD_VERSION } from "./records.js";
import type { ObsRecord } from "./records.js";

export type ObsRecordParse =
	| { readonly ok: true; readonly record: ObsRecord }
	| { readonly ok: false; readonly reason: string };

type Dict = Record<string, unknown>;

function isPlainObject(value: unknown): value is Dict {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function needString(o: Dict, key: string): string | null {
	return typeof o[key] === "string" ? null : `${key} must be a string`;
}

function needNullableString(o: Dict, key: string): string | null {
	const value = o[key];
	return value === null || typeof value === "string" ? null : `${key} must be a string or null`;
}

function needNumber(o: Dict, key: string): string | null {
	const value = o[key];
	return typeof value === "number" && Number.isFinite(value) ? null : `${key} must be a finite number`;
}

function needNullableNumber(o: Dict, key: string): string | null {
	const value = o[key];
	return value === null || (typeof value === "number" && Number.isFinite(value))
		? null
		: `${key} must be a finite number or null`;
}

function needBoolean(o: Dict, key: string): string | null {
	return typeof o[key] === "boolean" ? null : `${key} must be a boolean`;
}

function needTimestamp(o: Dict, key: string): string | null {
	const value = o[key];
	return typeof value === "string" && !Number.isNaN(Date.parse(value))
		? null
		: `${key} must be an ISO timestamp string`;
}

function needOneOf(o: Dict, key: string, allowed: readonly string[]): string | null {
	const value = o[key];
	return typeof value === "string" && allowed.includes(value) ? null : `${key} must be one of ${allowed.join(", ")}`;
}

function needStringArray(o: Dict, key: string): string | null {
	const value = o[key];
	if (!Array.isArray(value)) return `${key} must be an array`;
	return value.every((item) => typeof item === "string") ? null : `${key} must contain only strings`;
}

function needNumberRecord(o: Dict, key: string): string | null {
	const value = o[key];
	if (!isPlainObject(value)) return `${key} must be an object`;
	return Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item))
		? null
		: `${key} must map to finite numbers`;
}

function validateTokens(value: unknown): string | null {
	if (!isPlainObject(value)) return "tokens must be an object";
	return (
		needNumber(value, "input") ??
		needNumber(value, "output") ??
		needNumber(value, "cache_read") ??
		needNumber(value, "cache_write") ??
		needNumber(value, "total") ??
		needNullableNumber(value, "cost_usd") ??
		needBoolean(value, "complete")
	);
}

function validateContext(value: unknown): string | null {
	if (!isPlainObject(value)) return "context must be an object";
	return (
		needNullableNumber(value, "start_tokens") ??
		needNullableNumber(value, "end_tokens") ??
		needNumber(value, "context_window")
	);
}

function validateTools(value: unknown): string | null {
	if (!isPlainObject(value)) return "tools must be an object";
	const calls = needNumberRecord(value, "calls");
	if (calls !== null) return calls;
	const status = value["status"];
	if (!isPlainObject(status)) return "tools.status must be an object";
	for (const [name, counts] of Object.entries(status)) {
		if (!isPlainObject(counts)) return `tools.status.${name} must be an object`;
		const bad = Object.entries(counts).find(([, count]) => typeof count !== "number" || !Number.isFinite(count));
		if (bad !== undefined) return `tools.status.${name}.${bad[0]} must be a finite number`;
	}
	return null;
}

function validateInjection(value: unknown): string | null {
	if (!isPlainObject(value)) return "injection must be an object";
	return (
		needNumber(value, "delivered_turns") ??
		needNumber(value, "injected") ??
		needNumber(value, "matched") ??
		needNumber(value, "stale") ??
		needNumberRecord(value, "outcome_counts")
	);
}

function validateAgentRun(o: Dict): string | null {
	return (
		needString(o, "run_id") ??
		needString(o, "session_id") ??
		needString(o, "session_file") ??
		needString(o, "project_id") ??
		needString(o, "project_path") ??
		needString(o, "branch_ref") ??
		needTimestamp(o, "started_at") ??
		needTimestamp(o, "ended_at") ??
		needNumber(o, "duration_ms") ??
		needStringArray(o, "models") ??
		needNumber(o, "turns") ??
		needOneOf(o, "outcome", ["completed", "aborted", "error"]) ??
		validateTokens(o["tokens"]) ??
		validateContext(o["context"]) ??
		validateTools(o["tools"]) ??
		validateInjection(o["injection"]) ??
		needNullableString(o, "error")
	);
}

function validateInvocationStart(o: Dict): string | null {
	return (
		needString(o, "invocation_id") ??
		needOneOf(o, "agent", AGENT_NAMES) ??
		needString(o, "project_id") ??
		needString(o, "session_id") ??
		needString(o, "input_id") ??
		needTimestamp(o, "at") ??
		needString(o, "question")
	);
}

function validateCallRequest(value: unknown): string | null {
	if (!isPlainObject(value)) return "request must be an object";
	if (!Array.isArray(value["messages"])) return "request.messages must be an array";
	return (
		needNumber(value, "max_output_tokens") ??
		needBoolean(value, "expect_json") ??
		needString(value, "thinking")
	);
}

function validateCallResponse(value: unknown): string | null {
	if (!isPlainObject(value)) return "response must be an object";
	const usage = value["usage"];
	if (!isPlainObject(usage)) return "response.usage must be an object";
	return (
		needString(value, "text") ??
		needString(value, "finish_reason") ??
		needNumber(usage, "tokens_in") ??
		needNumber(usage, "tokens_out") ??
		needNullableNumber(usage, "cost_usd")
	);
}

function validateModelCall(o: Dict): string | null {
	return (
		needString(o, "call_id") ??
		needString(o, "invocation_id") ??
		needNumber(o, "round") ??
		needOneOf(o, "purpose", ["judge_expand", "medium_summary"]) ??
		needString(o, "layer") ??
		needString(o, "model") ??
		needTimestamp(o, "at") ??
		needNumber(o, "elapsed_ms") ??
		validateCallRequest(o["request"]) ??
		validateCallResponse(o["response"]) ??
		needOneOf(o, "outcome", ["ok", "error"])
	);
}

function validateInvocationEnd(o: Dict): string | null {
	const tokens = o["tokens"];
	const tokenError = isPlainObject(tokens) ? needNumber(tokens, "in") ?? needNumber(tokens, "out") : "tokens must be an object";
	return (
		needString(o, "invocation_id") ??
		needTimestamp(o, "at") ??
		needNumber(o, "calls") ??
		tokenError ??
		needNullableNumber(o, "cost_usd") ??
		needOneOf(o, "outcome", ["ok", "sufficient", "insufficient", "failed", "cancelled"])
	);
}

function validateRoutes(value: unknown): string | null {
	if (!isPlainObject(value)) return "routes must be an object";
	for (const [route, counts] of Object.entries(value)) {
		if (!isPlainObject(counts)) return `routes.${route} must be an object`;
		for (const bucket of ["2xx", "4xx", "5xx", "total"]) {
			const error = needNumber(counts, bucket);
			if (error !== null) return `routes.${route}.${error}`;
		}
	}
	return null;
}

function validateIfaceSnapshot(o: Dict): string | null {
	return (
		needTimestamp(o, "at") ??
		needTimestamp(o, "since") ??
		needNumber(o, "window_ms") ??
		needString(o, "scope") ??
		validateRoutes(o["routes"]) ??
		needNumberRecord(o, "reasons")
	);
}

const VALIDATORS: Readonly<Record<string, (o: Dict) => string | null>> = {
	agent_run: validateAgentRun,
	model_invocation_start: validateInvocationStart,
	model_call: validateModelCall,
	model_invocation_end: validateInvocationEnd,
	iface_snapshot: validateIfaceSnapshot,
};

export function validateObsRecord(value: unknown): ObsRecordParse {
	if (!isPlainObject(value)) return { ok: false, reason: "record must be a plain object" };
	if (value["v"] !== OBS_RECORD_VERSION) return { ok: false, reason: `v must be ${OBS_RECORD_VERSION}` };
	const type = value["type"];
	if (typeof type !== "string") return { ok: false, reason: "type must be a string" };
	const validate = VALIDATORS[type];
	if (validate === undefined) return { ok: false, reason: `unknown record type: ${type}` };
	const reason = validate(value);
	if (reason !== null) return { ok: false, reason };
	return { ok: true, record: value as unknown as ObsRecord };
}
