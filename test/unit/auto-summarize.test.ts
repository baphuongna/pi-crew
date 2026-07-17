/**
 * Unit tests for AutoSummarizeService.
 * @see src/runtime/auto-summarize.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { AutoSummarizeService, createAutoSummarizeService, DEFAULT_AUTO_SUMMARIZE_CONFIG } from "../../src/runtime/auto-summarize.ts";
import type { TaskPacket, TaskResult } from "../../src/runtime/handoff-manager.ts";

// Test helpers
function createTaskPacket(overrides: Partial<TaskPacket> = {}): TaskPacket {
	return {
		taskId: "test-task-1",
		runId: "test-run-1",
		goal: "Test task",
		summarizeThreshold: 5000,
		collapseContext: false,
		forceSummarize: false,
		context: {},
		...overrides,
	};
}

function createTaskResult(overrides: Partial<TaskResult> = {}): TaskResult {
	return {
		outcome: "success",
		usage: { inputTokens: 2500, outputTokens: 2500, totalTokens: 5000 },
		duration: 30000,
		iterations: 1,
		toolsUsed: ["read", "write", "bash"],
		blockers: [],
		nextSteps: [],
		filesCreated: [],
		filesModified: [],
		filesDeleted: [],
		decisions: [],
		error: undefined,
		...overrides,
	};
}

// Mock event emitter
function createMockEventEmitter() {
	const emittedEvents: Array<{ event: string; data: unknown }> = [];
	return {
		emittedEvents,
		emitter: {
			emit(event: string, data: unknown) {
				emittedEvents.push({ event, data });
			},
		},
	};
}

test("AutoSummarizeService - isEnabled returns false by default", () => {
	const service = new AutoSummarizeService();

	assert.strictEqual(service.isEnabled(), false);
});

test("AutoSummarizeService - toggle enables when disabled", () => {
	const service = new AutoSummarizeService();

	const newState = service.toggle();

	assert.strictEqual(newState, true);
	assert.strictEqual(service.isEnabled(), true);
});

test("AutoSummarizeService - toggle disables when enabled", () => {
	const service = new AutoSummarizeService();
	service.enable();

	const newState = service.toggle();

	assert.strictEqual(newState, false);
	assert.strictEqual(service.isEnabled(), false);
});

test("AutoSummarizeService - enable sets enabled to true", () => {
	const service = new AutoSummarizeService();

	service.enable();

	assert.strictEqual(service.isEnabled(), true);
});

test("AutoSummarizeService - disable sets enabled to false", () => {
	const service = new AutoSummarizeService();
	service.enable();

	service.disable();

	assert.strictEqual(service.isEnabled(), false);
});

test("AutoSummarizeService - shouldAutoSummarize returns false when disabled", () => {
	const service = new AutoSummarizeService();
	const packet = createTaskPacket();
	const result = createTaskResult({ usage: { totalTokens: 100000 } });

	const should = service.shouldAutoSummarize(packet, result);

	assert.strictEqual(should, false);
});

test("AutoSummarizeService - shouldAutoSummarize returns true when token threshold exceeded", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const packet = createTaskPacket();
	const result = createTaskResult({ usage: { totalTokens: 6000 } });

	const should = service.shouldAutoSummarize(packet, result);

	assert.strictEqual(should, true);
});

test("AutoSummarizeService - shouldAutoSummarize returns true when tools threshold met", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const packet = createTaskPacket();
	const result = createTaskResult({
		usage: { totalTokens: 1000 },
		toolsUsed: ["a", "b", "c", "d", "e"], // 5 tools meets default threshold
	});

	const should = service.shouldAutoSummarize(packet, result);

	assert.strictEqual(should, true);
});

test("AutoSummarizeService - shouldAutoSummarize returns true for high token-to-tool ratio", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const packet = createTaskPacket();
	const result = createTaskResult({
		usage: { totalTokens: 5000 }, // 2500 tokens/tool, high ratio
		toolsUsed: ["a", "b"], // 2 tools
	});

	const should = service.shouldAutoSummarize(packet, result);

	assert.strictEqual(should, true);
});

test("AutoSummarizeService - shouldAutoSummarize returns false below all thresholds", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const packet = createTaskPacket();
	const result = createTaskResult({
		usage: { totalTokens: 1000 },
		toolsUsed: ["read"], // 1 tool, below default 5
	});

	const should = service.shouldAutoSummarize(packet, result);

	assert.strictEqual(should, false);
});

test("AutoSummarizeService - getAutoSummarizeDecision returns correct trigger for token threshold", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const packet = createTaskPacket();
	const result = createTaskResult({ usage: { totalTokens: 6000 } });

	const decision = service.getAutoSummarizeDecision(packet, result);

	assert.strictEqual(decision.shouldSummarize, true);
	assert.strictEqual(decision.trigger, "token_threshold");
	assert.strictEqual(decision.tokenCount, 6000);
});

test("AutoSummarizeService - getAutoSummarizeDecision returns correct trigger for tools threshold", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const packet = createTaskPacket();
	const result = createTaskResult({
		usage: { totalTokens: 1000 },
		toolsUsed: ["a", "b", "c", "d", "e"],
	});

	const decision = service.getAutoSummarizeDecision(packet, result);

	assert.strictEqual(decision.shouldSummarize, true);
	assert.strictEqual(decision.trigger, "tools_threshold");
	assert.strictEqual(decision.toolsUsed, 5);
});

test("AutoSummarizeService - getAutoSummarizeDecision returns correct trigger for high usage", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const packet = createTaskPacket();
	// Use 4000 tokens (< 5000 threshold) and 3 tools to isolate high_usage trigger
	// High usage: tokenCount > 2000 AND tools >= 3 AND tokensPerTool > 1000
	// 4000 tokens with 3 tools = 1333 tokens/tool > 1000 ✓
	const result = createTaskResult({
		usage: { totalTokens: 4000 },
		toolsUsed: ["a", "b", "c"],
	});

	const decision = service.getAutoSummarizeDecision(packet, result);

	assert.strictEqual(decision.shouldSummarize, true);
	assert.strictEqual(decision.trigger, "high_usage");
});

test("AutoSummarizeService - getAutoSummarizeDecision returns false when disabled", () => {
	const service = new AutoSummarizeService(); // disabled
	const packet = createTaskPacket();
	const result = createTaskResult({ usage: { totalTokens: 100000 } });

	const decision = service.getAutoSummarizeDecision(packet, result);

	assert.strictEqual(decision.shouldSummarize, false);
	assert.strictEqual(decision.reason, "auto-summarize is disabled");
	assert.strictEqual(decision.trigger, undefined);
});

test("AutoSummarizeService - getAutoSummarizeDecision returns reason for below threshold", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const packet = createTaskPacket();
	const result = createTaskResult({
		usage: { totalTokens: 1000 },
		toolsUsed: ["read"],
	});

	const decision = service.getAutoSummarizeDecision(packet, result);

	assert.strictEqual(decision.shouldSummarize, false);
	assert.ok(decision.reason.includes("Below thresholds"));
});

test("AutoSummarizeService - getConfig returns current config", () => {
	const service = new AutoSummarizeService({
		config: { enabled: true, threshold: 3000 },
	});

	const config = service.getConfig();

	assert.strictEqual(config.enabled, true);
	assert.strictEqual(config.threshold, 3000);
	assert.strictEqual(config.minToolsUsed, 5);
	assert.strictEqual(config.collapseContext, true);
});

test("AutoSummarizeService - updateConfig can update settings", () => {
	const service = new AutoSummarizeService();
	service.enable();

	service.updateConfig({ threshold: 10000 });

	assert.strictEqual(service.getThreshold(), 10000);
});

test("AutoSummarizeService - updateConfig emits event when enabled changes", () => {
	const { emitter, emittedEvents } = createMockEventEmitter();
	const service = new AutoSummarizeService({ eventEmitter: emitter });

	service.updateConfig({ enabled: true });

	assert.ok(emittedEvents.some((e) => e.event === "auto-summarize:toggled"));
});

test("AutoSummarizeService - getThreshold returns configured threshold", () => {
	const service = new AutoSummarizeService({ config: { threshold: 8000 } });

	assert.strictEqual(service.getThreshold(), 8000);
});

test("AutoSummarizeService - setThreshold updates threshold", () => {
	const service = new AutoSummarizeService();

	service.setThreshold(10000);

	assert.strictEqual(service.getThreshold(), 10000);
});

test("AutoSummarizeService - setThreshold throws for negative value", () => {
	const service = new AutoSummarizeService();

	assert.throws(() => service.setThreshold(-1), Error);
});

test("AutoSummarizeService - getMinToolsUsed returns configured value", () => {
	const service = new AutoSummarizeService({ config: { minToolsUsed: 3 } });

	assert.strictEqual(service.getMinToolsUsed(), 3);
});

test("AutoSummarizeService - setMinToolsUsed updates value", () => {
	const service = new AutoSummarizeService();

	service.setMinToolsUsed(7);

	assert.strictEqual(service.getMinToolsUsed(), 7);
});

test("AutoSummarizeService - setMinToolsUsed throws for negative value", () => {
	const service = new AutoSummarizeService();

	assert.throws(() => service.setMinToolsUsed(-1), Error);
});

test("AutoSummarizeService - shouldCollapseContext returns true by default", () => {
	const service = new AutoSummarizeService();

	assert.strictEqual(service.shouldCollapseContext(), true);
});

test("AutoSummarizeService - shouldCollapseContext reflects config", () => {
	const service = new AutoSummarizeService({
		config: { collapseContext: false },
	});

	assert.strictEqual(service.shouldCollapseContext(), false);
});

test("AutoSummarizeService - toggle emits event", () => {
	const { emitter, emittedEvents } = createMockEventEmitter();
	const service = new AutoSummarizeService({ eventEmitter: emitter });

	service.toggle();

	assert.ok(emittedEvents.some((e) => e.event === "auto-summarize:toggled"));
});

test("AutoSummarizeService - toggle event includes previous state", () => {
	const { emitter, emittedEvents } = createMockEventEmitter();
	const service = new AutoSummarizeService({
		eventEmitter: emitter,
		config: { enabled: true },
	});

	service.toggle();

	const event = emittedEvents.find((e) => e.event === "auto-summarize:toggled");
	assert.ok(event !== undefined);
	assert.strictEqual((event!.data as { previousEnabled: boolean }).previousEnabled, true);
});

test("AutoSummarizeService - setEventEmitter can update emitter", () => {
	const service = new AutoSummarizeService();
	const { emitter: emitter1, emittedEvents: events1 } = createMockEventEmitter();
	const { emitter: emitter2, emittedEvents: events2 } = createMockEventEmitter();

	service.setEventEmitter(emitter1);
	service.toggle();

	service.setEventEmitter(emitter2);
	service.toggle();

	assert.strictEqual(events1.length, 1);
	assert.strictEqual(events2.length, 1);
});

test("AutoSummarizeService - DEFAULT_AUTO_SUMMARIZE_CONFIG has correct values", () => {
	assert.strictEqual(DEFAULT_AUTO_SUMMARIZE_CONFIG.threshold, 5000);
	assert.strictEqual(DEFAULT_AUTO_SUMMARIZE_CONFIG.minToolsUsed, 5);
	assert.strictEqual(DEFAULT_AUTO_SUMMARIZE_CONFIG.collapseContext, true);
});

test("AutoSummarizeService - handles missing usage in result", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const packet = createTaskPacket();
	const result = createTaskResult({ usage: undefined });

	const decision = service.getAutoSummarizeDecision(packet, result);

	assert.strictEqual(decision.tokenCount, 0);
	// No tokens, no tools - should be false
	assert.strictEqual(decision.shouldSummarize, false);
});

test("AutoSummarizeService - handles missing toolsUsed in result", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const packet = createTaskPacket();
	// Use 0 tokens and undefined tools to test edge case
	const result = createTaskResult({
		usage: { totalTokens: 0 },
		toolsUsed: undefined,
	});

	const decision = service.getAutoSummarizeDecision(packet, result);

	assert.strictEqual(decision.toolsUsed, 0);
	// With 0 tokens and 0 tools, should be false
	assert.strictEqual(decision.shouldSummarize, false);
});

test("createAutoSummarizeService factory creates instance", () => {
	const service = createAutoSummarizeService();

	assert.ok(service instanceof AutoSummarizeService);
});

// Edge cases
test("AutoSummarizeService - exact threshold still triggers", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const packet = createTaskPacket({ summarizeThreshold: 5000 });
	const result = createTaskResult({ usage: { totalTokens: 5000 } });

	const should = service.shouldAutoSummarize(packet, result);

	assert.strictEqual(should, true);
});

test("AutoSummarizeService - exact minToolsUsed triggers", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const result = createTaskResult({
		usage: { totalTokens: 100 },
		toolsUsed: ["a", "b", "c", "d", "e"], // Exactly 5
	});

	const should = service.shouldAutoSummarize(createTaskPacket(), result);

	assert.strictEqual(should, true);
});

test("AutoSummarizeService - tokensPerTool threshold calculation", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const result = createTaskResult({
		usage: { totalTokens: 4000 },
		toolsUsed: ["a", "b", "c"],
	});

	const should = service.shouldAutoSummarize(createTaskPacket(), result);

	assert.strictEqual(should, true);
});

test("AutoSummarizeService - below tokensPerTool threshold doesn't trigger high_usage", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const result = createTaskResult({
		usage: { totalTokens: 1500 },
		toolsUsed: ["a", "b", "c"],
	});

	const should = service.shouldAutoSummarize(createTaskPacket(), result);

	assert.strictEqual(should, false);
});

test("AutoSummarizeService - high_usage requires 3+ tools", () => {
	const service = new AutoSummarizeService();
	service.enable();
	const result = createTaskResult({
		usage: { totalTokens: 1500 },
		toolsUsed: ["read"],
	});

	const decision = service.getAutoSummarizeDecision(createTaskPacket(), result);

	assert.strictEqual(decision.shouldSummarize, false);
});

test("AutoSummarizeService - custom minToolsUsed affects threshold", () => {
	const service = new AutoSummarizeService();
	service.enable();
	service.setMinToolsUsed(10);
	const result = createTaskResult({
		usage: { totalTokens: 100 },
		toolsUsed: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], // 10 tools
	});

	const should = service.shouldAutoSummarize(createTaskPacket(), result);

	assert.strictEqual(should, true);
});
