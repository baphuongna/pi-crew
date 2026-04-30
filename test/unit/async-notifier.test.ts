import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { markDeadAsyncRunIfNeeded, startAsyncRunNotifier, stopAsyncRunNotifier, type AsyncNotifierState } from "../../src/extension/async-notifier.ts";
import { appendEvent, readEvents } from "../../src/state/event-log.ts";
import { createRunManifest, saveRunManifest } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("async notifier reports pre-existing active runs that finish after notifier start", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-existing-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const notifications: Array<{ text: string; level?: string }> = [];
	const state: AsyncNotifierState = { seenFinishedRunIds: new Set() };
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "pre-existing" });
		saveRunManifest({ ...created.manifest, status: "running" });
		startAsyncRunNotifier({ cwd, ui: { notify: (text: string, level?: string) => notifications.push({ text, level }) } } as never, state, 10);
		saveRunManifest({ ...created.manifest, status: "failed", summary: "finished after notifier start", updatedAt: new Date().toISOString() });
		await wait(40);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.text, /failed/);
	} finally {
		stopAsyncRunNotifier(state);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/* Regression: auto-compaction can stop/restart the extension while an async run
 * is still active. The restarted notifier must not mark that active run as
 * already consumed, otherwise the completion follow-up is lost. */
test("async notifier reports run completed across session restart", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-restart-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const notifications: Array<{ text: string; level?: string }> = [];
	const state: AsyncNotifierState = { seenFinishedRunIds: new Set() };
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "compaction restart" });
		saveRunManifest({ ...created.manifest, status: "running" });
		startAsyncRunNotifier({ cwd, ui: { notify: (text: string, level?: string) => notifications.push({ text, level }) } } as never, state, 10);
		stopAsyncRunNotifier(state);
		saveRunManifest({ ...created.manifest, status: "completed", updatedAt: new Date().toISOString() });
		startAsyncRunNotifier({ cwd, ui: { notify: (text: string, level?: string) => notifications.push({ text, level }) } } as never, state, 10);
		await wait(40);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.text, /completed/);
	} finally {
		stopAsyncRunNotifier(state);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("async notifier marks quiet dead background runner as failed", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-dead-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "dead async" });
		const oldTime = new Date(Date.now() - 60_000).toISOString();
		const manifest = { ...created.manifest, status: "running" as const, updatedAt: oldTime, async: { pid: 999_999_999, logPath: path.join(created.manifest.stateRoot, "background.log"), spawnedAt: oldTime } };
		saveRunManifest(manifest);
		appendEvent(manifest.eventsPath, { type: "async.started", runId: manifest.runId, data: { pid: manifest.async.pid } });
		const marked = markDeadAsyncRunIfNeeded(manifest, Date.now() + 60_000, 30_000);
		assert.ok(marked);
		assert.equal(marked.status, "failed");
		assert.equal(readEvents(marked.eventsPath).some((event) => event.type === "async.died"), true);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("async notifier suppresses notifications after generation becomes stale", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-stale-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const notifications: Array<{ text: string; level?: string }> = [];
	const state: AsyncNotifierState = { seenFinishedRunIds: new Set() };
	let currentGeneration = 1;
	try {
		startAsyncRunNotifier({ cwd, ui: { notify: (text: string, level?: string) => notifications.push({ text, level }) } } as never, state, 10, { generation: 1, isCurrent: (generation) => generation === currentGeneration });
		currentGeneration = 2;
		const created = createRunManifest({ cwd, team, workflow, goal: "stale run" });
		saveRunManifest({ ...created.manifest, status: "completed" });
		await wait(40);
		assert.equal(notifications.length, 0);
	} finally {
		stopAsyncRunNotifier(state);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("async notifier still reports runs created after notifier start", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-new-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const notifications: Array<{ text: string; level?: string }> = [];
	const state: AsyncNotifierState = { seenFinishedRunIds: new Set() };
	try {
		startAsyncRunNotifier({ cwd, ui: { notify: (text: string, level?: string) => notifications.push({ text, level }) } } as never, state, 10);
		const created = createRunManifest({ cwd, team, workflow, goal: "new run" });
		saveRunManifest({ ...created.manifest, status: "completed" });
		await wait(40);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.text, /completed/);
		assert.equal(notifications[0]!.level, "info");
	} finally {
		stopAsyncRunNotifier(state);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});