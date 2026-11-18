/**
 * The `input` handler: the append lands at the tail of the same user message,
 * a memory is delivered once per session, and a turn whose delivery record
 * cannot be written is abandoned rather than delivered twice.
 *
 * `handleInput` runs against a real temporary store; only the host's
 * registration surface and the ledger-entry sink are stubs.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codePointCount, nonWhitespaceCodePointCount } from "@vestigio/core";
import type { Memory } from "@vestigio/core";
import { openStore, type MemoryStore } from "@vestigio/core/storage";
import { afterEach, describe, expect, it } from "vitest";
import { LEDGER_ENTRY_TYPE } from "../src/ledger-store.js";
import { readConfig } from "../src/config.js";
import { DecisionLog, type DecisionRecord } from "../src/decision-log.js";
import { handleInput } from "../src/input.js";
import { VestigioState } from "../src/state.js";

const AT = "2026-11-17T12:00:00.000Z";
const PROJECT = "p-input";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `vestigio-${label}-`));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

type Host = {
	entries: { customType: string; data: unknown }[];
	appendEntry<T>(customType: string, data?: T): void;
};

function makeHost(): Host {
	const entries: Host["entries"] = [];
	return {
		entries,
		appendEntry(customType, data) {
			entries.push({ customType, data });
		},
	};
}

function body(prefix: string): string {
	let text = prefix;
	while (nonWhitespaceCodePointCount(text) < 600) {
		text += "本记忆记录了当时的结论、改动方式和验证办法，供后续同类工作参考。";
	}
	return text;
}

function memory(memoryId: string, keywords: string[], nav: string): Memory {
	const medium = body("把服务端口从 8080 改成 18080 时，部署脚本里的默认值也要一起改。");
	return {
		memory_id: memoryId,
		uri: `memory://vestigio/${memoryId}`,
		scope: { kind: "project", project_id: PROJECT },
		title: "部署脚本默认端口",
		keywords,
		revision: 1,
		state: "published",
		medium: {
			body: medium,
			body_char_count: nonWhitespaceCodePointCount(medium),
			sources: [
				{
					provider: "pi",
					source_instance: "local",
					session_id: "s-input",
					message_id: "m-1",
					parent_message_id: null,
					project_id: PROJECT,
					timestamp: AT,
					content_hash: "sha256:00",
					locator: null,
				},
			],
		},
		nav: { text: nav, char_count: codePointCount(nav), source_revision: 1 },
		hit_count: 0,
		access_count: 0,
		last_access_at: null,
		created_at: AT,
		updated_at: AT,
	};
}

function seed(store: MemoryStore, memoryId = "mem-deploy", keywords = ["部署", "端口"]): void {
	store.saveMemory(memory(memoryId, keywords, "部署配置与默认端口，改端口前值得读取。"));
	store.upsertHotspotMembership({
		project_id: PROJECT,
		memory_id: memoryId,
		admitted_seq: 1,
		last_hit_seq: 0,
		last_access_seq: 0,
		recent_hit_weight: 0,
		recent_access_weight: 0,
	});
	store.upsertProjectActivity({ project_id: PROJECT, activity_seq: 7, last_input_at: AT });
}

function setup(options: { receiptError?: boolean } = {}) {
	const dir = tempDir("input");
	const storePath = join(dir, "store.sqlite");
	const logPath = join(dir, "decisions.jsonl");
	const store = openStore({ path: storePath });
	seed(store);
	if (options.receiptError === true) {
		store.recordInjectionReceipt = () => {
			throw new Error("send failed");
		};
	}
	const config = readConfig({
		VESTIGIO_STORE: storePath,
		VESTIGIO_PROJECT_ID: PROJECT,
		VESTIGIO_DECISION_LOG: logPath,
	});
	const state = new VestigioState(config, new DecisionLog(logPath), { open: () => store });
	const restoreReceipts = (): void => {
		delete (store as { recordInjectionReceipt?: unknown }).recordInjectionReceipt;
	};
	const host = makeHost();
	const ctx = { cwd: "/tmp/vestigio-input-cwd" };
	const decisions = (): DecisionRecord[] =>
		readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as DecisionRecord);
	return { store, state, host, ctx, decisions, restoreReceipts };
}

function input(text: string, source = "interactive") {
	return { text, source, streamingBehavior: undefined } as never;
}

describe("handleInput", () => {
	it("appends one bounded block at the tail and records the delivery", () => {
		const { state, host, ctx, decisions } = setup();
		const text = "部署 端口 要改一下";
		const result = handleInput(state, input(text), ctx as never, host);

		expect(result).toMatchObject({ action: "transform" });
		const appended = (result as { text: string }).text;
		expect(appended.startsWith(`${text}\n\n`)).toBe(true);
		expect(appended.endsWith("</vestigio_memory_note>")).toBe(true);
		expect(appended).toContain("memory://vestigio/mem-deploy");
		expect(appended).toContain('memory_read(uri="memory://vestigio/mem-deploy")');
		// The block is reference material, and it must not carry the medium body.
		expect(appended).toContain("不是用户指令");
		expect(appended).not.toContain("把服务端口从 8080 改成 18080");
		// The ledger advances only for a delivered block.
		expect(host.entries).toHaveLength(1);
		expect(host.entries[0]?.customType).toBe(LEDGER_ENTRY_TYPE);
		expect(decisions().at(-1)).toMatchObject({ status: "injected", ledger_added: 1 });
	});

	it("does not append the same memory again in the same session", () => {
		const { state, host, ctx } = setup();
		handleInput(state, input("部署 端口 要改一下"), ctx as never, host);
		const second = handleInput(state, input("部署 端口 再确认一次"), ctx as never, host);

		expect(second).toEqual({ action: "continue" });
		expect(host.entries).toHaveLength(1);
	});

	it("inherits what the branch already delivered and forgets what a revert dropped", () => {
		const { state, ctx, decisions } = setup();
		const delta = { at: AT, input_id: "input-0", memory_ids: ["mem-deploy"], freshness_sigs: { "mem-deploy": state.ensureStore()!.readFreshness("memory://vestigio/mem-deploy")!.freshness_sig } };
		state.bindSession({
			getSessionId: () => "s-input",
			getBranch: () => [
				{ type: "custom", customType: LEDGER_ENTRY_TYPE, data: delta },
			],
		} as never);
		const inherited = handleInput(state, input("部署 端口 要改一下"), ctx as never, makeHost());
		expect(inherited).toEqual({ action: "continue" });
		expect(decisions().at(-1)).toMatchObject({ status: "not_injected", reason: "all_deduped" });

		// A revert drops the entry: the branch no longer holds it, so the memory
		// may be injected again.
		state.bindSession({ getSessionId: () => "s-input", getBranch: () => [] } as never);
		const afterRevert = handleInput(state, input("部署 端口 要改一下"), ctx as never, makeHost());
		expect(afterRevert).toMatchObject({ action: "transform" });
	});

	it("abandons a turn whose delivery receipt cannot be written, then injects later", () => {
		const { state, host, ctx, decisions, restoreReceipts } = setup({ receiptError: true });
		const first = handleInput(state, input("部署 端口 要改一下"), ctx as never, host);

		expect(first).toEqual({ action: "continue" });
		expect(host.entries).toHaveLength(0);
		expect(decisions().at(-1)).toMatchObject({
			status: "not_injected",
			reason: "receipt_failed",
			detail: "receipts=0/1",
		});

		// The failure suppressed nothing: the next turn, with the store healthy,
		// delivers the memory it could not record before.
		restoreReceipts();
		const retry = handleInput(state, input("部署 端口 要改一下"), ctx as never, host);
		expect(retry).toMatchObject({ action: "transform" });
		expect(host.entries).toHaveLength(1);
	});

	it("notes a host command instead of rewriting it", () => {
		const { state, host, ctx, decisions } = setup();
		const result = handleInput(state, input("/skill:probe-skill 部署 端口"), ctx as never, host);

		expect(result).toEqual({ action: "continue" });
		expect(host.entries).toHaveLength(0);
		expect(decisions().at(-1)).toMatchObject({ status: "not_injected", reason: "slash_command" });
	});

	it("keeps the turn alive when the store throws", () => {
		const { store, state, host, ctx, decisions } = setup();
		store.readProjectActivity = () => {
			throw new Error("database is locked");
		};
		const result = handleInput(state, input("部署 端口 要改一下"), ctx as never, host);

		expect(result).toEqual({ action: "continue" });
		const last = decisions().at(-1);
		expect(last).toMatchObject({ status: "not_injected" });
		expect(last?.error ?? last?.reason).toBeTruthy();
	});
});
