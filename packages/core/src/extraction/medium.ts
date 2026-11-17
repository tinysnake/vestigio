/**
 * One bounded model call that produces the medium summary, plus its validation.
 *
 * The port's failure contract is honoured here: an environment problem comes
 * back as a status, never as a throw. Only the caller's own invalid input
 * throws, and there is no such input in this narrow path.
 */

import { nonWhitespaceCodePointCount } from "../contracts/index.js";
import type { ModelRequest, ModelResult, ModelUsage } from "../resolver/types.js";
import { MEDIUM_SUMMARY_SYSTEM_PROMPT, buildMediumUserMessage, describeMediumFailure, validateMediumBody } from "./prompt.js";
import type { MediumCall, MediumExtractInput, MediumExtraction } from "./types.js";

const ZERO_USAGE: ModelUsage = { tokens_in: 0, tokens_out: 0, cost_usd: null };

function readBodyObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  const substance = fenced?.[1] ?? trimmed;
  const start = substance.indexOf("{");
  const end = substance.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  try {
    const parsed = JSON.parse(substance.slice(start, end + 1)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const body = (parsed as Record<string, unknown>)["body"];
    return typeof body === "string" && body.trim().length > 0 ? body : null;
  } catch {
    return null;
  }
}

function callOf(
  model: string,
  usage: ModelUsage,
  elapsedMs: number,
  outcome: MediumCall["outcome"],
): MediumCall {
  return {
    model,
    tokens_in: usage.tokens_in,
    tokens_out: usage.tokens_out,
    cost_usd: usage.cost_usd,
    elapsed_ms: elapsedMs,
    outcome,
  };
}

export async function extractMediumSummary(input: MediumExtractInput): Promise<MediumExtraction> {
  const started = performance.now();
  const request: ModelRequest = {
    ...(input.model_id === undefined ? {} : { model: input.model_id }),
    messages: [
      { role: "system", content: MEDIUM_SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: buildMediumUserMessage(input.evidence) },
    ],
    max_output_tokens: input.max_output_tokens,
    expect_json: true,
    // The body is prose; reasoning tokens would only eat the output ceiling and
    // turn a complete JSON object into a truncated one.
    thinking: "off",
    signal: input.signal,
  };

  let result: ModelResult;
  try {
    result = await input.model.complete(request);
  } catch (error) {
    return {
      status: "failed",
      body: null,
      body_char_count: null,
      cited_ids: [],
      reason: `model_threw:${error instanceof Error ? error.message : String(error)}`,
      usage: ZERO_USAGE,
      call: callOf(input.model_id ?? "unconfigured", ZERO_USAGE, performance.now() - started, "failed"),
    };
  }

  const elapsed = performance.now() - started;
  if (!result.ok) {
    const cancelled = result.status === "cancelled";
    return {
      status: cancelled ? "cancelled" : "failed",
      body: null,
      body_char_count: null,
      cited_ids: [],
      reason: `model_${result.status}:${result.reason}`,
      usage: ZERO_USAGE,
      call: callOf(input.model_id ?? "unconfigured", ZERO_USAGE, elapsed, cancelled ? "cancelled" : "failed"),
    };
  }

  const usage = result.value.usage;
  const model = result.value.model;
  const body = readBodyObject(result.value.text);
  if (body === null) {
    return {
      status: "invalid",
      body: null,
      body_char_count: null,
      cited_ids: [],
      reason: "model_malformed_output:no_body",
      usage,
      call: callOf(model, usage, elapsed, "malformed"),
    };
  }

  const validation = validateMediumBody(body, input.allowed_ids);
  if (!validation.ok) {
    if (validation.failure.kind === "too_short") {
      return {
        status: "insufficient_evidence",
        body,
        body_char_count: nonWhitespaceCodePointCount(body),
        cited_ids: [],
        reason: describeMediumFailure(validation.failure),
        usage,
        call: callOf(model, usage, elapsed, "ok"),
      };
    }
    return {
      status: "invalid",
      body: null,
      body_char_count: null,
      cited_ids: [],
      reason: describeMediumFailure(validation.failure),
      usage,
      call: callOf(model, usage, elapsed, "invalid"),
    };
  }

  return {
    status: "ok",
    body: validation.body,
    body_char_count: validation.body_char_count,
    cited_ids: validation.cited_ids,
    reason: null,
    usage,
    call: callOf(model, usage, elapsed, "ok"),
  };
}
