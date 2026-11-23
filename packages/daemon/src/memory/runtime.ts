/**
 * The daemon memory runtime: the store, the model port and the history adapter
 * the memory handler operates on.
 *
 * `entry.ts` and the parent daemon own the process; this module only assembles
 * the three dependencies the memory operations need, from an already-known
 * store path plus the process environment. Configuration is read but never
 * required: with no model configured the read-only operations still answer and
 * the model-backed ones degrade to the same typed "unavailable" they use in the
 * extension.
 */

import { createAgentModelPort, type OpenAiCompatibleOptions } from "@vestigio/model-client";
import { agentModelSettings } from "@vestigio/config";
import { createObeliskHistoryPort } from "@vestigio/source-obelisk";
import { openStore, type MemoryStore } from "@vestigio/core/storage";
import { resolveProjectId } from "@vestigio/core/project";
import type { HistoryPort } from "@vestigio/core/retrieval";
import type { ModelPort, ModelThinking } from "@vestigio/core/resolver";

import { openResolveContexts } from "./resolve-context.js";

export const MODEL_BASE_URL_ENV = "VESTIGIO_MODEL_BASE_URL";
export const MODEL_ID_ENV = "VESTIGIO_MODEL_ID";
export const MODEL_API_KEY_ENV = "VESTIGIO_MODEL_API_KEY";
export const MODEL_THINKING_ENV = "VESTIGIO_MODEL_THINKING";
export const OBELISK_HOME_ENV = "VESTIGIO_OBELISK_HOME";
export const OBELISK_CLI_ENV = "VESTIGIO_OBELISK_CLI";
export const PROJECT_ENV = "VESTIGIO_PROJECT_ID";

export const DEFAULT_MODEL_ID = "auto/deepseek-v4.1-flash";
export const DEFAULT_MODEL_THINKING: ModelThinking = "low";

export type RuntimeEnv = Record<string, string | undefined>;

export type MemoryRuntime = {
  readonly store: MemoryStore;
  readonly resolves: ReturnType<typeof openResolveContexts>;
  /** The operations only need the port, so a test or a caller can supply any implementation. */
  readonly model: ModelPort | null;
  readonly model_id: string;
  readonly history: HistoryPort | null;
  readonly project_id: string | null;
  readonly now: () => number;
  readonly mono: () => number;
  /** The operation's wall-clock stamp as an ISO string. */
  timestamp(): string;
  close(): void;
};

export type MemoryRuntimeOptions = {
  recoverExclusive?: boolean;
  store?: MemoryStore | undefined;
  model?: ModelPort | null | undefined;
  model_id?: string | undefined;
  history?: HistoryPort | null | undefined;
  project_id?: string | null | undefined;
  now?: (() => number) | undefined;
  mono?: (() => number) | undefined;
  env?: RuntimeEnv | undefined;
};

/**
 * The configured model client, or `null` when no base URL is set. This mirrors
 * the extension's "the only configured backend" rule: never guess a URL.
 */
export function createModelClient(env: RuntimeEnv = process.env): MemoryRuntime["model"] {
  const base_url = strOrNull(env[MODEL_BASE_URL_ENV]);
  if (base_url === null) return null;
  const options: OpenAiCompatibleOptions = {
    base_url,
    model: strOrNull(env[MODEL_ID_ENV]) ?? DEFAULT_MODEL_ID,
  };
  const api_key = strOrNull(env[MODEL_API_KEY_ENV]);
  if (api_key !== null) options.api_key = api_key;
  options.thinking = thinkingOr(env[MODEL_THINKING_ENV], DEFAULT_MODEL_THINKING);
  // Every agent may name its own model; the tag in `user_agent` picks the client.
  return createAgentModelPort(options, agentModelSettings(env));
}

export function createHistoryPort(env: RuntimeEnv = process.env): HistoryPort | null {
  const home = strOrNull(env[OBELISK_HOME_ENV]);
  if (home === null) return null;
  const cli_path = strOrNull(env[OBELISK_CLI_ENV]);
  return createObeliskHistoryPort(cli_path === null ? { home } : { home, cli_path });
}

export function openMemoryRuntime(storePath: string, options: MemoryRuntimeOptions = {}): MemoryRuntime {
  const env = options.env ?? process.env;
  const owned = options.store === undefined;
  const store = options.store ?? openStore({ path: storePath });
  if (options.recoverExclusive) {
    store.database().exec(`
      BEGIN IMMEDIATE;
      UPDATE summary_jobs SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL,
        attempts = MAX(0, attempts - 1) WHERE state = 'running';
      UPDATE memory_requests SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
        attempts = MAX(0, attempts - 1) WHERE status = 'processing';
      COMMIT;
    `);
  }
  const model = options.model === undefined ? createModelClient(env) : options.model;
  const model_id = options.model_id ?? strOrNull(env[MODEL_ID_ENV]) ?? DEFAULT_MODEL_ID;
  const history = options.history === undefined ? createHistoryPort(env) : options.history;
  const configuredProject = options.project_id === undefined ? strOrNull(env[PROJECT_ENV]) : options.project_id;
  const project_id = configuredProject === null ? null : resolveProjectId(configuredProject);
  const now = options.now ?? (() => Date.now());
  const mono = options.mono ?? (() => performance.now());
  return {
    store,
    resolves: openResolveContexts(store.database()),
    model,
    model_id,
    history,
    project_id,
    now,
    mono,
    timestamp: () => new Date(now()).toISOString(),
    close: () => {
      if (owned) store.close();
    },
  };
}

const THINKING_LEVELS: readonly ModelThinking[] = ["off", "low", "medium", "high"];

function thinkingOr(value: string | undefined, fallback: ModelThinking): ModelThinking {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  return (THINKING_LEVELS as readonly string[]).includes(trimmed) ? (trimmed as ModelThinking) : fallback;
}

function strOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
