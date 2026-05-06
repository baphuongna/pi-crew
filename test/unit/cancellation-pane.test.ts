import test from "node:test";
import assert from "node:assert/strict";
import { renderCancellationPane } from "../../src/ui/dashboard-panes/cancellation-pane.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

function makeManifest(overrides: Partial<TeamRunManifest> = {}): TeamRunManifest {
	return {
		runId: "test-run-1",
		cwd: "/tmp",
		team: "test",
		workflow: "default",
		goal: "test",
		status: "running",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		stateRoot: "/tmp/.crew/state/runs/test-run-1",
		artifactsRoot: "/tmp/.crew/artifacts/test-run-1",
		ownerSessionId: "session-a",
		eventsPath: "/tmp/.crew/state/runs/test-run-1/events.jsonl",
		...overrides,
	} as TeamRunManifest;
}

test("cancellation pane shows no cancellations for running run", () => {
	const manifest = makeManifest();
	const tasks: TeamTaskState[] = [];
	const lines = renderCancellationPane(manifest, tasks);
	assert.ok(lines[0].includes("no active cancellations"));
});

test("cancellation pane shows cancelled tasks", () => {
	const manifest = makeManifest({ status: "cancelled" });
	const tasks: TeamTaskState[] = [
		{ id: "01_explore", role: "explorer", agent: "explorer", title: "explore", status: "cancelled", error: "user cancel", dependsOn: [], cwd: "/tmp", runId: "test-run-1" } as TeamTaskState,
	];
	const lines = renderCancellationPane(manifest, tasks);
	assert.ok(lines.some((l) => l.includes("01_explore")));
	assert.ok(lines.some((l) => l.includes("user cancel")));
});