/**
 * Extension configuration, read once at load time from the process environment.
 *
 * Every knob has a default that already satisfies the PR-05 contract, so the
 * only variable a deployment must set is `VESTIGIO_STORE`. Without a store path
 * the extension is inert: it registers no tools and never rewrites input.
 *
 * `VESTIGIO_PROJECT_ID` defaults to the session cwd, which is the same project
 * identity the Obelisk adapter writes into `SourceRef.project_id` (the absolute
 * project path), so hotspot scoping and history scoping agree by construction.
 */

import {
	DEFAULT_HOTSPOT_POOL_CAPACITY,
	DEFAULT_HOTSPOT_TIMEOUT_MS,
	DEFAULT_INJECTION_BUDGET_BYTES,
	DEFAULT_MAX_HOTSPOT_MEMORIES,
	DEFAULT_MIN_MATCH_SCORE,
} from "@vestigio/core/hotspots";

export const STORE_ENV = "VESTIGIO_STORE";
export const PROJECT_ENV = "VESTIGIO_PROJECT_ID";
export const OBELISK_HOME_ENV = "VESTIGIO_OBELISK_HOME";
export const OBELISK_CLI_ENV = "VESTIGIO_OBELISK_CLI";
export const BUDGET_ENV = "VESTIGIO_INJECTION_BUDGET_BYTES";
export const MAX_MEMORIES_ENV = "VESTIGIO_MAX_MEMORIES";
export const MIN_SCORE_ENV = "VESTIGIO_MIN_SCORE";
export const POOL_CAPACITY_ENV = "VESTIGIO_POOL_CAPACITY";
export const TIMEOUT_ENV = "VESTIGIO_MATCH_TIMEOUT_MS";
export const DECISION_LOG_ENV = "VESTIGIO_DECISION_LOG";

export type VestigioEnv = Record<string, string | undefined>;

export type VestigioConfig = {
	readonly store_path: string | null;
	readonly project_id: string | null;
	readonly obelisk_home: string | null;
	readonly obelisk_cli: string | null;
	readonly budget_bytes: number;
	readonly max_memories: number;
	readonly min_score: number;
	readonly pool_capacity: number;
	readonly timeout_ms: number;
	readonly decision_log: string | null;
	readonly enabled: boolean;
};

export const VESTIGIO_DEFAULTS = {
	budget_bytes: DEFAULT_INJECTION_BUDGET_BYTES,
	max_memories: DEFAULT_MAX_HOTSPOT_MEMORIES,
	min_score: DEFAULT_MIN_MATCH_SCORE,
	pool_capacity: DEFAULT_HOTSPOT_POOL_CAPACITY,
	timeout_ms: DEFAULT_HOTSPOT_TIMEOUT_MS,
} as const;

export function readConfig(env: VestigioEnv = process.env): VestigioConfig {
	const store_path = strOrNull(env[STORE_ENV]);
	return {
		store_path,
		project_id: strOrNull(env[PROJECT_ENV]),
		obelisk_home: strOrNull(env[OBELISK_HOME_ENV]),
		obelisk_cli: strOrNull(env[OBELISK_CLI_ENV]),
		budget_bytes: intOr(env[BUDGET_ENV], VESTIGIO_DEFAULTS.budget_bytes, 64),
		max_memories: intOr(env[MAX_MEMORIES_ENV], VESTIGIO_DEFAULTS.max_memories, 1),
		min_score: intOr(env[MIN_SCORE_ENV], VESTIGIO_DEFAULTS.min_score, 1),
		pool_capacity: intOr(env[POOL_CAPACITY_ENV], VESTIGIO_DEFAULTS.pool_capacity, 1),
		timeout_ms: intOr(env[TIMEOUT_ENV], VESTIGIO_DEFAULTS.timeout_ms, 1),
		decision_log: strOrNull(env[DECISION_LOG_ENV]),
		enabled: store_path !== null,
	};
}

function strOrNull(value: string | undefined): string | null {
	if (value === undefined) return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

/** A positive integer override, or `fallback` when absent/garbage/below `min`. */
function intOr(value: string | undefined, fallback: number, min: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed < min) return fallback;
	return parsed;
}
