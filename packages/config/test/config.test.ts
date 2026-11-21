import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CONFIG_DEFAULTS,
	CONFIG_PATH_ENV,
	applyConfigToEnv,
	configToEnv,
	defaultConfigPath,
	loadConfigFile,
	resolveEnv,
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
