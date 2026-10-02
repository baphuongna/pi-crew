import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactStatus } from "../../../../src/extension/team-tool/status.ts";

/** G19 (W-E Phase 1) pins: the team-tool status output must surface the
 * goal-achievement verdict once a run is terminal — ⚠ when the goal was NOT
 * achieved (false-green / not verified), silent when achieved, never while
 * the run is still active, and never for legacy runs without a verdict. */
const baseManifest = {
	runId: "team_g19_status",
	team: "default",
	workflow: "default",
	status: "completed",
	goal: "Ship the fix",
	workspaceMode: "single",
	goalAchieved: false,
	goalAchievementNote: "goal-achievement: FALSE-GREEN — clean tree despite mutating workflow",
} as const;

test("compact status surfaces goalAchieved=false on a completed run", () => {
	const out = buildCompactStatus({ ...baseManifest }, [], new Map());
	const text = out.join("\n");
	assert.match(text, /Status: completed/);
	assert.match(text, /Goal achieved: ⚠ not achieved/);
	assert.match(text, /FALSE-GREEN/);
});

test("compact status marks unverified goals as unknown", () => {
	const out = buildCompactStatus({ ...baseManifest, goalAchieved: "unknown" }, [], new Map());
	assert.match(out.join("\n"), /Goal achieved: ⚠ unknown \(not verified\)/);
});

test("compact status stays silent when the goal was achieved", () => {
	const out = buildCompactStatus({ ...baseManifest, goalAchieved: true }, [], new Map());
	assert.doesNotMatch(out.join("\n"), /Goal achieved/);
});

test("compact status never shows the goal verdict while the run is active", () => {
	const out = buildCompactStatus({ ...baseManifest, status: "running" }, [], new Map());
	assert.doesNotMatch(out.join("\n"), /Goal achieved/);
});

test("compact status is silent for legacy runs without a goal assessment", () => {
	const { goalAchieved, goalAchievementNote, ...legacy } = baseManifest;
	const out = buildCompactStatus({ ...legacy }, [], new Map());
	assert.doesNotMatch(out.join("\n"), /Goal achieved/);
});
