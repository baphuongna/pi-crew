import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { openTeamDashboard, setTeamCommandsDeps } from "../../../src/extension/registration/commands/shared.ts";
import { saveCrewAgents } from "../../../src/runtime/crew-agent-records.ts";
import { appendMailboxMessage } from "../../../src/state/coordination/mailbox.ts";
import { createRunManifest, saveRunManifest } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { __test__resetDashboardState, RunDashboard, type RunDashboardSelection } from "../../../src/ui/run-dashboard.ts";
import { createRunSnapshotCache } from "../../../src/ui/run-snapshot-cache.ts";
import type { RunUiSnapshot } from "../../../src/ui/snapshot-types.ts";

function run(id: string, status: TeamRunManifest["status"]): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: id,
		team: "default",
		workflow: "default",
		goal: "Test goal",
		status,
		workspaceMode: "single",
		createdAt: "2026-04-26T00:00:00.000Z",
		updatedAt: "2026-04-26T00:00:00.000Z",
		cwd: "/tmp/project",
		stateRoot: "/tmp/state",
		artifactsRoot: "/tmp/artifacts",
		tasksPath: "/tmp/state/tasks.json",
		eventsPath: "/tmp/state/events.jsonl",
		artifacts: [],
	};
}

test("RunDashboard renders and selects runs", () => {
	let selected: RunDashboardSelection | undefined;
	const dashboard = new RunDashboard([run("team_a", "completed"), run("team_b", "failed")], (selection) => {
		selected = selection;
	});
	const lines = dashboard.render(80);
	// RAIL (M4, 2026-09-16): the canopy replaced the `▐ pi-crew · N runs` title row.
	assert.ok(lines.some((line) => line.includes("┏ DASHBOARD ▸ 2 runs")));
	assert.ok(lines.some((line) => line.includes("2 runs")));
	assert.ok(lines.some((line) => line.includes("team_a") && line.includes("completed")));
	assert.ok(lines.some((line) => line.includes("team_a")));
	dashboard.handleInput("j");
	dashboard.handleInput("\r");
	assert.deepEqual(selected, { runId: "team_b", action: "status" });
});

test("RunDashboard renders the canonical canopy + key-hint rows", () => {
	// M1-8: this test used to pass `{ placement: "right" }` and assert only
	// generic strings ("pi-crew", the runId) — it therefore proved nothing
	// about the removed no-op option. The right-vs-center decision is owned by
	// the overlay HOST (`shared.ts` overlayOptions), asserted by the M1-8
	// anchor tests at the bottom of this file.
	const dashboard = new RunDashboard([run("team_title", "running")], () => undefined);
	const lines = dashboard.render(70);
	// `┏ DASHBOARD ▸ <n> runs` is the RAIL canopy; the hint rides its dot-led
	// right segment in the shared `formatHint` format, and the close action
	// lives in the `┗` cap (close LAST).
	assert.ok(
		lines.some((line) => line.includes("┏ DASHBOARD ▸ 1 run")),
		`canonical canopy missing (runs count not rendered): ${JSON.stringify(lines.slice(0, 3))}`,
	);
	assert.ok(
		lines.some((line) => line.includes("1-8 pane · ↑/↓ move · Enter select · ? help")), // width 80: cancel hint budget-gated (US-020; rail test @100 covers it)
		`header hint missing: ${JSON.stringify(lines.slice(0, 3))}`,
	);
	assert.ok(
		lines.some((line) => line.trimEnd().endsWith("┗ R reload · Esc close")),
		`end cap missing: ${JSON.stringify(lines.slice(-2))}`,
	);
});

test("RunDashboard emits health and notification actions", () => {
	const selections: RunDashboardSelection[] = [];
	const dashboard = new RunDashboard([run("team_health", "running")], (selection) => {
		if (selection) selections.push(selection);
	});
	dashboard.handleInput("5");
	dashboard.handleInput("R");
	dashboard.handleInput("5");
	dashboard.handleInput("K");
	dashboard.handleInput("5");
	dashboard.handleInput("D");
	dashboard.handleInput("H");
	assert.deepEqual(
		selections.map((selection) => selection.action),
		["health-recovery", "health-kill-stale", "health-diagnostic-export", "notifications-dismiss"],
	);
});

test("RunDashboard supports phase 5 observability hotkeys", () => {
	let selected: RunDashboardSelection | undefined;
	const dashboard = new RunDashboard([run("team_obs", "running")], (selection) => {
		selected = selection;
	});
	dashboard.handleInput("d");
	assert.deepEqual(selected, { runId: "team_obs", action: "agents" });
	dashboard.handleInput("e");
	assert.deepEqual(selected, { runId: "team_obs", action: "agent-events" });
	dashboard.handleInput("o");
	assert.deepEqual(selected, { runId: "team_obs", action: "agent-output" });
	dashboard.handleInput("v");
	assert.deepEqual(selected, {
		runId: "team_obs",
		action: "agent-transcript",
	});
});

test("RunDashboard renders compact agent preview", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dashboard-agents-"));
	try {
		const manifest = run("team_agents", "running");
		manifest.stateRoot = tmp;
		saveCrewAgents(manifest, [
			{
				id: "team_agents:01",
				runId: "team_agents",
				taskId: "01",
				agent: "executor",
				role: "executor",
				runtime: "child-process",
				status: "running",
				startedAt: "2026-04-26T00:00:00.000Z",
				progress: {
					recentTools: [],
					recentOutput: ["npm test"],
					toolCount: 1,
					currentTool: "bash",
					tokens: 42,
					turns: 2,
					activityState: "active",
				},
			},
		]);
		const dashboard = new RunDashboard([manifest], () => undefined);
		const lines = dashboard.render(120);
		assert.ok(lines.some((line) => line.includes("Agents:")));
		assert.ok(
			lines.some((line) => line.includes("executor▸executor")),
			"RAIL separator `▸`, not the retired `->`",
		);
		assert.ok(lines.some((line) => line.includes("tool=bash")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("RunDashboard renders model and token details from task state", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dashboard-usage-"));
	try {
		const manifest = run("team_usage", "completed");
		manifest.stateRoot = tmp;
		manifest.tasksPath = path.join(tmp, "tasks.json");
		fs.writeFileSync(
			manifest.tasksPath,
			JSON.stringify([
				{
					id: "01",
					status: "completed",
					usage: { input: 1000, output: 250, cacheRead: 750 },
					modelAttempts: [
						{
							model: "configured-provider/configured-model",
							success: true,
							exitCode: 0,
						},
					],
				},
			]),
		);
		saveCrewAgents(manifest, [
			{
				id: "team_usage:01",
				runId: "team_usage",
				taskId: "01",
				agent: "verifier",
				role: "verifier",
				runtime: "child-process",
				status: "completed",
				startedAt: "2026-04-26T00:00:00.000Z",
				completedAt: "2026-04-26T00:00:05.000Z",
				progress: { recentTools: [], recentOutput: [], toolCount: 0 },
			},
		]);
		const dashboard = new RunDashboard([manifest], () => undefined, {}, { showModel: true, showTokens: true });
		const lines = dashboard.render(140);
		// L7 (real-test 2026-10-07): the model renders BARE (agents-pane
		// dialect), never behind the retired `model=` wire prefix.
		assert.ok(
			lines.some((line) => line.includes("configured-provider/configured-model") && !line.includes("model=")),
			`bare model dialect missing: ${JSON.stringify(lines.filter((l) => l.includes("configured")))}`,
		);
		// L7: usage renders in the compact TUI dialect `↑in ↓out`, never
		// `tok=/in=/out=/cache=`. input=1000 → `↑1.0k`, output=250 → `↓250`.
		assert.ok(
			lines.some((line) => line.includes("↑1.0k ↓250") && !line.includes("tok=")),
			`compact usage dialect missing: ${JSON.stringify(lines.filter((l) => l.includes("↑") || l.includes("tok=")))}`,
		);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("RunDashboard switches live snapshot panes and shows mailbox badges", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dashboard-panes-"));
	try {
		fs.mkdirSync(path.join(tmp, ".crew"), { recursive: true });
		const team = {
			name: "pane-team",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "pane-workflow",
			description: "",
			steps: [{ id: "one", role: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd: tmp,
			team,
			workflow,
			goal: "panes",
		});
		saveRunManifest({ ...created.manifest, status: "running" }, { allowTerminalExit: true });
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: created.tasks[0]?.id ?? "one",
				agent: "worker",
				role: "worker",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				progress: {
					recentTools: [],
					recentOutput: ["hello output"],
					toolCount: 1,
					currentTool: "bash",
					activityState: "needs_attention",
				},
			},
		]);
		appendMailboxMessage(created.manifest, {
			direction: "inbox",
			from: "lead",
			to: "worker",
			body: "ping",
		});
		const cache = createRunSnapshotCache(tmp, { ttlMs: 0 });
		const dashboard = new RunDashboard(
			[created.manifest],
			() => undefined,
			{},
			{ snapshotCache: cache, runProvider: () => [created.manifest] },
		);
		dashboard.handleInput("3");
		let lines = dashboard.render(120);
		assert.ok(lines.some((line) => line.includes("Mailbox pane")));
		assert.ok(lines.some((line) => line.includes("↓1 unread")));
		dashboard.handleInput("4");
		lines = dashboard.render(120);
		assert.ok(lines.some((line) => line.includes("Output pane")));
		assert.ok(lines.some((line) => line.includes("hello output")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("RunDashboard renders progress preview", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dashboard-progress-"));
	try {
		const progressPath = path.join(tmp, "progress.md");
		fs.writeFileSync(progressPath, "# Progress\nTask counts: completed=1\n", "utf-8");
		const manifest = run("team_progress", "running");
		manifest.artifactsRoot = tmp;
		manifest.artifacts.push({
			kind: "progress",
			path: progressPath,
			createdAt: "2026-04-26T00:00:00.000Z",
			producer: "test",
			retention: "run",
		});
		const dashboard = new RunDashboard([manifest], () => undefined);
		const lines = dashboard.render(100);
		assert.ok(lines.some((line) => line.includes("Progress:")));
		assert.ok(lines.some((line) => line.includes("Task counts")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── L7/L9 (real-test 2026-10-07): dashboard dialect pins ──────────────────

test("L7/L9: dashboard agent preview speaks the TUI dialect (no wire keys, correct plurals)", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dashboard-dialect-"));
	try {
		const manifest = run("team_dialect", "running");
		manifest.stateRoot = tmp;
		manifest.tasksPath = path.join(tmp, "tasks.json");
		fs.writeFileSync(
			manifest.tasksPath,
			JSON.stringify([
				{
					id: "01",
					status: "running",
					usage: { input: 2800, output: 3715, cost: 0.012 },
					modelAttempts: [{ model: "probe-model", success: true, exitCode: 0 }],
				},
			]),
		);
		saveCrewAgents(manifest, [
			{
				id: "team_dialect:01",
				runId: "team_dialect",
				taskId: "01",
				agent: "executor",
				role: "executor",
				runtime: "child-process",
				status: "running",
				// 344.2s old → formatDuration renders `5m44s` (deterministic for
				// ~800ms of test-run drift).
				startedAt: new Date(Date.now() - 344_200).toISOString(),
				progress: { recentTools: [], recentOutput: [], toolCount: 1, currentTool: "bash", turns: 1, activityState: "active" },
			},
		]);
		const dashboard = new RunDashboard([manifest], () => undefined, {}, { showModel: true, showTokens: true, showTools: true });
		const lines = dashboard.render(140);
		// L7: the retired wire keys must never appear on a rendered row.
		const wire = lines.filter((line) => /tok=|in=|out=|model=|age=/.test(line));
		assert.deepEqual(wire, [], `wire-format keys leaked into rendered rows: ${JSON.stringify(wire)}`);
		// L7: compact usage dialect (compactUsage pattern from live-run-sidebar).
		assert.ok(
			lines.some((line) => line.includes("↑2.8k ↓3.7k $0.012")),
			`compact usage dialect missing: ${JSON.stringify(lines.filter((l) => l.includes("↑")))}`,
		);
		// L7: the model renders bare (agents-pane dialect), age via formatDuration.
		assert.ok(
			lines.some((line) => line.includes("probe-model")),
			"bare model name must render",
		);
		assert.ok(
			lines.some((line) => line.includes("5m44s")),
			`formatDuration age missing: ${JSON.stringify(lines.filter((l) => /\dm\d+s/.test(l)))}`,
		);
		// L9: turns pluralise via formatCount.
		assert.ok(
			lines.some((line) => line.includes("1 turn")),
			"`1 turn` singular missing",
		);
		assert.ok(!lines.some((line) => line.includes("1 turns")), "`1 turns` plural bug present");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── L5 (real-test 2026-10-07): paint path reads cached snapshots only ──────

test("L5: render resolves via readForRender (no sync rebuild); keypress keeps sync refreshIfStale", () => {
	__test__resetDashboardState();
	const manifest = run("team_l5", "completed");
	const snapshot: RunUiSnapshot = {
		runId: manifest.runId,
		cwd: manifest.cwd,
		fetchedAt: Date.now(),
		signature: "sig-l5-1",
		manifest,
		tasks: [],
		agents: [],
		progress: { total: 1, completed: 1, running: 0, failed: 0, queued: 0 },
		usage: { tokensIn: 0, tokensOut: 0, toolUses: 0 },
		mailbox: { inboxUnread: 0, outboxPending: 0, needsAttention: 0 },
		recentEvents: [],
		recentOutputLines: [],
	};
	const calls = { refresh: 0, refreshIfStale: 0, readForRender: 0, scheduleRefresh: 0 };
	const cache = {
		get: (id: string) => (id === snapshot.runId ? snapshot : undefined),
		refresh: () => {
			calls.refresh++;
			return snapshot;
		},
		refreshIfStale: () => {
			calls.refreshIfStale++;
			return snapshot;
		},
		readForRender: (id: string) => {
			calls.readForRender++;
			return id === snapshot.runId ? snapshot : undefined;
		},
		scheduleRefresh: () => {
			calls.scheduleRefresh++;
		},
		invalidate: () => undefined,
		snapshotsByKey: () => new Map([[snapshot.runId, snapshot]]),
		dispose: () => undefined,
	};
	const dashboard = new RunDashboard([manifest], () => undefined, {}, { snapshotCache: cache });
	// The constructor primes via the sync path (cursor restore → groupedRuns →
	// snapshotFor); reset the counters so the assertions below measure the
	// RENDER FRAME only.
	calls.refreshIfStale = 0;
	calls.refresh = 0;
	const lines = dashboard.render(120);
	assert.ok(lines.length > 0, "dashboard must render");
	assert.equal(calls.refreshIfStale, 0, "render must not sync-rebuild via refreshIfStale (L5 paint-path rule)");
	assert.equal(calls.refresh, 0, "render must not force-rebuild via refresh (L5 paint-path rule)");
	assert.ok(calls.readForRender > 0, "render path must resolve through the readForRender paint accessor");
	// Tier 11a (read-your-writes): keypress handlers KEEP the sync path.
	dashboard.handleInput("j");
	assert.ok(calls.refreshIfStale > 0, "keypress path must keep sync refreshIfStale (Tier 11a)");
	dashboard.dispose();
});

// ─── M1-8 (P1-5b): the `placement` no-op option is gone ─────────────────────
//
// The removed `RunDashboardOptions.placement` field was never read by
// RunDashboard; the real right-vs-center decision is made by the overlay HOST
// (`openTeamDashboard` in commands/shared.ts) through `overlayOptions.anchor`.
// These two tests drive the REAL host and capture the options it hands to
// `ctx.ui.custom`, so "the dashboard still opens right/centre correctly" is
// proven against the production code path rather than a render string.
//
// Sandbox: `loadConfig(cwd)` reads `<cwd>/.crew/config.json` and the user
// config under HOME, so both cwd and HOME/USERPROFILE/PI_CREW_HOME are pointed
// at a mkdtemp — nothing is written to the repo or the real ~/.pi.

async function captureDashboardOverlayOptions(
	uiConfig: Record<string, unknown> | undefined,
): Promise<{ overlay?: boolean; overlayOptions?: { anchor?: string; width?: number | string } }> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-anchor-"));
	const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CREW_HOME: process.env.PI_CREW_HOME };
	process.env.HOME = tmp;
	process.env.USERPROFILE = tmp;
	process.env.PI_CREW_HOME = tmp;
	try {
		if (uiConfig) {
			fs.mkdirSync(path.join(tmp, ".crew"), { recursive: true });
			fs.writeFileSync(path.join(tmp, ".crew", "config.json"), JSON.stringify({ ui: uiConfig }), "utf-8");
		}
		const captures: Array<{ overlay?: boolean; overlayOptions?: { anchor?: string; width?: number | string } }> = [];
		const ctx = {
			cwd: tmp,
			hasUI: true,
			ui: {
				// The component factory is never invoked (returning `undefined`
				// breaks the action loop after one dashboard open).
				custom: (_factory: unknown, opts: { overlay?: boolean; overlayOptions?: { anchor?: string } }) => {
					captures.push(opts);
					return Promise.resolve(undefined);
				},
				notify: () => undefined,
			},
		};
		setTeamCommandsDeps({
			startForegroundRun: () => undefined,
			abortForegroundRun: () => false,
			openLiveSidebar: () => undefined,
			getManifestCache: () => ({ list: () => [] }),
		});
		await openTeamDashboard(ctx as never);
		assert.equal(captures.length, 1, "dashboard host opened the overlay exactly once");
		return captures[0] ?? {};
	} finally {
		if (prev.HOME === undefined) delete process.env.HOME;
		else process.env.HOME = prev.HOME;
		if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prev.USERPROFILE;
		if (prev.PI_CREW_HOME === undefined) delete process.env.PI_CREW_HOME;
		else process.env.PI_CREW_HOME = prev.PI_CREW_HOME;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

test("M1-8: ui.dashboardPlacement='right' anchors the overlay top-right (host-owned, not a RunDashboard option)", async () => {
	const opts = await captureDashboardOverlayOptions({ dashboardPlacement: "right" });
	assert.equal(opts.overlay, true, "dashboard still opens as an overlay");
	assert.equal(opts.overlayOptions?.anchor, "top-right", "right placement must anchor top-right");
	assert.equal(typeof opts.overlayOptions?.width, "number", "right panel uses an explicit column width");
});

test("M1-8: default ui.dashboardPlacement='right' anchors the overlay top-right (L3 re-pin)", async () => {
	// L3 (real-test 2026-10-07): the DEFAULT placement moved from "center"
	// (90% overlay that exposed chopped background words at both margins) to
	// the right-anchored panel — re-pinned here so the default can never drift
	// back silently.
	const opts = await captureDashboardOverlayOptions(undefined);
	assert.equal(opts.overlay, true, "dashboard still opens as an overlay");
	assert.equal(opts.overlayOptions?.anchor, "top-right", "default placement must anchor top-right");
	assert.equal(typeof opts.overlayOptions?.width, "number", "default right panel uses an explicit column width");
});
