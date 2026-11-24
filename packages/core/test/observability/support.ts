/**
 * Shared helpers for the observability writer tests (OBS-01).
 *
 * The tests need the same four things over and over: a throwaway directory, a
 * compact valid record to append, a recursive listing of the segments on disk
 * and the ability to read every appended line back. Keeping them here means the
 * writer and perf tests exercise the same shapes.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IfaceSnapshotRecord } from "../../src/observability/index.js";

export type SeqSnapshot = IfaceSnapshotRecord & { readonly seq: number; readonly pad: string };

/** A minimal valid `iface_snapshot` carrying a `seq` (for ordering) and padding (for size). */
export function snapshot(seq: number, padding = 0): SeqSnapshot {
	const base: IfaceSnapshotRecord = {
		type: "iface_snapshot",
		v: 1,
		at: "2026-11-24T10:00:00.000Z",
		since: "2026-11-24T09:59:00.000Z",
		window_ms: 60_000,
		scope: "daemon",
		routes: { "GET /v1/health": { "2xx": 1, "4xx": 0, "5xx": 0, total: 1 } },
		reasons: { resolver: 1 },
	};
	return { ...base, seq, pad: "x".repeat(padding) };
}

export function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "vestigio-obs-test-"));
}

export function removeTempDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

/** Every `.jsonl` file under `dir`, recursively, in numeric-aware name order. */
export function segmentPaths(dir: string): string[] {
	return walk(dir)
		.filter((path) => path.endsWith(".jsonl"))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** `0` for `<base>.jsonl`, otherwise the `<n>` of `<base>.<n>.jsonl`. */
export function segmentIndex(path: string): number {
	const match = /\.([0-9]+)\.jsonl$/.exec(path);
	return match === null ? 0 : Number(match[1]);
}

export function totalBytes(dir: string): number {
	let total = 0;
	for (const path of segmentPaths(dir)) total += statSync(path).size;
	return total;
}

/** Every record written under `dir`, in segment then file order. */
export function readRecords(dir: string): Array<Record<string, unknown>> {
	const records: Array<Record<string, unknown>> = [];
	for (const path of segmentPaths(dir)) {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (line.trim() === "") continue;
			records.push(JSON.parse(line) as Record<string, unknown>);
		}
	}
	return records;
}

function walk(root: string): string[] {
	const found: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile()) found.push(path);
		}
	}
	return found;
}
