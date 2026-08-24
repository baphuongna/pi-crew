/**
 * Task 26 (2026-08-24): batched sidechain/transcript JSONL writer coverage.
 *
 * writeSidechainEntry / appendBatchedJsonlLine queue per path and flush ONE
 * appendFileSync per 50ms window (previously: one mkdirSync + appendFileSync +
 * full redaction clone PER streaming event). flushPendingSidechainWrites
 * drains pending batches synchronously at session teardown / process exit.
 *
 * The fs spy uses the CJS-default-swap + syncBuiltinESMExports technique
 * (same as test/unit/manifest-cache-ttl.test.ts): `node:fs` ESM namespace
 * properties are read-only, but the CommonJS exports object behind the
 * builtin is mutable and syncBuiltinESMExports() pushes the patched function
 * into every ESM namespace that imported node:fs (verified on this
 * toolchain, Node v22). A liveness guard makes a dead spy fail loudly
 * instead of passing vacuously.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	appendBatchedJsonlLine,
	flushPendingSidechainWrites,
	writeSidechainEntry,
} from "../../../../src/runtime/output/sidechain-output.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface AppendSpy {
	appendCallsFor(file: string): string[];
	restore(): void;
}

function spyAppendFileSync(): AppendSpy {
	const nodeRequire = createRequire(import.meta.url);
	const fsDefault = nodeRequire("node:fs") as {
		appendFileSync: (...args: unknown[]) => void;
	};
	const nodeModule = nodeRequire("node:module") as { syncBuiltinESMExports(): void };
	const originalAppend = fsDefault.appendFileSync;
	const callsByFile = new Map<string, string[]>();
	fsDefault.appendFileSync = (...args: unknown[]) => {
		const target = String(args[0]);
		const data = typeof args[1] === "string" ? args[1] : String(args[1]);
		const calls = callsByFile.get(target) ?? [];
		calls.push(data);
		callsByFile.set(target, calls);
		originalAppend(...args);
	};
	nodeModule.syncBuiltinESMExports();
	return {
		appendCallsFor(file: string) {
			return callsByFile.get(file) ?? [];
		},
		restore() {
			fsDefault.appendFileSync = originalAppend;
			nodeModule.syncBuiltinESMExports();
		},
	};
}

test("spy instrumentation is live — a dead spy fails loudly, not vacuously", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-batched-live-"));
	const spy = spyAppendFileSync();
	try {
		const file = path.join(dir, "liveness.jsonl");
		appendBatchedJsonlLine(file, '{"liveness":true}\n');
		flushPendingSidechainWrites();
		assert.equal(
			spy.appendCallsFor(file).length,
			1,
			"spy must observe the appendFileSync — if this fails, syncBuiltinESMExports stopped propagating CJS patches and every other count assertion below is vacuous",
		);
	} finally {
		spy.restore();
		flushPendingSidechainWrites();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("100 writeSidechainEntry calls within one window flush as ONE appendFileSync with all 100 lines in order", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-batched-100-"));
	const spy = spyAppendFileSync();
	try {
		const file = path.join(dir, "sidechain.output.jsonl");
		for (let i = 0; i < 100; i++) {
			writeSidechainEntry(file, {
				agentId: `a${i}`,
				type: "message",
				message: i,
				cwd: dir,
			});
		}
		// The queue loop and this assertion run synchronously — the 50ms timer
		// cannot have fired in between, so nothing may be written yet.
		assert.equal(spy.appendCallsFor(file).length, 0, "nothing is written before the 50ms window closes");

		await sleep(250); // well past the 50ms flush window, tolerant of slow CI

		const calls = spy.appendCallsFor(file);
		assert.equal(calls.length, 1, `expected exactly ONE appendFileSync for the batch (got ${calls.length})`);
		const lines = calls[0].split("\n").filter(Boolean);
		assert.equal(lines.length, 100, "the single write must contain all 100 lines");
		const parsed = lines.map((line) => JSON.parse(line) as { agentId: string; isSidechain: boolean; timestamp: string });
		for (let i = 0; i < 100; i++) {
			assert.equal(parsed[i].agentId, `a${i}`, `line ${i} must preserve queue order`);
			assert.equal(parsed[i].isSidechain, true);
			assert.ok(parsed[i].timestamp);
		}
		assert.equal(fs.readFileSync(file, "utf-8"), calls[0], "on-disk content matches the single batched write");
	} finally {
		spy.restore();
		flushPendingSidechainWrites();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("flush-on-dispose drains pending lines synchronously and is idempotent", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-batched-drain-"));
	const spy = spyAppendFileSync();
	try {
		const file = path.join(dir, "drain.jsonl");
		for (let i = 0; i < 7; i++) appendBatchedJsonlLine(file, `{"i":${i}}\n`);
		assert.equal(spy.appendCallsFor(file).length, 0, "queued lines are not written before the flush");

		flushPendingSidechainWrites();

		assert.equal(spy.appendCallsFor(file).length, 1, "flush drains the pending batch in one appendFileSync");
		const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
		assert.equal(lines.length, 7);
		assert.deepEqual(
			lines.map((line) => (JSON.parse(line) as { i: number }).i),
			[0, 1, 2, 3, 4, 5, 6],
			"drained lines preserve queue order",
		);

		flushPendingSidechainWrites();
		assert.equal(spy.appendCallsFor(file).length, 1, "a second flush with an empty queue writes nothing");
	} finally {
		spy.restore();
		flushPendingSidechainWrites();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("separate paths batch independently — one appendFileSync each", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-batched-paths-"));
	const spy = spyAppendFileSync();
	try {
		const fileA = path.join(dir, "a.jsonl");
		const fileB = path.join(dir, "b.jsonl");
		writeSidechainEntry(fileA, { agentId: "a", type: "message", message: 1, cwd: dir });
		appendBatchedJsonlLine(fileB, '{"transcript":true}\n');
		await sleep(250);
		assert.equal(spy.appendCallsFor(fileA).length, 1, "path A flushes exactly once");
		assert.equal(spy.appendCallsFor(fileB).length, 1, "path B flushes exactly once");
		assert.equal(fs.readFileSync(fileB, "utf-8"), '{"transcript":true}\n');
	} finally {
		spy.restore();
		flushPendingSidechainWrites();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
