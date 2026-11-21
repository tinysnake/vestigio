import { describe, expect, it } from "vitest";
import type { ModelPort, ModelRequest } from "@vestigio/core/resolver";
import { createAgentModelPort } from "../src/index.js";

const request: ModelRequest = {
	messages: [{ role: "user", content: "question" }],
	max_output_tokens: 64,
	expect_json: true,
	signal: new AbortController().signal,
};

type Call = { model: string; agent: string | undefined; request_model: string | undefined; request_thinking: string | undefined };

function recorder(calls: Call[], model: string): ModelPort {
	return {
		async complete(input) {
			calls.push({
				model,
				agent: input.user_agent,
				request_model: input.model,
				request_thinking: input.thinking,
			});
			return {
				ok: true,
				value: {
					text: "{}",
					usage: { tokens_in: 1, tokens_out: 1, cost_usd: null },
					model,
					finish_reason: null,
				},
			};
		},
	};
}

describe("createAgentModelPort", () => {
	it("builds one client when no agent overrides the base", async () => {
		const calls: Call[] = [];
		const built: string[] = [];
		const port = createAgentModelPort({ base_url: "http://x/v1", model: "base" }, {}, (options) => {
			built.push(options.model);
			return recorder(calls, options.model);
		});

		await port.complete({ ...request, user_agent: "vestigio/detector" });

		expect(built).toEqual(["base"]);
		expect(calls.map((call) => call.model)).toEqual(["base"]);
	});

	it("routes each agent to its own client and leaves the rest on the base", async () => {
		const calls: Call[] = [];
		const port = createAgentModelPort(
			{ base_url: "http://x/v1", model: "base" },
			{ detector: { model: "cheap" }, extraction: { model: "cheap" } },
			(options) => recorder(calls, options.model),
		);

		await port.complete({ ...request, user_agent: "vestigio/detector" });
		await port.complete({ ...request, user_agent: "vestigio/extraction" });
		await port.complete({ ...request, user_agent: "vestigio/resolver" });
		await port.complete({ ...request });

		expect(calls.map((call) => call.model)).toEqual(["cheap", "cheap", "base", "base"]);
	});

	it("takes the agent's model over the request's model", async () => {
		const calls: Call[] = [];
		const port = createAgentModelPort(
			{ base_url: "http://x/v1", model: "base" },
			{ detector: { model: "cheap" } },
			(options) => recorder(calls, options.model),
		);

		await port.complete({ ...request, user_agent: "vestigio/detector", model: "call-site" });

		expect(calls[0]?.model).toBe("cheap");
		expect(calls[0]?.request_model).toBe("cheap");
	});

	it("takes the agent's thinking level over the request's, and keeps the request's model", async () => {
		const calls: Call[] = [];
		const port = createAgentModelPort(
			{ base_url: "http://x/v1", model: "base", thinking: "low" },
			{ detector: { thinking: "off" } },
			(options) => recorder(calls, `${options.model}:${options.thinking}`),
		);

		await port.complete({ ...request, user_agent: "vestigio/detector", model: "call-site", thinking: "high" });

		expect(calls[0]?.model).toBe("base:off");
		expect(calls[0]?.request_model).toBe("call-site");
		expect(calls[0]?.request_thinking).toBe("off");
	});

	it("treats a tag with no route as the base client", async () => {
		const calls: Call[] = [];
		const port = createAgentModelPort(
			{ base_url: "http://x/v1", model: "base" },
			{ nav: { model: "nav-model" } },
			(options) => recorder(calls, options.model),
		);

		await port.complete({ ...request, user_agent: "somebody/else" });

		expect(calls.map((call) => call.model)).toEqual(["base"]);
	});
});
