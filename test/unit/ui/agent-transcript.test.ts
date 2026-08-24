/**
 * Unit tests for the per-agent event JSONL → transcript item parser.
 *
 * Feeds records in the exact envelope `appendCrewAgentEventBuffered` writes
 * (`{seq, time, event}` with the compacted child-pi event inside — the shape
 * produced by `compactChildPiEvent` in child-pi-streams.ts) and asserts the
 * pane-facing items that come out.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { TeamRunManifest } from "../../../src/state/types.ts";
import {
	__hasAgentTranscriptState,
	type CrewTranscriptItem,
	readAgentTranscript,
	resetAgentTranscriptCursor,
	resetAllAgentTranscriptCursors,
} from "../../../src/ui/inline-panel/agent-transcript.ts";

const TASK = "task_1";

interface Fixture {
	manifest: TeamRunManifest;
	dir: string;
	file: string;
}

function makeFixture(): Fixture {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-agent-transcript-test-"));
	const agentsDir = path.join(dir, "agents", TASK);
	fs.mkdirSync(agentsDir, { recursive: true });
	const file = path.join(agentsDir, "events.jsonl");
	const manifest = { stateRoot: dir, artifactsRoot: dir } as unknown as TeamRunManifest;
	return { manifest, dir, file };
}

function writeEvents(fixture: Fixture, events: Array<Record<string, unknown>>, startSeq = 1): void {
	const lines = events.map((event, i) => JSON.stringify({ seq: startSeq + i, time: new Date().toISOString(), event }));
	fs.appendFileSync(fixture.file, `${lines.join("\n")}\n`, "utf-8");
}

function cleanup(fixture: Fixture): void {
	resetAllAgentTranscriptCursors();
	try {
		fs.rmSync(fixture.dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

test("tool start → end → message_end folds one tool card with its result", () => {
	const fixture = makeFixture();
	try {
		writeEvents(fixture, [
			{ type: "tool_execution_start", toolName: "read", args: { file_path: "/tmp/a.ts" } },
			{ type: "tool_execution_end", toolName: "read" },
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Saw it." },
						{ type: "toolResult", name: "read", content: "<file body>", isError: false },
					],
					stopReason: "end_turn",
				},
			},
		]);

		const items = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(items.length, 2, "one tool card + one assistant text");
		const [tool, assistant] = items as CrewTranscriptItem[];

		assert.equal(tool.type, "tool");
		if (tool.type === "tool") {
			assert.equal(tool.name, "read");
			assert.equal(tool.args.file_path, "/tmp/a.ts");
			assert.deepEqual(
				tool.result,
				{ content: [{ type: "text", text: "<file body>" }], isError: false },
				"toolResult folds into the pending start as an updateResult envelope",
			);
			assert.equal(tool.isError, false);
		}
		assert.equal(assistant.type, "assistant");
		if (assistant.type === "assistant") assert.equal(assistant.text, "Saw it.");
	} finally {
		cleanup(fixture);
	}
});

test("pi ≥0.84 role:toolResult message_end records fold FIFO into pending starts", () => {
	// Real-run shape (pi 0.84.2): results are their OWN message_end records
	// with NO tool name, arriving in the originating message's toolCall order
	// even when the executions complete out of order (concurrent tools).
	const fixture = makeFixture();
	try {
		writeEvents(fixture, [
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "need both" },
						{ type: "text", text: "Checking." },
						{ type: "toolCall", name: "bash" },
						{ type: "toolCall", name: "read" },
					],
				},
			},
			{ type: "tool_execution_start", toolName: "bash", args: { command: "wc -l" } },
			{ type: "tool_execution_start", toolName: "read", args: { file_path: "/tmp/a.ts" } },
			{ type: "tool_execution_end", toolName: "read" },
			{ type: "tool_execution_end", toolName: "bash" },
			{ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "1054 /tmp/a.ts" }] } },
			{ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "file body" }] } },
		]);

		const items = readAgentTranscript(fixture.manifest, TASK);
		const tools = items.filter((item) => item.type === "tool");
		assert.equal(tools.length, 2, "both tool cards present");
		const bash = tools[0];
		const read = tools[1];
		if (bash?.type === "tool" && read?.type === "tool") {
			assert.equal(bash.name, "bash");
			assert.equal(read.name, "read");
			// FIFO: the first result lands on the FIRST-STARTED tool (bash),
			// not on the one that finished first (read).
			assert.deepEqual(bash.result, { content: [{ type: "text", text: "1054 /tmp/a.ts" }], isError: false });
			assert.deepEqual(read.result, { content: [{ type: "text", text: "file body" }], isError: false });
		}
		// The role:toolResult records themselves must not become items.
		assert.equal(items.filter((item) => item.type === "system").length, 0);
	} finally {
		cleanup(fixture);
	}
});

test("role:toolResult with isError marks the card and leaves later starts pending", () => {
	const fixture = makeFixture();
	try {
		writeEvents(fixture, [
			{ type: "tool_execution_start", toolName: "bash", args: { command: "false" } },
			{ type: "tool_execution_start", toolName: "read", args: { file_path: "/tmp/b.ts" } },
			{ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "boom" }], isError: true } },
		]);

		const items = readAgentTranscript(fixture.manifest, TASK);
		const tools = items.filter((item) => item.type === "tool");
		const bash = tools[0];
		const read = tools[1];
		if (bash?.type === "tool") {
			assert.deepEqual(bash.result, { content: [{ type: "text", text: "boom" }], isError: true });
			assert.equal(bash.isError, true);
		}
		if (read?.type === "tool") {
			assert.equal(read.result, undefined, "second card stays started until its result arrives");
		}
	} finally {
		cleanup(fixture);
	}
});

test("assistant item keeps the full message (thinking + usage) normalized for the pane", () => {
	const fixture = makeFixture();
	try {
		writeEvents(fixture, [
			{
				type: "message_end",
				usage: { input: 1200, output: 340, cost: 0.0042 },
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "let me reason about this" },
						{ type: "text", text: "Saw it." },
					],
					stopReason: "end_turn",
					model: "commandcode/poolside/laguna-s-2.1-free",
				},
			},
		]);

		const items = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(items.length, 1);
		const assistant = items[0];
		assert.equal(assistant?.type, "assistant");
		if (assistant?.type !== "assistant") return;

		assert.equal(assistant.text, "Saw it.");
		assert.ok(assistant.message, "full compacted message is retained for AssistantMessageComponent");
		const content = (assistant.message.content as Array<Record<string, unknown>>) ?? [];
		assert.ok(
			content.some((part) => part.type === "thinking" && String(part.thinking).includes("reason")),
			"thinking part survives",
		);
		// Record-level usage merges into the message and is normalized to pi shape.
		assert.deepEqual(assistant.usage, {
			input: 1200,
			output: 340,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { total: 0.0042 },
		});
		if (assistant.message.usage) {
			assert.equal((assistant.message.usage as Record<string, unknown>).input, 1200, "usage merged into the retained message");
		}
	} finally {
		cleanup(fixture);
	}
});

test("user messages become user items", () => {
	const fixture = makeFixture();
	try {
		writeEvents(fixture, [
			{
				type: "message_end",
				message: { role: "user", content: [{ type: "text", text: "Inspect the auth flow" }] },
			},
		]);
		const items = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(items.length, 1);
		assert.equal(items[0]?.type, "user");
		assert.equal(items[0]?.type === "user" ? items[0].text : "", "Inspect the auth flow");
	} finally {
		cleanup(fixture);
	}
});

test("unknown events degrade to dim system lines only when they carry text", () => {
	const fixture = makeFixture();
	try {
		writeEvents(fixture, [
			{ type: "worker_status", text: "heartbeat" },
			{ type: "task.claimed" },
			{ type: "message_update", text: "should be dropped" },
		]);
		const items = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(items.length, 1, "only the text-bearing system event survives");
		assert.equal(items[0]?.type, "system");
	} finally {
		cleanup(fixture);
	}
});

test("cross-read pairing: a tool start on one read folds with its result on the next", () => {
	const fixture = makeFixture();
	try {
		writeEvents(fixture, [{ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } }]);
		const first = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(first.length, 1);
		assert.equal(first[0]?.type, "tool");
		if (first[0]?.type === "tool") assert.equal(first[0].result, undefined, "still running after the first read");

		// The result arrives in the next read (new events only, seq continues).
		writeEvents(
			fixture,
			[
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolResult", name: "bash", content: "ok", isError: false }],
					},
				},
			],
			2,
		);
		const second = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(second.length, 1, "same tool card, not a duplicate");
		if (second[0]?.type === "tool") {
			assert.deepEqual(
				second[0].result,
				{ content: [{ type: "text", text: "ok" }], isError: false },
				"result folds across the read boundary",
			);
		}
	} finally {
		cleanup(fixture);
	}
});

test("cursor accumulator returns full history, capped at MAX", () => {
	const fixture = makeFixture();
	try {
		// 510 assistant messages → ring buffer keeps the most recent 500.
		const events = Array.from({ length: 510 }, (_, i) => ({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: `msg ${i}` }] },
		}));
		writeEvents(fixture, events);

		const items = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(items.length, 500, "ring-capped at 500");
		assert.equal(items[0]?.type === "assistant" ? items[0].text : "", "msg 10", "oldest retained is the 501st event");
		const last = items.at(-1);
		assert.equal(last?.type === "assistant" ? last.text : "", "msg 509");
	} finally {
		cleanup(fixture);
	}
});

test("switch + teardown reset per-task state", () => {
	const fixture = makeFixture();
	try {
		writeEvents(fixture, [{ type: "tool_execution_start", toolName: "read", args: {} }]);
		readAgentTranscript(fixture.manifest, TASK);
		assert.ok(__hasAgentTranscriptState(TASK), "state retained while the task is active");

		resetAgentTranscriptCursor(TASK);
		assert.ok(!__hasAgentTranscriptState(TASK), "switch clears the old task's state");

		// Re-reading replays from scratch (new cursor starts at 0).
		const items = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(items.length, 1);
	} finally {
		cleanup(fixture);
	}
});

test("malformed JSON lines are skipped, not fatal", () => {
	const fixture = makeFixture();
	try {
		fs.appendFileSync(fixture.file, "not json\n", "utf-8");
		writeEvents(fixture, [{ type: "tool_execution_start", toolName: "read", args: {} }]);
		const items = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(items.length, 1);
		assert.equal(items[0]?.type, "tool");
	} finally {
		cleanup(fixture);
	}
});

test("worker prompt artifact seeds the opening user message (session parity)", () => {
	const fixture = makeFixture();
	try {
		fs.mkdirSync(path.join(fixture.dir, "prompts"), { recursive: true });
		fs.writeFileSync(path.join(fixture.dir, "prompts", `${TASK}.md`), "# Worker prompt\ndo the thing", "utf-8");
		writeEvents(fixture, [
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }] } },
		]);

		const items = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(items[0]?.type, "user", "the child's initial prompt opens the transcript");
		if (items[0]?.type === "user") assert.match(items[0].text, /do the thing/);

		// A later read (new events) must not seed a second copy.
		writeEvents(
			fixture,
			[{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }],
			2,
		);
		const again = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(again.filter((item) => item.type === "user").length, 1, "seeded exactly once");
	} finally {
		cleanup(fixture);
	}
});

test("missing prompt artifact is skipped without poisoning later reads", () => {
	const fixture = makeFixture();
	try {
		writeEvents(fixture, [
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }] } },
		]);
		let items = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(items.every((item) => item.type !== "user"), true, "no seed without the artifact");

		// Artifact appears late (e.g. written after the first peek): the next
		// read seeds it.
		fs.mkdirSync(path.join(fixture.dir, "prompts"), { recursive: true });
		fs.writeFileSync(path.join(fixture.dir, "prompts", `${TASK}.md`), "late prompt", "utf-8");
		items = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(items[0]?.type, "user");
		if (items[0]?.type === "user") assert.equal(items[0].text, "late prompt");
	} finally {
		cleanup(fixture);
	}
});
