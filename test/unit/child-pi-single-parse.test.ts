/**
 * Phase 2 regression test: compactChildPiLine preParsed path produces output
 * identical to the standalone parse path, and emitLine now parses each line
 * exactly once (verified via instrumented JSON.parse count).
 *
 * Run: PI_CREW_ALLOW_MOCK=1 PI_TEAMS_MOCK_CHILD_PI=success npx tsx --test test/unit/child-pi-single-parse.test.ts
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { ChildPiLineObserver } from "../../src/runtime/child-pi.ts";
import type { ChildPiRunInput } from "../../src/runtime/child-pi.ts";

const SAMPLE_AGENT: AgentConfig = {
	name: "explorer",
	description: "",
	source: "builtin",
	filePath: "/test/explorer.json",
	systemPrompt: "",
};

function buildInput(): ChildPiRunInput {
	return {
		cwd: process.cwd(),
		task: "test",
		agent: SAMPLE_AGENT,
		onJsonEvent: () => {},
		onStdoutLine: () => {},
	};
}

describe("Phase 2: single JSON.parse per stdout line", () => {
	test("emitLine parses each valid JSON line exactly once", () => {
		const events: unknown[] = [];
		const input = buildInput();
		input.onJsonEvent = (e) => events.push(e);
		const observer = new ChildPiLineObserver(input);

		// Instrument JSON.parse to count child-pi-module-internal parses.
		// We count ALL parses during observe(); the only parse-per-line should be 1.
		const line = JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
		});
		const chunk = `${line}\n`;

		let count = 0;
		const orig = JSON.parse;
		(JSON as { parse: typeof JSON.parse }).parse = function (...args: Parameters<typeof JSON.parse>) {
			count++;
			return orig.apply(JSON, args);
		};
		try {
			observer.observe(chunk);
		} finally {
			(JSON as { parse: typeof JSON.parse }).parse = orig;
		}
		// Exactly one parse for one line (was 2 before Phase 2).
		assert.equal(count, 1, `expected 1 JSON.parse for 1 line, got ${count}`);
		assert.equal(events.length, 1, "one compacted event should be emitted");
	});

	test("non-JSON line falls back without double parse", () => {
		const observer = new ChildPiLineObserver(buildInput());
		let count = 0;
		const orig = JSON.parse;
		(JSON as { parse: typeof JSON.parse }).parse = function (...args: Parameters<typeof JSON.parse>) {
			count++;
			return orig.apply(JSON, args);
		};
		try {
			observer.observe("not json at all\n");
		} finally {
			(JSON as { parse: typeof JSON.parse }).parse = orig;
		}
		// One failed parse attempt in emitLine; compactChildPiLine must NOT re-parse.
		assert.equal(count, 1, `non-JSON line should parse once (failed), got ${count}`);
	});

	test("mixed valid+invalid chunk: parses == line count (not 2x)", () => {
		const valid = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x" }] } });
		const chunk = `${valid}\nbroken\n${valid}\n${valid}\n`;
		const observer = new ChildPiLineObserver(buildInput());
		let count = 0;
		const orig = JSON.parse;
		(JSON as { parse: typeof JSON.parse }).parse = function (...args: Parameters<typeof JSON.parse>) {
			count++;
			return orig.apply(JSON, args);
		};
		try {
			observer.observe(chunk);
		} finally {
			(JSON as { parse: typeof JSON.parse }).parse = orig;
		}
		// 4 lines: 3 valid (1 parse each) + 1 broken (1 failed parse) = 4 total.
		assert.equal(count, 4, `4 lines should produce 4 parses, got ${count}`);
	});

	test("getRawFinalText still captures uncapped assistant text", () => {
		const observer = new ChildPiLineObserver(buildInput());
		const text = "The authoritative final answer — uncapped.";
		const line = JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text }] },
		});
		observer.observe(`${line}\n`);
		assert.equal(observer.getRawFinalText(), text);
	});
});
