import { describe, expect, it } from "vitest";
import { VESTIGIO_DEFAULTS, readConfig } from "../src/config.js";

describe("readConfig", () => {
	it("is inert without VESTIGIO_STORE", () => {
		const config = readConfig({});
		expect(config.enabled).toBe(false);
		expect(config.store_path).toBeNull();
		expect(config.project_id).toBeNull();
	});

	it("ignores a blank store path instead of opening something", () => {
		const config = readConfig({ VESTIGIO_STORE: "   " });
		expect(config.enabled).toBe(false);
	});

	it("uses the contract defaults for every knob", () => {
		const config = readConfig({ VESTIGIO_STORE: "/tmp/memory.sqlite" });
		expect(config.enabled).toBe(true);
		expect(config.store_path).toBe("/tmp/memory.sqlite");
		expect(config.budget_bytes).toBe(VESTIGIO_DEFAULTS.budget_bytes);
		expect(config.max_memories).toBe(VESTIGIO_DEFAULTS.max_memories);
		expect(config.min_score).toBe(VESTIGIO_DEFAULTS.min_score);
		expect(config.pool_capacity).toBe(VESTIGIO_DEFAULTS.pool_capacity);
		expect(config.timeout_ms).toBe(VESTIGIO_DEFAULTS.timeout_ms);
		expect(config.repair_mode).toBe("inline");
		expect(config.decision_log).toBeNull();
	});

	it("accepts the background repair mode", () => {
		const config = readConfig({ VESTIGIO_STORE: "/tmp/memory.sqlite", VESTIGIO_REPAIR_MODE: "background" });
		expect(config.repair_mode).toBe("background");
	});

	it("tolerates surrounding whitespace on the repair mode", () => {
		const config = readConfig({ VESTIGIO_STORE: "/tmp/memory.sqlite", VESTIGIO_REPAIR_MODE: "  background  " });
		expect(config.repair_mode).toBe("background");
	});

	it("falls back to inline for a garbage repair mode", () => {
		const config = readConfig({ VESTIGIO_STORE: "/tmp/memory.sqlite", VESTIGIO_REPAIR_MODE: "maybe" });
		expect(config.repair_mode).toBe("inline");
	});

	it("honours overrides", () => {
		const config = readConfig({
			VESTIGIO_STORE: "/tmp/memory.sqlite",
			VESTIGIO_PROJECT_ID: "/work/sprout-mio",
			VESTIGIO_OBELISK_HOME: "/Users/x",
			VESTIGIO_INJECTION_BUDGET_BYTES: "2048",
			VESTIGIO_MAX_MEMORIES: "2",
			VESTIGIO_POOL_CAPACITY: "8",
			VESTIGIO_MATCH_TIMEOUT_MS: "250",
			VESTIGIO_DECISION_LOG: "/tmp/vestigio.jsonl",
		});
		expect(config.project_id).toBe("/work/sprout-mio");
		expect(config.obelisk_home).toBe("/Users/x");
		expect(config.budget_bytes).toBe(2048);
		expect(config.max_memories).toBe(2);
		expect(config.pool_capacity).toBe(8);
		expect(config.timeout_ms).toBe(250);
		expect(config.decision_log).toBe("/tmp/vestigio.jsonl");
	});

	it("falls back rather than accepting a garbage integer", () => {
		const config = readConfig({
			VESTIGIO_STORE: "/tmp/memory.sqlite",
			VESTIGIO_MAX_MEMORIES: "-3",
			VESTIGIO_MATCH_TIMEOUT_MS: "soon",
		});
		expect(config.max_memories).toBe(VESTIGIO_DEFAULTS.max_memories);
		expect(config.timeout_ms).toBe(VESTIGIO_DEFAULTS.timeout_ms);
	});
});
