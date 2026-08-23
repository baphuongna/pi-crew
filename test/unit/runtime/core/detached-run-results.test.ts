import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	clearDetachedRunsForTest,
	forgetDetachedRun,
	formatDetachedRunResult,
	hasDetachedRuns,
	markRunDetached,
	peekFinishedDetachedRunResults,
} from "../../../../src/runtime/detached-run-results.ts";
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

function fixture(): { cwd: string; runId: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "detached-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const created = createRunManifest({ cwd, team, workflow, goal: "detach goal" });
	saveRunManifest({ ...created.manifest, status: "running" as const });
	return { cwd, runId: created.manifest.runId };
}

test("a still-running detached run yields nothing (stays parked)", () => {
	const { cwd, runId } = fixture();
	try {
		markRunDetached(runId, cwd);
		assert.equal(hasDetachedRuns(), true);
		assert.deepEqual(peekFinishedDetachedRunResults(), []);
		assert.equal(hasDetachedRuns(), true, "still tracked until it finishes");
	} finally {
		clearDetachedRunsForTest();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("a finished detached run is handed over ONCE to its owning session", () => {
	const { cwd, runId } = fixture();
	try {
		markRunDetached(runId, cwd);
		const manifestPath = path.join(cwd, ".crew", "state", "runs", runId, "manifest.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
		fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, status: "completed" }), "utf-8");

		const first = peekFinishedDetachedRunResults();
		assert.equal(first.length, 1);
		assert.equal(first[0].runId, runId);
		assert.match(first[0].text, /pi-crew run completed/);
		assert.match(first[0].text, /detached when you opened an agent view/);
		// peek does NOT drop the entry — a failed send must be retryable.
		assert.equal(peekFinishedDetachedRunResults().length, 1);
		// The caller drops it only after a successful delivery.
		forgetDetachedRun(runId);
		assert.deepEqual(peekFinishedDetachedRunResults(), []);
		assert.equal(hasDetachedRuns(), false);
	} finally {
		clearDetachedRunsForTest();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("a finished run stays parked while a DIFFERENT session is current (never lands in a view)", () => {
	const { cwd, runId } = fixture();
	try {
		markRunDetached(runId, cwd);
		const manifestPath = path.join(cwd, ".crew", "state", "runs", runId, "manifest.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
		fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, status: "completed" }), "utf-8");

		assert.deepEqual(peekFinishedDetachedRunResults({ inViewSession: true }), [], "parked for the view session");
		assert.equal(hasDetachedRuns(), true);
		assert.equal(peekFinishedDetachedRunResults().length, 1, "delivered after returning to main");
	} finally {
		clearDetachedRunsForTest();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("a detached run whose state was deleted is dropped without a result", () => {
	const { cwd, runId } = fixture();
	try {
		markRunDetached(runId, cwd);
		fs.rmSync(path.join(cwd, ".crew", "state", "runs", runId), { recursive: true, force: true });
		assert.deepEqual(peekFinishedDetachedRunResults(), []);
		assert.equal(hasDetachedRuns(), false);
	} finally {
		clearDetachedRunsForTest();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("formatDetachedRunResult lists per-task status and roots", () => {
	const { cwd, runId } = fixture();
	try {
		const manifestPath = path.join(cwd, ".crew", "state", "runs", runId, "manifest.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Parameters<typeof formatDetachedRunResult>[0];
		const text = formatDetachedRunResult({ ...manifest, status: "failed" }, [
			{ id: "01_plan", role: "planner", status: "failed", error: "boom" } as never,
		]);
		assert.match(text, /pi-crew run failed/);
		assert.match(text, /01_plan \(planner\): failed — boom/);
		assert.match(text, /State: /);
	} finally {
		clearDetachedRunsForTest();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
