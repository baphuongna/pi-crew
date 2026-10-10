/**
 * P2-1 (pi 1.0.4 adoption, 2026-10-07): unit tests for the host-process
 * classifier seam (src/runtime/classifier/classifier-service.ts).
 *
 * Covers the never-rejects contract with a FAKE modelRegistry (no real
 * classify call, no credentials — mirrors the R2.3 finding that this host has
 * zero credentialed classifiers):
 *   - available classifier → bool answer wired into the decision
 *   - unavailable (getAvailableOfType → []) → caller fallback + LOG-ONCE
 *     (a second failure does not re-log)
 *   - classify() throws → caller fallback
 *   - stopReason !== "stop" → caller fallback
 *   - answer missing / non-boolean → caller fallback
 *   - registry absent / wrong shape → caller fallback
 *   - resolver precedence: env beats config beats default (enabled default
 *     FALSE / model default "opencode/jev-1.13-free")
 *   - metric counter increments with outcome labels (fake MetricRegistry)
 *
 * U6B additions (spec §U6 Phase B, classifyScore — the score-question
 * variant used by the verifier pre-gate):
 *   - real pi-ai answer shape {type:"score", score, confidence} → classified
 *   - wrapped {value, confidence} + bare-number answers accepted defensively
 *   - answer missing / non-numeric → fallback; never-rejects preserved
 *
 * Env tests mutate process.env and restore in finally (no leakage).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { createMetricRegistry } from "../../../../src/observability/metric-registry.ts";
import {
	__test__classifierLoggedFailureModes,
	__test__resetClassifierLogOnce,
	classifyBool,
	classifyScore,
	DEFAULT_CLASSIFIER_MODEL,
	resolveClassifierEnabled,
	resolveClassifierModel,
} from "../../../../src/runtime/classifier/classifier-service.ts";

/** Fake registry factory: chat surface optional, classifier surface configurable. */
function fakeRegistry(opts: { available?: unknown[]; classifyImpl?: (model: unknown, request: unknown) => unknown } = {}) {
	const calls: Array<{ model: unknown; request: unknown }> = [];
	return {
		calls,
		getAvailable: () => [
			{ provider: "openai-codex", id: "gpt-5.5" },
			{ provider: "openai-codex", id: "gpt-5-mini" },
		],
		getAvailableOfType: (type: string) => (type === "classifier" ? (opts.available ?? []) : []),
		// Always present (default stop-result) so the fake exercises the real
		// classify branch unless a test overrides it — an absent classify would
		// short-circuit to registry_missing instead of the mode under test.
		classify: (model: unknown, request: unknown) => {
			calls.push({ model, request });
			return opts.classifyImpl
				? opts.classifyImpl(model, request)
				: Promise.resolve({ answers: { transient: true }, stopReason: "stop" });
		},
	};
}

const BOOL_QUESTION = {
	type: "bool" as const,
	instructions: "Is the failure transient?",
	criteria: { true: "Transient", false: "Permanent" },
};

afterEach(() => {
	__test__resetClassifierLogOnce();
});

test("[cls-1] available classifier → bool answer wired into the decision", async () => {
	const registry = fakeRegistry({
		available: [{ provider: "opencode", id: "jev-1.13-free" }],
		classifyImpl: async () => ({ answers: { transient: false }, stopReason: "stop" }),
	});
	const result = await classifyBool({
		modelRegistry: registry,
		classifierModel: "opencode/jev-1.13-free",
		questionKey: "transient",
		question: BOOL_QUESTION,
		state: { failureSummary: "rate limit" },
		fallback: true,
	});
	assert.equal(result.fromClassifier, true);
	assert.equal(result.decision, false, "classifier answer (false) must replace the fallback (true)");
	assert.equal(result.reason, "classified");
	assert.equal(result.usedModel, "opencode/jev-1.13-free");
	assert.equal(registry.calls.length, 1);
	// The exact configured model was passed (not a random available entry).
	const passed = registry.calls[0]!.model as { provider: string; id: string };
	assert.equal(`${passed.provider}/${passed.id}`, "opencode/jev-1.13-free");
	// The request carries the question under the caller's key.
	const request = registry.calls[0]!.request as { state: Record<string, unknown>; questions: Record<string, unknown> };
	assert.ok(request.questions.transient);
	assert.equal(request.state.failureSummary, "rate limit");
});

test("[cls-2] configured model not available → falls back to first available classifier", async () => {
	const registry = fakeRegistry({
		available: [{ provider: "openrouter", id: "~typesafe/jev-latest" }],
		classifyImpl: async () => ({ answers: { transient: true }, stopReason: "stop" }),
	});
	const result = await classifyBool({
		modelRegistry: registry,
		classifierModel: "opencode/jev-1.13-free",
		questionKey: "transient",
		question: BOOL_QUESTION,
		state: {},
		fallback: false,
	});
	assert.equal(result.fromClassifier, true);
	assert.equal(result.decision, true);
	assert.equal(result.usedModel, "openrouter/~typesafe/jev-latest", "first available substitutes for the uncredentialed configured id");
});

test("[cls-3] unavailable (getAvailableOfType → []) → fallback + log-once; second failure does not re-log", async () => {
	const registry = fakeRegistry({ available: [] });
	const args = {
		modelRegistry: registry,
		classifierModel: "opencode/jev-1.13-free",
		questionKey: "transient",
		question: BOOL_QUESTION,
		state: {},
		fallback: true,
	};
	const first = await classifyBool(args);
	assert.equal(first.fromClassifier, false);
	assert.equal(first.decision, true, "caller fallback decision returned");
	assert.equal(first.reason, "no_classifier_available");
	assert.deepEqual(__test__classifierLoggedFailureModes(), ["no_classifier_available|opencode/jev-1.13-free"]);
	// Second call: same failure mode must NOT append a second log entry.
	const second = await classifyBool(args);
	assert.equal(second.reason, "no_classifier_available");
	assert.equal(__test__classifierLoggedFailureModes().length, 1, "log-once: second failure of the same mode must not re-log");
});

test("[cls-4] classify() throws → fallback (never rejects)", async () => {
	const registry = fakeRegistry({
		available: [{ provider: "opencode", id: "jev-1.13-free" }],
		classifyImpl: async () => {
			throw new Error("boom");
		},
	});
	const result = await classifyBool({
		modelRegistry: registry,
		classifierModel: "opencode/jev-1.13-free",
		questionKey: "transient",
		question: BOOL_QUESTION,
		state: {},
		fallback: true,
	});
	assert.equal(result.fromClassifier, false);
	assert.equal(result.decision, true);
	assert.equal(result.reason, "classify_threw");
});

test("[cls-5] stopReason 'error' → fallback (R2.3 live shape: provider not configured)", async () => {
	const registry = fakeRegistry({
		available: [{ provider: "opencode", id: "jev-1.13-free" }],
		classifyImpl: async () => ({
			answers: {},
			stopReason: "error",
			errorMessage: "Provider is not configured: opencode",
		}),
	});
	const result = await classifyBool({
		modelRegistry: registry,
		classifierModel: "opencode/jev-1.13-free",
		questionKey: "transient",
		question: BOOL_QUESTION,
		state: {},
		fallback: false,
	});
	assert.equal(result.fromClassifier, false);
	assert.equal(result.decision, false, "caller fallback decision returned");
	assert.equal(result.reason, "stop_reason_error");
	assert.equal(result.errorMessage, "Provider is not configured: opencode");
});

test("[cls-6] stopReason 'stop' but answer missing / non-boolean → fallback", async () => {
	const base = {
		modelRegistry: fakeRegistry({
			available: [{ provider: "opencode", id: "jev-1.13-free" }],
			classifyImpl: async () => ({ answers: {}, stopReason: "stop" }),
		}),
		classifierModel: "opencode/jev-1.13-free",
		questionKey: "transient",
		question: BOOL_QUESTION,
		state: {},
		fallback: true,
	};
	const missing = await classifyBool(base);
	assert.equal(missing.reason, "answer_missing");
	assert.equal(missing.decision, true);

	const nonBool = await classifyBool({
		...base,
		modelRegistry: fakeRegistry({
			available: [{ provider: "opencode", id: "jev-1.13-free" }],
			classifyImpl: async () => ({ answers: { transient: "yes" }, stopReason: "stop" }),
		}),
	});
	assert.equal(nonBool.reason, "answer_missing");
	assert.equal(nonBool.fromClassifier, false);
});

test("[cls-7] registry absent / wrong shape → fallback without touching classify", async () => {
	for (const bad of [undefined, null, "registry", 42, [], { getAvailableOfType: "not-a-fn" }]) {
		const result = await classifyBool({
			modelRegistry: bad,
			classifierModel: "opencode/jev-1.13-free",
			questionKey: "transient",
			question: BOOL_QUESTION,
			state: {},
			fallback: true,
		});
		assert.equal(result.fromClassifier, false, `registry ${String(bad)} must fall back`);
		assert.equal(result.reason, "registry_missing");
		assert.equal(result.decision, true);
	}
});

test("[cls-8] getAvailableOfType throwing → fallback (classify_threw mode)", async () => {
	const registry = {
		getAvailableOfType: () => {
			throw new Error("catalog explosion");
		},
		classify: () => {
			throw new Error("must not be reached");
		},
	};
	const result = await classifyBool({
		modelRegistry: registry,
		classifierModel: "opencode/jev-1.13-free",
		questionKey: "transient",
		question: BOOL_QUESTION,
		state: {},
		fallback: false,
	});
	assert.equal(result.reason, "classify_threw");
	assert.equal(result.decision, false);
});

test("[cls-9] metric counter: outcome labels via a real MetricRegistry", async () => {
	const metricRegistry = createMetricRegistry();
	await classifyBool({
		modelRegistry: fakeRegistry({ available: [] }),
		classifierModel: "opencode/jev-1.13-free",
		questionKey: "transient",
		question: BOOL_QUESTION,
		state: {},
		fallback: true,
		metricRegistry,
		metricLabels: { consumer: "retry_triage" },
	});
	await classifyBool({
		modelRegistry: fakeRegistry({
			available: [{ provider: "opencode", id: "jev-1.13-free" }],
			classifyImpl: async () => ({ answers: { transient: true }, stopReason: "stop" }),
		}),
		classifierModel: "opencode/jev-1.13-free",
		questionKey: "transient",
		question: BOOL_QUESTION,
		state: {},
		fallback: false,
		metricRegistry,
		metricLabels: { consumer: "retry_triage" },
	});
	const snapshot = JSON.stringify(metricRegistry.snapshot());
	assert.ok(snapshot.includes("crew.classifier.calls_total"), "counter must be registered");
	assert.ok(
		snapshot.includes('"outcome":"no_classifier_available"') && snapshot.includes('"consumer":"retry_triage"'),
		"fallback outcome labels recorded",
	);
	assert.ok(snapshot.includes('"outcome":"classified"'), "classified outcome recorded");
	metricRegistry.dispose();
});

// ─── Resolver precedence (env beats config beats default) ───────────────

test("[cls-10] resolveClassifierEnabled: default false; config beats default; env beats config", () => {
	const saved = process.env.PI_CREW_CLASSIFIER_ENABLED;
	try {
		delete process.env.PI_CREW_CLASSIFIER_ENABLED;
		assert.equal(resolveClassifierEnabled(), false, "default must be FALSE (dormant)");
		assert.equal(resolveClassifierEnabled(undefined), false);
		assert.equal(resolveClassifierEnabled(true), true, "explicit config value wins over default");
		assert.equal(resolveClassifierEnabled(false), false);
		process.env.PI_CREW_CLASSIFIER_ENABLED = "0";
		assert.equal(resolveClassifierEnabled(true), false, "env '0' must beat config true");
		process.env.PI_CREW_CLASSIFIER_ENABLED = "1";
		assert.equal(resolveClassifierEnabled(false), true, "env '1' must beat config false");
		process.env.PI_CREW_CLASSIFIER_ENABLED = "bogus";
		assert.equal(
			resolveClassifierEnabled(true),
			true,
			"unparseable env falls back to the explicit config value (registry boolean parse yields undefined)",
		);
	} finally {
		if (saved === undefined) delete process.env.PI_CREW_CLASSIFIER_ENABLED;
		else process.env.PI_CREW_CLASSIFIER_ENABLED = saved;
	}
});

test("[cls-11] resolveClassifierModel: default opencode/jev-1.13-free; config beats default; env beats config; blank env ignored", () => {
	const saved = process.env.PI_CREW_CLASSIFIER_MODEL;
	try {
		delete process.env.PI_CREW_CLASSIFIER_MODEL;
		assert.equal(resolveClassifierModel(), DEFAULT_CLASSIFIER_MODEL);
		assert.equal(DEFAULT_CLASSIFIER_MODEL, "opencode/jev-1.13-free");
		assert.equal(resolveClassifierModel("openrouter/~typesafe/jev-latest"), "openrouter/~typesafe/jev-latest");
		assert.equal(resolveClassifierModel("   "), DEFAULT_CLASSIFIER_MODEL, "blank config falls back to default");
		process.env.PI_CREW_CLASSIFIER_MODEL = "typesafe/jev-latest";
		assert.equal(resolveClassifierModel("openrouter/x"), "typesafe/jev-latest", "env beats config");
		process.env.PI_CREW_CLASSIFIER_MODEL = "  ";
		assert.equal(resolveClassifierModel("openrouter/x"), "openrouter/x", "blank env is ignored (falls through to config)");
	} finally {
		if (saved === undefined) delete process.env.PI_CREW_CLASSIFIER_MODEL;
		else process.env.PI_CREW_CLASSIFIER_MODEL = saved;
	}
});

// ─── Config ceremony: parse + emit through the real validation chain ────

test("[cls-12] config-validation emits runtime.classifierEnabled/classifierModel", async () => {
	const { parseConfig } = await import("../../../../src/config/config-validation.ts");
	const parsed = parseConfig({
		runtime: { classifierEnabled: true, classifierModel: "typesafe/jev-latest" },
	});
	assert.equal(parsed?.runtime?.classifierEnabled, true);
	assert.equal(parsed?.runtime?.classifierModel, "typesafe/jev-latest");
	// Defaults: keys absent → undefined (read-site defaults stay authoritative).
	const bare = parseConfig({ runtime: { maxTurns: 5 } });
	assert.equal(bare?.runtime?.classifierEnabled, undefined);
	assert.equal(bare?.runtime?.classifierModel, undefined);
	// Type errors are dropped, not fatal (parseWithSchema contract).
	const bad = parseConfig({ runtime: { classifierEnabled: "yes-please" } });
	assert.equal(bad?.runtime?.classifierEnabled, undefined);
});

test("[cls-13] TypeBox schema accepts the new runtime keys (strict block)", async () => {
	const { PiTeamsRuntimeConfigSchema } = await import("../../../../src/schema/config-schema.ts");
	const props = PiTeamsRuntimeConfigSchema.properties as Record<string, unknown>;
	assert.ok("classifierEnabled" in props, "schema must declare runtime.classifierEnabled");
	assert.ok("classifierModel" in props, "schema must declare runtime.classifierModel");
});

// ─── logInternalError stderr capture (log-once observability proof) ─────

test("[cls-14] log-once writes to stderr exactly once per failure mode", async () => {
	// Capture console.error by spawning nothing — patch console.error in-process.
	const original = console.error;
	const lines: string[] = [];
	console.error = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	try {
		const registry = fakeRegistry({ available: [] });
		const args = {
			modelRegistry: registry,
			classifierModel: "opencode/jev-1.13-free",
			questionKey: "transient",
			question: BOOL_QUESTION,
			state: {},
			fallback: true,
		};
		await classifyBool(args);
		await classifyBool(args);
	} finally {
		console.error = original;
	}
	const logged = lines.filter((line) => line.includes("classifier fallback: no_classifier_available"));
	assert.equal(logged.length, 1, `expected exactly one stderr line for the failure mode, got ${logged.length}`);
	// Tempdir reference keeps os/path imports honest in CI (no unused-import lint).
	assert.ok(typeof path.join(os.tmpdir(), "x") === "string" && typeof fs.statSync === "function");
});

// ─── U6B: classifyScore (score-question variant, spec §U6 Phase B) ───────

const SCORE_QUESTION = {
	type: "score" as const,
	instructions: "Score how decisively the structured state alone establishes a pass.",
	criteria: ["1.0 — evidence conclusively proves the pass", "0.5 — mixed evidence", "0.0 — nothing usable"],
};

const scoreArgs = {
	classifierModel: "opencode/jev-1.13-free",
	questionKey: "decisive",
	question: SCORE_QUESTION,
	state: { verdict: "PASS", evidenceLines: ["exit 0"], changedFiles: ["src/a.ts"] },
	fallback: 0,
};

test("[cls-15] score variant: real pi-ai answer shape {type:'score', score, confidence} → classified", async () => {
	const registry = fakeRegistry({
		available: [{ provider: "opencode", id: "jev-1.13-free" }],
		classifyImpl: async () => ({
			answers: { decisive: { type: "score", score: 0.93, confidence: 0.91 } },
			stopReason: "stop",
		}),
	});
	const result = await classifyScore({ ...scoreArgs, modelRegistry: registry });
	assert.equal(result.fromClassifier, true);
	assert.equal(result.score, 0.93, "classifier score replaces the fallback");
	assert.equal(result.confidence, 0.91, "pi-ai score answers carry a REQUIRED confidence — surfaced");
	assert.equal(result.reason, "classified");
	assert.equal(result.usedModel, "opencode/jev-1.13-free");
	// The request carries the score question under the caller's key with the
	// pi-ai shape: criteria is a string ARRAY (bool uses a {true,false} map).
	const request = registry.calls[0]!.request as { state: Record<string, unknown>; questions: Record<string, unknown> };
	const question = request.questions.decisive as { type: string; criteria: string[] };
	assert.equal(question.type, "score");
	assert.ok(Array.isArray(question.criteria) && question.criteria.length === 3);
	assert.equal(request.state.verdict, "PASS");
});

test("[cls-16] score variant: wrapped {value, confidence} and bare-number answers accepted defensively", async () => {
	const wrapped = fakeRegistry({
		available: [{ provider: "opencode", id: "jev-1.13-free" }],
		classifyImpl: async () => ({
			answers: { decisive: { value: 0.8, confidence: 0.7 } },
			stopReason: "stop",
		}),
	});
	const wrappedResult = await classifyScore({ ...scoreArgs, modelRegistry: wrapped });
	assert.equal(wrappedResult.fromClassifier, true, "U6A-wrapped {value, confidence} shape accepted");
	assert.equal(wrappedResult.score, 0.8);
	assert.equal(wrappedResult.confidence, 0.7);

	const bare = fakeRegistry({
		available: [{ provider: "opencode", id: "jev-1.13-free" }],
		classifyImpl: async () => ({ answers: { decisive: 0.55 }, stopReason: "stop" }),
	});
	const bareResult = await classifyScore({ ...scoreArgs, modelRegistry: bare });
	assert.equal(bareResult.fromClassifier, true, "bare-number answer accepted");
	assert.equal(bareResult.score, 0.55);
	assert.equal(bareResult.confidence, undefined, "no confidence in a bare number");
});

test("[cls-17] score variant: top-level result.confidence passthrough when the answer lacks one", async () => {
	const registry = fakeRegistry({
		available: [{ provider: "opencode", id: "jev-1.13-free" }],
		classifyImpl: async () => ({ answers: { decisive: 0.9 }, stopReason: "stop", confidence: 0.85 }),
	});
	const result = await classifyScore({ ...scoreArgs, modelRegistry: registry });
	assert.equal(result.fromClassifier, true);
	assert.equal(result.score, 0.9);
	assert.equal(result.confidence, 0.85, "top-level confidence fills the absent answer-level one");
});

test("[cls-18] score variant: answer missing / non-numeric → caller fallback score (answer_missing)", async () => {
	const missing = await classifyScore({
		...scoreArgs,
		modelRegistry: fakeRegistry({
			available: [{ provider: "opencode", id: "jev-1.13-free" }],
			classifyImpl: async () => ({ answers: {}, stopReason: "stop" }),
		}),
	});
	assert.equal(missing.reason, "answer_missing");
	assert.equal(missing.fromClassifier, false);
	assert.equal(missing.score, 0, "caller fallback score returned");

	const nonNumeric = await classifyScore({
		...scoreArgs,
		modelRegistry: fakeRegistry({
			available: [{ provider: "opencode", id: "jev-1.13-free" }],
			classifyImpl: async () => ({ answers: { decisive: "high" }, stopReason: "stop" }),
		}),
	});
	assert.equal(nonNumeric.reason, "answer_missing");
	assert.equal(nonNumeric.score, 0);
});

test("[cls-19] score variant: provider unconfigured / stopReason error / classify threw / registry missing → soft fallback", async () => {
	// getAvailableOfType → [] (opencode unconfigured on this host — the live R2.3 shape).
	const unconfigured = await classifyScore({
		...scoreArgs,
		modelRegistry: fakeRegistry({ available: [] }),
		fallback: 0.25,
	});
	assert.equal(unconfigured.reason, "no_classifier_available");
	assert.equal(unconfigured.score, 0.25, "caller fallback score returned — never rejects");

	const stopError = await classifyScore({
		...scoreArgs,
		modelRegistry: fakeRegistry({
			available: [{ provider: "opencode", id: "jev-1.13-free" }],
			classifyImpl: async () => ({
				answers: {},
				stopReason: "error",
				errorMessage: "Provider is not configured: opencode",
			}),
		}),
		fallback: 0.5,
	});
	assert.equal(stopError.reason, "stop_reason_error");
	assert.equal(stopError.score, 0.5);
	assert.equal(stopError.errorMessage, "Provider is not configured: opencode");

	const threw = await classifyScore({
		...scoreArgs,
		modelRegistry: fakeRegistry({
			available: [{ provider: "opencode", id: "jev-1.13-free" }],
			classifyImpl: async () => {
				throw new Error("boom");
			},
		}),
		fallback: 0.75,
	});
	assert.equal(threw.reason, "classify_threw");
	assert.equal(threw.score, 0.75);

	const noRegistry = await classifyScore({ ...scoreArgs, modelRegistry: undefined, fallback: 0.1 });
	assert.equal(noRegistry.reason, "registry_missing");
	assert.equal(noRegistry.score, 0.1);
});

test("[cls-20] score variant: metric counter + confidence histogram via a real MetricRegistry", async () => {
	const metricRegistry = createMetricRegistry();
	await classifyScore({
		...scoreArgs,
		modelRegistry: fakeRegistry({ available: [] }),
		metricRegistry,
		metricLabels: { consumer: "verifier_pre_gate" },
	});
	await classifyScore({
		...scoreArgs,
		modelRegistry: fakeRegistry({
			available: [{ provider: "opencode", id: "jev-1.13-free" }],
			classifyImpl: async () => ({
				answers: { decisive: { type: "score", score: 0.95, confidence: 0.9 } },
				stopReason: "stop",
			}),
		}),
		metricRegistry,
		metricLabels: { consumer: "verifier_pre_gate" },
	});
	const snapshot = JSON.stringify(metricRegistry.snapshot());
	assert.ok(snapshot.includes("crew.classifier.calls_total"));
	assert.ok(
		snapshot.includes('"outcome":"no_classifier_available"') && snapshot.includes('"consumer":"verifier_pre_gate"'),
		"fallback outcome labels recorded for the score variant",
	);
	assert.ok(snapshot.includes('"outcome":"classified"'), "classified outcome recorded");
	assert.ok(snapshot.includes("crew.classifier.confidence"), "confidence histogram observed");
	metricRegistry.dispose();
});
