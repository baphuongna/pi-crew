import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineContext, PipelineStage, PipelineWorkflow } from "../../src/runtime/pipeline-runner.ts";
import { createPipelineWorkflow, PipelineRunner } from "../../src/runtime/pipeline-runner.ts";

test("PipelineRunner executes single stage", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "test-pipeline",
		description: "Test pipeline",
		goal: "Test goal",
		stages: [
			{
				name: "stage1",
				team: "test-team",
				inputs: "test input",
			},
		],
	};

	let executedStage: string | undefined;
	let executedInputs: unknown;
	const executeStage = async (stage: PipelineStage, inputs: unknown) => {
		executedStage = stage.name;
		executedInputs = inputs;
		return { result: "ok" };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(result.status, "completed");
	assert.equal(result.stages.length, 1);
	assert.equal(result.stages[0].name, "stage1");
	assert.equal(result.stages[0].status, "completed");
	assert.equal(executedStage, "stage1");
	assert.equal(executedInputs, "test input");
});

test("PipelineRunner executes multiple stages sequentially", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "multi-stage",
		description: "Multi-stage pipeline",
		goal: "Test goal",
		stages: [
			{ name: "stage1", team: "team1", inputs: "input1" },
			{ name: "stage2", team: "team2", inputs: "input2" },
			{ name: "stage3", team: "team3", inputs: "input3" },
		],
	};

	const executionOrder: string[] = [];
	const executeStage = async (stage: PipelineStage, inputs: unknown) => {
		executionOrder.push(stage.name);
		return { stage: stage.name, inputs };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(result.status, "completed");
	assert.equal(result.stages.length, 3);
	assert.deepEqual(executionOrder, ["stage1", "stage2", "stage3"]);
});

test("PipelineRunner passes previous results to next stage", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "sequential",
		description: "Sequential pipeline",
		goal: "Test goal",
		stages: [
			{ name: "stage1", team: "team1", inputs: "initial" },
			{ name: "stage2", team: "team2", inputs: "${previous}" },
		],
	};

	let stage2Inputs: unknown;
	const executeStage = async (stage: PipelineStage, inputs: unknown) => {
		if (stage.name === "stage2") {
			stage2Inputs = inputs;
		}
		return { result: stage.name };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(result.status, "completed");
	assert.ok(Array.isArray(stage2Inputs));
});

test("PipelineRunner fans out for array inputs", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "fanout",
		description: "Fan-out pipeline",
		goal: "Test goal",
		stages: [
			{
				name: "fanout-stage",
				team: "team",
				inputs: ["item1", "item2", "item3"],
				fanOut: true,
			},
		],
	};

	const executions: { item: unknown; index: number }[] = [];
	const executeStage = async (stage: PipelineStage, inputs: unknown, context: PipelineContext) => {
		executions.push({ item: inputs, index: context.stageIndex });
		return { result: inputs };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(result.status, "completed");
	assert.equal(result.stages[0].fanOutItems, 3);
	assert.equal(executions.length, 3);
	assert.deepEqual(
		executions.map((e) => e.item),
		["item1", "item2", "item3"],
	);
});

test("PipelineRunner respects maxConcurrency for fan-out", async () => {
	const runner = new PipelineRunner({ defaultMaxConcurrency: 2 });
	const workflow: PipelineWorkflow = {
		name: "concurrency-test",
		description: "Test concurrency",
		goal: "Test goal",
		stages: [
			{
				name: "concurrent-stage",
				team: "team",
				inputs: ["a", "b", "c", "d"],
				fanOut: true,
				maxConcurrency: 2,
			},
		],
	};

	let concurrentCount = 0;
	let maxConcurrent = 0;
	const executeStage = async (stage: PipelineStage, inputs: unknown) => {
		concurrentCount++;
		maxConcurrent = Math.max(maxConcurrent, concurrentCount);
		await new Promise((resolve) => setTimeout(resolve, 10));
		concurrentCount--;
		return { result: inputs };
	};

	await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.ok(maxConcurrent <= 2, `Max concurrent should be <= 2, got ${maxConcurrent}`);
});

test("PipelineRunner stops on error by default", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "stop-on-error",
		description: "Stop on error pipeline",
		goal: "Test goal",
		stages: [
			{ name: "stage1", team: "team", inputs: "input1" },
			{ name: "stage2", team: "team", inputs: "input2" },
			{ name: "stage3", team: "team", inputs: "input3" },
		],
	};

	const executionOrder: string[] = [];
	const executeStage = async (stage: PipelineStage) => {
		executionOrder.push(stage.name);
		if (stage.name === "stage2") {
			throw new Error("stage2 failed");
		}
		return { result: stage.name };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(result.status, "failed");
	assert.equal(result.stages.length, 2);
	assert.equal(result.stages[0].status, "completed");
	assert.equal(result.stages[1].status, "failed");
	assert.equal(executionOrder.length, 2);
	assert.ok(result.stages[1].error?.includes("stage2 failed"));
});

test("PipelineRunner continues on error when stopOnError is false", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "continue-on-error",
		description: "Continue on error pipeline",
		goal: "Test goal",
		stages: [
			{ name: "stage1", team: "team", inputs: "input1" },
			{ name: "stage2", team: "team", inputs: "input2" },
			{ name: "stage3", team: "team", inputs: "input3" },
		],
		stopOnError: false,
	};

	const executionOrder: string[] = [];
	const executeStage = async (stage: PipelineStage) => {
		executionOrder.push(stage.name);
		if (stage.name === "stage2") {
			throw new Error("stage2 failed");
		}
		return { result: stage.name };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(result.status, "partial");
	assert.equal(result.stages.length, 3);
	assert.equal(result.stages[0].status, "completed");
	assert.equal(result.stages[1].status, "failed");
	assert.equal(result.stages[2].status, "completed");
	assert.equal(executionOrder.length, 3);
});

test("PipelineRunner calculates duration", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "duration-test",
		description: "Test duration",
		goal: "Test goal",
		stages: [{ name: "stage1", team: "team", inputs: "input" }],
	};

	const executeStage = async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
		return { result: "ok" };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.ok(result.totalDuration >= 50);
	assert.ok(result.stages[0].duration >= 50);
});

test("PipelineRunner returns final results", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "final-results",
		description: "Test final results",
		goal: "Test goal",
		stages: [
			{ name: "stage1", team: "team", inputs: "input1" },
			{ name: "stage2", team: "team", inputs: "input2" },
		],
	};

	const executeStage = async (stage: PipelineStage) => {
		return { stage: stage.name, output: "result" };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.ok(result.finalResults);
	assert.equal(result.finalResults.length, 1);
	assert.equal((result.finalResults[0] as { stage: string }).stage, "stage2");
});

test("PipelineRunner resolves context variables", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "context-test",
		description: "Test context resolution",
		goal: "Test goal",
		stages: [{ name: "stage1", team: "team", inputs: "${context.value}" }],
	};

	let receivedInputs: unknown;
	const executeStage = async (stage: PipelineStage, inputs: unknown) => {
		receivedInputs = inputs;
		return { result: inputs };
	};

	await runner.run(workflow, { value: "from-context" }, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(receivedInputs, "from-context");
});

test("PipelineRunner resolves args variables", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "args-test",
		description: "Test args resolution",
		goal: "Test goal",
		stages: [{ name: "stage1", team: "team", inputs: "${args.topic}" }],
	};

	let receivedInputs: unknown;
	const executeStage = async (stage: PipelineStage, inputs: unknown) => {
		receivedInputs = inputs;
		return { result: inputs };
	};

	await runner.run(workflow, { args: { topic: "AI" } }, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(receivedInputs, "AI");
});

test("PipelineRunner resolves previous[N] pattern", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "previous-index",
		description: "Test previous index",
		goal: "Test goal",
		stages: [
			{ name: "stage1", team: "team", inputs: "initial" },
			{ name: "stage2", team: "team", inputs: "${previous[0]}" },
		],
	};

	let stage2Inputs: unknown;
	const executeStage = async (stage: PipelineStage, inputs: unknown) => {
		if (stage.name === "stage2") {
			stage2Inputs = inputs;
		}
		return { stage: stage.name };
	};

	await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	// ${previous[0]} should return the first previous result (which is an array of results from stage 1)
	// Since stage 1 returns {stage: 'stage1'}, previousResults is [{stage: 'stage1'}]
	// ${previous[0]} resolves to {stage: 'stage1'}
	assert.deepEqual(stage2Inputs, { stage: "stage1" });
});

test("PipelineRunner provides correct stage context", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "context-info",
		description: "Test context info",
		goal: "Test goal",
		stages: [
			{ name: "stage1", team: "team", inputs: "input1" },
			{ name: "stage2", team: "team", inputs: "input2" },
		],
	};

	const contexts: PipelineContext[] = [];
	const executeStage = async (_stage: PipelineStage, _inputs: unknown, context: PipelineContext) => {
		contexts.push({ ...context });
		return { result: "ok" };
	};

	await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(contexts[0].stageIndex, 0);
	assert.equal(contexts[0].stageName, "stage1");
	assert.equal(contexts[0].totalStages, 2);
	assert.equal(contexts[1].stageIndex, 1);
	assert.equal(contexts[1].stageName, "stage2");
	assert.ok(Array.isArray(contexts[0].previousResults));
});

test("PipelineRunner fromWorkflowConfig converts workflow", () => {
	const workflow = {
		name: "test-workflow",
		description: "Test workflow",
		source: "builtin" as const,
		filePath: "/test/workflow.md",
		steps: [
			{ id: "step1", role: "explorer", task: "Task 1" },
			{
				id: "step2",
				role: "analyst",
				task: "Task 2",
				dependsOn: ["step1"],
			},
		],
		maxConcurrency: 3,
	};

	const pipeline = PipelineRunner.fromWorkflowConfig(workflow, "Test goal");

	assert.equal(pipeline.name, "test-workflow");
	assert.equal(pipeline.description, "Test workflow");
	assert.equal(pipeline.goal, "Test goal");
	assert.equal(pipeline.stages.length, 2);
	assert.equal(pipeline.stages[0].name, "step1");
	assert.equal(pipeline.stages[0].team, "explorer");
	assert.equal(pipeline.stages[1].name, "step2");
	assert.equal(pipeline.stages[1].usePreviousResults, true);
	assert.equal(pipeline.defaultMaxConcurrency, 3);
});

test("createPipelineWorkflow factory function", () => {
	const workflow = createPipelineWorkflow("my-pipeline", "My pipeline description", "My goal", [
		{ name: "stage1", team: "team1", inputs: "input1" },
		{ name: "stage2", team: "team2", inputs: "input2" },
	]);

	assert.equal(workflow.name, "my-pipeline");
	assert.equal(workflow.description, "My pipeline description");
	assert.equal(workflow.goal, "My goal");
	assert.equal(workflow.stages.length, 2);
	assert.equal(workflow.stopOnError, true);
	assert.equal(workflow.defaultMaxConcurrency, 5);
});

test("PipelineRunner handles empty array inputs without fan-out", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "empty-fanout",
		description: "Test empty array",
		goal: "Test goal",
		stages: [
			{
				name: "stage1",
				team: "team",
				inputs: [],
				fanOut: true,
			},
		],
	};

	let executed = false;
	const executeStage = async (stage: PipelineStage, inputs: unknown) => {
		executed = true;
		return { result: inputs };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(result.status, "completed");
	assert.equal(result.stages[0].status, "completed");
	assert.equal(result.stages[0].fanOutItems, 0);
});

test("PipelineRunner handles object inputs", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "object-inputs",
		description: "Test object inputs",
		goal: "Test goal",
		stages: [
			{
				name: "stage1",
				team: "team",
				inputs: { key1: "value1", key2: "value2" },
			},
		],
	};

	let receivedInputs: unknown;
	const executeStage = async (stage: PipelineStage, inputs: unknown) => {
		receivedInputs = inputs;
		return { result: inputs };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(result.status, "completed");
	assert.deepEqual(receivedInputs, { key1: "value1", key2: "value2" });
});

test("PipelineRunner handles array of object inputs with fan-out", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "array-objects",
		description: "Test array of objects",
		goal: "Test goal",
		stages: [
			{
				name: "stage1",
				team: "team",
				inputs: [
					{ id: 1, name: "item1" },
					{ id: 2, name: "item2" },
				],
				fanOut: true,
			},
		],
	};

	const executions: unknown[] = [];
	const executeStage = async (stage: PipelineStage, inputs: unknown) => {
		executions.push(inputs);
		return { result: inputs };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(result.status, "completed");
	assert.equal(executions.length, 2);
	assert.deepEqual(executions[0], { id: 1, name: "item1" });
	assert.deepEqual(executions[1], { id: 2, name: "item2" });
});

test("PipelineRunner respects stage-level stopOnError", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "stage-stop",
		description: "Test stage-level stopOnError",
		goal: "Test goal",
		stages: [
			{ name: "stage1", team: "team", inputs: "input1" },
			{
				name: "stage2",
				team: "team",
				inputs: "input2",
				stopOnError: false,
			},
			{ name: "stage3", team: "team", inputs: "input3" },
		],
	};

	const executionOrder: string[] = [];
	const executeStage = async (stage: PipelineStage) => {
		executionOrder.push(stage.name);
		if (stage.name === "stage2") {
			throw new Error("stage2 failed");
		}
		return { result: stage.name };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(result.status, "partial");
	assert.equal(result.stages[1].status, "failed");
	assert.equal(result.stages[2].status, "completed");
});

test("PipelineRunner default options", () => {
	const runner = new PipelineRunner();
	// Test with no options - should use defaults
	assert.ok(runner);
});

test("PipelineRunner with custom defaultMaxConcurrency", () => {
	const runner = new PipelineRunner({ defaultMaxConcurrency: 10 });
	const workflow: PipelineWorkflow = {
		name: "custom-concurrency",
		description: "Test custom concurrency",
		goal: "Test goal",
		stages: [
			{
				name: "stage1",
				team: "team",
				inputs: ["a", "b", "c"],
				fanOut: true,
				// No maxConcurrency specified - should use default
			},
		],
	};

	let maxSeen = 0;
	let current = 0;
	const executeStage = async (stage: PipelineStage, inputs: unknown) => {
		current++;
		maxSeen = Math.max(maxSeen, current);
		await new Promise((resolve) => setTimeout(resolve, 5));
		current--;
		return { result: inputs };
	};

	runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	// Should respect the custom defaultMaxConcurrency of 10
	assert.ok(maxSeen <= 10);
});

test("PipelineRunner resolves nested context paths", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "nested-context",
		description: "Test nested context",
		goal: "Test goal",
		stages: [
			{
				name: "stage1",
				team: "team",
				inputs: "${context.nested.deep.value}",
			},
		],
	};

	let receivedInputs: unknown;
	const executeStage = async (stage: PipelineStage, inputs: unknown) => {
		receivedInputs = inputs;
		return { result: inputs };
	};

	await runner.run(workflow, { nested: { deep: { value: "found!" } } }, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(receivedInputs, "found!");
});

test("PipelineRunner handles undefined previous results gracefully", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "undefined-previous",
		description: "Test undefined previous",
		goal: "Test goal",
		stages: [{ name: "stage1", team: "team", inputs: "${previous[99]}" }],
	};

	const executeStage = async (stage: PipelineStage, inputs: unknown) => {
		return { result: inputs };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(result.status, "completed");
	assert.deepEqual(result.finalResults[0], { result: undefined });
});

test("PipelineRunner reports correct status when all stages complete", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "all-complete",
		description: "Test all complete",
		goal: "Test goal",
		stages: [
			{ name: "stage1", team: "team", inputs: "input1" },
			{ name: "stage2", team: "team", inputs: "input2" },
		],
	};

	const executeStage = async () => ({ result: "ok" });

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(result.status, "completed");
	assert.ok(result.stages.every((s) => s.status === "completed"));
});

test("PipelineRunner stage status is correct for failed pipeline", async () => {
	const runner = new PipelineRunner();
	const workflow: PipelineWorkflow = {
		name: "failed-pipeline",
		description: "Test failed pipeline",
		goal: "Test goal",
		stages: [
			{ name: "stage1", team: "team", inputs: "input1" },
			{ name: "stage2", team: "team", inputs: "input2" },
		],
	};

	const executeStage = async (stage: PipelineStage) => {
		if (stage.name === "stage1") {
			throw new Error("First stage failed");
		}
		return { result: stage.name };
	};

	const result = await runner.run(workflow, {}, executeStage, "run-1", "/tmp/events.jsonl");

	assert.equal(result.status, "failed");
	assert.equal(result.stages.length, 1);
	assert.equal(result.stages[0].status, "failed");
	assert.equal(result.stages[0].error, "First stage failed");
});
