import assert from "node:assert/strict";
import test from "node:test";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { goalAchievedStatusLabel, goalFlagSuffix, isGoalNotAchieved } from "../../../src/ui/goal-flag.ts";
import { shortRunLabel } from "../../../src/ui/widget/widget-model.ts";

/** Minimal manifest factory — shortRunLabel/goalFlagSuffix only read the
 * identity + status + goalAchieved fields. */
function run(overrides: Partial<TeamRunManifest>): TeamRunManifest {
	return {
		runId: "team_g19_pin",
		team: "fast-fix",
		workflow: "fast-fix",
		status: "running",
		goal: "pin the goal flag",
		...overrides,
	} as TeamRunManifest;
}

test("goalFlagSuffix warns only on terminal runs that did not achieve the goal", () => {
	assert.equal(goalFlagSuffix({ status: "completed", goalAchieved: false }), " ⚠");
	assert.equal(goalFlagSuffix({ status: "completed", goalAchieved: "unknown" }), " ⚠");
	assert.equal(goalFlagSuffix({ status: "failed", goalAchieved: false }), " ⚠");
	// silent: achieved, never-assessed (legacy), and any non-terminal status
	assert.equal(goalFlagSuffix({ status: "completed", goalAchieved: true }), "");
	assert.equal(goalFlagSuffix({ status: "completed" }), "");
	assert.equal(goalFlagSuffix({ status: "running", goalAchieved: false }), "");
	assert.equal(goalFlagSuffix({ status: "queued", goalAchieved: "unknown" }), "");
	assert.equal(goalFlagSuffix({}), "");
});

test("isGoalNotAchieved is false while the run is still active", () => {
	assert.equal(isGoalNotAchieved({ status: "running", goalAchieved: false }), false);
	assert.equal(isGoalNotAchieved({ status: "completed", goalAchieved: false }), true);
});

test("goalAchievedStatusLabel renders the false-green verdict with its note", () => {
	const line = goalAchievedStatusLabel({
		status: "completed",
		goalAchieved: false,
		goalAchievementNote:
			"goal-achievement: FALSE-GREEN — code-mutating run completed but made no project edits (false-green). corroborating failed task: 01_exec (executor)",
	});
	assert.match(line, /Goal achieved: ⚠ not achieved/);
	assert.match(line, /FALSE-GREEN/);
});

test("goalAchievedStatusLabel marks unverified goals as unknown", () => {
	const line = goalAchievedStatusLabel({ status: "completed", goalAchieved: "unknown" });
	assert.match(line, /Goal achieved: ⚠ unknown \(not verified\)/);
});

test("goalAchievedStatusLabel is silent when achieved, active, or never assessed", () => {
	assert.equal(goalAchievedStatusLabel({ status: "completed", goalAchieved: true }), "");
	assert.equal(goalAchievedStatusLabel({ status: "running", goalAchieved: false }), "");
	assert.equal(goalAchievedStatusLabel({ status: "completed" }), "");
});

test("shortRunLabel appends the goal flag only for terminal not-achieved runs", () => {
	assert.equal(shortRunLabel(run({ status: "completed", goalAchieved: false })), "fast-fix ⚠");
	assert.equal(shortRunLabel(run({ status: "failed", goalAchieved: "unknown" })), "fast-fix ⚠");
	// team ≠ workflow keeps both halves; flag still appended
	assert.equal(shortRunLabel(run({ status: "completed", goalAchieved: false, team: "default", workflow: "impl" })), "default/impl ⚠");
	// silent: green run, active run, legacy run without a verdict
	assert.equal(shortRunLabel(run({ status: "completed", goalAchieved: true })), "fast-fix");
	assert.equal(shortRunLabel(run({ status: "running", goalAchieved: false })), "fast-fix");
	assert.equal(shortRunLabel(run({ status: "completed" })), "fast-fix");
});
