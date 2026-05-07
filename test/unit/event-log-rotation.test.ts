import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { needsRotation, compactEventLog, getEventLogStats } from "../../src/state/event-log-rotation.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rotation-"));
}

function writeEvents(filePath: string, count: number, baseTime = "2025-01-01T00:00:00.000Z"): void {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		const ts = new Date(Date.parse(baseTime) + i * 1000).toISOString();
		lines.push(JSON.stringify({ time: ts, type: "tick", runId: "r1", metadata: { seq: i + 1, provenance: "test" } }));
	}
	fs.appendFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

describe("needsRotation", () => {
	it("returns false for non-existent file", () => {
		assert.equal(needsRotation("/nonexistent/file.jsonl"), false);
	});

	it("returns false for small files", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 10);
		assert.equal(needsRotation(filePath), false);
		fs.rmSync(dir, { recursive: true });
	});

	it("returns true when file exceeds size threshold", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		// Write enough events to exceed a tiny threshold
		writeEvents(filePath, 500);
		assert.ok(fs.statSync(filePath).size > 100);
		assert.equal(needsRotation(filePath, { maxFileSizeBytes: 100, maxEventCount: 100_000 }), true);
		fs.rmSync(dir, { recursive: true });
	});

	it("returns true when event count exceeds threshold", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 200);
		assert.equal(needsRotation(filePath, { maxFileSizeBytes: 100 * 1024 * 1024, maxEventCount: 100 }), true);
		fs.rmSync(dir, { recursive: true });
	});
});

describe("compactEventLog", () => {
	it("returns undefined for non-existent file", () => {
		assert.equal(compactEventLog("/nonexistent/file.jsonl"), undefined);
	});

	it("returns undefined when event count is below compactToCount", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 5);
		assert.equal(compactEventLog(filePath, { compactToCount: 100 }), undefined);
		fs.rmSync(dir, { recursive: true });
	});

	it("reduces file size", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 500);
		const originalSize = fs.statSync(filePath).size;
		const result = compactEventLog(filePath, { compactToCount: 50 });
		assert.ok(result);
		assert.ok(result.compactedSize < originalSize);
		assert.equal(result.originalSize, originalSize);
		assert.equal(result.eventsKept, 50);
		assert.equal(result.eventsRemoved, 450);
		fs.rmSync(dir, { recursive: true });
	});

	it("keeps last N events", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 200);
		compactEventLog(filePath, { compactToCount: 10 });
		const content = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
		assert.equal(content.length, 10);
		const first = JSON.parse(content[0]) as { metadata: { seq: number } };
		assert.equal(first.metadata.seq, 191); // events 191-200
		fs.rmSync(dir, { recursive: true });
	});

	it("preserves event order", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 100, "2025-06-01T00:00:00.000Z");
		compactEventLog(filePath, { compactToCount: 5 });
		const events = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { time: string });
		for (let i = 1; i < events.length; i++) {
			assert.ok(events[i].time >= events[i - 1].time, `event ${i} not in order: ${events[i].time} < ${events[i - 1].time}`);
		}
		fs.rmSync(dir, { recursive: true });
	});
});

describe("getEventLogStats", () => {
	it("returns undefined for non-existent file", () => {
		assert.equal(getEventLogStats("/nonexistent/file.jsonl"), undefined);
	});

	it("returns correct file size", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 10);
		const stat = getEventLogStats(filePath);
		assert.ok(stat);
		assert.equal(stat.fileSizeBytes, fs.statSync(filePath).size);
		assert.equal(stat.eventCount, 10);
		fs.rmSync(dir, { recursive: true });
	});

	it("returns oldest and newest timestamps", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 5, "2025-03-15T12:00:00.000Z");
		const stat = getEventLogStats(filePath);
		assert.ok(stat);
		assert.equal(stat.oldestTimestamp, "2025-03-15T12:00:00.000Z");
		assert.equal(stat.newestTimestamp, "2025-03-15T12:00:04.000Z");
		fs.rmSync(dir, { recursive: true });
	});
});
