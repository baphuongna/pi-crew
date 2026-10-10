/**
 * P2-1 (pi 1.0.4 adoption, 2026-10-07): host-process classifier seam.
 *
 * Thin never-rejects wrapper around the Pi extension-surface classifier API
 * (`ctx.modelRegistry.classify()` — docs/models.md:137-138 of the 1.0.4
 * release: "Extensions call classifiers through ctx.modelRegistry.classify(),
 * without codemode"). HOST-PROCESS ONLY: the registry handle lives on the
 * extension ctx in this process — child `pi -p` workers are separate
 * processes with no ctx and must never import this path.
 *
 * Contract (adoption review §R2.3, R2-V probe p3b):
 *   - classifier unavailable (`getAvailableOfType("classifier")` → [] — the
 *     catalog lists models but no provider is credentialed) → caller fallback;
 *   - classify() throws → caller fallback;
 *   - result.stopReason !== "stop" (e.g. "error" + errorMessage
 *     "Provider is not configured: opencode" on this host) → caller fallback;
 *   - answer missing / not boolean-shaped → caller fallback;
 *   - classify() must NEVER throw up to the orchestrator.
 *
 * Every fallback mode logs ONCE per (mode, model) per process (log-once set)
 * and increments `crew.classifier.calls_total{outcome}` when a metric
 * registry is threaded — mirrors the dispatch-batch retry-counter pattern
 * (dispatch-batch.ts:812). Defaults are DORMANT: callers gate on
 * resolveClassifierEnabled() (runtime.classifierEnabled, default false).
 */
import { getCrewEnvBool, getCrewEnvString } from "../../config/env-vars.ts";
import type { MetricRegistry } from "../../observability/metric-registry.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { modelStringFromUnknown } from "../model/model-fallback.ts";

/** Default classifier model (runtime.classifierModel default). */
export const DEFAULT_CLASSIFIER_MODEL = "opencode/jev-1.13-free";

/** One typed yes/no question (codemode classify question shape, bool type). */
export interface ClassifierBoolQuestion {
	type: "bool";
	instructions: string;
	/** Label per answer — helps the classifier ground the decision. */
	criteria?: { true: string; false: string };
}

/** U6B (upgrade spec 2026-10-09 §U6 Phase B): one typed SCORE question — the
 *  graded sibling of {@link ClassifierBoolQuestion}, used by the verifier
 *  pre-gate. Mirrors pi-ai's ClassifierScoreQuestion (pi-ai dist/types.d.ts:
 *  {type:"score", instructions, criteria: string[]}); answers arrive as the
 *  ClassifierScoreAnswer shape {type:"score", score, confidence} — score is
 *  the graded 0..1 reading, confidence the provider-reported certainty. */
export interface ClassifierScoreQuestion {
	type: "score";
	instructions: string;
	/** Rubric anchors for the 0..1 scale, ordered decisive (1.0) → useless (0.0). */
	criteria: string[];
}

/** Request body for modelRegistry.classify(model, request). */
export interface ClassifyRequest {
	state: Record<string, unknown>;
	questions: Record<string, ClassifierBoolQuestion | ClassifierScoreQuestion>;
}

/** Structured result shape returned by modelRegistry.classify (never throws
 *  per model-registry.d.ts — but we still guard a throwing implementation).
 *  U6A (spec 2026-10-09 §U6 Phase A): `confidence` is a passthrough — the
 *  classify API documents answers "kèm confidence" (research §8.2); when a
 *  provider reports it (top-level or per-answer `{value, confidence}`), we
 *  surface it on the result + `crew.classifier.confidence` histogram. */
export interface ClassifyCallResult {
	answers?: Record<string, unknown>;
	stopReason?: string;
	errorMessage?: string;
	confidence?: number;
}

/** Duck-typed host registry handle (mirrors ModelRegistryLike in
 *  model-fallback.ts — the runtime threads the real ctx.modelRegistry as
 *  `unknown`). NOTE: on the real 1.0.4 ModelRegistry, getAvailableOfType is
 *  ASYNC (returns a Promise — model-registry.d.ts) while getModelsOfType is
 *  sync; the duck type accepts both shapes and classifyBool awaits. */
export interface ClassifierModelRegistryLike {
	getAvailableOfType?: (type: string) => Promise<unknown[]> | unknown[];
	classify?: (model: unknown, request: ClassifyRequest) => Promise<ClassifyCallResult> | ClassifyCallResult;
}

export type ClassifierOutcomeReason =
	| "classified"
	| "registry_missing"
	| "no_classifier_available"
	| "classify_threw"
	| "stop_reason_error"
	| "answer_missing";

export interface ClassifyBoolInput {
	/** Host-process model registry handle (ctx.modelRegistry, threaded unknown). */
	modelRegistry: unknown;
	/** Configured classifier model id ("provider/id"). */
	classifierModel: string;
	/** Key under `questions` carrying the bool question. */
	questionKey: string;
	question: ClassifierBoolQuestion;
	/** JSON state the classifier reasons about (keep small + low-cardinality). */
	state: Record<string, unknown>;
	/** Caller-provided fallback decision — returned on EVERY failure mode. */
	fallback: boolean;
	/** Optional metric registry (counter created on demand, dispatch-batch style). */
	metricRegistry?: MetricRegistry;
	/** Extra low-cardinality labels for the calls_total counter. */
	metricLabels?: Record<string, string>;
}

export interface ClassifyBoolResult {
	/** Effective decision: the classifier answer, or the caller fallback. */
	decision: boolean;
	/** True ONLY when a real classifier answer informed the decision. */
	fromClassifier: boolean;
	/** Which branch produced the outcome (diagnostics + metric label). */
	reason: ClassifierOutcomeReason;
	/** Classifier model id actually used (undefined on every fallback path). */
	usedModel: string | undefined;
	/** Raw stopReason / errorMessage from the classify call, when one ran. */
	stopReason: string | undefined;
	errorMessage: string | undefined;
	/** U6A: provider-reported answer confidence, when the registry supplied
	 *  one (top-level `confidence` or per-answer `{value, confidence}`).
	 *  Undefined on every fallback path and for bare-boolean answers. */
	confidence: number | undefined;
}

export interface ClassifyScoreInput {
	/** Host-process model registry handle (ctx.modelRegistry, threaded unknown). */
	modelRegistry: unknown;
	/** Configured classifier model id ("provider/id"). */
	classifierModel: string;
	/** Key under `questions` carrying the score question. */
	questionKey: string;
	question: ClassifierScoreQuestion;
	/** JSON state the classifier reasons about (keep small + low-cardinality). */
	state: Record<string, unknown>;
	/** Caller-provided fallback score — returned on EVERY failure mode. */
	fallback: number;
	/** Optional metric registry (counter created on demand, dispatch-batch style). */
	metricRegistry?: MetricRegistry;
	/** Extra low-cardinality labels for the calls_total counter. */
	metricLabels?: Record<string, string>;
}

export interface ClassifyScoreResult {
	/** Effective graded reading: the classifier score, or the caller fallback. */
	score: number;
	/** True ONLY when a real classifier answer informed the score. */
	fromClassifier: boolean;
	/** Which branch produced the outcome (diagnostics + metric label). */
	reason: ClassifierOutcomeReason;
	/** Classifier model id actually used (undefined on every fallback path). */
	usedModel: string | undefined;
	/** Raw stopReason / errorMessage from the classify call, when one ran. */
	stopReason: string | undefined;
	errorMessage: string | undefined;
	/** Provider-reported answer confidence (answer-level or top-level), when
	 *  supplied. The pi-ai ClassifierScoreAnswer shape marks confidence
	 *  REQUIRED, but a defensive read tolerates its absence. Undefined on
	 *  every fallback path. */
	confidence: number | undefined;
}

/**
 * Log-once state: `${reason}|${classifierModel}`. Module-level on purpose —
 * per-call-site instances would re-log on every consumer invocation; the
 * process-wide set matches the "log-once per failure mode" contract.
 * @internal — test introspection/reset.
 */
const loggedFailureModes = new Set<string>();

/** @internal — test hook: reset the log-once set between test cases. */
export function __test__resetClassifierLogOnce(): void {
	loggedFailureModes.clear();
}

/** @internal — test hook: observe the log-once set (assert no re-log). */
export function __test__classifierLoggedFailureModes(): string[] {
	return [...loggedFailureModes];
}

function noteFailureMode(reason: ClassifierOutcomeReason, classifierModel: string, detail: string): void {
	const key = `${reason}|${classifierModel}`;
	if (loggedFailureModes.has(key)) return;
	loggedFailureModes.add(key);
	logInternalError("classifier-service", new Error(`classifier fallback: ${reason}`), detail, "warn");
}

function outcomeMetric(
	metricRegistry: MetricRegistry | undefined,
	reason: ClassifierOutcomeReason,
	labels: Record<string, string> | undefined,
): void {
	try {
		metricRegistry?.counter("crew.classifier.calls_total", "Classifier calls by outcome").inc({
			outcome: reason,
			...labels,
		});
	} catch (error) {
		// Metric plumbing must never break the never-rejects contract.
		logInternalError("classifier-service.metric", error, `outcome=${reason}`, "warn");
	}
}

/** U6A: observe the provider-reported confidence when one was supplied.
 *  Mirrors outcomeMetric's never-break contract. */
function confidenceMetric(
	metricRegistry: MetricRegistry | undefined,
	confidence: number | undefined,
	labels: Record<string, string> | undefined,
): void {
	if (confidence === undefined) return;
	try {
		metricRegistry
			?.histogram("crew.classifier.confidence", "Classifier answer confidence when reported", [0.25, 0.5, 0.75, 0.9, 0.99])
			.observe({ ...labels }, confidence);
	} catch (error) {
		// Metric plumbing must never break the never-rejects contract.
		logInternalError("classifier-service.metric", error, `confidence=${confidence}`, "warn");
	}
}

/** Normalize a registry handle into the duck-typed classifier surface. */
function asClassifierRegistry(modelRegistry: unknown): ClassifierModelRegistryLike | undefined {
	if (!modelRegistry || typeof modelRegistry !== "object" || Array.isArray(modelRegistry)) return undefined;
	return modelRegistry as ClassifierModelRegistryLike;
}

/**
 * Resolve classifier-enabled precedence: env PI_CREW_CLASSIFIER_ENABLED beats
 * runtime.classifierEnabled beats default FALSE (dormant). Mirrors
 * resolveHermeticWorkers (pi-args.ts) — env wins in either direction.
 */
export function resolveClassifierEnabled(explicit?: boolean): boolean {
	const env = getCrewEnvBool("PI_CREW_CLASSIFIER_ENABLED");
	if (env !== undefined) return env;
	return explicit ?? false;
}

/**
 * Resolve classifier-model precedence: env PI_CREW_CLASSIFIER_MODEL beats
 * runtime.classifierModel beats DEFAULT_CLASSIFIER_MODEL. Blank env values
 * are ignored (fall through to config/default) — conservative.
 */
export function resolveClassifierModel(explicit?: string): string {
	const env = getCrewEnvString("PI_CREW_CLASSIFIER_MODEL");
	if (env !== undefined && env.trim().length > 0) return env.trim();
	return explicit && explicit.trim().length > 0 ? explicit.trim() : DEFAULT_CLASSIFIER_MODEL;
}

/**
 * Internal shared pipeline for the typed classify wrappers (U6B): resolves a
 * usable classifier and runs ONE classify call, returning either the raw
 * answer for the question key or a fallback marker with the outcome reason.
 * Every registry-level failure mode (missing registry, zero credentialed
 * classifiers, thrown call, non-"stop" stopReason) logs once + counts its
 * metric here; answer interpretation (classified / answer_missing) stays
 * with the typed wrappers so each keeps its own acceptance shape. The
 * observable behavior of classifyBool is unchanged by the extraction (its
 * landed tests are the equivalence guard).
 */
interface ClassifyPipelineInput {
	/** Host-process model registry handle (ctx.modelRegistry, threaded unknown). */
	modelRegistry: unknown;
	/** Configured classifier model id ("provider/id"). */
	classifierModel: string;
	/** Key under `questions` carrying the typed question. */
	questionKey: string;
	question: ClassifierBoolQuestion | ClassifierScoreQuestion;
	/** JSON state the classifier reasons about (keep small + low-cardinality). */
	state: Record<string, unknown>;
	/** Optional metric registry (counter created on demand, dispatch-batch style). */
	metricRegistry?: MetricRegistry;
	/** Extra low-cardinality labels for the calls_total counter. */
	metricLabels?: Record<string, string>;
}

interface ClassifyPipelineOk {
	status: "ok";
	/** Raw answers[questionKey] value — the wrapper decides the acceptance shape. */
	rawAnswer: unknown;
	/** Top-level result.confidence passthrough, when finite. */
	topLevelConfidence: number | undefined;
	stopReason: string | undefined;
	errorMessage: string | undefined;
	usedModel: string;
}

interface ClassifyPipelineFallback {
	status: "fallback";
	reason: ClassifierOutcomeReason;
	stopReason: string | undefined;
	errorMessage: string | undefined;
}

async function runClassifyQuestion(input: ClassifyPipelineInput): Promise<ClassifyPipelineOk | ClassifyPipelineFallback> {
	const registry = asClassifierRegistry(input.modelRegistry);
	if (!registry || typeof registry.getAvailableOfType !== "function" || typeof registry.classify !== "function") {
		noteFailureMode("registry_missing", input.classifierModel, "model registry absent or lacks the classifier surface");
		outcomeMetric(input.metricRegistry, "registry_missing", input.metricLabels);
		return { status: "fallback", reason: "registry_missing", stopReason: undefined, errorMessage: undefined };
	}
	// Credentialed classifiers only — the catalog (getModelsOfType) can list
	// models whose provider has no key on this host (R2.3: 6 catalog entries,
	// 0 available). getAvailableOfType is the availability oracle (ASYNC on
	// the real registry — model-registry.d.ts).
	let available: unknown[];
	try {
		available = (await registry.getAvailableOfType("classifier")) ?? [];
	} catch (error) {
		noteFailureMode("classify_threw", input.classifierModel, `getAvailableOfType threw: ${String(error)}`);
		outcomeMetric(input.metricRegistry, "classify_threw", input.metricLabels);
		return { status: "fallback", reason: "classify_threw", stopReason: undefined, errorMessage: undefined };
	}
	if (!Array.isArray(available) || available.length === 0) {
		noteFailureMode(
			"no_classifier_available",
			input.classifierModel,
			"getAvailableOfType('classifier') is empty — no credentialed classifier",
		);
		outcomeMetric(input.metricRegistry, "no_classifier_available", input.metricLabels);
		return { status: "fallback", reason: "no_classifier_available", stopReason: undefined, errorMessage: undefined };
	}
	// Prefer the configured model id; fall back to the first available
	// candidate so a renamed catalog id still gets a usable classifier.
	const requested = input.classifierModel.trim();
	const normalized = available.map((entry) => modelStringFromUnknown(entry)).filter((id): id is string => id !== undefined);
	const matchedIndex = normalized.indexOf(requested);
	const chosenIndex = matchedIndex >= 0 ? matchedIndex : 0;
	const chosen = available[chosenIndex];
	const usedModel = normalized[chosenIndex] ?? requested;
	try {
		const result = await registry.classify(chosen, {
			state: input.state,
			questions: { [input.questionKey]: input.question },
		});
		const stopReason = typeof result?.stopReason === "string" ? result.stopReason : undefined;
		const errorMessage = typeof result?.errorMessage === "string" ? result.errorMessage : undefined;
		if (stopReason !== "stop") {
			noteFailureMode(
				"stop_reason_error",
				input.classifierModel,
				`classify stopReason=${stopReason ?? "undefined"}${errorMessage ? ` errorMessage=${errorMessage}` : ""}`,
			);
			outcomeMetric(input.metricRegistry, "stop_reason_error", input.metricLabels);
			return { status: "fallback", reason: "stop_reason_error", stopReason, errorMessage };
		}
		const topLevelConfidence =
			typeof result?.confidence === "number" && Number.isFinite(result.confidence) ? result.confidence : undefined;
		return {
			status: "ok",
			rawAnswer: result?.answers?.[input.questionKey],
			topLevelConfidence,
			stopReason,
			errorMessage,
			usedModel,
		};
	} catch (error) {
		// The registry contract says classify never rejects, but a misbehaving
		// implementation must still not take the orchestrator down with it.
		noteFailureMode("classify_threw", input.classifierModel, `classify threw: ${String(error)}`);
		outcomeMetric(input.metricRegistry, "classify_threw", input.metricLabels);
		return { status: "fallback", reason: "classify_threw", stopReason: undefined, errorMessage: undefined };
	}
}

/**
 * Ask ONE bool question of a host-process classifier. NEVER REJECTS — every
 * failure mode (no registry, no credentialed classifier, thrown error,
 * stopReason !== "stop", missing/non-boolean answer) returns the
 * caller-provided fallback with {@link ClassifyBoolResult.fromClassifier}
 * false, after a log-once note + metric counter increment.
 */
export async function classifyBool(input: ClassifyBoolInput): Promise<ClassifyBoolResult> {
	const outcome = await runClassifyQuestion(input);
	if (outcome.status === "fallback") {
		return {
			decision: input.fallback,
			fromClassifier: false,
			reason: outcome.reason,
			usedModel: undefined,
			stopReason: outcome.stopReason,
			errorMessage: outcome.errorMessage,
			confidence: undefined,
		};
	}
	const rawAnswer = outcome.rawAnswer;
	// U6A: bool answers arrive either as a bare boolean or wrapped with a
	// confidence reading (`{value: boolean, confidence: number}` — research
	// §8.2 "typed choice/score/bool ... answers carry confidence"). Accept
	// both shapes; everything else stays the answer_missing fallback.
	let answer: boolean | undefined;
	let confidence: number | undefined;
	if (typeof rawAnswer === "boolean") {
		answer = rawAnswer;
	} else if (rawAnswer && typeof rawAnswer === "object" && !Array.isArray(rawAnswer)) {
		const wrapped = rawAnswer as { value?: unknown; confidence?: unknown };
		if (typeof wrapped.value === "boolean") {
			answer = wrapped.value;
			if (typeof wrapped.confidence === "number" && Number.isFinite(wrapped.confidence)) {
				confidence = wrapped.confidence;
			}
		}
	}
	if (outcome.topLevelConfidence !== undefined && confidence === undefined) {
		confidence = outcome.topLevelConfidence;
	}
	if (answer === undefined) {
		noteFailureMode("answer_missing", input.classifierModel, `answers[${input.questionKey}] is ${typeof rawAnswer}, expected boolean`);
		outcomeMetric(input.metricRegistry, "answer_missing", input.metricLabels);
		return {
			decision: input.fallback,
			fromClassifier: false,
			reason: "answer_missing",
			usedModel: undefined,
			stopReason: outcome.stopReason,
			errorMessage: outcome.errorMessage,
			confidence: undefined,
		};
	}
	outcomeMetric(input.metricRegistry, "classified", input.metricLabels);
	confidenceMetric(input.metricRegistry, confidence, input.metricLabels);
	return {
		decision: answer,
		fromClassifier: true,
		reason: "classified",
		usedModel: outcome.usedModel,
		stopReason: outcome.stopReason,
		errorMessage: outcome.errorMessage,
		confidence,
	};
}

/**
 * Ask ONE score question of a host-process classifier (U6B — the graded
 * sibling of {@link classifyBool}, consumer: verifier pre-gate). NEVER
 * REJECTS — every failure mode (no registry, no credentialed classifier,
 * thrown error, stopReason !== "stop", missing/non-numeric answer) returns
 * the caller-provided fallback score with
 * {@link ClassifyScoreResult.fromClassifier} false, after a log-once note +
 * metric counter increment. A malformed or unconfigured classifier can only
 * degrade to the caller fallback — it can never fail a task.
 */
export async function classifyScore(input: ClassifyScoreInput): Promise<ClassifyScoreResult> {
	const outcome = await runClassifyQuestion(input);
	if (outcome.status === "fallback") {
		return {
			score: input.fallback,
			fromClassifier: false,
			reason: outcome.reason,
			usedModel: undefined,
			stopReason: outcome.stopReason,
			errorMessage: outcome.errorMessage,
			confidence: undefined,
		};
	}
	const rawAnswer = outcome.rawAnswer;
	// Real pi-ai shape (ClassifierScoreAnswer): {type:"score", score: number,
	// confidence: number} — the type marks confidence REQUIRED, but a
	// defensive read tolerates its absence. A bare-number answer and the U6A
	// wrapped {value, confidence} shape are accepted for symmetry with
	// classifyBool; everything else stays the answer_missing fallback.
	let score: number | undefined;
	let confidence: number | undefined;
	if (typeof rawAnswer === "number" && Number.isFinite(rawAnswer)) {
		score = rawAnswer;
	} else if (rawAnswer && typeof rawAnswer === "object" && !Array.isArray(rawAnswer)) {
		const wrapped = rawAnswer as { score?: unknown; value?: unknown; confidence?: unknown };
		const candidate =
			typeof wrapped.score === "number" && Number.isFinite(wrapped.score)
				? wrapped.score
				: typeof wrapped.value === "number" && Number.isFinite(wrapped.value)
					? wrapped.value
					: undefined;
		if (candidate !== undefined) {
			score = candidate;
			if (typeof wrapped.confidence === "number" && Number.isFinite(wrapped.confidence)) {
				confidence = wrapped.confidence;
			}
		}
	}
	if (outcome.topLevelConfidence !== undefined && confidence === undefined) {
		confidence = outcome.topLevelConfidence;
	}
	if (score === undefined) {
		noteFailureMode(
			"answer_missing",
			input.classifierModel,
			`answers[${input.questionKey}] is ${typeof rawAnswer}, expected score number`,
		);
		outcomeMetric(input.metricRegistry, "answer_missing", input.metricLabels);
		return {
			score: input.fallback,
			fromClassifier: false,
			reason: "answer_missing",
			usedModel: undefined,
			stopReason: outcome.stopReason,
			errorMessage: outcome.errorMessage,
			confidence: undefined,
		};
	}
	outcomeMetric(input.metricRegistry, "classified", input.metricLabels);
	confidenceMetric(input.metricRegistry, confidence, input.metricLabels);
	return {
		score,
		fromClassifier: true,
		reason: "classified",
		usedModel: outcome.usedModel,
		stopReason: outcome.stopReason,
		errorMessage: outcome.errorMessage,
		confidence,
	};
}
