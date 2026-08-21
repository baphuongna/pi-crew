/**
 * Unit tests for `widgetPlacement: "bottom"`: the dock renders inside the
 * crew-vibes footer (dock-footer registry) instead of pi's widget slot, and
 * falls back to the `belowEditor` slot when no footer sink is active.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { createRunManifest } from "../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import { getFooterDockProvider, resetFooterDockRegistry, setFooterDockSinkActive } from "../../../src/ui/dock-footer.ts";
import { resetCrewViewSessionState, setCrewViewSessionState } from "../../../src/ui/inline-panel/view-session-store.ts";
import { stopCrewWidget, updateCrewWidget } from "../../../src/ui/widget/index.ts";
import type { CrewWidgetState } from "../../../src/ui/widget/widget-types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../fixtures/test-tempdir.ts";

const team: TeamConfig = {
	name: "test-team",
	description: "Test team",
	source: "builtin",
	filePath: "test.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

/**
 * Create a run WITH a durable agent record (agents.json), because
 * isDisplayActiveRun hides active runs with zero agents from the widget.
 */
function makeRunWithAgent(cwd: string): { manifest: ReturnType<typeof createRunManifest>["manifest"] } {
	const { manifest } = createRunManifest({ cwd, team, goal: "widget bottom" });
	fs.writeFileSync(
		path.join(manifest.stateRoot, "agents.json"),
		JSON.stringify([
			{
				id: "agent-executor-1",
				taskId: "task_executor_1",
				agent: "executor",
				role: "executor",
				status: "running",
				startedAt: new Date().toISOString(),
				progress: { recentOutput: [] },
			},
		]),
	);
	return { manifest };
}

interface WidgetCall {
	key: string;
	content: unknown;
	options: { placement?: string };
}

function makeHarness(cwd: string): {
	ctx: Parameters<typeof updateCrewWidget>[0];
	widgetCalls: WidgetCall[];
	statusValue: () => string | undefined;
} {
	const widgetCalls: WidgetCall[] = [];
	let statusValue: string | undefined;
	const ui = {
		setWidget: (key: string, content: unknown, options: { placement?: string }) => widgetCalls.push({ key, content, options }),
		setStatus: (_k: string, v: string | undefined) => {
			statusValue = v;
		},
		requestRender: () => undefined,
	} as never;
	const ctx = { cwd, hasUI: true, ui, sessionManager: { getSessionId: () => undefined } } as unknown as Parameters<
		typeof updateCrewWidget
	>[0];
	return { ctx, widgetCalls, statusValue: () => statusValue };
}

function newState(): CrewWidgetState {
	return {
		frame: 0,
		lastVisibility: undefined,
		lastPlacement: undefined,
		lastKey: undefined,
		lastMaxLines: undefined,
		lastCwd: undefined,
		legacyCleared: false,
		notificationCount: 0,
	};
}

function installCallsFor(calls: WidgetCall[], key: string): WidgetCall[] {
	return calls.filter((c) => c.key === key && typeof c.content === "function");
}

test("bottom + sink active: no widget slot, provider registered, dock lines served", () => {
	const cwd = createTrackedTempDir("pi-crew-bottom-");
	resetFooterDockRegistry();
	resetCrewViewSessionState();
	try {
		const { manifest } = makeRunWithAgent(cwd);
		const harness = makeHarness(cwd);
		setFooterDockSinkActive(true);

		updateCrewWidget(harness.ctx, newState(), { widgetPlacement: "bottom" }, undefined, undefined, [manifest]);

		// The dock must NOT be installed as a pi widget slot.
		const activeInstalls = installCallsFor(harness.widgetCalls, "pi-crew-active");
		assert.equal(activeInstalls.length, 0, `bottom mode must not install pi-crew-active, got: ${JSON.stringify(harness.widgetCalls)}`);
		// Legacy placeholder clearing can still happen (it is a clear, not an install).
		const legacyCalls = harness.widgetCalls.filter((c) => c.key === "pi-crew");
		assert.ok(
			legacyCalls.every((c) => c.content === undefined),
			"legacy clears only",
		);

		const provider = getFooterDockProvider();
		assert.ok(provider, "dock provider registered for the footer");
		const lines = provider(100);
		assert.ok(Array.isArray(lines) && lines.length > 0, "provider renders dock lines");
		const joined = lines.join("\n");
		assert.ok(joined.includes("main"), `dock shows the main row:\n${joined}`);
		assert.ok(!joined.includes("\u001b["), "provider emits raw (uncolored) lines for the footer to theme");
	} finally {
		setFooterDockSinkActive(false);
		resetFooterDockRegistry();
		removeTrackedTempDir(cwd);
	}
});

test("bottom without sink: falls back to the belowEditor widget slot", () => {
	const cwd = createTrackedTempDir("pi-crew-bottom-nosink-");
	resetFooterDockRegistry();
	resetCrewViewSessionState();
	try {
		const { manifest } = makeRunWithAgent(cwd);
		const harness = makeHarness(cwd);
		// Sink inactive — crew-vibes footer not installed (e.g. vibes disabled).
		updateCrewWidget(harness.ctx, newState(), { widgetPlacement: "bottom" }, undefined, undefined, [manifest]);

		const activeInstalls = installCallsFor(harness.widgetCalls, "pi-crew-active");
		assert.equal(activeInstalls.length, 1, "widget slot used as fallback");
		assert.equal(activeInstalls[0].options.placement, "belowEditor", "bottom maps to belowEditor for pi's slot");
		assert.equal(getFooterDockProvider(), undefined, "no footer provider when the sink is off");
	} finally {
		resetFooterDockRegistry();
		removeTrackedTempDir(cwd);
	}
});

test("aboveEditor keeps the widget slot even with the sink active", () => {
	const cwd = createTrackedTempDir("pi-crew-above-");
	resetFooterDockRegistry();
	resetCrewViewSessionState();
	try {
		const { manifest } = makeRunWithAgent(cwd);
		const harness = makeHarness(cwd);
		setFooterDockSinkActive(true);

		updateCrewWidget(harness.ctx, newState(), { widgetPlacement: "aboveEditor" }, undefined, undefined, [manifest]);
		const activeInstalls = installCallsFor(harness.widgetCalls, "pi-crew-active");
		assert.equal(activeInstalls.length, 1);
		assert.equal(activeInstalls[0].options.placement, "aboveEditor");
		assert.equal(getFooterDockProvider(), undefined, "sink does not hijack non-bottom placements");
	} finally {
		setFooterDockSinkActive(false);
		resetFooterDockRegistry();
		removeTrackedTempDir(cwd);
	}
});

test("bottom + sink: switching to a no-run state unregisters the provider", () => {
	const cwd = createTrackedTempDir("pi-crew-bottom-empty-");
	resetFooterDockRegistry();
	resetCrewViewSessionState();
	try {
		const { manifest } = makeRunWithAgent(cwd);
		const harness = makeHarness(cwd);
		const state = newState();
		setFooterDockSinkActive(true);

		updateCrewWidget(harness.ctx, state, { widgetPlacement: "bottom" }, undefined, undefined, [manifest]);
		assert.ok(getFooterDockProvider(), "provider present while a run exists");

		// Second tick: nothing left to display (no runs) — dock must vanish.
		updateCrewWidget(harness.ctx, state, { widgetPlacement: "bottom" }, undefined, undefined, []);
		assert.equal(getFooterDockProvider(), undefined, "provider unregistered when there is nothing to paint");
	} finally {
		setFooterDockSinkActive(false);
		resetFooterDockRegistry();
		removeTrackedTempDir(cwd);
	}
});

test("view mode: dock hint advertises esc→back while the view session is active", () => {
	const cwd = createTrackedTempDir("pi-crew-bottom-view-");
	resetFooterDockRegistry();
	resetCrewViewSessionState();
	try {
		const { manifest } = makeRunWithAgent(cwd);
		const harness = makeHarness(cwd);
		setFooterDockSinkActive(true);
		setCrewViewSessionState({ active: true, runId: manifest.runId, taskId: "task_1", mainSessionFile: "/tmp/main.jsonl" });

		updateCrewWidget(harness.ctx, newState(), { widgetPlacement: "bottom" }, undefined, undefined, [manifest]);
		const lines = getFooterDockProvider()?.(100) ?? [];
		assert.ok(
			lines.some((line) => line.includes("agent view — esc back to main")),
			`view hint present:\n${lines.join("\n")}`,
		);
	} finally {
		setFooterDockSinkActive(false);
		resetFooterDockRegistry();
		resetCrewViewSessionState();
		removeTrackedTempDir(cwd);
	}
});

test("stopCrewWidget clears the provider and the slot", () => {
	const cwd = createTrackedTempDir("pi-crew-bottom-stop-");
	resetFooterDockRegistry();
	resetCrewViewSessionState();
	try {
		const { manifest } = makeRunWithAgent(cwd);
		const harness = makeHarness(cwd);
		const state = newState();
		setFooterDockSinkActive(true);

		updateCrewWidget(harness.ctx, state, { widgetPlacement: "bottom" }, undefined, undefined, [manifest]);
		assert.ok(getFooterDockProvider());

		stopCrewWidget(harness.ctx, state, { widgetPlacement: "bottom" });
		assert.equal(getFooterDockProvider(), undefined, "provider removed on stop");
		const cleared = harness.widgetCalls.filter((c) => c.key === "pi-crew-active" && c.content === undefined);
		assert.ok(cleared.length >= 1, "widget slot cleared on stop");
	} finally {
		setFooterDockSinkActive(false);
		resetFooterDockRegistry();
		removeTrackedTempDir(cwd);
	}
});
