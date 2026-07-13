import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { ChildPiLineObserver } from "../../src/runtime/child-pi.ts";
import { deliverGroupJoin, resolveGroupJoinMode, shouldGroupJoin } from "../../src/runtime/group-join.ts";
import { parseSessionUsageFromJsonlText } from "../../src/runtime/session-usage.ts";
import { readMailbox } from "../../src/state/mailbox.ts";
import { createRunManifest } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "phase4",
	description: "phase4",
	source: "builtin",
	filePath: "phase4.team.md",
	roles: [
		{ name: "explorer", agent: "explorer" },
		{ name: "planner", agent: "planner" },
	],
};

const workflow: WorkflowConfig = {
	name: "phase4",
	description: "phase4",
	source: "builtin",
	filePath: "phase4.workflow.md",
	steps: [
		{ id: "explore", role: "explorer", task: "Explore" },
		{ id: "plan", role: "planner", task: "Plan" },
	],
};

test("child Pi line observer preserves JSON events split across chunks", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-line-observer-"));
	try {
		const transcriptPath = path.join(dir, "transcript.jsonl");
		const events: unknown[] = [];
		const lines: string[] = [];
		const observer = new ChildPiLineObserver({
			cwd: dir,
			task: "task",
			agent: {
				name: "mock",
				description: "mock",
				source: "builtin",
				filePath: "mock.md",
				systemPrompt: "mock",
			},
			transcriptPath,
			onStdoutLine: (line) => lines.push(line),
			onJsonEvent: (event) => events.push(event),
		});
		observer.observe('{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hel');
		observer.observe('lo"}]}}\nraw');
		// OPT-06 follow-up: flush() is now async and drains the module-scoped
		// pending-write set before resolving. Without `await`, the post-flush
		// fs.readFileSync sees an empty file because the async file handle
		// had not yet been opened.
		await observer.flush();
		assert.equal(events.length, 1);
		assert.deepEqual(lines, ["hello", "raw"]);
		assert.match(fs.readFileSync(transcriptPath, "utf-8"), /hello/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("child Pi line observer does not mirror user prompts into output log", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-line-observer-user-"));
	try {
		const transcriptPath = path.join(dir, "transcript.jsonl");
		const lines: string[] = [];
		const events: unknown[] = [];
		const observer = new ChildPiLineObserver({
			cwd: dir,
			task: "task",
			agent: {
				name: "mock",
				description: "mock",
				source: "builtin",
				filePath: "mock.md",
				systemPrompt: "mock",
			},
			transcriptPath,
			onStdoutLine: (line) => lines.push(line),
			onJsonEvent: (event) => events.push(event),
		});
		observer.observe(
			`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "task prompt" }] } })}\n`,
		);
		observer.observe(
			`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } })}\n`,
		);
		// OPT-06 follow-up: await flush so the transcript file exists on disk
		// before the post-flush fs.readFileSync below.
		await observer.flush();
		assert.deepEqual(lines, ["answer"]);
		assert.equal(events.length, 1);
		assert.doesNotMatch(fs.readFileSync(transcriptPath, "utf-8"), /task prompt/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("child Pi line observer drops noisy message updates from durable logs", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-line-observer-noise-"));
	try {
		const transcriptPath = path.join(dir, "transcript.jsonl");
		const events: unknown[] = [];
		const lines: string[] = [];
		const observer = new ChildPiLineObserver({
			cwd: dir,
			task: "task",
			agent: {
				name: "mock",
				description: "mock",
				source: "builtin",
				filePath: "mock.md",
				systemPrompt: "mock",
			},
			transcriptPath,
			onStdoutLine: (line) => lines.push(line),
			onJsonEvent: (event) => events.push(event),
		});
		observer.observe(
			`${JSON.stringify({ type: "message_update", message: { content: [{ type: "thinking", thinkingSignature: "x".repeat(10_000) }] } })}\n`,
		);
		observer.observe(
			`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
		);
		// OPT-06 follow-up: await flush so the transcript file is durable on disk
		// before the post-flush fs.readFileSync below reads it.
		await observer.flush();
		assert.equal(events.length, 1);
		assert.equal(lines.length, 1);
		const transcript = fs.readFileSync(transcriptPath, "utf-8");
		assert.doesNotMatch(transcript, /thinkingSignature/);
		assert.match(transcript, /done/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("session usage parser sums JSONL token usage and ignores corrupt lines", () => {
	const usage = parseSessionUsageFromJsonlText(
		[
			JSON.stringify({
				usage: { inputTokens: 10, outputTokens: 5, turns: 1 },
			}),
			"not-json",
			JSON.stringify({
				message: {
					usage: {
						input: 2,
						output: 3,
						cacheRead: 4,
						cacheWrite: 1,
						cost: 0.25,
					},
				},
			}),
		].join("\n"),
	);
	assert.deepEqual(usage, {
		input: 12,
		output: 8,
		turns: 1,
		cacheRead: 4,
		cacheWrite: 1,
		cost: 0.25,
	});
});

test("group join writes metadata artifact, event, and mailbox delivery", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-group-join-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest, tasks } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "phase4",
		});
		const completed = tasks.map((task) => ({
			...task,
			status: "completed" as const,
			finishedAt: new Date().toISOString(),
		}));
		assert.equal(resolveGroupJoinMode({ groupJoin: "smart" }), "smart");
		assert.equal(shouldGroupJoin("smart", completed), true);
		const delivery = deliverGroupJoin({
			manifest,
			mode: "smart",
			batch: tasks,
			allTasks: completed,
		});
		assert.ok(delivery?.artifact);
		assert.deepEqual(delivery.completed.sort(), completed.map((task) => task.id).sort());
		assert.match(fs.readFileSync(delivery.artifact.path, "utf-8"), /"partial": false/);
		const mailbox = readMailbox(manifest, "outbox");
		assert.equal(mailbox.length, 1);
		assert.match(mailbox[0]!.body, /Group join completed/);
		assert.equal(mailbox[0]!.data?.kind, "group_join");
		assert.equal(mailbox[0]!.data?.requestId, delivery.requestId);
		const reused = deliverGroupJoin({
			manifest,
			mode: "smart",
			batch: tasks,
			allTasks: completed,
		});
		assert.equal(reused?.messageId, delivery.messageId);
		assert.equal(readMailbox(manifest, "outbox").length, 1);
		assert.match(fs.readFileSync(manifest.eventsPath, "utf-8"), /agent\.group_join\.completed/);
		assert.match(fs.readFileSync(manifest.eventsPath, "utf-8"), /agent\.group_join\.delivery_reused/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("group join mailbox ack emits acknowledged event", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-group-join-ack-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest, tasks } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "phase4 ack",
		});
		const completed = tasks.map((task) => ({
			...task,
			status: "completed" as const,
			finishedAt: new Date().toISOString(),
		}));
		const delivery = deliverGroupJoin({
			manifest,
			mode: "smart",
			batch: tasks,
			allTasks: completed,
		});
		assert.ok(delivery?.messageId);
		const pendingStatus = await handleTeamTool(
			{
				action: "status",
				runId: manifest.runId,
				config: { runtime: { groupJoinAckTimeoutMs: 1 } },
			},
			{ cwd },
		);
		assert.equal(pendingStatus.isError, false);
		const pendingText = pendingStatus.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		assert.match(pendingText, /Group joins:/);
		const ack = await handleTeamTool(
			{
				action: "api",
				runId: manifest.runId,
				config: {
					operation: "ack-message",
					messageId: delivery.messageId,
				},
			},
			{ cwd },
		);
		assert.equal(ack.isError, false);
		const acknowledgedStatus = await handleTeamTool({ action: "status", runId: manifest.runId }, { cwd });
		const acknowledgedText = acknowledgedStatus.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		assert.match(acknowledgedText, /ack=acknowledged/);
		assert.match(fs.readFileSync(manifest.eventsPath, "utf-8"), /agent\.group_join\.acknowledged/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
