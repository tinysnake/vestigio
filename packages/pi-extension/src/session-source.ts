/**
 * Canonical pi session entry → `SourceRef`.
 *
 * Both the explicit `memory_mark_stale` tool and the `agent_end` detector must
 * anchor evidence to a real session entry, so this is the one helper they share.
 * `message_id` is the pi session entry id (never a model-generated id),
 * `content_hash` is SHA-256 over the entry's own text, and `locator` points at
 * the session file plus that entry. The bounded excerpt saved next to a stale
 * event comes from the same text, so the evidence is durable even when the
 * history index lags.
 */

import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MemoryUri, SourceRef } from "@vestigio/core";
import { boundStaleExcerpt, parseSourceRef } from "@vestigio/core";

export type EntrySourceContext = {
	session_id: string;
	session_file: string | null;
	project_id: string;
	/** Defaults to `"session"`; the host name is otherwise meaningless here. */
	source_instance?: string;
};

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const record = part as Record<string, unknown>;
		const type = record["type"];
		if (type === "text" && typeof record["text"] === "string") {
			parts.push(record["text"]);
		} else if (type === "toolCall") {
			const name = typeof record["name"] === "string" ? record["name"] : "tool";
			parts.push(`tool_call ${name} ${JSON.stringify(record["arguments"] ?? {})}`);
		}
	}
	return parts.join("\n");
}

/** The entry's own text, or null when the entry carries none. */
export function sessionEntryText(entry: SessionEntry): string | null {
	if (entry.type === "custom_message") {
		const text = textFromContent(entry.content);
		return text.trim().length === 0 ? null : text;
	}
	if (entry.type !== "message") return null;
	const message = entry.message as { role?: string; content?: unknown };
	const text = textFromContent(message.content);
	return text.trim().length === 0 ? null : text;
}

export function contentHashOf(text: string): string {
	return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function entryLocator(sessionFile: string | null, entryId: string): string | null {
	return sessionFile === null ? null : `${sessionFile}#${entryId}`;
}

/**
 * Build a `SourceRef` for one entry, or null when the entry has no text (a
 * label, a model-change marker). The result goes through the core validator, so
 * this helper cannot emit a ref the rest of the system would reject.
 */
export function sourceRefForEntry(entry: SessionEntry, context: EntrySourceContext): SourceRef | null {
	const text = sessionEntryText(entry);
	if (text === null) return null;
	return parseSourceRef({
		provider: "pi",
		source_instance: context.source_instance ?? "session",
		session_id: context.session_id,
		message_id: entry.id,
		parent_message_id: entry.parentId,
		project_id: context.project_id,
		timestamp: entry.timestamp,
		content_hash: contentHashOf(text),
		locator: entryLocator(context.session_file, entry.id),
	});
}

export type EntryEvidence = {
	entry_id: string;
	source_ref: SourceRef;
	excerpt: string;
	excerpt_truncated: boolean;
	kind: "history" | "memory";
};

/**
 * The bounded evidence set for a detector run: the newest `maxEntries` text
 * entries, oldest first, each with its canonical ref and a bounded excerpt.
 */
export function evidenceFromEntries(
	entries: readonly SessionEntry[],
	context: EntrySourceContext,
	maxEntries: number,
): EntryEvidence[] {
	const out: EntryEvidence[] = [];
	for (const entry of entries) {
		const sourceRef = sourceRefForEntry(entry, context);
		if (sourceRef === null) continue;
		const bounded = boundStaleExcerpt(sessionEntryText(entry) ?? "");
		out.push({
			entry_id: entry.id,
			source_ref: sourceRef,
			excerpt: bounded.excerpt,
			excerpt_truncated: bounded.truncated,
			kind: "history",
		});
	}
	return out.slice(-maxEntries);
}

export function memoryUriOf(storeId: string, memoryId: string): MemoryUri {
	return `memory://${storeId}/${memoryId}` as MemoryUri;
}
