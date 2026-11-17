/**
 * Scenario (f): cancel a resolve mid-flight against the live gateway.
 *
 * The CLI has no cancellation surface, so this runs the real resolver, the real
 * `@vestigio/model-client` and a real seeded store in-process, aborts the
 * caller's signal almost immediately, and reports what the resolver did. It
 * prints one JSON line; the harness asserts on it.
 *
 * Usage: node --import ./hook.mjs cancel.mjs <store.sqlite> <project_id> <question>
 * Env:   VESTIGIO_MODEL_BASE_URL / VESTIGIO_MODEL_API_KEY / VESTIGIO_MODEL_ID
 *        VESTIGIO_MODEL_COST_INPUT / VESTIGIO_MODEL_COST_OUTPUT
 */

import { resolveMemory } from "@vestigio/core/resolver";
import { createOpenAiCompatibleClient } from "@vestigio/model-client";
import { openStore } from "@vestigio/core/storage";

const [, , storePath, projectId, question] = process.argv;
if (!storePath || !projectId || !question) {
  console.error("usage: cancel.mjs <store.sqlite> <project_id> <question>");
  process.exit(2);
}

const baseUrl = process.env["VESTIGIO_MODEL_BASE_URL"];
const apiKey = process.env["VESTIGIO_MODEL_API_KEY"];
const modelId = process.env["VESTIGIO_MODEL_ID"] ?? "auto/deepseek-v4.1-flash";
const costInput = Number(process.env["VESTIGIO_MODEL_COST_INPUT"] ?? "0");
const costOutput = Number(process.env["VESTIGIO_MODEL_COST_OUTPUT"] ?? "0");

const store = openStore({ path: storePath });
const model = createOpenAiCompatibleClient({
  base_url: baseUrl,
  model: modelId,
  api_key: apiKey,
  thinking: "low",
  cost: { input: costInput, output: costOutput },
});

const controller = new AbortController();
const started = Date.now();
const timer = setTimeout(() => controller.abort(new Error("harness cancel")), 5);

const outcome = await resolveMemory({
  store,
  question,
  scope: { kind: "project", project_id: projectId },
  model,
  signal: controller.signal,
  wall_now: () => Date.now(),
  mono_now: () => performance.now(),
});
clearTimeout(timer);
store.close();

console.log(
  JSON.stringify({
    cancelled: outcome.measured.degraded === false && (outcome.result.missing.includes("cancelled") ||
      outcome.calls.some((call) => call.outcome === "cancelled")),
    elapsed_ms: Date.now() - started,
    status: outcome.result.status,
    answer: outcome.result.answer,
    missing: outcome.result.missing,
    calls: outcome.calls.map((call) => ({ index: call.index, layer: call.layer, outcome: call.outcome })),
    measured: outcome.measured,
  }),
);
