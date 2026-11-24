/**
 * Rotating JSONL observability writer (OBS-01).
 *
 * One `createObsLog` instance owns a directory: the default stream is
 * `<dir>/<kind>.jsonl`, `openRun(name)` adds an independent named stream, and
 * the cap is measured over the segments this instance owns. Segments are cut at
 * `segmentBytes` (`<kind>.<n>.jsonl` for n >= 1); once its own total exceeds
 * `maxBytes` the oldest of its segments are deleted until it is back under.
 *
 * Failure policy mirrors `packages/pi-extension/src/decision-log.ts`: failures
 * are counted, and after more than five the writer degrades to a no-op and
 * reports that once on stderr. Appends are append-only, so two writers in one
 * directory interleave without truncating each other, and the writer never
 * throws into a caller. A malformed record is rejected before any I/O and is
 * not counted as a write failure.
 *
 * Retention is per writer: the cap is the sum of the segments this instance
 * opened, so the directory is bounded by writers times `maxBytes`. A second
 * process in the same directory is invisible here, so this one can never delete
 * the segment that process is appending to, and a stalled writer's leftovers
 * cannot make a live one delete its own segments to stay under a shared total.
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ObsRecord } from "./records.js";
import { validateObsRecord } from "./validate.js";

export const DEFAULT_OBS_MAX_BYTES = 128 * 1024 * 1024;
export const DEFAULT_OBS_SEGMENT_BYTES = 32 * 1024 * 1024;

const SEGMENT_EXTENSION = ".jsonl";
const MAX_WRITE_FAILURES = 5;

export type ObsLogOptions = {
	/** Directory the logs live in. Created if missing; a failure just degrades appends. */
	readonly dir: string;
	/** Base file name (without extension) of the default stream. */
	readonly kind: string;
	/** Directory-wide byte cap. Oldest segments are deleted above it. Default 128 MiB. */
	readonly maxBytes?: number;
	/** Cut a new segment once the current one reaches this many bytes. Default 32 MiB. */
	readonly segmentBytes?: number;
};

export type ObsStream = {
	/** Validates and appends one record. False when rejected, degraded or closed. Never throws. */
	append(record: ObsRecord): boolean;
	/** Enforce the cap and stop accepting records on this stream. */
	close(): void;
};

export type ObsLog = ObsStream & {
	/** Open an independent stream under `<dir>/<name>.jsonl`. */
	openRun(name: string): ObsStream;
};

type Segment = {
	readonly base: string;
	readonly key: string;
	index: number;
	bytes: number;
	path: string;
};

type LogFile = {
	readonly path: string;
	readonly size: number;
	readonly mtimeMs: number;
};

function segmentPath(base: string, index: number): string {
	return index === 0 ? `${base}${SEGMENT_EXTENSION}` : `${base}.${index}${SEGMENT_EXTENSION}`;
}

function parseSegmentIndex(name: string, baseName: string): number | null {
	if (name === `${baseName}${SEGMENT_EXTENSION}`) return 0;
	if (!name.startsWith(`${baseName}.`) || !name.endsWith(SEGMENT_EXTENSION)) return null;
	const middle = name.slice(baseName.length + 1, -SEGMENT_EXTENSION.length);
	return /^[1-9][0-9]*$/.test(middle) ? Number(middle) : null;
}

function pathOrder(path: string): number {
	const match = /\.([0-9]+)\.jsonl$/.exec(path);
	return match === null ? 0 : Number(match[1]);
}

function compareOldest(a: LogFile, b: LogFile): number {
	return a.mtimeMs - b.mtimeMs || pathOrder(a.path) - pathOrder(b.path) || a.path.localeCompare(b.path);
}

function statSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function listLogFiles(root: string): LogFile[] {
	const found: LogFile[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				pending.push(path);
			} else if (entry.isFile() && entry.name.endsWith(SEGMENT_EXTENSION)) {
				try {
					const stats = statSync(path);
					found.push({ path, size: stats.size, mtimeMs: stats.mtimeMs });
				} catch {
					// A segment that vanished between readdir and stat is simply not counted.
				}
			}
		}
	}
	return found;
}

class ObsLogWriter implements ObsLog {
	private readonly dir: string;
	private readonly kind: string;
	private readonly maxBytes: number;
	private readonly segmentBytes: number;
	private readonly streams = new Map<string, Segment>();
	/** Base paths (`<dir>/<name>`) this instance has opened a stream for. */
	private readonly ownedBases = new Set<string>();
	private failures = 0;
	private disabled = false;
	private closed = false;

	constructor(options: ObsLogOptions) {
		this.dir = options.dir;
		this.kind = options.kind;
		this.maxBytes = options.maxBytes ?? DEFAULT_OBS_MAX_BYTES;
		this.segmentBytes = options.segmentBytes ?? DEFAULT_OBS_SEGMENT_BYTES;
		this.ensureDir(this.dir);
	}

	append(record: ObsRecord): boolean {
		if (this.disabled || this.closed) return false;
		return this.appendTo(this.stream(this.kind), record);
	}

	openRun(name: string): ObsStream {
		return {
			append: (record) => {
				if (this.disabled || this.closed) return false;
				return this.appendTo(this.stream(name), record);
			},
			close: () => this.closeStream(name),
		};
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const segment of this.streams.values()) this.enforceCap(segment.path);
	}

	private appendTo(segment: Segment, record: ObsRecord): boolean {
		let line: string;
		try {
			const parsed = validateObsRecord(record);
			if (!parsed.ok) return false;
			line = `${JSON.stringify(parsed.record)}\n`;
		} catch {
			return false;
		}
		const size = Buffer.byteLength(line);
		try {
			if (segment.bytes > 0 && segment.bytes + size > this.segmentBytes) {
				segment.index += 1;
				segment.bytes = 0;
				segment.path = segmentPath(segment.base, segment.index);
				this.ensureDir(dirname(segment.path));
			}
			appendFileSync(segment.path, line);
			segment.bytes += size;
			if (segment.bytes >= this.segmentBytes) this.enforceCap(segment.path);
			return true;
		} catch {
			this.noteFailure();
			return false;
		}
	}

	private stream(name: string): Segment {
		const existing = this.streams.get(name);
		if (existing !== undefined) return existing;
		const base = join(this.dir, name);
		this.ownedBases.add(base);
		this.ensureDir(dirname(base));
		const index = this.nextSegmentIndex(base);
		const segment: Segment = {
			base,
			key: name,
			index,
			bytes: statSize(segmentPath(base, index)),
			path: segmentPath(base, index),
		};
		this.streams.set(name, segment);
		return segment;
	}

	private closeStream(name: string): void {
		const segment = this.streams.get(name);
		if (segment === undefined) return;
		this.enforceCap(segment.path);
		this.streams.delete(name);
	}

	private nextSegmentIndex(base: string): number {
		const baseName = base.slice(this.dir.length + 1);
		let highest = -1;
		let entries;
		try {
			entries = readdirSync(this.dir, { withFileTypes: true });
		} catch {
			return 0;
		}
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const index = parseSegmentIndex(entry.name, baseName);
			if (index !== null && index > highest) highest = index;
		}
		if (highest < 0) return 0;
		return statSize(segmentPath(base, highest)) < this.segmentBytes ? highest : highest + 1;
	}

	/**
	 * Delete whole oldest owned segments until this instance's own total is at or
	 * under the cap. The cap covers only segments this instance opened, so a
	 * concurrent writer in the same directory is not a candidate and the segment
	 * just written is never removed. Re-running converges: the scan is rebuilt
	 * from disk and an already-deleted file is a no-op.
	 */
	private enforceCap(protectedPath: string): void {
		const owned = listLogFiles(this.dir).filter((file) => this.owns(file.path));
		let total = 0;
		for (const file of owned) total += file.size;
		if (total <= this.maxBytes) return;
		const candidates = owned.filter((file) => file.path !== protectedPath).sort(compareOldest);
		for (const file of candidates) {
			if (total <= this.maxBytes) break;
			try {
				unlinkSync(file.path);
				total -= file.size;
			} catch {
				// Idempotent: a segment another actor already removed is simply skipped.
			}
		}
	}

	/** True when `filePath` is a segment of one of this instance's own streams. */
	private owns(filePath: string): boolean {
		const relative = filePath.slice(this.dir.length + 1);
		for (const base of this.ownedBases) {
			if (parseSegmentIndex(relative, base.slice(this.dir.length + 1)) !== null) return true;
		}
		return false;
	}

	private noteFailure(): void {
		this.failures += 1;
		if (this.failures > MAX_WRITE_FAILURES && !this.disabled) {
			this.disabled = true;
			try {
				console.error("vestigio: observability log disabled after repeated write failures");
			} catch {
				// Reporting a degraded writer must never surface either.
			}
		}
	}

	private ensureDir(path: string): void {
		try {
			mkdirSync(path, { recursive: true });
		} catch {
			// The append that follows reports the failure; construction must not throw.
		}
	}
}

export function createObsLog(options: ObsLogOptions): ObsLog {
	return new ObsLogWriter(options);
}
