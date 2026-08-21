/**
 * Unit tests for the agent-view session builder: compacted events.jsonl →
 * a linear pi session file (`/crew-view` whole-screen swap).
 *
 * Events use the exact envelope the child-pi writer produces
 * (`{seq, time, event}` with COMPACTED events — toolCall/toolResult ids are
 * absent and must be re-synthesized here).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { agentEventsPath } from "../../../src/runtime/crew-agent-records.ts";
import { __test__clearManifestCache, createRunManifest } from "../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import { buildAgentViewSessionFile, workerSessionSourceStamp } from "../../../src/ui/inline-panel/agent-view-session.ts";
import { CREW_VIEW_SESSION_BASENAME } from "../../../src/ui/inline-panel/view-session-store.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../fixtures/test-tempdir.ts";

const team: TeamConfig = {
	name: "test-team",
	description: "Test team",
	source: "builtin",
	filePath: "test.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const singleStepWorkflow: WorkflowConfig = {
	name: "test-workflow",
	description: "Test workflow",
	source: "builtin",
	filePath: "test.workflow.md",
	steps: [{ id: "step1", role: "executor", task: "Do thing" }],
};

interface Fixture {
	cwd: string;
	runId: string;
	taskId: string;
	eventsFile: string;
	viewFile: string;
}

function makeFixture(goal: string): Fixture {
	const cwd = createTrackedTempDir("pi-crew-aview-");
	const created = createRunManifest({ cwd, team, workflow: singleStepWorkflow, goal });
	const runId = created.manifest.runId;
	const taskId = created.tasks[0].id;
	const eventsFile = agentEventsPath(created.manifest, taskId);
	fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
	return {
		cwd,
		runId,
		taskId,
		eventsFile,
		viewFile: path.join(path.dirname(eventsFile), CREW_VIEW_SESSION_BASENAME),
	};
}

function writeEvents(fixture: Fixture, events: Array<Record<string, unknown>>, startSeq = 1): void {
	const lines = events.map((event, i) => JSON.stringify({ seq: startSeq + i, time: new Date().toISOString(), event }));
	fs.appendFileSync(fixture.eventsFile, `${lines.join("\n")}\n`, "utf-8");
}

function readView(fixture: Fixture): Array<Record<string, unknown>> {
	return fs
		.readFileSync(fixture.viewFile, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assistantEntries(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	return records.filter(
		(r) => r.type === "message" && (r.message as { role?: string } | undefined)?.role === "assistant" && r.id !== "crew-view-intro",
	);
}

/** Extract the first text part of an assistant entry (test helper). */
function firstText(entry: Record<string, unknown> | undefined): string | undefined {
	const message = entry?.message;
	if (!message || typeof message !== "object") return undefined;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content) || content.length === 0) return undefined;
	const part = content[0] as { text?: unknown } | undefined;
	return typeof part?.text === "string" ? part.text : undefined;
}

/** The message body of an assistant entry (test helper). */
function entryMessage(entry: Record<string, unknown> | undefined): {
	usage?: { input?: number; cacheRead?: number; cost?: { total?: number } };
} {
	const message = entry?.message;
	if (!message || typeof message !== "object") return {};
	return message as { usage?: { input?: number; cacheRead?: number; cost?: { total?: number } } };
}

test("finished turn: text + toolCall + toolResult become one linear assistant entry", () => {
	const fixture = makeFixture("Fix the parser bug");
	try {
		writeEvents(fixture, [
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Looking at the parser." },
						{ type: "toolCall", name: "read", input: { file_path: "src/parser.ts" } },
						{ type: "toolResult", name: "read", content: "source body", isError: false },
					],
					model: "fake-mini",
					stopReason: "end_turn",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			},
		]);

		const viewPath = buildAgentViewSessionFile({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId });
		assert.ok(viewPath, "view file path resolved");
		assert.equal(viewPath, fixture.viewFile);

		const records = readView(fixture);
		assert.equal(records.length, 3, "header + lead-in + one assistant entry");
		const header = records[0] as { type?: string; version?: number; id?: string; cwd?: string };
		assert.equal(header.type, "session");
		assert.equal(header.version, 3);
		assert.equal(header.id, `crew-view-${fixture.taskId}`);
		assert.equal(header.cwd, fixture.cwd);

		const leadIn = records[1]?.message as { role?: string; content?: Array<{ type: string; text: string }> };
		assert.equal(leadIn.role, "user");
		const leadText = leadIn.content?.[0]?.text ?? "";
		assert.ok(leadText.includes("executor agent"), `lead-in names the role: ${leadText}`);
		assert.ok(leadText.includes("Fix the parser bug"), "lead-in carries the goal");

		const entries = assistantEntries(records);
		assert.equal(entries.length, 1);
		const entry = entries[0];
		const content = (entry.message as { content?: Array<Record<string, unknown>> }).content ?? [];
		assert.equal(content.length, 3, "text + toolCall + toolResult kept");
		assert.equal(content[0]?.type, "text");
		const call = content[1] as { type?: unknown; id?: string; name?: string; input?: unknown };
		assert.equal(call.type, "toolCall");
		assert.equal(call.name, "read");
		assert.equal((call.input as { file_path?: string }).file_path, "src/parser.ts");
		const result = content[2] as { type?: unknown; id?: string; name?: string; content?: unknown; isError?: boolean };
		assert.equal(result.type, "toolResult");
		assert.equal(result.id, call.id, "result folds into the synthesized call id");
		assert.equal(result.name, "read");
		assert.equal(result.isError, false);
		const msg = entry.message as {
			model?: string;
			stopReason?: string;
			usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
		};
		assert.equal(msg.model, "fake-mini");
		assert.equal(msg.stopReason, "end_turn");
		assert.equal(msg.usage?.input, 10, "usage carried");
		assert.equal(msg.usage?.cost?.total, 0.001, "cost normalized into pi's {total} shape");
		assert.equal(entry.parentId, "crew-view-intro", "chain links back to the lead-in");
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

test("message → message_end dedups: final copy wins, no double entry", () => {
	const fixture = makeFixture("Dedup goal");
	try {
		writeEvents(fixture, [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "partial stream" }] } },
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "final answer" }] },
			},
			// A second, independent turn.
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "second turn" }] },
			},
		]);

		const viewPath = buildAgentViewSessionFile({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId });
		assert.ok(viewPath);
		const entries = assistantEntries(readView(fixture));
		assert.equal(entries.length, 2, "exactly one entry per assistant generation");
		const texts = entries
			.map((entry) => (entry.message as { content?: Array<{ type: string; text: string }> }).content?.[0]?.text ?? "")
			.join("|");
		assert.equal(texts, "final answer|second turn", "the message_end copy wins; stream copy dropped");
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

test("running agent: a message without message_end flushes as the latest entry", () => {
	const fixture = makeFixture("Running goal");
	try {
		writeEvents(fixture, [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "still working…" }] } }]);

		const viewPath = buildAgentViewSessionFile({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId });
		assert.ok(viewPath);
		const entries = assistantEntries(readView(fixture));
		assert.equal(entries.length, 1, "partial message still visible in the view");
		assert.equal(firstText(entries[0]), "still working…");
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

test("record-level usage tail (mock shape) attaches usage to the streamed copy", () => {
	const fixture = makeFixture("Mock usage tail goal");
	try {
		writeEvents(fixture, [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "mock streamed text" }] } },
			// The mock child-pi writes usage at the RECORD level, without a
			// nested message, and `cost` as a bare number.
			{ type: "message_end", usage: { input: 10, output: 5, cost: 0.001, turns: 1 } },
		]);

		const viewPath = buildAgentViewSessionFile({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId });
		assert.ok(viewPath);
		const entries = assistantEntries(readView(fixture));
		assert.equal(entries.length, 1, "one entry per turn despite the usage-only tail");
		assert.equal(firstText(entries[0]), "mock streamed text", "streamed content kept");
		const message = entryMessage(entries[0]);
		const usage = message.usage;
		assert.equal(usage?.input, 10);
		assert.equal(usage?.cost?.total, 0.001, "bare cost number normalized to {total}");
		assert.equal(usage?.cacheRead, 0, "cache fields default to 0 — pi's footer reads them unconditionally");
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

test("every assistant entry carries a zeroed pi-shaped usage (footer safety)", () => {
	const fixture = makeFixture("No usage goal");
	try {
		writeEvents(fixture, [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "plain" }] } },
			{ type: "message_end", usage: { input: 1, output: 1, cost: 0 } },
		]);
		const viewPath = buildAgentViewSessionFile({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId });
		assert.ok(viewPath);
		const entries = assistantEntries(readView(fixture));
		assert.equal(entries.length, 1);
		const usage = entryMessage(entries[0]).usage;
		assert.deepEqual(
			{ input: usage?.input, cacheRead: usage?.cacheRead, cost: usage?.cost?.total },
			{ input: 1, cacheRead: 0, cost: 0 },
			"normalized shape is always present",
		);
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

test("usage-only message_end reuses the pending stream copy", () => {
	const fixture = makeFixture("Usage tail goal");
	try {
		writeEvents(fixture, [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "held copy" }] } },
			{
				type: "message_end",
				message: { role: "assistant", content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
			},
		]);

		const viewPath = buildAgentViewSessionFile({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId });
		assert.ok(viewPath);
		const entries = assistantEntries(readView(fixture));
		assert.equal(entries.length, 1, "no duplicate from the usage-only tail");
		assert.equal(firstText(entries[0]), "held copy");
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

test("user messages and non-message records are skipped", () => {
	const fixture = makeFixture("Filter goal");
	try {
		writeEvents(fixture, [
			{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			{ type: "worker_status", text: "heartbeat" },
			{ type: "tool_execution_start", toolName: "bash" },
		]);

		const viewPath = buildAgentViewSessionFile({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId });
		assert.ok(viewPath);
		const records = readView(fixture);
		// header + lead-in + a placeholder assistant entry: the file must NEVER
		// end on the user lead-in (pi would auto-resume a real model turn).
		assert.equal(records.length, 3, "header + lead-in + placeholder");
		const last = records[2] as { message?: { role?: string; content?: Array<{ type: string; text: string }> } };
		assert.equal(last.message?.role, "assistant", "file ends on an assistant entry");
		const text = last.message?.content?.[0]?.text ?? "";
		assert.ok(text.includes("still starting"), `placeholder text hints at the empty snapshot: ${text}`);
		assert.equal(assistantEntries(records).length, 1, "placeholder counts once");
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

test("long goal is truncated in the lead-in", () => {
	const longGoal = "x".repeat(500);
	const fixture = makeFixture(longGoal);
	try {
		writeEvents(fixture, [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }]);
		const viewPath = buildAgentViewSessionFile({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId });
		assert.ok(viewPath);
		const leadIn = readView(fixture)[1]?.message as { content?: Array<{ type: string; text: string }> };
		const text = leadIn.content?.[0]?.text ?? "";
		assert.ok(text.length < 300, `lead-in is bounded, got ${text.length}`);
		assert.ok(text.endsWith("…"), "truncation marker added");
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

test("header carries parentSession when provided", () => {
	const fixture = makeFixture("Parent goal");
	try {
		writeEvents(fixture, [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }]);
		const viewPath = buildAgentViewSessionFile({
			cwd: fixture.cwd,
			runId: fixture.runId,
			taskId: fixture.taskId,
			parentSessionFile: "/tmp/main-session.jsonl",
		});
		assert.ok(viewPath);
		const header = readView(fixture)[0] as { parentSession?: string };
		assert.equal(header.parentSession, "/tmp/main-session.jsonl");
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

test("missing run or missing events file resolves to undefined (pane fallback)", () => {
	const cwd = createTrackedTempDir("pi-crew-aview-missing-");
	try {
		assert.equal(buildAgentViewSessionFile({ cwd, runId: "no_such_run", taskId: "task_1" }), undefined, "unknown run id → undefined");
		const created = createRunManifest({ cwd, team, workflow: singleStepWorkflow, goal: "no events" });
		assert.equal(
			buildAgentViewSessionFile({ cwd, runId: created.manifest.runId, taskId: created.tasks[0].id }),
			undefined,
			"task without an events.jsonl → undefined",
		);
	} finally {
		removeTrackedTempDir(cwd);
		__test__clearManifestCache();
	}
});

test("malformed JSON lines are skipped, not fatal", () => {
	const fixture = makeFixture("Corrupt goal");
	try {
		fs.appendFileSync(fixture.eventsFile, "not json\n", "utf-8");
		writeEvents(fixture, [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "survived" }] } }]);
		const viewPath = buildAgentViewSessionFile({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId });
		assert.ok(viewPath);
		const entries = assistantEntries(readView(fixture));
		assert.equal(entries.length, 1);
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

/**
 * A worker-session fixture: a fake worker pi session file under the pi-style
 * sessions root (`--<cwd-stem>--`), written at the task's start time.
 */
function writeWorkerSession(fixture: Fixture, opts: { startedAt?: string; text?: string; sessionRoot?: (cwd: string) => string }): string {
	const start = opts.startedAt ?? new Date().toISOString();
	const root = opts.sessionRoot?.(fixture.cwd) ?? path.join(path.dirname(fixture.cwd), "sessions-root");
	const stem = `--${fixture.cwd.replace(/^\/+/, "").replace(/[\\/]/g, "-")}--`;
	const dir = path.join(root, stem);
	fs.mkdirSync(dir, { recursive: true });
	const workerFile = path.join(dir, "worker-01.jsonl");
	const mtime = new Date(Date.parse(start) + 2_000);
	fs.writeFileSync(
		workerFile,
		[
			JSON.stringify({ type: "session", version: 3, id: "worker-session-01", timestamp: start, cwd: fixture.cwd }),
			JSON.stringify({
				type: "message",
				id: "w-1",
				parentId: null,
				timestamp: start,
				message: { role: "user", content: [{ type: "text", text: `<file name="task.md">\n${opts.text ?? "Do the thing"}` }] },
			}),
			JSON.stringify({
				type: "message",
				id: "w-2",
				parentId: "w-1",
				timestamp: start,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "worker result" }],
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}),
		].join("\n") + "\n",
		"utf-8",
	);
	fs.utimesSync(workerFile, mtime, mtime);
	return workerFile;
}

test("view copies the worker's own session file (real session, header gets parentSession)", () => {
	const fixture = makeFixture("Worker copy goal");
	try {
		writeEvents(fixture, [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ignored" }] } }]);
		const sessionRoot = path.join(path.dirname(fixture.cwd), "sessions-root");
		const workerFile = writeWorkerSession(fixture, { sessionRoot: () => sessionRoot, text: "Do the worker copy thing" });

		const viewPath = buildAgentViewSessionFile({
			cwd: fixture.cwd,
			runId: fixture.runId,
			taskId: fixture.taskId,
			parentSessionFile: "/tmp/main-session.jsonl",
			sessionRoot,
		});
		assert.ok(viewPath, "resolves");
		const records = readView(fixture);
		assert.equal(records.length, 3, "the worker's own entries, not the synthesized lead-in");
		assert.equal(records[0]?.id, "worker-session-01", "original session id preserved");
		assert.equal((records[0] as { parentSession?: string }).parentSession, "/tmp/main-session.jsonl", "parentSession injected");
		const ids = records.map((r) => String(r.id));
		assert.ok(!ids.includes("crew-view-intro"), "no synthesized lead-in on the copy path");
		const userText = ((records[1]?.message as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "") as string;
		assert.ok(userText.includes("Do the worker copy thing"), "worker's real task message copied verbatim");
		assert.equal((records[2]?.message as { role?: string } | undefined)?.role, "assistant", "worker assistant entry copied");
		// Byte-identical apart from the injected header: strip the first line
		// of both files and compare.
		const viewBody = fs.readFileSync(fixture.viewFile, "utf8").split("\n").slice(1).join("\n");
		const workerBody = fs.readFileSync(workerFile, "utf8").split("\n").slice(1).join("\n");
		assert.equal(viewBody, workerBody, "copy is byte-identical apart from the header");
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

test("worker session path wins over events synthesis; stamp reflects source growth", () => {
	const fixture = makeFixture("Stamp goal");
	try {
		const sessionRoot = path.join(path.dirname(fixture.cwd), "sessions-root");
		const workerFile = writeWorkerSession(fixture, { sessionRoot: () => sessionRoot });
		// Events exist too, but the worker session takes precedence.
		writeEvents(fixture, [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "events-only" }] } }]);

		const stamp1 = workerSessionSourceStamp({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId, sessionRoot });
		assert.ok(stamp1, "source stamp resolves");
		const viewPath = buildAgentViewSessionFile({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId, sessionRoot });
		assert.ok(viewPath);
		assert.ok(
			readView(fixture).some((r) => String(r.id) === "worker-session-01"),
			"worker session copied",
		);

		// The worker appends a new message — the stamp must move.
		const before = stamp1 as { mtimeMs: number; size: number };
		fs.appendFileSync(
			workerFile,
			JSON.stringify({
				type: "message",
				id: "w-3",
				parentId: "w-2",
				timestamp: new Date().toISOString(),
				message: { role: "assistant", content: [{ type: "text", text: "more work" }] },
			}) + "\n",
			"utf-8",
		);
		const stamp2 = workerSessionSourceStamp({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId, sessionRoot });
		assert.ok(stamp2 && stamp2.size > before.size, "stamp tracks appended content");
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

test("worker session not found → events synthesis fallback (no spurious copy)", () => {
	const fixture = makeFixture("Fallback goal");
	try {
		writeEvents(fixture, [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fallback text" }] } }]);
		const sessionRoot = path.join(path.dirname(fixture.cwd), "sessions-root");
		// The sessions dir exists but holds ONLY files outside the task window
		// (e.g. a stale session from a previous run) — must not match.
		const staleDir = path.join(sessionRoot, `--${fixture.cwd.replace(/^\/+/, "").replace(/[\\/]/g, "-")}--`);
		fs.mkdirSync(staleDir, { recursive: true });
		const stale = path.join(staleDir, "stale-00.jsonl");
		fs.writeFileSync(
			stale,
			JSON.stringify({ type: "session", version: 3, id: "stale", timestamp: "2020-01-01T00:00:00.000Z", cwd: fixture.cwd }) + "\n",
		);
		const old = new Date(Date.now() - 3 * 60 * 60_000);
		fs.utimesSync(stale, old, old);

		const viewPath = buildAgentViewSessionFile({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId, sessionRoot });
		assert.ok(viewPath);
		const records = readView(fixture);
		assert.equal(String(records[0]?.id), `crew-view-${fixture.taskId}`, "synthesis path (crew-* ids), not the stale file");
		assert.ok(assistantEntries(records).some((r) => firstText(r) === "fallback text"));
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

test("sequential overlap: the newest in-window session wins (previous worker's settle mtime inside the next task's window)", () => {
	const fixture = makeFixture("Overlap goal");
	try {
		// Create a session root with TWO worker sessions whose mtimes both fall
		// inside the task's recent window (worker A settled <1s before worker B
		// started). The newest must win deterministically.
		const sessionRoot = path.join(path.dirname(fixture.cwd), "sessions-root");
		const stamps = [new Date(Date.now() - 2_000), new Date(Date.now() - 1_000)];
		const dir = path.join(sessionRoot, `--${fixture.cwd.replace(/^\/+/, "").replace(/[\\/]/g, "-")}--`);
		fs.mkdirSync(dir, { recursive: true });
		stamps.forEach((mtime, i) => {
			const f = path.join(dir, `worker-${i}.jsonl`);
			fs.writeFileSync(
				f,
				[
					JSON.stringify({ type: "session", version: 3, id: `worker-${i}-id`, timestamp: mtime.toISOString(), cwd: fixture.cwd }),
					JSON.stringify({
						type: "message",
						id: `worker-${i}-m1`,
						parentId: null,
						timestamp: mtime.toISOString(),
						message: { role: "user", content: [{ type: "text", text: '<file name="task.md">\nshared goal' }] },
					}),
				].join("\n") + "\n",
				"utf-8",
			);
			fs.utimesSync(f, mtime, mtime);
		});

		const viewPath = buildAgentViewSessionFile({
			cwd: fixture.cwd,
			runId: fixture.runId,
			taskId: fixture.taskId,
			parentSessionFile: "/tmp/main-session.jsonl",
			sessionRoot,
		});
		assert.ok(viewPath);
		assert.equal(String(readView(fixture)[0]?.id), "worker-1-id", "newest in-window session chosen");
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});

test("rebuild preserves pi-appended entries (typed messages, thinking_level changes)", () => {
	const fixture = makeFixture("Live goal");
	try {
		writeEvents(fixture, [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first pass" }] } }]);
		const firstPath = buildAgentViewSessionFile({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId });
		assert.ok(firstPath);

		// pi appends REAL session entries to the open view file (a message the
		// user typed in the view + a thinking_level_change record).
		fs.appendFileSync(
			fixture.viewFile,
			[
				JSON.stringify({
					type: "message",
					id: "user-typed-1",
					parentId: "crew-ev-1",
					timestamp: "2026-08-21T10:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: "go deeper" }] },
				}),
				JSON.stringify({
					type: "thinking_level_change",
					id: "tl-abc123",
					parentId: "user-typed-1",
					timestamp: "2026-08-21T10:00:01.000Z",
					thinkingLevel: "high",
				}),
			].join("\n") + "\n",
			"utf-8",
		);

		// The agent produced more content; rebuild the view.
		writeEvents(fixture, [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second pass" }] } }]);
		const secondPath = buildAgentViewSessionFile({ cwd: fixture.cwd, runId: fixture.runId, taskId: fixture.taskId });
		assert.ok(secondPath);

		const records = readView(fixture);
		const ids = new Set(records.map((r) => String(r.id)).filter(Boolean));
		// New content present, synthesized ids deduped/rebuilt.
		assert.ok(ids.has("crew-ev-2"), "fresh events-derived entry present");
		assert.equal(records.filter((r) => r.id === "crew-ev-1").length, 1, "synthesized entries not duplicated");
		// pi-appended entries preserved exactly once.
		assert.ok(ids.has("user-typed-1"), "user-typed message survives the rebuild");
		assert.ok(ids.has("tl-abc123"), "thinking_level entry survives the rebuild");
		const texts = records.map((r) => firstText(r)).filter((text): text is string => Boolean(text));
		assert.ok(texts.includes("second pass"), "fresh content in rebuilt view");
		assert.ok(texts.includes("first pass"), "earlier content retained");
	} finally {
		removeTrackedTempDir(fixture.cwd);
	}
});
