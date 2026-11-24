// Live proof for the rotating observability writer. Writes 200 padded records
// into a directory capped at 64 KiB, prints every surviving segment and the
// total, then proves the total stayed under the cap and the newest record reads
// back. Run from this directory:
//   node --import ./hook.mjs write-rotation.ts
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObsLog } from "../../../src/observability/index.js";
import type { IfaceSnapshotRecord } from "../../../src/observability/index.js";

const MAX_BYTES = 64 * 1024;
const SEGMENT_BYTES = 8 * 1024;
const RECORDS = 200;

type SeqSnapshot = IfaceSnapshotRecord & { readonly seq: number; readonly pad: string };

function snapshot(seq: number): SeqSnapshot {
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
	return { ...base, seq, pad: "x".repeat(256) };
}

const dir = mkdtempSync(join(tmpdir(), "vestigio-obs-live-"));
try {
	const log = createObsLog({ dir, kind: "agent-runs", maxBytes: MAX_BYTES, segmentBytes: SEGMENT_BYTES });
	for (let i = 0; i < RECORDS; i += 1) {
		if (!log.append(snapshot(i))) throw new Error(`append ${i} was rejected`);
	}
	log.close();

	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	let total = 0;
	for (const name of files) {
		const size = statSync(join(dir, name)).size;
		total += size;
		console.log(`${name}\t${size}`);
	}
	console.log(`segments=${files.length} total=${total} cap=${MAX_BYTES}`);

	const newestName = files[files.length - 1];
	if (newestName === undefined) throw new Error("no segments were written");
	const lines = readFileSync(join(dir, newestName), "utf8").trimEnd().split("\n");
	const lastLine = lines[lines.length - 1] ?? "";
	const newest = JSON.parse(lastLine) as SeqSnapshot;
	console.log(`newest ${newestName}: seq=${newest.seq} line_bytes=${Buffer.byteLength(lastLine)}`);

	let remaining = 0;
	for (const name of files) {
		for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
			if (line.trim() === "") continue;
			JSON.parse(line);
			remaining += 1;
		}
	}
	console.log(`remaining_records=${remaining} of ${RECORDS}`);

	if (total > MAX_BYTES) throw new Error(`total ${total} exceeds cap ${MAX_BYTES}`);
	if (newest.seq !== RECORDS - 1) throw new Error(`newest seq ${newest.seq} != ${RECORDS - 1}`);
	if (remaining >= RECORDS) throw new Error("expected the cap to delete older records");
	console.log("PASS: total <= cap and the newest record reads back");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
