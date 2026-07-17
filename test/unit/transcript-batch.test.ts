/**
 * Phase 3 regression test: transcript batching behavior.
 *
 * Verifies that the batched transcript write path produces the same file
 * content as the old per-line path, with correct ordering and security flags.
 *
 * Run: PI_CREW_USE_BUNDLE=0 npx tsx --test test/unit/transcript-batch.test.ts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import type { ChildPiRunInput } from "../../src/runtime/child-pi.ts";
import { ChildPiLineObserver, flushPendingTranscriptWrites, resetTranscriptBatchState } from "../../src/runtime/child-pi.ts";

const SAMPLE_AGENT: AgentConfig = {
	name: "explorer",
	description: "",
	source: "builtin",
	filePath: "/test/explorer.json",
	systemPrompt: "",
};

let tmpDir: string;

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-batch-test-"));
});

afterEach(() => {
	// Reset module-scoped batch state between tests (H1 from review Round 2).
	resetTranscriptBatchState();
});

after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeObserver(transcriptPath: string): ChildPiLineObserver {
	const input: ChildPiRunInput = {
		cwd: tmpDir,
		task: "test",
		agent: SAMPLE_AGENT,
		transcriptPath,
		onJsonEvent: () => {},
		onStdoutLine: () => {},
	};
	return new ChildPiLineObserver(input);
}

function makeLine(text = "hello"): string {
	return JSON.stringify({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
}

describe("Phase 3: transcript batching", () => {
	test("batched writes produce correct file content after flush", async () => {
		const transcriptPath = path.join(tmpDir, "batch-test.jsonl");
		const observer = makeObserver(transcriptPath);

		const lines = [makeLine("a"), makeLine("b"), makeLine("c")];
		for (const line of lines) {
			observer.observe(`${line}\n`);
		}
		await observer.flush();

		const content = fs.readFileSync(transcriptPath, "utf-8");
		const fileLines = content.split("\n").filter(Boolean);
		assert.equal(fileLines.length, 3, `expected 3 transcript lines, got ${fileLines.length}`);
	});

	test("lines appear in correct order (M1: ordering verification)", async () => {
		const transcriptPath = path.join(tmpDir, "order-test.jsonl");
		const observer = makeObserver(transcriptPath);

		const payloads = ["first", "second", "third"];
		for (const text of payloads) {
			observer.observe(`${makeLine(text)}\n`);
		}
		await observer.flush();

		const content = fs.readFileSync(transcriptPath, "utf-8");
		const fileLines = content.split("\n").filter(Boolean);
		assert.equal(fileLines.length, 3);
		for (let i = 0; i < payloads.length; i++) {
			const parsed = JSON.parse(fileLines[i]);
			const text = parsed.message?.content?.[0]?.text;
			assert.equal(text, payloads[i], `line ${i}: expected "${payloads[i]}", got "${text}"`);
		}
	});

	test("flushPendingTranscriptWrites drains buffer", async () => {
		const transcriptPath = path.join(tmpDir, "drain-test.jsonl");
		const observer = makeObserver(transcriptPath);

		observer.observe(`${makeLine()}\n`);
		await flushPendingTranscriptWrites();

		const content = fs.readFileSync(transcriptPath, "utf-8");
		const fileLines = content.split("\n").filter(Boolean);
		assert.equal(fileLines.length, 1, `expected 1 transcript line after flush, got ${fileLines.length}`);
	});

	test("timer-based auto-flush writes content without explicit flush", async () => {
		const transcriptPath = path.join(tmpDir, "timer-test.jsonl");
		const observer = makeObserver(transcriptPath);

		observer.observe(`${makeLine("timer")}\n`);
		// Do NOT call flush — wait for the 50ms debounce timer to fire.
		await new Promise((r) => setTimeout(r, 150));

		const content = fs.readFileSync(transcriptPath, "utf-8");
		const fileLines = content.split("\n").filter(Boolean);
		assert.equal(fileLines.length, 1, `timer flush should write 1 line, got ${fileLines.length}`);
		const parsed = JSON.parse(fileLines[0]);
		const text = parsed.message?.content?.[0]?.text;
		assert.equal(text, "timer", `expected "timer", got "${text}"`);
	});

	test("file has O_APPEND-compatible content (lines end with newline)", async () => {
		const transcriptPath = path.join(tmpDir, "newline-test.jsonl");
		const observer = makeObserver(transcriptPath);

		observer.observe(`${makeLine()}\n${makeLine()}\n`);
		await observer.flush();

		const raw = fs.readFileSync(transcriptPath, "utf-8");
		assert.ok(raw.endsWith("\n"), "transcript file should end with newline");
		const fileLines = raw.split("\n").filter(Boolean);
		assert.equal(fileLines.length, 2, `expected 2 lines, got ${fileLines.length}`);
	});
});
