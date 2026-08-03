/**
 * Unit tests for GoalStore.compareAndSetStatus (P1b, RFC v0.5 §P1b).
 *
 * The CAS guard makes stuck↔resume transitions atomic so a racing `goal
 * resume` / idle-sweeper / background-loop cannot lose updates.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { GoalStore } from "../../src/runtime/goal-workflow/goal-state-store.ts";
import type { GoalLoopState } from "../../src/state/types.ts";
import { clearProjectRootCache } from "../../src/utils/paths.ts";

function makeTmpCwd(): string {
	clearProjectRootCache();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-goal-cas-"));
	fs.mkdirSync(path.join(cwd, ".crew", "state", "goals"), {
		recursive: true,
	});
	return cwd;
}

function sampleGoal(cwd: string, goalId: string, state: GoalLoopState["state"] = "running"): GoalLoopState {
	const now = new Date().toISOString();
	return {
		goalId,
		ownerSessionId: "test-session",
		objective: "Make all tests pass",
		state,
		maxTurns: 3,
		turnsUsed: 0,
		budgetUsed: 0,
		evaluatorModel: "stub",
		cwd,
		verdicts: [],
		history: [],
		createdAt: now,
		updatedAt: now,
	};
}

describe("GoalStore.compareAndSetStatus", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()!();
	});

	it("succeeds and persists when current state matches expected (running→stuck)", () => {
		const cwd = makeTmpCwd();
		cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const store = new GoalStore(cwd);
		const id = store.createGoalId();
		store.save(sampleGoal(cwd, id, "running"));

		const result = store.compareAndSetStatus(id, "running", "stuck");
		assert.ok(result, "CAS should succeed when expected matches");
		assert.equal(result!.state, "stuck");
		assert.equal(store.load(id)?.state, "stuck", "persisted state must be updated");
	});

	it("succeeds for stuck→running (resume transition)", () => {
		const cwd = makeTmpCwd();
		cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const store = new GoalStore(cwd);
		const id = store.createGoalId();
		store.save(sampleGoal(cwd, id, "stuck"));

		const result = store.compareAndSetStatus(id, "stuck", "running");
		assert.ok(result);
		assert.equal(result!.state, "running");
		assert.equal(store.load(id)?.state, "running");
	});

	it("fails (returns undefined) and does NOT mutate when expected mismatches", () => {
		const cwd = makeTmpCwd();
		cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const store = new GoalStore(cwd);
		const id = store.createGoalId();
		store.save(sampleGoal(cwd, id, "running"));

		// Expecting 'stuck' but actual is 'running' → CAS must fail.
		const result = store.compareAndSetStatus(id, "stuck", "cancelled");
		assert.equal(result, undefined, "CAS must return undefined on mismatch");
		assert.equal(store.load(id)?.state, "running", "state must be UNCHANGED on CAS failure (no partial mutation)");
	});

	it("returns undefined for an unknown goalId", () => {
		const cwd = makeTmpCwd();
		cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const store = new GoalStore(cwd);
		const result = store.compareAndSetStatus("goal_missing_xyz", "running", "stuck");
		assert.equal(result, undefined);
	});

	it("emits a goal.state_changed event when an eventsPath is supplied", () => {
		const cwd = makeTmpCwd();
		cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const store = new GoalStore(cwd);
		const id = store.createGoalId();
		store.save(sampleGoal(cwd, id, "running"));

		const eventsPath = path.join(cwd, ".crew", "state", "events.jsonl");
		store.compareAndSetStatus(id, "running", "stuck", eventsPath);
		assert.ok(fs.existsSync(eventsPath), "events.jsonl must be created/appended");
		const lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
		assert.ok(lines.length > 0, "at least one event must be appended");
		const evt = JSON.parse(lines[lines.length - 1]);
		assert.equal(evt.type, "goal.state_changed");
		assert.equal(evt.data.goalId, id);
		assert.equal(evt.data.state, "stuck");
	});

	it("does NOT emit an event when CAS fails", () => {
		const cwd = makeTmpCwd();
		cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const store = new GoalStore(cwd);
		const id = store.createGoalId();
		store.save(sampleGoal(cwd, id, "running"));

		const eventsPath = path.join(cwd, ".crew", "state", "events.jsonl");
		const beforeExists = fs.existsSync(eventsPath);
		store.compareAndSetStatus(id, "stuck", "cancelled", eventsPath);
		// No event file should have been created on a failed CAS.
		assert.equal(fs.existsSync(eventsPath), beforeExists);
	});
});
