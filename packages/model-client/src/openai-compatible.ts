/**
 * OpenAI-compatible chat-completions client for the resolver's `ModelPort`.
 *
 * This is the only place in the repo that talks HTTP to a model. It keeps the
 * port's promise: an environment problem is a typed `{ ok: false }`, never a
 * throw, and the API key is never echoed into a reason string.
 *
 * The client is deliberately dumb: one request, one response, `json_object`
 * requested but never trusted (the resolver parses and validates the text).
 * Cost is `null` unless a price table is supplied; a price is never invented.
 */

import type { ModelPort, ModelRequest, ModelResponse, ModelResult, ModelThinking, ModelUsage } from "@vestigio/core/resolver";

/** USD per 1,000,000 tokens, the same units `~/.pi/agent/models.json` uses. */
export type ModelCost = {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
};

export type OpenAiCompatibleOptions = {
  /** e.g. `http://127.0.0.1:3425/v1`; `/chat/completions` is appended. */
  base_url: string;
  model: string;
  /** Sent as `Authorization: Bearer`. Omitted when absent. */
  api_key?: string | undefined;
  /** Forwarded as `reasoning_effort`; `"off"` sends nothing. */
  thinking?: ModelThinking | undefined;
  cost?: ModelCost | undefined;
  /** Extra headers, e.g. session-affinity hints. */
  headers?: Record<string, string> | undefined;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch | undefined;
  /** Caller-side ceiling; the resolver's signal always also applies. */
  timeout_ms?: number | undefined;
};

export type ModelClient = ModelPort & {
  readonly model_id: string;
  readonly cost: ModelCost | null;
};

const REASON_LIMIT = 200;

function snippet(text: string): string {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  return oneLine.length > REASON_LIMIT ? `${oneLine.slice(0, REASON_LIMIT)}…` : oneLine;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function computeCost(cost: ModelCost | undefined, usage: Record<string, unknown>): number | null {
  if (cost === undefined) return null;
  const prompt = readNumber(usage, "prompt_tokens") ?? 0;
  const completion = readNumber(usage, "completion_tokens") ?? 0;
  const cached = readNumber(usage, "prompt_tokens_details") ?? 0;
  const total =
    (prompt / 1_000_000) * cost.input +
    (completion / 1_000_000) * cost.output +
    (cached / 1_000_000) * (cost.cache_read ?? 0);
  return Number.isFinite(total) ? total : null;
}

function readUsage(raw: unknown, cost: ModelCost | undefined): ModelUsage {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const usage: Record<string, unknown> = {
    prompt_tokens: readNumber(record, "prompt_tokens") ?? 0,
    completion_tokens: readNumber(record, "completion_tokens") ?? 0,
  };
  const details = record["prompt_tokens_details"];
  if (typeof details === "object" && details !== null) {
    const cached = readNumber(details as Record<string, unknown>, "cached_tokens");
    if (cached !== null) usage["prompt_tokens_details"] = cached;
  }
  return {
    tokens_in: usage["prompt_tokens"] as number,
    tokens_out: usage["completion_tokens"] as number,
    cost_usd: computeCost(cost, usage),
  };
}

function failureStatus(httpStatus: number): "unavailable" | "failed" {
  return httpStatus === 401 || httpStatus === 403 || httpStatus === 404 ? "unavailable" : "failed";
}

export function createOpenAiCompatibleClient(options: OpenAiCompatibleOptions): ModelClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = `${options.base_url.replace(/\/+$/u, "")}/chat/completions`;
  const cost: ModelCost | null = options.cost ?? null;

  return {
    model_id: options.model,
    cost,
    async complete(request: ModelRequest): Promise<ModelResult> {
      const body: Record<string, unknown> = {
        model: request.model ?? options.model,
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        max_tokens: request.max_output_tokens,
        temperature: 0,
        stream: false,
      };
      if (request.expect_json) body["response_format"] = { type: "json_object" };
      const thinking = request.thinking ?? options.thinking;
      if (thinking !== undefined && thinking !== "off") body["reasoning_effort"] = thinking;

      const signal =
        options.timeout_ms === undefined
          ? request.signal
          : AbortSignal.any([request.signal, AbortSignal.timeout(options.timeout_ms)]);

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.api_key === undefined ? {} : { authorization: `Bearer ${options.api_key}` }),
            ...options.headers,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        const aborted = signal.aborted || request.signal.aborted;
        return {
          ok: false,
          status: aborted ? "cancelled" : "unavailable",
          reason: aborted ? "request aborted" : `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const text = await response.text().catch(() => "");
      if (!response.ok) {
        return {
          ok: false,
          status: failureStatus(response.status),
          reason: `http ${response.status}: ${snippet(text)}`,
        };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, status: "invalid_response", reason: `response is not JSON: ${snippet(text)}` };
      }
      const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const choices = Array.isArray(record["choices"]) ? record["choices"] : [];
      const first = choices[0];
      const choice = typeof first === "object" && first !== null ? (first as Record<string, unknown>) : null;
      const message = choice !== null && typeof choice["message"] === "object" && choice["message"] !== null
        ? (choice["message"] as Record<string, unknown>)
        : null;
      const content = message?.["content"];
      if (typeof content !== "string") {
        return { ok: false, status: "invalid_response", reason: "response has no string choices[0].message.content" };
      }
      const model = typeof record["model"] === "string" ? record["model"] : options.model;
      const finishReason = typeof choice?.["finish_reason"] === "string" ? (choice["finish_reason"] as string) : null;
      const value: ModelResponse = {
        text: content,
        usage: readUsage(record["usage"], options.cost),
        model,
        finish_reason: finishReason,
      };
      return { ok: true, value };
    },
  };
}
