/**
 * The daemon memory handler, at the layer the daemon actually calls it.
 *
 * Two kinds of test live here. The first drives `createMemoryJobHandler`
 * directly to pin the operation contract: which jobs write, which only report a
 * write as a dependency, and what the legacy tool text looks like. The second
 * runs the same handler through `JobService` and a real `JobStore`, so the
 * "defer a write into the maintenance slot" path is exercised as the daemon
 * schedules it — including the durable child job and the parent yielding.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Kind } from "../../src/protocol.js";
import { JobStore } from "../../src/jobs.js";
import { JobService, type Handler } from "../../src/service.js";
import { openStore, type MemoryStore } from "@vestigio/core/storage";
import type { ModelPort } from "@vestigio/core/resolver";
import type { Memory, MemoryId, MemoryUri, SourceRef } from "@vestigio/core";
import {
  MEMORY_OPS,
  MemoryContractError,
  OP_KINDS,
  kindOfOp,
  parseMemoryJobInput,
  type DeferredMemoryJob,
  type MemoryJobControl,
  type MemoryJobInput,
  type MemoryJobResult,
} from "../../src/memory/contract.js";
import { createMemoryJobHandler } from "../../src/memory/handler.js";
import { openMemoryRuntime } from "../../src/memory/runtime.js";

const PROJECT = "p-vestigio";
const SESSION = { source: "test", sessionId: "s-1" };

function sourceRef(overrides: Partial<SourceRef> = {}): SourceRef {
	return {
		provider: "pi",
		source_instance: "local",
		session_id: "s-1",
		message_id: "m-1",
		parent_message_id: null,
		project_id: PROJECT,
		timestamp: "2026-11-17T16:21:53Z",
		content_hash: "sha256:0",
		locator: null,
		...overrides,
	};
}

function seed(store: MemoryStore, id = "mem-1", overrides: Partial<Memory> = {}): Memory {
	const body = "部署脚本默认端口是 8080，改端口前先读这条记忆。".repeat(30);
	const navText = "部署配置与默认端口，改端口前值得读取。";
	const memory: Memory = {
		memory_id: id as MemoryId,
		uri: `memory://${store.storeId}/${id}` as MemoryUri,
		scope: { kind: "project", project_id: PROJECT },
		title: "部署脚本默认端口",
		keywords: ["部署", "端口", "8080"],
		revision: 1,
		state: "published",
		medium: { body, body_char_count: [...body.replace(/\s/gu, "")].length, sources: [sourceRef()] },
		nav: { text: navText, char_count: [...navText].length, source_revision: 1 },
		hit_count: 0,
		access_count: 0,
		last_access_at: null,
		created_at: "2026-11-17T16:21:53Z",
		updated_at: "2026-11-17T16:30:00Z",
		...overrides,
	};
	store.saveMemory(memory);
	return memory;
}

type CapturedControl = { calls: Array<{ kind: Kind; input: MemoryJobInput }> } & MemoryJobControl;

function captureControl(): CapturedControl {
	const calls: CapturedControl["calls"] = [];
	const control: CapturedControl = {
		calls,
		defer: async (kind, input, options) => {
			calls.push({ kind, input });
			return {
				key: options?.key ?? String(calls.length),
				kind,
				op: input.op,
				status: "enqueued",
				jobId: `child-${calls.length}`,
				input,
				mandatory: options?.mandatory !== false,
			} satisfies DeferredMemoryJob;
		},
	};
	return control;
}

async function harness(
	run: (store: MemoryStore, handler: ReturnType<typeof createMemoryJobHandler>) => Promise<void>,
	options: { model?: ModelPort | null } = {},
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "vestigio-memory-"));
	const path = join(directory, "memory.sqlite");
	const store = openStore({ path });
	const runtime = openMemoryRuntime(path, { store, model: options.model ?? null, history: null, project_id: PROJECT, env: {} });
	try {
		await run(store, createMemoryJobHandler(runtime));
	} finally {
		runtime.close();
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function call(
	handler: ReturnType<typeof createMemoryJobHandler>,
	kind: Kind,
	input: MemoryJobInput,
	control?: MemoryJobControl,
): Promise<MemoryJobResult> {
	return handler({ jobId: "job-1", kind, session: SESSION, input }, new AbortController().signal, control);
}

test("every operation maps to exactly one job kind", () => {
	expect(Object.keys(OP_KINDS).sort()).toEqual([...MEMORY_OPS].sort());
	for (const op of ["memory.search", "memory.read", "memory.resolve", "request.status", "hotspot.plan"] as const) {
		expect(kindOfOp(op)).toBe("search");
	}
	expect(kindOfOp("detector.run")).toBe("detector");
	for (const op of MEMORY_OPS.filter((candidate) => !["memory.search", "memory.read", "memory.resolve", "request.status", "hotspot.plan", "detector.run"].includes(candidate))) {
		expect(kindOfOp(op)).toBe("maintenance");
	}
});

test("the wire parser rejects an unknown operation and a malformed input", () => {
	expect(() => parseMemoryJobInput({ op: "memory.nope" })).toThrow(MemoryContractError);
	expect(() => parseMemoryJobInput({})).toThrow(MemoryContractError);
	expect(() => parseMemoryJobInput(null)).toThrow(MemoryContractError);
	expect(parseMemoryJobInput({ op: "memory.search", query: "x" }).op).toBe("memory.search");
});

test("a handler refuses a job whose kind cannot carry its operation", async () => {
	await harness(async (_store, handler) => {
		await expect(call(handler, "maintenance", { op: "memory.search", query: "部署" })).rejects.toThrow(/cannot carry/);
		await expect(call(handler, "search", { op: "stale.publish", events: [] })).rejects.toThrow(/cannot carry/);
	});
});

test("a read reports its usage write as a dependency instead of writing", async () => {
	await harness(async (store, handler) => {
		seed(store);
		const control = captureControl();
		const result = await call(handler, "search", { op: "memory.search", query: "部署 端口", session_id: "s-1", input_id: "in-1" }, control);
		expect(result.op).toBe("memory.search");
		expect(result.text).toMatch(/^memory_search\("部署 端口"\) -> /);
		expect(control.calls.map((entry) => entry.input.op)).toEqual(["usage.search_hits"]);
		expect(control.calls[0]!.kind).toBe("maintenance");
		expect(result.deferred).toMatchObject([{ op: "usage.search_hits", kind: "maintenance", status: "enqueued" }]);
		// The read itself wrote nothing: the usage event only exists once the child runs.
		expect(store.countUsageEvents()).toBe(0);
	});
});

test("without a control a read leaves the dependency unscheduled but still reports it", async () => {
	await harness(async (store, handler) => {
		seed(store);
		const result = await call(handler, "search", { op: "memory.search", query: "部署 端口", session_id: "s-1", input_id: "in-1" });
		expect(result.deferred).toMatchObject([{ op: "usage.search_hits", status: "pending", jobId: null }]);
		expect(store.countUsageEvents()).toBe(0);
	});
});

test("stale.publish writes the event and reports its freshness", async () => {
	await harness(async (store, handler) => {
		const memory = seed(store);
		const result = await call(handler, "maintenance", {
			op: "stale.publish",
			events: [
				{
					memory_id: memory.memory_id,
					observed_revision: 1,
					reason: "the deployment notes changed",
					excerpt: "部署脚本的默认端口已经改了",
					sources: [sourceRef({ message_id: "m-9" })],
					producer: "agent",
				},
			],
		});
		expect(result.text).toMatch(/stale\.publish\(mem-1\) -> recorded/);
		expect(result.result).toMatchObject({ inserted: 1 });
		expect(store.countPendingStaleEvents(memory.memory_id)).toBe(1);
	});
});

test("stale.publish rejects an event whose reason names an unanchored value", async () => {
	await harness(async (store, handler) => {
		const memory = seed(store);
		const result = await call(handler, "maintenance", {
			op: "stale.publish",
			events: [
				{
					memory_id: memory.memory_id,
					observed_revision: 1,
					reason: "the port is now 9999",
					excerpt: "unrelated text",
					sources: [sourceRef()],
					producer: "agent",
				},
			],
		});
		expect(result.result).toMatchObject({ events: [{ recorded: false, reason: "unanchored:9999" }] });
		expect(store.countPendingStaleEvents(memory.memory_id)).toBe(0);
	});
});

test("the detector reports a publication dependency and never writes", async () => {
	await harness(async (store, handler) => {
		const memory = seed(store);
		const control = captureControl();
		const result = await call(
			handler,
			"detector",
			{
				op: "detector.run",
				project_id: PROJECT,
				memory_ids: [memory.memory_id],
				evidence: [
					{
						id: "e-1",
						kind: "history",
						provider: "pi",
						source_instance: "local",
						session_id: "s-1",
						timestamp: "2026-11-17T16:40:00Z",
						text: "we changed the deployment port",
						source: sourceRef({ message_id: "m-2" }),
					},
				],
			},
			control,
		);
		// No model is configured, so the detector stops before any call and writes nothing.
		expect(result.result).toMatchObject({ status: "skipped", reason: "no_model" });
		expect(store.countPendingStaleEvents(memory.memory_id)).toBe(0);
		expect(control.calls).toHaveLength(0);
	});
});

test("a search job hands its usage write to the maintenance slot and the parent yields", async () => {
	const directory = await mkdtemp(join(tmpdir(), "vestigio-daemon-memory-"));
	const path = join(directory, "memory.sqlite");
	const store = openStore({ path });
	const runtime = openMemoryRuntime(path, { store, model: null, history: null, project_id: PROJECT, env: {} });
	const handler = createMemoryJobHandler(runtime);
	const jobs = new JobStore(join(directory, "jobs.sqlite"));
	const service = new JobService(jobs, handler);
	try {
		seed(store);
		const submitted = jobs.submit(SESSION, "req-1", "search", { op: "memory.search", query: "部署 端口", session_id: "s-1", input_id: "in-1" });
		service.pump();
		await expect.poll(() => jobs.get(submitted.jobId)?.state, { timeout: 4_000 }).toBe("succeeded");
		const record = jobs.get(submitted.jobId);
		expect(record).toMatchObject({ visibility: "full", resultCode: "ok" });
		const result = (record as { result: MemoryJobResult }).result;
		expect(result.op).toBe("memory.search");
		expect(result.deferred).toMatchObject([{ op: "usage.search_hits", kind: "maintenance", status: "enqueued" }]);
		// The child ran in the maintenance slot and recorded the hits.
		expect(store.countUsageEvents()).toBeGreaterThan(0);
	} finally {
		service.stop();
		jobs.close();
		runtime.close();
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a resolve that matched no card does not defer an empty usage write", async () => {
	await harness(async (store, handler) => {
		seed(store);
		const control = captureControl();
		const result = await call(
			handler,
			"search",
			{ op: "memory.resolve", question: "量子纠缠的退相干时间", session_id: "s-1", input_id: "in-9" },
			control,
		);
		const body = result.result as { status: string; cards: unknown[] };
		expect(body.cards).toEqual([]);
		// `usage.search_hits` rejects an empty hit list, so a resolve with no card
		// must not defer it: the child failure used to fail the whole answer.
		expect(control.calls).toHaveLength(0);
		expect(result.deferred).toEqual([]);
	});
});

test("a failed accounting child no longer fails the answer its parent produced", async () => {
	const directory = await mkdtemp(join(tmpdir(), "vestigio-memory-"));
	const jobs = new JobStore(join(directory, "jobs.sqlite"));
	const handler: Handler = async (job, _signal, control) => {
		if (job.kind === "maintenance") throw new Error("hits must be a non-empty array of at most 256 objects");
		const mandatory = (job.input as { mandatory_child?: boolean }).mandatory_child === true;
		await control?.defer(
			"maintenance",
			{ op: "usage.search_hits", session_id: "s-1", input_id: "in-1", hits: [] },
			{ key: "usage", ...(mandatory ? {} : { mandatory: false }) },
		);
		return { op: "memory.search", kind: "search", result: { status: "not_found", cards: [] }, text: null, deferred: [], notes: [] };
	};
	const service = new JobService(jobs, handler);
	try {
		const optional = jobs.submit(SESSION, "req-optional", "search", { op: "memory.search", query: "x" });
		const required = jobs.submit(SESSION, "req-required", "search", { op: "memory.search", query: "y", mandatory_child: true });
		service.pump();
		await expect.poll(() => jobs.get(optional.jobId)?.state, { timeout: 4_000 }).toBe("succeeded");
		await expect.poll(() => jobs.get(required.jobId)?.state, { timeout: 4_000 }).toBe("failed");

		const optionalRecord = jobs.get(optional.jobId) as { result: { children: Array<Record<string, unknown>> } };
		expect(optionalRecord).toMatchObject({ visibility: "full", resultCode: "ok" });
		expect(optionalRecord.result.children).toMatchObject([{ mandatory: false, status: "failed" }]);
		// The child's reason survives beside the answer instead of replacing it.
		expect(JSON.stringify(optionalRecord.result.children)).toContain("non-empty array");

		const requiredRecord = jobs.get(required.jobId) as { result: { children: Array<Record<string, unknown>> } };
		expect(requiredRecord).toMatchObject({ resultCode: "dependency_failed" });
		expect(requiredRecord.result.children).toMatchObject([{ mandatory: true, status: "failed" }]);
	} finally {
		service.stop();
		jobs.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a request written in the maintenance slot is readable from the search slot", async () => {
	await harness(async (store, handler) => {
		const control = captureControl();
		const written = await call(
			handler,
			"maintenance",
			{
				op: "request.write",
				project_id: PROJECT,
				session_id: "s-1",
				intent: "remember the deployment port and how to change it",
				title: "deployment port",
				evidence: [
					{ source: sourceRef({ message_id: "m-3" }), excerpt: "the deploy script defaults to 8080" },
					{ source: sourceRef({ message_id: "m-4" }), excerpt: "changing it needs a restart" },
				],
			},
			control,
		);
		const request_id = (written.result as { request_id: string }).request_id;
		expect(written.result).toMatchObject({ status: "stored", inserted: true, request_status: "pending" });
		expect(store.countMemoryRequests()).toBe(1);

		const status = await call(handler, "search", { op: "request.status", request_id });
		expect(status.result).toMatchObject({ status: "ok", requests: [{ request_id, status: "pending" }] });
		expect(status.text).toContain(`${request_id} [pending] attempts=0 | no memory URI yet`);
		// Reading a request never writes; the maintenance write already happened above.
		expect(control.calls).toHaveLength(0);
	});
});

test("memory.read returns the legacy shape and defers its access write", async () => {
	await harness(async (store, handler) => {
		const memory = seed(store);
		const control = captureControl();
		const result = await call(
			handler,
			"search",
			{ op: "memory.read", uri: memory.uri, session_id: "s-1", input_id: "in-2", project_id: PROJECT },
			control,
		);
		expect(result.text).toMatch(/^memory_read\(memory:\/\/vestigio\/mem-1\) -> resolved \| revision=1/);
		expect(control.calls.map((entry) => entry.input.op)).toEqual(["usage.memory_read"]);
		expect(control.calls[0]!.input).toMatchObject({ op: "usage.memory_read", memory_id: "mem-1", revision: 1 });
		expect(store.countUsageEvents()).toBe(0);
	});
});

test("persistence and nav refuse to write without a model instead of half-writing", async () => {
	await harness(async (store, handler) => {
		const persisted = await call(handler, "maintenance", {
			op: "resolve.persist",
			request: {
				question: "how do we deploy?",
				scope: { kind: "project", project_id: PROJECT },
				answer: "run the script",
				evidence: [],
				excerpts: [],
				cards: [],
				call_index: 1,
			},
		});
		expect(persisted.result).toMatchObject({ status: "missing", reason: "model_not_configured" });
		const nav = await call(handler, "maintenance", { op: "nav.run" });
		expect(nav.result).toMatchObject({ status: "missing", reason: "model_not_configured" });
		expect(store.countMemories()).toBe(0);
	});
});

test("hotspot.plan is read-only and hotspot.commit is the write that follows it", async () => {
	await harness(async (store, handler) => {
		seed(store);
		const planned = await call(handler, "search", {
			op: "hotspot.plan",
			project_id: PROJECT,
			session_id: "s-1",
			input_id: "in-3",
			text: "改部署端口之前先看看",
		});
		const plan = planned.result as { status: string; input_id: string };
		expect(planned.text).toMatch(/^hotspot\.plan -> (injected|not_injected) /);
		expect(plan.input_id).toBe("in-3");
		expect(store.countInjectionReceipts()).toBe(0);

		const committed = await call(handler, "maintenance", {
			op: "hotspot.commit",
			project_id: PROJECT,
			session_id: "s-1",
			input_id: "in-3",
			plan,
			delivered: [],
		});
		expect(committed.text).toMatch(/^hotspot\.commit -> delivered=0\//);
	});
});

test("a detector finding becomes a publication dependency, never an inline write", async () => {
	const model: ModelPort = {
		complete: async () => ({
			ok: true,
			value: {
				text: JSON.stringify({
					findings: [
						{
							memory_id: "mem-1",
							reason: "the deployment notes changed",
							excerpt: "部署脚本的默认端口已经改了",
							evidence_ids: ["e-1"],
						},
					],
				}),
				usage: { tokens_in: 12, tokens_out: 8, cost_usd: null },
				model: "fake",
				finish_reason: "stop",
			},
		}),
	};
	await harness(
		async (store, handler) => {
			const memory = seed(store);
			const control = captureControl();
			const result = await call(
				handler,
				"detector",
				{
					op: "detector.run",
					project_id: PROJECT,
					memory_ids: [memory.memory_id],
					evidence: [
						{
							id: "e-1",
							kind: "history",
							provider: "pi",
							source_instance: "local",
							session_id: "s-1",
							timestamp: "2026-11-17T16:40:00Z",
							text: "the deployment script now defaults to 9090",
							source: sourceRef({ message_id: "m-2" }),
						},
					],
				},
				control,
			);
			expect(result.result).toMatchObject({ status: "ok", detected: 1 });
			expect(result.deferred).toMatchObject([{ op: "stale.publish", kind: "maintenance", status: "enqueued" }]);
			expect(control.calls).toHaveLength(1);
			expect(control.calls[0]!.kind).toBe("maintenance");
			expect(control.calls[0]!.input).toMatchObject({
				op: "stale.publish",
				events: [{ memory_id: "mem-1", producer: "detector", observed_revision: 1 }],
			});
			// The detector itself wrote nothing; publication is the child's job.
			expect(store.countPendingStaleEvents(memory.memory_id)).toBe(0);
		},
		{ model },
	);
});
