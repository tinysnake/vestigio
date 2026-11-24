export { createOpenAiCompatibleClient } from "./openai-compatible.js";
export type { ModelClient, ModelCost, OpenAiCompatibleOptions } from "./openai-compatible.js";
export { agentOf, agentOfAgentTag, createAgentModelPort } from "./agents.js";
export type { AgentModelChoice, ModelCallEvent, ModelCallObserver } from "./agents.js";
export { observeModelCalls } from "./call-log.js";
