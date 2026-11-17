import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@vestigio/core/resolver";
import { createOpenAiCompatibleClient } from "../src/index.js";

const request: ModelRequest = {
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "question" },
  ],
  max_output_tokens: 512,
  expect_json: true,
  thinking: "low",
  signal: new AbortController().signal,
};

type Captured = { url: string; init: RequestInit };

function clientWith(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  overrides: Partial<Parameters<typeof createOpenAiCompatibleClient>[0]> = {},
) {
  const captured: Captured[] = [];
  const client = createOpenAiCompatibleClient({
    base_url: "http://127.0.0.1:9/v1",
    model: "test-model",
    api_key: "secret-key",
    cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      captured.push({ url, init: init ?? {} });
      return await handler(url, init ?? {});
    },
    ...overrides,
  });
  return { client, captured };
}

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("createOpenAiCompatibleClient", () => {
  it("sends the model, json_object request and reasoning effort, and prices the usage", async () => {
    const { client, captured } = clientWith(() =>
      ok({
        model: "auto/deepseek-v4.1-flash",
        choices: [{ message: { role: "assistant", content: '{"sufficient":false}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
      }),
    );

    const result = await client.complete(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('{"sufficient":false}');
    expect(result.value.usage.tokens_in).toBe(1000);
    expect(result.value.usage.tokens_out).toBe(200);
    // 1000/1e6*0.15 + 200/1e6*0.6
    expect(result.value.usage.cost_usd).toBeCloseTo(0.00027, 8);
    const body = JSON.parse(String(captured[0]?.init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("test-model");
    expect(body["response_format"]).toEqual({ type: "json_object" });
    expect(body["reasoning_effort"]).toBe("low");
    expect(body["stream"]).toBe(false);
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer secret-key");
  });

  it("reports a usable-but-failing endpoint as failed without leaking the key", async () => {
    const { client } = clientWith(() => new Response("bad request: model not found secret-key", { status: 400 }));

    const result = await client.complete(request);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("http 400");
  });

  it("reports an unusable key as unavailable", async () => {
    const { client } = clientWith(() => new Response("unauthorized", { status: 401 }));
    const result = await client.complete(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("unavailable");
  });

  it("reports a network failure as unavailable", async () => {
    const { client } = clientWith(() => Promise.reject(new Error("ECONNREFUSED")));
    const result = await client.complete(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("unavailable");
      expect(result.reason).toContain("ECONNREFUSED");
    }
  });

  it("reports an aborted request as cancelled", async () => {
    const controller = new AbortController();
    const { client } = clientWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const pending = client.complete({ ...request, signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("cancelled");
  });

  it("reports non-JSON and contentless responses as invalid_response", async () => {
    const { client } = clientWith((_url, _init) => Promise.resolve(new Response("not json", { status: 200 })));
    const bad = await client.complete(request);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe("invalid_response");

    const { client: client2 } = clientWith(() => ok({ choices: [{ message: {} }] }));
    const empty = await client2.complete(request);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.status).toBe("invalid_response");
  });

  it("reports cost as null when no price table is configured", async () => {
    const { client } = clientWith(
      () => ok({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { cost: undefined },
    );
    const result = await client.complete(request);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.usage.cost_usd).toBeNull();
  });
});
