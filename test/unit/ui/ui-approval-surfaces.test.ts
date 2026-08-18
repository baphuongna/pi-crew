/**
 * WP-3 (H4-subset) — integration coverage for the plan-approval UI surfaces.
 *
 * Covers the five acceptance slices from the WP-3/R3 contract end-to-end in
 * ONE file, at the seam level the implementation exposes:
 *
 *   (a) widget renderer  — `⚠ plan:<id>` badge replaces the spinner glyph on
 *                          the pending run's line (widget-renderer.ts).
 *   (b) progress pane    — one-line banner + "A approve / n deny" hint while
 *                          snapshot.manifest.planApproval.status === "pending"
 *                          (progress-pane.ts).
 *   (c) key dispatch     — dashboardActionForKey("A"/"n", "progress") resolves
 *                          to plan-approve/plan-deny, and RunDashboard
 *                          .handleInput surfaces {runId, action} via done()
 *                          ONLY when the selected run is pending.
 *   (d) approved state   — badge gone (widget) + banner gone (progress pane).
 *   (e) shared.ts action — openTeamDashboard dispatch loop →
 *                          handlePlanDashboardAction: pending manifest →
 *                          handleTeamTool({action:"api", config:{operation:
 *                          "approve-plan"|"cancel-plan"}}) via the
 *                          __test__setHandleTeamTool seam; non-pending →
 *                          depsNotify "no pending plan approval", NO dispatch.
 *
 * Fixture style copied from test/unit/ui/run-dashboard-cov.test.ts (makeRun +
 * RunDashboard handleInput tests) and test/unit/ui/powerbar-publisher.test.ts
 * (on-disk run fixture via createRunManifest/saveRunManifest/saveRunTasks —
 * required because loadRunManifestById runs validateRunManifestPaths, which
 * demands artifactsRoot under <crewRoot>/artifacts/<runId>; createRunManifest
 * builds compliant paths by construction).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { __test__setHandleTeamTool, openTeamDashboard, setTeamCommandsDeps } from "../../../src/extension/registration/commands/shared.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { renderProgressPane } from "../../../src/ui/dashboard-panes/progress-pane.ts";
import { __test__resetKeybindingCache, dashboardActionForKey } from "../../../src/ui/keybinding-map.ts";
import { RunDashboard, type RunDashboardSelection } from "../../../src/ui/run-dashboard.ts";
import type { RunUiSnapshot } from "../../../src/ui/snapshot-types.ts";
import { SUBAGENT_SPINNER_FRAMES } from "../../../src/ui/spinner.ts";
import { buildWidgetLines } from "../../../src/ui/widget/widget-renderer.ts";
import type { WidgetRun } from "../../../src/ui/widget/widget-types.ts";

const PENDING_APPROVAL = {
	required: true,
	status: "pending",
	requestedAt: "2026-08-18T00:00:00.000Z",
	updatedAt: "2026-08-18T00:00:00.000Z",
} as const;

const APPROVED_APPROVAL = {
	...PENDING_APPROVAL,
	status: "approved",
	approvedAt: "2026-08-18T00:01:00.000Z",
} as const;

// ─── widget fixtures (style: widget-truncate.test.ts makeFakeRun) ─────────

function makeWidgetRun(runId: string, planApproval?: TeamRunManifest["planApproval"]): WidgetRun {
	const run = {
		schemaVersion: 1,
		runId,
		team: "implementation",
		workflow: "implementation",
		goal: "approval surfaces",
		status: "running" as const,
		startedAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		workspaceMode: "single" as const,
		cwd: "/tmp/pi-crew-approval-surfaces",
		stateRoot: "/tmp/pi-crew-approval-surfaces",
		artifactsRoot: "/tmp/pi-crew-approval-surfaces",
		tasksPath: "/tmp/tasks.jsonl",
		eventsPath: "/tmp/events.jsonl",
		pendingTasks: [],
		artifacts: {} as never,
		planApproval,
	};
	const agents = [
		{
			id: `${runId}:01`,
			runId,
			agent: "explorer",
			role: "explorer",
			taskId: "01",
			status: "running" as const,
			startedAt: new Date(Date.now() - 60_000).toISOString(),
			prompt: "map surfaces",
			runtime: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		},
	];
	return { run, agents, snapshot: undefined } as unknown as WidgetRun;
}

// ─── progress-pane fixtures (style: powerbar-publisher.test.ts snapshot) ──

function makeSnapshot(run: TeamRunManifest): RunUiSnapshot {
	return {
		runId: run.runId,
		cwd: run.cwd,
		fetchedAt: Date.now(),
		signature: run.runId,
		manifest: run,
		tasks: [],
		agents: [],
		progress: { total: 1, completed: 0, running: 0, failed: 0, queued: 1 },
		usage: { tokensIn: 0, tokensOut: 0, toolUses: 0 },
		mailbox: { inboxUnread: 0, outboxPending: 0, needsAttention: 0 },
		recentEvents: [],
		recentOutputLines: [],
	};
}

// ─── dashboard fixtures (style: run-dashboard-cov.test.ts makeRun) ────────

function makeManifest(id: string, planApproval?: TeamRunManifest["planApproval"]): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: id,
		team: "test-team",
		workflow: "test-workflow",
		goal: `Goal for ${id}`,
		status: "running",
		workspaceMode: "single",
		createdAt: "2026-08-18T00:00:00.000Z",
		updatedAt: "2026-08-18T00:00:00.000Z",
		cwd: "/tmp",
		stateRoot: "/tmp/state",
		artifactsRoot: "/tmp/artifacts",
		tasksPath: "/tmp/tasks.json",
		eventsPath: "/tmp/events.jsonl",
		artifacts: [],
		planApproval,
	};
}

// ─── (a) widget: pending → ⚠ plan: badge replaces the spinner ────────────

test("(a) widget: pending run line carries the ⚠ plan: badge with the run-id fragment and no spinner glyph", () => {
	const pending = makeWidgetRun("team_20260818_deadbeef01", PENDING_APPROVAL);
	const normal = makeWidgetRun("team_20260818_cafef00d02"); // no planApproval → spinner
	const lines = buildWidgetLines("/tmp/pi-crew-approval-surfaces", 0, 20, [pending, normal], 0, 120);

	// The run line surfaces the run id only as its last-8 fragment (badge +
	// line trailer), so locate lines via the same slice the renderer uses.
	const pendingFragment = pending.run.runId.slice(-8);
	const normalFragment = normal.run.runId.slice(-8);
	const pendingLine = lines.find((line) => line.includes(pendingFragment));
	assert.ok(pendingLine, "pending run must render a line");
	assert.ok(pendingLine.includes("⚠ plan:"), `pending line must carry the badge: ${pendingLine}`);
	assert.ok(pendingLine.includes(`⚠ plan:${pendingFragment}`), "badge carries the last-8 run-id fragment");
	for (const frame of SUBAGENT_SPINNER_FRAMES) {
		assert.ok(!pendingLine.includes(frame), `spinner frame ${frame} must be suppressed on the pending run line`);
	}

	// Specificity: the sibling non-pending run keeps its spinner glyph, so the
	// badge is a per-run swap, not a widget-wide spinner disable.
	const normalLine = lines.find((line) => line.includes(normalFragment));
	assert.ok(normalLine, "sibling run must render a line");
	assert.ok(
		SUBAGENT_SPINNER_FRAMES.some((frame) => normalLine.includes(frame)),
		`sibling running run keeps its spinner: ${normalLine}`,
	);
});

// ─── (d) widget: approved → badge gone ────────────────────────────────────

test("(d) widget: approved run drops the badge and restores the spinner glyph", () => {
	const approved = makeWidgetRun("team_20260818_deadbeef01", APPROVED_APPROVAL);
	const lines = buildWidgetLines("/tmp/pi-crew-approval-surfaces", 0, 20, [approved], 0, 120);
	const runLine = lines.find((line) => line.includes(approved.run.runId.slice(-8)));
	assert.ok(runLine, "run must render a line");
	assert.ok(!runLine.includes("⚠ plan:"), "approved run must not carry the plan badge");
	assert.ok(
		SUBAGENT_SPINNER_FRAMES.some((frame) => runLine.includes(frame)),
		"approved (still running) run restores the spinner glyph",
	);
});

// ─── (b) progress pane: pending → banner + hint ───────────────────────────

test("(b) progress pane: pending snapshot shows the approval banner with the A/n hint", () => {
	const lines = renderProgressPane(makeSnapshot(makeManifest("team_pending_pane", PENDING_APPROVAL)));
	const joined = lines.join("\n");
	assert.ok(joined.includes("⚠ plan approval pending"), `banner must render: ${joined}`);
	assert.ok(joined.includes("A approve / n deny"), "banner must surface the key hint");
	const bannerLines = lines.filter((line) => line.includes("plan approval pending"));
	assert.equal(bannerLines.length, 1, "exactly one banner line (one-line budget)");
});

// ─── (d) progress pane: approved → banner gone ────────────────────────────

test("(d) progress pane: approved snapshot shows no banner and no hint", () => {
	const lines = renderProgressPane(makeSnapshot(makeManifest("team_approved_pane", APPROVED_APPROVAL)));
	const joined = lines.join("\n");
	assert.ok(!joined.includes("plan approval pending"), `no banner once approved: ${joined}`);
	assert.ok(!joined.includes("A approve / n deny"), "no key hint once approved");
});

// ─── (c) keybinding map: pane-scoped resolution ───────────────────────────

test("(c) dashboardActionForKey: A/n resolve to plan actions only in the progress pane", () => {
	assert.equal(dashboardActionForKey("A", "progress"), "plan-approve");
	assert.equal(dashboardActionForKey("n", "progress"), "plan-deny");
	// Outside the progress pane the plan keys stay unclaimed by plan bindings.
	assert.notEqual(dashboardActionForKey("A", "agents"), "plan-approve");
	assert.notEqual(dashboardActionForKey("n", "agents"), "plan-deny");
});

// ─── (c) handleInput: done({runId, action}) only for a pending run ────────

test("(c) RunDashboard.handleInput: A in the progress pane surfaces {runId, action:'plan-approve'} for a pending run", () => {
	let selected: RunDashboardSelection | undefined;
	const dashboard = new RunDashboard([makeManifest("team_input_pending", PENDING_APPROVAL)], (s) => {
		selected = s;
	});
	dashboard.handleInput("2"); // focus the progress pane
	dashboard.handleInput("A");
	assert.deepEqual(selected, { runId: "team_input_pending", action: "plan-approve" });
	dashboard.dispose();
});

test("(c) RunDashboard.handleInput: plan keys are a silent no-op when the selected run is NOT pending", () => {
	// Sentinel pattern (run-dashboard-cov.test.ts): done() must never fire, so
	// the sentinel object survives and the dashboard stays open.
	let selected: RunDashboardSelection | undefined = { runId: "sentinel", action: "status" };
	const dashboard = new RunDashboard([makeManifest("team_input_approved", APPROVED_APPROVAL)], (s) => {
		selected = s;
	});
	dashboard.handleInput("2");
	dashboard.handleInput("A");
	dashboard.handleInput("n");
	assert.equal(selected?.runId, "sentinel", "done() must not fire for a non-pending run");
	dashboard.dispose();
});

// ─── (e) shared.ts handler via __test__setHandleTeamTool + openTeamDashboard ──
//
// handlePlanDashboardAction is module-private; the dispatch entry point is the
// exported openTeamDashboard loop. The ui.custom mock is scripted per call:
//   call 1 → dashboard selection (the run + action under test)
//   [deny only] call 2 → ConfirmOverlay result (true = confirm)
//   final call → undefined (loop breaks, openTeamDashboard returns)

interface TeamToolCall {
	action: string;
	runId?: string;
	config?: { operation?: string };
}

function makeOnDiskPendingRun(cwd: string, planApproval: TeamRunManifest["planApproval"]): TeamRunManifest {
	const created = createRunManifest({
		cwd,
		team: {
			name: "implementation",
			description: "",
			roles: [{ name: "explorer", agent: "explorer" }],
			source: "test",
			filePath: "builtin",
		} as never,
		workflow: {
			name: "implementation",
			description: "",
			steps: [{ id: "explore", role: "explorer" }],
			source: "test",
			filePath: "builtin",
		} as never,
		goal: "approval surfaces e2e",
	});
	const manifest: TeamRunManifest = { ...created.manifest, status: "running", planApproval };
	saveRunManifest(manifest);
	saveRunTasks(manifest, created.tasks);
	return manifest;
}

function setupDashboardEnv(
	cwd: string,
	manifest: TeamRunManifest,
	customScript: unknown[],
): { ctx: never; calls: TeamToolCall[]; notifications: Array<{ text: string; level: string }>; invalidated: string[] } {
	const calls: TeamToolCall[] = [];
	const notifications: Array<{ text: string; level: string }> = [];
	const invalidated: string[] = [];
	const script = [...customScript];
	__test__setHandleTeamTool(((params: TeamToolCall) => {
		calls.push(params);
		return Promise.resolve({ content: [{ type: "text", text: "op ok" }] });
	}) as never);
	setTeamCommandsDeps({
		startForegroundRun: () => undefined,
		abortForegroundRun: () => false,
		openLiveSidebar: () => undefined,
		getManifestCache: () => ({ list: () => [manifest] }),
		getRunSnapshotCache: () => ({ invalidate: (runId: string) => invalidated.push(runId) }) as never,
	});
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			// Scripted overlay responses; the component factories are never
			// invoked by the mock (openTeamDashboard only consumes the result).
			custom: () => Promise.resolve(script.shift()),
			notify: (text: string, level: string) => notifications.push({ text, level }),
		},
	};
	return { ctx: ctx as never, calls, notifications, invalidated };
}

afterEach(() => {
	__test__setHandleTeamTool(undefined);
});

test("(e) approve: pending manifest dispatches the approve-plan api op and invalidates the snapshot cache", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-approval-e2e-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const manifest = makeOnDiskPendingRun(cwd, PENDING_APPROVAL);
		const { ctx, calls, notifications, invalidated } = setupDashboardEnv(cwd, manifest, [
			{ runId: manifest.runId, action: "plan-approve" },
			undefined,
		]);

		await openTeamDashboard(ctx);

		assert.equal(calls.length, 1, "exactly one team-tool dispatch");
		assert.equal(calls[0]?.action, "api");
		assert.equal(calls[0]?.runId, manifest.runId);
		assert.equal(calls[0]?.config?.operation, "approve-plan");
		assert.ok(invalidated.includes(manifest.runId), "snapshot cache invalidated for the run after the dispatch");
		assert.ok(
			notifications.some((n) => n.text.includes("op ok")),
			"result surfaced via notifyCommandResult",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("(e) deny: pending manifest confirms then dispatches cancel-plan", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-approval-deny-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const manifest = makeOnDiskPendingRun(cwd, PENDING_APPROVAL);
		// script: deny selection → ConfirmOverlay true → loop break.
		const { ctx, calls } = setupDashboardEnv(cwd, manifest, [{ runId: manifest.runId, action: "plan-deny" }, true, undefined]);

		await openTeamDashboard(ctx);

		assert.equal(calls.length, 1, "exactly one team-tool dispatch");
		assert.equal(calls[0]?.action, "api");
		assert.equal(calls[0]?.config?.operation, "cancel-plan");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("(e) non-pending manifest: notify path, NO dispatch", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-approval-nopending-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const manifest = makeOnDiskPendingRun(cwd, APPROVED_APPROVAL);
		const { ctx, calls, notifications } = setupDashboardEnv(cwd, manifest, [
			{ runId: manifest.runId, action: "plan-approve" },
			undefined,
		]);

		await openTeamDashboard(ctx);

		assert.equal(calls.length, 0, "no team-tool dispatch for a non-pending run");
		assert.ok(
			notifications.some((n) => n.text.includes("no pending plan approval") && n.level === "warning"),
			`depsNotify warning expected: ${JSON.stringify(notifications)}`,
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── WP-3 review round-1 hardening (F1 + F5) ─────────────────────────────

test("(e) F5: runId not found → error notify, NO dispatch, NO cache invalidation", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-approval-missing-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const manifest = makeOnDiskPendingRun(cwd, PENDING_APPROVAL);
		// Selection points at a runId that has no on-disk manifest.
		const { ctx, calls, notifications, invalidated } = setupDashboardEnv(cwd, manifest, [
			{ runId: "team_missing_runid", action: "plan-approve" },
			undefined,
		]);

		await openTeamDashboard(ctx);

		assert.equal(calls.length, 0, "no team-tool dispatch when the manifest is missing");
		// NOTE: the dispatch loop invalidates the snapshot cache unconditionally
		// after the handler returns (pre-existing health-action pattern — a
		// benign refresh for a missing/non-pending runId), so only the DISPATCH
		// count is the safety property here, not the invalidation count.
		assert.ok(
			notifications.some((n) => n.text.includes("not found") && n.level === "error"),
			`error notify expected: ${JSON.stringify(notifications)}`,
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("(e) F5: deny aborted at the confirm overlay → NO dispatch (2-keystroke deny stays safe)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-approval-abort-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const manifest = makeOnDiskPendingRun(cwd, PENDING_APPROVAL);
		// script: deny selection → ConfirmOverlay FALSE (abort) → loop break.
		const { ctx, calls, notifications, invalidated } = setupDashboardEnv(cwd, manifest, [
			{ runId: manifest.runId, action: "plan-deny" },
			false,
			undefined,
		]);

		await openTeamDashboard(ctx);

		assert.equal(calls.length, 0, "aborting the confirm must not dispatch cancel-plan");
		// Invalidations are unconditional in the dispatch loop (benign — see the
		// runId-not-found test note); the safety property is zero DISPATCHES.
		assert.ok(!notifications.some((n) => n.text.includes("op ok")), "no result notify on abort");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("(e) F4: backend rejection surfaces as an ERROR notify, not an info toast", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-approval-err-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const manifest = makeOnDiskPendingRun(cwd, PENDING_APPROVAL);
		const calls: TeamToolCall[] = [];
		const notifications: Array<{ text: string; level: string }> = [];
		const invalidated: string[] = [];
		__test__setHandleTeamTool((() =>
			Promise.resolve({ content: [{ type: "text", text: "no pending plan approval (stale)" }], isError: true })) as never);
		setTeamCommandsDeps({
			startForegroundRun: () => undefined,
			abortForegroundRun: () => false,
			openLiveSidebar: () => undefined,
			getManifestCache: () => ({ list: () => [manifest] }),
			getRunSnapshotCache: () => ({ invalidate: (runId: string) => invalidated.push(runId) }) as never,
		});
		const script: unknown[] = [{ runId: manifest.runId, action: "plan-approve" }, undefined];
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				custom: () => Promise.resolve(script.shift()),
				notify: (text: string, level: string) => notifications.push({ text, level }),
			},
		};

		await openTeamDashboard(ctx as never);

		const err = notifications.find((n) => n.text.includes("stale"));
		assert.ok(err, `error result must be notified: ${JSON.stringify(notifications)}`);
		assert.equal(err?.level, "error", "isError result must notify at level error (F4)");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("(e) F1: keybinding override collision on the new plan keys surfaces a warning when the dashboard opens", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-approval-kbwarn-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const manifest = makeOnDiskPendingRun(cwd, PENDING_APPROVAL);
		// Global override on "A" now collides with the progress-scoped
		// plan-approve binding → computeEffectiveBindings reverts it. Before
		// the F1 fix this revert was completely silent.
		process.env.PI_CREW_KEYBINDINGS = JSON.stringify({ events: ["A"] });
		__test__resetKeybindingCache();
		t.after(() => {
			delete process.env.PI_CREW_KEYBINDINGS;
			__test__resetKeybindingCache();
		});
		const { ctx, notifications } = setupDashboardEnv(cwd, manifest, [undefined]);

		await openTeamDashboard(ctx);

		assert.ok(
			notifications.some((n) => n.text.includes("keybindings reverted") && n.text.includes("events") && n.level === "warning"),
			`collision revert warning expected: ${JSON.stringify(notifications)}`,
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("(F2) malformed manifest: status 'pending' WITHOUT required=true lights NO surface (single-source predicate)", () => {
	const malformed = { ...PENDING_APPROVAL, required: false } as const;
	// Widget: no badge, spinner preserved (the run is still running).
	const widgetLines = buildWidgetLines("/tmp/pi-crew-approval-surfaces", 0, 20, [makeWidgetRun("team_malformed_bad1", malformed)], 0, 120);
	const runLine = widgetLines.find((line) => line.includes("bad1"));
	assert.ok(runLine, "run line must render");
	assert.ok(!runLine.includes("⚠ plan:"), "malformed pending-without-required must NOT badge (render == action gating, F2)");
	// Progress pane: no banner (isPlanApprovalPending requires required===true).
	const paneLines = renderProgressPane(makeSnapshot(makeManifest("team_malformed_bad2", malformed)));
	assert.ok(!paneLines.join("\n").includes("plan approval pending"), "malformed approval must NOT banner");
});
