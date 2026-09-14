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
import { resetCrewViewSessionState } from "../../../src/ui/inline-panel/view-session-store.ts";
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

test("not viewing: filter uses the ctx session id as before", () => {
	const cwd = createTrackedTempDir("pi-crew-vw-main-");
	resetCrewViewSessionState();
	try {
		const manifest = makeRunWithAgent(cwd, "main-session-id");
		const harness = makeHarness(cwd, "main-session-id");

		updateCrewWidget(harness.ctx, newState(), { widgetPlacement: "bottom" }, undefined, undefined, [manifest]);

		const install = harness.widgetCalls.find((c) => c.key === "pi-crew-active" && typeof c.content === "function");
		assert.ok(install, "widget installed in the main session");
		const factory = install.content as (tui: unknown, theme: unknown) => { render(w: number): string[] };
		const joined = factory({}, undefined).render(100).join("\n");
		assert.ok(joined.includes("main"), `widget shows the main session's run:\n${joined}`);
	} finally {
		resetCrewViewSessionState();
		removeTrackedTempDir(cwd);
	}
});
