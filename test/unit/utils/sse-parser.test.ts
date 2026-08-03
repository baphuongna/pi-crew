import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSseEvents, readSseJson } from "../../../src/utils/sse-parser.ts";

function toStream(text: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
}

function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of gen) items.push(item);
	return items;
}

describe("readSseEvents", () => {
	it("parses a basic single event", async () => {
		const events = await collect(readSseEvents(toStream("data: hello\n\n")));
		assert.equal(events.length, 1);
		assert.equal(events[0].data, "hello");
		assert.equal(events[0].event, null);
	});

	it("handles multi-line data field", async () => {
		const events = await collect(readSseEvents(toStream("data: line1\ndata: line2\n\n")));
		assert.equal(events.length, 1);
		assert.equal(events[0].data, "line1\nline2");
	});

	it("handles event type field", async () => {
		const events = await collect(readSseEvents(toStream("event: message\ndata: hello\n\n")));
		assert.equal(events.length, 1);
		assert.equal(events[0].event, "message");
		assert.equal(events[0].data, "hello");
	});

	it("ignores comment lines", async () => {
		const events = await collect(readSseEvents(toStream(": this is a comment\ndata: hello\n\n")));
		assert.equal(events.length, 1);
		assert.equal(events[0].data, "hello");
		assert.equal(events[0].raw.length, 1);
	});

	it("stops on [DONE] sentinel", async () => {
		const events = await collect(readSseEvents(toStream("data: first\n\n[DONE]\ndata: second\n\n")));
		assert.equal(events.length, 1);
		assert.equal(events[0].data, "first");
	});

	it("parses multiple events in sequence", async () => {
		const events = await collect(readSseEvents(toStream("data: one\n\ndata: two\n\ndata: three\n\n")));
		assert.equal(events.length, 3);
		assert.equal(events[0].data, "one");
		assert.equal(events[1].data, "two");
		assert.equal(events[2].data, "three");
	});

	it("handles empty stream", async () => {
		const events = await collect(readSseEvents(toStream("")));
		assert.equal(events.length, 0);
	});

	it("handles CRLF line endings", async () => {
		const events = await collect(readSseEvents(toStream("data: hello\r\n\r\n")));
		assert.equal(events.length, 1);
		assert.equal(events[0].data, "hello");
	});

	it("handles partial / chunked delivery", async () => {
		const events = await collect(readSseEvents(chunkedStream(["data: hel", "lo\n\n", "data: world\n\n"])));
		assert.equal(events.length, 2);
		assert.equal(events[0].data, "hello");
		assert.equal(events[1].data, "world");
	});

	it("collects raw lines", async () => {
		const events = await collect(readSseEvents(toStream("event: ping\ndata: hello\n\n")));
		assert.deepEqual(events[0].raw, ["event: ping", "data: hello"]);
	});

	it("respects AbortSignal", async () => {
		const ac = new AbortController();
		ac.abort();
		const events = await collect(readSseEvents(toStream("data: hello\n\n"), ac.signal));
		assert.equal(events.length, 0);
	});
});

describe("readSseJson", () => {
	it("yields parsed JSON objects", async () => {
		const items = await collect(readSseJson<{ msg: string }>(toStream('data: {"msg":"hi"}\n\ndata: {"msg":"bye"}\n\n')));
		assert.equal(items.length, 2);
		assert.equal(items[0].msg, "hi");
		assert.equal(items[1].msg, "bye");
	});

	it("stops on [DONE]", async () => {
		const items = await collect(readSseJson<{ v: number }>(toStream('data: {"v":1}\n\n[DONE]\ndata: {"v":2}\n\n')));
		assert.equal(items.length, 1);
		assert.equal(items[0].v, 1);
	});
});
