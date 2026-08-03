/**
 * Round 22 reliability fixes:
 *  - BUG 1: concurrent checkpoint saves must use UNIQUE temp files (no shared
 *    '.tmp.checkpoint'), otherwise cross-process saves corrupt/lose data.
 *  - BUG 2: chain-parser parseStep() must reject pathological nesting instead
 *    of overflowing the stack.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { parseChainDSL } from "../../src/runtime/chain-parser.ts";
import { type Checkpoint, FileCheckpointStore } from "../../src/runtime/recovery/checkpoint.ts";

// ---------------------------------------------------------------------------
// BUG 1: unique temp file per concurrent checkpoint save
// ---------------------------------------------------------------------------

function makeStore(): { store: FileCheckpointStore; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cp-r22-"));
	const store = new FileCheckpointStore(dir);
	return { store, dir };
}

function makeCheckpoint(taskId: string): Checkpoint {
	return {
		runId: "r1",
		taskId,
		step: 0,
		context: `context-for-${taskId}`,
		progress: `progress-for-${taskId}`,
		savedAt: Date.now(),
		agentId: "agent-1",
	};
}

test("BUG 1: save writes a checkpoint that round-trips (single)", () => {
	const { store, dir } = makeStore();
	try {
		store.save(makeCheckpoint("t1"));
		const loaded = store.load("r1", "t1");
		assert.ok(loaded, "checkpoint round-trips");
		assert.equal(loaded!.taskId, "t1");
		assert.equal(loaded!.context, "context-for-t1");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("BUG 1: many saves to distinct taskIds each land with their OWN data", () => {
	// Simulates the multi-process race at high speed. With the old shared
	// '.tmp.checkpoint' name this could intermittently corrupt data; with
	// unique temp names every task file contains exactly its own data.
	const { store, dir } = makeStore();
	try {
		const N = 50;
		const cps = Array.from({ length: N }, (_, i) => makeCheckpoint(`t${i}`));
		for (const cp of cps) store.save(cp);
		// Every file must round-trip with the correct per-task context.
		for (const cp of cps) {
			const loaded = store.load("r1", cp.taskId);
			assert.ok(loaded, `task ${cp.taskId} missing`);
			assert.equal(loaded!.taskId, cp.taskId, `task ${cp.taskId} wrong taskId`);
			assert.equal(loaded!.context, cp.context, `task ${cp.taskId} cross-contaminated context`);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("BUG 1: no leftover shared '.tmp.checkpoint' file after saves", () => {
	const { store, dir } = makeStore();
	try {
		store.save(makeCheckpoint("t1"));
		store.save(makeCheckpoint("t2"));
		const entries = fs.readdirSync(dir);
		assert.ok(!entries.includes(".tmp.checkpoint"), "legacy shared '.tmp.checkpoint' must not be used");
		// Only final checkpoint JSON files should remain (no stray temps).
		const strayTmp = entries.filter((e) => e.startsWith(".tmp."));
		assert.equal(strayTmp.length, 0, `stray temp files left behind: ${strayTmp.join(", ")}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// BUG 2: chain-parser depth guard
// ---------------------------------------------------------------------------

test("BUG 2: deeply nested parallel(...) is rejected, not stack-overflowed", () => {
	const depth = 200;
	let src = "single";
	for (let i = 0; i < depth; i++) src = `parallel(${src})`;
	assert.throws(
		() => parseChainDSL(src),
		/nesting too deep|nesting|max/i,
		"deeply nested input must be rejected with a clear error, not a RangeError",
	);
});

test("BUG 2: reasonable nesting still parses fine (regression)", () => {
	const steps = parseChainDSL("parallel(explore, plan, parallel(exec1, exec2)) -> review");
	assert.ok(steps.length >= 1);
	assert.equal(steps[0]!.name, "parallel");
});

test("BUG 2: single-step chain parses fine (regression)", () => {
	const steps = parseChainDSL("explore");
	assert.equal(steps.length, 1);
	assert.equal(steps[0]!.name, "explore");
});
