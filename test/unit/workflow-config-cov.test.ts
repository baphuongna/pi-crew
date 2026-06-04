import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WorkflowStep, WorkflowConfig } from "../../src/workflows/workflow-config.ts";

describe("WorkflowStep type", () => {
	it("accepts a minimal step with required fields", () => {
		const step: WorkflowStep = {
			id: "step1",
			role: "explorer",
			task: "Explore the codebase",
		};
		assert.equal(step.id, "step1");
		assert.equal(step.role, "explorer");
		assert.equal(step.task, "Explore the codebase");
		assert.equal(step.dependsOn, undefined);
	});

	it("accepts a fully populated step", () => {
		const step: WorkflowStep = {
			id: "step2",
			role: "analyst",
			task: "Analyze results",
			dependsOn: ["step1"],
			parallelGroup: "analysis",
			output: "results.json",
			reads: ["src/**/*.ts"],
			model: "sonnet",
			skills: ["verification"],
			progress: true,
			worktree: true,
			verify: true,
			seedPaths: ["./data"],
			preStepScript: "./scripts/pre.sh",
			preStepArgs: ["--verbose"],
			preStepTimeout: 60000,
		};
		assert.deepEqual(step.dependsOn, ["step1"]);
		assert.equal(step.parallelGroup, "analysis");
		assert.equal(step.output, "results.json");
		assert.equal(step.model, "sonnet");
		assert.equal(step.preStepTimeout, 60000);
	});

	it("allows output to be false to disable output", () => {
		const step: WorkflowStep = {
			id: "silent",
			role: "explorer",
			task: "no output",
			output: false,
		};
		assert.equal(step.output, false);
	});

	it("allows skills to be false to disable role-default skills", () => {
		const step: WorkflowStep = {
			id: "noskills",
			role: "executor",
			task: "run",
			skills: false,
		};
		assert.equal(step.skills, false);
	});

	it("allows reads to be false to disable reading", () => {
		const step: WorkflowStep = {
			id: "noreads",
			role: "writer",
			task: "write",
			reads: false,
		};
		assert.equal(step.reads, false);
	});
});

describe("WorkflowConfig type", () => {
	it("accepts a minimal config", () => {
		const config: WorkflowConfig = {
			name: "test",
			description: "A test config",
			source: "builtin",
			filePath: "/test.workflow.md",
			steps: [],
		};
		assert.equal(config.name, "test");
		assert.equal(config.maxConcurrency, undefined);
	});

	it("accepts a config with maxConcurrency", () => {
		const config: WorkflowConfig = {
			name: "parallel",
			description: "Parallel workflow",
			source: "project",
			filePath: "/parallel.workflow.md",
			steps: [],
			maxConcurrency: 4,
		};
		assert.equal(config.maxConcurrency, 4);
	});

	it("accepts a config with steps", () => {
		const step: WorkflowStep = {
			id: "s1",
			role: "explorer",
			task: "explore",
		};
		const config: WorkflowConfig = {
			name: "stepped",
			description: "Has steps",
			source: "user",
			filePath: "/stepped.workflow.md",
			steps: [step],
		};
		assert.equal(config.steps.length, 1);
		assert.equal(config.steps[0]!.id, "s1");
	});
});
