import test from "node:test";
import assert from "node:assert/strict";
import { createJsonlWriter, type DrainableSource, type JsonlWriteStream } from "../../src/state/jsonl-writer.ts";

class MockSource implements DrainableSource {
	paused = 0;
	resumed = 0;
	pause(): void {
		this.paused++;
	}
	resume(): void {
		this.resumed++;
	}
}

class MockStream implements JsonlWriteStream {
	writes: string[] = [];
	ended = false;
	private drainHandler: (() => void) | undefined;
	private readonly writeResults: boolean[];
	constructor(writeResults: boolean[] = []) {
		this.writeResults = writeResults;
	}
	write(chunk: string): boolean {
		this.writes.push(chunk);
		if (this.writeResults.length === 0) return true;
		return this.writeResults.shift() ?? true;
	}
	once(event: "drain", listener: () => void): JsonlWriteStream {
		if (event === "drain") this.drainHandler = listener;
		return this;
	}
	end(callback?: () => void): void {
		this.ended = true;
		callback?.();
	}
	emitDrain(): void {
		this.drainHandler?.();
	}
}

test("writes line and keeps trailing newline", () => {
	const source = new MockSource();
	const stream = new MockStream();
	const writer = createJsonlWriter("/tmp/out.jsonl", source, { createWriteStream: () => stream });
	writer.writeLine('{"type":"a"}');
	writer.writeLine('{"type":"b"}');
	assert.deepEqual(stream.writes, ["{\"type\":\"a\"}\n", "{\"type\":\"b\"}\n"]);
	assert.equal(source.paused, 0);
	assert.equal(source.resumed, 0);
});

test("drops writes when max bytes exceeded", () => {
	const source = new MockSource();
	const stream = new MockStream();
	const writer = createJsonlWriter("/tmp/out.jsonl", source, {
		createWriteStream: () => stream,
		maxBytes: 20,
	});
	writer.writeLine('{"type":"a"}');
	writer.writeLine('{"type":"b"}');
	assert.equal(stream.writes.length, 1);
	assert.equal(stream.writes[0], "{\"type\":\"a\"}\n");
	assert.equal(source.paused, 0);
	assert.equal(source.resumed, 0);
});

test("pauses when backpressured and resumes on drain", async () => {
	const source = new MockSource();
	const stream = new MockStream([false, true]);
	const writer = createJsonlWriter("/tmp/out.jsonl", source, { createWriteStream: () => stream });
	writer.writeLine('{"type":"a"}');
	assert.equal(source.paused, 1);
	stream.emitDrain();
	assert.equal(source.resumed, 1);
	writer.writeLine('{"type":"b"}');
	assert.equal(stream.writes.length, 2);
});

test("close() is safe idempotent", async () => {
	const source = new MockSource();
	const stream = new MockStream();
	const writer = createJsonlWriter("/tmp/out.jsonl", source, { createWriteStream: () => stream });
	await writer.close();
	await writer.close();
	assert.equal(stream.ended, true);
});

test("drops a single line that exceeds maxLineBytes (Round 21 per-line cap)", () => {
	const source = new MockSource();
	const stream = new MockStream();
	const writer = createJsonlWriter("/tmp/out.jsonl", source, {
		createWriteStream: () => stream,
		maxLineBytes: 16,
	});
	// 16 bytes cap. The redactJsonLine output is a JSON string with the secret
	// fields preserved as plain text. Build a payload whose redacted form is
	// longer than 16 bytes (e.g. a large `data` field).
	const huge = JSON.stringify({ type: "x", data: "a".repeat(50) });
	writer.writeLine(huge);
	assert.equal(stream.writes.length, 0, "oversize line should be dropped, not written");
	// A normal-sized line should still go through.
	writer.writeLine('{"type":"ok"}');
	assert.equal(stream.writes.length, 1);
	assert.equal(stream.writes[0], "{\"type\":\"ok\"}\n");
});

test("per-line cap is independent of total maxBytes (Round 21)", () => {
	const source = new MockSource();
	const stream = new MockStream();
	const writer = createJsonlWriter("/tmp/out.jsonl", source, {
		createWriteStream: () => stream,
		maxBytes: 10_000_000, // huge total
		maxLineBytes: 8, // tiny per-line
	});
	writer.writeLine('{"type":"a"}');
	writer.writeLine('{"type":"b"}');
	// Both lines exceed 8 bytes after redaction + newline; both should drop.
	assert.equal(stream.writes.length, 0);
});
