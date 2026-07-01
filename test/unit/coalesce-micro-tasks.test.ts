import assert from "node:assert/strict";
import test from "node:test";
import { flattenGroupIds, planCoalescedGroups } from "../../src/runtime/coalesce-tasks.ts";
import type { TeamTaskState } from "../../src/state/types.ts";
import type { WorkflowConfig, WorkflowStep } from "../../src/workflows/workflow-config.ts";

function makeTask(id: string, role: string, cwd: string, stepId: string): TeamTaskState {
	return {
		id,
		runId: "run-1",
		stepId,
		role,
		agent: role,
		title: id,
		status: "queued",
		dependsOn: [],
		cwd,
	} as TeamTaskState;
}

function makeStep(id: string, role: string, task: string, output?: string | false): WorkflowStep {
	const base: WorkflowStep = { id, role, task };
	return output !== undefined ? { ...base, output } : base;
}

function makeWorkflow(steps: WorkflowStep[]): WorkflowConfig {
	return {
		name: "test-workflow",
		description: "test",
		source: "user",
		filePath: "/tmp/test/workflow.md",
		steps,
	};
}

test("coalesce: flag off returns empty (caller decides)", () => {
	const tasks = [makeTask("a", "explorer", "/cwd", "step-a")];
	const workflow = makeWorkflow([makeStep("step-a", "explorer", "explore A")]);
	assert.deepEqual(planCoalescedGroups(["a"], tasks, workflow, false), []);
});

test("coalesce: tasks with same role + cwd group together", () => {
	const tasks = [
		makeTask("a", "explorer", "/cwd", "step-a"),
		makeTask("b", "explorer", "/cwd", "step-b"),
		makeTask("c", "explorer", "/cwd", "step-c"),
	];
	const workflow = makeWorkflow([
		makeStep("step-a", "explorer", "explore A"),
		makeStep("step-b", "explorer", "explore B"),
		makeStep("step-c", "explorer", "explore C"),
	]);
	const groups = planCoalescedGroups(["a", "b", "c"], tasks, workflow, true);
	assert.equal(groups.length, 1);
	assert.equal(groups[0]?.id, "a+b+c");
	assert.equal(groups[0]?.tasks.length, 3);
});

test("coalesce: different roles stay in separate groups", () => {
	// MVP (M6 real-dispatch): only READ_ONLY roles are coalescable. executor
	// (write role) is filtered out by planCoalescedGroups. To verify
	// "different roles" still separate groups, use two read-only roles.
	const tasks = [makeTask("a", "explorer", "/cwd", "step-a"), makeTask("b", "reviewer", "/cwd", "step-b")];
	const workflow = makeWorkflow([makeStep("step-a", "explorer", "explore"), makeStep("step-b", "reviewer", "review")]);
	const groups = planCoalescedGroups(["a", "b"], tasks, workflow, true);
	assert.equal(groups.length, 2);
	const ids = groups.flatMap((g) => g.tasks.map((t) => t.id));
	assert.deepEqual(ids.sort(), ["a", "b"]);
});

test("coalesce: different cwds stay in separate groups", () => {
	const tasks = [makeTask("a", "explorer", "/cwd-1", "step-a"), makeTask("b", "explorer", "/cwd-2", "step-b")];
	const workflow = makeWorkflow([makeStep("step-a", "explorer", "explore A"), makeStep("step-b", "explorer", "explore B")]);
	const groups = planCoalescedGroups(["a", "b"], tasks, workflow, true);
	assert.equal(groups.length, 2);
});

test("coalesce: same role + cwd but write-path conflict splits groups", () => {
	// MVP (M6 real-dispatch): any step with explicit output (not false) is
	// filtered out as a safety guard (write-path side effects don't compose
	// in a single multi-task worker). So this test verifies that 2 tasks
	// with explicit output paths return 0 coalescable groups — they fall
	// through to per-task dispatch.
	const tasks = [makeTask("a", "reviewer", "/cwd", "step-a"), makeTask("b", "reviewer", "/cwd", "step-b")];
	const workflow = makeWorkflow([
		makeStep("step-a", "reviewer", "review A", "out.md"),
		makeStep("step-b", "reviewer", "review B", "out.md"), // same output as a → conflict
	]);
	const groups = planCoalescedGroups(["a", "b"], tasks, workflow, true);
	// MVP filters out steps with explicit output paths entirely.
	assert.equal(groups.length, 0);
});

test("coalesce: read-only tasks (no output) coalesce freely", () => {
	const tasks = [makeTask("a", "reviewer", "/cwd", "step-a"), makeTask("b", "reviewer", "/cwd", "step-b")];
	const workflow = makeWorkflow([makeStep("step-a", "reviewer", "review A", false), makeStep("step-b", "reviewer", "review B", false)]);
	const groups = planCoalescedGroups(["a", "b"], tasks, workflow, true);
	assert.equal(groups.length, 1);
	assert.equal(groups[0]?.tasks.length, 2);
});

test("coalesce: tasks missing stepId are skipped (safety)", () => {
	const tasks = [
		makeTask("a", "explorer", "/cwd", "step-a"),
		{ ...makeTask("b", "explorer", "/cwd", "step-b"), stepId: undefined } as TeamTaskState,
	];
	const workflow = makeWorkflow([makeStep("step-a", "explorer", "explore A")]);
	const groups = planCoalescedGroups(["a", "b"], tasks, workflow, true);
	assert.equal(groups.length, 1);
	assert.equal(groups[0]?.tasks.length, 1);
	assert.equal(groups[0]?.tasks[0]?.id, "a");
});

test("coalesce: empty input returns empty", () => {
	const workflow = makeWorkflow([]);
	assert.deepEqual(planCoalescedGroups([], [], workflow, true), []);
});

test("flattenGroupIds: preserves group order and within-group order", () => {
	const tasks = [makeTask("a", "explorer", "/cwd", "step-a"), makeTask("b", "explorer", "/cwd", "step-b")];
	const workflow = makeWorkflow([makeStep("step-a", "explorer", "explore A"), makeStep("step-b", "explorer", "explore B")]);
	const groups = planCoalescedGroups(["a", "b"], tasks, workflow, true);
	assert.deepEqual(flattenGroupIds(groups), ["a", "b"]);
});
