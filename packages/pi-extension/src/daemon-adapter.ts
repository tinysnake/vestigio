import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { TSchema, Static } from "typebox";
import type { Kind } from "@vestigio/client";
import { saveActivity } from "@vestigio/config";
import { splitMemoryUri } from "@vestigio/core";
import { requestTitle } from "@vestigio/core/requests";
import { ActivityPanel, clip, formatInjection, formatJobEvent, formatNotInjected, formatToolEvent, line } from "./activity.js";
import { ACTIVITY_ENV, type VestigioConfig } from "./config.js";
import { DecisionLog, hashQuery } from "./decision-log.js";
import { PiDaemon, sessionOf } from "./daemon-client.js";
import { loadLedger, persistLedgerDelta } from "./ledger-store.js";
import { classifySaveDirective, requestedScope, resolveRequestEvidence } from "./request-consent.js";
import { evidenceFromEntries, sessionEntryText, sourceRefForEntry } from "./session-source.js";
import { searchParameters, readParameters, resolveParameters, markStaleParameters, writeParameters, statusParameters } from "./tool-parameters.js";
import type { CommitResult, InjectionPlan } from "@vestigio/core/hotspots";

type Result = { text: string | null; result: unknown; children?: { result: unknown }[] };
type Context = ReturnType<typeof capture>;

function capture(ctx: ExtensionContext, config: VestigioConfig) {
	const session = ctx.sessionManager;
	const entries = session.getBranch();
	return {
		entries,
		session_id: sessionOf(ctx).sessionId,
		session_file: session.getSessionFile() ?? null,
		project_id: config.project_id ?? ctx.cwd,
		branch_ref: entries[0]?.id ?? "root",
		leaf: entries.at(-1)?.id ?? "root",
	};
}

function report(error: unknown): void {
	if (process.env.VESTIGIO_DEBUG) console.error(error);
}

export function connectPi(pi: ExtensionAPI, config: VestigioConfig, storePath: string) {
	const daemon = new PiDaemon(storePath);
	const log = new DecisionLog(config.decision_log);
	const panel = new ActivityPanel(config.activity_panel);
	let currentInput: { text: string; id: string } | undefined;
	const seen = new Set<string>();
	const checkpoints = new Map<string, string>();
	const bind = (ctx: ExtensionContext) => {
		currentInput = undefined;
		seen.clear();
		panel.attach(ctx);
		daemon.bind(ctx, (event) => {
			const detail = event.result as { turnLeaf?: string; op?: string; result?: Record<string, unknown> } | null;
			if (!detail?.turnLeaf || !ctx.sessionManager.getBranch().some((entry) => entry.id === detail.turnLeaf)) return;
			panel.pushAll(ctx, formatJobEvent(String(detail.op ?? event.kind), String(event.state), detail.result));
			if (event.state === "failed" || event.state === "cancelled") {
				ctx.ui.notify(`Vestigio ${detail.op ?? event.kind}: ${event.state}`, "warning");
				return;
			}
			const repaired = Number(detail.result?.repaired ?? 0);
			const saved = Number(detail.result?.saved ?? 0) + Number(detail.result?.merged ?? 0);
			if (repaired > 0) ctx.ui.notify(`Vestigio 已修复 ${repaired} 条记忆`, "info");
			if (saved > 0) ctx.ui.notify(`Vestigio 已处理 ${saved} 条记忆保存请求`, "info");
		});
	};
	pi.on("session_start", (_event, ctx) => {
		panel.clear(ctx);
		bind(ctx);
	});
	pi.on("session_tree", (_event, ctx) => bind(ctx));
	pi.on("session_shutdown", () => daemon.close());

	async function input(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> {
		const id = randomUUID();
		const context = capture(ctx, config);
		const base = { kind: "input", ts: new Date().toISOString(), source: event.source,
			streaming_behavior: event.streamingBehavior ?? null, session_id: context.session_id,
			branch_ref: context.branch_ref, input_id: id, project_id: context.project_id } as const;
		if (event.source === "extension" || event.text.startsWith("/")) {
			log.write({ ...base, status: "not_injected", reason: event.source === "extension" ? "extension_source" : "slash_command" });
			return { action: "continue" };
		}
		currentInput = { id, text: event.text };
		const ledger = loadLedger(ctx.sessionManager);
		try {
			const response = await daemon.run(ctx, "maintenance", `input:${id}`, {
				op: "session.input", project_id: context.project_id, session_id: context.session_id, input_id: id,
				branch_ref: context.branch_ref, source: event.source, text: event.text,
				delivered: ledger.ids(), freshness_sigs: Object.fromEntries(ledger.ids().map((id) => [id, ledger.freshnessSig(id)])),
				budget_bytes: config.budget_bytes, max_memories: config.max_memories, min_score: config.min_score,
				capacity: config.pool_capacity, timeout_ms: config.timeout_ms,
			}) as Result;
			const result = response.result as { action: "transform" | "continue"; text?: string; reason?: string;
				commit?: CommitResult; plan?: InjectionPlan };
			const delta = result.commit?.delta;
			if (delta) {
				persistLedgerDelta(pi, delta);
				for (const memoryId of delta.memory_ids) seen.add(memoryId);
			}
			const text = result.action === "transform" ? result.text : undefined;
			const plan = result.plan;
			const delivered = text === undefined ? [] : plan?.injected ?? [];
			log.write({ ...base, status: text === undefined ? "not_injected" : "injected", reason: result.reason ?? null,
				query_hash: hashQuery(event.text), query_chars: Array.from(event.text).length,
				injected: delivered.length, memory_ids: delivered.map((match) => match.memory_id),
				stale_ids: delivered.filter((match) => match.freshness.is_stale).map((match) => match.memory_id),
				...(plan === undefined ? {} : {
					matched: plan.matched.length, matched_ids: plan.matched.map((match) => match.memory_id), elapsed_ms: plan.elapsed_ms,
				}),
				...(text === undefined || plan === undefined ? {} : {
					block_bytes: plan.budget.used_bytes, estimated_tokens: plan.budget.estimated_tokens,
				}),
			});
			if (text === undefined) {
				const skipped = formatNotInjected(result.reason ?? null);
				if (skipped !== null) panel.push(ctx, skipped);
			} else if (plan !== undefined) {
				panel.pushAll(ctx, formatInjection(plan));
			}
			return text === undefined ? { action: "continue" } : { action: "transform", text };
		} catch (error) {
			log.write({ ...base, status: "not_injected", reason: "store_error", error: String(error) });
			panel.push(ctx, line("error", "注入失败 · 记忆库不可用"));
			report(error);
			return { action: "continue" };
		}
	}
	pi.on("input", input);

	pi.on("agent_end", async (_event, ctx) => {
		const context = capture(ctx, config);
		const key = `${context.session_id}:${context.branch_ref}`;
		const memoryIds = [...seen];
		const last = checkpoints.get(key);
		const lastIndex = context.entries.findIndex((entry) => entry.id === last);
		const fresh = new Set(context.entries.slice(lastIndex + 1).map((entry) => entry.id));
		const evidence = evidenceFromEntries(context.entries, context, 48).map((row) => ({
			id: row.entry_id, kind: row.kind, provider: row.source_ref.provider, source_instance: row.source_ref.source_instance,
			session_id: row.source_ref.session_id, timestamp: row.source_ref.timestamp, text: row.excerpt,
			source: row.source_ref, is_new: fresh.has(row.entry_id),
		}));
		currentInput = undefined;
		try {
			if (evidence.some((row) => row.is_new)) {
				await daemon.submit(ctx, "detector", `detector:${context.leaf}`, {
					op: "detector.run", project_id: context.project_id, session_id: context.session_id,
					branch_ref: context.branch_ref, turn_leaf: context.leaf, evidence, memory_ids: memoryIds,
				});
				checkpoints.set(key, context.leaf);
			}
			await daemon.submit(ctx, "maintenance", `maintenance:${context.leaf}`, {
				op: "repair.memories", project_id: context.project_id, turn_leaf: context.leaf, memory_ids: memoryIds,
			});
			await daemon.submit(ctx, "maintenance", `requests:${context.leaf}`, { op: "request.process", project_id: context.project_id, turn_leaf: context.leaf });
		} catch (error) {
			report(error);
		}
	});

	function tool<T extends TSchema>(name: string, description: string, parameters: T, kind: Kind,
		makeInput: (params: Static<T>, context: Context) => Record<string, unknown>) {
		pi.registerTool({ name, label: name, description, parameters, async execute(toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const context = capture(ctx, config);
				const payload = makeInput(params, context);
				const inputId = currentInput?.id;
				const result = await daemon.run(ctx, kind, `tool:${toolCallId}`, {
					project_id: context.project_id, session_id: context.session_id, input_id: inputId, ...payload,
				}, signal) as Result;
				const uri = typeof payload.uri === "string" ? splitMemoryUri(payload.uri) : null;
				if (uri?.memoryId) seen.add(uri.memoryId);
				if (payload.op === "memory.read") {
					const detail = result.result as { status: string };
					log.write({ ts: new Date().toISOString(), kind: "tool_read", status: detail.status,
						session_id: context.session_id, branch_ref: context.branch_ref, input_id: inputId ?? null, project_id: context.project_id,
						memory_ids: detail.status === "resolved" && uri !== null ? [uri.memoryId] : [],
					});
				}
				if (payload.op === "memory.search" || payload.op === "memory.resolve") {
					const search = payload.op === "memory.search";
					const query = (search ? payload.query : payload.question) as string;
					const detail = result.result as {
						status: string;
						cards: { memory_id: string }[];
						recovery?: { status: string; model_calls: number; cost_usd: number | null; elapsed_ms: number };
						measured?: { model_calls?: number; cost_usd?: number | null };
					};
					log.write({ ts: new Date().toISOString(), kind: search ? "tool_search" : "tool_resolve", status: detail.status,
						session_id: context.session_id, branch_ref: context.branch_ref, input_id: inputId ?? null, project_id: context.project_id,
						memory_ids: detail.cards.map((card) => card.memory_id), query_hash: hashQuery(query), query_chars: Array.from(query).length,
						...(detail.recovery === undefined ? {} : { recovery: detail.recovery }),
						model_calls: detail.recovery?.model_calls ?? detail.measured?.model_calls ?? 0,
						model_cost_usd: detail.recovery?.cost_usd ?? detail.measured?.cost_usd ?? null,
					});
				}
				panel.pushAll(ctx, formatToolEvent(String(payload["op"]), payload, result.result));
				return { content: [{ type: "text", text: result.text ?? JSON.stringify(result.result) }], details: result.result };
			} catch (error) {
				panel.push(ctx, line("error", `${name} 失败 · ${clip(error instanceof Error ? error.message : String(error), 48)}`));
				return { content: [{ type: "text", text: `${name}: ${error instanceof Error ? error.message : String(error)}` }], details: { status: "unavailable" } };
			}
		} });
	}
	tool("memory_search", "Search what you already know about this project and this machine: recorded memories plus, by default, the indexed past sessions. Use it before answering a recall question (a host, an account, a port, a config value, a past decision or fix) and before grepping files or session logs. If literal search is empty, a configured model checks rewritten and ranked partial matches against the current question.", searchParameters, "search", (params) => ({
		op: "memory.search", ...params, question: currentInput?.text.trim().slice(0, 8192) || params.query,
	}));
	tool("memory_read", "Read a memory and its freshness evidence.", readParameters, "search", (params) => ({ op: "memory.read", ...params }));
	tool("memory_resolve", "Answer a recall question from the layered memory: recorded memories first, then the raw session history. Use it when one memory_search was not enough. Budgeted and model-backed.", resolveParameters, "search", (params, context) => ({ op: "memory.resolve", context_handle: context.branch_ref, ...params }));
	tool("memory_request_status", "Read the status of a durable save request.", statusParameters, "search", (params) => ({ op: "request.status", ...params }));
	tool("memory_request_write", "Queue a durable memory when the operator asks to save it. Provide their exact words or real entry IDs.", writeParameters, "maintenance", (params, context) => {
		const directive = classifySaveDirective(currentInput?.text ?? "");
		if (directive.kind === "negated" || directive.kind === "temporary") throw new Error("The operator declined or the preference is temporary");
		const resolved = resolveRequestEvidence({ entries: context.entries, context, ids: params.source_message_ids ?? [], quotes: params.quotes ?? [] });
		if (!resolved.ok) throw new Error(`Rejected evidence: ${resolved.reason}`);
		const intent = params.intent.replace(/\s+/gu, " ").trim();
		return { op: "request.write", intent, title: requestTitle(intent), evidence: resolved.evidence, branch_ref: context.branch_ref,
			scope: requestedScope({ requested: params.scope, directive, project_id: context.project_id }) };
	});
	tool("memory_mark_stale", "Report a specific effective change with real evidence from the active branch.", markStaleParameters, "maintenance", (params, context) => {
		const uri = splitMemoryUri(params.uri);
		const entries = params.source_message_ids?.length
			? context.entries.filter((entry) => params.source_message_ids?.includes(entry.id))
			: context.entries.filter((entry) => sessionEntryText(entry)?.includes(params.excerpt)).slice(-1);
		if (!entries.length || (params.source_message_ids?.length && entries.length !== new Set(params.source_message_ids).size)) {
			throw new Error("Evidence must come from real entries on the active branch");
		}
		const sources = entries.flatMap((entry) => sourceRefForEntry(entry, context) ?? []);
		if (!sources.length) throw new Error("Evidence has no source references");
		return { op: "stale.publish", events: [{ memory_id: uri.memoryId, observed_revision: params.observed_revision,
			reason: params.reason, excerpt: params.excerpt, sources, producer: "agent", branch_ref: context.branch_ref }] };
	});
	pi.registerCommand("vestigio-log", {
		description: "记忆活动面板：on 打开，off 关闭，clear 清空",
		handler: async (args: string, ctx: ExtensionContext) => {
			const action = args.trim().toLowerCase();
			if (action === "off" || action === "on") {
				const enabled = action === "on";
				panel.setEnabled(enabled, ctx);
				ctx.ui.notify(`记忆活动面板已${enabled ? "打开" : "关闭"}${persistenceNote(enabled)}`, "info");
				return;
			}
			if (action === "" || action === "clear") {
				panel.clear(ctx);
				ctx.ui.notify("记忆活动面板已清空", "info");
				return;
			}
			ctx.ui.notify("用法：/vestigio-log on | off | clear", "warning");
		},
	});
}

/**
 * The panel's state lives in `logging.activity`, so a toggle outlives the
 * session. An explicit `VESTIGIO_ACTIVITY` outranks the file, so writing then
 * would promise a change the next start would not honour.
 */
function persistenceNote(next: boolean): string {
	const override = process.env[ACTIVITY_ENV];
	if (override !== undefined && override.trim().length > 0) {
		return "，仅本次会话（环境变量 VESTIGIO_ACTIVITY 优先）";
	}
	const saved = saveActivity(next);
	if (saved.status === "saved") return "，已写入配置";
	if (saved.status === "no_file") return "，仅本次会话（没有配置文件）";
	return `，本次会话生效（配置写入失败：${clip(saved.message, 60)}）`;
}
