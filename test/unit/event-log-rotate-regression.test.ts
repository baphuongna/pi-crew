import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { compactEventLog, rotateEventLog } from "../../src/state/event-log/event-log-rotation.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rotate-"));
}

function writeEvents(filePath: string, count: number, baseTime = "2025-01-01T00:00:00.000Z"): void {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		const ts = new Date(Date.parse(baseTime) + i * 1000).toISOString();
		lines.push(
			JSON.stringify({
				time: ts,
				type: "tick",
				runId: "r1",
				metadata: { seq: i + 1, provenance: "test" },
			}),
		);
	}
	fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

describe("rotateEventLog (Round 12 C1 regression)", () => {
	it("preserves ALL events in the archive (not empty)", () => {
		// BUG C1: previous code did atomicWriteFile("") THEN rename, so the
		// archive received an EMPTY file and all events were destroyed.
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 100);

		const result = rotateEventLog(filePath);
		assert.equal(result, true);

		// Find the archive file
		const archives = fs.readdirSync(dir).filter((f) => f.endsWith(".archive.jsonl"));
		assert.equal(archives.length, 1, "exactly one archive should be created");
		const archivePath = path.join(dir, archives[0]);

		// CRITICAL: archive must contain ALL 100 events, not be empty
		const archiveContent = fs.readFileSync(archivePath, "utf-8").split("\n").filter(Boolean);
		assert.equal(archiveContent.length, 100, `archive must preserve all events, got ${archiveContent.length}`);

		fs.rmSync(dir, { recursive: true });
	});

	it("creates an empty events.jsonl after rotation", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 50);

		rotateEventLog(filePath);

		// eventsPath must exist and be empty
		assert.ok(fs.existsSync(filePath), "eventsPath must still exist after rotation");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.equal(content, "", "eventsPath must be empty after rotation");

		fs.rmSync(dir, { recursive: true });
	});

	it("returns false for non-existent file", () => {
		assert.equal(rotateEventLog("/nonexistent/events.jsonl"), false);
	});

	it("can rotate multiple times (each archive is non-empty)", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");

		// First rotation
		writeEvents(filePath, 30);
		rotateEventLog(filePath);

		// Second rotation
		writeEvents(filePath, 20);
		rotateEventLog(filePath);

		const archives = fs.readdirSync(dir).filter((f) => f.endsWith(".archive.jsonl"));
		assert.equal(archives.length, 2, "two archives should exist");
		for (const archive of archives) {
			const content = fs.readFileSync(path.join(dir, archive), "utf-8").split("\n").filter(Boolean);
			assert.ok(content.length > 0, `archive ${archive} should not be empty`);
		}

		fs.rmSync(dir, { recursive: true });
	});
});

describe("compactEventLog recovery (Round 12 C2 regression)", () => {
	it("does not destroy the compacted log — recovery preserves all kept events", () => {
		// This test verifies the happy path is intact after the C2 fix.
		// The C2 bug (atomicWriteFile-per-event in the recovery loop) only
		// triggered when afterWrite < kept.length (a rare race). We verify
		// the normal compaction still keeps exactly compactToCount events.
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 200);

		const result = compactEventLog(filePath, { compactToCount: 20 });
		assert.ok(result);

		const content = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
		// Must keep exactly 20 (not collapse to 1 like the old recovery bug)
		assert.equal(content.length, 20, `compaction must keep 20 events, got ${content.length}`);

		// Verify they are the LAST 20 (seq 181-200)
		const seqs = content.map((l) => (JSON.parse(l) as { metadata: { seq: number } }).metadata.seq);
		assert.equal(seqs[0], 181);
		assert.equal(seqs[seqs.length - 1], 200);

		fs.rmSync(dir, { recursive: true });
	});
});
