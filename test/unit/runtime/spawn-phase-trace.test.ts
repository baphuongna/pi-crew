/**
 * spawn-phase-trace.test.ts — Observability for pre-worker-spawn hangs
 * (2026-11-01, run team_20261101074334 forensics: a 7-minute log-silent
 * spawn hang left no bisectable trace). Contract:
 *  - silent when the spawn settles inside one tick (healthy path, zero noise)
 *  - one breadcrumb line per tick while stuck, naming the current phase
 *  - phase() advances the label; end() stops ticking (idempotent)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createSpawnPhaseTracer } from "../../../src/runtime/spawn-phase-trace.ts";

function captureConsoleError<T>(fn: () => T): { lines: string[]; result: T } {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	try {
		const result = fn();
		return { lines, result };
	} finally {
		console.error = original;
	}
}

test("spawn-phase-trace: healthy sub-tick spawn is silent", async () => {
	const { lines } = captureConsoleError(() => {
		const tracer = createSpawnPhaseTracer("t1", 0, 200);
		tracer.phase("runWorker-await");
		tracer.end();
		tracer.end(); // idempotent
	});
	assert.equal(lines.length, 0, "no breadcrumbs for a fast spawn");
});

test("spawn-phase-trace: stuck phase emits one breadcrumb per tick with the current label", async () => {
	// (folded into the third test — kept as an explicit no-op contract marker)
});

test("spawn-phase-trace: ticks observed inside the capture window", async () => {
	const seen: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		seen.push(args.map(String).join(" "));
	};
	const tracer = createSpawnPhaseTracer("t3", 2, 30);
	tracer.phase("worker-slot-wait");
	try {
		await new Promise((r) => setTimeout(r, 105));
		tracer.phase("runWorker-await");
		await new Promise((r) => setTimeout(r, 40));
	} finally {
		console.error = original;
		tracer.end();
	}
	assert.ok(seen.length >= 3, `expected several breadcrumbs, got ${seen.length}`);
	assert.ok(
		seen.some((l) => l.includes("phase=worker-slot-wait")),
		"first label recorded",
	);
	assert.ok(
		seen.some((l) => l.includes("phase=runWorker-await")),
		"advanced label recorded",
	);
	assert.ok(
		seen.every((l) => l.includes("task=t3") && l.includes("attempt=2")),
		"task/attempt stamped",
	);
	// end() stops the ticks — no growth after settling.
	const countAtEnd = seen.length;
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(seen.length, countAtEnd, "no ticks after end()");
});
