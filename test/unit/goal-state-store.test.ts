import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { GoalStore } from "../../src/runtime/goal-state-store.ts";
import { clearProjectRootCache } from "../../src/utils/paths.ts";
import type { GoalLoopState } from "../../src/state/types.ts";

function makeTmpCwd(): string {
	clearProjectRootCache(); // findRepoRoot has a global cache (paths.ts:71) — clear it so each tmpdir resolves correctly.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-goal-store-"));
	// Pre-create `.crew` so projectCrewRoot(cwd) resolves to `<cwd>/.crew` deterministically
	// (otherwise findRepoRoot may walk up to /tmp and a sibling test's cache entry can win under concurrency).
	fs.mkdirSync(path.join(cwd, ".crew", "state", "goals"), { recursive: true });
	return cwd;
}

function sampleGoal(cwd: string, goalId: string): GoalLoopState {
	const now = new Date().toISOString();
	return {
		goalId,
		ownerSessionId: "test-session",
		objective: "Make all tests pass",
		state: "running",
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

test("GoalStore.createGoalId() returns a path-safe id matching the `goal_*` pattern", () => {
	const cwd = makeTmpCwd();
	try {
		const store = new GoalStore(cwd);
		const id = store.createGoalId();
		assert.match(id, /^goal_[0-9]{14}_[0-9a-f]+$/, "goalId must be path-safe (assertSafePathId regex)");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("GoalStore.save/load round-trip persists GoalLoopState atomically", () => {
	const cwd = makeTmpCwd();
	try {
		const store = new GoalStore(cwd);
		const id = store.createGoalId();
		const goal = sampleGoal(cwd, id);
		store.save(goal);

		const loaded = store.load(id);
		assert.ok(loaded, "load should return the saved goal");
		assert.equal(loaded!.goalId, id);
		assert.equal(loaded!.objective, "Make all tests pass");
		assert.equal(loaded!.state, "running");
		assert.deepEqual(loaded!.verdicts, []);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("GoalStore.patch() merges fields and preserves goalId + createdAt", () => {
	const cwd = makeTmpCwd();
	try {
		const store = new GoalStore(cwd);
		const id = store.createGoalId();
		store.save(sampleGoal(cwd, id));
		const original = store.load(id);
		assert.ok(original);

		const patched = store.patch(id, { state: "achieved", turnsUsed: 3, budgetUsed: 12345 });
		assert.ok(patched);
		assert.equal(patched!.state, "achieved");
		assert.equal(patched!.turnsUsed, 3);
		assert.equal(patched!.budgetUsed, 12345);
		assert.equal(patched!.goalId, id, "goalId must be preserved");
		assert.equal(patched!.createdAt, original!.createdAt, "createdAt must be preserved");
		assert.equal(patched!.objective, original!.objective, "objective must be preserved");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("GoalStore.setStatus() transitions state and persists", () => {
	const cwd = makeTmpCwd();
	try {
		const store = new GoalStore(cwd);
		const id = store.createGoalId();
		store.save(sampleGoal(cwd, id));

		const paused = store.setStatus(id, "paused");
		assert.equal(paused?.state, "paused");
		assert.equal(store.load(id)?.state, "paused");

		const cancelled = store.setStatus(id, "cancelled");
		assert.equal(cancelled?.state, "cancelled");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("GoalStore.list() returns goals newest-first by updatedAt", () => {
	const cwd = makeTmpCwd();
	try {
		const store = new GoalStore(cwd);
		const id1 = store.createGoalId();
		const id2 = store.createGoalId();
		store.save(sampleGoal(cwd, id1));
		// Bump id2's updatedAt by patching after id1.
		store.save(sampleGoal(cwd, id2));
		store.patch(id1, { turnsUsed: 1 });

		const list = store.list();
		assert.equal(list.length, 2);
		assert.equal(list[0].goalId, id1, "id1 was patched last → newest");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("GoalStore.remove() deletes the goal file", () => {
	const cwd = makeTmpCwd();
	try {
		const store = new GoalStore(cwd);
		const id = store.createGoalId();
		store.save(sampleGoal(cwd, id));
		assert.ok(store.load(id));

		const removed = store.remove(id);
		assert.equal(removed, true);
		assert.equal(store.load(id), undefined);

		// Removing again is a no-op (returns false).
		assert.equal(store.remove(id), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("GoalStore.load() returns undefined for missing/corrupt files", () => {
	const cwd = makeTmpCwd();
	try {
		const store = new GoalStore(cwd);
		assert.equal(store.load("goal_missing_12345_abcd"), undefined);

		// Corrupt file: valid goalId-shaped name but bad JSON.
		const id = store.createGoalId();
		const goalsDir = findGoalsDir(cwd);
		fs.mkdirSync(goalsDir, { recursive: true });
		fs.writeFileSync(path.join(goalsDir, `${id}.json`), "{not valid json");
		assert.equal(store.load(id), undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("GoalStore rejects path-traversal goalIds (§0c C10 — assertSafePathId)", () => {
	const cwd = makeTmpCwd();
	try {
		const store = new GoalStore(cwd);
		// `../escape` must be rejected by assertSafePathId before any file access.
		assert.throws(() => store.load("../escape"), /goalId/i);
		assert.throws(() => store.save({ ...sampleGoal(cwd, "../escape"), goalId: "../escape" }), /goalId/i);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/** Recursively find the goal file for an id under cwd (projectCrewRoot may resolve to <cwd>/.crew). */
function findGoalFile(cwd: string, goalId: string): string | undefined {
	const goalsDir = findGoalsDir(cwd);
	const candidate = path.join(goalsDir, `${goalId}.json`);
	return fs.existsSync(candidate) ? candidate : undefined;
}

/** Locate the goals dir (projectCrewRoot may be <cwd>/.crew or fall back elsewhere under cwd). */
function findGoalsDir(cwd: string): string {
	// Prefer <cwd>/.crew/state/goals (projectCrewRoot default).
	const direct = path.join(cwd, ".crew", "state", "goals");
	if (fs.existsSync(direct)) return direct;
	// Fallback: search for any state/goals dir under cwd.
	for (const ent of fs.readdirSync(cwd, { withFileTypes: true })) {
		if (ent.isDirectory()) {
			const candidate = path.join(cwd, ent.name, "state", "goals");
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return direct; // default even if missing
}
