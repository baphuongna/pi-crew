/**
 * Unit tests for the run-workspace filter while an agent session view is
 * open: the dock/powerbar rows must key off the MAIN session's id (the run's
 * owner), never the view session's own id — otherwise the run being viewed
 * disappears from the dock (regression: dock vanished while viewing).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { createRunManifest } from "../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import { getFooterDockProvider, resetFooterDockRegistry, setFooterDockSinkActive } from "../../../src/ui/dock-footer.ts";
import { resetCrewViewSessionState, setCrewViewSessionState } from "../../../src/ui/inline-panel/view-session-store.ts";
import { updateCrewWidget } from "../../../src/ui/widget/index.ts";
import type { CrewWidgetState } from "../../../src/ui/widget/widget-types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../fixtures/test-tempdir.ts";

const team: TeamConfig = {
	name: "test-team",
	description: "Test team",
	source: "builtin",
	filePath: "test.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

function makeRunWithAgent(cwd: string, ownerSessionId: string): ReturnType<typeof createRunManifest>["manifest"] {
	const { manifest } = createRunManifest({ cwd, team, goal: "widget view workspace" });
	manifest.ownerSessionId = ownerSessionId;
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
	return manifest;
}

function makeHarness(
	cwd: string,
	ctxSessionId: string | undefined,
): {
	ctx: Parameters<typeof updateCrewWidget>[0];
	widgetCalls: { key: string; content: unknown }[];
} {
	const widgetCalls: { key: string; content: unknown }[] = [];
	const ui = {
		setWidget: (key: string, content: unknown) => widgetCalls.push({ key, content }),
		setStatus: () => undefined,
		requestRender: () => undefined,
	} as never;
	const ctx = {
		cwd,
		hasUI: true,
		ui,
		sessionManager: { getSessionId: () => ctxSessionId },
	} as unknown as Parameters<typeof updateCrewWidget>[0];
	return { ctx, widgetCalls };
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

test("view open: dock lists the run when mainSessionId matches the run owner", () => {
	const cwd = createTrackedTempDir("pi-crew-vw-");
	resetFooterDockRegistry();
	resetCrewViewSessionState();
	try {
		const manifest = makeRunWithAgent(cwd, "main-session-id");
		const harness = makeHarness(cwd, "view-session-id"); // the VIEW session's own id
		setFooterDockSinkActive(true);
		// View active; return path points at the MAIN session.
		setCrewViewSessionState({
			active: true,
			runId: manifest.runId,
			taskId: "task_executor_1",
			mainSessionFile: "/tmp/main.jsonl",
			mainSessionId: "main-session-id",
		});

		updateCrewWidget(harness.ctx, newState(), { widgetPlacement: "bottom" }, undefined, undefined, [manifest]);

		const provider = getFooterDockProvider();
		assert.ok(provider, "dock provider registered");
		const joined = (provider(100) ?? []).join("\n");
		assert.ok(joined.includes("main"), `dock shows rows despite the view session's own id:\n${joined}`);
	} finally {
		setFooterDockSinkActive(false);
		resetFooterDockRegistry();
		resetCrewViewSessionState();
		removeTrackedTempDir(cwd);
	}
});

test("view open: dock hides the run when mainSessionId is missing or mismatched", () => {
	const cwd = createTrackedTempDir("pi-crew-vw-miss-");
	resetFooterDockRegistry();
	resetCrewViewSessionState();
	try {
		const manifest = makeRunWithAgent(cwd, "other-session-id");
		const harness = makeHarness(cwd, "view-session-id");
		setFooterDockSinkActive(true);
		setCrewViewSessionState({
			active: true,
			runId: manifest.runId,
			taskId: "task_executor_1",
			mainSessionFile: "/tmp/main.jsonl",
			mainSessionId: "main-session-id",
		});

		updateCrewWidget(harness.ctx, newState(), { widgetPlacement: "bottom" }, undefined, undefined, [manifest]);

		const provider = getFooterDockProvider();
		const joined = provider ? (provider(100) ?? []).join("\n") : "";
		assert.ok(!joined.includes("executor"), `foreign run filtered out while viewing:\n${joined}`);
	} finally {
		setFooterDockSinkActive(false);
		resetFooterDockRegistry();
		resetCrewViewSessionState();
		removeTrackedTempDir(cwd);
	}
});

test("not viewing: filter uses the ctx session id as before", () => {
	const cwd = createTrackedTempDir("pi-crew-vw-main-");
	resetFooterDockRegistry();
	resetCrewViewSessionState();
	try {
		const manifest = makeRunWithAgent(cwd, "main-session-id");
		const harness = makeHarness(cwd, "main-session-id");
		setFooterDockSinkActive(true);

		updateCrewWidget(harness.ctx, newState(), { widgetPlacement: "bottom" }, undefined, undefined, [manifest]);

		const provider = getFooterDockProvider();
		assert.ok(provider, "dock provider registered in the main session");
		const joined = (provider(100) ?? []).join("\n");
		assert.ok(joined.includes("main"), `dock shows the main session's run:\n${joined}`);
	} finally {
		setFooterDockSinkActive(false);
		resetFooterDockRegistry();
		resetCrewViewSessionState();
		removeTrackedTempDir(cwd);
	}
});
