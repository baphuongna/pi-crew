import test from "node:test";
import assert from "node:assert/strict";
import { __test__mergeTaskUpdates } from "../../src/runtime/team-runner.ts";
import type { TeamTaskState } from "../../src/state/types.ts";

function task(id: string, status: TeamTaskState["status"]): TeamTaskState {
	return {
		id,
		runId: "run_merge",
		stepId: id,
		role: "explorer",
		agent: "explorer",
		title: id,
		status,
		dependsOn: [],
		cwd: "/tmp/project",
		graph: { taskId: id, children: [], dependencies: [], queue: status === "queued" ? "ready" : status === "running" ? "running" : "done" },
	};
}

test("parallel task merge does not regress completed tasks from stale worker snapshots", () => {
	const base = [task("a", "queued"), task("b", "queued")];
	const resultA = { tasks: [{ ...task("a", "completed"), finishedAt: "2026-01-01T00:00:00.000Z" }, task("b", "running")] };
	const resultB = { tasks: [task("a", "running"), { ...task("b", "completed"), finishedAt: "2026-01-01T00:00:01.000Z" }] };
	const merged = __test__mergeTaskUpdates(base, [resultA, resultB]);
	assert.equal(merged.find((item) => item.id === "a")?.status, "completed");
	assert.equal(merged.find((item) => item.id === "b")?.status, "completed");
});
