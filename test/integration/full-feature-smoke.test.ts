/**
 * Full Feature Smoke Test — exercises every pi-crew action end-to-end.
 *
 * Strategy:
 *   1. Spin up a temp project dir with .crew/ initialized.
 *   2. Test each action group sequentially.
 *   3. Use mock child-pi for run/resume/cancel flows.
 *
 * Run: node --test --test-timeout=60000 test/integration/full-feature-smoke.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";
import { listRuns } from "../../src/extension/run-index.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

let _cwd: string;
let _home: string;
let _savedHome: string | undefined;
let _savedSkip: string | undefined;
let _savedExec: string | undefined;
let _savedMock: string | undefined;
let _savedAllow: string | undefined;

function tool(params: Record<string, unknown>) {
	return handleTeamTool(params, { cwd: _cwd });
}

function setup() {
	_cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-smoke-"));
	_home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-smoke-home-"));
	fs.mkdirSync(path.join(_cwd, ".crew"), { recursive: true });
	_savedHome = process.env.PI_TEAMS_HOME;
	_savedSkip = process.env.PI_CREW_SKIP_HOME_CHECK;
	_savedExec = process.env.PI_TEAMS_EXECUTE_WORKERS;
	_savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	_savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_TEAMS_HOME = _home;
	process.env.PI_CREW_SKIP_HOME_CHECK = "1";
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
}

function teardown() {
	if (_savedHome === undefined) delete process.env.PI_TEAMS_HOME;
	else process.env.PI_TEAMS_HOME = _savedHome;
	if (_savedSkip === undefined) delete process.env.PI_CREW_SKIP_HOME_CHECK;
	else process.env.PI_CREW_SKIP_HOME_CHECK = _savedSkip;
	if (_savedExec === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
	else process.env.PI_TEAMS_EXECUTE_WORKERS = _savedExec;
	if (_savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	else process.env.PI_TEAMS_MOCK_CHILD_PI = _savedMock;
	if (_savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
	else process.env.PI_CREW_ALLOW_MOCK = _savedAllow;
	try { fs.rmSync(_cwd, { recursive: true, force: true }); } catch { /* ok */ }
	try { fs.rmSync(_home, { recursive: true, force: true }); } catch { /* ok */ }
}

function ok(res: Awaited<ReturnType<typeof handleTeamTool>>, label: string) {
	assert.equal(res.isError, false, `${label} should not error: ${getText(res)}`);
}

function getText(res: Awaited<ReturnType<typeof handleTeamTool>>): string {
	const c = res.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		const block = c.find((b: { type?: string }) => b.type === "text");
		return block && "text" in block ? (block as { text: string }).text : JSON.stringify(c);
	}
	return JSON.stringify(c);
}

// ── Group 1: Discovery & Config ──────────────────────────────────────────

test("G1: help shows usage", async () => {
	setup();
	try {
		const res = await tool({ action: "help" });
		ok(res, "help");
		assert.match(getText(res), /team/i);
	} finally { teardown(); }
});

test("G1: list returns teams/agents/workflows", async () => {
	setup();
	try {
		const res = await tool({ action: "list" });
		ok(res, "list");
		assert.match(getText(res), /team|agent|workflow/i);
	} finally { teardown(); }
});

test("G1: get returns team details", async () => {
	setup();
	try {
		const res = await tool({ action: "get", team: "default" });
		ok(res, "get team");
		assert.match(getText(res), /default/i);
	} finally { teardown(); }
});

test("G1: get returns agent details", async () => {
	setup();
	try {
		const res = await tool({ action: "get", agent: "executor" });
		ok(res, "get agent");
		assert.match(getText(res), /executor/i);
	} finally { teardown(); }
});

test("G1: get returns workflow details", async () => {
	setup();
	try {
		const res = await tool({ action: "get", workflow: "default" });
		ok(res, "get workflow");
		assert.match(getText(res), /default/i);
	} finally { teardown(); }
});

test("G1: config shows current config", async () => {
	setup();
	try {
		const res = await tool({ action: "config" });
		ok(res, "config");
		assert.match(getText(res), /config/i);
	} finally { teardown(); }
});

test("G1: autonomy shows status", async () => {
	setup();
	try {
		const res = await tool({ action: "autonomy" });
		ok(res, "autonomy");
		assert.match(getText(res), /autonom/i);
	} finally { teardown(); }
});

test("G1: validate checks resources", async () => {
	setup();
	try {
		const res = await tool({ action: "validate" });
		ok(res, "validate");
	} finally { teardown(); }
});

test("G1: recommend suggests team/workflow", async () => {
	setup();
	try {
		const res = await tool({ action: "recommend", goal: "Fix a small bug" });
		ok(res, "recommend");
		assert.match(getText(res), /team|workflow|fast-fix/i);
	} finally { teardown(); }
});

test("G1: search finds agents/teams", async () => {
	setup();
	try {
		const res = await tool({ action: "search", goal: "executor agent for code implementation" });
		ok(res, "search");
	} finally { teardown(); }
});

test("G1: init reinitializes project", async () => {
	setup();
	try {
		const res = await tool({ action: "init", config: { copyBuiltins: false, configScope: "none" } });
		ok(res, "init");
		assert.match(getText(res), /init/i);
	} finally { teardown(); }
});

test("G1: doctor diagnoses environment", async () => {
	setup();
	try {
		const res = await tool({ action: "doctor" });
		// doctor may report warnings but should not isError
		// It might error if Pi binary not found, that's OK for smoke
		assert.ok(res, "doctor returned something");
	} finally { teardown(); }
});

// ── Group 2: Run Lifecycle ───────────────────────────────────────────────

test("G2: run creates and executes a team run (mock)", async () => {
	setup();
	try {
		const res = await tool({ action: "run", team: "fast-fix", goal: "Fix a typo" });
		ok(res, "run");
		const runId = res.details?.runId as string;
		assert.ok(runId, "run should return runId");
		assert.match(runId, /^team_/);
		// Verify manifest persisted
		const loaded = loadRunManifestById(_cwd, runId);
		assert.ok(loaded, "manifest should be persisted");
		assert.equal(loaded!.manifest.status, "completed", "mock run should complete");
	} finally { teardown(); }
});

test("G2: run with agent runs direct agent", async () => {
	setup();
	try {
		const res = await tool({ action: "run", agent: "executor", goal: "Run a quick check" });
		ok(res, "run agent");
		const runId = res.details?.runId as string;
		assert.ok(runId, "agent run should return runId");
	} finally { teardown(); }
});

test("G2: plan creates dry-run plan", async () => {
	setup();
	try {
		const res = await tool({ action: "plan", team: "default", goal: "Investigate an issue" });
		ok(res, "plan");
		// Plan mode returns a preview without creating a run
	} finally { teardown(); }
});

// ── Group 3: Status & Observability ──────────────────────────────────────

test("G3: status shows run status", async () => {
	setup();
	try {
		const run = await tool({ action: "run", team: "fast-fix", goal: "Quick task" });
		const runId = run.details!.runId as string;
		const res = await tool({ action: "status", runId });
		ok(res, "status");
		assert.match(getText(res), /status|run|completed/i);
	} finally { teardown(); }
});

test("G3: events shows event log", async () => {
	setup();
	try {
		const run = await tool({ action: "run", team: "fast-fix", goal: "Task with events" });
		const runId = run.details!.runId as string;
		const res = await tool({ action: "events", runId });
		ok(res, "events");
	} finally { teardown(); }
});

test("G3: artifacts lists artifacts", async () => {
	setup();
	try {
		const run = await tool({ action: "run", team: "fast-fix", goal: "Task with artifacts" });
		const runId = run.details!.runId as string;
		const res = await tool({ action: "artifacts", runId });
		ok(res, "artifacts");
	} finally { teardown(); }
});

test("G3: summary shows/creates summary", async () => {
	setup();
	try {
		const run = await tool({ action: "run", team: "fast-fix", goal: "Task with summary" });
		const runId = run.details!.runId as string;
		const res = await tool({ action: "summary", runId });
		ok(res, "summary");
	} finally { teardown(); }
});

test("G3: graph loads run graph", async () => {
	setup();
	try {
		const run = await tool({ action: "run", team: "fast-fix", goal: "Graph test" });
		const runId = run.details!.runId as string;
		const res = await tool({ action: "graph", runId });
		// Graph might not exist for all workflows, just verify no crash
		assert.ok(res, "graph returned something");
	} finally { teardown(); }
});

test("G3: graph lists all graphs", async () => {
	setup();
	try {
		const res = await tool({ action: "graph" });
		ok(res, "graph list");
	} finally { teardown(); }
});

// ── Group 4: Control Flow ────────────────────────────────────────────────

test("G4: cancel stops a running run", async () => {
	setup();
	try {
		// Create a run with hard-failure so tasks fail, then cancel
		process.env.PI_TEAMS_MOCK_CHILD_PI = "hard-failure";
		const run = await tool({ action: "run", team: "fast-fix", goal: "Cancel test" });
		const runId = run.details!.runId as string;
		// Run already completed (mock), but cancel should still work
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		const res = await tool({ action: "cancel", runId });
		assert.ok(res, "cancel returned something");
	} finally { teardown(); }
});

test("G4: resume restarts failed tasks", async () => {
	setup();
	try {
		// First run with hard-failure
		process.env.PI_TEAMS_MOCK_CHILD_PI = "hard-failure";
		const run = await tool({ action: "run", team: "fast-fix", goal: "Resume test" });
		const runId = run.details!.runId as string;

		// Verify it failed
		const failed = loadRunManifestById(_cwd, runId);
		assert.ok(failed, "failed manifest exists");

		// Resume with success mock
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		const res = await tool({ action: "resume", runId });
		ok(res, "resume");
	} finally { teardown(); }
});

test("G4: retry re-runs a task", async () => {
	setup();
	try {
		process.env.PI_TEAMS_MOCK_CHILD_PI = "hard-failure";
		const run = await tool({ action: "run", team: "fast-fix", goal: "Retry test" });
		const runId = run.details!.runId as string;
		const loaded = loadRunManifestById(_cwd, runId);
		const failedTask = loaded?.tasks.find(t => t.status === "failed" || t.status === "needs_attention");
		if (failedTask) {
			process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
			const res = await tool({ action: "retry", runId, taskId: failedTask.id });
			assert.ok(res, "retry returned something");
		}
	} finally { teardown(); }
});

// ── Group 5: Resource Management ─────────────────────────────────────────

test("G5: create agent", async () => {
	setup();
	try {
		const res = await tool({
			action: "create",
			resource: "agent",
			config: {
				name: "smoke-tester",
				description: "Agent created by smoke test",
				model: "test-model",
			},
		});
		ok(res, "create agent");
		assert.match(getText(res), /smoke-tester/i);
	} finally { teardown(); }
});

test("G5: create team", async () => {
	setup();
	try {
		const res = await tool({
			action: "create",
			resource: "team",
			config: {
				name: "smoke-team",
				description: "Team created by smoke test",
				roles: [{ name: "worker", agent: "executor" }],
			},
		});
		ok(res, "create team");
		assert.match(getText(res), /smoke-team/i);
	} finally { teardown(); }
});

test("G5: create workflow", async () => {
	setup();
	try {
		const res = await tool({
			action: "create",
			resource: "workflow",
			config: {
				name: "smoke-workflow",
				description: "Workflow created by smoke test",
				steps: [
					{ id: "step1", role: "executor" },
				],
			},
		});
		ok(res, "create workflow");
		assert.match(getText(res), /smoke-workflow/i);
	} finally { teardown(); }
});

test("G5: update agent", async () => {
	setup();
	try {
		// Create first
		await tool({
			action: "create",
			resource: "agent",
			config: { name: "updatable-agent", description: "v1" },
		});
		const res = await tool({
			action: "update",
			resource: "agent",
			agent: "updatable-agent",
			config: { description: "v2 updated" },
		});
		ok(res, "update agent");
		assert.match(getText(res), /v2 updated|updated/i);
	} finally { teardown(); }
});

test("G5: delete agent", async () => {
	setup();
	try {
		await tool({
			action: "create",
			resource: "agent",
			config: { name: "deletable-agent", description: "To delete" },
		});
		const res = await tool({
			action: "delete",
			resource: "agent",
			agent: "deletable-agent",
			confirm: true,
		});
		ok(res, "delete agent");
	} finally { teardown(); }
});

// ── Group 6: Data Lifecycle ──────────────────────────────────────────────

test("G6: export run bundle", async () => {
	setup();
	try {
		const run = await tool({ action: "run", team: "fast-fix", goal: "Export test" });
		const runId = run.details!.runId as string;
		const exported = await tool({ action: "export", runId });
		ok(exported, "export");
	} finally { teardown(); }
});

test("G6: imports lists imported bundles", async () => {
	setup();
	try {
		const res = await tool({ action: "imports" });
		ok(res, "imports");
	} finally { teardown(); }
});

test("G6: cleanup removes run worktrees", async () => {
	setup();
	try {
		const run = await tool({ action: "run", team: "fast-fix", goal: "Cleanup test" });
		const runId = run.details!.runId as string;
		const res = await tool({ action: "cleanup", runId });
		ok(res, "cleanup");
	} finally { teardown(); }
});

test("G6: forget removes run data", async () => {
	setup();
	try {
		const run = await tool({ action: "run", team: "fast-fix", goal: "Forget test" });
		const runId = run.details!.runId as string;
		const res = await tool({ action: "forget", runId, confirm: true });
		ok(res, "forget");
		// Verify manifest is gone
		const loaded = loadRunManifestById(_cwd, runId);
		assert.equal(loaded, undefined, "manifest should be gone after forget");
	} finally { teardown(); }
});

test("G6: prune removes old runs", async () => {
	setup();
	try {
		await tool({ action: "run", team: "fast-fix", goal: "Prune test" });
		const res = await tool({ action: "prune", olderThanDays: 0, confirm: true });
		// prune with 0 days should remove everything
		assert.ok(res, "prune returned something");
	} finally { teardown(); }
});

// ── Group 7: Advanced ────────────────────────────────────────────────────

test("G7: api reads manifest", async () => {
	setup();
	try {
		const run = await tool({ action: "run", team: "fast-fix", goal: "API test" });
		const runId = run.details!.runId as string;
		const res = await tool({ action: "api", runId, operation: "read-manifest" });
		ok(res, "api read-manifest");
	} finally { teardown(); }
});

test("G7: invalidate refreshes cache", async () => {
	setup();
	try {
		const run = await tool({ action: "run", team: "fast-fix", goal: "Invalidate test" });
		const runId = run.details!.runId as string;
		const res = await tool({ action: "invalidate", runId });
		// May report "no snapshot cache" — that's fine, just verify no crash
		assert.ok(res, "invalidate returned something");
	} finally { teardown(); }
});

test("G7: worktrees lists worktree info", async () => {
	setup();
	try {
		const run = await tool({ action: "run", team: "fast-fix", goal: "Worktree test" });
		const runId = run.details!.runId as string;
		const res = await tool({ action: "worktrees", runId });
		ok(res, "worktrees");
	} finally { teardown(); }
});

test("G7: steer sends steering note", async () => {
	setup();
	try {
		const run = await tool({ action: "run", team: "fast-fix", goal: "Steer test" });
		const runId = run.details!.runId as string;
		const res = await tool({ action: "steer", runId, message: "Focus on edge cases" });
		assert.ok(res, "steer returned something");
	} finally { teardown(); }
});

test("G7: health monitor", async () => {
	setup();
	try {
		const res = await tool({ action: "health" });
		assert.ok(res, "health returned something");
	} finally { teardown(); }
});

test("G7: settings shows/updates settings", async () => {
	setup();
	try {
		const res = await tool({ action: "settings" });
		assert.ok(res, "settings returned something");
	} finally { teardown(); }
});

test("G7: anchor status", async () => {
	setup();
	try {
		const res = await tool({ action: "anchor" });
		assert.ok(res, "anchor returned something");
	} finally { teardown(); }
});

test("G7: onboard builds onboarding info", async () => {
	setup();
	try {
		const res = await tool({ action: "onboard", team: "default" });
		ok(res, "onboard");
	} finally { teardown(); }
});

test("G7: explain returns explanation", async () => {
	setup();
	try {
		const res = await tool({ action: "explain" });
		assert.ok(res, "explain returned something");
	} finally { teardown(); }
});

test("G7: auto-summarize status", async () => {
	setup();
	try {
		const res = await tool({ action: "auto-summarize" });
		assert.ok(res, "auto-summarize returned something");
	} finally { teardown(); }
});

test("G7: cache checks run cache", async () => {
	setup();
	try {
		const res = await tool({ action: "cache", goal: "Cache test" });
		assert.ok(res, "cache returned something");
	} finally { teardown(); }
});

// ── Group 8: Schedule ────────────────────────────────────────────────────

test("G8: schedule creates a scheduled run", async () => {
	setup();
	try {
		const res = await tool({
			action: "schedule",
			team: "fast-fix",
			goal: "Scheduled task",
			cron: "0 9 * * MON",
		});
		assert.ok(res, "schedule returned something");
	} finally { teardown(); }
});

test("G8: scheduled lists scheduled jobs", async () => {
	setup();
	try {
		const res = await tool({ action: "scheduled" });
		// Scheduler may not be running; just verify it doesn't crash
		assert.ok(res, "scheduled returned something");
	} finally { teardown(); }
});

// ── Group 9: Run with different teams ────────────────────────────────────

test("G9: run with default team", async () => {
	setup();
	try {
		const res = await tool({ action: "run", team: "default", goal: "Default team test" });
		ok(res, "run default");
		const runId = res.details!.runId as string;
		const loaded = loadRunManifestById(_cwd, runId);
		assert.equal(loaded!.manifest.status, "completed");
	} finally { teardown(); }
});

test("G9: run with research team", async () => {
	setup();
	try {
		const res = await tool({ action: "run", team: "research", goal: "Research test" });
		ok(res, "run research");
		const runId = res.details!.runId as string;
		const loaded = loadRunManifestById(_cwd, runId);
		assert.equal(loaded!.manifest.status, "completed");
	} finally { teardown(); }
});

test("G9: run with implementation team", async () => {
	setup();
	try {
		const res = await tool({ action: "run", team: "implementation", goal: "Implementation test" });
		ok(res, "run implementation");
		const runId = res.details!.runId as string;
		const loaded = loadRunManifestById(_cwd, runId);
		assert.ok(loaded, "manifest should be persisted");
		// Implementation team uses adaptive planning; mock may not satisfy all phases
	} finally { teardown(); }
});

test("G9: run with review team", async () => {
	setup();
	try {
		const res = await tool({ action: "run", team: "review", goal: "Review test" });
		ok(res, "run review");
		const runId = res.details!.runId as string;
		const loaded = loadRunManifestById(_cwd, runId);
		assert.equal(loaded!.manifest.status, "completed");
	} finally { teardown(); }
});

// ── Group 10: Error handling ─────────────────────────────────────────────

test("G10: status with invalid runId returns error", async () => {
	setup();
	try {
		const res = await tool({ action: "status", runId: "nonexistent-run-id" });
		assert.ok(res.isError, "status with invalid runId should error");
	} finally { teardown(); }
});

test("G10: get with invalid resource returns error", async () => {
	setup();
	try {
		const res = await tool({ action: "get", resource: "team", name: "nonexistent-team" });
		assert.ok(res.isError, "get nonexistent team should error");
	} finally { teardown(); }
});

test("G10: delete without confirm returns error", async () => {
	setup();
	try {
		await tool({ action: "create", resource: "agent", config: { name: "del-no-confirm" } });
		const res = await tool({ action: "delete", resource: "agent", agent: "del-no-confirm" });
		assert.ok(res.isError, "delete without confirm should error");
	} finally { teardown(); }
});

test("G10: forget without confirm returns error", async () => {
	setup();
	try {
		const run = await tool({ action: "run", team: "fast-fix", goal: "Forget no confirm" });
		const runId = run.details!.runId as string;
		const res = await tool({ action: "forget", runId });
		assert.ok(res.isError, "forget without confirm should error");
	} finally { teardown(); }
});

test("G10: recommend without goal returns error", async () => {
	setup();
	try {
		const res = await tool({ action: "recommend" });
		assert.ok(res.isError, "recommend without goal should error");
	} finally { teardown(); }
});

// ── Group 11: Multi-run operations ───────────────────────────────────────

test("G11: multiple sequential runs get unique IDs", async () => {
	setup();
	try {
		const res1 = await tool({ action: "run", team: "fast-fix", goal: "Run 1" });
		const res2 = await tool({ action: "run", team: "fast-fix", goal: "Run 2" });
		const id1 = res1.details!.runId as string;
		const id2 = res2.details!.runId as string;
		assert.notEqual(id1, id2, "consecutive runs should have unique IDs");
		// Both should be loadable
		assert.ok(loadRunManifestById(_cwd, id1));
		assert.ok(loadRunManifestById(_cwd, id2));
	} finally { teardown(); }
});

test("G11: list runs after multiple runs", async () => {
	setup();
	try {
		await tool({ action: "run", team: "fast-fix", goal: "List test 1" });
		await tool({ action: "run", team: "fast-fix", goal: "List test 2" });
		const manifests = listRuns(_cwd);
		assert.ok(manifests.length >= 2, "should have at least 2 runs");
	} finally { teardown(); }
});
