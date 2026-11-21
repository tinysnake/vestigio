import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiDaemon } from "../src/daemon-client.js";
import vestigio, { STALE_MAINTENANCE_INSTRUCTIONS } from "../src/extension.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

type CommandHandler = (args: string, ctx: Record<string, unknown>) => Promise<void>;

function stubPi() {
	const handlers = new Map<string, Handler>();
	const tools: string[] = [];
	const commands = new Map<string, CommandHandler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		appendEntry() {},
	};
	return { pi, handlers, tools, commands };
}

function uiCtx() {
	const setWidget = vi.fn();
	const notify = vi.fn();
	const branch = [{ id: "root" }, { id: "turn" }];
	return {
		setWidget,
		notify,
		ctx: { hasUI: true, sessionManager: { getBranch: () => branch }, ui: { setWidget, notify } },
		branch,
	};
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

	it("states the one repair path and the answer rule", () => {
		expect(STALE_MAINTENANCE_INSTRUCTIONS).toContain("You cannot rewrite a stored memory");
		expect(STALE_MAINTENANCE_INSTRUCTIONS).toContain("repaired at the end of the session");
		expect(STALE_MAINTENANCE_INSTRUCTIONS).toContain("never repeat the stale value as current");
	});

	it("is inert without a store path", () => {
		const { pi, handlers } = stubPi();
		withEnv({ VESTIGIO_STORE: "" }, () => vestigio(pi as never));
		expect(handlers.size).toBe(0);
	});

	it("only displays a late repair on a branch containing the originating turn", () => {
		const { pi, handlers } = stubPi();
		const bind = vi.spyOn(PiDaemon.prototype, "bind").mockImplementation(() => {});
		cleanups.push(() => bind.mockRestore());
		withEnv({ VESTIGIO_STORE: "/tmp/vestigio-branch-test.sqlite" }, () => vestigio(pi as never));
		let branch = [{ id: "root" }, { id: "original" }];
		const notify = vi.fn();
		const ctx = { sessionManager: { getBranch: () => branch }, ui: { notify } };
		handlers.get("session_start")!({}, ctx);
		branch = [{ id: "root" }, { id: "sibling" }];
		handlers.get("session_tree")!({}, ctx);
		const deliver = bind.mock.lastCall![1];
		const event = {
			eventId: "event", jobId: "job", sessionRef: 1, kind: "maintenance", state: "succeeded",
			resultCode: "ok", createdAt: 1, expiresAt: 2,
			result: { turnLeaf: "original", op: "repair.memories", result: { repaired: 1 } },
		} as const;
		deliver(event);
		expect(notify).not.toHaveBeenCalled();
		branch = [{ id: "root" }, { id: "original" }, { id: "next-turn" }];
		deliver(event);
		expect(notify).toHaveBeenCalledOnce();
	});

	it("registers the activity panel command and hides the panel on off", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vestigio-ext-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const { pi, commands } = stubPi();
		const bind = vi.spyOn(PiDaemon.prototype, "bind").mockImplementation(() => {});
		cleanups.push(() => bind.mockRestore());
		withEnv({ VESTIGIO_STORE: join(dir, "store.sqlite") }, () => vestigio(pi as never));
		const { setWidget, notify, ctx } = uiCtx();
		const command = commands.get("vestigio-log");
		expect(command).toBeDefined();
		await command!("off", ctx);
		expect(setWidget.mock.lastCall).toEqual(["vestigio-activity", undefined]);
		expect(notify).toHaveBeenLastCalledWith("记忆活动面板已关闭", "info");
	});

	it("shows a delivered job in the panel", () => {
		const dir = mkdtempSync(join(tmpdir(), "vestigio-ext-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const { pi, handlers } = stubPi();
		const bind = vi.spyOn(PiDaemon.prototype, "bind").mockImplementation(() => {});
		cleanups.push(() => bind.mockRestore());
		withEnv({ VESTIGIO_STORE: join(dir, "store.sqlite") }, () => vestigio(pi as never));
		const { setWidget, ctx } = uiCtx();
		handlers.get("session_start")!({}, ctx);
		const deliver = bind.mock.lastCall![1];
		deliver({
			eventId: "event", jobId: "job", sessionRef: 1, kind: "maintenance", state: "succeeded",
			resultCode: "ok", createdAt: 1, expiresAt: 2,
			result: { turnLeaf: "turn", op: "repair.memories", result: { repaired: 1 } },
		} as never);
		expect(setWidget.mock.lastCall?.[1]).toContain("· 已修复 1 条记忆");
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
