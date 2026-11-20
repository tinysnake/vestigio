import { nonWhitespaceCodePointCount } from "@vestigio/core";
import { openStore } from "@vestigio/core/storage";
import { setTimeout as delay } from "node:timers/promises";

/**
 * The `agent_end` repair pass is the only repair path. A read always delivers
 * the stored body, a change recorded in a turn is absorbed when that turn ends,
 * and the `repair: deferred` line is what the agent sees when a pending event
 * outlives the pass that could have folded it in. This scenario drives real pi
 * processes through detection, an explicit mark, a staged event that survives a
 * pass, and a later session.
 */
export async function scenarioStale({ mock, spawnPi, check, storePath, port, chatRequests, systemText, lastUserText }) {
	const uri = "memory://vestigio/mem-deploy-port";
	const env = { VESTIGIO_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`, VESTIGIO_MODEL_ID: "mock-1", VESTIGIO_MODEL_API_KEY: "mock" };
	const inspect = (fn) => {
		const store = openStore({ path: storePath });
		try {
			return fn(store);
		} finally {
			store.close();
		}
	};
	const snapshot = () =>
		inspect((store) => {
			const memory = store.readMemory(uri);
			return {
				revision: memory?.revision ?? null,
				body: memory?.medium.body ?? "",
				state: memory?.state ?? null,
				nav_revision: memory?.nav?.source_revision ?? null,
				pending: store.listPendingStaleEvents("mem-deploy-port"),
				events: store.listStaleEvents("mem-deploy-port"),
			};
		});
	const waitForRevision = async (revision) => {
		const deadline = Date.now() + 5000;
		for (;;) {
			const current = snapshot();
			if (current.revision === revision && current.nav_revision === revision || Date.now() >= deadline) return current;
			await delay(25);
		}
	};
	const stagedChange = (excerpt, reason) =>
		inspect((store) => {
			const memory = store.readMemory(uri);
			const now = new Date().toISOString();
			return store.markStale({
				memory_id: "mem-deploy-port",
				observed_revision: memory.revision,
				reason,
				excerpt,
				sources: [
					{
						provider: "pi",
						source_instance: "local",
						session_id: "s-stale",
						message_id: "m-stale-1",
						parent_message_id: null,
						project_id: memory.scope.project_id,
						timestamp: now,
						content_hash: "sha256:02",
						locator: null,
					},
				],
				producer: "agent",
				at: now,
			}).event.event_id;
		});
	const readResults = (client) =>
		client.events
			.filter((event) => event.type === "tool_execution_end")
			.map((event) => JSON.stringify(event.result))
			.filter((text) => text.includes("memory_read("));
	/** The value the pending events carry now, so the mock body states it. */
	const pendingValue = () => {
		const pending = inspect((store) => store.listPendingStaleEvents("mem-deploy-port"));
		const text = pending.map((event) => event.excerpt).join(" ");
		const found = [...text.matchAll(/\d{4}/gu)].map((match) => match[0]);
		return found[found.length - 1] ?? "5678";
	};
	const body = (prefix) => {
		let text = prefix;
		while (nonWhitespaceCodePointCount(text) < 560) {
			text += "部署配置应与服务配置保持一致，检查启动参数与环境变量之后再使用当前端口。";
		}
		return text;
	};
	let phase = "detect";
	let step = 0;
	let detectorCalls = 0;
	const tool = (name, args) => ({ content: null, tool_calls: [{ index: 0, id: `stale-${phase}-${step++}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
	const detectorGate = Promise.withResolvers();
	mock.setResponder(async (body0) => {
		const system = (body0?.messages ?? []).filter((m) => m.role === "system").map((m) => m.content).join("\n");
		const prompt = (body0?.messages ?? []).filter((m) => m.role === "user").map((m) => m.content).join("\n");
		if (!body0?.stream) {
			if (system.includes("You decide whether a stored memory")) {
				detectorCalls++;
				if (phase !== "detect") return { content: '{"findings":[]}' };
				await detectorGate.promise;
				const row = prompt.split("\n").find((line) => line.includes("text: [new activity] 端口已改为 5678"));
				const id = row?.match(/^- id=(\S+)/u)?.[1];
				check("stale: detector sees completed tool evidence", Boolean(id), prompt.slice(-400));
				check("stale: detector sees the stored body", prompt.includes("18080"));
				return { content: JSON.stringify({ findings: id ? [{ memory_id: "mem-deploy-port", reason: "端口已改为 5678", excerpt: "model paraphrase must not replace raw evidence", evidence_ids: [id] }] : [] }) };
			}
			if (system.includes("Decide whether the candidates")) return { content: JSON.stringify({ sufficient: true, answer: "端口需要按后续证据更新。", evidence_ids: ["mem-deploy-port"], read_uris: [], next_queries: [], conflicts: [], descend: false }) };
			const value = pendingValue();
			if (system.includes("导航短摘要")) return { content: JSON.stringify({ nav: `部署端口已改为 ${value}，改端口前建议先读本页。` }) };
			const pending = inspect((store) => store.listPendingStaleEvents("mem-deploy-port"));
			const refs = pending.map((event) => `[来源:${event.event_id}]`).join("");
			return { content: JSON.stringify({ body: body(`部署端口当前为 ${value}。保留部署步骤和验证方式。${refs}`) }) };
		}
		if (step > 0) return { content: "OK" };
		if (phase === "detect") return tool("bash", { command: "printf '端口已改为 5678\\n'" });
		if (phase === "explicit") return tool("memory_mark_stale", { uri, observed_revision: 2, reason: "端口改为 6789", excerpt: "端口改为 6789" });
		return tool("memory_read", { uri });
	});
	const first = spawnPi({ name: "stale-first", env });
	const from = mock.requests.length;
	try {
		await first.client.prompt("部署 端口，执行检查确认配置变更。", "stale-detect");
		check("stale: submitting pi exits while detector response is held", await first.client.close() === 0);
		check("stale: no change is published before the detector response", snapshot().revision === 1);
	} finally {
		detectorGate.resolve();
	}
	const absorbed = await waitForRevision(2);
	const explicit = spawnPi({ name: "stale-explicit", env });
	try {
		check("stale: agent_end records the change the turn established", absorbed.events.length === 1, `${absorbed.events.length} events`);
		check("stale: evidence is raw tool output", absorbed.events[0]?.excerpt === "端口已改为 5678", JSON.stringify(absorbed.events[0]?.excerpt));
		check("stale: agent_end absorbs the change without a read", absorbed.revision === 2 && absorbed.pending.length === 0 && absorbed.state === "published" && absorbed.nav_revision === 2, `r${absorbed.revision} ${absorbed.state} nav=r${absorbed.nav_revision} ${absorbed.pending.length} pending`);
		check("stale: the absorbed body carries the new value", absorbed.body.includes("5678"), absorbed.body.slice(0, 80));
		check("stale: main prompt retains maintenance instructions", systemText(chatRequests(from)[0]).includes("memory_mark_stale"));
		check("stale: instruction does not promise an inline repair", !systemText(chatRequests(from)[0]).includes("the read repairs it and returns the current revision"));
		phase = "explicit";
		step = 0;
		await explicit.client.prompt("部署 端口改为 6789，记录这条新变化。", "stale-explicit");
		const marked = await waitForRevision(3);
		check("stale: explicit mark works without invented message ids", marked.revision === 3 && marked.pending.length === 0, `r${marked.revision} ${marked.pending.length} pending`);
		check("stale: a later change in the same session is absorbed too", marked.body.includes("6789"), marked.body.slice(0, 80));
		check("stale: no recursive main-agent run", [...first.client.events, ...explicit.client.events].filter((e) => e.type === "agent_start").length === 2);
		const ranTools = first.client.events.filter((e) => e.type === "tool_execution_end").map((e) => e.toolName);
		check("stale: no tool hands the agent a memory writer", !ranTools.includes("memory_update"), ranTools.join(","));
	} finally {
		check("stale: explicit-mark pi exits cleanly", (await explicit.client.close()) === 0);
	}
	phase = "deferred";
	step = 0;
	const eventId = stagedChange("端口已改为 7890。", "端口又由 6789 改为 7890");
	check("stale: the staged event is pending", snapshot().pending.length === 1 && eventId.length > 0);
	const second = spawnPi({ name: "stale-deferred", env });
	try {
		const deferredFrom = mock.requests.length;
		await second.client.prompt("部署 端口，读取已有摘要。", "stale-deferred-read");
		const readResult = readResults(second.client)[0];
		check("stale: the deferred read keeps the stored body", (readResult ?? "").includes("6789") && (readResult ?? "").includes("STALE"), readResult ?? "no read result");
		check("stale: the deferred read does not repair", (readResult ?? "").includes("repair: deferred"), readResult ?? "no read result");
		check("stale: changed freshness reinjects the note", chatRequests(deferredFrom).some((r) => lastUserText(r).includes("该摘要可能未吸收")));
		const repaired = await waitForRevision(4);
		check("stale: agent_end repairs and publishes the pending event", repaired.revision === 4 && repaired.pending.length === 0 && repaired.state === "published" && repaired.nav_revision === 4, `r${repaired.revision} ${repaired.state} nav=r${repaired.nav_revision} ${repaired.pending.length} pending`);
		check("stale: the repaired body carries the new value", repaired.body.includes("7890"), repaired.body.slice(0, 80));
	} finally {
		check("stale: the deferred pi exits cleanly", (await second.client.close()) === 0);
	}
	phase = "current";
	step = 0;
	const next = spawnPi({ name: "stale-next", env });
	try {
		await next.client.prompt("部署 端口，读取当前摘要。", "stale-current");
		const readResult = readResults(next.client)[0];
		check("stale: a current memory is read without a repair", (readResult ?? "").includes("memory_read(") && !(readResult ?? "").includes("repair:"), readResult ?? "no read result");
		const current = snapshot();
		check("stale: nothing is left pending", current.revision === 4 && current.pending.length === 0, `r${current.revision} ${current.pending.length} pending`);
		check("stale: completed turns reach the detector", detectorCalls >= 2, `${detectorCalls} calls`);
	} finally {
		check("stale: next pi exits cleanly", (await next.client.close()) === 0);
		mock.setResponder(null);
	}
}
