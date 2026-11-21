/**
 * One bounded model call that produces the medium summary, plus its validation.
 *
 * The port's failure contract is honoured here: an environment problem comes
 * back as a status, never as a throw. Only the caller's own invalid input
 * throws, and there is no such input in this narrow path.
 */

import { nonWhitespaceCodePointCount } from "../contracts/index.js";
import type { ModelRequest, ModelResult, ModelUsage } from "../resolver/types.js";
import { MEDIUM_REWRITE_SYSTEM_NOTE, MEDIUM_SUMMARY_SYSTEM_PROMPT, buildMediumUserMessage, describeMediumFailure, validateMediumAliases, validateMediumBody } from "./prompt.js";
import type { MediumCall, MediumExtractInput, MediumExtraction } from "./types.js";

const ZERO_USAGE: ModelUsage = { tokens_in: 0, tokens_out: 0, cost_usd: null };

/**
 * The client's documented reason for a non-2xx answer is `http <status>: ...`
 * (`packages/model-client/src/openai-compatible.ts`). That prefix is the port's
 * contract, so the HTTP status is read here, once, where the port answer is
 * consumed; no caller parses the reason again.
 */
const HTTP_STATUS = /^http (\d{3})\b/u;

function httpStatusOf(reason: string): number | null {
  const match = HTTP_STATUS.exec(reason);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

function readSummaryObject(text: string): { body: string; aliases: unknown } | null {
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
    const record = parsed as Record<string, unknown>;
    const body = record["body"];
    if (typeof body !== "string" || body.trim().length === 0) return null;
    return { body, aliases: record["aliases"] };
  } catch {
    return null;
  }
}

function aliasGrounding(input: MediumExtractInput["evidence"]): string[] {
  const ids = new Set(input.alias_grounding_ids ?? []);
  const grounding = [input.question];
  for (const item of input.evidence) {
    if (ids.has(item.id)) grounding.push(item.text);
  }
  return grounding;
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
  const evidence = input.evidence;
  const request: ModelRequest = {
    ...(input.model_id === undefined ? {} : { model: input.model_id }),
    messages: [
      {
        role: "system",
        content:
          input.guidance === undefined && input.correction === undefined
            ? MEDIUM_SUMMARY_SYSTEM_PROMPT
            : `${MEDIUM_SUMMARY_SYSTEM_PROMPT}\n\n${MEDIUM_REWRITE_SYSTEM_NOTE}`,
      },
      { role: "user", content: buildMediumUserMessage(evidence, input.correction, input.guidance) },
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
      aliases: [],
      reason: `model_threw:${error instanceof Error ? error.message : String(error)}`,
      failure: { kind: "model_threw", message: error instanceof Error ? error.message : String(error) },
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
      aliases: [],
      reason: `model_${result.status}:${result.reason}`,
      failure: { kind: "model", status: result.status, http_status: httpStatusOf(result.reason) },
      usage: ZERO_USAGE,
      call: callOf(input.model_id ?? "unconfigured", ZERO_USAGE, elapsed, cancelled ? "cancelled" : "failed"),
    };
  }

  const usage = result.value.usage;
  const model = result.value.model;
  const summary = readSummaryObject(result.value.text);
  if (summary === null) {
    return {
      status: "invalid",
      body: null,
      body_char_count: null,
      cited_ids: [],
      aliases: [],
      reason: "model_malformed_output:no_body",
      failure: { kind: "malformed_output" },
      usage,
      call: callOf(model, usage, elapsed, "malformed"),
    };
  }

  const body = summary.body;
  const aliases = validateMediumAliases(summary.aliases, aliasGrounding(evidence));
  const validation = validateMediumBody(body, input.allowed_ids);
  if (!validation.ok) {
    if (validation.failure.kind === "too_short") {
      return {
        status: "insufficient_evidence",
        body,
        body_char_count: nonWhitespaceCodePointCount(body),
        cited_ids: [],
        aliases,
        reason: describeMediumFailure(validation.failure),
        failure: { kind: "body", failure: validation.failure },
        usage,
        call: callOf(model, usage, elapsed, "ok"),
      };
    }
    return {
      status: "invalid",
      body: null,
      body_char_count: null,
      cited_ids: [],
      aliases: [],
      reason: describeMediumFailure(validation.failure),
      failure: { kind: "body", failure: validation.failure },
      usage,
      call: callOf(model, usage, elapsed, "invalid"),
    };
  }

  return {
    status: "ok",
    body: validation.body,
    body_char_count: validation.body_char_count,
    cited_ids: validation.cited_ids,
    aliases,
    reason: null,
    failure: null,
    usage,
    call: callOf(model, usage, elapsed, "ok"),
  };
}
