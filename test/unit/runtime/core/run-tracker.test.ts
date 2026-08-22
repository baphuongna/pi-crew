import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	clearRunPromisesForTest,
	detachRunPromise,
	hasActiveRunPromise,
	hasPendingRunDetach,
	registerRunPromise,
	rejectRunPromise,
	resolveRunPromise,
	waitForRun,
} from "../../../../src/runtime/run-tracker.ts";
import { createRunManifest, saveRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

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

test("waitForRun returns immediately for a terminal manifest on disk", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "test",
		});
		const completed = {
			...created.manifest,
			status: "completed" as const,
			updatedAt: new Date().toISOString(),
		};
		saveRunManifest(completed);
		const result = await waitForRun(created.manifest.runId, cwd, {
			timeoutMs: 1000,
		});
		assert.equal(result.manifest.status, "completed");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("detachRunPromise releases the foreground waiter while the run is still running", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "test" });
		const running = {
			...created.manifest,
			status: "running" as const,
			updatedAt: new Date().toISOString(),
		};
		saveRunManifest(running);

		registerRunPromise(created.manifest.runId);
		setTimeout(() => {
			assert.equal(detachRunPromise(created.manifest.runId, cwd), true);
		}, 50);

		const result = await waitForRun(created.manifest.runId, cwd, { timeoutMs: 5000 });
		assert.equal(result.detached, true);
		assert.equal(result.manifest.status, "running");
		// Waiter is gone, so the run's own later completion is a no-op.
		assert.equal(hasActiveRunPromise(created.manifest.runId), false);
		// A second detach has no waiter left — it only records a request.
		assert.equal(detachRunPromise(created.manifest.runId, cwd), true);
		assert.equal(hasPendingRunDetach(created.manifest.runId), true);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		clearRunPromisesForTest();
	}
});

test("detach releases a POLLING waiter (promise not registered yet)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "test" });
		saveRunManifest({ ...created.manifest, status: "running" as const });
		// No registerRunPromise: this is the race where the tool starts waiting
		// before executeTeamRun registers its foreground promise.
		const waiting = waitForRun(created.manifest.runId, cwd, { timeoutMs: 5000 });
		await wait(50);
		assert.equal(detachRunPromise(created.manifest.runId, cwd), true);
		const result = await waiting;
		assert.equal(result.detached, true);
		assert.equal(result.manifest.status, "running");
		// Request was consumed — a later waiter is unaffected.
		assert.equal(hasPendingRunDetach(created.manifest.runId), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		clearRunPromisesForTest();
	}
});

test("detach requested before the waiter starts still releases it", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "test" });
		saveRunManifest({ ...created.manifest, status: "running" as const });
		assert.equal(detachRunPromise(created.manifest.runId, cwd), true);
		assert.equal(hasPendingRunDetach(created.manifest.runId), true);
		const result = await waitForRun(created.manifest.runId, cwd, { timeoutMs: 5000 });
		assert.equal(result.detached, true);
		assert.equal(hasPendingRunDetach(created.manifest.runId), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		clearRunPromisesForTest();
	}
});

test("detachRunPromise returns false when the run state cannot be read", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		assert.equal(detachRunPromise("team_does_not_exist", cwd), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		clearRunPromisesForTest();
	}
});

test("waitForRun awaits a foreground promise and resolves when run completes", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "test",
		});
		const running = {
			...created.manifest,
			status: "running" as const,
			updatedAt: new Date().toISOString(),
		};
		saveRunManifest(running);

		registerRunPromise(created.manifest.runId);
		assert.equal(hasActiveRunPromise(created.manifest.runId), true);

		setTimeout(() => {
			resolveRunPromise(created.manifest.runId, {
				manifest: { ...running, status: "completed" },
				tasks: [],
			});
		}, 100);

		const result = await waitForRun(created.manifest.runId, cwd, {
			timeoutMs: 5000,
		});
		assert.equal(result.manifest.status, "completed");
		assert.equal(hasActiveRunPromise(created.manifest.runId), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		clearRunPromisesForTest();
	}
});

test("waitForRun rejects when run promise is rejected", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "test",
		});
		const running = {
			...created.manifest,
			status: "running" as const,
			updatedAt: new Date().toISOString(),
		};
		saveRunManifest(running);

		registerRunPromise(created.manifest.runId);

		setTimeout(() => {
			rejectRunPromise(created.manifest.runId, new Error("Simulated run failure"));
		}, 50);

		await assert.rejects(
			async () =>
				await waitForRun(created.manifest.runId, cwd, {
					timeoutMs: 5000,
				}),
			(error) => (error as Error).message === "Simulated run failure",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		clearRunPromisesForTest();
	}
});

test("waitForRun times out if run never finishes and no promise is registered", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "test",
		});
		const running = {
			...created.manifest,
			status: "running" as const,
			updatedAt: new Date().toISOString(),
		};
		saveRunManifest(running);

		await assert.rejects(
			async () =>
				await waitForRun(created.manifest.runId, cwd, {
					timeoutMs: 300,
				}),
			(error) => (error as Error).message.includes("timed out"),
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		clearRunPromisesForTest();
	}
});
