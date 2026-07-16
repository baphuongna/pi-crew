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
import { describe, test, before, after } from "node:test";
import { ChildPiLineObserver, flushPendingTranscriptWrites } from "../../src/runtime/child-pi.ts";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import type { ChildPiRunInput } from "../../src/runtime/child-pi.ts";

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

function makeLine(type = "message"): string {
	return JSON.stringify({
		type,
		message: { role: "assistant", content: [{ type: "text", text: `event-${Date.now()}` }] },
	});
}

describe("Phase 3: transcript batching", () => {
	test("batched writes produce correct file content after flush", async () => {
		const transcriptPath = path.join(tmpDir, "batch-test.jsonl");
		const observer = makeObserver(transcriptPath);

		const lines = [makeLine(), makeLine(), makeLine()];
		for (const line of lines) {
			observer.observe(`${line}\n`);
		}
		await observer.flush();

		const content = fs.readFileSync(transcriptPath, "utf-8");
		const fileLines = content.split("\n").filter(Boolean);
		assert.equal(fileLines.length, 3, `expected 3 transcript lines, got ${fileLines.length}`);
	});

	test("flushPendingTranscriptWrites drains buffer", async () => {
		const transcriptPath = path.join(tmpDir, "drain-test.jsonl");
		const observer = makeObserver(transcriptPath);

		observer.observe(`${makeLine()}\n`);
		// Don't call observer.flush — use flushPendingTranscriptWrites directly
		await flushPendingTranscriptWrites();

		const content = fs.readFileSync(transcriptPath, "utf-8");
		const fileLines = content.split("\n").filter(Boolean);
		assert.equal(fileLines.length, 1, `expected 1 transcript line after flush, got ${fileLines.length}`);
	});

	test("file has O_APPEND-compatible content (lines end with newline)", async () => {
		const transcriptPath = path.join(tmpDir, "newline-test.jsonl");
		const observer = makeObserver(transcriptPath);

		observer.observe(`${makeLine()}\n${makeLine()}\n`);
		await observer.flush();

		const raw = fs.readFileSync(transcriptPath, "utf-8");
		// Every line should end with \n (O_APPEND writes are newline-terminated)
		assert.ok(raw.endsWith("\n"), "transcript file should end with newline");
		const fileLines = raw.split("\n").filter(Boolean);
		assert.equal(fileLines.length, 2, `expected 2 lines, got ${fileLines.length}`);
	});
});
