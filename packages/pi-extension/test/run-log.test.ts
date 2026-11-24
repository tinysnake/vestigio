import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunRecord } from "@vestigio/core/observability";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentRunRecorder, INJECTION_OUTCOMES, registerAgentRunRecorder, type AgentRunRecorderOptions } from "../src/run-log.js";

const IDENTITY = {
	session_id: "s1",
	session_file: "/tmp/s.jsonl",
	project_id: "/proj",
	project_path: "/proj",
	branch_ref: "root",
};

type Clock = { ms: number };

function makeCtx(
	usage: { tokens: number | null; contextWindow: number } | null,
	entries: unknown[] = [],
): ExtensionContext {
	return {
		getContextUsage: () => usage ?? undefined,
		sessionManager: { getEntries: () => entries },
	} as unknown as ExtensionContext;
}

function make(clock: Clock, overrides: Partial<AgentRunRecorderOptions> = {}) {
	const records: AgentRunRecord[] = [];
	const errors: unknown[] = [];
	const recorder = new AgentRunRecorder({
		storePath: "/tmp/store.sqlite",
		identity: () => IDENTITY,
		append: (record) => {
			records.push(record);
		},
		now: () => clock.ms,
		newRunId: () => "run-1",
		report: (error) => {
			errors.push(error);
		},
		...overrides,
	});
	return { recorder, records, errors };
}

const turnStart = (turnIndex = 0) => ({ turnIndex, timestamp: 0 }) as never;
const turnEnd = (toolResults: unknown) => ({ turnIndex: 0, toolResults }) as never;
const settled = (aborted: boolean) => ({ aborted }) as never;
const assistant = (usage?: unknown, provider = "anthropic", model = "claude-x") =>
	({ message: usage === undefined ? { role: "assistant", provider, model } : { role: "assistant", provider, model, usage } }) as never;
const tool = (toolCallId: string, toolName: string, status?: string, isError = false) =>
	({ toolCallId, toolName, isError, result: status === undefined ? {} : { details: { status } } }) as never;
const modelSelect = (provider: string, id: string) => ({ model: { provider, id } }) as never;

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number, cost: number) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: total,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

describe("AgentRunRecorder", () => {
	it("summarizes turns, models, tokens, tools and injections for one run", () => {
		const clock: Clock = { ms: 1_000 };
		const { recorder, records } = make(clock);
		recorder.onTurnStart(turnStart(), makeCtx({ tokens: 500, contextWindow: 200_000 }));
		recorder.onMessageEnd(assistant(usage(100, 50, 10, 5, 165, 0.01)));
		recorder.onToolExecutionEnd(tool("c1", "memory_search", "resolved"));
		recorder.onToolExecutionEnd(tool("c2", "memory_search", "not_found"));
		recorder.onToolExecutionEnd(tool("c3", "memory_read", undefined, true));
		recorder.onModelSelect(modelSelect("anthropic", "claude-y"));
		recorder.noteInjection("delivered", { injected: 2, matched: 3, stale: 1 });
		recorder.noteInjection("no_match");
		// turn_end repeats an already-seen result and adds one the hook never saw.
		recorder.onTurnEnd(
			turnEnd([
				{ toolCallId: "c1", toolName: "memory_search", isError: false },
				{ toolCallId: "c9", toolName: "custom_tool", isError: false },
			]),
			makeCtx(null),
		);
		clock.ms = 1_500;
		recorder.onAgentSettled(settled(false), makeCtx({ tokens: 900, contextWindow: 200_000 }));

		expect(records).toHaveLength(1);
		const record = records[0]!;
		expect(record.turns).toBe(1);
		expect(record.outcome).toBe("completed");
		expect(record.duration_ms).toBe(500);
		expect(record.models).toEqual(["anthropic/claude-x", "anthropic/claude-y"]);
		expect(record.tokens).toEqual({
			input: 100,
			output: 50,
			cache_read: 10,
			cache_write: 5,
			total: 165,
			cost_usd: 0.01,
			complete: true,
		});
		expect(record.context).toEqual({ start_tokens: 500, end_tokens: 900, context_window: 200_000 });
		expect(record.tools.calls).toEqual({ memory_search: 2, memory_read: 1, custom_tool: 1 });
		expect(record.tools.status).toEqual({
			memory_search: { resolved: 1, not_found: 1 },
			memory_read: { error: 1 },
			custom_tool: { ok: 1 },
		});
		expect(record.injection).toEqual({
			delivered_turns: 1,
			injected: 2,
			matched: 3,
			stale: 1,
			outcome_counts: { delivered: 1, no_match: 1, all_deduped: 0, over_budget: 0, timeout: 0, store_unavailable: 0, host_command: 0 },
		});
		expect(Object.keys(record.injection.outcome_counts).sort()).toEqual([...INJECTION_OUTCOMES].sort());
	});

	it("carries ids, counts, durations and tokens only", () => {
		const clock: Clock = { ms: 0 };
		const { recorder, records } = make(clock);
		recorder.onTurnStart(turnStart(), makeCtx(null));
		recorder.onAgentSettled(settled(false), makeCtx(null));
		const record = records[0]!;
		expect(Object.keys(record).sort()).toEqual(
			["branch_ref", "context", "duration_ms", "ended_at", "error", "injection", "models", "outcome", "project_id", "project_path", "run_id", "session_file", "session_id", "started_at", "tokens", "tools", "turns", "type", "v"].sort(),
		);
		expect(Object.keys(record.tokens).sort()).toEqual(["cache_read", "cache_write", "complete", "cost_usd", "input", "output", "total"].sort());
		expect(Object.keys(record.tools).sort()).toEqual(["calls", "status"]);
		expect(Object.keys(record.context).sort()).toEqual(["context_window", "end_tokens", "start_tokens"]);
		expect(Object.keys(record.injection).sort()).toEqual(["delivered_turns", "injected", "matched", "outcome_counts", "stale"]);
	});

	it("marks tokens incomplete when an assistant message has no usage", () => {
		const clock: Clock = { ms: 0 };
		const { recorder, records } = make(clock);
		recorder.onTurnStart(turnStart(), makeCtx(null));
		recorder.onMessageEnd(assistant());
		recorder.onMessageEnd(assistant(usage(10, 0, 0, 0, 10, 0.001)));
		recorder.onAgentSettled(settled(false), makeCtx(null));
		expect(records[0]!.tokens.complete).toBe(false);
		expect(records[0]!.tokens.total).toBe(10);
	});

	it("reports an aborted run when the agent settled via Escape", () => {
		const clock: Clock = { ms: 0 };
		const { recorder, records } = make(clock);
		recorder.onTurnStart(turnStart(), makeCtx(null));
		recorder.onAgentSettled(settled(true), makeCtx(null));
		expect(records[0]!.outcome).toBe("aborted");
	});

	it("counts usage entries written during this run and ignores earlier ones", () => {
		const clock: Clock = { ms: 1_000 };
		const { recorder, records } = make(clock);
		const entries = [
			{ type: "usage", timestamp: new Date(900).toISOString(), usage: usage(1_000, 0, 0, 0, 1_000, 1) },
			{ type: "usage", timestamp: new Date(1_200).toISOString(), usage: usage(7, 3, 0, 0, 10, 0.002) },
			{ type: "message", timestamp: new Date(1_200).toISOString() },
		];
		recorder.onTurnStart(turnStart(), makeCtx({ tokens: 10, contextWindow: 1_000 }, entries));
		recorder.onAgentSettled(settled(false), makeCtx({ tokens: 20, contextWindow: 1_000 }, entries));
		expect(records[0]!.tokens).toEqual({ input: 7, output: 3, cache_read: 0, cache_write: 0, total: 10, cost_usd: 0.002, complete: true });
	});

	it("writes on settle even when a hook throws", () => {
		const clock: Clock = { ms: 0 };
		const { recorder, records, errors } = make(clock);
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi = {
			on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
				handlers.set(name, handler);
			},
		};
		registerAgentRunRecorder(pi as never, {
			storePath: "/tmp/store.sqlite",
			identity: () => IDENTITY,
			env: {},
			append: (record) => {
				records.push(record);
			},
			now: () => clock.ms,
			newRunId: () => "run-1",
			report: (error) => {
				errors.push(error);
			},
		});
		handlers.get("turn_start")!(turnStart(), makeCtx(null));
		// toolResults is undefined: onTurnEnd throws, the guard must swallow it.
		handlers.get("turn_end")!({ turnIndex: 0 }, makeCtx(null));
		handlers.get("message_end")!(assistant(usage(1, 2, 3, 4, 10, 0.001)), makeCtx(null));
		handlers.get("agent_settled")!(settled(false), makeCtx(null));
		expect(errors).toHaveLength(1);
		expect(records).toHaveLength(1);
		expect(records[0]!.tokens.total).toBe(10);
		void recorder;
	});

	it("writes the default stream under the store, and honors VESTIGIO_OBS_DIR", () => {
		const dir = mkdtempSync(join(tmpdir(), "vestigio-runs-"));
		try {
			const clock: Clock = { ms: 0 };
			const storePath = join(dir, "store.sqlite");
			const { recorder } = make(clock, { storePath, env: {}, append: undefined });
			recorder.onTurnStart(turnStart(), makeCtx(null));
			recorder.onAgentSettled(settled(false), makeCtx(null));
			const lines = readFileSync(join(`${storePath}.observability`, "agent-runs.jsonl"), "utf8").trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ type: "agent_run", v: 1, session_id: "s1" });

			const override = join(dir, "obs");
			const second = make(clock, { env: { VESTIGIO_OBS_DIR: override }, append: undefined });
			second.recorder.onTurnStart(turnStart(), makeCtx(null));
			second.recorder.onAgentSettled(settled(false), makeCtx(null));
			expect(readFileSync(join(override, "agent-runs.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
