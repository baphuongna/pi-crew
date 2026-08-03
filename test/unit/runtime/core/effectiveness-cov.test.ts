import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrewRuntimeConfig } from "../../../../src/config/types.ts";
import {
	effectivenessPolicyDecision,
	evaluateRunEffectiveness,
	formatRunEffectivenessLines,
	resolveEffectivenessGuardMode,
	taskHasObservableWorkerActivity,
} from "../../../../src/runtime/effectiveness.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";

function makeTask(overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id: overrides.id ?? "task_1",
		runId: overrides.runId ?? "run_1",
		role: overrides.role ?? "executor",
		agent: overrides.agent ?? "test-agent",
		title: overrides.title ?? "Test task",
		status: overrides.status ?? "completed",
		dependsOn: overrides.dependsOn ?? [],
		cwd: overrides.cwd ?? "/tmp",
		...overrides,
	};
}

describe("effectiveness", () => {
	describe("taskHasObservableWorkerActivity", () => {
		it("returns false for task with no activity", () => {
			assert.equal(taskHasObservableWorkerActivity(makeTask()), false);
		});

		it("returns true when toolCount > 0", () => {
			assert.equal(
				taskHasObservableWorkerActivity(
					makeTask({
						agentProgress: {
							toolCount: 5,
							recentTools: [],
							recentOutput: [],
						},
					}),
				),
				true,
			);
		});

		it("returns true when usage is present", () => {
			assert.equal(taskHasObservableWorkerActivity(makeTask({ usage: { input: 100, output: 50 } })), true);
		});

		it("returns true when transcriptArtifact is present", () => {
			assert.equal(
				taskHasObservableWorkerActivity(
					makeTask({
						transcriptArtifact: {
							kind: "log",
							path: "/tmp/transcript.md",
							createdAt: "",
							producer: "test",
							retention: "run",
						},
					}),
				),
				true,
			);
		});

		it("returns true when modelAttempts has a success", () => {
			assert.equal(
				taskHasObservableWorkerActivity(
					makeTask({
						modelAttempts: [{ model: "sonnet", success: true }],
					}),
				),
				true,
			);
		});

		it("returns true when jsonEvents is set", () => {
			assert.equal(taskHasObservableWorkerActivity(makeTask({ jsonEvents: 42 })), true);
		});
	});

	describe("resolveEffectivenessGuardMode", () => {
		it("returns 'warn' by default", () => {
			assert.equal(resolveEffectivenessGuardMode(undefined), "warn");
		});

		it("returns configured mode", () => {
			const config = {
				effectivenessGuard: "off",
			} as unknown as CrewRuntimeConfig;
			assert.equal(resolveEffectivenessGuardMode(config), "off");
		});

		it("returns 'off' for explicit_dry_run safety", () => {
			const manifest = {
				runtimeResolution: { safety: "explicit_dry_run" },
			} as unknown as TeamRunManifest;
			assert.equal(resolveEffectivenessGuardMode(undefined, manifest), "off");
		});

		it("returns 'block' when configured", () => {
			const config = {
				effectivenessGuard: "block",
			} as unknown as CrewRuntimeConfig;
			assert.equal(resolveEffectivenessGuardMode(config), "block");
		});

		it("returns 'fail' when configured", () => {
			const config = {
				effectivenessGuard: "fail",
			} as unknown as CrewRuntimeConfig;
			assert.equal(resolveEffectivenessGuardMode(config), "fail");
		});
	});

	describe("evaluateRunEffectiveness", () => {
		it("returns ok when all completed tasks have observable work", () => {
			const result = evaluateRunEffectiveness({
				tasks: [
					makeTask({
						id: "t1",
						status: "completed",
						usage: { input: 100 },
					}),
					makeTask({
						id: "t2",
						status: "completed",
						usage: { input: 200 },
					}),
				],
				executeWorkers: true,
			});
			assert.equal(result.severity, "ok");
			assert.equal(result.completed, 2);
			assert.equal(result.observable, 2);
		});

		it("returns warning when completed tasks lack observable work", () => {
			const result = evaluateRunEffectiveness({
				tasks: [makeTask({ id: "t1", status: "completed" })],
				executeWorkers: true,
			});
			assert.equal(result.severity, "blocked"); // executor role is not read_only, escalates
		});

		it("returns ok when guard is off", () => {
			const result = evaluateRunEffectiveness({
				tasks: [makeTask({ id: "t1", status: "completed" })],
				executeWorkers: true,
				runtimeConfig: {
					effectivenessGuard: "off",
				} as unknown as CrewRuntimeConfig,
			});
			assert.equal(result.severity, "ok");
		});

		it("returns ok when workers not executed", () => {
			const result = evaluateRunEffectiveness({
				tasks: [makeTask({ id: "t1", status: "completed" })],
				executeWorkers: false,
			});
			assert.equal(result.severity, "ok");
			assert.equal(result.workerExecution, "disabled/scaffold");
		});

		it("identifies needs_attention tasks", () => {
			const result = evaluateRunEffectiveness({
				tasks: [
					makeTask({
						id: "t1",
						status: "running",
						agentProgress: {
							toolCount: 0,
							recentTools: [],
							recentOutput: [],
							activityState: "needs_attention",
						},
					}),
				],
				executeWorkers: true,
			});
			assert.deepEqual(result.needsAttentionTaskIds, ["t1"]);
		});

		it("returns failed severity in fail mode", () => {
			const result = evaluateRunEffectiveness({
				tasks: [makeTask({ id: "t1", status: "completed" })],
				executeWorkers: true,
				runtimeConfig: {
					effectivenessGuard: "fail",
				} as unknown as CrewRuntimeConfig,
			});
			assert.equal(result.severity, "failed");
		});
	});

	describe("formatRunEffectivenessLines", () => {
		it("formats summary lines", () => {
			const lines = formatRunEffectivenessLines({
				completed: 5,
				observable: 4,
				noObservedWorkTaskIds: ["t3"],
				needsAttentionTaskIds: [],
				workerExecution: "enabled",
				guardMode: "warn",
				severity: "warning",
			});
			assert.equal(lines.length, 5);
			assert.ok(lines[0].includes("4/5"));
			assert.ok(lines[1].includes("enabled"));
			assert.ok(lines[2].includes("warn"));
		});

		it("shows 'none' for empty lists", () => {
			const lines = formatRunEffectivenessLines({
				completed: 1,
				observable: 1,
				noObservedWorkTaskIds: [],
				needsAttentionTaskIds: [],
				workerExecution: "enabled",
				guardMode: "off",
				severity: "ok",
			});
			assert.ok(lines[3].includes("none"));
			assert.ok(lines[4].includes("none"));
		});
	});

	describe("effectivenessPolicyDecision", () => {
		it("returns undefined for ok severity", () => {
			assert.equal(
				effectivenessPolicyDecision({
					completed: 1,
					observable: 1,
					noObservedWorkTaskIds: [],
					needsAttentionTaskIds: [],
					workerExecution: "enabled",
					guardMode: "off",
					severity: "ok",
				}),
				undefined,
			);
		});

		it("returns notify for warning severity", () => {
			const decision = effectivenessPolicyDecision({
				completed: 1,
				observable: 0,
				noObservedWorkTaskIds: ["t1"],
				needsAttentionTaskIds: [],
				workerExecution: "enabled",
				guardMode: "warn",
				severity: "warning",
			});
			assert.ok(decision);
			assert.equal(decision.action, "notify");
			assert.equal(decision.reason, "ineffective_worker");
		});

		it("returns block for blocked severity", () => {
			const decision = effectivenessPolicyDecision({
				completed: 1,
				observable: 0,
				noObservedWorkTaskIds: ["t1"],
				needsAttentionTaskIds: [],
				workerExecution: "enabled",
				guardMode: "block",
				severity: "blocked",
			});
			assert.ok(decision);
			assert.equal(decision.action, "block");
		});

		it("returns fail for failed severity", () => {
			const decision = effectivenessPolicyDecision({
				completed: 1,
				observable: 0,
				noObservedWorkTaskIds: ["t1"],
				needsAttentionTaskIds: [],
				workerExecution: "enabled",
				guardMode: "fail",
				severity: "failed",
			});
			assert.ok(decision);
			assert.equal(decision.action, "fail");
		});
	});
});
