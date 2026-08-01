import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildContinuationPrompt, triggerContinuation } from "../../src/extension/registration/compaction-guard.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

function makeRun(overrides: Partial<TeamRunManifest> = {}): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run-abc-123",
		team: "default",
		workflow: "default",
		goal: "Build a login feature",
		status: "running",
		workspaceMode: "single",
		createdAt: "2026-06-15T00:00:00.000Z",
		updatedAt: "2026-06-15T00:01:00.000Z",
		cwd: "/tmp",
		stateRoot: "/tmp/.crew/state/runs/run-abc-123",
		artifactsRoot: "/tmp/.crew/artifacts/run-abc-123",
		tasksPath: "/tmp/tasks.json",
		eventsPath: "/tmp/events.jsonl",
		artifacts: [],
		...overrides,
	} as TeamRunManifest;
}

describe("buildContinuationPrompt", () => {
	it("returns empty string for no in-flight runs", () => {
		assert.equal(buildContinuationPrompt([]), "");
	});

	it("includes the continuation instruction and runId", () => {
		const prompt = buildContinuationPrompt([makeRun()]);
		assert.ok(prompt.includes("[pi-crew]"), "should have pi-crew tag");
		assert.ok(prompt.includes("do not wait for me"), "should tell agent to continue without waiting");
		assert.ok(prompt.includes("run-abc-123"), "should include runId");
		assert.ok(prompt.includes("Build a login feature"), "should include goal");
		assert.ok(prompt.includes("action='status'"), "should give resume instructions");
	});

	it("lists multiple in-flight runs", () => {
		const prompt = buildContinuationPrompt([makeRun({ runId: "run-a", goal: "Task A" }), makeRun({ runId: "run-b", goal: "Task B" })]);
		assert.ok(prompt.includes("run-a"));
		assert.ok(prompt.includes("run-b"));
		assert.ok(prompt.includes("Task A"));
		assert.ok(prompt.includes("Task B"));
	});
});

describe("triggerContinuation", () => {
	it("calls pi.sendUserMessage with the continuation prompt", () => {
		let sentContent: unknown;
		const fakePi = {
			sendUserMessage: (content: string) => {
				sentContent = content;
				return Promise.resolve();
			},
		};
		const fakeCtx = { ui: { notify: () => undefined } };

		triggerContinuation(fakePi as never, fakeCtx as never, [makeRun()]);

		assert.equal(typeof sentContent, "string");
		const content = sentContent as string;
		assert.ok(content.includes("run-abc-123"));
		assert.ok(content.includes("do not wait for me"));
	});

	it("does nothing when no in-flight runs", () => {
		let called = false;
		const fakePi = {
			sendUserMessage: () => {
				called = true;
				return Promise.resolve();
			},
		};
		const fakeCtx = { ui: { notify: () => undefined } };

		triggerContinuation(fakePi as never, fakeCtx as never, []);

		assert.equal(called, false);
	});

	it("notifies on error instead of crashing", async () => {
		let notifyCalled = false;
		let notifyMsg = "";
		// sendUserMessage returns a rejected promise
		const fakePi = {
			sendUserMessage: () => Promise.reject(new Error("agent busy")),
		};
		const fakeCtx = {
			ui: {
				notify: (msg: string, _level: string) => {
					notifyCalled = true;
					notifyMsg = msg;
				},
			},
		};

		triggerContinuation(fakePi as never, fakeCtx as never, [makeRun()]);

		// Wait for the promise rejection to be caught
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(notifyCalled, true);
		assert.ok(notifyMsg.includes("failed"));
	});
});
