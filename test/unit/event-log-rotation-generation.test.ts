/**
 * R-03 regression test: event-log rotation must bump a generation sidecar so
 * that byte-offset cursor readers (readEventsCursor with fromByteOffset)
 * detect the rotation/truncation and reset their offset instead of reading
 * past EOF and silently missing post-rotation events.
 *
 * Without the fix, a reader that captured a byte offset at the end of the
 * pre-rotation file keeps reusing that offset after rotation truncates the
 * file to empty. Once new events are appended, the stale offset points past
 * the (small) new file's EOF → the reader permanently misses those events.
 * The generation sidecar lets the reader detect the rotation and re-read
 * from offset 0 of the new file.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readEventsCursor } from "../../src/state/event-log/event-log.ts";
import { currentGeneration, generationPath, rotateEventLog } from "../../src/state/event-log/event-log-rotation.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-gen-"));
}

/** Append `count` events with sequential seq numbers starting at `fromSeq`. */
function appendEvents(filePath: string, fromSeq: number, count: number): void {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		const seq = fromSeq + i;
		lines.push(
			JSON.stringify({
				time: new Date(Date.parse("2025-01-01T00:00:00.000Z") + seq * 1000).toISOString(),
				type: "tick",
				runId: "r1",
				taskId: `t${seq}`,
				metadata: { seq, provenance: "test" },
			}),
		);
	}
	fs.appendFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

describe("R-03 generation sidecar", () => {
	it("currentGeneration returns 0 when no .gen sidecar exists (backward-compat)", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			appendEvents(filePath, 1, 5);
			assert.equal(fs.existsSync(generationPath(filePath)), false, "no sidecar before any rotation");
			assert.equal(currentGeneration(filePath), 0, "absent sidecar is treated as generation 0");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rotateEventLog bumps the generation sidecar monotonically", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			appendEvents(filePath, 1, 10);
			assert.equal(currentGeneration(filePath), 0);

			assert.equal(rotateEventLog(filePath), true);
			assert.equal(currentGeneration(filePath), 1);
			assert.ok(fs.existsSync(generationPath(filePath)), "rotation creates the sidecar");

			// A second rotation bumps again.
			appendEvents(filePath, 11, 5);
			assert.equal(rotateEventLog(filePath), true);
			assert.equal(currentGeneration(filePath), 2);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("R-03 readEventsCursor generation-aware reset", () => {
	it("detects rotation via generation and re-reads from offset 0 (no missed events)", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			// Initial events seq 1..10.
			appendEvents(filePath, 1, 10);
			const first = readEventsCursor(filePath, { fromByteOffset: 0 });
			assert.equal(first.events.length, 10);
			assert.equal(first.generation, 0, "no sidecar yet → generation 0");
			assert.ok((first.nextByteOffset ?? 0) > 0, "cursor advanced past the initial events");

			// Rotate: file truncated + archived, generation bumped to 1.
			rotateEventLog(filePath);
			assert.equal(currentGeneration(filePath), 1);

			// Post-rotation events seq 11..13 appended to the fresh file.
			appendEvents(filePath, 11, 3);

			// WITHOUT generation tracking: the stale byte offset (end of the
			// pre-rotation file) points past EOF of the new small file, so the
			// reader sees ZERO events — it MISSES seq 11..13.
			const stale = readEventsCursor(filePath, {
				fromByteOffset: first.nextByteOffset,
				sinceSeq: 10,
			});
			assert.equal(stale.events.length, 0, "stale cursor misses post-rotation events (the bug)");

			// WITH generation tracking: gen mismatch triggers a reset to
			// offset 0, so the reader picks up the post-rotation events.
			const recovered = readEventsCursor(filePath, {
				fromByteOffset: first.nextByteOffset,
				sinceSeq: 10,
				generation: first.generation,
			});
			assert.equal(recovered.events.length, 3, "generation-aware cursor recovers post-rotation events");
			assert.equal(recovered.events[0]?.metadata?.seq, 11);
			assert.equal(recovered.events.at(-1)?.metadata?.seq, 13);
			assert.equal(recovered.generation, 1, "returned generation reflects the post-rotation file");
			assert.equal(recovered.nextByteOffset, fs.statSync(filePath).size, "cursor advanced to end of new file");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not reset when generation is unchanged (normal incremental read)", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			appendEvents(filePath, 1, 5);
			const first = readEventsCursor(filePath, { fromByteOffset: 0 });

			// Append more events WITHOUT rotating (generation stays 0).
			appendEvents(filePath, 6, 3);
			const next = readEventsCursor(filePath, {
				fromByteOffset: first.nextByteOffset,
				sinceSeq: 5,
				generation: first.generation,
			});
			assert.equal(next.events.length, 3, "incremental read picks up appended events");
			assert.equal(next.generation, 0, "generation unchanged when no rotation");
			assert.ok((next.nextByteOffset ?? 0) > (first.nextByteOffset ?? 0), "cursor advanced past only the new bytes (no reset)");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stale generation with empty post-rotation file resets and returns nothing cleanly", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			appendEvents(filePath, 1, 4);
			const first = readEventsCursor(filePath, { fromByteOffset: 0 });
			rotateEventLog(filePath);
			// No events appended after rotation → file is empty.
			assert.equal(fs.statSync(filePath).size, 0);

			const after = readEventsCursor(filePath, {
				fromByteOffset: first.nextByteOffset,
				sinceSeq: 4,
				generation: first.generation,
			});
			assert.equal(after.events.length, 0, "no events to read in the empty rotated file");
			assert.equal(after.generation, 1, "generation bumped despite empty file");
			assert.equal(after.nextByteOffset, 0, "cursor reset to 0 for the empty file");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
