/**
 * ST-8 regression test: rotation must not lose events when a concurrent
 * append is in flight.
 *
 * The old copy+truncate approach (`copyFileSync` + `atomicWriteFile("")`)
 * orphaned in-flight writer file descriptors: appends that landed on the
 * OLD inode after `atomicWriteFile` replaced `eventsPath` with a new
 * (empty) inode went to an inode with no directory entry — silently lost
 * forever once the writer's fd closed.
 *
 * The rename+create fix ensures:
 *   - The old inode (with ALL pre-rotation content) moves atomically to the
 *     archive path via `rename(2)`. In-flight writer fds that still point
 *     at the old inode continue writing to it — but it is now the ARCHIVE,
 *     so their appends are preserved, not orphaned.
 *   - A fresh new inode is created at `eventsPath` for subsequent appends.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { rotateEventLog, rotateEventLogUnlocked } from "../../src/state/event-log-rotation.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st8-"));
}

function makeEventLine(seq: number): string {
	return (
		JSON.stringify({
			time: new Date(Date.parse("2025-01-01T00:00:00.000Z") + seq * 1000).toISOString(),
			type: "tick",
			runId: "r1",
			metadata: { seq, provenance: "test" },
		}) + "\n"
	);
}

function writeEvents(filePath: string, count: number, fromSeq = 1): void {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) lines.push(makeEventLine(fromSeq + i).trimEnd());
	fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

/** Collect every event seq found in the live file + all archive files in dir. */
function collectAllSeqs(dir: string, liveName: string): Set<number> {
	const seqs = new Set<number>();
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith(".jsonl") || name.endsWith(".seq") || name.endsWith(".gen")) continue;
		if (name === `${liveName}.seq` || name === `${liveName}.gen`) continue;
		// Only inspect the live file and *.archive.jsonl files.
		if (name !== liveName && !name.endsWith(".archive.jsonl")) continue;
		const fullPath = path.join(dir, name);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(fullPath);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		const content = fs.readFileSync(fullPath, "utf-8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as { metadata?: { seq?: number } };
				if (typeof event.metadata?.seq === "number") seqs.add(event.metadata.seq);
			} catch {
				/* skip corrupt */
			}
		}
	}
	return seqs;
}

describe("ST-8: rotation under concurrent append (no event lost)", () => {
	it("in-flight writer fd lands in the archive, not orphaned", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			writeEvents(filePath, 10, 1); // seq 1..10

			// Simulate an in-flight writer fd opened BEFORE rotation (e.g. an
			// async append that yielded between open and write).
			const writerFd = fs.openSync(filePath, "a");

			// Rotate: rename live → archive, create new empty live.
			assert.equal(rotateEventLog(filePath), true);

			// The in-flight append completes AFTER rotation. With copy+truncate
			// this write went to the orphaned old inode and was lost. With
			// rename+create it lands in the archive (which shares the old inode).
			fs.writeSync(writerFd, makeEventLine(11));
			fs.closeSync(writerFd);

			// A NEW append opens the fresh live log (new inode at eventsPath).
			fs.appendFileSync(filePath, makeEventLine(12), "utf-8");

			// No event may be lost — all 12 must appear across live + archive.
			const allSeqs = collectAllSeqs(dir, "events.jsonl");
			assert.equal(allSeqs.size, 12, `expected 12 unique events (seq 1..12), got ${allSeqs.size}`);
			for (let s = 1; s <= 12; s++) {
				assert.ok(allSeqs.has(s), `event seq ${s} was lost`);
			}

			// The live log must contain the post-rotation append (seq 12).
			const liveContent = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
			assert.equal(liveContent.length, 1, "live log should have exactly the post-rotation append");
			const liveEvent = JSON.parse(liveContent[0]) as { metadata: { seq: number } };
			assert.equal(liveEvent.metadata.seq, 12);

			// The in-flight append (seq 11) must be in the archive, not lost.
			const archives = fs.readdirSync(dir).filter((f) => f.endsWith(".archive.jsonl"));
			assert.equal(archives.length, 1, "exactly one archive");
			const archiveContent = fs.readFileSync(path.join(dir, archives[0]), "utf-8").split("\n").filter(Boolean);
			assert.equal(archiveContent.length, 11, "archive must have 10 pre-rotation + 1 in-flight append");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("multiple sequential appends + rotations lose no events", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			const initialCount = 50;
			const perBatch = 100;
			const rotations = 5;
			writeEvents(filePath, initialCount, 1); // seq 1..50

			let nextSeq = initialCount + 1;
			// Interleave raw appends and rotations — exercises rename+create
			// repeatedly and verifies every event lands somewhere.
			for (let r = 0; r < rotations; r++) {
				for (let i = 0; i < perBatch; i++) {
					fs.appendFileSync(filePath, makeEventLine(nextSeq++), "utf-8");
				}
				assert.equal(rotateEventLogUnlocked(filePath), true);
			}
			// Final batch after the last rotation.
			for (let i = 0; i < perBatch; i++) {
				fs.appendFileSync(filePath, makeEventLine(nextSeq++), "utf-8");
			}

			const expectedTotal = initialCount + perBatch * (rotations + 1);
			const allSeqs = collectAllSeqs(dir, "events.jsonl");
			assert.equal(allSeqs.size, expectedTotal, `expected ${expectedTotal} events, got ${allSeqs.size}`);

			// No gaps in the seq range 1..expectedTotal.
			for (let s = 1; s <= expectedTotal; s++) {
				assert.ok(allSeqs.has(s), `event seq ${s} was lost`);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("live log is a fresh empty file after rotation (new inode on POSIX)", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			writeEvents(filePath, 10, 1);
			const inodeBefore = fs.statSync(filePath).ino;
			rotateEventLog(filePath);
			const statAfter = fs.statSync(filePath);
			// On POSIX the inode must differ: rename moved the old inode to the
			// archive; create made a new inode for the live log. On Windows
			// `ino` is always 0 so the assertion is skipped there.
			if (process.platform !== "win32" && inodeBefore !== 0) {
				assert.notEqual(statAfter.ino, inodeBefore, "rotation must create a new inode for the live log");
			}
			assert.equal(statAfter.size, 0, "live log must be empty after rotation");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("archive preserves ALL pre-rotation content (not a copy-time snapshot)", () => {
		// The old copy+truncate took a snapshot at copy time; appends between
		// copy and truncate were excluded from the archive. With rename, the
		// archive IS the pre-rotation inode, so it carries every byte.
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			writeEvents(filePath, 20, 1);

			// Open a writer fd, then rotate, then write via the fd.
			const fd = fs.openSync(filePath, "a");
			rotateEventLogUnlocked(filePath);
			fs.writeSync(fd, makeEventLine(21));
			fs.closeSync(fd);

			const archives = fs.readdirSync(dir).filter((f) => f.endsWith(".archive.jsonl"));
			assert.equal(archives.length, 1);
			const archiveSeqs = fs
				.readFileSync(path.join(dir, archives[0]), "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((l) => (JSON.parse(l) as { metadata: { seq: number } }).metadata.seq);
			// Archive must have seq 1..21 (20 original + the in-flight append).
			assert.equal(archiveSeqs.length, 21);
			assert.equal(archiveSeqs[0], 1);
			assert.equal(archiveSeqs[20], 21);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("ST-8: rotation under true concurrent append (worker threads)", () => {
	it("concurrent appenders + rotation lose no events", async () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			const initialCount = 100;
			writeEvents(filePath, initialCount, 1);

			const numWorkers = 4;
			const eventsPerWorker = 250;
			const baseSeq = initialCount + 1;

			// Each worker hammers the file with appends on its own thread.
			const workerCode = `
				const fs = require("fs");
				const { workerData, parentPort } = require("node:worker_threads");
				const { filePath, startSeq, count } = workerData;
				for (let i = 0; i < count; i++) {
					const seq = startSeq + i;
					fs.appendFileSync(
						filePath,
						JSON.stringify({
							time: new Date(Date.parse("2025-01-01T00:00:00.000Z") + seq * 1000).toISOString(),
							type: "tick",
							runId: "r1",
							metadata: { seq, provenance: "test" },
						}) + "\\n",
					);
				}
				parentPort.postMessage("done");
			`;

			const workers: Worker[] = [];
			const workerPromises: Promise<string>[] = [];
			for (let w = 0; w < numWorkers; w++) {
				const worker = new Worker(workerCode, {
					eval: true,
					workerData: {
						filePath,
						startSeq: baseSeq + w * eventsPerWorker,
						count: eventsPerWorker,
					},
				});
				workers.push(worker);
				workerPromises.push(
					new Promise<string>((resolve, reject) => {
						worker.on("message", (msg: string) => resolve(msg));
						worker.on("error", reject);
					}),
				);
			}

			// While workers append, rotate a few times from the main thread.
			const rotateCount = 3;
			for (let r = 0; r < rotateCount; r++) {
				// Small delay to let workers append some events first.
				await new Promise((resolve) => setTimeout(resolve, 5));
				rotateEventLogUnlocked(filePath);
			}

			await Promise.all(workerPromises);

			const expectedTotal = initialCount + numWorkers * eventsPerWorker;
			const allSeqs = collectAllSeqs(dir, "events.jsonl");
			// Every event must appear exactly once across live + archives.
			// With the old copy+truncate, in-flight appends during rotation
			// were orphaned and lost. With rename+create, every append lands
			// either in the live log or an archive.
			assert.equal(
				allSeqs.size,
				expectedTotal,
				`expected ${expectedTotal} unique events, got ${allSeqs.size} (lost ${expectedTotal - allSeqs.size})`,
			);
			for (let s = 1; s <= expectedTotal; s++) {
				assert.ok(allSeqs.has(s), `event seq ${s} was lost`);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
