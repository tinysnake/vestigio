/**
 * The OBS-05 model-call point: one observed event per `complete`, and the
 * invocation file the daemon and the CLI write.
 *
 * The decorator is the only seam the model port exposes. These tests pin that
 * it reports faithfully, that it never changes what the caller receives, and
 * that a port built without `onCall` writes nothing at all.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelPort, ModelRequest, ModelResult } from "@vestigio/core/resolver";
import {
	createModelInvocationRecorder,
	createObsLog,
	type ModelCallEvent,
	type ModelInvocationContext,
} from "@vestigio/core/observability";
import { createAgentModelPort, observeModelCalls } from "../src/index.js";

const OK: ModelResult = {
	ok: true,
	value: {
		text: "{}",
		usage: { tokens_in: 12, tokens_out: 3, cost_usd: null },
		model: "m",
		finish_reason: "stop",
	},
};

function judgeRequest(layer: string): ModelRequest {
	return {
		messages: [{ role: "user", content: `question: what?\nproject: global\nlayer: ${layer}\ncandidates:` }],
		max_output_tokens: 64,
		expect_json: true,
		user_agent: "vestigio/resolver",
		signal: new AbortController().signal,
	};
}

function portReturning(result: ModelResult, seen: ModelRequest[] = []): ModelPort {
	return {
		async complete(request) {
			seen.push(request);
			return result;
		},
	};
}

function context(invocation_id: string, agent: ModelInvocationContext["agent"]): ModelInvocationContext {
	return { invocation_id, agent, project_id: "p", session_id: "s", input_id: invocation_id, question: "what?" };
}

type StoredRecord = {
	type: string;
	round?: number;
	purpose?: string;
	layer?: string;
	response?: { usage?: { tokens_in?: number; tokens_out?: number; cost_usd?: number | null } };
	calls?: number;
	tokens?: { in?: number; out?: number };
};

function readRecords(path: string): StoredRecord[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as StoredRecord);
}

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "vestigio-model-log-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("observeModelCalls", () => {
	it("reports one event per complete with the request, the result and the elapsed time", async () => {
		const events: ModelCallEvent[] = [];
		const port = observeModelCalls(portReturning(OK), (event) => events.push(event));
		const first = judgeRequest("active");
		const second = judgeRequest("archived");

		await port.complete(first);
		await port.complete(second);

		expect(events).toHaveLength(2);
		expect(events[0]?.request).toBe(first);
		expect(events[1]?.request).toBe(second);
		expect(events[0]?.result).toBe(OK);
		for (const event of events) expect(event.elapsed_ms).toBeGreaterThanOrEqual(0);
	});

	it("keeps a failed result unchanged and still reports it", async () => {
		const failure: ModelResult = { ok: false, status: "failed", reason: "boom" };
		const events: ModelCallEvent[] = [];
		const port = observeModelCalls(portReturning(failure), (event) => events.push(event));

		const result = await port.complete(judgeRequest("active"));

		expect(result).toBe(failure);
		expect(events).toHaveLength(1);
		expect(events[0]?.result).toEqual({ ok: false, status: "failed", reason: "boom" });
	});

	it("returns the model result even when the observer throws", async () => {
		const port = observeModelCalls(portReturning(OK), () => {
			throw new Error("observer exploded");
		});

		await expect(port.complete(judgeRequest("active"))).resolves.toBe(OK);
	});

	it("writes no record when the port is used without onCall", async () => {
		const dir = tempDir();
		const log = createObsLog({ dir, kind: "model" });
		const recorder = createModelInvocationRecorder(log);
		const port = createAgentModelPort({ base_url: "http://127.0.0.1:1/v1", model: "base" }, {}, () => portReturning(OK));

		await recorder.run(context("plain", "resolver"), () => port.complete(judgeRequest("active")));
		log.close();

		expect(existsSync(join(dir, "context", "model", "resolver__plain.jsonl"))).toBe(false);
	});

	it("records start, one call per complete and end in the invocation file", async () => {
		const dir = tempDir();
		const log = createObsLog({ dir, kind: "model" });
		const recorder = createModelInvocationRecorder(log);
		const port = createAgentModelPort(
			{ base_url: "http://127.0.0.1:1/v1", model: "base" },
			{},
			() => portReturning(OK),
			recorder.observer,
		);

		const returned = await recorder.run(context("inv-1", "resolver"), async () => {
			await port.complete(judgeRequest("active"));
			await port.complete(judgeRequest("archived"));
			// The resolve's medium_summary round speaks for extraction, and must
			// stay in the resolver's invocation file.
			await port.complete({ ...judgeRequest("active"), user_agent: "vestigio/extraction" });
			return "done";
		});
		log.close();

		expect(returned).toBe("done");
		const records = readRecords(join(dir, "context", "model", "resolver__inv-1.jsonl"));
		expect(records.map((record) => record.type)).toEqual([
			"model_invocation_start",
			"model_call",
			"model_call",
			"model_call",
			"model_invocation_end",
		]);
		const calls = records.filter((record) => record.type === "model_call");
		expect(calls.map((call) => call.round)).toEqual([0, 1, 2]);
		expect(calls.map((call) => call.purpose)).toEqual(["judge_expand", "judge_expand", "medium_summary"]);
		expect(calls.map((call) => call.layer)).toEqual(["active", "archived", "history"]);
		expect(calls[0]?.response?.usage).toEqual({ tokens_in: 12, tokens_out: 3, cost_usd: null });
		const end = records.at(-1);
		expect(end?.calls).toBe(3);
		expect(end?.tokens).toEqual({ in: 36, out: 9 });
	});
});
