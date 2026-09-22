import assert from "node:assert/strict";
import test from "node:test";
import { __setSpinnerClockSource, spinnerBucket, spinnerClockNow, spinnerFrame } from "../../../src/ui/spinner.ts";
import { formatCompactToolProgress } from "../../../src/ui/tool-progress-formatter.ts";

/**
 * Deterministic-capture clock (2026-09-22): spinner phase and the elapsed-time
 * fallbacks (tool-progress formatter, record durations) read one swappable
 * clock source so docs/ui-samples/capture.ts produces byte-stable captures.
 * Production default is Date.now() — nothing changes unless the hook is used.
 */

test("pinned clock source freezes spinner frames, buckets, and spinnerClockNow", async () => {
	const pinned = new Date("2026-09-15T09:00:00.000Z").getTime();
	const restore = __setSpinnerClockSource(() => pinned);
	try {
		const f1 = spinnerFrame("widget-header");
		const b1 = spinnerBucket();
		const n1 = spinnerClockNow();
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(spinnerFrame("widget-header"), f1, "frame must not advance under a pinned clock");
		assert.equal(spinnerBucket(), b1, "bucket must not advance under a pinned clock");
		assert.equal(spinnerClockNow(), pinned);
		assert.equal(n1, pinned);
	} finally {
		__setSpinnerClockSource(restore);
	}
});

test("restoring the clock source returns to real time", () => {
	const pinned = new Date("2026-09-15T09:00:00.000Z").getTime();
	const restore = __setSpinnerClockSource(() => pinned);
	__setSpinnerClockSource(restore);
	assert.ok(Math.abs(spinnerClockNow() - Date.now()) < 50, "restored clock must track Date.now()");
});

test("tool-progress elapsed is deterministic under the pinned clock", async () => {
	const pinned = new Date("2026-09-15T09:00:00.000Z").getTime();
	const restore = __setSpinnerClockSource(() => pinned);
	try {
		const input = {
			agentId: "team_demo",
			status: "running",
			runId: "team_demo",
			startedAt: pinned - 372_000,
			manifest: undefined,
			tasks: [],
			agents: [],
		};
		const a = formatCompactToolProgress(input as never);
		await new Promise((r) => setTimeout(r, 200));
		const b = formatCompactToolProgress(input as never);
		assert.equal(a, b, "elapsed=…s output must be byte-stable under a pinned clock");
		assert.ok(a.includes("elapsed=372s"), `expected 372s elapsed, got: ${a.split("\n")[0]}`);
	} finally {
		__setSpinnerClockSource(restore);
	}
});
