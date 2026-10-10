/**
 * U6B (upgrade spec 2026-10-09, §U6 Phase B): tests for the classifier
 * VERIFIER PRE-GATE (src/runtime/verification/classifier-pre-gate.ts) —
 * the consumer of the U6B score-question variant (classifyScore).
 *
 * Contract under test (spec caveats, mandatory SOFT branches):
 *   - default-off (enabled=false) → registry NEVER touched, verdict escalates
 *     to the LLM verifier (zero behavior change: the module is unwired and
 *     dormant until U13 mounts it);
 *   - pass-shaped verdict + score ≥ 0.9 + confidence ≥ 0.8 → BLOCKS the LLM
 *     verifier spawn (decisions_total{decision="blocked"} + event);
 *   - verdict FAILED-shaped (or ambiguous) → escalate EVEN with a perfect
 *     score/confidence ("escalate khi confidence thấp HOẶC verdict FAILED");
 *   - low confidence (or unreported) → escalate_low_confidence;
 *   - low score (or out of 0..1) → escalate_low_score;
 *   - provider unconfigured (getAvailableOfType("classifier") → []) /
 *     classify throws / registry absent → SOFT escalate_fallback, NO decision
 *     event/counter (the service's calls_total{outcome} already counts it),
 *     never a rejection — a wrong/unconfigured classifier can never fail a
 *     task, it only costs the one escalate it was trying to save;
 *   - classifier sees CAPPED JSON state ONLY ({verdict, evidenceLines,
 *     changedFiles}) — never diffs or unbounded worker prose;
 *   - the score question is the pi-ai shape (type:"score", criteria array).
 *
 * Env note (knowledge.md 2026-08-15): ambient PI_CREW_CLASSIFIER_* vars from
 * the worker harness are scrubbed per-case so helper args are the only input.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { createMetricRegistry } from "../../../../src/observability/metric-registry.ts";
import {
	__test__resetClassifierLogOnce,
	type ClassifierScoreQuestion,
	type ClassifyRequest,
} from "../../../../src/runtime/classifier/classifier-service.ts";
import {
	classifyVerifierPreGate,
	VERIFIER_PRE_GATE_BLOCK_CONFIDENCE_THRESHOLD,
	VERIFIER_PRE_GATE_BLOCK_SCORE_THRESHOLD,
} from "../../../../src/runtime/verification/classifier-pre-gate.ts";
import { readEvents } from "../../../../src/state/event-log/event-log.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

/** Fake classifier-surface registry (classifier-service.test.ts pattern). */
function fakeRegistry(
	opts: {
		score?: number;
		confidence?: number;
		answerShape?: "pi-ai" | "bare";
		available?: unknown[];
		throwOnClassify?: boolean;
		throwOnAvailable?: boolean;
	} = {},
) {
	const access: string[] = [];
	const requests: ClassifyRequest[] = [];
	return {
		access,
		requests,
		getAvailableOfType: (type: string) => {
			access.push(`getAvailableOfType:${type}`);
			if (opts.throwOnAvailable) throw new Error("catalog explosion (fake)");
			return type === "classifier" ? (opts.available ?? [{ provider: "opencode", id: "jev-1.13-free" }]) : [];
		},
		classify: async (model: unknown, request: ClassifyRequest) => {
			access.push("classify");
			requests.push(request);
			if (opts.throwOnClassify) throw new Error("provider exploded (fake)");
			assert.ok(model && typeof model === "object", "classify must receive the resolved model object");
			const decisive = request.questions.decisive as ClassifierScoreQuestion;
			assert.ok(decisive, "the gate must ask the 'decisive' score question");
			assert.equal(decisive.type, "score", "U6B question variant is type 'score'");
			assert.ok(Array.isArray(decisive.criteria), "score criteria is the pi-ai string array");
			const score = opts.score ?? 0.95;
			if (opts.answerShape === "bare") return { answers: { decisive: score }, stopReason: "stop" };
			return {
				answers: { decisive: { type: "score", score, confidence: opts.confidence ?? 0.9 } },
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
	return { enabled: process.env.PI_CREW_CLASSIFIER_ENABLED, model: process.env.PI_CREW_CLASSIFIER_MODEL };
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
	return path.join(createTrackedTempDir("pi-crew-verifier-pre-gate-"), "events.jsonl");
}

function preGateArgs(overrides: Partial<Parameters<typeof classifyVerifierPreGate>[0]> = {}) {
	return {
		enabled: true,
		modelRegistry: undefined,
		classifierModel: "opencode/jev-1.13-free",
		verdict: {
			verdict: "PASS",
			evidenceLines: ["npm run test:critical → exit 0", "tsc --noEmit → exit 0"],
			changedFiles: ["src/a.ts", "test/a.test.ts"],
		},
		eventsPath: "/dev/null",
		runId: "run-pre-gate",
		taskId: "task-pre-gate",
		...overrides,
	} as Parameters<typeof classifyVerifierPreGate>[0];
}

function preGateEvents(eventsPath: string) {
	return readEvents(eventsPath).filter((e) => e.type === "task.verifier_pre_gate");
}

/** The gate's event append is fire-and-forget — poll briefly for the writes. */
async function waitForPreGateEvents(eventsPath: string, count: number, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (preGateEvents(eventsPath).length >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function waitForPreGateEvent(eventsPath: string, timeoutMs = 3000): Promise<void> {
	await waitForPreGateEvents(eventsPath, 1, timeoutMs);
}

// ─── Flag: off by default (dormant until U13 mounts) ─────────────────────

test("[pg-1] default-off: enabled=false → registry NEVER touched, verdict escalates (zero behavior change)", async () => {
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
		const result = await classifyVerifierPreGate(preGateArgs({ enabled: false, modelRegistry: boobyTrapped }));
		assert.equal(touched, false, "disabled gate must not touch the registry");
		assert.equal(result.blockVerifier, false, "disabled gate never blocks the LLM verifier spawn");
		assert.equal(result.consulted, false);
		assert.equal(result.action, "disabled");
	} finally {
		restoreEnv(prev);
	}
});

// ─── Block path: unambiguous pass + decisive score + confident provider ──

test("[pg-2] pass verdict + score ≥ threshold + confidence ≥ threshold → BLOCK the LLM verifier spawn", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	const eventsPath = makeEventsPath();
	const metricRegistry = createMetricRegistry();
	const registry = fakeRegistry({ score: 0.95, confidence: 0.92 });
	try {
		const result = await classifyVerifierPreGate(preGateArgs({ modelRegistry: registry, eventsPath, metricRegistry }));
		assert.equal(result.blockVerifier, true, "decisive structured pass blocks the spawn");
		assert.equal(result.consulted, true);
		assert.equal(result.action, "blocked");
		assert.equal(result.score, 0.95);
		assert.equal(result.confidence, 0.92);
		await waitForPreGateEvent(eventsPath);
		const events = preGateEvents(eventsPath);
		assert.equal(events.length, 1, "one task.verifier_pre_gate event");
		assert.equal(events[0]!.taskId, "task-pre-gate");
		assert.equal(events[0]!.data?.action, "blocked");
		assert.equal(events[0]!.data?.score, 0.95);
		assert.equal(events[0]!.data?.verdict, "PASS");
		const snapshot = JSON.stringify(metricRegistry.snapshot());
		assert.ok(snapshot.includes("crew.classifier.calls_total"), "service calls_total counted");
		assert.ok(
			snapshot.includes("crew.classifier.decisions_total") && snapshot.includes('"decision":"blocked"'),
			"decisions_total{consumer=verifier_pre_gate, decision=blocked} counted",
		);
	} finally {
		restoreEnv(prev);
		metricRegistry.dispose();
		fs.rmSync(path.dirname(eventsPath), { recursive: true, force: true });
	}
});

test("[pg-3] threshold edges: score exactly 0.9 + confidence exactly 0.8 still blocks (at-threshold inclusive)", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	try {
		assert.equal(VERIFIER_PRE_GATE_BLOCK_SCORE_THRESHOLD, 0.9);
		assert.equal(VERIFIER_PRE_GATE_BLOCK_CONFIDENCE_THRESHOLD, 0.8);
		const registry = fakeRegistry({ score: 0.9, confidence: 0.8 });
		const result = await classifyVerifierPreGate(preGateArgs({ modelRegistry: registry }));
		assert.equal(result.blockVerifier, true, "at-threshold readings block (>= semantics)");
		assert.equal(result.action, "blocked");
	} finally {
		restoreEnv(prev);
	}
});

// ─── Escalation policy (spec: confidence thấp HOẶC verdict FAILED) ────────

test("[pg-4] FAILED verdict escalates EVEN with a perfect score/confidence", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	const eventsPath = makeEventsPath();
	const registry = fakeRegistry({ score: 0.99, confidence: 0.99 });
	try {
		for (const verdict of ["FAILED", "error: 2 tests failing", "BLOCKED: no evidence", "INCONCLUSIVE", ""]) {
			const result = await classifyVerifierPreGate(
				preGateArgs({ modelRegistry: registry, eventsPath, verdict: { verdict, evidenceLines: [], changedFiles: [] } }),
			);
			assert.equal(result.blockVerifier, false, `verdict "${verdict}" must never block`);
			assert.equal(result.action, "escalate_verdict_failed", `verdict "${verdict}" is failure/ambiguous-shaped`);
			assert.equal(result.consulted, true);
		}
		// 5 consulted verdicts → 5 events (fire-and-forget; poll for delivery).
		await waitForPreGateEvents(eventsPath, 5);
		assert.equal(preGateEvents(eventsPath).length, 5, "each consulted escalation emits a diagnostic event");
	} finally {
		restoreEnv(prev);
		fs.rmSync(path.dirname(eventsPath), { recursive: true, force: true });
	}
});

test("[pg-5] low/unreported confidence → escalate_low_confidence", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	try {
		const lowConfidence = fakeRegistry({ score: 0.95, confidence: 0.5 });
		const low = await classifyVerifierPreGate(preGateArgs({ modelRegistry: lowConfidence }));
		assert.equal(low.action, "escalate_low_confidence");
		assert.equal(low.blockVerifier, false);

		const bare = fakeRegistry({ score: 0.95, answerShape: "bare" });
		const unreported = await classifyVerifierPreGate(preGateArgs({ modelRegistry: bare }));
		assert.equal(unreported.action, "escalate_low_confidence", "unreported confidence NEVER blocks");
		assert.equal(unreported.confidence, undefined);
	} finally {
		restoreEnv(prev);
	}
});

test("[pg-6] low / out-of-range score → escalate_low_score", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	try {
		const lowScore = fakeRegistry({ score: 0.6, confidence: 0.95 });
		const low = await classifyVerifierPreGate(preGateArgs({ modelRegistry: lowScore }));
		assert.equal(low.action, "escalate_low_score");
		assert.equal(low.blockVerifier, false);

		// Out-of-range scores are treated as non-decisive (defensive).
		const overRange = fakeRegistry({ score: 1.5, confidence: 0.95 });
		const over = await classifyVerifierPreGate(preGateArgs({ modelRegistry: overRange }));
		assert.equal(over.action, "escalate_low_score");
	} finally {
		restoreEnv(prev);
	}
});

// ─── Soft-fail: provider unconfigured / threw / registry absent ───────────

test("[pg-7] provider unconfigured (no credentialed classifier) → SOFT escalate, no decision event/counter", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	const eventsPath = makeEventsPath();
	const metricRegistry = createMetricRegistry();
	const registry = fakeRegistry({ available: [] });
	try {
		const result = await classifyVerifierPreGate(preGateArgs({ modelRegistry: registry, eventsPath, metricRegistry }));
		assert.deepEqual(
			{ blockVerifier: result.blockVerifier, consulted: result.consulted, action: result.action },
			{ blockVerifier: false, consulted: false, action: "escalate_fallback" },
			"unconfigured provider degrades to always-escalate (pre-U6B behavior)",
		);
		assert.equal(registry.access.includes("classify"), false, "classify unreachable with zero available classifiers");
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(preGateEvents(eventsPath).length, 0, "fallback must NOT emit a decision event");
		const snapshot = JSON.stringify(metricRegistry.snapshot());
		assert.ok(
			snapshot.includes("no_classifier_available") && snapshot.includes("verifier_pre_gate"),
			"calls_total{outcome=no_classifier_available, consumer=verifier_pre_gate} counted by the service",
		);
		assert.ok(!snapshot.includes("decisions_total"), "no decision was made — decisions_total must stay absent");
	} finally {
		restoreEnv(prev);
		metricRegistry.dispose();
		fs.rmSync(path.dirname(eventsPath), { recursive: true, force: true });
	}
});

test("[pg-8] classify throws / getAvailableOfType throws / registry absent → SOFT escalate (never rejects, never fails the task)", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	try {
		const threw = await classifyVerifierPreGate(preGateArgs({ modelRegistry: fakeRegistry({ throwOnClassify: true }) }));
		assert.deepEqual(
			{ blockVerifier: threw.blockVerifier, consulted: threw.consulted, action: threw.action },
			{ blockVerifier: false, consulted: false, action: "escalate_fallback" },
		);

		const catalogExploded = await classifyVerifierPreGate(preGateArgs({ modelRegistry: fakeRegistry({ throwOnAvailable: true }) }));
		assert.equal(catalogExploded.action, "escalate_fallback");

		const noRegistry = await classifyVerifierPreGate(preGateArgs({ modelRegistry: undefined }));
		assert.equal(noRegistry.action, "escalate_fallback");
		assert.equal(noRegistry.blockVerifier, false);
	} finally {
		restoreEnv(prev);
	}
});

// ─── State hygiene: JSON state ONLY, capped (spec: "KHÔNG phán diff") ─────

test("[pg-9] classifier sees CAPPED {verdict, evidenceLines, changedFiles} JSON state — no diff, no unbounded prose", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	try {
		const registry = fakeRegistry({ score: 0.95, confidence: 0.9 });
		await classifyVerifierPreGate(
			preGateArgs({
				modelRegistry: registry,
				verdict: {
					verdict: "P".repeat(500),
					evidenceLines: Array.from({ length: 30 }, (_, i) => `line-${i}-${"x".repeat(500)}`),
					changedFiles: Array.from({ length: 40 }, (_, i) => `file-${i}-${"y".repeat(500)}`),
				},
			}),
		);
		const state = registry.requests[0]!.state as {
			verdict: string;
			evidenceLines: string[];
			changedFiles: string[];
		};
		// Exactly the spec's structured shape — no diff field, no transcript.
		assert.deepEqual(Object.keys(state).sort(), ["changedFiles", "evidenceLines", "verdict"]);
		assert.ok(state.verdict.length <= 200, "verdict capped");
		assert.ok(state.evidenceLines.length <= 8, "evidence lines capped at 8");
		assert.ok(
			state.evidenceLines.every((line) => line.length <= 200),
			"each evidence line capped at 200 chars",
		);
		assert.ok(state.changedFiles.length <= 16, "changed files capped at 16");
		assert.ok(
			state.changedFiles.every((file) => file.length <= 200),
			"each file name capped at 200 chars",
		);
	} finally {
		restoreEnv(prev);
	}
});

test("[pg-10] taskId optional (goal-loop judge is not a task) — event omits it cleanly", async () => {
	const prev = saveEnv();
	scrubEnv();
	__test__resetClassifierLogOnce();
	const eventsPath = makeEventsPath();
	const registry = fakeRegistry({ score: 0.95, confidence: 0.9 });
	try {
		const { taskId: _taskId, ...argsWithoutTask } = preGateArgs({ modelRegistry: registry, eventsPath });
		const result = await classifyVerifierPreGate(argsWithoutTask);
		assert.equal(result.action, "blocked");
		await waitForPreGateEvent(eventsPath);
		const event = preGateEvents(eventsPath)[0]!;
		assert.equal(event.taskId, undefined, "no taskId on the diagnostic event when omitted");
	} finally {
		restoreEnv(prev);
		fs.rmSync(path.dirname(eventsPath), { recursive: true, force: true });
	}
});
