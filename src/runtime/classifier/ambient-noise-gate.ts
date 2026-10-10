/**
 * U6A (upgrade spec 2026-10-09, §U6 Phase A): generalized "ambient-noise vs
 * real-failure" classifier gate for the DISPATCH-BATCH retry loop —
 * the sibling of child-executor's model-fallback `triageRetryWithClassifier`
 * (retry-triage). Same never-rejects contract, same dormant default
 * (`runtime.classifierEnabled`, default FALSE — resolveClassifierEnabled),
 * one shared flag/model for both consumers.
 *
 * Semantics: after a failed task attempt and BEFORE the next (expensive)
 * worker re-spawn is queued, ask the host classifier ONE bool question — is
 * the failure AMBIENT NOISE (transient/environmental: rate limit, provider
 * hiccup, timeout, network blip — a fresh attempt has a realistic chance)
 * rather than a REAL FAILURE (deterministic: auth/permission denied, invalid
 * request, missing resource — the retry will fail the same way)?
 *
 * SOFT-BRANCH CONTRACT (spec caveat, mandatory):
 *   - opencode/provider unconfigured (`getAvailableOfType("classifier")` →
 *     [], classify stopReason "error") → caller fallback;
 *   - classify throws / registry absent → caller fallback;
 *   - fallback on EVERY failure mode is `proceedWithRetry: true` — the
 *     pre-existing retry behavior. A wrong classifier verdict can only SKIP
 *     one queued retry (the task surfaces its original error — the same
 *     outcome as retry exhaustion); it can NEVER fail a task with a new
 *     error or block the loop.
 *
 * Diagnostics (confidence monitoring, spec Phase A):
 *   - `crew.classifier.calls_total{consumer="ambient_noise_gate",outcome}`
 *     + `crew.classifier.confidence` histogram via classifyBool;
 *   - `crew.classifier.decisions_total{consumer,decision}` and a
 *     `task.noise_gate` event ONLY when a real classifier answer informed
 *     the decision (fallback paths are already counted by the service's
 *     calls_total and must not double-report a decision they did not make).
 */
import type { MetricRegistry } from "../../observability/metric-registry.ts";
import { appendEventAsync } from "../../state/event-log/event-log.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { classifyBool } from "./classifier-service.ts";

export interface AmbientNoiseGateArgs {
	/** Pre-resolved gate (resolveClassifierEnabled) — false short-circuits before ANY registry touch. */
	enabled: boolean;
	/** Host-process model registry (ctx.modelRegistry, threaded unknown). */
	modelRegistry: unknown;
	/** Pre-resolved classifier model id (resolveClassifierModel). */
	classifierModel: string;
	/** Failure summary the retry loop computed (the thrown attempt error message). */
	failureSummary: string;
	/** 1-based index of the attempt that just failed. */
	attempt: number;
	/** Retry policy maxAttempts (context for the classifier, not enforced here). */
	maxAttempts: number;
	/** Event-log identity for the task.noise_gate diagnostic event. */
	eventsPath: string;
	runId: string;
	taskId: string;
	/** Optional host metric registry (crew.classifier.* counters/histograms). */
	metricRegistry?: MetricRegistry;
}

export interface AmbientNoiseGateResult {
	/** false → skip the queued retry attempt (classifier judged the failure real/deterministic). */
	proceedWithRetry: boolean;
	/** true ONLY when a real classifier answer informed the decision (event + decision metric emitted). */
	consulted: boolean;
}

/**
 * Ask the ambient-noise gate. NEVER REJECTS and never throws up to the
 * caller — the disabled path returns without touching the registry (zero
 * behavior change), every classifier failure mode falls back to
 * `proceedWithRetry: true`.
 */
export async function classifyAmbientNoiseGate(args: AmbientNoiseGateArgs): Promise<AmbientNoiseGateResult> {
	if (!args.enabled) return { proceedWithRetry: true, consulted: false };
	const result = await classifyBool({
		modelRegistry: args.modelRegistry,
		classifierModel: args.classifierModel,
		questionKey: "ambient",
		question: {
			type: "bool",
			instructions:
				"A dispatched worker task attempt failed and an automatic retry is queued (the worker will be re-spawned from scratch). Read the failure state. Is the failure AMBIENT NOISE (transient or environmental — rate limit, provider hiccup, timeout, network error, stale lock — a fresh attempt has a realistic chance of success) rather than a REAL FAILURE (deterministic — auth or permission denied, invalid request, missing resource, code or prompt defect — the retry will fail the same way)?",
			criteria: {
				true: "Ambient noise — the queued retry may succeed",
				false: "Real failure — the queued retry will fail the same way",
			},
		},
		state: {
			// Cap the summary: classifiers reason over small JSON state — the raw
			// error can carry multi-KB stderr tails (same cap as retry-triage).
			failureSummary: args.failureSummary.slice(0, 2000),
			attempt: args.attempt,
			maxAttempts: args.maxAttempts,
		},
		fallback: true,
		metricRegistry: args.metricRegistry,
		metricLabels: { consumer: "ambient_noise_gate" },
	});
	if (!result.fromClassifier) return { proceedWithRetry: true, consulted: false };
	const decision = result.decision ? "noise_retry" : "real_giveup";
	try {
		args.metricRegistry?.counter("crew.classifier.decisions_total", "Classifier-informed decisions by consumer and verdict").inc({
			consumer: "ambient_noise_gate",
			decision,
		});
	} catch (metricError) {
		logInternalError("ambient-noise-gate.metric", metricError, `decision=${decision}`, "warn");
	}
	void appendEventAsync(args.eventsPath, {
		type: "task.noise_gate",
		runId: args.runId,
		taskId: args.taskId,
		message: `Ambient-noise gate classified the attempt-${args.attempt} failure as ${decision} (classifier ${result.usedModel ?? args.classifierModel})`,
		data: {
			decision,
			attempt: args.attempt,
			classifierModel: result.usedModel,
			configuredModel: args.classifierModel,
			stopReason: result.stopReason,
			...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
		},
	}).catch(() => {
		/* no-op: best-effort diagnostic append, ignore delivery errors */
	});
	return { proceedWithRetry: result.decision, consulted: true };
}
