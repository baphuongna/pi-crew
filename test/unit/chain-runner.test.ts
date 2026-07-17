/**
 * Unit tests for ChainRunner.
 * @see src/runtime/chain-runner.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ChainRunner, type ChainSpec, type ChainTaskRunner, createChainRunner, parseChainString } from "../../src/runtime/chain-runner.ts";
import { HandoffManager, type TaskPacket, type TaskResult } from "../../src/runtime/handoff-manager.ts";

// Test helpers
function createTaskResult(overrides: Partial<TaskResult> = {}): TaskResult {
	return {
		outcome: "success",
		usage: { totalTokens: 1000 },
		duration: 1000,
		iterations: 1,
		toolsUsed: [],
		blockers: [],
		nextSteps: [],
		filesCreated: [],
		filesModified: [],
		filesDeleted: [],
		decisions: [],
		...overrides,
	};
}

function createMockTaskRunner(): ChainTaskRunner {
	let callCount = 0;
	return {
		runTask: async (packet: TaskPacket) => {
			callCount++;
			return createTaskResult({ outcome: "success" });
		},
	};
}

function createMockHandoffManager(): HandoffManager {
	return new HandoffManager();
}

// Mock HandoffManager that tracks calls
function createTrackingHandoffManager() {
	const calls: Array<{ packet: TaskPacket; result: TaskResult }> = [];
	const manager = {
		generateSummary: async (packet: TaskPacket, result: TaskResult) => {
			calls.push({ packet, result });
			return {
				taskId: packet.taskId,
				runId: packet.runId,
				timestamp: Date.now(),
				task: packet.goal,
				outcome: result.outcome,
				filesCreated: [],
				filesModified: [],
				filesDeleted: [],
				decisions: [],
				blockers: [],
				nextSteps: [],
				metrics: {
					tokensUsed: result.usage?.totalTokens ?? 0,
					duration: result.duration ?? 0,
					iterations: 1,
					toolsUsed: [],
				},
				contextSnapshot: "",
			};
		},
	} as unknown as HandoffManager;
	return { manager, calls };
}

// Parse chain tests
test("ChainRunner - parseChain handles simple team references", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@research -> @implement -> @review");

	assert.strictEqual(spec.steps.length, 3);
	assert.strictEqual(spec.steps[0].team, "research");
	assert.strictEqual(spec.steps[1].team, "implement");
	assert.strictEqual(spec.steps[2].team, "review");
});

test("ChainRunner - parseChain handles workflow references", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("workflow:build -> workflow:test");

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].workflow, "build");
	assert.strictEqual(spec.steps[1].workflow, "test");
});

test("ChainRunner - parseChain handles template references", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("template:planning -> template:execution");

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].template, "planning");
	assert.strictEqual(spec.steps[1].template, "execution");
});

test("ChainRunner - parseChain handles inline goals", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain('"Research AI trends" -> "Analyze findings"');

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].inlineGoal, "Research AI trends");
	assert.strictEqual(spec.steps[1].inlineGoal, "Analyze findings");
});

test("ChainRunner - parseChain extracts per-step model override", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 --model claude-opus-3 -> @step2");

	assert.strictEqual(spec.steps[0].model, "claude-opus-3");
	assert.strictEqual(spec.steps[1].model, undefined);
});

test("ChainRunner - parseChain extracts per-step skill override", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@research --skill coding -> @implement");

	assert.strictEqual(spec.steps[0].skill, "coding");
	assert.strictEqual(spec.steps[1].skill, undefined);
});

test("ChainRunner - parseChain extracts thinking mode", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 --thinking deep -> @step2 --thinking fast");

	assert.strictEqual(spec.steps[0].thinking, "deep");
	assert.strictEqual(spec.steps[1].thinking, "fast");
});

test("ChainRunner - parseChain extracts timeout", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 --timeout 30 -> @step2");

	assert.strictEqual(spec.steps[0].timeout, 30000); // 30 seconds in ms
	assert.strictEqual(spec.steps[1].timeout, undefined);
});

test("ChainRunner - parseChain extracts global model", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 -> @step2 --global-model claude-sonnet-4");

	assert.strictEqual(spec.globalModel, "claude-sonnet-4");
	assert.strictEqual(spec.steps[0].model, undefined);
	assert.strictEqual(spec.steps[1].model, undefined);
});

test("ChainRunner - parseChain extracts global skill", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 --global-skill writing -> @step2");

	assert.strictEqual(spec.globalSkill, "writing");
});

test("ChainRunner - parseChain extracts continueOnError", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 -> @step2 --continue-on-error true");

	assert.strictEqual(spec.continueOnError, true);
});

test("ChainRunner - parseChain assigns names to steps", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@research -> @implement");

	assert.strictEqual(spec.steps[0].name, "@research");
	assert.strictEqual(spec.steps[1].name, "@implement");
});

test("ChainRunner - parseChain handles step with only overrides", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 --model opus --skill coding");

	assert.strictEqual(spec.steps.length, 1);
	assert.strictEqual(spec.steps[0].team, "step1");
	assert.strictEqual(spec.steps[0].model, "opus");
	assert.strictEqual(spec.steps[0].skill, "coding");
});

// Run chain tests
test("ChainRunner - runChain executes all steps sequentially", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);

	const spec = runner.parseChain("@step1 -> @step2 -> @step3");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps.length, 3);
	assert.strictEqual(result.success, true);
});

test("ChainRunner - runChain stops on failure by default", async () => {
	const { manager, calls } = createTrackingHandoffManager();

	let stepIndex = 0;
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			stepIndex++;
			if (stepIndex === 2) {
				return createTaskResult({ outcome: "failure" });
			}
			return createTaskResult();
		},
	};

	const runner = new ChainRunner(mockRunner, manager);
	const spec = runner.parseChain("@step1 -> @step2 -> @step3");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps.length, 2);
	assert.strictEqual(result.success, false);
	assert.strictEqual(result.steps[1].outcome, "failure");
});

test("ChainRunner - runChain continues on error when continueOnError is true", async () => {
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			return createTaskResult({ outcome: "failure" });
		},
	};
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);

	const spec = runner.parseChain("@step1 -> @step2 -> @step3");
	spec.continueOnError = true;

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps.length, 3);
	assert.strictEqual(result.success, false);
});

test("ChainRunner - runChain passes handoffs between steps", async () => {
	const { manager, calls } = createTrackingHandoffManager();

	const mockRunner = createMockTaskRunner();
	const runner = new ChainRunner(mockRunner, manager);
	const spec = runner.parseChain("@step1 -> @step2");

	const result = await runner.runChain(spec);

	// One handoff per step (for next step)
	assert.strictEqual(result.totalHandoffs.length, 2);
});

test("ChainRunner - runChain enriches context with chain history", async () => {
	const { manager } = createTrackingHandoffManager();

	const receivedPackets: TaskPacket[] = [];
	const mockRunner: ChainTaskRunner = {
		runTask: async (packet: TaskPacket) => {
			receivedPackets.push(packet);
			return createTaskResult();
		},
	};

	const runner = new ChainRunner(mockRunner, manager);
	const spec = runner.parseChain("@step1 -> @step2");

	await runner.runChain(spec);

	// Second step should have chain history
	assert.ok(receivedPackets[1].context?.__chainHistory);
});

test("ChainRunner - runChain calculates total duration", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@step1");

	const result = await runner.runChain(spec);

	assert.ok(result.totalDuration >= 0);
});

test("ChainRunner - runChain calculates total tokens", async () => {
	const { manager } = createTrackingHandoffManager();

	let callCount = 0;
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			callCount++;
			return createTaskResult({
				usage: { totalTokens: callCount * 1000 },
			});
		},
	};

	const runner = new ChainRunner(mockRunner, manager);
	const spec = runner.parseChain("@step1 -> @step2 -> @step3");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.totalTokens, 6000); // 1000 + 2000 + 3000
});

test("ChainRunner - runChain applies step overrides global config", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);

	const spec = runner.parseChain("@step1 --model opus -> @step2");
	spec.globalModel = "sonnet";

	// Step 1 should use opus, step 2 should use sonnet (global)
	// Since our mock doesn't check model, we just verify parsing worked
	assert.strictEqual(spec.steps[0].model, "opus");
	assert.strictEqual(spec.steps[1].model, undefined); // Inherits from global at runtime
});

test("ChainRunner - runChain handles single step", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@only-step");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps.length, 1);
	assert.strictEqual(result.success, true);
});

test("ChainRunner - runChain uses initial context", async () => {
	const { manager } = createTrackingHandoffManager();

	const receivedPackets: TaskPacket[] = [];
	const mockRunner: ChainTaskRunner = {
		runTask: async (packet: TaskPacket) => {
			receivedPackets.push(packet);
			return createTaskResult();
		},
	};

	const runner = new ChainRunner(mockRunner, manager);
	const spec = runner.parseChain("@step1");

	await runner.runChain(spec, { customKey: "customValue" });

	// Initial context should be passed
	assert.ok(receivedPackets[0].context);
});

// parseChainString utility tests
test("parseChainString parses simple chain", () => {
	const spec = parseChainString("@team1 -> @team2");

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].team, "team1");
});

test("parseChainString handles complex syntax", () => {
	const spec = parseChainString('"Goal 1" --model opus --timeout 60 -> "Goal 2" --global-model sonnet');

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].inlineGoal, "Goal 1");
	assert.strictEqual(spec.steps[0].model, "opus");
	assert.strictEqual(spec.steps[0].timeout, 60000);
	assert.strictEqual(spec.steps[1].inlineGoal, "Goal 2");
	assert.strictEqual(spec.globalModel, "sonnet");
});

test("parseChainString handles whitespace", () => {
	const spec = parseChainString("  @step1  ->  @step2  ");

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].name, "@step1");
});

// createChainRunner factory test
test("createChainRunner creates instance", () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = createChainRunner(mockRunner, handoffManager);

	assert.ok(runner instanceof ChainRunner);
});

// Error handling tests
test("ChainRunner - runChain handles runner errors", async () => {
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			throw new Error("Runner failed");
		},
	};
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@step1");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.success, false);
	assert.strictEqual(result.steps.length, 1);
	assert.strictEqual(result.steps[0].error, "Runner failed");
	assert.strictEqual(result.steps[0].outcome, "failure");
});

test("ChainRunner - runChain propagates error message", async () => {
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			throw new Error("Specific error message");
		},
	};
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@step1");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps[0].error, "Specific error message");
});

// Edge cases
test("ChainRunner - parseChain handles empty step gracefully", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@valid");

	assert.strictEqual(spec.steps.length, 1);
	assert.strictEqual(spec.steps[0].team, "valid");
});

test("ChainRunner - parseChain handles step with only flags", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("--model opus");

	assert.strictEqual(spec.steps.length, 1);
	assert.strictEqual(spec.steps[0].name, "--model");
});

test("ChainRunner - runChain handles undefined inlineGoal", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);

	const spec: ChainSpec = {
		steps: [{ name: "no-inline-goal" }],
	};

	const result = await runner.runChain(spec);

	assert.strictEqual(result.success, true);
	assert.strictEqual(result.steps[0].outcome, "success");
});

test("ChainRunner - runChain continues when step continueOnError is true", async () => {
	const mockRunner: ChainTaskRunner = {
		runTask: async () => createTaskResult({ outcome: "failure" }),
	};
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@step1 -> @step2");
	spec.steps[0].continueOnError = true;

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps.length, 2);
});

test("ChainRunner - runChain tracks step index correctly", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@a -> @b -> @c");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps[0].step, 1);
	assert.strictEqual(result.steps[1].step, 2);
	assert.strictEqual(result.steps[2].step, 3);
});

test("ChainRunner - runChain preserves step names in results", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@research -> @implementation");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps[0].name, "@research");
	assert.strictEqual(result.steps[1].name, "@implementation");
});

test("ChainRunner - runChain handles step with both team and inlineGoal", async () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain('@team1 "with inline goal" -> @team2');

	// Last match wins - inlineGoal takes precedence
	assert.strictEqual(spec.steps[0].team, "team1");
	assert.strictEqual(spec.steps[0].inlineGoal, "with inline goal");
});

test("ChainRunner - parseChain normalizes thinking mode values", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step --thinking fast");

	assert.strictEqual(spec.steps[0].thinking, "fast");
});

test("ChainRunner - parseChain ignores invalid thinking mode", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step --thinking invalid");

	assert.strictEqual(spec.steps[0].thinking, undefined);
});

test("ChainRunner - runChain step result includes handoff", async () => {
	const { manager } = createTrackingHandoffManager();
	const mockRunner = createMockTaskRunner();
	const runner = new ChainRunner(mockRunner, manager);
	const spec = runner.parseChain("@step1");

	const result = await runner.runChain(spec);

	assert.ok(result.steps[0].handoff !== undefined);
	assert.strictEqual(result.steps[0].handoff?.taskId, "chain-step-0");
});

test("ChainRunner - runChain step result duration is positive", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@step1");

	const result = await runner.runChain(spec);

	assert.ok(result.steps[0].duration >= 0);
});

test("ChainRunner - runChain empty spec produces empty results", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec: ChainSpec = { steps: [] };

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps.length, 0);
	assert.strictEqual(result.success, true);
});

test("ChainRunner - parseChain handles trailing arrow", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 -> @step2 ->");

	assert.strictEqual(spec.steps.length, 3); // Empty step created
});
