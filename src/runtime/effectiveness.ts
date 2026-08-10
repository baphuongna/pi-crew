import type { CrewRuntimeConfig } from "../config/config.ts";
import type { PolicyDecision, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { permissionForRole } from "./role-permission.ts";

export type EffectivenessGuardMode = "off" | "warn" | "block" | "fail";
export type WorkerExecutionState = "enabled" | "disabled/scaffold";
export type RunEffectivenessSeverity = "ok" | "warning" | "blocked" | "failed";

export interface RunEffectivenessSummary {
	completed: number;
	observable: number;
	noObservedWorkTaskIds: string[];
	needsAttentionTaskIds: string[];
	workerExecution: WorkerExecutionState;
	guardMode: EffectivenessGuardMode;
	severity: RunEffectivenessSeverity;
}

export function taskHasObservableWorkerActivity(task: TeamTaskState): boolean {
	return Boolean(
		(task.agentProgress?.toolCount ?? 0) > 0 ||
			task.usage ||
			task.transcriptArtifact ||
			task.modelAttempts?.some((attempt) => attempt.success) ||
			task.jsonEvents,
	);
}

/**
 * True when the task completed but its result artifact is an EMPTY file
 * (0 bytes). Closes the F4 monitoring gap (real-test-2026-08-10 finding):
 * a child worker absorbed by a rate-limit (429) or a model-not-found
 * failure still emits transcript/usage events, so
 * {@link taskHasObservableWorkerActivity} reports "activity" — but the
 * actual result content is empty. A completed task with an empty result
 * has done no real work and must not count toward run effectiveness.
 *
 * Deliberately only flags `sizeBytes === 0` (a written-but-empty file).
 * A missing resultArtifact stays non-flagging (some tasks legitimately
 * produce no result file), and an undefined sizeBytes stays non-flagging
 * (legacy tasks — do not false-positive on absent metadata).
 */
export function taskHasEmptyResult(task: TeamTaskState): boolean {
	return Boolean(task.resultArtifact && task.resultArtifact.sizeBytes === 0);
}

export function resolveEffectivenessGuardMode(
	runtimeConfig: CrewRuntimeConfig | undefined,
	manifest?: TeamRunManifest,
): EffectivenessGuardMode {
	const configured = runtimeConfig?.effectivenessGuard;
	if (configured === "off" || configured === "warn" || configured === "block" || configured === "fail") return configured;
	if (manifest?.runtimeResolution?.safety === "explicit_dry_run") return "off";
	return "warn";
}

export function evaluateRunEffectiveness(input: {
	manifest?: TeamRunManifest;
	tasks: TeamTaskState[];
	executeWorkers: boolean;
	runtimeConfig?: CrewRuntimeConfig;
}): RunEffectivenessSummary {
	const completedTasks = input.tasks.filter((task) => task.status === "completed");
	// F4: a completed task with an EMPTY result artifact (0 bytes) is
	// treated exactly like no-observed-work — the worker may have spun up
	// and streamed transcript events, but it produced no real output
	// (e.g. a 429 rate-limit absorbed by the fallback chain).
	const noObservedWorkTasks = completedTasks.filter((task) => !taskHasObservableWorkerActivity(task) || taskHasEmptyResult(task));
	const needsAttentionTasks = input.tasks.filter((task) => task.agentProgress?.activityState === "needs_attention");
	const workerExecution: WorkerExecutionState = input.executeWorkers ? "enabled" : "disabled/scaffold";
	const guardMode = resolveEffectivenessGuardMode(input.runtimeConfig, input.manifest);
	const completedNeedsAttention = needsAttentionTasks.filter((task) => task.status === "completed").length;
	const observable = Math.max(0, completedTasks.length - noObservedWorkTasks.length - completedNeedsAttention);
	let severity: RunEffectivenessSeverity = "ok";
	if (input.executeWorkers && guardMode !== "off" && noObservedWorkTasks.length > 0) {
		severity = guardMode === "fail" ? "failed" : guardMode === "block" ? "blocked" : "warning";
		// P0.1: default warn escalates to blocked for mutating-role tasks without observed work
		if (severity === "warning" && noObservedWorkTasks.some((task) => permissionForRole(task.role) !== "read_only")) {
			severity = "blocked";
		}
	}
	return {
		completed: completedTasks.length,
		observable,
		noObservedWorkTaskIds: noObservedWorkTasks.map((task) => task.id),
		needsAttentionTaskIds: needsAttentionTasks.map((task) => task.id),
		workerExecution,
		guardMode,
		severity,
	};
}

export function formatRunEffectivenessLines(summary: RunEffectivenessSummary): string[] {
	return [
		`Score: ${summary.observable}/${Math.max(1, summary.completed)} completed task(s) with observable worker activity`,
		`Worker execution: ${summary.workerExecution}`,
		`Guard: ${summary.guardMode} severity=${summary.severity}`,
		`No observable worker activity: ${summary.noObservedWorkTaskIds.length ? summary.noObservedWorkTaskIds.join(", ") : "none"}`,
		`Needs attention: ${summary.needsAttentionTaskIds.length ? summary.needsAttentionTaskIds.join(", ") : "none"}`,
	];
}

export function effectivenessPolicyDecision(summary: RunEffectivenessSummary): PolicyDecision | undefined {
	if (summary.severity !== "warning" && summary.severity !== "blocked" && summary.severity !== "failed") return undefined;
	const action = summary.severity === "failed" ? "fail" : summary.severity === "blocked" ? "block" : "notify";
	return {
		action,
		reason: "ineffective_worker",
		message: `Run effectiveness guard ${summary.guardMode}: no observable worker activity for ${summary.noObservedWorkTaskIds.join(", ")}.`,
		createdAt: new Date().toISOString(),
	};
}
