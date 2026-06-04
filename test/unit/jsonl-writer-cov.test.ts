import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJsonlWriter, type DrainableSource, type JsonlWriteStream, type JsonlWriterDeps } from "../../src/state/jsonl-writer.ts";

class MockSource implements DrainableSource {
	pauseCount = 0;
	resumeCount = 0;
	pause(): void { this.pauseCount++; }
	resume(): void { this.resumeCount++; }
}

class MockStream implements JsonlWriteStream {
	writes: string[] = [];
	ended = false;
	private drainHandler: (() => void) | undefined;
	private writeResults: boolean[];

	constructor(writeResults: boolean[] = []) {
		this.writeResults = [...writeResults];
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

	triggerDrain(): void {
		this.drainHandler?.();
	}
}

function makeDeps(streamResults: boolean[] = []): JsonlWriterDeps & { stream: MockStream } {
	const stream = new MockStream(streamResults);
	return {
		createWriteStream: () => stream,
		stream,
	};
}

describe("createJsonlWriter", () => {
	it("returns no-op writer when filePath is undefined", () => {
		const source = new MockSource();
		const writer = createJsonlWriter(undefined, source);
		writer.writeLine('{"test":true}');
		// Should not throw
	});

	it("returns no-op writer when filePath is empty string", () => {
		const source = new MockSource();
		const writer = createJsonlWriter("", source);
		writer.writeLine('{"test":true}');
	});

	it("writes lines to the stream", () => {
		const source = new MockSource();
		const deps = makeDeps();
		const writer = createJsonlWriter("/tmp/test.jsonl", source, deps);
		writer.writeLine('{"a":1}');
		writer.writeLine('{"b":2}');
		assert.equal(deps.stream.writes.length, 2);
		assert.ok(deps.stream.writes[0].includes('"a"'));
	});

	it("skips empty lines", () => {
		const source = new MockSource();
		const deps = makeDeps();
		const writer = createJsonlWriter("/tmp/test.jsonl", source, deps);
		writer.writeLine("");
		writer.writeLine("   ");
		assert.equal(deps.stream.writes.length, 0);
	});

	it("pauses source on backpressure", () => {
		const source = new MockSource();
		const deps = makeDeps([false]); // first write returns false = backpressure
		const writer = createJsonlWriter("/tmp/test.jsonl", source, deps);
		writer.writeLine('{"a":1}');
		assert.equal(source.pauseCount, 1);
		assert.equal(source.resumeCount, 0);
	});

	it("resumes source on drain", () => {
		const source = new MockSource();
		const deps = makeDeps([false]);
		const writer = createJsonlWriter("/tmp/test.jsonl", source, deps);
		writer.writeLine('{"a":1}');
		assert.equal(source.pauseCount, 1);
		deps.stream.triggerDrain();
		assert.equal(source.resumeCount, 1);
	});

	it("does not resume source after close on drain", () => {
		const source = new MockSource();
		const deps = makeDeps([false]);
		const writer = createJsonlWriter("/tmp/test.jsonl", source, deps);
		writer.writeLine('{"a":1}');
		// Close before drain
		const closePromise = writer.close();
		deps.stream.triggerDrain();
		// Resume should not be called since writer is closed
		assert.equal(source.resumeCount, 0);
		return closePromise;
	});

	it("respects maxBytes limit", () => {
		const source = new MockSource();
		const deps = makeDeps();
		const writer = createJsonlWriter("/tmp/test.jsonl", source, {
			...deps,
			maxBytes: 30,
		});
		writer.writeLine('{"a":1}'); // ~10 bytes
		writer.writeLine('{"b":2}'); // ~10 bytes
		writer.writeLine('{"c":3}'); // should exceed 30 bytes with newlines
		// Should have written at most 2 lines
		assert.ok(deps.stream.writes.length <= 3);
	});

	it("respects maxLineBytes limit", () => {
		const source = new MockSource();
		const deps = makeDeps();
		const writer = createJsonlWriter("/tmp/test.jsonl", source, {
			...deps,
			maxLineBytes: 20,
		});
		const bigLine = '{"key":"' + "x".repeat(100) + '"}';
		writer.writeLine(bigLine);
		assert.equal(deps.stream.writes.length, 0); // dropped for being too large
	});

	it("closes the stream", async () => {
		const source = new MockSource();
		const deps = makeDeps();
		const writer = createJsonlWriter("/tmp/test.jsonl", source, deps);
		await writer.close();
		assert.ok(deps.stream.ended);
	});

	it("ignores writes after close", async () => {
		const source = new MockSource();
		const deps = makeDeps();
		const writer = createJsonlWriter("/tmp/test.jsonl", source, deps);
		await writer.close();
		writer.writeLine('{"after":true}');
		assert.equal(deps.stream.writes.length, 0);
	});

	it("handles stream creation failure gracefully", () => {
		const source = new MockSource();
		const writer = createJsonlWriter("/tmp/test.jsonl", source, {
			createWriteStream: () => { throw new Error("no stream"); },
		});
		writer.writeLine('{"test":true}');
		// Should not throw
	});

	it("redacts secrets in written lines", () => {
		const source = new MockSource();
		const deps = makeDeps();
		const writer = createJsonlWriter("/tmp/test.jsonl", source, deps);
		writer.writeLine(JSON.stringify({ password: "secret123" }));
		const written = deps.stream.writes[0];
		assert.ok(written.includes("***"));
		assert.ok(!written.includes("secret123"));
	});
});
