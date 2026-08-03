import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStreamPreview, feedJsonEvent, finishStreamPreview, renderPreviewStatus } from "../../src/runtime/output/stream-preview.ts";

describe("stream-preview", () => {
	it("creates a preview with correct defaults", () => {
		const p = createStreamPreview("t1", "r1");
		assert.equal(p.taskId, "t1");
		assert.equal(p.runId, "r1");
		assert.equal(p.textBuffer, "");
		assert.equal(p.activeToolCall, null);
		assert.equal(p.toolCallCount, 0);
		assert.equal(p.turnCount, 0);
		assert.equal(p.finished, false);
	});

	it("detects tool_call events", () => {
		const p = createStreamPreview("t1", "r1");
		const modified = feedJsonEvent(p, {
			type: "tool_call",
			name: "read",
			input: { path: "/foo.ts" },
		});
		assert.ok(modified);
		assert.ok(p.activeToolCall);
		assert.equal(p.activeToolCall.toolName, "read");
		assert.equal(p.toolCallCount, 1);
	});

	it("detects tool_result events and clears active tool", () => {
		const p = createStreamPreview("t1", "r1");
		feedJsonEvent(p, {
			type: "tool_call",
			name: "bash",
			input: { command: "ls" },
		});
		assert.ok(p.activeToolCall);
		feedJsonEvent(p, { type: "tool_result", output: "ok" });
		assert.equal(p.activeToolCall, null);
	});

	it("captures assistant text output", () => {
		const p = createStreamPreview("t1", "r1");
		feedJsonEvent(p, {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello world" }],
			},
		});
		assert.equal(p.turnCount, 1);
		assert.ok(p.textBuffer.includes("Hello world"));
	});

	it("captures direct text field", () => {
		const p = createStreamPreview("t1", "r1");
		feedJsonEvent(p, { text: "Direct output" });
		assert.ok(p.textBuffer.includes("Direct output"));
	});

	it("tracks usage from events", () => {
		const p = createStreamPreview("t1", "r1");
		feedJsonEvent(p, { usage: { input: 1000, output: 200, cost: 0.05 } });
		assert.ok(p.usage);
		assert.equal(p.usage?.input, 1000);
		assert.equal(p.usage?.output, 200);
		assert.equal(p.usage?.cost, 0.05);
	});

	it("returns false for non-object events", () => {
		const p = createStreamPreview("t1", "r1");
		assert.equal(feedJsonEvent(p, "string"), false);
		assert.equal(feedJsonEvent(p, null), false);
		assert.equal(feedJsonEvent(p, 42), false);
	});

	it("truncates text buffer when exceeding max", () => {
		const p = createStreamPreview("t1", "r1");
		const longText = "x".repeat(20_000);
		feedJsonEvent(p, { text: longText });
		assert.ok(p.textBuffer.length <= 16_384);
		assert.ok(p.textBuffer.endsWith("xxx"));
	});

	it("truncates tool input preview", () => {
		const p = createStreamPreview("t1", "r1");
		const longInput = "a".repeat(1000);
		feedJsonEvent(p, { type: "tool_call", name: "edit", input: longInput });
		assert.ok(p.activeToolCall!);
		assert.ok(p.activeToolCall!.inputPreview.length <= 512);
		assert.ok(p.activeToolCall!.inputPreview.endsWith("..."));
	});

	it("finishStreamPreview marks finished and clears active tool", () => {
		const p = createStreamPreview("t1", "r1");
		feedJsonEvent(p, { type: "tool_call", name: "read", input: {} });
		assert.ok(p.activeToolCall);
		finishStreamPreview(p);
		assert.equal(p.finished, true);
		assert.equal(p.activeToolCall, null);
	});

	it("renderPreviewStatus shows tool name when active", () => {
		const p = createStreamPreview("t1", "r1");
		feedJsonEvent(p, { type: "tool_call", name: "bash", input: {} });
		const status = renderPreviewStatus(p);
		assert.ok(status.includes("bash"));
		assert.ok(status.includes("T0"));
	});

	it("renderPreviewStatus shows done when finished", () => {
		const p = createStreamPreview("t1", "r1");
		finishStreamPreview(p);
		const status = renderPreviewStatus(p);
		assert.ok(status.includes("done"));
	});

	it("accumulates multiple text events", () => {
		const p = createStreamPreview("t1", "r1");
		feedJsonEvent(p, { text: "Line 1" });
		feedJsonEvent(p, { text: "Line 2" });
		assert.ok(p.textBuffer.includes("Line 1"));
		assert.ok(p.textBuffer.includes("Line 2"));
	});
});
