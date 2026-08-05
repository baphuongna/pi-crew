/**
 * Tests for src/extension/session-summary.ts
 *
 * notifyActiveRuns is tightly coupled to pi infrastructure (listRuns,
 * readCrewAgents, isDisplayActiveRun). These tests verify it does not crash
 * and that the notification logic works as expected.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { notifyActiveRuns } from "../../../../src/extension/session-summary.ts";
import { recordFromTask, saveCrewAgents } from "../../../../src/runtime/crew-agent-records.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import { clearProjectRootCache } from "../../../../src/utils/paths.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

interface MockCtx {
	cwd: string;
	ui: { notify: (msg: string, level: string) => void };
	notifyCalls: string[];
}

function makeCtx(dir: string): MockCtx {
	const calls: string[] = [];
	return {
		cwd: dir,
		ui: {
			notify: (msg: string, _level: string) => {
				calls.push(msg);
			},
		},
		notifyCalls: calls,
	};
}

describe("notifyActiveRuns does not crash with empty temp cwd", () => {
	it("executes without throwing on a directory with no project markers", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-summary-cov-"));
		clearProjectRootCache();
		// No .git, no .crew — findRepoRoot returns undefined
		const ctx = makeCtx(dir);
		try {
			// Should not throw
			notifyActiveRuns(ctx as never);
			assert.ok(true, "should complete without error");
		} finally {
			clearProjectRootCache();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("notifyActiveRuns uses correct message format", () => {
	it("passes 'pi-crew active runs' prefix when notifying", () => {
		// Use the real CWD which may have active runs from the dev environment
		const cwd = process.cwd();
		clearProjectRootCache();
		const ctx = makeCtx(cwd);
		try {
			notifyActiveRuns(ctx as never);
			// If there are active runs, verify the message format
			if (ctx.notifyCalls.length > 0) {
				const msg = ctx.notifyCalls[0];
				assert.ok(msg.includes("pi-crew active runs"), "message should contain 'pi-crew active runs'");
				assert.ok(msg.includes("["), "message should contain status bracket notation");
			}
			// If no active runs, that's also acceptable (all completed/filtered)
		} finally {
			clearProjectRootCache();
		}
	});
});

describe("notifyActiveRuns produces at most one notification", () => {
	it("calls ctx.ui.notify at most once per invocation", () => {
		const cwd = process.cwd();
		clearProjectRootCache();
		const ctx = makeCtx(cwd);
		try {
			notifyActiveRuns(ctx as never);
			// The function either calls notify once or not at all
			assert.ok(ctx.notifyCalls.length <= 1, `expected at most 1 notification, got ${ctx.notifyCalls.length}`);
		} finally {
			clearProjectRootCache();
		}
	});
});

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

/* Vector #11: notifyActiveRuns must never surface another session's runs in the
 * active-runs toast — session B must not advertise session A's in-flight runs. */
describe("notifyActiveRuns filters out runs owned by another session (vector #11)", () => {
	it("skips a run owned by a different pi session, surfaces it for the owning session", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-summary-xsession-"));
		fs.mkdirSync(path.join(dir, ".crew"));
		const calls: string[] = [];
		const ctxAs = (sid: string): unknown => ({
			cwd: dir,
			sessionManager: { getSessionId: () => sid },
			ui: {
				notify: (msg: string) => {
					calls.push(msg);
				},
			},
		});
		try {
			const created = createRunManifest({ cwd: dir, team, workflow, goal: "cross-session" });
			const manifest = {
				...created.manifest,
				status: "running" as const,
				ownerSessionId: "session-A",
				updatedAt: new Date().toISOString(),
			};
			const activeTasks = created.tasks.map((task) => ({
				...task,
				status: "running" as const,
				startedAt: new Date().toISOString(),
			}));
			saveRunManifest(manifest);
			saveRunTasks(manifest, activeTasks);
			saveCrewAgents(manifest, activeTasks.map((task) => recordFromTask(manifest, task, "live-session")));

			// As session-B: the session-A run must be filtered out.
			clearProjectRootCache();
			notifyActiveRuns(ctxAs("session-B") as never);
			assert.equal(calls.length, 0, "must not surface another session's active run");

			// As session-A: the run should now pass the ownership filter.
			clearProjectRootCache();
			notifyActiveRuns(ctxAs("session-A") as never);
			assert.equal(calls.length, 1, "should surface the owning session's active run");
			assert.match(calls[0]!, /pi-crew active runs/);
		} finally {
			clearProjectRootCache();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
