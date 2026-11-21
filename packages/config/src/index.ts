/**
 * The operator config file, `~/.vestigio/config.json`.
 *
 * Four processes read configuration: the CLI, the daemon it starts, the MCP
 * adapter, and the pi extension. They all read the same `VESTIGIO_*` variables,
 * so this module turns the file into those variables rather than introducing a
 * second configuration path. Precedence is command-line flag, environment
 * variable, file, built-in default. The file never overwrites a variable that
 * is already set, which keeps the eval harnesses hermetic when they pin
 * `VESTIGIO_CONFIG=""`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	DEFAULT_HOTSPOT_POOL_CAPACITY,
	DEFAULT_HOTSPOT_TIMEOUT_MS,
	DEFAULT_INJECTION_BUDGET_BYTES,
	DEFAULT_MAX_HOTSPOT_MEMORIES,
	DEFAULT_MIN_MATCH_SCORE,
} from "@vestigio/core/hotspots";
import type { ModelThinking } from "@vestigio/core/resolver";

export const CONFIG_PATH_ENV = "VESTIGIO_CONFIG";
export const CONFIG_DIRECTORY = ".vestigio";
export const CONFIG_FILENAME = "config.json";
export const CONFIG_VERSION = 1;

export type VestigioEnv = Record<string, string | undefined>;

export type ModelSection = {
	readonly base_url?: string;
	readonly id?: string;
	readonly api_key?: string | null;
	readonly thinking?: ModelThinking;
};

export type RetrievalSection = {
	readonly budget_bytes?: number;
	readonly max_memories?: number;
	readonly min_score?: number;
	readonly pool_capacity?: number;
	readonly timeout_ms?: number;
};

export type HistorySection = {
	readonly obelisk_home?: string | null;
	readonly obelisk_cli?: string | null;
};

export type LoggingSection = {
	readonly decision_log?: string | null;
	/** The on-screen activity panel; off unless the operator turns it on. */
	readonly activity?: boolean;
};

export type ConfigFile = {
	readonly store?: string;
	readonly model?: ModelSection;
	readonly retrieval?: RetrievalSection;
	readonly history?: HistorySection;
	readonly logging?: LoggingSection;
};

export type ConfigOptions = {
	/** Replaces the home directory; tests point it at a temporary folder. */
	readonly home?: string;
};

const ROOT_KEYS = ["version", "store", "model", "retrieval", "history", "logging"] as const;
const MODEL_KEYS = ["base_url", "id", "api_key", "thinking"] as const;
const RETRIEVAL_KEYS = ["budget_bytes", "max_memories", "min_score", "pool_capacity", "timeout_ms"] as const;
const HISTORY_KEYS = ["obelisk_home", "obelisk_cli"] as const;
const LOGGING_KEYS = ["decision_log", "activity"] as const;
const THINKING_LEVELS: readonly ModelThinking[] = ["off", "low", "medium", "high"];

export function defaultConfigPath(options: ConfigOptions = {}): string {
	return join(options.home ?? homedir(), CONFIG_DIRECTORY, CONFIG_FILENAME);
}

/** The parsed file, or `null` when no file should be read. Throws on a file it cannot trust. */
export function loadConfigFile(env: VestigioEnv = process.env, options: ConfigOptions = {}): ConfigFile | null {
	const override = env[CONFIG_PATH_ENV];
	if (override !== undefined) {
		const trimmed = override.trim();
		if (trimmed.length === 0) return null;
		const path = expandHome(trimmed, options);
		const text = readIfPresent(path);
		if (text === null) throw new Error(`vestigio config ${path}: file not found`);
		return parseConfig(text, path, options);
	}
	const path = defaultConfigPath(options);
	const text = readIfPresent(path);
	return text === null ? null : parseConfig(text, path, options);
}

/** Fill in the variables the file names, leaving every variable already set alone. */
export function resolveEnv(env: VestigioEnv = process.env, options: ConfigOptions = {}): VestigioEnv {
	const file = loadConfigFile(env, options);
	if (file === null) return { ...env };
	const out: VestigioEnv = { ...env };
	for (const [key, value] of Object.entries(configToEnv(file))) {
		const current = out[key];
		if (current === undefined || current.trim().length === 0) out[key] = value;
	}
	return out;
}

/** Apply the file to a process's own environment. Used by the CLI, daemon and MCP entry points. */
export function applyConfigToEnv(env: VestigioEnv = process.env, options: ConfigOptions = {}): void {
	Object.assign(env, resolveEnv(env, options));
}

export type ConfigWriteResult =
	| { readonly status: "saved"; readonly path: string }
	| { readonly status: "no_file" }
	| { readonly status: "error"; readonly message: string };

/**
 * Persist the activity panel's on/off state. A missing default file is created;
 * a missing file named by `VESTIGIO_CONFIG` is not, because the operator named
 * a path and inventing one would put settings somewhere they did not ask for.
 */
export function saveActivity(enabled: boolean, env: VestigioEnv = process.env, options: ConfigOptions = {}): ConfigWriteResult {
	const override = env[CONFIG_PATH_ENV];
	let path: string;
	if (override === undefined) {
		path = defaultConfigPath(options);
	} else {
		const trimmed = override.trim();
		if (trimmed.length === 0) return { status: "no_file" };
		path = expandHome(trimmed, options);
	}
	const text = readIfPresent(path);
	if (text === null && override !== undefined) return { status: "no_file" };
	let root: Record<string, unknown> = {};
	if (text !== null) {
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (error) {
			return { status: "error", message: message(error) };
		}
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { status: "error", message: "the file must be a JSON object" };
		}
		root = raw as Record<string, unknown>;
	}
	const current = root["logging"];
	if (current !== undefined && (typeof current !== "object" || current === null || Array.isArray(current))) {
		return { status: "error", message: "logging must be a JSON object" };
	}
	root["logging"] = { ...(current as Record<string, unknown> | undefined), activity: enabled };
	try {
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(root, null, 2)}\n`, "utf8");
		renameSync(temporary, path);
		return { status: "saved", path };
	} catch (error) {
		return { status: "error", message: message(error) };
	}
}

export function configToEnv(file: ConfigFile): Record<string, string> {
	const out: Record<string, string> = {};
	if (file.store !== undefined) {
		out["VESTIGIO_STORE"] = file.store;
		// The MCP adapter has always had its own name for the same value.
		out["VESTIGIO_DB"] = file.store;
	}
	const model = file.model;
	if (model !== undefined) {
		if (model.base_url !== undefined) out["VESTIGIO_MODEL_BASE_URL"] = model.base_url;
		if (model.id !== undefined) out["VESTIGIO_MODEL_ID"] = model.id;
		if (model.api_key !== undefined && model.api_key !== null) out["VESTIGIO_MODEL_API_KEY"] = model.api_key;
		if (model.thinking !== undefined) out["VESTIGIO_MODEL_THINKING"] = model.thinking;
	}
	const retrieval = file.retrieval;
	if (retrieval !== undefined) {
		if (retrieval.budget_bytes !== undefined) out["VESTIGIO_INJECTION_BUDGET_BYTES"] = String(retrieval.budget_bytes);
		if (retrieval.max_memories !== undefined) out["VESTIGIO_MAX_MEMORIES"] = String(retrieval.max_memories);
		if (retrieval.min_score !== undefined) out["VESTIGIO_MIN_SCORE"] = String(retrieval.min_score);
		if (retrieval.pool_capacity !== undefined) out["VESTIGIO_POOL_CAPACITY"] = String(retrieval.pool_capacity);
		if (retrieval.timeout_ms !== undefined) out["VESTIGIO_MATCH_TIMEOUT_MS"] = String(retrieval.timeout_ms);
	}
	const history = file.history;
	if (history !== undefined) {
		if (history.obelisk_home !== undefined && history.obelisk_home !== null) out["VESTIGIO_OBELISK_HOME"] = history.obelisk_home;
		if (history.obelisk_cli !== undefined && history.obelisk_cli !== null) out["VESTIGIO_OBELISK_CLI"] = history.obelisk_cli;
	}
	const logging = file.logging;
	if (logging !== undefined && logging.decision_log !== undefined && logging.decision_log !== null) {
		out["VESTIGIO_DECISION_LOG"] = logging.decision_log;
	}
	if (logging?.activity !== undefined) out["VESTIGIO_ACTIVITY"] = logging.activity ? "1" : "0";
	return out;
}

/** The defaults a fresh config file should carry, as dotted keys. */
export const CONFIG_DEFAULTS = {
	"retrieval.budget_bytes": DEFAULT_INJECTION_BUDGET_BYTES,
	"retrieval.max_memories": DEFAULT_MAX_HOTSPOT_MEMORIES,
	"retrieval.min_score": DEFAULT_MIN_MATCH_SCORE,
	"retrieval.pool_capacity": DEFAULT_HOTSPOT_POOL_CAPACITY,
	"retrieval.timeout_ms": DEFAULT_HOTSPOT_TIMEOUT_MS,
	"logging.activity": false,
} as const;

function parseConfig(text: string, path: string, options: ConfigOptions): ConfigFile {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error(`vestigio config ${path}: invalid JSON (${message(error)})`);
	}
	const root = objectAt(raw, path, "");
	onlyKeys(root, path, "", ROOT_KEYS);
	const version = root["version"];
	if (version !== undefined && version !== CONFIG_VERSION) {
		throw new Error(`vestigio config ${path}: version ${JSON.stringify(version)} is not supported, expected ${CONFIG_VERSION}`);
	}
	const base = dirname(path);
	const file: { store?: string; model?: ModelSection; retrieval?: RetrievalSection; history?: HistorySection; logging?: LoggingSection } = {};
	if (root["store"] !== undefined) file.store = pathAt(root["store"], path, "store", base, options);
	if (root["model"] !== undefined) file.model = parseModel(root["model"], path);
	if (root["retrieval"] !== undefined) file.retrieval = parseRetrieval(root["retrieval"], path);
	if (root["history"] !== undefined) file.history = parseHistory(root["history"], path, base, options);
	if (root["logging"] !== undefined) file.logging = parseLogging(root["logging"], path, base, options);
	return file;
}

function parseModel(section: unknown, path: string): ModelSection {
	const record = objectAt(section, path, "model");
	onlyKeys(record, path, "model", MODEL_KEYS);
	const out: { base_url?: string; id?: string; api_key?: string | null; thinking?: ModelThinking } = {};
	if (record["base_url"] !== undefined) out.base_url = urlAt(record["base_url"], path, "model.base_url");
	if (record["id"] !== undefined) out.id = stringAt(record["id"], path, "model.id");
	if (record["api_key"] !== undefined) {
		out.api_key = record["api_key"] === null ? null : stringAt(record["api_key"], path, "model.api_key");
	}
	if (record["thinking"] !== undefined) out.thinking = thinkingAt(record["thinking"], path, "model.thinking");
	return out;
}

function parseRetrieval(section: unknown, path: string): RetrievalSection {
	const record = objectAt(section, path, "retrieval");
	onlyKeys(record, path, "retrieval", RETRIEVAL_KEYS);
	const out: {
		budget_bytes?: number;
		max_memories?: number;
		min_score?: number;
		pool_capacity?: number;
		timeout_ms?: number;
	} = {};
	if (record["budget_bytes"] !== undefined) out.budget_bytes = integerAt(record["budget_bytes"], path, "retrieval.budget_bytes", 64);
	if (record["max_memories"] !== undefined) out.max_memories = integerAt(record["max_memories"], path, "retrieval.max_memories", 1);
	if (record["min_score"] !== undefined) out.min_score = integerAt(record["min_score"], path, "retrieval.min_score", 1);
	if (record["pool_capacity"] !== undefined) out.pool_capacity = integerAt(record["pool_capacity"], path, "retrieval.pool_capacity", 1);
	if (record["timeout_ms"] !== undefined) out.timeout_ms = integerAt(record["timeout_ms"], path, "retrieval.timeout_ms", 1);
	return out;
}

function parseHistory(section: unknown, path: string, base: string, options: ConfigOptions): HistorySection {
	const record = objectAt(section, path, "history");
	onlyKeys(record, path, "history", HISTORY_KEYS);
	const out: { obelisk_home?: string | null; obelisk_cli?: string | null } = {};
	if (record["obelisk_home"] !== undefined) {
		out.obelisk_home = record["obelisk_home"] === null ? null : pathAt(record["obelisk_home"], path, "history.obelisk_home", base, options);
	}
	if (record["obelisk_cli"] !== undefined) {
		out.obelisk_cli = record["obelisk_cli"] === null ? null : pathAt(record["obelisk_cli"], path, "history.obelisk_cli", base, options);
	}
	return out;
}

function parseLogging(section: unknown, path: string, base: string, options: ConfigOptions): LoggingSection {
	const record = objectAt(section, path, "logging");
	onlyKeys(record, path, "logging", LOGGING_KEYS);
	const out: { decision_log?: string | null; activity?: boolean } = {};
	if (record["decision_log"] !== undefined) {
		out.decision_log = record["decision_log"] === null ? null : pathAt(record["decision_log"], path, "logging.decision_log", base, options);
	}
	if (record["activity"] !== undefined) out.activity = boolAt(record["activity"], path, "logging.activity");
	return out;
}

function objectAt(value: unknown, path: string, where: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`vestigio config ${path}: ${where.length === 0 ? "the file" : where} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

function onlyKeys(record: Record<string, unknown>, path: string, where: string, allowed: readonly string[]): void {
	for (const key of Object.keys(record)) {
		if (allowed.includes(key)) continue;
		throw new Error(`vestigio config ${path}: unknown key ${where.length === 0 ? key : `${where}.${key}`}`);
	}
}

function stringAt(value: unknown, path: string, where: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`vestigio config ${path}: ${where} must be a non-empty string`);
	}
	return value.trim();
}

function urlAt(value: unknown, path: string, where: string): string {
	const text = stringAt(value, path, where);
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		throw new Error(`vestigio config ${path}: ${where} must be an http(s) URL`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`vestigio config ${path}: ${where} must be an http(s) URL`);
	}
	return text;
}

function integerAt(value: unknown, path: string, where: string, min: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
		throw new Error(`vestigio config ${path}: ${where} must be an integer >= ${min}`);
	}
	return value;
}

function boolAt(value: unknown, path: string, where: string): boolean {
	if (typeof value !== "boolean") throw new Error(`vestigio config ${path}: ${where} must be true or false`);
	return value;
}

function thinkingAt(value: unknown, path: string, where: string): ModelThinking {
	if (typeof value !== "string" || !(THINKING_LEVELS as readonly string[]).includes(value)) {
		throw new Error(`vestigio config ${path}: ${where} must be one of ${THINKING_LEVELS.join(", ")}`);
	}
	return value as ModelThinking;
}

function pathAt(value: unknown, path: string, where: string, base: string, options: ConfigOptions): string {
	const expanded = expandHome(stringAt(value, path, where), options);
	return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

function expandHome(value: string, options: ConfigOptions): string {
	const home = options.home ?? homedir();
	if (value === "~") return home;
	if (value.startsWith("~/")) return join(home, value.slice(2));
	return value;
}

function readIfPresent(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`vestigio config ${path}: ${message(error)}`);
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
