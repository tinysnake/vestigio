import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createObsLog } from "../../src/observability/index.js";
import type { ObsRecord } from "../../src/observability/index.js";
import { makeTempDir, readRecords, removeTempDir, segmentIndex, segmentPaths, snapshot, totalBytes } from "./support.js";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = makeTempDir();
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) removeTempDir(dir);
	}
});

describe("createObsLog retention", () => {
	it("deletes the oldest segments once the directory exceeds the cap", () => {
		const dir = tempDir();
		const log = createObsLog({ dir, kind: "iface", maxBytes: 4096, segmentBytes: 1024 });
		for (let i = 0; i < 200; i += 1) log.append(snapshot(i, 64));
		log.close();

		const files = segmentPaths(dir);
		expect(files.length).toBeGreaterThan(1);
		expect(totalBytes(dir)).toBeLessThanOrEqual(4096);

		const seqs = readRecords(dir)
			.map((record) => record["seq"] as number)
			.sort((a, b) => a - b);
		expect(seqs.length).toBeGreaterThan(0);
		expect(seqs.length).toBeLessThan(200);
		expect(seqs[0]).toBeGreaterThan(0);
	});

	it("keeps the remaining records and segment indices contiguous", () => {
		const dir = tempDir();
		const log = createObsLog({ dir, kind: "iface", maxBytes: 4096, segmentBytes: 1024 });
		for (let i = 0; i < 200; i += 1) log.append(snapshot(i, 64));
		log.close();

		const seqs = readRecords(dir)
			.map((record) => record["seq"] as number)
			.sort((a, b) => a - b);
		for (let i = 1; i < seqs.length; i += 1) {
			expect(seqs[i]).toBe((seqs[i - 1] ?? -1) + 1);
		}

		const indices = segmentPaths(dir).map((path) => segmentIndex(path));
		for (let i = 1; i < indices.length; i += 1) {
			expect(indices[i]).toBe((indices[i - 1] ?? -1) + 1);
		}
	});

	it("re-running deletion converges and close is idempotent", () => {
		const dir = tempDir();
		const log = createObsLog({ dir, kind: "iface", maxBytes: 4096, segmentBytes: 1024 });
		for (let i = 0; i < 200; i += 1) log.append(snapshot(i, 64));
		log.close();
		const after = totalBytes(dir);
		expect(() => log.close()).not.toThrow();
		expect(totalBytes(dir)).toBe(after);
	});
});

describe("createObsLog concurrency", () => {
	it("two writer instances in one directory do not truncate each other", () => {
		const dir = tempDir();
		const first = createObsLog({ dir, kind: "agent-runs", maxBytes: 1 << 20, segmentBytes: 1 << 20 });
		const second = createObsLog({ dir, kind: "agent-runs", maxBytes: 1 << 20, segmentBytes: 1 << 20 });
		for (let i = 0; i < 100; i += 1) {
			first.append(snapshot(i, 32));
			second.append(snapshot(1000 + i, 32));
		}
		first.close();
		second.close();

		const seqs = readRecords(dir).map((record) => record["seq"] as number);
		expect(seqs.length).toBe(200);
		expect(new Set(seqs).size).toBe(200);
	});
});

describe("createObsLog validation", () => {
	it("rejects a malformed record and writes nothing", () => {
		const dir = tempDir();
		const log = createObsLog({ dir, kind: "iface" });
		expect(log.append({ type: "agent_run", v: 1 } as unknown as ObsRecord)).toBe(false);
		expect(log.append({ type: "nope", v: 1 } as unknown as ObsRecord)).toBe(false);
		expect(log.append({ ...snapshot(0, 0), v: 2 } as unknown as ObsRecord)).toBe(false);
		expect(log.append(snapshot(1, 0))).toBe(true);
		log.close();

		const files = segmentPaths(dir);
		expect(files.length).toBe(1);
		const lines = readFileSync(files[0] ?? "", "utf8").trimEnd().split("\n");
		expect(lines.length).toBe(1);
		expect((JSON.parse(lines[0] ?? "{}") as { seq: number }).seq).toBe(1);
	});
});

describe("createObsLog failure policy", () => {
	it("does not throw on an unwritable directory and degrades with one console.error", () => {
		const parent = tempDir();
		const blocker = join(parent, "blocker");
		writeFileSync(blocker, "not a directory");
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		const log = createObsLog({ dir: join(blocker, "obs"), kind: "iface" });
		for (let i = 0; i < 8; i += 1) {
			let appended = true;
			expect(() => {
				appended = log.append(snapshot(i, 0));
			}).not.toThrow();
			expect(appended).toBe(false);
		}
		expect(errors).toHaveBeenCalledTimes(1);
		expect(() => log.close()).not.toThrow();
	});
});
