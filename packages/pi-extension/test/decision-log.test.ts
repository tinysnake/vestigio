import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DecisionLog } from "../src/decision-log.js";

describe("DecisionLog", () => {
	it("is a no-op when no path is configured", () => {
		const log = new DecisionLog(null);
		expect(log.enabled).toBe(false);
		log.write({ ts: "t", kind: "input", status: "not_injected" });
	});

	it("appends one JSON line per record", () => {
		const dir = mkdtempSync(join(tmpdir(), "vestigio-log-"));
		try {
			const path = join(dir, "decisions.jsonl");
			const log = new DecisionLog(path);
			log.write({ ts: "t1", kind: "input", status: "not_injected", reason: "no_match" });
			log.write({ ts: "t2", kind: "input", status: "injected", matched: 1, injected: 1, block_bytes: 300 });
			const lines = readFileSync(path, "utf8").trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ reason: "no_match" });
			expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ status: "injected", block_bytes: 300 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never throws on an unwritable path", () => {
		const log = new DecisionLog("/definitely/not/a/real/dir/decisions.jsonl");
		expect(() => log.write({ ts: "t", kind: "input", status: "not_injected" })).not.toThrow();
	});
});
