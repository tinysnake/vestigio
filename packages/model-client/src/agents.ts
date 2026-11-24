/**
 * One model port for every agent, with per-agent clients behind it.
 *
 * Each request already names its agent in `user_agent` (the same tag a gateway
 * splits usage by), so routing on that tag keeps every call site unchanged: the
 * resolver, extraction, the stale detector and the maintenance navigator each
 * get their own model while the code still holds a single `ModelPort`.
 */

import { AGENT_USER_AGENT, type AgentName, type ModelPort, type ModelRequest, type ModelThinking } from "@vestigio/core/resolver";
import type { ModelCallObserver } from "@vestigio/core/observability";
import { observeModelCalls } from "./call-log.js";
import { createOpenAiCompatibleClient, type OpenAiCompatibleOptions } from "./openai-compatible.js";

export type { ModelCallEvent, ModelCallObserver } from "./call-log.js";

export type AgentModelChoice = {
	readonly model?: string;
	/** Only set when the agent overrides the base thinking level. */
	readonly thinking?: ModelThinking;
};

const BY_TAG = new Map<string, AgentName>(
	(Object.entries(AGENT_USER_AGENT) as [AgentName, string][]).map(([agent, tag]) => [tag, agent]),
);

/** The agent a request speaks for, or `null` when it carries no known tag. */
export function agentOfAgentTag(tag: string | undefined): AgentName | null {
	if (tag === undefined) return null;
	return BY_TAG.get(tag) ?? null;
}

export function agentOf(request: ModelRequest): AgentName | null {
	return agentOfAgentTag(request.user_agent);
}

/**
 * `create` is one client factory so a test or a host can inject its own.
 *
 * A dedicated client means that agent's model wins: when the choice sets a
 * model, it replaces the request's own `model` field (the daemon passes its
 * default id there), so the call, the client and the failure record agree.
 *
 * `onCall`, when given, reports one settled call per `complete`; it is the
 * only observation the port exposes and it never changes what the caller gets.
 */
export function createAgentModelPort(
	base: OpenAiCompatibleOptions,
	choices: Partial<Record<AgentName, AgentModelChoice>>,
	create: (options: OpenAiCompatibleOptions) => ModelPort = createOpenAiCompatibleClient,
	onCall?: ModelCallObserver,
): ModelPort {
	const routes = new Map<AgentName, { port: ModelPort; model?: string; thinking?: ModelThinking }>();
	for (const [agent, choice] of Object.entries(choices) as [AgentName, AgentModelChoice | undefined][]) {
		if (choice === undefined) continue;
		const model = choice.model ?? base.model;
		const thinking = choice.thinking ?? base.thinking;
		if (model === base.model && thinking === base.thinking) continue;
		const options: OpenAiCompatibleOptions = { ...base, model };
		if (thinking !== undefined) options.thinking = thinking;
		routes.set(agent, {
			port: create(options),
			...(choice.model === undefined ? {} : { model: choice.model }),
			...(choice.thinking === undefined ? {} : { thinking: choice.thinking }),
		});
	}
	if (routes.size === 0) {
		const port = create(base);
		return onCall === undefined ? port : observeModelCalls(port, onCall);
	}
	const fallback = create(base);
	const port: ModelPort = {
		complete(request: ModelRequest) {
			const agent = agentOf(request);
			const route = agent === null ? undefined : routes.get(agent);
			if (route === undefined) return fallback.complete(request);
			if (route.model === undefined && route.thinking === undefined) return route.port.complete(request);
			// The agent's choice replaces the request's own, so a failure record
			// still names the model that was called.
			return route.port.complete({
				...request,
				...(route.model === undefined ? {} : { model: route.model }),
				...(route.thinking === undefined ? {} : { thinking: route.thinking }),
			});
		},
	};
	return onCall === undefined ? port : observeModelCalls(port, onCall);
}
