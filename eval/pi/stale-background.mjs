import { openStore } from "@vestigio/core/storage";

/**
 * `VESTIGIO_REPAIR_MODE=background`: a read never repairs, the `agent_end` pass
 * does. A change recorded by the detector is therefore absorbed inside the same
 * turn that established it, and the `repair: deferred` line is the fallback the
 * agent sees when a pending event outlives that pass. The scenario stages such
 * an event directly instead of hoping for a race.
 */
export async function scenarioStaleBackground({ mock, spawnPi, check, storePath, port, chatRequests, systemText, reseed }) {
	reseed();
	const uri = "memory://vestigio/mem-deploy-port";
	const env = {
		VESTIGIO_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`,
		VESTIGIO_MODEL_ID: "mock-1",
		VESTIGIO_MODEL_API_KEY: "mock",
		VESTIGIO_REPAIR_MODE: "background",
	};
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
			};
		});
	const markChange = () =>
		inspect((store) => {
			const memory = store.readMemory(uri);
			const now = new Date().toISOString();
			return store.markStale({
				memory_id: "mem-deploy-port",
				observed_revision: memory.revision,
				reason: "端口又由 5678 改为 6789",
				excerpt: "端口已改为 6789。",
				sources: [
					{
						provider: "pi",
						source_instance: "local",
						session_id: "s-bg",
						message_id: "m-bg-1",
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
	let phase = "background";
	let step = 0;
	const tool = (name, args) => ({
		content: null,
		tool_calls: [{ index: 0, id: `stale-bg-${phase}-${step++}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
	});
	mock.setResponder((body) => {
		const system = (body?.messages ?? []).filter((m) => m.role === "system").map((m) => m.content).join("\n");
		const prompt = (body?.messages ?? []).filter((m) => m.role === "user").map((m) => m.content).join("\n");
		if (!body?.stream) {
			if (system.includes("You decide whether a stored memory")) {
				if (phase !== "background") return { content: '{"findings":[]}' };
				const row = prompt.split("\n").find((line) => line.includes("text: [new activity] 端口已改为 5678"));
				const id = row?.match(/^- id=(\S+)/u)?.[1];
				return { content: JSON.stringify({ findings: id ? [{ memory_id: "mem-deploy-port", reason: "端口已改为 5678", excerpt: "端口已改为 5678", evidence_ids: [id] }] : [] }) };
			}
			const value = phase === "deferred" ? "6789" : "5678";
			if (system.includes("导航短摘要")) return { content: JSON.stringify({ nav: `部署端口已改为 ${value}。` }) };
			const pending = inspect((store) => store.listPendingStaleEvents("mem-deploy-port"));
			const refs = pending.map((event) => `[来源:${event.event_id}]`).join("");
			return { content: JSON.stringify({ body: `部署端口当前为 ${value}。保留部署步骤和验证方式。${refs}` + "部署配置应与服务配置保持一致，检查启动参数与环境变量后再使用当前端口。".repeat(18) }) };
		}
		if (step > 0) return { content: "OK" };
		if (phase === "background") return tool("bash", { command: "printf '端口已改为 5678\\n'" });
		return tool("memory_read", { uri });
	});
	const first = spawnPi({ name: "stale-bg-first", env });
	const from = mock.requests.length;
	try {
		await first.client.prompt("部署 端口，执行检查确认配置变更。", "stale-bg-detect");
		const absorbed = snapshot();
		check("stale-background: agent_end absorbs the change without a read", absorbed.revision === 2 && absorbed.pending.length === 0 && absorbed.state === "published" && absorbed.nav_revision === 2, `r${absorbed.revision} ${absorbed.state} nav=r${absorbed.nav_revision} ${absorbed.pending.length} pending`);
		check("stale-background: the absorbed body carries the new value", absorbed.body.includes("5678"), absorbed.body.slice(0, 80));
		check("stale-background: instruction does not promise an inline repair", !systemText(chatRequests(from)[0]).includes("the read repairs it and returns the current revision"));
	} finally {
		check("stale-background: first pi exits cleanly", (await first.client.close()) === 0);
	}
	phase = "deferred";
	step = 0;
	const eventId = markChange();
	check("stale-background: the staged event is pending", snapshot().pending.length === 1 && eventId.length > 0);
	const second = spawnPi({ name: "stale-bg-deferred", env });
	try {
		await second.client.prompt("部署 端口，读取已有摘要。", "stale-bg-deferred");
		const readResult = readResults(second.client)[0];
		check("stale-background: the read defers the repair", (readResult ?? "").includes("repair: deferred"), readResult ?? "no read result");
		check("stale-background: the deferred read returns the stored body", (readResult ?? "").includes("5678") && (readResult ?? "").includes("STALE"));
		const repaired = snapshot();
		check("stale-background: agent_end repairs and publishes it", repaired.revision === 3 && repaired.pending.length === 0 && repaired.state === "published" && repaired.nav_revision === 3, `r${repaired.revision} ${repaired.state} nav=r${repaired.nav_revision} ${repaired.pending.length} pending`);
		check("stale-background: the repaired body carries the new value", repaired.body.includes("6789"), repaired.body.slice(0, 80));
	} finally {
		check("stale-background: the deferred pi exits cleanly", (await second.client.close()) === 0);
	}
	phase = "current";
	step = 0;
	const third = spawnPi({ name: "stale-bg-current", env });
	try {
		await third.client.prompt("部署 端口，读取当前摘要。", "stale-bg-current");
		const readResult = readResults(third.client)[0];
		check("stale-background: a current memory is read without a repair", (readResult ?? "").includes("memory_read(") && !(readResult ?? "").includes("repair:"), readResult ?? "no read result");
		const current = snapshot();
		check("stale-background: nothing is left pending", current.revision === 3 && current.pending.length === 0, `r${current.revision} ${current.pending.length} pending`);
	} finally {
		check("stale-background: next pi exits cleanly", (await third.client.close()) === 0);
		mock.setResponder(null);
	}
}
