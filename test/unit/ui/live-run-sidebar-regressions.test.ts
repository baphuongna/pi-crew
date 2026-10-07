/**
 * Regression pins for the UI-instability wave (real-test 2026-10-07):
 *  - L4: sidebar auto-close deadline must be FIXED on first eligibility —
 *    re-renders with a changed signature must NOT clearTimeout+setTimeout the
 *    full delay again (the deadline used to slide forever on trailing events
 *    and the "3s…" countdown froze).
 *  - L5: render() must read the paint-path accessor (readForRender) ONLY —
 *    never a synchronous refreshIfStale rebuild between paints.
 *  - L6: the pre-load frame and the loaded frame must share ONE stable height
 *    (mirrors run-dashboard's targetHeight() contract) so the overlay anchor
 *    never moves and the differential renderer leaves no ghost footprint.
 *
 * The sidebar is fed an in-memory RunSnapshotCache mock (the extended
 * interface from run-snapshot-cache.ts), so no disk reads happen on the paint
 * path — exactly like production wiring.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { CrewAgentRecord } from "../../../src/runtime/crew-agent-runtime.ts";
import { createRunManifest } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import { LiveRunSidebar } from "../../../src/ui/live-run-sidebar.ts";
import type { RunSnapshotCache } from "../../../src/ui/run-snapshot-cache.ts";
import type { RunUiSnapshot } from "../../../src/ui/snapshot-types.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir } from "../../fixtures/test-tempdir.ts";

const team: TeamConfig = {
	name: "research",
	description: "research",
	source: "builtin",
	filePath: "research.team.md",
	roles: [
		{ name: "explorer", agent: "explorer" },
		{ name: "analyst", agent: "analyst" },
	],
};

const workflow: WorkflowConfig = {
	name: "research",
	description: "research",
	source: "builtin",
	filePath: "research.workflow.md",
	steps: [
		{ id: "explore", role: "explorer", task: "Explore" },
		{ id: "analyze", role: "analyst", dependsOn: ["explore"], task: "Analyze" },
	],
};

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

interface CacheCalls {
	readForRender: number;
	scheduleRefresh: number;
	refreshIfStale: number;
}

/** In-memory cache mock speaking the EXTENDED RunSnapshotCache interface.
 * `refreshIfStale`/`refresh` are spies that would satisfy the OLD (pre-L5)
 * render path, so the "never called" assertions below are real mutation
 * targets: reverting render() to the sync rebuild makes them fire. */
function makeSnapshotCache(initial?: RunUiSnapshot): {
	cache: RunSnapshotCache;
	snapshots: Map<string, RunUiSnapshot>;
	calls: CacheCalls;
} {
	const snapshots = new Map<string, RunUiSnapshot>();
	if (initial) snapshots.set(initial.runId, initial);
	const calls: CacheCalls = { readForRender: 0, scheduleRefresh: 0, refreshIfStale: 0 };
	const cache: RunSnapshotCache = {
		get: (id: string) => snapshots.get(id),
		refresh: (id: string) => {
			const snap = snapshots.get(id);
			if (!snap) throw new Error(`test cache: no entry for ${id}`);
			return snap;
		},
		refreshIfStale: (id: string) => {
			calls.refreshIfStale++;
			const snap = snapshots.get(id);
			if (!snap) throw new Error(`test cache: no entry for ${id}`);
			return snap;
		},
		invalidate: () => undefined,
		snapshotsByKey: () => new Map(snapshots),
		preloadStale: async () => undefined,
		preloadAllStale: async () => undefined,
		scheduleRefresh: () => {
			calls.scheduleRefresh++;
		},
		readForRender: (id: string) => {
			calls.readForRender++;
			return snapshots.get(id);
		},
		isDisposed: () => false,
	};
	return { cache, snapshots, calls };
}

function buildSnapshot(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	signature: string,
	agents: CrewAgentRecord[] = [],
): RunUiSnapshot {
	return {
		runId: manifest.runId,
		cwd: manifest.cwd,
		fetchedAt: Date.now(),
		signature,
		manifest,
		tasks,
		agents,
		progress: { total: tasks.length, completed: 0, running: agents.filter((a) => a.status === "running").length, failed: 0, queued: 0 },
		usage: { tokensIn: 0, tokensOut: 0, toolUses: 0 },
		mailbox: { inboxUnread: 0, outboxPending: 0, needsAttention: 0 },
		recentEvents: [],
		recentOutputLines: [],
	};
}

/** A running-agent record that is inert under applyAttentionState (started at
 * the mocked epoch, so the activity age is always ~0). */
function runningAgent(manifest: TeamRunManifest, n: number): CrewAgentRecord {
	return {
		id: `agent-${n}`,
		runId: manifest.runId,
		taskId: "01_explore",
		agent: "explorer",
		role: "explorer",
		runtime: "child-process",
		status: "running",
		startedAt: new Date(0).toISOString(),
	};
}

function setupRun(label: string): { cwd: string; manifest: TeamRunManifest; tasks: TeamTaskState[] } {
	const cwd = createTrackedTempDir(`pi-crew-sidebar-regressions-${label}-`);
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "sidebar regressions" });
	return { cwd, manifest, tasks };
}

// ─────────────────────────────────────────────────────────────────────────────
// L5 — paint path reads the cache only
// ─────────────────────────────────────────────────────────────────────────────

test("L5: render() reads via readForRender only — never a sync refreshIfStale rebuild", () => {
	const { cwd, manifest, tasks } = setupRun("l5-hit");
	try {
		const snapshot = buildSnapshot({ ...manifest, status: "running" }, tasks, "sig-v1");
		const { cache, calls } = makeSnapshotCache(snapshot);
		const sidebar = new LiveRunSidebar({ cwd, runId: manifest.runId, done: () => undefined, snapshotCache: cache });
		const lines = sidebar.render(80).map(stripAnsi).join("\n");
		assert.ok(!lines.includes("loading…"), "a cache hit must paint the loaded frame, not the pre-load one");
		assert.match(lines, /┣ ACTIVE/, "loaded frame carries the active section");
		assert.ok(calls.readForRender >= 1, "render reads the paint-path accessor");
		assert.equal(calls.refreshIfStale, 0, "L5: the paint path must NOT sync-rebuild via refreshIfStale");
		assert.equal(calls.scheduleRefresh, 0, "a cache hit schedules nothing");
		sidebar.dispose();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("L5: a missing entry paints the pre-load frame and schedules the async fill", () => {
	const { cwd, manifest, tasks } = setupRun("l5-miss");
	try {
		const { cache, snapshots, calls } = makeSnapshotCache();
		const sidebar = new LiveRunSidebar({ cwd, runId: manifest.runId, done: () => undefined, snapshotCache: cache });
		const first = sidebar.render(80).map(stripAnsi).join("\n");
		assert.ok(first.includes("loading…"), "an empty cache paints the pre-load frame");
		assert.ok(calls.readForRender >= 1, "render consulted the paint-path accessor");
		assert.ok(calls.scheduleRefresh >= 1, "a miss must kick the coalesced async refresh or the frame never fills");
		assert.equal(calls.refreshIfStale, 0, "L5: a miss must not fall back to a sync rebuild");
		// The async pipeline fills the entry; the next render paints the loaded frame.
		snapshots.set(manifest.runId, buildSnapshot({ ...manifest, status: "running" }, tasks, "sig-filled"));
		sidebar.invalidate();
		const second = sidebar.render(80).map(stripAnsi).join("\n");
		assert.ok(!second.includes("loading…"), "a filled cache paints the loaded frame");
		sidebar.dispose();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// L6 — one stable height across loading / loaded / shrunk frames
// ─────────────────────────────────────────────────────────────────────────────

test("L6: pre-load, loaded and shrunk frames share ONE stable height (no ghost footprint)", () => {
	const { cwd, manifest, tasks } = setupRun("l6-height");
	try {
		const { cache, snapshots } = makeSnapshotCache();
		const sidebar = new LiveRunSidebar({ cwd, runId: manifest.runId, done: () => undefined, snapshotCache: cache });
		const loading = sidebar.render(80);
		assert.ok(loading.map(stripAnsi).join("\n").includes("loading…"), "pre-load frame");

		// Loaded frame with 8 running agents: enough content rows to exceed the
		// targetHeight() clamp, so the SLICE side of the height lock is exercised.
		const rich = buildSnapshot(
			{ ...manifest, status: "running" },
			tasks,
			"sig-rich",
			Array.from({ length: 8 }, (_, i) => runningAgent(manifest, i + 1)),
		);
		snapshots.set(manifest.runId, rich);
		sidebar.invalidate();
		const loaded = sidebar.render(80);
		assert.match(loaded.map(stripAnsi).join("\n"), /┣ ACTIVE ▸ 8 agents/, "rich loaded frame");

		// Shrunk frame: run drains (0 agents, empty task graph) — the row count
		// collapse that used to leave the ghost footprint below the sidebar.
		snapshots.set(manifest.runId, buildSnapshot({ ...manifest, status: "running" }, [], "sig-shrunk"));
		sidebar.invalidate();
		const shrunk = sidebar.render(80);

		assert.equal(loading.length, loaded.length, `loading(${loading.length}) and loaded(${loaded.length}) heights must match`);
		assert.equal(loaded.length, shrunk.length, `loaded(${loaded.length}) and shrunk(${shrunk.length}) heights must match`);
		assert.ok(loaded.length >= 12, "height is clamped to at least the minimum (12)");
		for (const [label, frame] of [
			["loading", loading],
			["loaded", loaded],
			["shrunk", shrunk],
		] as const) {
			assert.ok((frame.at(-1) ?? "").includes("┗"), `${label} frame keeps the ┗ cap LAST after the height lock`);
		}
		sidebar.dispose();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// L4 — fixed auto-close deadline
// ─────────────────────────────────────────────────────────────────────────────

test("L4: the auto-close deadline is FIXED on first eligibility — trailing re-renders cannot slide it", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { cwd, manifest, tasks } = setupRun("l4-fixed");
	try {
		const snapshot = buildSnapshot({ ...manifest, status: "completed" }, tasks, "sig-t0");
		const { cache } = makeSnapshotCache(snapshot);
		let closes = 0;
		const sidebar = new LiveRunSidebar({
			cwd,
			runId: manifest.runId,
			done: () => {
				closes++;
			},
			config: { autoCloseDashboardMs: 1000 },
			snapshotCache: cache,
		});
		// t=0 — FIRST eligibility: the deadline is captured at 0 + 1000.
		sidebar.render(80);
		assert.equal(closes, 0);
		// Trailing events land every 200ms (< autoCloseMs) and each forces a
		// FRESH render (changed signature). The old code re-armed the FULL delay
		// on every one of these, sliding the deadline to 1800.
		for (let i = 1; i <= 4; i++) {
			t.mock.timers.tick(200);
			snapshot.signature = `sig-t${i}`;
			sidebar.render(80);
			assert.equal(closes, 0, `still open at t=${i * 200}`);
		}
		// t=1000 = firstEligibility + autoCloseMs: the fixed deadline must land.
		t.mock.timers.tick(200);
		assert.equal(closes, 1, "close fires at firstEligibility + autoCloseMs, not at lastRender + autoCloseMs");
		sidebar.dispose();
	} finally {
		t.mock.timers.reset();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("L4: the countdown reads the FIXED deadline (remaining shrinks) and stays inside the frame", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { cwd, manifest, tasks } = setupRun("l4-countdown");
	try {
		const snapshot = buildSnapshot({ ...manifest, status: "completed" }, tasks, "sig-c0");
		const { cache } = makeSnapshotCache(snapshot);
		const sidebar = new LiveRunSidebar({
			cwd,
			runId: manifest.runId,
			done: () => undefined,
			config: { autoCloseDashboardMs: 3000 },
			snapshotCache: cache,
		});
		const atFirst = sidebar.render(80).map(stripAnsi);
		assert.ok(
			atFirst.some((l) => l.includes("auto-close in 3s…")),
			`countdown at first eligibility, got: ${atFirst.join(" | ")}`,
		);
		// Half the window elapses with trailing events re-rendering: the
		// displayed remaining must track the FIXED deadline, not restart at 3s.
		t.mock.timers.tick(1500);
		snapshot.signature = "sig-c1";
		const atHalf = sidebar.render(80).map(stripAnsi);
		const countdownRow = atHalf.find((l) => l.includes("auto-close in"));
		assert.ok(countdownRow?.includes("auto-close in 2s…"), `remaining = deadline - now (ceil), got: ${countdownRow}`);
		// F-6 invariant preserved: the countdown renders INSIDE the frame.
		const countdownIdx = atHalf.findIndex((l) => l.includes("auto-close in"));
		const capIdx = atHalf.findIndex((l) => l.includes("┗"));
		assert.ok(countdownIdx >= 0 && capIdx >= 0 && countdownIdx < capIdx, "countdown precedes the ┗ cap");
		sidebar.dispose();
	} finally {
		t.mock.timers.reset();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("L4: leaving the terminal window cancels the deadline; re-entry captures a NEW one", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { cwd, manifest, tasks } = setupRun("l4-rearm");
	try {
		const snapshot = buildSnapshot({ ...manifest, status: "completed" }, tasks, "sig-d0");
		const { cache } = makeSnapshotCache(snapshot);
		let closes = 0;
		const sidebar = new LiveRunSidebar({
			cwd,
			runId: manifest.runId,
			done: () => {
				closes++;
			},
			config: { autoCloseDashboardMs: 1000 },
			snapshotCache: cache,
		});
		sidebar.render(80); // t=0: eligibility → deadline 1000
		// The run resumes: non-terminal again → the pending close must cancel.
		snapshot.manifest = { ...snapshot.manifest, status: "running" };
		snapshot.signature = "sig-d1";
		sidebar.render(80);
		t.mock.timers.tick(1500); // past the ORIGINAL deadline
		assert.equal(closes, 0, "a cancelled deadline must not fire");
		// Completes again at t=1500 → a NEW deadline at 2500 (not the old 1000).
		snapshot.manifest = { ...snapshot.manifest, status: "completed" };
		snapshot.signature = "sig-d2";
		sidebar.render(80);
		t.mock.timers.tick(999);
		assert.equal(closes, 0, "not before the NEW deadline");
		t.mock.timers.tick(1);
		assert.equal(closes, 1, "re-entry arms a fresh deadline at reEligibility + autoCloseMs");
		sidebar.dispose();
	} finally {
		t.mock.timers.reset();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("L4: active agents reappearing cancels the pending close until they drain", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { cwd, manifest, tasks } = setupRun("l4-agents");
	try {
		const snapshot = buildSnapshot({ ...manifest, status: "completed" }, tasks, "sig-a0");
		const { cache } = makeSnapshotCache(snapshot);
		let closes = 0;
		const sidebar = new LiveRunSidebar({
			cwd,
			runId: manifest.runId,
			done: () => {
				closes++;
			},
			config: { autoCloseDashboardMs: 1000 },
			snapshotCache: cache,
		});
		sidebar.render(80); // t=0: terminal, no agents → deadline 1000
		// An agent is (re)spawned while the run is terminal: eligibility breaks.
		t.mock.timers.tick(200);
		snapshot.agents = [runningAgent(manifest, 1)];
		snapshot.signature = "sig-a1";
		sidebar.render(80);
		t.mock.timers.tick(1200); // past the ORIGINAL deadline
		assert.equal(closes, 0, "the agent window cancels the pending close");
		// The agent drains at t=1400 → a NEW deadline at 2400.
		snapshot.agents = [];
		snapshot.signature = "sig-a2";
		sidebar.render(80);
		t.mock.timers.tick(999);
		assert.equal(closes, 0);
		t.mock.timers.tick(1);
		assert.equal(closes, 1, "drain re-arms a fresh deadline");
		sidebar.dispose();
	} finally {
		t.mock.timers.reset();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
