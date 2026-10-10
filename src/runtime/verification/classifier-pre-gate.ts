/**
 * U6B (upgrade spec 2026-10-09, §U6 Phase B): classifier VERIFIER PRE-GATE —
 * the third consumer of the P2-1 host classifier seam, alongside retry-triage
 * (child-executor.ts) and the ambient-noise gate (ambient-noise-gate.ts).
 *
 * Semantics: BEFORE an LLM verifier is spawned, the already-produced
 * STRUCTURED verdict state is scored by the cheap host classifier — ONE
 * `score` question (classifyScore, the graded sibling of classifyBool added
 * by U6B) over JSON state ONLY:
 *     { verdict, evidenceLines, changedFiles }
 * The classifier NEVER sees a diff, file contents, or prose transcripts — it
 * judges whether the structured state alone is decisive enough to skip the
 * LLM verifier spawn ("verdict được pre-gate chặn"). Every other outcome
 * escalates to the LLM verifier, exactly the pre-U6B spawn decision.
 *
 * ESCALATION POLICY (spec §U6 Phase B, mandatory — "escalate LLM khi
 * confidence thấp hoặc verdict FAILED"):
 *   - verdict failure-shaped (FAILED/error/blocked/...) or not clearly
 *     pass-shaped (INCONCLUSIVE/blank) → escalate (a cheap classifier may
 *     never rubber-stamp a failure or an ambiguous verdict);
 *   - provider confidence below BLOCK_CONFIDENCE_THRESHOLD (or unreported)
 *     → escalate;
 *   - score below BLOCK_SCORE_THRESHOLD (or outside 0..1) → escalate;
 *   - EVERY classifier failure mode (registry missing, `opencode` provider
 *     unconfigured → getAvailableOfType("classifier") = [], classify threw,
 *     stopReason error, answer missing) → escalate, soft.
 *
 * SOFT-BRANCH CONTRACT (spec caveat, mandatory):
 *   - `opencode` provider is sometimes unconfigured on this host — the
 *     pre-gate then degrades to "always escalate" (identical to pre-U6B
 *     behavior);
 *   - a WRONG classifier verdict can only cost ONE extra escalate (the LLM
 *     verifier runs anyway) or skip one spawn whose structured state showed a
 *     high-confidence unambiguous pass — it can NEVER fail a task. This
 *     module never throws up to the caller.
 *
 * Metrics (spec acceptance: % verdicts blocked by the pre-gate, % escalate,
 * zero task-fail due to classifier — flag OFF by default until data exists):
 *   - crew.classifier.calls_total{consumer="verifier_pre_gate",outcome} +
 *     crew.classifier.confidence via classifyScore (service level);
 *   - crew.classifier.decisions_total{consumer="verifier_pre_gate",
 *     decision=<action>} + a `task.verifier_pre_gate` diagnostic event ONLY
 *     when a real classifier answer informed the decision (fallback paths are
 *     already counted by the service's calls_total and must not double-report
 *     a decision they did not make). Percentages derive from decisions_total.
 *     NOTE: `task.verifier_pre_gate` is NOT yet in TEAM_EVENT_TYPES
 *     (src/state/contracts.ts) — src/state/** is outside U6B's file
 *     ownership, so registration is deferred to the U13 mount commit (see
 *     MOUNT POINT below); scripts/check-event-types-registry.mjs runs
 *     report-only today.
 *
 * Concurrency: the seam caps host classify at 4 parallel calls; each consumer
 * (retry-triage, ambient-noise gate, this pre-gate) issues at most ONE
 * concurrent call, so the aggregate stays within the budget.
 *
 * ── MOUNT POINT (U13 lane — this module is intentionally NOT wired yet) ──
 * The verifier spawn path stays UNTOUCHED by U6B per lane ownership:
 *   - verification-gates.ts command-gate spawn logic: NOT modified here
 *     (U13 owns the mount, spec §U13);
 *   - goal-loop judge spawn (goal-evaluator.ts evaluateGoal → runWorker):
 *     NOT modified here.
 * When U13 mounts the deterministic ctx.executeTool gates, insert this
 * pre-gate in the decision flow:
 *   1. run the deterministic gates (U13: typecheck / test:critical / grep
 *      evidence via ctx.executeTool) and build the structured verdict state:
 *        { verdict: "PASS"|"FAILED"|..., evidenceLines: [...], changedFiles: [...] };
 *   2. BEFORE spawning the LLM verifier:
 *        const preGate = await classifyVerifierPreGate({
 *            enabled: resolveClassifierEnabled(runtime.classifierEnabled), // default false
 *            modelRegistry: ctx.modelRegistry,
 *            classifierModel: resolveClassifierModel(runtime.classifierModel),
 *            verdict, eventsPath, runId, metricRegistry,
 *        });
 *      — preGate.blockVerifier === true → SKIP the LLM verifier spawn (the
 *        structured pass stands; mark the verdict's evaluator/model provenance
 *        e.g. "classifier-pre-gate/<model>" so consumers can tell);
 *      — otherwise → spawn the LLM verifier as today (optionally attach the
 *        pre-gate score/confidence to the verifier's prompt context).
 * The args/result interfaces below are the stable contract for that mount;
 * changes need both lanes' review.
 */
import type { MetricRegistry } from "../../observability/metric-registry.ts";
import { appendEventAsync } from "../../state/event-log/event-log.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { classifyScore } from "../classifier/classifier-service.ts";

/** Structured verdict state the classifier reasons over — JSON state ONLY
 *  (spec: "chỉ JSON state, KHÔNG phán diff"). Built by the deterministic
 *  gates (U13) / the verdict-producing step; never diffs, never file
 *  contents — only labels, evidence lines and file NAMES. */
export interface VerifierPreGateVerdictState {
	/** Short structured verdict label, e.g. "PASS", "FAILED", "INCONCLUSIVE". */
	verdict: string;
	/** Structured evidence lines (command exit codes, artifact refs). Capped before classify. */
	evidenceLines: string[];
	/** Changed-file paths (names only). Capped before classify. */
	changedFiles: string[];
}

export type VerifierPreGateAction =
	| "disabled"
	| "blocked"
	| "escalate_verdict_failed"
	| "escalate_low_confidence"
	| "escalate_low_score"
	| "escalate_fallback";

/** Default score at/above which a pass-shaped verdict blocks the LLM verifier spawn. */
export const VERIFIER_PRE_GATE_BLOCK_SCORE_THRESHOLD = 0.9;
/** Default provider confidence at/above which blocking is allowed. An
 *  unreported confidence NEVER blocks (defensive: block is the risky branch). */
export const VERIFIER_PRE_GATE_BLOCK_CONFIDENCE_THRESHOLD = 0.8;

const VERDICT_MAX_CHARS = 200;
const EVIDENCE_MAX_LINES = 8;
const EVIDENCE_LINE_MAX_CHARS = 200;
const CHANGED_FILES_MAX = 16;

const VERDICT_FAIL_RE = /\b(fail(?:ed|ure)?|error(?:ed)?|blocked|fatal|timeout|timed[- ]out|red)\b/i;
const VERDICT_PASS_RE = /\b(pass(?:ed)?|green|succeed(?:ed)?|success(?:ful)?|ok|achieved|complete(?:d)?)\b/i;

/** A verdict reaches the block path ONLY when unambiguously pass-shaped:
 *  matches PASS vocabulary AND carries no failure vocabulary. Explicit
 *  failures and ambiguous labels ("INCONCLUSIVE", blank) both escalate. */
function isPassShapedVerdict(verdict: string): boolean {
	return VERDICT_PASS_RE.test(verdict) && !VERDICT_FAIL_RE.test(verdict);
}

/** Cap the classifier state — classifiers reason over small low-cardinality
 *  JSON; the verdict fields are worker-influenced and can be arbitrarily
 *  long, so every string is bounded before it reaches the classify call. */
function capVerdictState(verdict: VerifierPreGateVerdictState): Record<string, unknown> {
	return {
		verdict: verdict.verdict.slice(0, VERDICT_MAX_CHARS),
		evidenceLines: verdict.evidenceLines.slice(0, EVIDENCE_MAX_LINES).map((line) => line.slice(0, EVIDENCE_LINE_MAX_CHARS)),
		changedFiles: verdict.changedFiles.slice(0, CHANGED_FILES_MAX).map((file) => file.slice(0, EVIDENCE_LINE_MAX_CHARS)),
	};
}

export interface VerifierPreGateArgs {
	/** Pre-resolved gate (resolveClassifierEnabled) — false short-circuits before ANY registry touch (dormant default). */
	enabled: boolean;
	/** Host-process model registry (ctx.modelRegistry, threaded unknown). */
	modelRegistry: unknown;
	/** Pre-resolved classifier model id (resolveClassifierModel). */
	classifierModel: string;
	/** Structured verdict state (JSON state only — never diffs). */
	verdict: VerifierPreGateVerdictState;
	/** Score at/above which a pass-shaped verdict blocks the spawn (default VERIFIER_PRE_GATE_BLOCK_SCORE_THRESHOLD). */
	blockScoreThreshold?: number;
	/** Confidence at/above which blocking is allowed (default VERIFIER_PRE_GATE_BLOCK_CONFIDENCE_THRESHOLD). */
	blockConfidenceThreshold?: number;
	/** Event-log identity for the task.verifier_pre_gate diagnostic event. */
	eventsPath: string;
	runId: string;
	/** Optional task id (the goal-loop judge is not a task — omit there). */
	taskId?: string;
	/** Optional host metric registry (crew.classifier.* counters/histograms). */
	metricRegistry?: MetricRegistry;
}

export interface VerifierPreGateResult {
	/** true → skip the LLM verifier spawn: the structured verdict stands as a pass. */
	blockVerifier: boolean;
	/** true ONLY when a real classifier answer informed the decision (event + decision metric emitted). */
	consulted: boolean;
	/** Which branch produced the outcome (metric label + event data). */
	action: VerifierPreGateAction;
	/** Classifier score reading, when consulted. */
	score: number | undefined;
	/** Provider-reported confidence, when consulted and reported. */
	confidence: number | undefined;
}

/**
 * Ask the verifier pre-gate. NEVER REJECTS and never throws up to the
 * caller — the disabled path returns without touching the registry (zero
 * behavior change: flag off by default), every classifier failure mode falls
 * back to "spawn the LLM verifier" (blockVerifier false).
 */
export async function classifyVerifierPreGate(args: VerifierPreGateArgs): Promise<VerifierPreGateResult> {
	if (!args.enabled) {
		return { blockVerifier: false, consulted: false, action: "disabled", score: undefined, confidence: undefined };
	}
	const scoreThreshold = args.blockScoreThreshold ?? VERIFIER_PRE_GATE_BLOCK_SCORE_THRESHOLD;
	const confidenceThreshold = args.blockConfidenceThreshold ?? VERIFIER_PRE_GATE_BLOCK_CONFIDENCE_THRESHOLD;
	const result = await classifyScore({
		modelRegistry: args.modelRegistry,
		classifierModel: args.classifierModel,
		questionKey: "decisive",
		question: {
			type: "score",
			instructions:
				"A unit of work reports a STRUCTURED verification verdict (JSON state only — you see no diffs and no file contents). Spawning an expensive LLM verifier is being considered. Score how DECISIVELY the structured state ALONE establishes that the work genuinely PASSED verification.",
			criteria: [
				"1.0 — the evidence lines conclusively prove the pass (explicit passing command exits, concrete artifact refs) and the changed-files list matches the work's expected scope",
				"0.75 — evidence is strong but at least one line is a claim rather than an artifact",
				"0.5 — evidence is mixed: some lines pass, others are inconclusive",
				"0.25 — evidence is thin, generic, or mostly absent",
				"0.0 — the state proves nothing usable, or any line already indicates a failure",
			],
		},
		state: capVerdictState(args.verdict),
		fallback: 0,
		metricRegistry: args.metricRegistry,
		metricLabels: { consumer: "verifier_pre_gate" },
	});
	if (!result.fromClassifier) {
		// Soft: every classifier failure mode (provider unconfigured, thrown
		// call, malformed answer) escalates — identical to the pre-U6B spawn
		// decision. The service's calls_total already counted the outcome; no
		// decision was made, so no decision metric/event (noise-gate pattern).
		return { blockVerifier: false, consulted: false, action: "escalate_fallback", score: undefined, confidence: undefined };
	}
	let action: VerifierPreGateAction;
	if (!isPassShapedVerdict(args.verdict.verdict)) {
		// Spec: escalate when verdict FAILED — and defensively for anything not
		// unambiguously pass-shaped. Ordered FIRST: a cheap classifier may
		// never rubber-stamp a failure, whatever its score/confidence.
		action = "escalate_verdict_failed";
	} else if (result.confidence === undefined || result.confidence < confidenceThreshold) {
		// Spec: escalate when confidence thấp. An unreported confidence counts
		// as low — blocking is the risky branch and needs positive certainty.
		action = "escalate_low_confidence";
	} else if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1 || result.score < scoreThreshold) {
		// Spec: block only on a decisively high score. Out-of-range scores are
		// treated as non-decisive (defensive) — malformed can only escalate.
		action = "escalate_low_score";
	} else {
		action = "blocked";
	}
	const blockVerifier = action === "blocked";
	try {
		args.metricRegistry
			?.counter("crew.classifier.decisions_total", "Classifier-informed decisions by consumer and verdict")
			.inc({ consumer: "verifier_pre_gate", decision: action });
	} catch (metricError) {
		logInternalError("classifier-pre-gate.metric", metricError, `decision=${action}`, "warn");
	}
	void appendEventAsync(args.eventsPath, {
		type: "task.verifier_pre_gate",
		runId: args.runId,
		...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
		message: blockVerifier
			? "Verifier pre-gate BLOCKED the LLM verifier spawn (structured pass stands)"
			: `Verifier pre-gate escalated to the LLM verifier (${action})`,
		data: {
			action,
			verdict: args.verdict.verdict.slice(0, VERDICT_MAX_CHARS),
			score: result.score,
			confidence: result.confidence,
			classifierModel: result.usedModel,
			configuredModel: args.classifierModel,
			stopReason: result.stopReason,
			evidenceLineCount: args.verdict.evidenceLines.length,
			changedFileCount: args.verdict.changedFiles.length,
		},
	}).catch(() => {
		/* no-op: best-effort diagnostic append, ignore delivery errors */
	});
	return { blockVerifier, consulted: true, action, score: result.score, confidence: result.confidence };
}
