import assert from "node:assert/strict";
import test from "node:test";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { dashboardActionForKey, VALID_OVERRIDE_ACTIONS } from "../../../src/ui/keybinding-map.ts";
import { RunDashboard, type RunDashboardSelection } from "../../../src/ui/run-dashboard.ts";

/**
 * US-020 (2026-09-23): interactive run dashboard — the genuinely-missing
 * pieces. (Selection cursor, panes, transcript/live viewers, schedule actions
 * and overridable keybindings already existed — this spec closed: run CANCEL
 * with a running-guard + 2-step confirm, WRAP navigation, and selection
 * persistence across close/reopen.)
 *
 * Mutations: remove the isActiveRunStatus guard → the refusal test RED;
 * restore the hard clamp → the wrap test RED.
 */

function makeRun(id: string, status: TeamRunManifest["status"] = "running"): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: id,
		team: "fast-fix",
		workflow: "fast-fix",
		goal: `goal ${id}`,
		status,
		workspaceMode: "single",
		createdAt: "2026-09-23T00:00:00.000Z",
		updatedAt: "2026-09-23T00:00:00.000Z",
		cwd: "/tmp/project",
		stateRoot: "/tmp/state",
		artifactsRoot: "/tmp/artifacts",
		tasksPath: "/tmp/state/tasks.json",
		eventsPath: "/tmp/state/events.jsonl",
		artifacts: [],
	} as TeamRunManifest;
}

function makeDashboard(runs: TeamRunManifest[]): { dashboard: RunDashboard; selections: RunDashboardSelection[] } {
	const selections: RunDashboardSelection[] = [];
	const dashboard = new RunDashboard(runs, (selection) => {
		if (selection) selections.push(selection);
	});
	return { dashboard, selections };
}

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

test("US-020 AC-1: j/k navigation WRAPS at both edges", () => {
	const runs = [makeRun("team_a"), makeRun("team_b"), makeRun("team_c")];
	{
		// down at the last item wraps to the first
		const { dashboard, selections } = makeDashboard(runs);
		dashboard.handleInput("j");
		dashboard.handleInput("j");
		dashboard.handleInput("j"); // a→b→c→a (wrap)
		dashboard.handleInput("\r"); // enter → select
		assert.equal(selections[0]?.action, "status");
		assert.equal(selections[0]?.runId, "team_a", "down×3 wraps back to the first run");
	}
	{
		// up at the first item wraps to the last
		const { dashboard, selections } = makeDashboard(runs);
		dashboard.handleInput("k"); // 0 → last
		dashboard.handleInput("\r");
		assert.equal(selections[0]?.runId, "team_c", "up at the top wraps to the last run");
	}
});

test("US-020 AC-3: x on a NON-running run refuses — no done, status line rendered", () => {
	const runs = [makeRun("team_done", "completed")];
	const { dashboard, selections } = makeDashboard(runs);
	dashboard.handleInput("x");
	dashboard.handleInput("x"); // second x must NOT dispatch either
	assert.equal(selections.length, 0, "a terminal run can never be cancelled");
	const text = strip(dashboard.render(100).join("\n"));
	assert.ok(text.includes("nothing to cancel"), `refusal status line must render, got: ${text.slice(0, 200)}`);
});

test("US-020 AC-3: x on a RUNNING run needs TWO presses; any other key disarms", () => {
	const runs = [makeRun("team_live", "running")];
	const { dashboard, selections } = makeDashboard(runs);
	dashboard.handleInput("x");
	assert.equal(selections.length, 0, "first x only ARMS the confirm gate");
	assert.ok(strip(dashboard.render(100).join("\n")).includes("x again to CANCEL"), "armed warning line renders");
	dashboard.handleInput("j"); // disarm
	dashboard.handleInput("x");
	dashboard.handleInput("x");
	assert.equal(selections.length, 1, "re-armed + confirmed dispatches exactly once");
	assert.equal(selections[0]?.action, "cancel");
	assert.equal(selections[0]?.runId, "team_live");
});

test("US-020 AC-2: selection survives close/reopen (enter → escape → same cursor)", () => {
	const runs = [makeRun("team_a"), makeRun("team_b"), makeRun("team_c")];
	const first = makeDashboard(runs);
	first.dashboard.handleInput("j"); // → team_b
	first.dashboard.handleInput("\r"); // open detail (done status — persists team_b)
	assert.equal(first.selections[0]?.runId, "team_b");
	// Reopen = a fresh instance (the shared.ts action loop re-creates it).
	const second = makeDashboard(runs);
	second.dashboard.handleInput("\r");
	assert.equal(second.selections[0]?.runId, "team_b", "cursor restored to the previously selected run");
});

test("US-020 AC-4: render ticks are fs-free — in-memory channels only, deterministic frames", () => {
	const runs = [makeRun("team_a"), makeRun("team_b")];
	// Fixtures point at NONEXISTENT state roots/events paths: if the render
	// path touched the filesystem for run state it would throw or produce
	// unstable output. The provider is the in-memory manifest-cache channel
	// (production: getManifestCache(cwd).list(50)) — calling it per frame is
	// by design; the contract is that NO fs read is on the tick path.
	const selections: RunDashboardSelection[] = [];
	const dashboard = new RunDashboard(
		runs,
		(s) => s && selections.push(s),
		{},
		{
			runProvider: () => runs,
		},
	);
	const frame1 = dashboard.render(100).join("\n");
	const frame2 = dashboard.render(100).join("\n");
	assert.equal(frame1, frame2, "identical width must produce a byte-stable cached frame");
	const frame3 = dashboard.render(60).join("\n");
	assert.notEqual(frame1, frame3, "width change forces a recompute (cache not stale)");
	assert.ok(frame1.length > 0);
});

test("US-020 AC-5: `x` is bound to cancel and participates in the override mechanism", () => {
	assert.equal(dashboardActionForKey("x"), "cancel");
	assert.equal(dashboardActionForKey("x", "schedules"), "cancel", "unscoped root binding works in every pane");
	// Overridability is the keybinding-map contract (keybinding-map-override
	// covers the mechanism); assert the action is in the overridable set.
	assert.ok(VALID_OVERRIDE_ACTIONS.has("cancel"), "cancel must be user-overridable");
});
