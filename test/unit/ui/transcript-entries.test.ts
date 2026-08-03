import assert from "node:assert/strict";
import test from "node:test";
import { parseTranscriptEntries, renderEntries, toggleEntry } from "../../../src/ui/transcript-entries.ts";

test("parseTranscriptEntries parses message and tool events from JSONL", () => {
	const lines = [
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello world" }],
			},
		}),
		JSON.stringify({
			type: "tool_call",
			name: "bash",
			input: { command: "ls" },
		}),
		JSON.stringify({
			type: "tool_result",
			toolName: "bash",
			text: "file.txt",
		}),
	];
	const entries = parseTranscriptEntries(lines);
	assert.equal(entries.length, 2);
	assert.equal(entries[0]!.type, "message");
	assert.equal(entries[0]!.role, "assistant");
	assert.match(entries[0]!.summary, /assistant.*hello world/i);
	assert.equal(entries[1]!.type, "tool_call");
	assert.equal(entries[1]!.toolName, "bash");
	assert.match(entries[1]!.content, /Result.*✓/);
	assert.match(entries[1]!.content, /file\.txt/);
});

test("parseTranscriptEntries groups tool_call with subsequent tool_result", () => {
	const lines = [
		JSON.stringify({
			type: "tool_call",
			toolName: "read",
			input: { path: "/foo.ts" },
		}),
		JSON.stringify({
			type: "tool_result",
			toolName: "read",
			text: "contents here",
		}),
	];
	const entries = parseTranscriptEntries(lines);
	assert.equal(entries.length, 1, "tool_call + tool_result should be grouped into one entry");
	assert.equal(entries[0]!.type, "tool_call");
	assert.equal(entries[0]!.toolName, "read");
	assert.match(entries[0]!.content, /contents here/);
});

test("parseTranscriptEntries handles standalone tool_result", () => {
	const lines = [
		JSON.stringify({
			type: "tool_result",
			toolName: "bash",
			text: "output",
			isError: true,
		}),
	];
	const entries = parseTranscriptEntries(lines);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]!.type, "tool_result");
	assert.equal(entries[0]!.toolName, "bash");
	assert.match(entries[0]!.summary, /✗/);
});

test("parseTranscriptEntries handles empty input", () => {
	assert.deepEqual(parseTranscriptEntries([]), []);
	assert.deepEqual(parseTranscriptEntries([""]), []);
	assert.deepEqual(parseTranscriptEntries(["   "]), []);
});

test("toggleEntry expands and collapses correctly", () => {
	const entries = parseTranscriptEntries([
		JSON.stringify({
			type: "message_end",
			message: { role: "user", content: "hi" },
		}),
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: "hey" },
		}),
	]);
	assert.equal(entries[0]!.expanded, false);
	assert.equal(entries[1]!.expanded, false);

	const expanded = toggleEntry(entries, 0);
	assert.equal(expanded[0]!.expanded, true);
	assert.equal(expanded[1]!.expanded, false, "other entries should remain unchanged");

	const collapsed = toggleEntry(expanded, 0);
	assert.equal(collapsed[0]!.expanded, false);

	// Original is not mutated
	assert.equal(entries[0]!.expanded, false);
});

test("renderEntries collapses entries to single line and expands to multi-line", () => {
	const entries = parseTranscriptEntries([
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: "short" },
		}),
		JSON.stringify({
			type: "message_end",
			message: { role: "user", content: "hello\nworld" },
		}),
	]);

	// Both collapsed → 2 lines
	const collapsed = renderEntries(entries, 200);
	assert.equal(collapsed.length, 2);
	assert.match(collapsed[0]!, /▸/);
	assert.match(collapsed[1]!, /▸/);

	// Expand second entry → more lines
	const expanded = toggleEntry(entries, 1);
	const expandedLines = renderEntries(expanded, 200);
	assert.ok(expandedLines.length > 2, "expanded entry should produce more lines");
	assert.match(expandedLines[0]!, /▸/);
	assert.match(expandedLines[1]!, /▾/);
	assert.match(expandedLines[2]!, / {2}/);
});

test("renderEntries truncates lines to maxWidth", () => {
	const entries = parseTranscriptEntries([
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: "this is a somewhat long message that should be truncated",
			},
		}),
	]);
	const lines = renderEntries(entries, 20);
	assert.equal(lines.length, 1);
	assert.ok(lines[0]!.length <= 20, `line length ${lines[0]!.length} should be <= maxWidth 20`);
});

test("renderEntries handles empty entries", () => {
	assert.deepEqual(renderEntries([], 80), []);
});

test("parseTranscriptEntries handles non-JSON lines as system entries", () => {
	const lines = [
		"plain text line",
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: "ok" },
		}),
	];
	const entries = parseTranscriptEntries(lines);
	assert.equal(entries.length, 2);
	assert.equal(entries[0]!.type, "system");
	assert.equal(entries[1]!.type, "message");
});

test("parseTranscriptEntries preserves timestamp", () => {
	const lines = [
		JSON.stringify({
			type: "message_end",
			timestamp: 12345,
			message: { role: "user", content: "hi" },
		}),
	];
	const entries = parseTranscriptEntries(lines);
	assert.equal(entries[0]!.timestamp, 12345);
});
