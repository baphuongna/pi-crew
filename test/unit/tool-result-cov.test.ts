import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolResult, isToolError, textFromToolResult } from "../../src/extension/tool-result.ts";

describe("toolResult", () => {
	it("creates a result with text content and details", () => {
		const r = toolResult("hello", { action: "test", status: "ok" });
		assert.equal(r.content.length, 1);
		assert.equal(r.content[0].type, "text");
		assert.equal(r.content[0].text, "hello");
		assert.deepEqual(r.details, { action: "test", status: "ok" });
		assert.equal(r.isError, false);
	});

	it("creates an error result when isError is true", () => {
		const r = toolResult("fail", { action: "run", status: "error" }, true);
		assert.equal(r.isError, true);
	});

	it("defaults isError to false", () => {
		const r = toolResult("ok", { action: "run", status: "ok" });
		assert.equal(r.isError, false);
	});

	it("preserves extra detail fields", () => {
		const r = toolResult("msg", { action: "cancel", status: "ok", runId: "r1", abortedIds: ["t1"] });
		assert.equal(r.details.runId, "r1");
		assert.deepEqual(r.details.abortedIds, ["t1"]);
	});
});

describe("isToolError", () => {
	it("returns true when isError is true", () => {
		assert.equal(isToolError({ isError: true }), true);
	});

	it("returns false when isError is false", () => {
		assert.equal(isToolError({ isError: false }), false);
	});

	it("returns false when isError is undefined", () => {
		assert.equal(isToolError({}), false);
	});
});

describe("textFromToolResult", () => {
	it("extracts text from single content item", () => {
		const r = { content: [{ type: "text", text: "hello" }] };
		assert.equal(textFromToolResult(r), "hello");
	});

	it("joins multiple content items with newline", () => {
		const r = { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] };
		assert.equal(textFromToolResult(r), "a\nb");
	});

	it("returns empty string when content is undefined", () => {
		assert.equal(textFromToolResult({}), "");
	});

	it("handles missing text field gracefully", () => {
		const r = { content: [{ type: "text" }] };
		assert.equal(textFromToolResult(r), "");
	});
});
