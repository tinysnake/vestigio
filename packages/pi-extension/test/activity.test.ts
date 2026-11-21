/**
 * The activity panel: what each memory event looks like on screen, and the
 * bound that keeps the widget small. The panel is a view over the same events
 * the decision log records, so the tests stay on formatting and rendering and
 * never touch a store.
 */

import { describe, expect, it, vi } from "vitest";
import {
	ACTIVITY_MAX_LINES,
	ACTIVITY_WIDGET_KEY,
	ActivityPanel,
	clip,
	formatInjection,
	formatJobEvent,
	formatNotInjected,
	formatToolEvent,
	line,
	shortMemory,
} from "../src/activity.js";

function fakeCtx(hasUI = true) {
	const setWidget = vi.fn();
	return { ctx: { hasUI, ui: { setWidget } } as never, setWidget };
}

const stale = { is_stale: true };
const fresh = { is_stale: false };

describe("clip", () => {
	it("keeps short text and cuts the rest on one line", () => {
		expect(clip("部署脚本", 10)).toBe("部署脚本");
		expect(clip("a  b\nc", 10)).toBe("a b c");
		expect(Array.from(clip("部署脚本默认端口需要一起改", 6))).toHaveLength(6);
		expect(clip("部署脚本默认端口需要一起改", 6)).toMatch(/…$/u);
	});
});

describe("shortMemory", () => {
	it("shortens a uri or a bare id", () => {
		expect(shortMemory("memory://vestigio/mem-deploy-port")).toBe("mem-deploy-port");
		expect(shortMemory("mem-a")).toBe("mem-a");
		const long = shortMemory("memory://vestigio/9f8e7d6c-5b4a-3928-1706-050403020100");
		expect(Array.from(long)).toHaveLength(21);
		expect(long.endsWith("…")).toBe(true);
	});
});

describe("formatInjection", () => {
	it("reports the delivery, its size, and marks a stale memory", () => {
		const lines = formatInjection({
			injected: [
				{ title: "部署脚本默认端口", freshness: fresh },
				{ title: "接口约定", freshness: stale },
			],
			matched: [{}, {}, {}],
			budget: { used_bytes: 520 },
			elapsed_ms: 9,
		});
		expect(lines[0]).toEqual(line("info", "注入 2/3 · 520B · 9ms"));
		expect(lines[1]).toEqual(line("note", "部署脚本默认端口"));
		expect(lines[2]).toEqual(line("warn", "接口约定（过期）"));
	});

	it("uses kilobytes once the block passes 1024 bytes", () => {
		const lines = formatInjection({ injected: [], matched: [], budget: { used_bytes: 2048 }, elapsed_ms: 1 });
		expect(lines[0]?.text).toBe("注入 0/0 · 2.0KB · 1ms");
	});
});

describe("formatNotInjected", () => {
	it("names the common reasons in words", () => {
		expect(formatNotInjected("no_match")).toEqual(line("info", "未注入 · 无匹配"));
		expect(formatNotInjected("all_deduped")).toEqual(line("info", "未注入 · 本会话已给过"));
		expect(formatNotInjected("store_error")).toEqual(line("warn", "未注入 · 记忆库出错"));
	});

	it("says nothing about input memory never saw", () => {
		expect(formatNotInjected("slash_command")).toBeNull();
		expect(formatNotInjected("extension_source")).toBeNull();
		expect(formatNotInjected("empty_input")).toBeNull();
	});

	it("passes an unknown reason through instead of hiding it", () => {
		expect(formatNotInjected("weird")).toEqual(line("info", "未注入 · weird"));
	});
});

describe("formatToolEvent", () => {
	it("reports a read with its revision and freshness", () => {
		const payload = { op: "memory.read", uri: "memory://vestigio/mem-a" };
		expect(formatToolEvent("memory.read", payload, { status: "resolved", revision: 3, freshness: fresh })).toEqual([
			line("info", "读取 mem-a · r3"),
		]);
		expect(formatToolEvent("memory.read", payload, { status: "resolved", revision: 4, freshness: stale })).toEqual([
			line("warn", "读取 mem-a · r4 · 过期"),
		]);
		expect(formatToolEvent("memory.read", payload, { status: "not_found" })).toEqual([line("warn", "读取 mem-a · not_found")]);
	});

	it("reports how many cards a search or resolve returned", () => {
		expect(formatToolEvent("memory.search", { query: "部署 端口" }, { status: "ok", cards: [{}, {}] })).toEqual([
			line("info", "检索 “部署 端口” → 2 条"),
		]);
		expect(formatToolEvent("memory.resolve", { question: "端口是多少" }, { status: "resolved", cards: [{}] })).toEqual([
			line("info", "解析 “端口是多少” → resolved · 1 条"),
		]);
	});

	it("reports a stale mark as recorded or refused", () => {
		const payload = { uri: "memory://vestigio/mem-a" };
		expect(formatToolEvent("stale.publish", payload, { status: "ok", inserted: 1, events: [{ recorded: true }] })).toEqual([
			line("warn", "标记过期 mem-a · 已记录"),
		]);
		expect(formatToolEvent("stale.publish", payload, { status: "ok", inserted: 0, events: [{ recorded: false }] })).toEqual([
			line("error", "标记过期 mem-a · 未记录 · 1 条被拒"),
		]);
	});
});

describe("formatJobEvent", () => {
	it("shows a detector finding and stays quiet on a clean turn", () => {
		expect(formatJobEvent("detector.run", "succeeded", { detected: 0 })).toEqual([]);
		expect(formatJobEvent("detector.run", "succeeded", { detected: 1, publish_pending: 1 })).toEqual([
			line("warn", "检测到 1 处变更 · 1 条待标记"),
		]);
	});

	it("shows repairs and saves only when something landed", () => {
		expect(formatJobEvent("repair.memories", "succeeded", { repaired: 0 })).toEqual([]);
		expect(formatJobEvent("repair.memories", "succeeded", { repaired: 2 })).toEqual([line("info", "已修复 2 条记忆")]);
		expect(formatJobEvent("request.process", "succeeded", { saved: 1, merged: 1 })).toEqual([line("info", "保存 2 条记忆")]);
	});

	it("reports a failed job by name", () => {
		expect(formatJobEvent("repair.memories", "failed", {})).toEqual([line("error", "记忆修复 失败 · failed")]);
		expect(formatJobEvent("unknown.op", "cancelled", {})).toEqual([line("error", "unknown.op 失败 · cancelled")]);
	});
});

describe("ActivityPanel", () => {
	it("stays hidden unless enabled", () => {
		const panel = new ActivityPanel();
		const { ctx, setWidget } = fakeCtx();
		panel.push(ctx, line("info", "事件"));
		expect(panel.active).toBe(false);
		expect(setWidget).not.toHaveBeenCalled();
		expect(new ActivityPanel(true).active).toBe(true);
	});

	it("keeps the newest lines and renders them as a widget", () => {
		const panel = new ActivityPanel(true);
		const { ctx, setWidget } = fakeCtx();
		for (let index = 0; index < ACTIVITY_MAX_LINES + 3; index += 1) {
			panel.push(ctx, line("info", `事件 ${index}`));
		}
		const [, content] = setWidget.mock.lastCall as [string, string[]];
		expect(setWidget.mock.lastCall?.[0]).toBe(ACTIVITY_WIDGET_KEY);
		expect(content).toHaveLength(ACTIVITY_MAX_LINES);
		expect(content[0]).toBe("· 事件 3");
		expect(content.at(-1)).toBe(`· 事件 ${ACTIVITY_MAX_LINES + 2}`);
	});

	it("renders nothing without a UI and never throws", () => {
		const panel = new ActivityPanel(true);
		const { ctx, setWidget } = fakeCtx(false);
		panel.push(ctx, line("info", "事件"));
		expect(setWidget).not.toHaveBeenCalled();
		const throwing = { hasUI: true, ui: { setWidget: () => { throw new Error("no terminal"); } } } as never;
		expect(() => panel.push(throwing, line("error", "事件"))).not.toThrow();
	});

	it("stops rendering and clears the widget when turned off", () => {
		const panel = new ActivityPanel(true);
		const { ctx, setWidget } = fakeCtx();
		panel.push(ctx, line("info", "事件"));
		panel.setEnabled(false, ctx);
		expect(panel.active).toBe(false);
		expect(setWidget.mock.lastCall).toEqual([ACTIVITY_WIDGET_KEY, undefined]);
		panel.push(ctx, line("info", "另一条"));
		expect(setWidget.mock.lastCall).toEqual([ACTIVITY_WIDGET_KEY, undefined]);
		panel.setEnabled(true, ctx);
		panel.push(ctx, line("info", "回来了"));
		expect(setWidget.mock.lastCall?.[1]).toEqual(["· 回来了"]);
	});

	it("clears on demand", () => {
		const panel = new ActivityPanel(true);
		const { ctx, setWidget } = fakeCtx();
		panel.push(ctx, line("warn", "事件"));
		panel.clear();
		expect(panel.shown).toHaveLength(0);
		expect(setWidget.mock.lastCall).toEqual([ACTIVITY_WIDGET_KEY, undefined]);
	});
});
