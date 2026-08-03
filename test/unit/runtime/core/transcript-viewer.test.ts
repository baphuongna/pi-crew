import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../../../src/runtime/crew-agent-records.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import type { CrewTheme } from "../../../../src/ui/theme-adapter.ts";
import { clearTranscriptCache, getTranscriptCacheEntry, readTranscriptLinesCached } from "../../../../src/ui/transcript-cache.ts";
import { DurableTextViewer, DurableTranscriptViewer, formatTranscriptText, readRunTranscript } from "../../../../src/ui/transcript-viewer.ts";

function manifest(tmp: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "team_transcript",
		team: "fast-fix",
		workflow: "fast-fix",
		goal: "transcript viewer",
		status: "completed",
		workspaceMode: "single",
		createdAt: "2026-04-27T00:00:00.000Z",
		updatedAt: "2026-04-27T00:00:00.000Z",
		cwd: tmp,
		stateRoot: tmp,
		artifactsRoot: tmp,
		tasksPath: path.join(tmp, "tasks.json"),
		eventsPath: path.join(tmp, "events.jsonl"),
		artifacts: [],
	};
}

test("formatTranscriptText formats message and tool JSONL into conversation lines", () => {
	const text = `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } })}\n${JSON.stringify({ type: "tool_result", toolName: "bash", text: "ok" })}\n`;
	assert.deepEqual(formatTranscriptText(text), ["[Assistant]:", "hello", "✓ [Tool: bash] tool_result", "ok"]);
});

const markerTheme: CrewTheme = {
	fg: (color, value) => `<${color}>${value}</${color}>`,
	bold: (value) => value,
	inverse: (value) => value,
};

test("formatTranscriptText styles errored tool events", () => {
	const text = `${JSON.stringify({ type: "tool_result", toolName: "bash", isError: true, text: "boom" })}\n`;
	const lines = formatTranscriptText(text, markerTheme);
	assert.equal(lines[0], "<error>✗ [Tool: bash] tool_result</error>");
});

test("formatTranscriptText styles partial tool events as running", () => {
	const text = `${JSON.stringify({ type: "tool_result", toolName: "read", isPartial: true, text: "chunk" })}\n`;
	const lines = formatTranscriptText(text, markerTheme);
	assert.equal(lines[0], "<accent>⋯ [Tool: read] tool_result</accent>");
});

test("transcript cache reuses parsed lines until file changes", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-transcript-cache-"));
	try {
		const transcriptPath = path.join(tmp, "transcript.jsonl");
		fs.writeFileSync(transcriptPath, "one\n", "utf-8");
		clearTranscriptCache(transcriptPath);
		let parses = 0;
		const parse = (text: string): string[] => {
			parses += 1;
			return text.trim().split(/\r?\n/);
		};
		assert.deepEqual(readTranscriptLinesCached(transcriptPath, parse), ["one"]);
		assert.deepEqual(readTranscriptLinesCached(transcriptPath, parse), ["one"]);
		assert.equal(parses, 1);
		assert.equal(getTranscriptCacheEntry(transcriptPath)?.readCount, 1);
		fs.writeFileSync(transcriptPath, "one\ntwo\n", "utf-8");
		assert.deepEqual(readTranscriptLinesCached(transcriptPath, parse), ["one", "two"]);
		assert.equal(parses, 2);
		assert.equal(getTranscriptCacheEntry(transcriptPath)?.readCount, 2);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("transcript cache defaults to bounded tail and can force full reads", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-transcript-tail-"));
	try {
		const transcriptPath = path.join(tmp, "large.jsonl");
		const lines = Array.from({ length: 200 }, (_value, index) => `line-${index.toString().padStart(3, "0")}`);
		fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf-8");
		clearTranscriptCache(transcriptPath);
		const parse = (text: string): string[] => text.split(/\r?\n/).filter(Boolean);
		const tailed = readTranscriptLinesCached(transcriptPath, parse, Date.now(), { maxTailBytes: 1024 });
		assert.ok(tailed.length < lines.length);
		assert.ok(tailed.at(0)?.startsWith("line-"));
		const tailEntry = getTranscriptCacheEntry(transcriptPath, {
			maxTailBytes: 1024,
		});
		assert.equal(tailEntry?.truncated, true);
		assert.ok((tailEntry?.bytesRead ?? 0) <= 1024);
		const full = readTranscriptLinesCached(transcriptPath, parse, Date.now(), { full: true, maxTailBytes: 1024 });
		assert.equal(full.length, lines.length);
		const fullEntry = getTranscriptCacheEntry(transcriptPath, {
			full: true,
			maxTailBytes: 1024,
		});
		assert.equal(fullEntry?.truncated, false);
		assert.equal(fullEntry?.size, fs.statSync(transcriptPath).size);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("DurableTranscriptViewer renders transcript overlay and scroll controls", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-transcript-viewer-"));
	try {
		const run = manifest(tmp);
		const transcriptPath = path.join(tmp, "transcript.jsonl");
		fs.writeFileSync(
			transcriptPath,
			`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "viewer hello" }] } })}\n`,
			"utf-8",
		);
		saveCrewAgents(run, [
			{
				id: "team_transcript:01",
				runId: run.runId,
				taskId: "01",
				agent: "explorer",
				role: "explorer",
				runtime: "live-session",
				status: "completed",
				startedAt: run.createdAt,
				transcriptPath,
			},
		]);
		assert.match(readRunTranscript(run).lines.join("\n"), /viewer hello/);
		let closed = false;
		const viewer = new DurableTranscriptViewer(
			run,
			{
				fg: (_color: string, value: string) => value,
				bold: (value: string) => value,
			} as never,
			() => {
				closed = true;
			},
		);
		const lines = viewer.render(100);
		assert.ok(lines.some((line) => line.includes("pi-crew transcript")));
		assert.ok(lines.some((line) => line.includes("viewer hello")));
		viewer.handleInput("q");
		assert.equal(closed, true);
		const resultViewer = new DurableTextViewer(
			"pi-crew result",
			"team_transcript:01",
			["result hello"],
			{
				fg: (_color: string, value: string) => value,
				bold: (value: string) => value,
			} as never,
			() => undefined,
		);
		assert.ok(resultViewer.render(80).some((line) => line.includes("result hello")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
