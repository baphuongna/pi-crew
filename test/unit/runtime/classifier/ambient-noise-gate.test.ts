/**
 * U6A (upgrade spec 2026-10-09, §U6 Phase A): tests for the generalized
 * "ambient-noise vs real-failure" classifier gate used by the dispatch-batch
 * retry loop (classifyAmbientNoiseGate + retry-executor shouldRetry hook).
 *
 * Contract under test (spec caveats, mandatory SOFT branches):
 *   - default-off (enabled=false) → classify never called, retry proceeds
 *     (zero behavior change, zero registry touch);
 *   - enabled + classifier answers AMBIENT NOISE → retry proceeds,
 *     crew.classifier.decisions_total{consumer="ambient_noise_gate",
 *     decision="noise_retry"} + task.noise_gate event;
 *   - enabled + classifier answers REAL FAILURE → queued retry skipped
 *     (decision="real_giveup" counter + event);
 *   - enabled + provider unconfigured (getAvailableOfType("classifier") → [])
 *     → caller fallback (retry proceeds), NO decision event/counter — the
 *     service's calls_total{outcome=no_classifier_available} already counts it;
 *   - enabled + classify throws → caller fallback (never fails the task);
 *   - confidence passthrough: wrapped answer {value, confidence} surfaces on
 *     the event data + crew.classifier.confidence histogram;
 *   - retry-executor shouldRetry hook: false → give up after the failed
 *     attempt (onRetryGivenUp + ORIGINAL error, no onAttemptFailed);
 *     throwing hook → soft-fail (retry proceeds); absent hook → unchanged.
 *
 * Env note (knowledge.md 2026-08-15): ambient PI_CREW_CLASSIFIER_* vars from
 * the worker harness are scrubbed per-case so helper args are the only input.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { createMetricRegistry } from "../../../../src/observability/metric-registry.ts";
import { classifyAmbientNoiseGate } from "../../../../src/runtime/classifier/ambient-noise-gate.ts";
import { __test__resetClassifierLogOnce, type ClassifyRequest } from "../../../../src/runtime/classifier/classifier-service.ts";
import { executeWithRetry } from "../../../../src/runtime/recovery/retry-executor.ts";
import { readEvents } from "../../../../src/state/event-log/event-log.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

/** Fake classifier-surface registry (classifier-service.test.ts pattern). */
function fakeRegistry(opts: { classifyAnswer?: boolean; available?: unknown[]; confidence?: number; throwOnClassify?: boolean } = {}) {
	const access: string[] = [];
	const requests: ClassifyRequest[] = [];
	return {
		access,
		requests,
		getAvailableOfType: (type: string) => {
			access.push(`getAvailableOfType:${type}`);
			return type === "classifier" ? (opts.available ?? [{ provider: "opencode", id: "jev-1.13-free" }]) : [];
		},
		classify: async (model: unknown, request: ClassifyRequest) => {
			access.push("classify");
			requests.push(request);
			if (opts.throwOnClassify) throw new Error("provider exploded (fake)");
			assert.ok(model && typeof model === "object", "classify must receive the resolved model object");
			assert.ok(request.questions.ambient, "the gate must ask the 'ambient' bool question");
			return {
				answers: {
					ambient:
						opts.confidence !== undefined
							? { value: opts.classifyAnswer ?? true, confidence: opts.confidence }
							: (opts.classifyAnswer ?? true),
				},
				stopReason: "stop",
			};
		},
	};
}

interface EnvState {
	enabled: string | undefined;
	model: string | undefined;
}

function saveEnv(): EnvState {
	return {
		enabled: process.env.PI_CREW_CLASSIFIER_ENABLED,
		model: process.env.PI_CREW_CLASSIFIER_MODEL,
	};
}

function scrubEnv(): void {
	delete process.env.PI_CREW_CLASSIFIER_ENABLED;
	delete process.env.PI_CREW_CLASSIFIER_MODEL;
}

function restoreEnv(state: EnvState): void {
	if (state.enabled === undefined) delete process.env.PI_CREW_CLASSIFIER_ENABLED;
	else process.env.PI_CREW_CLASSIFIER_ENABLED = state.enabled;
	if (state.model === undefined) delete process.env.PI_CREW_CLASSIFIER_MODEL;
	else process.env.PI_CREW_CLASSIFIER_MODEL = state.model;
}

function makeEventsPath(): string {
	const cwd = createTrackedTempDir("pi-crew-noise-gate-");
	return path.join(cwd, "events.jsonl");
}

function gateArgs(overrides: Partial<Parameters<typeof classifyAmbientNoiseGate>[0]> = {}) {
	// eventsPath default: a temp file the test cleans up via tracked dir; the
	// fire-and-forget append tolerates a missing parent only if it exists, so
	// tests that assert events pass a REAL path (see waitForNoiseGateEvent).
	return {
		enabled: true,
		modelRegistry: undefined,
		classifierModel: "opencode/jev-1.13-free",
		failureSummary: "Provider error: 429 rate limit exceeded",
		attempt: 1,
		maxAttempts: 3,
		eventsPath: "/dev/null",
		runId: "run-gate",
		taskId: "task-gate",
		...overrides,
	} as Parameters<typeof classifyAmbientNoiseGate>[0];
}

function noiseGateEvents(eventsPath: string) {
	return readEvents(eventsPath).filter((e) => e.type === "task.noise_gate");
}

/** The gate's event append is fire-and-forget — poll briefly for the write. */
async function waitForNoiseGateEvent(eventsPath: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (noiseGateEvents(eventsPath).length > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// ─── Gate: flag on/off ───────────────────────────────────────────────────

test("[gate-1] default-off: enabled=false → registry NEVER touched, retry proceeds (zero behavior change)", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	try {
		let touched = false;
		const boobyTrapped = {
			getAvailableOfType: (): unknown[] => {
				touched = true;
				throw new Error("registry must not be touched when disabled");
			},
			classify: (): never => {
				touched = true;
				throw new Error("classify must not be called when disabled");
			},
		};
		const result = await classifyAmbientNoiseGate(gateArgs({ enabled: false, modelRegistry: boobyTrapped }));
		assert.equal(touched, false, "disabled gate must not touch the registry");
		assert.deepEqual(result, { proceedWithRetry: true, consulted: false });
	} finally {
		restoreEnv(prev);
	}
});

test("[gate-2] enabled + classifier answers AMBIENT NOISE → retry proceeds + decisions_total counter + task.noise_gate event", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	const eventsPath = makeEventsPath();
	const metricRegistry = createMetricRegistry();
	const registry = fakeRegistry({ classifyAnswer: true });
	try {
		const result = await classifyAmbientNoiseGate(gateArgs({ modelRegistry: registry, eventsPath, metricRegistry }));
		assert.deepEqual(result, { proceedWithRetry: true, consulted: true });
		assert.equal(registry.access.filter((a) => a === "classify").length, 1, "classify consulted exactly once");
		await waitForNoiseGateEvent(eventsPath);
		const events = noiseGateEvents(eventsPath);
		assert.equal(events.length, 1, "one task.noise_gate event");
		assert.equal(events[0]!.taskId, "task-gate");
		assert.equal(events[0]!.data?.decision, "noise_retry");
		assert.equal(events[0]!.data?.classifierModel, "opencode/jev-1.13-free");
		// Classifier state carries the capped failure summary + attempt context.
		assert.equal(registry.requests[0]!.state.failureSummary, "Provider error: 429 rate limit exceeded");
		assert.equal(registry.requests[0]!.state.attempt, 1);
		assert.equal(registry.requests[0]!.state.maxAttempts, 3);
		const snapshot = JSON.stringify(metricRegistry.snapshot());
		assert.ok(snapshot.includes("crew.classifier.calls_total"), "service calls_total counted");
		assert.ok(
			snapshot.includes("crew.classifier.decisions_total") && snapshot.includes("noise_retry"),
			"decisions_total{consumer=ambient_noise_gate, decision=noise_retry} counted",
		);
	} finally {
		restoreEnv(prev);
		metricRegistry.dispose();
		fs.rmSync(path.dirname(eventsPath), { recursive: true, force: true });
	}
});

test("[gate-3] enabled + classifier answers REAL FAILURE → queued retry skipped (real_giveup counter + event)", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	const eventsPath = makeEventsPath();
	const metricRegistry = createMetricRegistry();
	const registry = fakeRegistry({ classifyAnswer: false });
	try {
		const result = await classifyAmbientNoiseGate(gateArgs({ modelRegistry: registry, eventsPath, metricRegistry }));
		assert.deepEqual(result, { proceedWithRetry: false, consulted: true });
		await waitForNoiseGateEvent(eventsPath);
		const events = noiseGateEvents(eventsPath);
		assert.equal(events.length, 1);
		assert.equal(events[0]!.data?.decision, "real_giveup");
		const snapshot = JSON.stringify(metricRegistry.snapshot());
		assert.ok(snapshot.includes("real_giveup"), "decisions_total{decision=real_giveup} counted");
	} finally {
		restoreEnv(prev);
		metricRegistry.dispose();
		fs.rmSync(path.dirname(eventsPath), { recursive: true, force: true });
	}
});

// ─── Gate: provider unconfigured / soft failure modes ────────────────────

test("[gate-4] enabled + provider unconfigured (no credentialed classifier) → caller fallback, NO decision event/counter", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	const eventsPath = makeEventsPath();
	const metricRegistry = createMetricRegistry();
	const registry = fakeRegistry({ available: [] });
	try {
		const result = await classifyAmbientNoiseGate(gateArgs({ modelRegistry: registry, eventsPath, metricRegistry }));
		assert.deepEqual(result, { proceedWithRetry: true, consulted: false }, "fallback keeps the pre-existing retry behavior");
		assert.equal(registry.access.filter((a) => a === "classify").length, 0, "classify unreachable with zero available classifiers");
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(noiseGateEvents(eventsPath).length, 0, "fallback must NOT emit a noise_gate decision event");
		const snapshot = JSON.stringify(metricRegistry.snapshot());
		assert.ok(
			snapshot.includes("no_classifier_available") && snapshot.includes("ambient_noise_gate"),
			"calls_total{outcome=no_classifier_available, consumer=ambient_noise_gate} counted by the service",
		);
		assert.ok(!snapshot.includes("decisions_total"), "no decision was made — decisions_total must stay absent");
	} finally {
		restoreEnv(prev);
		metricRegistry.dispose();
		fs.rmSync(path.dirname(eventsPath), { recursive: true, force: true });
	}
});

test("[gate-5] enabled + classify throws → caller fallback (soft: never fails the task)", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	const eventsPath = makeEventsPath();
	const registry = fakeRegistry({ throwOnClassify: true });
	try {
		const result = await classifyAmbientNoiseGate(gateArgs({ modelRegistry: registry, eventsPath }));
		assert.deepEqual(result, { proceedWithRetry: true, consulted: false });
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(noiseGateEvents(eventsPath).length, 0, "throwing classify must not emit a decision event");
	} finally {
		restoreEnv(prev);
		fs.rmSync(path.dirname(eventsPath), { recursive: true, force: true });
	}
});

test("[gate-6] registry absent (undefined) → caller fallback, no crash", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	try {
		const result = await classifyAmbientNoiseGate(gateArgs({ modelRegistry: undefined }));
		assert.deepEqual(result, { proceedWithRetry: true, consulted: false });
	} finally {
		restoreEnv(prev);
	}
});

// ─── Gate: confidence metrics (spec Phase A: "giám sát confidence qua events") ──

test("[gate-7] confidence passthrough: wrapped answer {value, confidence} → event data.confidence + crew.classifier.confidence histogram", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	const eventsPath = makeEventsPath();
	const metricRegistry = createMetricRegistry();
	const registry = fakeRegistry({ classifyAnswer: true, confidence: 0.87 });
	try {
		const result = await classifyAmbientNoiseGate(gateArgs({ modelRegistry: registry, eventsPath, metricRegistry }));
		assert.deepEqual(result, { proceedWithRetry: true, consulted: true });
		await waitForNoiseGateEvent(eventsPath);
		const events = noiseGateEvents(eventsPath);
		assert.equal(events.length, 1);
		assert.equal(events[0]!.data?.confidence, 0.87, "event carries the provider-reported confidence");
		const snapshot = JSON.stringify(metricRegistry.snapshot());
		assert.ok(snapshot.includes("crew.classifier.confidence"), "confidence histogram observed");
	} finally {
		restoreEnv(prev);
		metricRegistry.dispose();
		fs.rmSync(path.dirname(eventsPath), { recursive: true, force: true });
	}
});

// ─── retry-executor shouldRetry hook (the dispatch-batch consumer seam) ───

test("[retry-1] shouldRetry=false → give up after the failed attempt: fn once, onRetryGivenUp, ORIGINAL error, no onAttemptFailed", async () => {
	let calls = 0;
	const failed = new Error("E007: worker became unresponsive");
	const givenUp: number[] = [];
	const attemptFailed: number[] = [];
	await assert.rejects(
		executeWithRetry(
			async () => {
				calls += 1;
				throw failed;
			},
			{ maxAttempts: 3, backoffMs: 1, jitterRatio: 0, exponentialFactor: 1 },
			{
				shouldRetry: () => false,
				onRetryGivenUp: (attempts) => givenUp.push(attempts),
				onAttemptFailed: (attempt) => attemptFailed.push(attempt),
			},
		),
		(error: unknown) => error === failed,
		"the ORIGINAL attempt error must surface (the gate never introduces a new failure)",
	);
	assert.equal(calls, 1, "the queued retry was skipped");
	assert.deepEqual(givenUp, [1], "onRetryGivenUp fired with the failed attempt index");
	assert.deepEqual(attemptFailed, [], "no retry was queued — onAttemptFailed must not fire");
});

test("[retry-2] throwing shouldRetry hook → SOFT-fail: the queued retry proceeds", async () => {
	let calls = 0;
	const gateCalls: number[] = [];
	const result = await executeWithRetry(
		async (attempt) => {
			calls += 1;
			if (attempt === 1) throw new Error("transient");
			return "recovered";
		},
		{ maxAttempts: 3, backoffMs: 1, jitterRatio: 0, exponentialFactor: 1 },
		{
			shouldRetry: (attempt) => {
				gateCalls.push(attempt);
				throw new Error("gate exploded (must be swallowed)");
			},
		},
	);
	assert.equal(result, "recovered");
	assert.equal(calls, 2, "a broken gate must never change retry behavior");
	assert.deepEqual(gateCalls, [1], "the hook was consulted once (between attempts)");
});

test("[retry-3] absent shouldRetry hook → unchanged retry behavior (regression guard)", async () => {
	let calls = 0;
	const result = await executeWithRetry(
		async (attempt) => {
			calls += 1;
			if (attempt < 3) throw new Error("boom");
			return "ok";
		},
		{ maxAttempts: 3, backoffMs: 1, jitterRatio: 0, exponentialFactor: 1 },
	);
	assert.equal(result, "ok");
	assert.equal(calls, 3);
});

test("[retry-4] async shouldRetry resolving false after attempt 3 → stops exactly there", async () => {
	let calls = 0;
	const gate: number[] = [];
	const failed = new Error("permanent-looking");
	await assert.rejects(
		executeWithRetry(
			async (attempt) => {
				calls += 1;
				if (attempt < 3) throw new Error(`first-${attempt}`);
				throw failed;
			},
			{ maxAttempts: 5, backoffMs: 1, jitterRatio: 0, exponentialFactor: 1 },
			{
				shouldRetry: async (attempt) => {
					gate.push(attempt);
					return attempt < 3;
				},
			},
		),
		(error: unknown) => error === failed,
	);
	assert.equal(calls, 3, "attempts 1-3 ran; the gate stopped the 4th spawn");
	assert.deepEqual(gate, [1, 2, 3], "gate consulted after every failed attempt until it said stop");
});

// ─── dispatch-batch wiring (source-pin: guards accidental unwiring) ──────

test("[wire-1] dispatch-batch wires classifyAmbientNoiseGate behind resolveClassifierEnabled on the retry loop", async () => {
	const src = fs.readFileSync(new URL("../../../../src/runtime/dispatch-batch.ts", import.meta.url), "utf-8");
	assert.ok(src.includes("noiseGateEnabled = resolveClassifierEnabled("), "gate flag resolved from runtime.classifierEnabled");
	assert.ok(src.includes("shouldRetry: noiseGateEnabled"), "the retry hook is passed ONLY when the gate is enabled (dormant default)");
	assert.ok(src.includes("classifyAmbientNoiseGate({"), "the retry hook consults the ambient-noise gate");
	// Event registry: task.noise_gate must stay registered (check:event-types drift table).
	const contracts = fs.readFileSync(new URL("../../../../src/state/contracts.ts", import.meta.url), "utf-8");
	assert.ok(contracts.includes('"task.noise_gate"'), "task.noise_gate registered in TEAM_EVENT_TYPES");
});
