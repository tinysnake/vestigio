import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const compare = fileURLToPath(new URL("./compare.mjs", import.meta.url));
const cases = [{ case_id: "required", status: "hit", surfaced_ids: ["m1"] }];
const baseline = { dataset_sha256: "dataset", catalog_version: "catalog", cases };

for (const [name, candidate, args, expected] of [
	["same inputs and results pass", baseline, [], 0],
	["a changed dataset cannot pass the gate", { ...baseline, dataset_sha256: "other" }, [], 2],
	["a changed catalog cannot pass the gate", { ...baseline, catalog_version: "other" }, [], 2],
	["an absent fingerprint cannot pass the gate", { ...baseline, dataset_sha256: undefined }, [], 2],
	["a missing case cannot pass the gate", { ...baseline, cases: [] }, [], 2],
	["duplicate cases cannot pass the gate", { ...baseline, cases: [...cases, ...cases] }, [], 2],
	["a result regression fails the gate", { ...baseline, cases: [{ ...cases[0], status: "miss" }] }, [], 1],
	["two empty reports cannot pass the gate", { ...baseline, cases: [] }, [], 2],
	["a case without an id cannot pass the gate", { ...baseline, cases: [{ status: "hit", surfaced_ids: [] }] }, [], 2],
	["a case without a status cannot pass the gate", { ...baseline, cases: [{ case_id: "required", surfaced_ids: [] }] }, [], 2],
	["a new error case fails the gate", { ...baseline, cases: [{ ...cases[0], status: "error" }] }, [], 1],
	["exploratory diffs accept different inputs", { ...baseline, dataset_sha256: "other" }, ["--exploratory"], 0],
]) {
	test(name, () => {
		const dir = mkdtempSync(join(tmpdir(), "vestigio-compare-"));
		try {
			const before = join(dir, "before.json");
			const after = join(dir, "after.json");
			writeFileSync(before, JSON.stringify(baseline));
			writeFileSync(after, JSON.stringify(candidate));
			const result = spawnSync(process.execPath, [compare, ...args, before, after], { encoding: "utf8" });
			assert.equal(result.status, expected, result.stderr + result.stdout);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
