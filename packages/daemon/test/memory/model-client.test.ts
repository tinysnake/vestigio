import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@vestigio/core/resolver";
import { createModelClient } from "../../src/memory/runtime.js";

const request: ModelRequest = {
	messages: [{ role: "user", content: "question" }],
	max_output_tokens: 32,
	expect_json: true,
	signal: new AbortController().signal,
};

/** A gateway stand-in that records the model and agent of each call. */
async function withGateway(run: (url: string, seen: { model: string; agent: string | undefined }[]) => Promise<void>) {
	const seen: { model: string; agent: string | undefined }[] = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			const body = JSON.parse(raw);
			seen.push({ model: body.model, agent: req.headers["user-agent"] });
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					model: body.model,
					choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				}),
			);
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
	try {
		await run(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen);
	} finally {
		await new Promise<void>((done) => server.close(() => done()));
	}
}

describe("createModelClient", () => {
	it("sends each agent's own model and tag to the gateway", async () => {
		await withGateway(async (base_url, seen) => {
			const port = createModelClient({
				VESTIGIO_MODEL_BASE_URL: base_url,
				VESTIGIO_MODEL_ID: "base-model",
				VESTIGIO_MODEL_DETECTOR_ID: "cheap-model",
			});
			expect(port).not.toBeNull();
			if (port === null) return;

			await port.complete({ ...request, user_agent: "vestigio/detector", model: "base-model" });
			await port.complete({ ...request, user_agent: "vestigio/resolver", model: "base-model" });

			expect(seen).toEqual([
				{ model: "cheap-model", agent: "vestigio/detector" },
				{ model: "base-model", agent: "vestigio/resolver" },
			]);
		});
	});

	it("stays one client when no agent overrides the model", async () => {
		await withGateway(async (base_url, seen) => {
			const port = createModelClient({ VESTIGIO_MODEL_BASE_URL: base_url, VESTIGIO_MODEL_ID: "base-model" });
			if (port === null) throw new Error("expected a model client");

			await port.complete({ ...request, user_agent: "vestigio/nav", model: "call-site" });

			expect(seen).toEqual([{ model: "call-site", agent: "vestigio/nav" }]);
		});
	});
});
