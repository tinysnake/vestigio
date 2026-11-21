/**
 * The on-screen activity panel: what memory did during this session, in the
 * order it happened. The decision log on disk records the same operations for
 * offline analysis; the panel exists so the operator can see delivery, reads
 * and staleness while the session runs, without a debugger or a log tail.
 *
 * One line per event, newest last so the panel sits next to the editor, capped
 * at `ACTIVITY_MAX_LINES`. Rendering is fire-and-forget: a host without a UI,
 * or a widget call that throws, must never break a turn.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ACTIVITY_WIDGET_KEY = "vestigio-activity";
export const ACTIVITY_MAX_LINES = 8;
const TITLE_CHARS = 34;
const QUERY_CHARS = 24;

export type Tone = "info" | "note" | "warn" | "error";
export type LogLine = { readonly tone: Tone; readonly text: string };

const MARKERS: Record<Tone, string> = { info: "· ", note: "  ", warn: "! ", error: "× " };

export function line(tone: Tone, text: string): LogLine {
	return { tone, text };
}

export function clip(text: string, max: number): string {
	const chars = Array.from(text.trim().replace(/\s+/gu, " "));
	return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

function size(bytes: number): string {
	return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

const ID_CHARS = 20;

/** A memory id shortened for the panel; the full id stays in the decision log. */
export function shortMemory(memoryId: string): string {
	const bare = memoryId.startsWith("memory://") ? (memoryId.split("/").at(-1) ?? memoryId) : memoryId;
	return bare.length > ID_CHARS ? `${bare.slice(0, ID_CHARS)}…` : bare;
}

/* ------------------------------------------------------------- injection */

export type InjectionPlanLike = {
	readonly injected: readonly { readonly title: string; readonly freshness: { readonly is_stale: boolean } }[];
	readonly matched: readonly unknown[];
	readonly budget: { readonly used_bytes: number };
	readonly elapsed_ms: number;
};

export function formatInjection(plan: InjectionPlanLike): LogLine[] {
	const lines: LogLine[] = [
		line("info", `注入 ${plan.injected.length}/${plan.matched.length} · ${size(plan.budget.used_bytes)} · ${plan.elapsed_ms}ms`),
	];
	for (const match of plan.injected) {
		const stale = match.freshness.is_stale;
		lines.push(line(stale ? "warn" : "note", `${clip(match.title, TITLE_CHARS)}${stale ? "（过期）" : ""}`));
	}
	return lines;
}

const SKIPPED_REASONS = new Set(["extension_source", "slash_command", "empty_input"]);

const INJECTION_REASONS: Record<string, string> = {
	no_pool_members: "还没有记忆",
	no_match: "无匹配",
	all_deduped: "本会话已给过",
	over_budget: "超出预算",
	timeout: "超时",
	store_unavailable: "记忆库不可用",
	store_error: "记忆库出错",
};

export function formatNotInjected(reason: string | null | undefined): LogLine | null {
	if (reason !== null && reason !== undefined && SKIPPED_REASONS.has(reason)) return null;
	const text = (reason !== null && reason !== undefined ? INJECTION_REASONS[reason] : undefined) ?? reason ?? "未知原因";
	const failed = reason === "store_unavailable" || reason === "store_error";
	return line(failed ? "warn" : "info", `未注入 · ${text}`);
}

/* ------------------------------------------------------------------ tools */

type Detail = Record<string, unknown>;

function asDetail(value: unknown): Detail {
	return value !== null && typeof value === "object" ? (value as Detail) : {};
}

function cardsOf(detail: Detail): { title?: unknown }[] {
	return Array.isArray(detail["cards"]) ? (detail["cards"] as { title?: unknown }[]) : [];
}

function freshnessOf(detail: Detail): { is_stale?: boolean } | null {
	const freshness = detail["freshness"];
	return freshness !== null && typeof freshness === "object" ? (freshness as { is_stale?: boolean }) : null;
}

export function formatToolEvent(op: string, payload: Detail, result: unknown): LogLine[] {
	const detail = asDetail(result);
	switch (op) {
		case "memory.read": {
			const label = shortMemory(String(payload["uri"] ?? ""));
			const status = String(detail["status"] ?? "unknown");
			if (status !== "resolved") return [line("warn", `读取 ${label} · ${status}`)];
			const revision = typeof detail["revision"] === "number" ? ` · r${detail["revision"]}` : "";
			const stale = freshnessOf(detail)?.is_stale === true;
			return [line(stale ? "warn" : "info", `读取 ${label}${revision}${stale ? " · 过期" : ""}`)];
		}
		case "memory.search":
			return [line("info", `检索 “${clip(String(payload["query"] ?? ""), QUERY_CHARS)}” → ${cardsOf(detail).length} 条`)];
		case "memory.resolve":
			return [line("info", `解析 “${clip(String(payload["question"] ?? ""), QUERY_CHARS)}” → ${String(detail["status"] ?? "unknown")} · ${cardsOf(detail).length} 条`)];
		case "stale.publish": {
			const events = Array.isArray(detail["events"]) ? (detail["events"] as Detail[]) : [];
			const inserted = typeof detail["inserted"] === "number" ? detail["inserted"] : 0;
			const refused = events.filter((event) => event["recorded"] !== true).length;
			const label = shortMemory(String(payload["uri"] ?? ""));
			const text = inserted > 0 ? `标记过期 ${label} · 已记录` : `标记过期 ${label} · 未记录`;
			return [line(inserted > 0 ? "warn" : "error", refused > 0 ? `${text} · ${refused} 条被拒` : text)];
		}
		case "request.write":
			return [line("info", `保存请求 · ${String(detail["status"] ?? "unknown")}`)];
		default:
			return [];
	}
}

/* --------------------------------------------------------------- daemon */

const OP_LABELS: Record<string, string> = {
	"detector.run": "过期检测",
	"stale.publish": "标记过期",
	"repair.memories": "记忆修复",
	"request.process": "保存处理",
};

export function formatJobEvent(op: string, state: string, result: unknown): LogLine[] {
	const detail = asDetail(result);
	if (state === "failed" || state === "cancelled") {
		return [line("error", `${OP_LABELS[op] ?? op} 失败 · ${state}`)];
	}
	switch (op) {
		case "detector.run": {
			const detected = Number(detail["detected"] ?? 0);
			if (detected === 0) return [];
			return [line("warn", `检测到 ${detected} 处变更 · ${Number(detail["publish_pending"] ?? 0)} 条待标记`)];
		}
		case "stale.publish": {
			const inserted = Number(detail["inserted"] ?? 0);
			return inserted > 0 ? [line("warn", `标记 ${inserted} 条记忆过期 · 待修复`)] : [];
		}
		case "repair.memories": {
			const repaired = Number(detail["repaired"] ?? 0);
			if (repaired === 0) return [];
			return [line("info", `已修复 ${repaired} 条记忆`)];
		}
		case "request.process": {
			const saved = Number(detail["saved"] ?? 0) + Number(detail["merged"] ?? 0);
			return saved > 0 ? [line("info", `保存 ${saved} 条记忆`)] : [];
		}
		default:
			return [];
	}
}

/* ----------------------------------------------------------------- panel */

/**
 * A bounded, self-clearing view of the log lines above. The panel owns no
 * state beyond the lines and the context it last rendered with, so switching
 * branches re-attaches it without replaying anything.
 */
export class ActivityPanel {
	private lines: string[] = [];
	private ctx: ExtensionContext | null = null;
	private enabled: boolean;

	constructor(enabled = false) {
		this.enabled = enabled;
	}

	get active(): boolean {
		return this.enabled;
	}

	get shown(): readonly string[] {
		return this.lines;
	}

	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.render();
	}

	push(ctx: ExtensionContext, entry: LogLine): void {
		this.pushAll(ctx, [entry]);
	}

	pushAll(ctx: ExtensionContext, entries: readonly LogLine[]): void {
		if (!this.enabled || entries.length === 0) return;
		this.ctx = ctx;
		for (const entry of entries) this.lines.push(`${MARKERS[entry.tone]}${entry.text}`);
		if (this.lines.length > ACTIVITY_MAX_LINES) this.lines.splice(0, this.lines.length - ACTIVITY_MAX_LINES);
		this.render();
	}

	clear(ctx?: ExtensionContext): void {
		if (ctx !== undefined) this.ctx = ctx;
		this.lines = [];
		this.render();
	}

	setEnabled(enabled: boolean, ctx?: ExtensionContext): void {
		this.enabled = enabled;
		if (ctx !== undefined) this.ctx = ctx;
		if (!enabled) this.lines = [];
		this.render();
	}

	private render(): void {
		const ctx = this.ctx;
		if (ctx === null || !ctx.hasUI) return;
		const content = this.enabled && this.lines.length > 0 ? [...this.lines] : undefined;
		try {
			ctx.ui.setWidget(ACTIVITY_WIDGET_KEY, content);
		} catch {
			// The panel is a convenience; a host that refuses the widget still runs.
		}
	}
}
