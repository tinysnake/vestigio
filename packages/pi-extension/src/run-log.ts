/**
 * OBS-02: one `agent_run` summary row per agent run.
 *
 * A run starts at the first `turn_start` after the previous settle and ends at
 * `agent_settled`, which pi emits once per agent run. The record carries ids,
 * counts, durations and tokens only — never message bodies, prompts or input
 * text.
 *
 * Every hook body is wrapped in try/catch by `registerAgentRunRecorder`: a
 * throwing hook is logged through `report` and never changes the turn's flow.
 * The OBS-01 writer never throws into the extension.
 */

import { randomUUID } from "node:crypto";
import type {
	AgentRunRecord,
	AgentRunTools,
	ObsLog,
	ObsLogOptions,
} from "@vestigio/core/observability";
import { createObsLog } from "@vestigio/core/observability";
import type {
	AgentSettledEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	ModelSelectEvent,
	ToolExecutionEndEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

/** File kind for the OBS-01 writer: `<obs dir>/agent-runs.jsonl`. */
export const AGENT_RUNS_KIND = "agent-runs";
/** Overrides the default `<store>.observability` directory. */
export const OBS_DIR_ENV = "VESTIGIO_OBS_DIR";
/** Overrides the OBS-01 directory byte cap. */
export const OBS_MAX_BYTES_ENV = "VESTIGIO_OBS_MAX_BYTES";

/**
 * Canonical injection outcomes (plan §2.1). Every key is present in
 * `outcome_counts`, zeroed when it never happened.
 */
export const INJECTION_OUTCOMES = [
	"delivered",
	"no_match",
	"all_deduped",
	"over_budget",
	"timeout",
	"store_unavailable",
	"host_command",
] as const;

/** Identity of the session an agent run belongs to. */
export type AgentRunIdentity = {
	readonly session_id: string;
	readonly session_file: string;
	readonly project_id: string;
	readonly project_path: string;
	readonly branch_ref: string;
};

/** Structural view of pi's `Usage`, so the recorder avoids a deep import. */
type UsageShape = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost?: { readonly total?: number } | undefined;
};

export type AgentRunRecorderOptions = {
	/** Absolute path of the vestigio store; default obs dir is `${storePath}.observability`. */
	storePath: string;
	/** Identity of the run's session, resolved from the hook context. */
	identity: (ctx: ExtensionContext) => AgentRunIdentity;
	/** Environment used for the OBS switches. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv | undefined;
	/** Explicit obs directory (tests, or a caller with its own resolution). */
	obsDir?: string | undefined;
	/** Explicit directory byte cap (tests). */
	maxBytes?: number | undefined;
	/** Sink for finished records. Defaults to the OBS-01 JSONL log. */
	append?: ((record: AgentRunRecord) => void) | undefined;
	/** Millisecond clock. Defaults to `Date.now`. */
	now?: (() => number) | undefined;
	/** Run id factory. Defaults to `randomUUID`. */
	newRunId?: (() => string) | undefined;
	/** Debug logger for swallowed exceptions. Defaults to a no-op. */
	report?: ((error: unknown) => void) | undefined;
};

/** Accumulates one agent run and writes it as a single `agent_run` record. */
export class AgentRunRecorder {
	private readonly identity: (ctx: ExtensionContext) => AgentRunIdentity;
	private readonly append: (record: AgentRunRecord) => void;
	private readonly now: () => number;
	private readonly newRunId: () => string;

	private runId: string | null = null;
	private startedMs = 0;
	private runIdentity: AgentRunIdentity | null = null;

	private turns = 0;
	private readonly models: string[] = [];
	private readonly modelSeen = new Set<string>();

	private readonly toolCalls = new Map<string, number>();
	private readonly toolStatus = new Map<string, Map<string, number>>();
	private readonly seenToolCallIds = new Set<string>();

	private inputTokens = 0;
	private outputTokens = 0;
	private cacheReadTokens = 0;
	private cacheWriteTokens = 0;
	private totalTokens = 0;
	private costSum = 0;
	private costSeen = false;
	private costComplete = true;
	private usageComplete = true;

	private startTokens: number | null = null;
	private endTokens: number | null = null;
	private contextWindow = 0;

	private deliveredTurns = 0;
	private injected = 0;
	private matched = 0;
	private stale = 0;
	private readonly outcomeCounts = new Map<string, number>();

	constructor(options: AgentRunRecorderOptions) {
		this.identity = options.identity;
		this.now = options.now ?? Date.now;
		this.newRunId = options.newRunId ?? (() => randomUUID());
		this.append = options.append ?? buildSink(options);
	}

	/** Starts the run on the first turn and counts turns. */
	onTurnStart(_event: TurnStartEvent, ctx: ExtensionContext): void {
		if (this.runId === null) this.begin(ctx);
		this.turns += 1;
	}

	/**
	 * Records tool results the extension hook did not see. `tool_execution_end`
	 * fires for every tool the agent runs, so this is a defensive fallback rather
	 * than the primary path.
	 */
	onTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): void {
		if (this.runId === null) this.begin(ctx);
		for (const result of event.toolResults) {
			if (this.seenToolCallIds.has(result.toolCallId)) continue;
			this.addToolCall(result.toolName, result.isError ? "error" : "ok");
		}
	}

	/** Adds an assistant message's usage; a message without usage lowers the total. */
	onMessageEnd(event: MessageEndEvent): void {
		if (this.runId === null) return;
		const message = event.message;
		if (message.role !== "assistant") return;
		const usage = message.usage as UsageShape | undefined;
		if (usage === undefined || usage === null) {
			this.usageComplete = false;
			return;
		}
		this.absorbUsage(usage);
		this.addModel(`${message.provider}/${message.model}`);
	}

	/** Counts a tool call and its status. */
	onToolExecutionEnd(event: ToolExecutionEndEvent): void {
		if (this.runId === null) return;
		if (typeof event.toolCallId === "string") this.seenToolCallIds.add(event.toolCallId);
		this.addToolCall(event.toolName, classifyToolStatus(event));
	}

	/** Remembers the model a turn ran on. */
	onModelSelect(event: ModelSelectEvent): void {
		if (this.runId === null) return;
		this.addModel(`${event.model.provider}/${event.model.id}`);
	}

	/** Finalizes the run and writes one `agent_run` record. */
	onAgentSettled(event: AgentSettledEvent, ctx: ExtensionContext): void {
		if (this.runId === null) return;
		this.settle(event.aborted, ctx);
	}

	/**
	 * Records an injection outcome from the input handler. Called where the
	 * existing handler already decides `status`/`reason`, so no second `input`
	 * hook is registered.
	 */
	noteInjection(
		outcome: string,
		counts?: { injected?: number; matched?: number; stale?: number } | undefined,
	): void {
		const bucket = normalizeOutcome(outcome);
		this.outcomeCounts.set(bucket, (this.outcomeCounts.get(bucket) ?? 0) + 1);
		if (bucket === "delivered") this.deliveredTurns += 1;
		this.injected += counts?.injected ?? 0;
		this.matched += counts?.matched ?? 0;
		this.stale += counts?.stale ?? 0;
	}

	private begin(ctx: ExtensionContext): void {
		this.runId = this.newRunId();
		this.startedMs = this.now();
		this.runIdentity = this.identity(ctx);
		const usage = ctx.getContextUsage();
		this.startTokens = usage ? usage.tokens : null;
		this.contextWindow = usage?.contextWindow ?? 0;
	}

	private settle(aborted: boolean, ctx: ExtensionContext): void {
		const endedMs = this.now();
		// Sum only usage entries written during this run. Summing the whole branch
		// would re-count a resumed session's earlier runs.
		this.absorbRunUsageEntries(ctx);
		const usage = ctx.getContextUsage();
		this.endTokens = usage ? usage.tokens : null;
		this.contextWindow = usage?.contextWindow ?? this.contextWindow;

		const identity = this.runIdentity;
		if (identity === null) {
			this.reset();
			return;
		}
		const record: AgentRunRecord = {
			type: "agent_run",
			v: 1,
			run_id: this.runId ?? "",
			session_id: identity.session_id,
			session_file: identity.session_file,
			project_id: identity.project_id,
			project_path: identity.project_path,
			branch_ref: identity.branch_ref,
			started_at: new Date(this.startedMs).toISOString(),
			ended_at: new Date(endedMs).toISOString(),
			duration_ms: Math.max(0, endedMs - this.startedMs),
			models: [...this.models],
			turns: this.turns,
			outcome: aborted ? "aborted" : "completed",
			tokens: {
				input: this.inputTokens,
				output: this.outputTokens,
				cache_read: this.cacheReadTokens,
				cache_write: this.cacheWriteTokens,
				total: this.totalTokens,
				cost_usd: this.costComplete && this.costSeen ? this.costSum : null,
				complete: this.usageComplete,
			},
			context: {
				start_tokens: this.startTokens,
				end_tokens: this.endTokens,
				context_window: this.contextWindow,
			},
			tools: this.snapshotTools(),
			injection: {
				delivered_turns: this.deliveredTurns,
				injected: this.injected,
				matched: this.matched,
				stale: this.stale,
				outcome_counts: this.snapshotOutcomeCounts(),
			},
			error: null,
		};
		this.reset();
		this.append(record);
	}

	private reset(): void {
		this.runId = null;
		this.startedMs = 0;
		this.runIdentity = null;
		this.turns = 0;
		this.models.length = 0;
		this.modelSeen.clear();
		this.toolCalls.clear();
		this.toolStatus.clear();
		this.seenToolCallIds.clear();
		this.inputTokens = 0;
		this.outputTokens = 0;
		this.cacheReadTokens = 0;
		this.cacheWriteTokens = 0;
		this.totalTokens = 0;
		this.costSum = 0;
		this.costSeen = false;
		this.costComplete = true;
		this.usageComplete = true;
		this.startTokens = null;
		this.endTokens = null;
		this.contextWindow = 0;
		this.deliveredTurns = 0;
		this.injected = 0;
		this.matched = 0;
		this.stale = 0;
		this.outcomeCounts.clear();
	}

	private absorbRunUsageEntries(ctx: ExtensionContext): void {
		let entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;
		try {
			entries = ctx.sessionManager.getEntries();
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.type !== "usage") continue;
			const at = Date.parse(entry.timestamp);
			if (!Number.isFinite(at) || at < this.startedMs) continue;
			this.absorbUsage(entry.usage);
		}
	}

	private absorbUsage(usage: UsageShape): void {
		const input = numberOrZero(usage.input);
		const output = numberOrZero(usage.output);
		const cacheRead = numberOrZero(usage.cacheRead);
		const cacheWrite = numberOrZero(usage.cacheWrite);
		this.inputTokens += input;
		this.outputTokens += output;
		this.cacheReadTokens += cacheRead;
		this.cacheWriteTokens += cacheWrite;
		const reported = numberOrZero(usage.totalTokens);
		this.totalTokens += reported > 0 ? reported : input + output + cacheRead + cacheWrite;
		const cost = usage.cost?.total;
		if (typeof cost === "number" && Number.isFinite(cost)) {
			this.costSum += cost;
			this.costSeen = true;
		} else {
			this.costComplete = false;
		}
	}

	private addModel(model: string): void {
		if (model === "/" || this.modelSeen.has(model)) return;
		this.modelSeen.add(model);
		this.models.push(model);
	}

	private addToolCall(toolName: string, status: string): void {
		const name = toolName === "" ? "unknown" : toolName;
		this.toolCalls.set(name, (this.toolCalls.get(name) ?? 0) + 1);
		let statuses = this.toolStatus.get(name);
		if (statuses === undefined) {
			statuses = new Map<string, number>();
			this.toolStatus.set(name, statuses);
		}
		statuses.set(status, (statuses.get(status) ?? 0) + 1);
	}

	private snapshotTools(): AgentRunTools {
		const calls: Record<string, number> = {};
		for (const [name, count] of this.toolCalls) calls[name] = count;
		const status: Record<string, Record<string, number>> = {};
		for (const [name, counts] of this.toolStatus) {
			const bucket: Record<string, number> = {};
			for (const [key, count] of counts) bucket[key] = count;
			status[name] = bucket;
		}
		return { calls, status };
	}

	private snapshotOutcomeCounts(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const key of INJECTION_OUTCOMES) counts[key] = 0;
		for (const [key, count] of this.outcomeCounts) counts[key] = (counts[key] ?? 0) + count;
		return counts;
	}
}

/** Creates the recorder and registers its six hooks. */
export function registerAgentRunRecorder(
	pi: ExtensionAPI,
	options: AgentRunRecorderOptions,
): AgentRunRecorder {
	const recorder = new AgentRunRecorder(options);
	const report = options.report ?? (() => {});
	const guard = (body: () => void): void => {
		try {
			body();
		} catch (error) {
			try {
				report(error);
			} catch {
				// A throwing report must not change the turn's flow either.
			}
		}
	};
	pi.on("turn_start", (event, ctx) => guard(() => recorder.onTurnStart(event, ctx)));
	pi.on("turn_end", (event, ctx) => guard(() => recorder.onTurnEnd(event, ctx)));
	pi.on("message_end", (event) => guard(() => recorder.onMessageEnd(event)));
	pi.on("tool_execution_end", (event) => guard(() => recorder.onToolExecutionEnd(event)));
	pi.on("agent_settled", (event, ctx) => guard(() => recorder.onAgentSettled(event, ctx)));
	pi.on("model_select", (event) => guard(() => recorder.onModelSelect(event)));
	return recorder;
}

function classifyToolStatus(event: ToolExecutionEndEvent): string {
	if (event.isError) return "error";
	const result = event.result as
		| { details?: { status?: unknown } | undefined; status?: unknown }
		| undefined;
	const fromDetails = result?.details?.status;
	if (typeof fromDetails === "string" && fromDetails !== "") return fromDetails;
	const fromResult = result?.status;
	if (typeof fromResult === "string" && fromResult !== "") return fromResult;
	return "ok";
}

/** Collapses pi's not-injected reasons onto the plan's outcome keys. */
function normalizeOutcome(outcome: string): string {
	if (outcome === "extension_source" || outcome === "slash_command") return "host_command";
	return outcome === "" ? "no_match" : outcome;
}

function numberOrZero(value: number): number {
	return Number.isFinite(value) ? value : 0;
}

function parseBytes(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function resolveObsDir(options: AgentRunRecorderOptions): string | null {
	if (options.obsDir !== undefined && options.obsDir !== "") return options.obsDir;
	const envDir = options.env?.[OBS_DIR_ENV];
	if (envDir !== undefined && envDir !== "") return envDir;
	return options.storePath === "" ? null : `${options.storePath}.observability`;
}

function buildSink(options: AgentRunRecorderOptions): (record: AgentRunRecord) => void {
	let log: ObsLog | null = null;
	try {
		const dir = resolveObsDir(options);
		if (dir !== null) {
			const maxBytes = options.maxBytes ?? parseBytes(options.env?.[OBS_MAX_BYTES_ENV]);
			const logOptions: ObsLogOptions =
				maxBytes === undefined
					? { dir, kind: AGENT_RUNS_KIND }
					: { dir, kind: AGENT_RUNS_KIND, maxBytes };
			log = createObsLog(logOptions);
		}
	} catch {
		log = null;
	}
	const sink = log;
	return (record) => {
		sink?.append(record);
	};
}
