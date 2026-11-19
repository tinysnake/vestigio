/**
 * `memory_request_write` and `memory_request_status`.
 *
 * The write tool is intentionally tiny: intent and evidence only. It never
 * accepts a `confirmed` flag, a title, or a durability switch, and it never
 * shows a dialog. Saving is a prompt rule: the agent calls the tool when the
 * operator's own message asked to save something, or when the operator clearly
 * agreed to an offer the agent made in its reply. Code only enforces what code
 * can check — the evidence must resolve against the real branch, and a
 * session-only preference is refused.
 *
 * Acceptance is not a save. The tool returns the request id and a `pending`
 * state; the durable worker composes the body later. `memory_request_status`
 * reports the eventual URI/revision or the failure reason.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ValidationError } from "@vestigio/core";
import type { MemoryRequest } from "@vestigio/core/requests";
import { MAX_REQUEST_INTENT_CHARS, MAX_REQUEST_EVIDENCE } from "./request-consent.js";
import { classifySaveDirective, requestedScope, resolveRequestEvidence } from "./request-consent.js";
import { requestTitle } from "@vestigio/core/requests";
import { errorText, nowIso, type VestigioState } from "./state.js";

const writeParameters = Type.Object({
	intent: Type.String({
		minLength: 1,
		maxLength: MAX_REQUEST_INTENT_CHARS,
		description:
			"The durable fact, decision, convention or scoped exception to remember, stated fully enough to stand alone. Do not write it for a session-only preference.",
	}),
	source_message_ids: Type.Optional(Type.Array(Type.String(), {
		maxItems: MAX_REQUEST_EVIDENCE,
		description:
			"Real entry ids from the active branch that support the intent. Use ids you saw in the conversation, never invented ones.",
	})),
	quotes: Type.Optional(Type.Array(Type.String(), {
		maxItems: MAX_REQUEST_EVIDENCE,
		description:
			"Exact excerpts from the operator's own messages in the active branch, when ids are not available. Each quote is located only in user messages; a quote from an assistant or tool entry fails the request.",
	})),
	scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global")], {
		description:
			"Requested scope. Omit for the project. Use global only when the operator's own words cover more than this project.",
	})),
});

const statusParameters = Type.Object({
	request_id: Type.Optional(Type.String({ description: "A request id returned by memory_request_write." })),
	uri: Type.Optional(Type.String({ description: "The memory URI, once saved or merged." })),
});

function entriesOf(sessionManager: { getBranch(): SessionEntry[] }): SessionEntry[] {
	try {
		return sessionManager.getBranch();
	} catch {
		return [];
	}
}

function sessionFileOf(sessionManager: ExtensionContext["sessionManager"]): string | null {
	try {
		const file = sessionManager.getSessionFile();
		return typeof file === "string" ? file : null;
	} catch {
		return null;
	}
}

function result(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function describeStatus(request: MemoryRequest): string {
	const where =
		request.memory_uri === null
			? "no memory URI yet"
			: `${request.memory_uri} r${request.revision ?? "?"} nav=${request.navigation_status ?? "none"}`;
	const reason = request.reason === null ? "" : ` reason=${request.reason}`;
	return `${request.request_id} [${request.status}] attempts=${request.attempts} | ${where}${reason}`;
}

function listRequests(store: ReturnType<VestigioState["ensureStore"]>, filter?: (request: MemoryRequest) => boolean): MemoryRequest[] {
	if (store === null) return [];
	const rows = store.listMemoryRequests(200);
	return filter === undefined ? rows : rows.filter(filter);
}

function statusText(requests: readonly MemoryRequest[]): string {
	if (requests.length === 0) return "memory_request_status: no matching request";
	return [`memory_request_status: ${requests.length} request(s)`, ...requests.map((request) => `- ${describeStatus(request)}`)].join("\n");
}

export function registerRequestTools(pi: ExtensionAPI, state: VestigioState): void {
	pi.registerTool({
		name: "memory_request_write",
		label: "Memory request",
		description:
			"Store a validated durable project memory request when the operator's own message asked to save something, or when you offered in your reply to remember a durable fact, convention, or verified incident conclusion and their next message clearly agreed. It never writes memory itself, takes no confirmed flag, invents no evidence, and refuses session-only or temporary preferences. Returns a request id and a pending state, not a saved URI: use memory_request_status to observe the URI/revision or a failure reason.",
		parameters: writeParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = state.ensureStore();
			if (store === null) {
				return result(`memory_request_write unavailable: ${state.storeFailureReason ?? "no store configured"}`, {
					status: "unavailable",
				});
			}
			const intent = params.intent.replace(/\s+/gu, " ").trim();
			if (intent.length === 0 || [...intent].length > MAX_REQUEST_INTENT_CHARS) {
				return result(`memory_request_write rejected: intent must be 1..${MAX_REQUEST_INTENT_CHARS} characters.`, {
					status: "rejected",
					reason: "intent_length",
				});
			}

			const at = nowIso();
			const sessionId = state.currentSessionId;

			const entries = entriesOf(ctx.sessionManager);
			const currentInput = state.currentUserInput;
			const directive = classifySaveDirective(currentInput?.text ?? "");
			if (directive.kind === "negated") {
				return result(
					"memory_request_write refused: the operator declined or withdrew this save. Do not queue it or ask again unless they later ask to save it.",
					{ status: "rejected", reason: "operator_declined" },
				);
			}
			if (directive.kind === "temporary") {
				return result(
					"memory_request_write refused: this is a session-only or temporary preference. Vestigio stores durable memories only; do not save it, and do not turn it into a general rule.",
					{ status: "rejected", reason: "temporary_not_durable" },
				);
			}

			const projectId = state.projectId(ctx.cwd);
			const scope = requestedScope({ requested: params.scope, directive, project_id: projectId });
			const resolved = resolveRequestEvidence({
				entries,
				context: {
					session_id: ctx.sessionManager.getSessionId(),
					session_file: sessionFileOf(ctx.sessionManager),
					project_id: projectId,
				},
				ids: params.source_message_ids ?? [],
				quotes: params.quotes ?? [],
			});
			if (!resolved.ok) {
				return result(`memory_request_write rejected evidence: ${resolved.reason}. Nothing was queued.`, {
					status: "rejected",
					reason: resolved.reason,
				});
			}

			try {
				const enqueued = store.enqueueMemoryRequest({
					scope,
					project_id: projectId,
					session_id: sessionId,
					branch_ref: state.currentBranchRef,
					intent,
					title: requestTitle(intent),
					evidence: resolved.evidence,
					at,
				});
				const request = enqueued.request;
				if (!enqueued.inserted) {
					return result(
						[
							`memory_request_write: already recorded as ${request.request_id} [${request.status}].`,
							describeStatus(request),
						].join("\n"),
						{
							status: request.status,
							request_id: request.request_id,
							memory_uri: request.memory_uri,
							revision: request.revision,
							navigation_status: request.navigation_status,
						},
					);
				}
				return result(
					[
						`memory_request_write: accepted ${request.request_id} [pending].`,
						"Not saved yet: the background worker will compose and validate the summary, then queue its navigation. Use memory_request_status to observe the URI/revision or a failure reason.",
					].join("\n"),
					{
						status: "accepted",
						request_id: request.request_id,
						memory_uri: null,
						revision: null,
						navigation_status: null,
					},
				);
			} catch (error) {
				const reason = error instanceof ValidationError ? error.message : errorText(error);
				return result(`memory_request_write rejected: ${reason}`, { status: "rejected", reason });
			}
		},
	});

	pi.registerTool({
		name: "memory_request_status",
		label: "Memory request status",
		description:
			"Read the durable state of memory requests: accepted/pending, processing, saved or merged with URI and revision, failed/rejected with a reason. Use this after memory_request_write rather than assuming the request saved.",
		parameters: statusParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = state.ensureStore();
			if (store === null) {
				return result(`memory_request_status unavailable: ${state.storeFailureReason ?? "no store configured"}`, {
					status: "unavailable",
				});
			}
			let requests: MemoryRequest[];
			try {
				if (params.request_id !== undefined) {
					const request = store.readMemoryRequest(params.request_id);
					requests = request === null ? [] : [request];
				} else if (params.uri !== undefined) {
					requests = listRequests(store, (request) => request.memory_uri === params.uri);
				} else {
					const projectId = state.projectId(ctx.cwd);
					requests = listRequests(store, (request) => request.project_id === projectId).slice(0, 50);
				}
			} catch (error) {
				return result(`memory_request_status failed: ${errorText(error)}`, { status: "failed" });
			}
			return result(statusText(requests), {
				status: requests.length === 0 ? "missing" : "ok",
				requests: requests.map((request) => ({
					request_id: request.request_id,
					status: request.status,
					scope: request.scope,
					intent: request.intent,
					title: request.title,
					evidence_ids: request.evidence.map((entry) => entry.source.message_id),
					attempts: request.attempts,
					memory_uri: request.memory_uri,
					revision: request.revision,
					navigation_status: request.navigation_status,
					reason: request.reason,
					updated_at: request.updated_at,
				})),
			});
		},
	});
}

export { statusText, describeStatus };
