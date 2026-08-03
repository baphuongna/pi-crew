/**
 * Unit tests for src/runtime/single-agent-compose.ts (ZERO-COVERAGE module).
 *
 * Public API under test:
 *   - composeSingleAgentPrompt(workflow, goal): SingleAgentPrompt
 *
 * These tests exercise the REAL composeSingleAgentPrompt — in particular the
 * topological step ordering (orderSteps) and the prompt assembly with phase
 * markers, role/task/output/reads annotations. They are mutation-sensitive:
 * changing the ordering algorithm, the phase index base, the dependency
 * annotation, or any of the assembled markers will break an assertion.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { composeSingleAgentPrompt } from "../../../../src/runtime/single-agent-compose.ts";
import type { WorkflowConfig, WorkflowStep } from "../../../../src/workflows/workflow-config.ts";

function makeWorkflow(steps: WorkflowStep[], overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
	return {
		name: "release",
		description: "ship a release",
		source: "project",
		filePath: "release.workflow.md",
		steps,
		...overrides,
	};
}

test("composeSingleAgentPrompt: orders steps topologically when declared out of dependency order", () => {
	// Declare steps so B (depends on A) appears BEFORE A. The composer must
	// emit A as Phase 1 and B as Phase 2.
	const steps: WorkflowStep[] = [
		{ id: "build", role: "builder", task: "compile", dependsOn: ["lint"] },
		{ id: "lint", role: "linter", task: "lint sources" },
	];
	const workflow = makeWorkflow(steps);

	const { prompt, stepCount } = composeSingleAgentPrompt(workflow, "release v1");

	assert.equal(stepCount, 2, "stepCount equals number of steps");
	// Topological order: lint (no deps) first, then build (depends on lint).
	const lintIdx = prompt.indexOf("### Phase 1: lint");
	const buildIdx = prompt.indexOf("### Phase 2: build");
	assert.notEqual(lintIdx, -1, "lint is emitted as Phase 1");
	assert.notEqual(buildIdx, -1, "build is emitted as Phase 2");
	assert.ok(lintIdx < buildIdx, "lint phase precedes build phase");
	// Dependency annotation must reference the dependency by id.
	assert.ok(prompt.includes("(after: lint)"), "build phase annotates its dependency");
});

test("composeSingleAgentPrompt: assembles header, goal, role/task/output/reads markers", () => {
	const steps: WorkflowStep[] = [
		{
			id: "design",
			role: "architect",
			task: "write the design doc",
			output: "docs/design.md",
			reads: ["README.md", "ROADMAP.md"],
		},
	];
	const workflow = makeWorkflow(steps, { name: "telemetry", description: "add telemetry" });

	const { prompt, stepCount } = composeSingleAgentPrompt(workflow, "ship telemetry MVP");

	assert.equal(stepCount, 1);
	// Header lines (exact fragments the module emits).
	assert.ok(prompt.startsWith("# Single-agent workflow execution: telemetry"), "title header uses workflow name");
	assert.ok(prompt.includes("Workflow: telemetry — add telemetry"), "workflow name + description line");
	// Goal section.
	assert.ok(prompt.includes("## Goal"), "goal section present");
	assert.ok(prompt.includes("ship telemetry MVP"), "goal text embedded");
	// Execution plan section.
	assert.ok(prompt.includes("## Execution plan"), "execution plan section present");
	// Phase 1 markers — index is 1-based.
	assert.ok(prompt.includes("### Phase 1: design"), "phase marker 1-based with step id");
	assert.ok(prompt.includes("Role: architect"), "role line");
	assert.ok(prompt.includes("Task: write the design doc"), "task line");
	assert.ok(prompt.includes("Output: write your result to `docs/design.md`"), "output line with backticked artifact");
	assert.ok(prompt.includes("Read first: README.md, ROADMAP.md"), "reads line joins with comma+space");
	// Closing summary section.
	assert.ok(prompt.includes("## After all phases"), "closing section present");
});

test("composeSingleAgentPrompt: preserves declaration order when no dependencies exist", () => {
	const steps: WorkflowStep[] = [
		{ id: "alpha", role: "r1", task: "t1" },
		{ id: "beta", role: "r2", task: "t2" },
		{ id: "gamma", role: "r3", task: "t3" },
	];
	const workflow = makeWorkflow(steps);

	const { prompt, stepCount } = composeSingleAgentPrompt(workflow, "g");

	assert.equal(stepCount, 3);
	// Without dependencies, order is stable (declaration order) — Phase indices
	// match the input order.
	assert.ok(prompt.indexOf("### Phase 1: alpha") < prompt.indexOf("### Phase 2: beta"));
	assert.ok(prompt.indexOf("### Phase 2: beta") < prompt.indexOf("### Phase 3: gamma"));
	// No dependency annotation should appear for dependency-free steps.
	assert.ok(!prompt.includes("(after:"), "no dependency annotation for independent steps");
});

test("composeSingleAgentPrompt: edge case — empty steps yields stepCount 0 and no phase markers", () => {
	const workflow = makeWorkflow([]);

	const { prompt, stepCount } = composeSingleAgentPrompt(workflow, "nothing to do");

	assert.equal(stepCount, 0, "zero steps → stepCount 0");
	assert.ok(!prompt.includes("### Phase"), "no phase markers emitted");
	// Header + goal + plan sections still present (structure, not steps).
	assert.ok(prompt.includes("# Single-agent workflow execution: release"));
	assert.ok(prompt.includes("nothing to do"));
});

test("composeSingleAgentPrompt: transitive dependencies resolve across a chain", () => {
	// Declare a 3-node chain in reverse so a single pass that only follows
	// direct dependsOn would still need to recurse: C -> B -> A.
	const steps: WorkflowStep[] = [
		{ id: "deploy", role: "ops", task: "deploy", dependsOn: ["test"] },
		{ id: "test", role: "qa", task: "run tests", dependsOn: ["build"] },
		{ id: "build", role: "dev", task: "build" },
	];
	const workflow = makeWorkflow(steps);

	const { prompt } = composeSingleAgentPrompt(workflow, "ship");

	// Full transitive order: build → test → deploy.
	const build = prompt.indexOf("### Phase 1: build");
	const ttest = prompt.indexOf("### Phase 2: test");
	const deploy = prompt.indexOf("### Phase 3: deploy");
	assert.notEqual(build, -1);
	assert.notEqual(ttest, -1);
	assert.notEqual(deploy, -1);
	assert.ok(build < ttest && ttest < deploy, "transitive chain ordered build -> test -> deploy");
});

test("composeSingleAgentPrompt: output:false is omitted (not written as an artifact path)", () => {
	// output is `string | false`; false should NOT emit an Output line.
	const steps: WorkflowStep[] = [{ id: "noop", role: "r", task: "t", output: false }];
	const workflow = makeWorkflow(steps);

	const { prompt } = composeSingleAgentPrompt(workflow, "g");

	assert.ok(prompt.includes("### Phase 1: noop"), "step present");
	assert.ok(!prompt.includes("Output: write your result to"), "output:false does not emit an artifact line");
});
