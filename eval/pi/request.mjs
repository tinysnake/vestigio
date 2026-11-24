/**
 * PR request: a durable candidate the agent judges worth saving is a prompt
 * rule, not a dialog. On a proactive turn the agent ends its reply with one
 * short offer and writes nothing; only the operator's own next message (好)
 * makes the agent call `memory_request_write` and reach one published memory.
 * A self-contained save command is written in the same turn with no question,
 * and a declined or ambiguous next message writes nothing. A save that
 * paraphrases a seeded subject folds into that subject instead of opening a
 * second topic next to it (issue #2).
 *
 * The provider is a local mock. Nothing here can reach the operator's real store
 * or Obelisk home; every check reads the isolated SQLite file the harness owns.
 */

import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { openStore } from "@vestigio/core/storage";

const DIRECT = "记住：项目统一使用 pnpm，部署脚本默认端口改为 18080";
const CONTEXT = "发布前必须跑完全量测试。";
const OVERLAP = "记住：部署脚本默认端口保持 18080";
const OVERLAP_QUOTE = "部署脚本默认端口改为 18080";
const PROPOSE_INTENT = "发布前必须运行全量测试";
const DECLINE_INTENT = "发布前必须先跑一遍全量测试";
const MOVED_INTENT = "发布前必须至少运行一次完整测试";
// The one short question the agent appends to a proactive reply.
const OFFER = "这条结论值得长期保留。要不要我把“发布前必须运行全量测试”记进项目记忆里，方便以后直接沿用？";

function mediumBody(ids, topic) {
	let text = `${topic}。`;
	for (const id of ids) text += ` [来源:${id}]`;
	while ([...text].filter((character) => !/\s/u.test(character)).length < 600) {
		text += "这条记住的约定来自操作者明确批准保存的证据，后续遇到同类工作时按此执行。";
	}
	return text;
}

function assistantText(events) {
	let streamed = "";
	let final = "";
	for (const event of events) {
		if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
			streamed += event.assistantMessageEvent.delta ?? "";
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			const content = event.message.content;
			final = Array.isArray(content)
				? content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("")
				: typeof content === "string"
					? content
					: final;
		}
	}
	return final.length > 0 ? final : streamed;
}

function systemOf(body) {
	return (body?.messages ?? [])
		.filter((message) => message.role === "system")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: (message.content ?? []).filter((part) => part?.type === "text").map((part) => part.text ?? "").join(""),
		)
		.join("\n");
}

export async function scenarioRequest({ mock, spawnPi, check, storePath, port }) {
	const env = {
		VESTIGIO_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`,
		VESTIGIO_MODEL_ID: "mock-1",
		VESTIGIO_MODEL_API_KEY: "mock",
	};
	const inspect = (fn) => {
		const store = openStore({ path: storePath });
		try {
			return fn(store);
		} finally {
			store.close();
		}
	};
	// The daemon owns the write. The old 5 s window read the row mid-flight under
	// CI load, so wait long enough for the compose and publish jobs to finish.
	const waitForRequest = async (predicate) => {
		const end = Date.now() + 30_000;
		while (!inspect((store) => store.listMemoryRequests().some(predicate)) && Date.now() < end) await delay(25);
	};

	let phase = "context";
	let step = 0;
	const toolCall = (name, args) => ({
		content: null,
		tool_calls: [
			{
				index: 0,
				id: `request-${phase}-${step++}`,
				type: "function",
				function: { name, arguments: JSON.stringify(args) },
			},
		],
	});
	const requestTool = (args) => toolCall("memory_request_write", args);

	mock.setResponder((body) => {
		const system = systemOf(body);
		const prompt = (body?.messages ?? [])
			.filter((message) => message.role === "user")
			.map((message) => message.content)
			.join("\n");
		if (!body?.stream) {
			if (system.includes("You decide whether a stored memory")) {
				return { content: '{"findings":[]}' };
			}
			if (system.includes("Decide whether the candidates")) {
				return {
					content: JSON.stringify({
						sufficient: false,
						answer: "没有新的可读摘要。",
						evidence_ids: [],
						read_uris: [],
						next_queries: [],
						conflicts: [],
						descend: false,
					}),
				};
			}
			if (system.includes("You write a navigation summary")) {
				return { content: JSON.stringify({ nav: "项目约定：使用 pnpm，部署脚本默认端口 18080。" }) };
			}
			// Fallback: the compose step. It must quote the evidence ids it was given.
			const ids = [...prompt.matchAll(/^- id=(\S+)/gmu)].map((match) => match[1]).filter(Boolean);
			const aboutPort = prompt.includes("端口") || prompt.includes("18080");
			return {
				content: JSON.stringify({
					body: mediumBody(ids, aboutPort ? "项目统一使用 pnpm，部署脚本默认端口为 18080，不改为 npm" : "发布前必须运行完整测试后继续"),
				}),
			};
		}
		if (step > 0) return { content: "OK" };
		if (phase === "direct") {
			return requestTool({ intent: "项目统一使用 pnpm，部署脚本默认端口改为 18080" });
		}
		if (phase === "overlap") {
			return requestTool({ intent: "部署脚本默认端口保持 18080", quotes: [OVERLAP_QUOTE] });
		}
		// Proactive turns: the agent offers to remember and writes nothing yet.
		if (phase === "offer-accept" || phase === "offer-decline" || phase === "offer-moved") {
			return { content: OFFER };
		}
		// The operator's next message decided it. Only a clear agreement (好)
		// calls the tool; a decline or an unrelated message writes nothing.
		if (phase === "approve") {
			return requestTool({ intent: PROPOSE_INTENT, quotes: [CONTEXT] });
		}
		if (phase === "decline" || phase === "moved") {
			return { content: "OK" };
		}
		if (phase === "temporary") {
			return requestTool({ intent: "发布脚本可以跳过测试直接上线" });
		}
		return { content: "OK" };
	});

	const client = spawnPi({ name: "request", env });
	const uiRequests = [];
	const ask = async (message, nextPhase) => {
		phase = nextPhase;
		step = 0;
		const from = client.client.events.length;
		const wireFrom = mock.requests.length;
		await client.client.prompt(message, `request-${nextPhase}`);
		return { events: client.client.events.slice(from), wire: mock.requests.slice(wireFrom) };
	};
	const toolResultText = (events) =>
		JSON.stringify(events.filter((event) => event.type === "tool_execution_end"));

	try {
		const direct = await ask(DIRECT, "direct");
		await waitForRequest((row) => (row.status === "saved" || row.status === "merged") && row.navigation_status === "ready");
		const first = inspect((store) => ({ requests: store.listMemoryRequests() }));
		check("request: a self-contained direct command is queued without a dialog", first.requests.length === 1, JSON.stringify(first.requests));
		check("request: the direct command creates no question in its own turn", !toolResultText(direct.events).includes("Append the question"), toolResultText(direct.events).slice(-300));
		check("request: the direct request folds into the seeded subject", first.requests[0]?.status === "merged" && first.requests[0]?.revision === 2 && first.requests[0]?.memory_uri === "memory://vestigio/mem-deploy-port", JSON.stringify(first.requests[0]));
		const memoryUri = first.requests[0]?.memory_uri;
		check("request: the saved request names its URI", typeof memoryUri === "string" && memoryUri.startsWith("memory://"));
		const memory = inspect((store) => (memoryUri === null ? null : store.readMemory(memoryUri)));
		check("request: the memory publishes with navigation", memory?.state === "published" && memory?.nav?.text?.includes("pnpm"), `${memory?.state} ${JSON.stringify(memory?.nav)}`);

		const approvedSource = first.requests[0]?.evidence[0]?.source;
		const staleSource = {
			provider: approvedSource?.provider ?? "pi/session",
			source_instance: approvedSource?.source_instance ?? "harness",
			session_id: approvedSource?.session_id ?? "request-session",
			message_id: "harness-port-change",
			parent_message_id: null,
			project_id: approvedSource?.project_id ?? "",
			timestamp: new Date().toISOString(),
			content_hash: createHash("sha256").update("端口改为 18080").digest("hex"),
			locator: null,
		};
		inspect((store) => {
			const target = store.readMemory(memoryUri);
			store.markStale({
				memory_id: target.memory_id,
				observed_revision: target.revision,
				reason: "部署脚本默认端口改为 18080",
				excerpt: "端口改为 18080",
				sources: [staleSource],
				producer: "detector",
			});
		});

		await ask(OVERLAP, "overlap");
		await waitForRequest((row) => row.status === "merged");
		const merged = inspect((store) => {
			const memory = store.readMemory(memoryUri);
			return {
				requests: store.listMemoryRequests(),
				memory,
				pending: memory === null ? [] : store.listPendingStaleEvents(memory.memory_id),
			};
		});
		check("request: an overlapping approved request reuses the same topic", merged.memory?.revision === 3, `r${merged.memory?.revision}`);
		check("request: one revision absorbs the request and the pending change", merged.memory?.revision === 3 && merged.pending.length === 0, `${merged.pending.length} pending`);
		const overlapRequest = merged.requests.find((row) => row.intent.includes("保持"));
		check("request: the overlap is reported as merged", overlapRequest?.status === "merged" && overlapRequest?.revision === 3 && overlapRequest?.memory_uri === memoryUri, JSON.stringify(overlapRequest));

		// Establish the durable conclusion the agent will judge worth saving.
		await ask(CONTEXT, "context");

		// Proactive-accepted: the offer turn writes nothing and asks one question.
		const beforeOffer = inspect((store) => store.listMemoryRequests().length);
		const offer = await ask("记住这个", "offer-accept");
		const afterOffer = inspect((store) => store.listMemoryRequests());
		check("request: a proactive turn writes no request", afterOffer.length === beforeOffer, `${beforeOffer} -> ${afterOffer.length}`);
		const offerReply = assistantText(offer.events);
		check("request: the proactive reply ends with the offer question", /[?？]/u.test(offerReply) && offerReply.includes("记忆") && offerReply.includes("全量测试"), offerReply.slice(-300));
		check("request: the prompt rule reaches the agent", offer.wire.some((entry) => systemOf(entry.body).includes("end your reply with one short question")), offer.wire.length + " wire");
		check("request: the offer turn opens no confirm dialog", offer.events.every((event) => event.type !== "extension_ui_request" || event.method === "notify" || event.method === "setWidget"));

		// The operator's next message clearly agrees: the agent now calls the tool.
		const approve = await ask("好", "approve");
		await waitForRequest((row) => row.intent === PROPOSE_INTENT && row.status === "saved");
		const afterApprove = inspect((store) => store.listMemoryRequests());
		const approved = afterApprove.find((row) => row.intent === PROPOSE_INTENT);
		check("request: the agreement turn creates the request", approved !== undefined, JSON.stringify(afterApprove));
		check("request: the agreed request reaches saved with one memory", approved?.status === "saved" && typeof approved?.memory_uri === "string" && approved.memory_uri.startsWith("memory://"), JSON.stringify(approved));
		check("request: the agreement turn returns no append-the-question text", !toolResultText(approve.events).includes("你觉得需不需要我将"), toolResultText(approve.events).slice(-300));

		// Proactive-declined: the offer turn writes nothing; the operator declines.
		const beforeDecline = inspect((store) => store.listMemoryRequests().length);
		const declineOffer = await ask("记住这个", "offer-decline");
		check("request: a declined offer writes no request", inspect((store) => store.listMemoryRequests().length) === beforeDecline, "decline offer");
		check("request: the declined offer still asks the question", /[?？]/u.test(assistantText(declineOffer.events)), assistantText(declineOffer.events).slice(-200));
		await ask("不用", "decline");
		const afterDecline = inspect((store) => store.listMemoryRequests());
		check("request: a declined offer never writes a row", !afterDecline.some((row) => row.intent === DECLINE_INTENT), `${afterDecline.length} requests`);
		check("request: a declined offer writes no memory", !afterDecline.some((row) => row.intent === DECLINE_INTENT && row.memory_uri !== null));

		// Proactive-ambiguous: an unrelated next message writes nothing.
		const beforeMoved = inspect((store) => store.listMemoryRequests().length);
		await ask("记住这个", "offer-moved");
		check("request: an ambiguous offer writes no request", inspect((store) => store.listMemoryRequests().length) === beforeMoved, "moved offer");
		await ask("先别管这个，我们看看构建为什么失败", "moved");
		const afterMoved = inspect((store) => store.listMemoryRequests());
		check("request: an unrelated next message writes no row", !afterMoved.some((row) => row.intent === MOVED_INTENT), `${afterMoved.length} requests`);
		check("request: an unrelated next message writes no memory", !afterMoved.some((row) => row.intent === MOVED_INTENT && row.memory_uri !== null));

		// A session-only preference is refused even when the agent calls the tool.
		await ask("这次先记住：发布脚本可以跳过测试，直接上线", "temporary");
		const afterTemporary = inspect((store) => store.listMemoryRequests());
		check("request: a session-only preference is not queued", !afterTemporary.some((row) => row.intent.includes("跳过测试")), `${afterTemporary.length} requests`);
		check("request: a session-only preference writes no memory", afterTemporary.every((row) => !row.intent.includes("跳过测试")));

		for (const event of client.client.events) {
			if (event.type === "extension_ui_request") uiRequests.push(event);
		}
		const dialogs = uiRequests.filter((event) => ["select", "confirm", "input", "editor"].includes(event.method));
		check("request: no confirm dialog was ever opened", dialogs.length === 0, JSON.stringify(dialogs));
		check("request: pi displays a background save notification", uiRequests.some((event) => event.method === "notify" && event.message.includes("memory save request")));

		const statusText = toolResultText(client.client.events);
		check("request: the write tool reports the accepted request id", statusText.includes("req-"), statusText.slice(-300));
	} finally {
		check("request: pi exits cleanly", (await client.client.close()) === 0);
		mock.setResponder(null);
	}
}
