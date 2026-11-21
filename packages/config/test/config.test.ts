import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CONFIG_DEFAULTS,
	CONFIG_PATH_ENV,
	applyConfigToEnv,
	configToEnv,
	defaultConfigPath,
	agentModelEnvKey,
	agentModelSettings,
	loadConfigFile,
	resolveEnv,
	saveActivity,
} from "../src/index.js";

function tempHome(config: unknown = null): string {
	const home = mkdtempSync(join(tmpdir(), "vestigio-config-"));
	if (config !== null) {
		mkdirSync(join(home, ".vestigio"), { recursive: true });
		writeFileSync(join(home, ".vestigio", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
	}
	return home;
}

function writeConfig(file: string, config: unknown): string {
	writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config));
	return file;
}

describe("loadConfigFile", () => {
	it("returns null when the default file does not exist", () => {
		const home = tempHome();
		expect(loadConfigFile({}, { home })).toBeNull();
		expect(defaultConfigPath({ home })).toBe(join(home, ".vestigio", "config.json"));
	});

	it("reads the default file and expands home-relative paths", () => {
		const home = tempHome({ version: 1, store: "~/.vestigio/data/store.sqlite" });
		const file = loadConfigFile({}, { home });
		expect(file?.store).toBe(join(home, ".vestigio/data/store.sqlite"));
	});

	it("resolves a relative path against the config file directory", () => {
		const home = tempHome({ store: "data/store.sqlite" });
		expect(loadConfigFile({}, { home })?.store).toBe(join(home, ".vestigio/data/store.sqlite"));
	});

	it("reads an explicit VESTIGIO_CONFIG path", () => {
		const home = tempHome();
		const file = writeConfig(join(home, "elsewhere.json"), { store: "/tmp/store.sqlite" });
		expect(loadConfigFile({ [CONFIG_PATH_ENV]: file }, { home })?.store).toBe("/tmp/store.sqlite");
	});

	it("treats an empty VESTIGIO_CONFIG as no file, even when the default exists", () => {
		const home = tempHome({ store: "/tmp/store.sqlite" });
		expect(loadConfigFile({ [CONFIG_PATH_ENV]: "" }, { home })).toBeNull();
	});

	it("reports a missing explicit file instead of falling back", () => {
		const home = tempHome();
		expect(() => loadConfigFile({ [CONFIG_PATH_ENV]: join(home, "missing.json") }, { home })).toThrow(
			/vestigio config .*missing\.json: file not found/,
		);
	});

	it("rejects invalid JSON with the file path", () => {
		const home = tempHome("{ nope");
		expect(() => loadConfigFile({}, { home })).toThrow(/vestigio config .*config\.json: invalid JSON/);
	});

	it("rejects an unknown key instead of ignoring it", () => {
		const home = tempHome({ retreival: {} });
		expect(() => loadConfigFile({}, { home })).toThrow(/unknown key retreival/);
	});

	it("rejects an unsupported version", () => {
		const home = tempHome({ version: 2 });
		expect(() => loadConfigFile({}, { home })).toThrow(/version 2 is not supported/);
	});

	it("rejects a bad thinking level and a non-http model URL", () => {
		expect(() => loadConfigFile({}, { home: tempHome({ model: { thinking: "max" } }) })).toThrow(/model\.thinking/);
		expect(() => loadConfigFile({}, { home: tempHome({ model: { base_url: "ftp://example.com" } }) })).toThrow(/http\(s\) URL/);
	});
});

describe("resolveEnv", () => {
	it("fills missing variables and keeps ones already set", () => {
		const home = tempHome({
			store: "/tmp/from-file.sqlite",
			model: { base_url: "http://127.0.0.1:11434/v1", id: "from-file", api_key: "sk-file" },
			retrieval: { budget_bytes: 2048, max_memories: 4 },
		});
		const env = resolveEnv({ VESTIGIO_STORE: "/tmp/from-env.sqlite", VESTIGIO_MODEL_ID: "from-env" }, { home });
		expect(env.VESTIGIO_STORE).toBe("/tmp/from-env.sqlite");
		expect(env.VESTIGIO_MODEL_ID).toBe("from-env");
		expect(env.VESTIGIO_MODEL_BASE_URL).toBe("http://127.0.0.1:11434/v1");
		expect(env.VESTIGIO_MODEL_API_KEY).toBe("sk-file");
		expect(env.VESTIGIO_INJECTION_BUDGET_BYTES).toBe("2048");
		expect(env.VESTIGIO_MAX_MEMORIES).toBe("4");
		expect(env.VESTIGIO_MIN_SCORE).toBeUndefined();
	});

	it("treats an empty variable as unset", () => {
		const home = tempHome({ store: "/tmp/from-file.sqlite" });
		expect(resolveEnv({ VESTIGIO_STORE: "" }, { home }).VESTIGIO_STORE).toBe("/tmp/from-file.sqlite");
	});

	it("does not mutate the environment it was given", () => {
		const home = tempHome({ store: "/tmp/from-file.sqlite" });
		const base = { PATH: "/usr/bin" };
		resolveEnv(base, { home });
		expect(base).toEqual({ PATH: "/usr/bin" });
	});

	it("leaves the environment alone when no file is read", () => {
		expect(resolveEnv({ VESTIGIO_STORE: "/tmp/a.sqlite" }, { home: tempHome() })).toEqual({ VESTIGIO_STORE: "/tmp/a.sqlite" });
	});

	it("applyConfigToEnv writes the resolved values into the target", () => {
		const home = tempHome({ store: "/tmp/from-file.sqlite" });
		const env: Record<string, string | undefined> = {};
		applyConfigToEnv(env, { home });
		expect(env.VESTIGIO_STORE).toBe("/tmp/from-file.sqlite");
	});
});

describe("configToEnv", () => {
	it("maps the store to both variable names and skips a null api key", () => {
		const env = configToEnv({ store: "/tmp/s.sqlite", model: { api_key: null, id: "m" }, logging: { decision_log: null } });
		expect(env).toEqual({ VESTIGIO_STORE: "/tmp/s.sqlite", VESTIGIO_DB: "/tmp/s.sqlite", VESTIGIO_MODEL_ID: "m" });
	});

	it("exposes the values a fresh file should carry", () => {
		expect(CONFIG_DEFAULTS["retrieval.budget_bytes"]).toBe(4096);
		expect(CONFIG_DEFAULTS["retrieval.timeout_ms"]).toBe(1000);
	});
});

describe("model.agents", () => {
	it("reads per-agent models and inherits nothing it was not given", () => {
		const file = loadConfigFile(
			{},
			{ home: tempHome({ model: { id: "base", agents: { detector: { id: "cheap" }, nav: {} } } }) },
		);
		expect(file?.model).toEqual({ id: "base", agents: { detector: { id: "cheap" }, nav: {} } });
	});

	it("rejects an unknown agent and an unknown field", () => {
		expect(() => loadConfigFile({}, { home: tempHome({ model: { agents: { summariser: { id: "x" } } } }) })).toThrow(
			/model\.agents\.summariser/,
		);
		expect(() => loadConfigFile({}, { home: tempHome({ model: { agents: { detector: { base_url: "http://x" } } } }) })).toThrow(
			/model\.agents\.detector\.base_url/,
		);
	});

	it("maps each override to its own variables", () => {
		const env = configToEnv({
			model: { base_url: "http://x/v1", id: "base", agents: { detector: { id: "cheap", thinking: "off" } } },
		});
		expect(env["VESTIGIO_MODEL_DETECTOR_ID"]).toBe("cheap");
		expect(env["VESTIGIO_MODEL_DETECTOR_THINKING"]).toBe("off");
		expect(env["VESTIGIO_MODEL_ID"]).toBe("base");
	});

	it("feeds the routing port from the environment and ignores blank or bad values", () => {
		expect(agentModelSettings({})).toEqual({});
		expect(agentModelSettings({ VESTIGIO_MODEL_DETECTOR_ID: "cheap" })).toEqual({ detector: { model: "cheap" } });
		expect(agentModelSettings({ VESTIGIO_MODEL_NAV_ID: " ", VESTIGIO_MODEL_NAV_THINKING: "loud" })).toEqual({});
		expect(agentModelEnvKey("extraction", "ID")).toBe("VESTIGIO_MODEL_EXTRACTION_ID");
		expect(
			agentModelSettings({ VESTIGIO_MODEL_RESOLVER_ID: "big", VESTIGIO_MODEL_RESOLVER_THINKING: "high" }),
		).toEqual({ resolver: { model: "big", thinking: "high" } });
	});

	it("reaches the entry points through resolveEnv", () => {
		const home = tempHome({ model: { base_url: "http://x/v1", agents: { extraction: { id: "cheap" } } } });
		expect(resolveEnv({}, { home })["VESTIGIO_MODEL_EXTRACTION_ID"]).toBe("cheap");
	});
});

describe("logging.activity", () => {
	it("defaults off and reaches the environment as a flag", () => {
		expect(loadConfigFile({}, { home: tempHome() })).toBeNull();
		expect(configToEnv({ logging: { activity: true } })).toEqual({ VESTIGIO_ACTIVITY: "1" });
		expect(configToEnv({ logging: { activity: false } })).toEqual({ VESTIGIO_ACTIVITY: "0" });
		expect(CONFIG_DEFAULTS["logging.activity"]).toBe(false);
	});

	it("rejects a non-boolean value", () => {
		const home = tempHome({ logging: { activity: "yes please" } });
		expect(() => loadConfigFile({}, { home })).toThrow("vestigio config");
	});

	it("is overridden by an explicit variable", () => {
		const home = tempHome({ logging: { activity: true } });
		expect(resolveEnv({ VESTIGIO_ACTIVITY: "0" }, { home }).VESTIGIO_ACTIVITY).toBe("0");
	});
});

describe("saveActivity", () => {
	it("creates the default file and keeps other keys", () => {
		const home = tempHome({ store: "/tmp/s.sqlite", model: { id: "m" } });
		const path = defaultConfigPath({ home });
		expect(saveActivity(true, {}, { home })).toEqual({ status: "saved", path });
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.store).toBe("/tmp/s.sqlite");
		expect(saved.model).toEqual({ id: "m" });
		expect(saved.logging).toEqual({ activity: true });
		saveActivity(false, {}, { home });
		const next = loadConfigFile({}, { home });
		expect(next?.logging?.activity).toBe(false);
		expect(next?.store).toBe("/tmp/s.sqlite");
	});

	it("writes a fresh file when the default one is missing", () => {
		const home = tempHome();
		const path = join(home, ".vestigio", "config.json");
		expect(saveActivity(true, {}, { home })).toEqual({ status: "saved", path });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ logging: { activity: true } });
	});

	it("refuses a path the operator named but never created", () => {
		const home = tempHome();
		const missing = join(home, "absent.json");
		expect(saveActivity(true, { [CONFIG_PATH_ENV]: missing }, { home })).toEqual({ status: "no_file" });
		expect(saveActivity(true, { [CONFIG_PATH_ENV]: "" }, { home })).toEqual({ status: "no_file" });
	});

	it("leaves a broken file alone", () => {
		const home = tempHome("{ not json");
		const path = join(home, ".vestigio", "config.json");
		const result = saveActivity(true, {}, { home });
		expect(result.status).toBe("error");
		expect(readFileSync(path, "utf8")).toBe("{ not json");
	});
});
