import assert from "node:assert/strict";
import test from "node:test";
import { convertRunHistoryToWorkerPrompt, transformRunContextBeforeWorkerStart } from "../../src/runtime/task-runner/run-projection.ts";

function makeManifest() {
	return {
		runId: "test-run",
		cwd: "/tmp",
		team: "test",
		workflow: "default",
		goal: "test",
		status: "running",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		stateRoot: "/tmp/.crew/state/runs/test-run",
		artifactsRoot: "/tmp/.crew/artifacts/test-run",
		ownerSessionId: "s1",
		eventsPath: "/tmp/.crew/state/runs/test-run/events.jsonl",
	} as const;
}

test("transformRunContextBeforeWorkerStart returns empty projection when no history", () => {
	const result = transformRunContextBeforeWorkerStart({
		manifest: makeManifest() as never,
		tasks: [],
		pendingMailbox: [],
		artifacts: [],
	});
	assert.equal(result.sources.length, 2); // ui_metadata + runtime_metadata
	assert.equal(result.injectedAsContext, true);
	assert.equal(result.summary, "");
});

test("transformRunContextBeforeWorkerStart projects completed tasks", () => {
	const result = transformRunContextBeforeWorkerStart({
		manifest: makeManifest() as never,
		tasks: [
			{
				id: "01_explore",
				role: "explorer",
				agent: "explorer",
				title: "explore",
				status: "completed",
				dependsOn: [],
				cwd: "/tmp",
				runId: "test-run",
			} as never,
			{
				id: "02_execute",
				role: "executor",
				agent: "executor",
				title: "execute",
				status: "failed",
				error: "timeout",
				dependsOn: [],
				cwd: "/tmp",
				runId: "test-run",
			} as never,
		],
		pendingMailbox: [],
		artifacts: [],
	});
	assert.ok(result.summary.includes("01_explore: completed"));
	assert.ok(result.summary.includes("02_execute: failed (timeout)"));
	const eventSource = result.sources.find((s) => s.kind === "events");
	assert.ok(eventSource);
	assert.equal(eventSource.bounded, true);
});

test("transformRunContextBeforeWorkerStart projects mailbox messages", () => {
	const result = transformRunContextBeforeWorkerStart({
		manifest: makeManifest() as never,
		tasks: [],
		pendingMailbox: [
			{
				id: "msg-1",
				runId: "test-run",
				direction: "inbox",
				from: "leader",
				to: "01_explore",
				body: "Please check the results",
				createdAt: new Date().toISOString(),
				status: "queued",
				kind: "follow-up",
			} as never,
		],
		artifacts: [],
	});
	assert.ok(
		result.summary.includes("follow-up: <untrusted_data source=\"mailbox\">Please check the results</untrusted_data>"),
		"mailbox body must be wrapped in <untrusted_data source=\"mailbox\"> demarcation (VULN-3)",
	);
	assert.ok(result.summary.includes("Pending messages"));
});

test("transformRunContextBeforeWorkerStart projects artifacts", () => {
	const result = transformRunContextBeforeWorkerStart({
		manifest: makeManifest() as never,
		tasks: [],
		pendingMailbox: [],
		artifacts: [
			{
				kind: "result",
				path: "/tmp/artifacts/results/01_explore.txt",
				createdAt: new Date().toISOString(),
				producer: "worker",
				retention: "run",
			} as never,
		],
	});
	assert.ok(result.summary.includes("Available artifacts"));
});

test("convertRunHistoryToWorkerPrompt returns empty string when no history", () => {
	const text = convertRunHistoryToWorkerPrompt({
		manifest: makeManifest() as never,
		tasks: [],
		pendingMailbox: [],
		artifacts: [],
	});
	assert.equal(text, "");
});

test("convertRunHistoryToWorkerPrompt returns bounded projection header", () => {
	const text = convertRunHistoryToWorkerPrompt({
		manifest: makeManifest() as never,
		tasks: [
			{
				id: "01_explore",
				role: "explorer",
				agent: "explorer",
				title: "explore",
				status: "completed",
				dependsOn: [],
				cwd: "/tmp",
				runId: "test-run",
			} as never,
		],
		pendingMailbox: [],
		artifacts: [],
	});
	assert.ok(text.startsWith("## Run Context (bounded projection)"));
	assert.ok(text.includes("01_explore: completed"));
	assert.ok(text.includes("Projection sources:"));
});
