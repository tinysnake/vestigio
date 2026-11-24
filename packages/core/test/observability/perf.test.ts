import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DecisionLog } from "../../../pi-extension/src/decision-log.js";
import { createObsLog } from "../../src/observability/index.js";
import { snapshot } from "./support.js";

const APPENDS = 1000;
const WARMUP = 200;
const ROUNDS = 3;

function medianAppendNs(count: number, append: (i: number) => void): number {
	for (let i = 0; i < WARMUP; i += 1) append(i);
	const samples: number[] = [];
	for (let i = 0; i < count; i += 1) {
		const start = process.hrtime.bigint();
		append(WARMUP + i);
		samples.push(Number(process.hrtime.bigint() - start));
	}
	samples.sort((a, b) => a - b);
	return samples[Math.floor(samples.length / 2)] ?? 0;
}

/** Best of ROUNDS medians: the minimum removes scheduler noise without hiding a slow hot path. */
function bestMedian(measure: () => number): number {
	let best = Number.POSITIVE_INFINITY;
	for (let round = 0; round < ROUNDS; round += 1) best = Math.min(best, measure());
	return best;
}

function measureDecisionLog(): number {
	const dir = mkdtempSync(join(tmpdir(), "vestigio-obs-perf-base-"));
	try {
		const log = new DecisionLog(join(dir, "decision.jsonl"));
		return medianAppendNs(APPENDS, () => {
			log.write({ ts: "2026-11-24T10:00:00.000Z", kind: "input", status: "ok", elapsed_ms: 1 });
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function measureObservability(): number {
	const dir = mkdtempSync(join(tmpdir(), "vestigio-obs-perf-new-"));
	try {
		const log = createObsLog({ dir, kind: "perf", maxBytes: 512 * 1024 * 1024, segmentBytes: 512 * 1024 * 1024 });
		const median = medianAppendNs(APPENDS, (i) => {
			log.append(snapshot(i, 128));
		});
		log.close();
		return median;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("append cost against the decision log", () => {
	it("keeps the median append within 2x of decision-log.ts", () => {
		const baseline = bestMedian(measureDecisionLog);
		const candidate = bestMedian(measureObservability);
		const ratio = candidate / baseline;
		console.log(
			`median append ns: observability=${candidate} decision-log=${baseline} ratio=${ratio.toFixed(2)} (bar 2.00)`,
		);
		expect(candidate).toBeLessThanOrEqual(2 * baseline);
	}, 120_000);
});
