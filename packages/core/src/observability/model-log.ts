/**
 * Model-call observation (OBS-05).
 *
 * The model-client decorator reports one {@link ModelCallEvent} per `complete`
 * that reached a client. This module turns those events into the §2.2 record
 * shape: one file per invocation at `context/model/<agent>__<invocation_id>.jsonl`
 * holding a start line, one `model_call` per round, and an end line.
 *
 * Events are only grouped when the caller opened an invocation on the same
 * async path, so a port wrapper can stay ignorant of resolve-internal identity.
 * The grouping is ambient (AsyncLocalStorage) rather than part of `ModelRequest`
 * because the request shape is fixed and the resolver's call sites are outside
 * OBS-05's write set.
 *
 * Nothing here may block, slow, or fail a model call: the observer swallows its
 * own errors, the writer never throws, and a recorder whose switch is off is
 * simply never created.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { AGENT_USER_AGENT, type AgentName, type ModelRequest, type ModelResult } from "../resolver/types.js";
import { OBS_RECORD_VERSION, type ModelCallPurpose } from "./records.js";
import { createObsLog, type ObsLog, type ObsStream } from "./writer.js";

/** One settled model call, as seen by the decorator. */
export type ModelCallEvent = {
	readonly request: ModelRequest;
	readonly result: ModelResult;
	readonly elapsed_ms: number;
};

/** The decorator's observer hook. It must never throw in a way that reaches the call. */
export type ModelCallObserver = (event: ModelCallEvent) => void;

/** Identity shared by every model call of one operation. */
export type ModelInvocationContext = {
	readonly invocation_id: string;
	readonly agent: AgentName;
	readonly project_id: string;
	readonly session_id: string;
	readonly input_id: string;
	readonly question: string;
};

export type ModelInvocationRecorder = {
	readonly observer: ModelCallObserver;
	run<T>(context: ModelInvocationContext, fn: () => Promise<T>): Promise<T>;
};

export type ModelLogEnv = {
	readonly [key: string]: string | undefined;
};

export const MODEL_LOG_ENV = "VESTIGIO_MODEL_LOG";
export const MODEL_LOG_DIR_ENV = "VESTIGIO_OBS_DIR";
export const MODEL_LOG_MAX_BYTES_ENV = "VESTIGIO_OBS_MAX_BYTES";

/**
 * The model log only exists when `VESTIGIO_MODEL_LOG=1`. With the switch off
 * this returns null, so no directory is created and the call path is unchanged.
 */
export function modelLogFromEnv(env: ModelLogEnv, storePath: string): ObsLog | null {
	if (env[MODEL_LOG_ENV] !== "1") {
		return null;
	}
	const dir = env[MODEL_LOG_DIR_ENV] ?? `${storePath}.observability`;
	const maxBytes = positiveInt(env[MODEL_LOG_MAX_BYTES_ENV]);
	return createObsLog({ dir, kind: "model", ...(maxBytes === undefined ? {} : { maxBytes }) });
}

type InvocationState = {
	readonly context: ModelInvocationContext;
	stream: ObsStream | null;
	round: number;
	tokens_in: number;
	tokens_out: number;
	cost_usd: number | null;
	failed: boolean;
	cancelled: boolean;
	live: boolean;
};

const ACTIVE = new AsyncLocalStorage<InvocationState>();

/** The stream is created lazily, so an invocation with zero model calls writes no file. */
function openStream(log: ObsLog, context: ModelInvocationContext): ObsStream {
	return log.openRun(`context/model/${context.agent}__${context.invocation_id}`);
}

export function createModelInvocationRecorder(log: ObsLog): ModelInvocationRecorder {
	const start = (state: InvocationState): ObsStream => {
		const stream = openStream(log, state.context);
		stream.append({
			type: "model_invocation_start",
			v: OBS_RECORD_VERSION,
			invocation_id: state.context.invocation_id,
			agent: state.context.agent,
			project_id: state.context.project_id,
			session_id: state.context.session_id,
			input_id: state.context.input_id,
			at: new Date().toISOString(),
			question: state.context.question,
		});
		return stream;
	};

	const record = (state: InvocationState, event: ModelCallEvent): void => {
		if (!state.live) {
			return;
		}
		try {
			state.stream ??= start(state);
			const ok = event.result.ok;
			const usage = ok ? event.result.value.usage : null;
			const tokens_in = usage?.tokens_in ?? 0;
			const tokens_out = usage?.tokens_out ?? 0;
			const cost_usd = usage?.cost_usd ?? null;
			const { purpose, layer } = classify(event.request);
			state.stream.append({
				type: "model_call",
				v: OBS_RECORD_VERSION,
				call_id: `${state.context.invocation_id}:${state.round}`,
				invocation_id: state.context.invocation_id,
				round: state.round,
				purpose,
				layer,
				model: ok ? event.result.value.model : (event.request.model ?? ""),
				at: new Date().toISOString(),
				elapsed_ms: Math.max(0, Math.round(event.elapsed_ms)),
				request: {
					messages: event.request.messages,
					max_output_tokens: event.request.max_output_tokens,
					expect_json: event.request.expect_json,
					thinking: event.request.thinking ?? "off",
				},
				response: ok
					? {
							text: event.result.value.text,
							finish_reason: event.result.value.finish_reason ?? "",
							usage: { tokens_in, tokens_out, cost_usd },
						}
					: {
							text: event.result.reason,
							finish_reason: event.result.status,
							usage: { tokens_in: 0, tokens_out: 0, cost_usd: null },
						},
				outcome: ok ? "ok" : "error",
			});
			state.round += 1;
			state.tokens_in += tokens_in;
			state.tokens_out += tokens_out;
			state.cost_usd = addCost(state.cost_usd, cost_usd);
			if (!ok) {
				if (event.result.status === "cancelled") {
					state.cancelled = true;
				} else {
					state.failed = true;
				}
			}
		} catch {
			/* Observation never affects the model call. */
		}
	};

	const finish = (state: InvocationState): void => {
		state.live = false;
		if (state.stream === null) {
			return;
		}
		try {
			state.stream.append({
				type: "model_invocation_end",
				v: OBS_RECORD_VERSION,
				invocation_id: state.context.invocation_id,
				at: new Date().toISOString(),
				calls: state.round,
				tokens: { in: state.tokens_in, out: state.tokens_out },
				cost_usd: state.cost_usd,
				outcome: state.cancelled ? "cancelled" : state.failed ? "failed" : "ok",
			});
		} catch {
			/* Observation never affects the model call. */
		}
	};

	return {
		observer: (event) => {
			const state = ACTIVE.getStore();
			if (state !== undefined) {
				record(state, event);
			}
		},
		async run(context, fn) {
			const state: InvocationState = {
				context,
				stream: null,
				round: 0,
				tokens_in: 0,
				tokens_out: 0,
				cost_usd: null,
				failed: false,
				cancelled: false,
				live: true,
			};
			try {
				return await ACTIVE.run(state, fn);
			} finally {
				finish(state);
			}
		},
	};
}

function classify(request: ModelRequest): { purpose: ModelCallPurpose; layer: string } {
	switch (request.user_agent) {
		case AGENT_USER_AGENT.resolver:
			return { purpose: "judge_expand", layer: layerOfJudge(request) };
		case AGENT_USER_AGENT.extraction:
			return { purpose: "medium_summary", layer: "history" };
		case AGENT_USER_AGENT.detector:
			return { purpose: "detector", layer: "" };
		case AGENT_USER_AGENT.nav:
			return { purpose: "nav", layer: "" };
		default:
			return { purpose: "judge_expand", layer: "" };
	}
}

function layerOfJudge(request: ModelRequest): string {
	for (const message of request.messages) {
		if (message.role !== "user") {
			continue;
		}
		const match = /^layer:[ \t]*(\S+)/mu.exec(message.content);
		if (match !== null) {
			return match[1] ?? "";
		}
	}
	return "";
}

function addCost(total: number | null, cost: number | null): number | null {
	if (cost === null) {
		return total;
	}
	return (total ?? 0) + cost;
}

function positiveInt(raw: string | undefined): number | undefined {
	if (raw === undefined || !/^\d+$/u.test(raw)) {
		return undefined;
	}
	const value = Number(raw);
	return value > 0 ? value : undefined;
}
