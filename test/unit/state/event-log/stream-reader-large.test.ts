import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * US-011 verify-close (2026-09-22) — AC-3 guard.
 *
 * The streaming READ half shipped as ST-11 (forEachLineSync, 8 KB bounded
 * chunks). The audit found no whole-file reader left on any hot path
 * (render/tick/status) but noted the spec's AC-3 was unmet: nothing proved the
 * large-log path stays bounded. This test pins that contract so a regression
 * back to readFileSync-the-whole-log is caught.
 *
 * Memory is measured in a CHILD process with --expose-gc so the number is
 * deterministic (in-process heap deltas are GC-timing dependent and the mutant
 * survived a naive in-process ceiling). Measured 2026-09-22 on an 11 MB /
 * 50k-event fixture: streaming ≈ 0.7 MB heap delta, whole-file read ≈ 22.5 MB.
 * The 8 MB ceiling sits cleanly between the two.
 */

const CHILD_SRC = `
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { compactEventLog } = await import(process.argv[2]);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "us011-child-"));
const p = path.join(cwd, "events.jsonl");
const fd = fs.openSync(p, "w");
let chunk = "";
for (let i = 0; i < 50000; i += 1) {
	chunk += JSON.stringify({
		time: new Date(1700000000000 + i * 1000).toISOString(),
		type: "task.progress",
		runId: "team_us011_big",
		taskId: "t" + (i % 8),
		message: "event " + i + " " + "x".repeat(120),
	}) + "\\n";
	if (chunk.length > 512 * 1024) { fs.writeSync(fd, chunk); chunk = ""; }
}
if (chunk) fs.writeSync(fd, chunk);
fs.closeSync(fd);
global.gc();
const before = process.memoryUsage().heapUsed;
const result = compactEventLog(p, { maxFileSizeBytes: 1024, compactToCount: 100 });
const delta = process.memoryUsage().heapUsed - before;
fs.rmSync(cwd, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ delta, ok: Boolean(result), size: 0 }));
`;

test("US-011: a 50k-event (11 MB) log compacts with a bounded heap footprint", () => {
	const moduleUrl = new URL("../../../../src/state/event-log/event-log-rotation.ts", import.meta.url).href;
	const tmpScript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "us011-src-")), "child.mjs");
	fs.writeFileSync(tmpScript, CHILD_SRC);
	try {
		const out = execFileSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "--no-warnings", tmpScript, moduleUrl], {
			encoding: "utf-8",
			timeout: 120_000,
		});
		const { delta, ok } = JSON.parse(out) as { delta: number; ok: boolean };
		assert.equal(ok, true, "compaction must produce a result for an over-threshold log");
		const deltaMb = delta / 1024 / 1024;
		assert.ok(
			deltaMb < 8,
			`heap grew ${deltaMb.toFixed(1)}MB during compaction of an 11MB log — the streaming reader must stay bounded (whole-file read measured ~22MB)`,
		);
	} finally {
		fs.rmSync(path.dirname(tmpScript), { recursive: true, force: true });
	}
});
