import { openStore } from "@vestigio/core/storage";

export async function scenarioStale({ mock, spawnPi, check, storePath, port, chatRequests, systemText, lastUserText }) {
	const uri = "memory://vestigio/mem-deploy-port";
	const env = { VESTIGIO_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`, VESTIGIO_MODEL_ID: "mock-1", VESTIGIO_MODEL_API_KEY: "mock" };
	const inspect = (fn) => {
		const store = openStore({ path: storePath });
		try { return fn(store); } finally { store.close(); }
	};
	const snapshot = () => inspect((store) => {
		const memory = store.readMemory(uri);
		return {
			revision: memory?.revision ?? null,
			body: memory?.medium.body ?? "",
			state: memory?.state ?? null,
			nav_revision: memory?.nav?.source_revision ?? null,
			pending: store.listPendingStaleEvents("mem-deploy-port"),
		};
	});
	let phase = "detect";
	let step = 0;
	let detectorCalls = 0;
	const tool = (name, args) => ({ content: null, tool_calls: [{ index: 0, id: `stale-${phase}-${step++}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
	mock.setResponder((body) => {
		const system = (body?.messages ?? []).filter((m) => m.role === "system").map((m) => m.content).join("\n");
		const prompt = (body?.messages ?? []).filter((m) => m.role === "user").map((m) => m.content).join("\n");
		if (!body?.stream) {
			if (system.includes("You decide whether a stored memory")) {
				detectorCalls++;
				if (phase !== "detect") return { content: '{"findings":[]}' };
				const row = prompt.split("\n").find((line) => line.includes("text: [new activity] 端口已改为 5678"));
				const id = row?.match(/^- id=(\S+)/u)?.[1];
				check("stale: detector sees completed tool evidence", Boolean(id), prompt.slice(-400));
				check("stale: detector sees the stored body", prompt.includes("18080"));
				return { content: JSON.stringify({ findings: id ? [{ memory_id: "mem-deploy-port", reason: "端口已改为 5678", excerpt: "model paraphrase must not replace raw evidence", evidence_ids: [id] }] : [] }) };
			}
			if (system.includes("Decide whether the candidates")) return { content: JSON.stringify({ sufficient: true, answer: "端口需要按后续证据更新。", evidence_ids: ["mem-deploy-port"], read_uris: [], next_queries: [], conflicts: [], descend: false }) };
			if (system.includes("导航短摘要")) return { content: JSON.stringify({ nav: "部署端口已改为 6789，改端口前建议先读本页。" }) };
			const pending = inspect((store) => store.listPendingStaleEvents("mem-deploy-port"));
			const refs = pending.map((event) => `[来源:${event.event_id}]`).join("");
			const text = `部署端口当前为 6789。保留部署步骤和验证方式，后续操作应结合当前项目配置检查。${refs}`;
			return { content: JSON.stringify({ body: text + "部署配置应与服务配置保持一致，检查启动参数与环境变量后再使用当前端口。".repeat(18) }) };
		}
		if (step > 0) return { content: "OK" };
		if (phase === "detect") return tool("bash", { command: "printf '端口已改为 5678\\n'" });
		if (phase === "explicit") return tool("memory_mark_stale", { uri, observed_revision: 1, reason: "端口改为 6789", excerpt: "端口改为 6789" });
		if (phase === "repair") return tool("memory_resolve", { question: "部署 端口" });
		return tool("memory_read", { uri });
	});
	const first = spawnPi({ name: "stale-first", env });
	const from = mock.requests.length;
	try {
		await first.client.prompt("部署 端口，执行检查确认配置变更。", "stale-detect");
		const detected = snapshot();
		check("stale: agent_end records without a following message", detected.pending.length === 1);
		check("stale: evidence is raw tool output", detected.pending[0]?.excerpt === "端口已改为 5678", JSON.stringify(detected.pending[0]?.excerpt));
		check("stale: main prompt retains maintenance instructions", systemText(chatRequests(from)[0]).includes("memory_mark_stale"));
		phase = "read"; step = 0;
		const readFrom = mock.requests.length;
		await first.client.prompt("部署 端口，读取已有摘要。", "stale-read");
		const readWire = chatRequests(readFrom);
		check("stale: changed freshness reinjects same-session note", readWire.some((r) => lastUserText(r).includes("stale")));
		const repaired = snapshot();
		check("stale: read repairs the stale memory in place", repaired.revision === 2 && repaired.body.includes("6789"), `r${repaired.revision}`);
		check("stale: repaired read publishes the memory", repaired.state === "published" && repaired.nav_revision === repaired.revision, `${repaired.state} nav=r${repaired.nav_revision}`);
		check("stale: repaired read acknowledges the event it absorbed", repaired.pending.length === 0, `${repaired.pending.length} pending`);
		check("stale: repaired read returns the new body", first.client.events.some((e) => e.type === "tool_execution_end" && JSON.stringify(e.result).includes("repaired r1 -> r2") && JSON.stringify(e.result).includes("6789")));
		phase = "explicit"; step = 0;
		await first.client.prompt("部署 端口改为 6789，记录这条新变化。", "stale-explicit");
		const marked = snapshot();
		check("stale: explicit mark works without invented message ids", marked.pending.length === 1 && marked.pending[0]?.observed_revision === 1, `${marked.pending.length} pending at r${marked.revision}`);
		phase = "read"; step = 0;
		await first.client.prompt("部署 端口，确认最新 freshness。", "stale-latest-note");
		const afterSecondRead = snapshot();
		check("stale: one repair attempt per session", afterSecondRead.revision === marked.revision && afterSecondRead.pending.length === 1, `r${afterSecondRead.revision} ${afterSecondRead.pending.length} pending`);
		check("stale: no recursive main-agent run", first.client.events.filter((e) => e.type === "agent_start").length === 4);
	} finally { check("stale: first pi exits cleanly", (await first.client.close()) === 0); }
	phase = "repair"; step = 0;
	const resumed = spawnPi({ name: "stale-first", env, continueSession: true, keepSessions: true });
	try {
		const resumeFrom = mock.requests.length;
		await resumed.client.prompt("部署 端口 当前配置，检索并吸收待处理证据。", "stale-resume");
		check("stale: resume preserves freshness dedup", chatRequests(resumeFrom).every((r) => !lastUserText(r).includes("<vestigio_memory_note>")));
		const afterResolve = snapshot();
		check("stale: resolver repairs the event recorded before the restart", afterResolve.revision === 3 && afterResolve.body.includes("6789") && afterResolve.pending.length === 0, `r${afterResolve.revision} ${afterResolve.pending.length} pending`);
		const ranTools = resumed.client.events.filter((e) => e.type === "tool_execution_end").map((e) => e.toolName);
		check("stale: repair is driven by retrieval, not by an agent write", ranTools.includes("memory_resolve") && !ranTools.includes("memory_update"), ranTools.join(","));
	} finally { check("stale: resumed pi exits cleanly", (await resumed.client.close()) === 0); }
	phase = "read"; step = 0;
	const next = spawnPi({ name: "stale-next", env });
	try {
		await next.client.prompt("部署 端口，读取当前摘要。", "stale-current");
		const current = snapshot();
		check("stale: a current memory is read without another repair", current.revision === 3 && current.pending.length === 0, `r${current.revision} ${current.pending.length} pending`);
		check("stale: completed turns reach the detector", detectorCalls >= 3, `${detectorCalls} calls`);
	} finally {
		check("stale: next pi exits cleanly", (await next.client.close()) === 0);
		mock.setResponder(null);
	}
}
