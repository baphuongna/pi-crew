/**
 * Tier A — schedules pane wiring in run-dashboard (pane 8).
 *
 * Covers the three required areas from the task packet:
 *   1. key routing for the pane (T/N/V/X/R pane-scoped via BINDINGS, "8"
 *      pane switch, no leakage into other panes — V stays live-conversation
 *      elsewhere),
 *   2. the 2-step confirm-gate X flow (first X arms, second X confirms,
 *      any other key disarms),
 *   3. action dispatch targeting the extension layer: mutation keys leave
 *      the component ONLY as done() selections carrying schedule-* actions
 *      + jobId, and those actions map onto real handle-schedule.ts
 *      subActions (verified by driving the REAL handleSchedule against a
 *      registered fake scheduler — the UI never touches the scheduler).
 *
 * Job data is injected through the sanctioned test hook
 * registerCrewScheduler() so the dashboard reads it via the G17 provider
 * (getScheduledJobs) exactly like production.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { handleSchedule, registerCrewScheduler, unregisterCrewScheduler } from "../../../src/extension/team-tool/handle-schedule.ts";
import type { ScheduledJob } from "../../../src/runtime/scheduling/scheduler.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { dashboardActionForKey } from "../../../src/ui/keybinding-map.ts";
import { RunDashboard, type RunDashboardSelection, scheduleDashboardActionToSubAction } from "../../../src/ui/run-dashboard.ts";

function job(partial: Partial<ScheduledJob> & { id: string }): ScheduledJob {
	return {
		name: `job-${partial.id}`,
		description: "test job",
		schedule: "*/5 * * * *",
		scheduleType: "cron",
		subagentType: "team",
		prompt: JSON.stringify({ action: "run", team: "default", goal: "Do the thing" }),
		enabled: true,
		createdAt: "2026-09-13T00:00:00.000Z",
		nextRun: "2026-09-13T01:24:00.000Z",
		runCount: 3,
		lastRun: "2026-09-13T01:00:00.000Z",
		lastStatus: "success",
		spawnedRunIds: ["run_abc123"],
		...partial,
	};
}

/** Fake scheduler registered via the @internal hook; records mutations. */
function fakeScheduler(jobs: ScheduledJob[]) {
	const calls: Array<{ op: string; id?: string; patch?: unknown }> = [];
	const live = new Map(jobs.map((j) => [j.id, { ...j }]));
	const ref = {
		add: (j: ScheduledJob) => {
			calls.push({ op: "add", id: j.id });
			live.set(j.id, j);
		},
		list: () => [...live.values()],
		remove: (id: string) => {
			calls.push({ op: "remove", id });
			return live.delete(id);
		},
		update: (id: string, patch: Partial<ScheduledJob>) => {
			calls.push({ op: "update", id, patch });
			const current = live.get(id);
			if (!current) return undefined;
			const next = { ...current, ...patch };
			live.set(id, next);
			return next;
		},
		runNow: (id: string): { ok: true } | { ok: false; error: string } => {
			calls.push({ op: "runNow", id });
			return live.has(id) ? { ok: true } : { ok: false, error: `unknown job ${id}` };
		},
		calls,
	};
	return ref;
}

const FIXED_NOW = new Date("2026-09-13T01:00:00.000Z");

function dashboardWith(
	jobs: ScheduledJob[],
	runs: TeamRunManifest[] = [],
): { dashboard: RunDashboard; selections: RunDashboardSelection[] } {
	registerCrewScheduler(fakeScheduler(jobs));
	const selections: RunDashboardSelection[] = [];
	const dashboard = new RunDashboard(
		runs,
		(selection) => {
			if (selection) selections.push(selection);
		},
		{},
		{ now: () => FIXED_NOW },
	);
	return { dashboard, selections };
}

afterEach(() => {
	unregisterCrewScheduler();
});

// ─── 1. Key routing ─────────────────────────────────────────────────────────

test("schedules pane keys T/N/V/X/R are pane-scoped and '8' switches panes", () => {
	assert.equal(dashboardActionForKey("T", "schedules"), "schedule-toggle");
	assert.equal(dashboardActionForKey("N", "schedules"), "schedule-run-now");
	assert.equal(dashboardActionForKey("V", "schedules"), "schedule-details");
	assert.equal(dashboardActionForKey("X", "schedules"), "schedule-delete");
	assert.equal(dashboardActionForKey("R", "schedules"), "schedule-refresh");
	assert.equal(dashboardActionForKey("8", "schedules"), "pane-schedules");
	assert.equal(dashboardActionForKey("8", "agents"), "pane-schedules");
	assert.equal(dashboardActionForKey("8", undefined), "pane-schedules");
});

test("schedules keys do NOT leak into other panes (V stays live-conversation)", () => {
	// T/N/X are unclaimed outside pane 8; V must fall through to the unscoped
	// root liveConversation binding (ordering rule in DEFAULT_BINDINGS); R
	// stays health-scoped only.
	assert.equal(dashboardActionForKey("T", "agents"), undefined);
	assert.equal(dashboardActionForKey("T", undefined), undefined);
	assert.equal(dashboardActionForKey("N", "agents"), undefined);
	assert.equal(dashboardActionForKey("X", "agents"), undefined);
	assert.equal(dashboardActionForKey("X", "health"), undefined);
	assert.equal(dashboardActionForKey("V", "agents"), "live-conversation");
	assert.equal(dashboardActionForKey("V", undefined), "live-conversation");
	assert.equal(dashboardActionForKey("R", "health"), "health-recovery");
	assert.equal(dashboardActionForKey("R", "agents"), undefined);
});

test("dashboard input '8' activates the schedules pane (pane-switch wiring)", () => {
	const { dashboard } = dashboardWith([job({ id: "j1" })]);
	dashboard.handleInput("8");
	const lines = dashboard.render(80).join("\n");
	assert.ok(lines.includes("── schedules ──"), "schedules pane header should render");
	assert.ok(lines.includes("Scheduled jobs (1)"), "provider table should render");
});

// ─── 2. Rendering (provider-only data, injected clock, non-run-scoped) ─────

test("schedules pane renders table rows with cursor marker and relative time via injected clock", () => {
	const { dashboard } = dashboardWith([job({ id: "j1", name: "nightly build" }), job({ id: "j2", enabled: false })]);
	dashboard.handleInput("8");
	dashboard.handleInput("j"); // move job cursor to the second job
	const lines = dashboard.render(80).join("\n");
	assert.ok(lines.includes("nightly build"));
	// FIXED_NOW=01:00, nextRun=01:24 → "in 24m" (clock injected, D6-T4)
	assert.ok(lines.includes("in 24m"), `expected injected-clock relative time, got:\n${lines}`);
	// cursor on second job: marker line renders the disabled glyph
	assert.ok(lines.includes("○ job-j2"));
});

test("schedules pane renders with ZERO runs — non-run-scoped (renders in the empty-runs state)", () => {
	const { dashboard } = dashboardWith([job({ id: "j1" })], []);
	dashboard.handleInput("8");
	const lines = dashboard.render(80).join("\n");
	assert.ok(lines.includes("No runs yet."), "empty-runs state still renders");
	assert.ok(lines.includes("── schedules ──"), "schedules pane renders below the empty-runs state");
	assert.ok(lines.includes("Scheduled jobs (1)"));
});

test("with runs present, pane 8 keeps the run list but REPLACES the run-scoped detail block", () => {
	const run: TeamRunManifest = {
		schemaVersion: 1,
		runId: "schedrun",
		team: "default",
		workflow: "default",
		goal: "Run goal",
		status: "completed",
		workspaceMode: "single",
		createdAt: "2026-09-13T00:00:00.000Z",
		updatedAt: "2026-09-13T00:00:00.000Z",
		cwd: "/tmp/project",
		stateRoot: "/tmp/state",
		artifactsRoot: "/tmp/artifacts",
		tasksPath: "/tmp/state/tasks.json",
		eventsPath: "/tmp/state/events.jsonl",
		artifacts: [],
	};
	const { dashboard } = dashboardWith([job({ id: "j1" })], [run]);
	dashboard.handleInput("8");
	const lines = dashboard.render(80).join("\n");
	assert.ok(lines.includes("schedrun"), "run list still renders above (context)");
	assert.ok(lines.includes("── schedules ──"), "schedules section renders");
	assert.ok(!lines.includes("── agents ──"), "run-scoped pane content is suppressed while pane 8 is active");
	// up/down move the JOB cursor, not the run selection (k = up on job 0 → stays 0)
	dashboard.handleInput("j");
	assert.ok(dashboard.render(80).join("\n").includes("› ● job-j1"), "job cursor marker on selected job");
});

test("schedules pane shared empty state when no jobs exist", () => {
	const { dashboard } = dashboardWith([]);
	dashboard.handleInput("8");
	const lines = dashboard.render(80).join("\n");
	assert.ok(lines.includes("No scheduled jobs — create via team tool action='schedule'"));
});

test("V toggles details view (full goal + schedule spec + spawnedRunIds), toggling back restores table", () => {
	const { dashboard } = dashboardWith([job({ id: "j1" })]);
	dashboard.handleInput("8");
	dashboard.handleInput("V");
	const details = dashboard.render(80).join("\n");
	assert.ok(details.includes("goal: Do the thing"), "full goal from prompt payload");
	assert.ok(details.includes("schedule: */5 * * * * (cron)"), "raw schedule spec");
	assert.ok(details.includes("spawned runs: run_abc123"), "spawnedRunIds");
	dashboard.handleInput("V");
	const table = dashboard.render(80).join("\n");
	assert.ok(table.includes("Scheduled jobs (1)"), "table restored after second V");
});

// ─── 3. Confirm-gate X flow ────────────────────────────────────────────────

test("X confirm-gate: first X arms (no dispatch + warning line), second X confirms remove", () => {
	const { dashboard, selections } = dashboardWith([job({ id: "j1", name: "precious" })]);
	dashboard.handleInput("8");
	dashboard.handleInput("X");
	assert.equal(selections.length, 0, "first X must NOT dispatch");
	assert.ok(dashboard.render(80).join("\n").includes("X again to DELETE 'precious'"), "armed hint renders");
	dashboard.handleInput("X");
	assert.deepEqual(selections, [{ runId: "", action: "schedule-remove", jobId: "j1" }]);
});

test("X confirm-gate: any other key disarms — a later single X re-arms instead of deleting", () => {
	const { dashboard, selections } = dashboardWith([job({ id: "j1" })]);
	dashboard.handleInput("8");
	dashboard.handleInput("X"); // arm
	dashboard.handleInput("k"); // other key → disarm (+ cursor move, no dispatch)
	assert.equal(selections.length, 0);
	assert.ok(!dashboard.render(80).join("\n").includes("X again to DELETE"), "hint cleared after disarm");
	dashboard.handleInput("X"); // re-arm, NOT confirm
	assert.equal(selections.length, 0, "single X after disarm must re-arm, not delete");
	dashboard.handleInput("X"); // now confirm
	assert.deepEqual(selections, [{ runId: "", action: "schedule-remove", jobId: "j1" }]);
});

test("mutation keys are silent no-ops with no jobs (plan-approve precedent)", () => {
	const { dashboard, selections } = dashboardWith([]);
	dashboard.handleInput("8");
	dashboard.handleInput("T");
	dashboard.handleInput("N");
	dashboard.handleInput("X");
	dashboard.handleInput("X");
	assert.equal(selections.length, 0);
});

// ─── 4. Action dispatch targets the extension layer ────────────────────────

test("T/N dispatch done() selections carrying jobId (never direct scheduler calls)", () => {
	const { dashboard, selections } = dashboardWith([job({ id: "j1", enabled: true }), job({ id: "j2", enabled: false })]);
	dashboard.handleInput("8");
	dashboard.handleInput("T"); // j1 enabled → disable
	dashboard.handleInput("j");
	dashboard.handleInput("T"); // j2 disabled → enable
	dashboard.handleInput("k"); // back to j1
	dashboard.handleInput("N"); // run-now j1
	assert.deepEqual(selections, [
		{ runId: "", action: "schedule-disable", jobId: "j1" },
		{ runId: "", action: "schedule-enable", jobId: "j2" },
		{ runId: "", action: "schedule-run-now", jobId: "j1" },
	]);
});

test("scheduleDashboardActionToSubAction maps every mutation action onto handle-schedule subActions", () => {
	assert.equal(scheduleDashboardActionToSubAction("schedule-enable"), "enable");
	assert.equal(scheduleDashboardActionToSubAction("schedule-disable"), "disable");
	assert.equal(scheduleDashboardActionToSubAction("schedule-run-now"), "run-now");
	assert.equal(scheduleDashboardActionToSubAction("schedule-remove"), "remove");
	assert.equal(scheduleDashboardActionToSubAction("status"), undefined);
	assert.equal(scheduleDashboardActionToSubAction("reload"), undefined);
});

test("emitted schedule actions are consumable by the REAL extension layer (handleSchedule)", async () => {
	const cases: Array<{ action: RunDashboardSelection["action"]; subAction: string; expectOp: string }> = [
		{ action: "schedule-enable", subAction: "enable", expectOp: "update" },
		{ action: "schedule-disable", subAction: "disable", expectOp: "update" },
		{ action: "schedule-run-now", subAction: "run-now", expectOp: "runNow" },
		{ action: "schedule-remove", subAction: "remove", expectOp: "remove" },
	];
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sched-ui-"));
	try {
		for (const { action, subAction, expectOp } of cases) {
			const mapped = scheduleDashboardActionToSubAction(action);
			assert.equal(mapped, subAction);
			const fake = fakeScheduler([job({ id: "j1" })]);
			registerCrewScheduler(fake);
			// Exactly how the extension layer will dispatch a dashboard
			// schedule-* selection: handleSchedule({action:'schedule', subAction, jobId}).
			const result = await handleSchedule(
				{ action: "schedule", subAction, jobId: "j1", config: { subAction, jobId: "j1" } },
				{ cwd: tmp },
			);
			assert.equal(result.isError, false, `${subAction} should succeed via the extension layer`);
			assert.ok(
				fake.calls.some((c) => c.op === expectOp && c.id === "j1"),
				`${subAction} must reach the scheduler through handleSchedule (got calls: ${JSON.stringify(fake.calls)})`,
			);
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("schedule-render path holds no wall-clock reads — output depends only on the injected clock", () => {
	const { dashboard } = dashboardWith([job({ id: "j1", nextRun: "2026-09-13T01:24:00.000Z" })]);
	dashboard.handleInput("8");
	const atFixed = dashboard.render(80).join("\n");
	assert.ok(atFixed.includes("in 24m"));
	// Same jobs, a LATER injected clock → different relative time from the
	// same provider data (proves the render consumes the injected `now`).
	registerCrewScheduler(fakeScheduler([job({ id: "j1", nextRun: "2026-09-13T01:24:00.000Z" })]));
	const later = new RunDashboard([], () => undefined, {}, { now: () => new Date("2026-09-13T01:10:00.000Z") });
	later.handleInput("8");
	assert.ok(later.render(80).join("\n").includes("in 14m"));
	assert.ok(!later.render(80).join("\n").includes("in 24m"));
});
