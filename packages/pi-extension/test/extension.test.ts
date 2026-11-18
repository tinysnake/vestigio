import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import vestigio, { STALE_MAINTENANCE_INSTRUCTIONS } from "../src/extension.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function stubPi() {
	const handlers = new Map<string, Handler>();
	const tools: string[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		appendEntry() {},
	};
	return { pi, handlers, tools };
}

function withEnv(env: Record<string, string>, fn: () => void): void {
	const previous: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		previous[key] = process.env[key];
		process.env[key] = value;
	}
	try {
		fn();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe("vestigio extension", () => {
	it("appends the maintenance instruction without replacing the host prompt", () => {
		const dir = mkdtempSync(join(tmpdir(), "vestigio-ext-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const { pi, handlers, tools } = stubPi();
		withEnv({ VESTIGIO_STORE: join(dir, "store.sqlite") }, () => vestigio(pi as never));
		expect(handlers.has("before_agent_start")).toBe(true);
		expect(handlers.has("agent_end")).toBe(true);
		expect(handlers.has("input")).toBe(true);
		expect(tools).toContain("memory_mark_stale");
		expect(tools).not.toContain("memory_update");
		const result = handlers.get("before_agent_start")!({ systemPrompt: "HOST PROMPT" }, {}) as {
			systemPrompt: string;
		};
		expect(result.systemPrompt.startsWith("HOST PROMPT\n\n")).toBe(true);
		expect(result.systemPrompt).toContain(STALE_MAINTENANCE_INSTRUCTIONS);
	});

	it("is inert without a store path", () => {
		const { pi, handlers } = stubPi();
		withEnv({ VESTIGIO_STORE: "" }, () => vestigio(pi as never));
		expect(handlers.size).toBe(0);
	});

	it("agent_end skips cleanly when the store has nothing seen", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vestigio-ext-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const { pi, handlers } = stubPi();
		withEnv({ VESTIGIO_STORE: join(dir, "store.sqlite") }, () => vestigio(pi as never));
		const sessionManager = {
			getSessionId: () => "s-1",
			getBranch: () => [{ id: "root" }],
			getEntries: () => [],
			getLeafId: () => null,
			getSessionFile: () => null,
		};
		await expect(handlers.get("agent_end")!({ messages: [] }, { cwd: dir, sessionManager })).resolves.toBeUndefined();
	});
});
