/**
 * U13 (upgrade spec 2026-10-09 §U13): DETERMINISTIC VERIFIER PRE-GATE ENGINE.
 *
 * The spec's probe (round 10, 13/13 checks) proved extension tools can run
 * other tools deterministically in the host process via
 * `ctx.executeTool("bash", ...)` — the 5th parameter of ToolDefinition.execute
 * (nested id `<parent>/1`, errors arrive as isError VALUES not throws,
 * `exit_code` readable in structuredContent; limits 256 nested calls / 8KB
 * per call / 32KB total args). That unlocks running the verifier's
 * deterministic checks (typecheck / test:critical / grep evidence lines) for
 * FREE before deciding whether the expensive LLM verifier worker must spawn.
 *
 * TWO ENTRY POINTS share this pure engine:
 *   1. the `verify_gate` TOOL (src/extension/registration/verify-gate-tool.ts)
 *      — runs checks via ctx.executeTool("bash", ...) in the host process,
 *      exposure "codemode" (hidden from the model, callable by other tools);
 *   2. the verifier SPAWN SITE (task-runner.ts runTeamTask) — runs the same
 *      engine through the hardened subprocess runner already exported by
 *      verification-gates.ts (executeCommand: command validation, sanitized
 *      env, process-group kill, output cap, timeout).
 *
 * TWO-LAYER DECISION (spec: "kết hợp classifier pre-gate U6-B — deterministic
 * trước, classifier sau"):
 *   - Layer 1 (deterministic, this module): gate PASS → SKIP the LLM verifier
 *     (U13 acceptance: "một run verification với gate xanh không spawn LLM
 *     verifier"); gate FAILED → spawn the LLM verifier WITH the gate results
 *     in its prompt (it must diagnose/report, not re-derive exit codes).
 *   - Layer 2 (classifier, U6B classifier-pre-gate.ts): consulted ONLY when
 *     layer 1 is INCONCLUSIVE (no checks resolved — e.g. a repo without
 *     typecheck/test:critical scripts). A decisively-high classifier score
 *     over the STRUCTURED verdict state may block the spawn; every other
 *     outcome escalates. A FAILED gate never reaches the classifier — a cheap
 *     classifier may never rubber-stamp a failure (U6B escalation policy),
 *     so consulting it there would only burn a call.
 *
 * SAFETY: a gate that cannot run (disabled by env, no checks resolved,
 * executor failure) degrades to "spawn the LLM verifier as today" — the
 * pre-gate can only SAVE a spawn on positive deterministic evidence, never
 * fail a task on its own.
 *
 * Metrics (spec acceptance: "metrics số verifier job tiết kiệm"):
 *   - crew.verification.verify_gate_runs_total{verdict} — gate executions;
 *   - crew.verification.verifier_spawns_skipped_total{reason} — LLM verifier
 *     spawns saved (the "tiết kiệm" counter);
 *   - crew.verification.verifier_spawns_total{reason} — spawns that still
 *     happened, labeled by which layer let them through.
 */
import * as fs from "node:fs";
import { getCrewEnvBool, getCrewEnvInt } from "../../config/env-vars.ts";
import type { MetricRegistry } from "../../observability/metric-registry.ts";
import type { VerifierPreGateResult } from "./classifier-pre-gate.ts";
import { classifyVerifierPreGate } from "./classifier-pre-gate.ts";
import { executeCommand } from "./verification-gates.ts";

/** One deterministic check to run. Mirrors the phase-gate shape
 *  (verification-gates.ts) but kept local so the tool schema can reuse it. */
export interface VerifyGateCheck {
	/** Short check name (metrics/events/evidence lines). */
	name: string;
	/** Shell command; exit code 0 = pass. */
	command: string;
	/** Stop the gate on the first failure of this check (default true). */
	critical?: boolean;
}

/** Result of one executed check. */
export interface VerifyGateCheckResult {
	name: string;
	command: string;
	exitCode: number | null;
	passed: boolean;
	durationMs: number;
	/** Tail of the command output (bounded) — evidence for humans/LLM. */
	outputTail: string;
	skipped?: boolean;
	error?: string;
}

/** Overall gate verdict. */
export type VerifyGateVerdict = "PASS" | "FAILED" | "INCONCLUSIVE";

export interface VerifyGateOutcome {
	verdict: VerifyGateVerdict;
	checks: VerifyGateCheckResult[];
	/** Compact structured evidence lines (exit codes + commands). */
	evidenceLines: string[];
	allPassed: boolean;
	totalDurationMs: number;
}

/** Injected command executor. The TOOL path wraps ctx.executeTool("bash");
 *  the spawn-site path wraps verification-gates executeCommand (subprocess).
 *  Must resolve (never reject) — failures come back as exitCode null/error. */
export type VerifyGateExecutor = (command: string, opts: VerifyGateExecutorOpts) => Promise<VerifyGateExecutorResult>;

export interface VerifyGateExecutorOpts {
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface VerifyGateExecutorResult {
	exitCode: number | null;
	output: string;
	error?: string;
}

/** Default per-check timeout — mirrors runPhaseGates (verification-gates.ts). */
export const DEFAULT_VERIFY_GATE_TIMEOUT_MS = 120_000;
/** Evidence tail budget per check (chars). */
const OUTPUT_TAIL_MAX_CHARS = 2_000;

/** U13 gate enable resolution: PI_CREW_VERIFY_GATE beats default ON. */
export function resolveVerifyGateEnabled(explicit?: boolean): boolean {
	const env = getCrewEnvBool("PI_CREW_VERIFY_GATE");
	if (env !== undefined) return env;
	return explicit ?? true;
}

/** U13 per-check timeout resolution: PI_CREW_VERIFY_GATE_TIMEOUT_MS beats
 *  default 120000 (mirrors runPhaseGates). Invalid/≤0 → default. */
export function resolveVerifyGateTimeoutMs(explicit?: number): number {
	const env = getCrewEnvInt("PI_CREW_VERIFY_GATE_TIMEOUT_MS");
	const raw = env ?? explicit ?? DEFAULT_VERIFY_GATE_TIMEOUT_MS;
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_VERIFY_GATE_TIMEOUT_MS;
}

/**
 * Default check preset — the spec's "check cấu hình" set, resolved from the
 * target repo's package.json scripts so the gate adapts instead of failing:
 *   - `typecheck` script present → `npm run --silent typecheck` (critical);
 *   - `test:critical` script present → `npm run --silent test:critical`
 *     (critical);
 *   - grep evidence lines: no universal marker exists, so they are provided
 *     explicitly via the tool's `checks` param (e.g. the bundle-marker rule
 *     `grep -c "<marker>" dist/index.mjs`) rather than defaulted.
 * Repos without either script resolve ZERO checks → INCONCLUSIVE → the
 * classifier layer (when enabled) or the LLM verifier spawn runs as today.
 */
export function defaultVerifyGateChecks(dir: string): VerifyGateCheck[] {
	let scripts: Record<string, unknown> = {};
	try {
		const raw = fs.readFileSync(`${dir}/package.json`, "utf8");
		const parsed = raw ? (JSON.parse(raw) as { scripts?: Record<string, unknown> }) : undefined;
		scripts = parsed?.scripts ?? {};
	} catch {
		scripts = {};
	}
	const checks: VerifyGateCheck[] = [];
	if (typeof scripts.typecheck === "string") {
		checks.push({ name: "typecheck", command: "npm run --silent typecheck", critical: true });
	}
	if (typeof scripts["test:critical"] === "string") {
		checks.push({ name: "test-critical", command: "npm run --silent test:critical", critical: true });
	}
	return checks;
}

function tailOutput(output: string): string {
	if (output.length <= OUTPUT_TAIL_MAX_CHARS) return output;
	return `…${output.slice(-OUTPUT_TAIL_MAX_CHARS)}`;
}

/** Cap the number of evidence lines (prompt/metric hygiene). */
const EVIDENCE_MAX_LINES = 12;

export function evaluateVerifyGateResults(checks: VerifyGateCheckResult[]): VerifyGateOutcome {
	const ran = checks.filter((c) => !c.skipped);
	const allPassed = ran.length > 0 && ran.every((c) => c.passed);
	const verdict: VerifyGateVerdict = ran.length === 0 ? "INCONCLUSIVE" : allPassed ? "PASS" : "FAILED";
	const evidenceLines = checks
		.slice(0, EVIDENCE_MAX_LINES)
		.map((c) =>
			c.skipped
				? `${c.name}: SKIPPED — ${c.command}`
				: `${c.name}: exit=${c.exitCode ?? "err"} ${c.passed ? "PASS" : "FAIL"} — ${c.command}${c.error ? ` (error: ${c.error})` : ""}`,
		);
	return {
		verdict,
		checks,
		evidenceLines,
		allPassed,
		totalDurationMs: checks.reduce((sum, c) => sum + c.durationMs, 0),
	};
}

/** Run the gate checks sequentially through the injected executor.
 *  Mirrors runPhaseGates semantics: stop on first critical failure; abort
 *  signal between checks marks the rest skipped. NEVER rejects. */
export async function runVerifyGate(
	checks: VerifyGateCheck[],
	exec: VerifyGateExecutor,
	opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<VerifyGateOutcome> {
	const timeoutMs = resolveVerifyGateTimeoutMs(opts.timeoutMs);
	const results: VerifyGateCheckResult[] = [];
	for (const check of checks) {
		if (opts.signal?.aborted) {
			results.push({
				name: check.name,
				command: check.command,
				exitCode: null,
				passed: false,
				durationMs: 0,
				outputTail: "",
				skipped: true,
				error: "Aborted",
			});
			continue;
		}
		const start = Date.now();
		let execResult: VerifyGateExecutorResult;
		try {
			execResult = await exec(check.command, { cwd: opts.cwd, timeoutMs, signal: opts.signal });
		} catch (error) {
			// Executor contract says never-reject; defend anyway — an executor
			// blowup must degrade the CHECK, not the host.
			execResult = { exitCode: null, output: "", error: error instanceof Error ? error.message : String(error) };
		}
		results.push({
			name: check.name,
			command: check.command,
			exitCode: execResult.exitCode,
			passed: execResult.exitCode === 0,
			durationMs: Date.now() - start,
			outputTail: tailOutput(execResult.output ?? ""),
			...(execResult.error ? { error: execResult.error } : {}),
		});
		// Stop on critical failure (default critical) — mirrors runPhaseGates.
		if (execResult.exitCode !== 0 && check.critical !== false) break;
	}
	return evaluateVerifyGateResults(results);
}

/** Spawn-site executor: the hardened subprocess runner the verifier flow
 *  already uses (validateGateCommand + sanitized env + group kill + caps). */
export function createSubprocessVerifyGateExecutor(): VerifyGateExecutor {
	return async (command, opts) => {
		if (opts.signal?.aborted) return { exitCode: null, output: "", error: "Aborted" };
		const { exitCode, output } = await executeCommand(command, opts.cwd, opts.timeoutMs);
		return { exitCode, output };
	};
}

export interface VerifierSpawnDecision {
	/** true → do NOT spawn the LLM verifier; the gate verdict stands. */
	skipVerifier: boolean;
	/** Which layer + branch decided (metric label). */
	reason: string;
	/** true → append the gate outcome block to the verifier's prompt. */
	attachGateContext: boolean;
}

/** TWO-LAYER decision (deterministic first, classifier second). */
export function resolveVerifierSpawnDecision(outcome: VerifyGateOutcome, preGate?: VerifierPreGateResult): VerifierSpawnDecision {
	if (outcome.verdict === "PASS") {
		return { skipVerifier: true, reason: "deterministic_pass", attachGateContext: false };
	}
	if (outcome.verdict === "FAILED") {
		// The LLM verifier gets the failing evidence in its prompt — it must
		// diagnose/report the failure, not re-derive exit codes.
		return { skipVerifier: false, reason: "deterministic_failed", attachGateContext: true };
	}
	// INCONCLUSIVE: classifier layer (U6B) may block on a decisively good
	// structured state; disabled/soft-fail/low-confidence all escalate.
	if (preGate?.blockVerifier) {
		return { skipVerifier: true, reason: "classifier_blocked", attachGateContext: false };
	}
	return {
		skipVerifier: false,
		reason: preGate ? `classifier_${preGate.action}` : "inconclusive_no_classifier",
		attachGateContext: false,
	};
}

/** Render the gate outcome as a compact prompt block for the LLM verifier. */
export function renderVerifyGateContext(outcome: VerifyGateOutcome): string {
	const lines = [
		"## Deterministic verify_gate results (U13 pre-gate)",
		`Gate verdict: ${outcome.verdict}`,
		...outcome.evidenceLines.map((line) => `- ${line}`),
	];
	for (const check of outcome.checks) {
		if (!check.skipped && !check.passed && check.outputTail.trim().length > 0) {
			const tail = check.outputTail.trim().split("\n").slice(-5).join("\n");
			lines.push(`### ${check.name} output tail`, "```", tail, "```");
		}
	}
	lines.push(
		"",
		"The deterministic gate already ran these commands — do NOT re-run them; verify the WORK (diff, files, acceptance), using these results as ground truth for build/test state.",
	);
	return lines.join("\n");
}

/** Human/one-line summary used for the skip path's synthetic result artifact. */
export function renderVerifyGateSummary(outcome: VerifyGateOutcome, reason: string): string {
	return [`verify_gate: ${outcome.verdict} (skip reason: ${reason})`, ...outcome.evidenceLines].join("\n");
}

export interface VerifierGatePreGateInput {
	cwd: string;
	/** Explicit checks override the default preset (tool path / tests). */
	checks?: VerifyGateCheck[];
	signal?: AbortSignal;
	timeoutMs?: number;
	/** U6B classifier layer args — consulted ONLY on INCONCLUSIVE. */
	classifier?: {
		enabled: boolean;
		modelRegistry: unknown;
		classifierModel: string;
		eventsPath: string;
		runId: string;
		taskId?: string;
	};
	metricRegistry?: MetricRegistry;
}

export interface VerifierGatePreGateResult {
	outcome: VerifyGateOutcome;
	decision: VerifierSpawnDecision;
	preGate?: VerifierPreGateResult;
	/** Prompt block to append when the verifier still spawns ("" otherwise). */
	promptContext: string;
}

function incMetric(registry: MetricRegistry | undefined, name: string, help: string, labels: Record<string, string>): void {
	try {
		registry?.counter(name, help).inc(labels);
	} catch {
		/* metrics are best-effort; never break the gate */
	}
}

/**
 * Spawn-site orchestration: run the deterministic gate, consult the U6B
 * classifier layer when inconclusive, resolve the two-layer spawn decision,
 * and emit the acceptance metrics. NEVER rejects — executor failures degrade
 * to INCONCLUSIVE checks, which escalate to the LLM verifier.
 */
export async function runVerifierGatePreGate(input: VerifierGatePreGateInput): Promise<VerifierGatePreGateResult> {
	const checks = input.checks ?? defaultVerifyGateChecks(input.cwd);
	const outcome = await runVerifyGate(checks, createSubprocessVerifyGateExecutor(), {
		cwd: input.cwd,
		signal: input.signal,
		timeoutMs: input.timeoutMs,
	});
	let preGate: VerifierPreGateResult | undefined;
	if (outcome.verdict === "INCONCLUSIVE" && input.classifier?.enabled) {
		try {
			preGate = await classifyVerifierPreGate({
				enabled: true,
				modelRegistry: input.classifier.modelRegistry,
				classifierModel: input.classifier.classifierModel,
				verdict: {
					verdict: outcome.verdict,
					evidenceLines: outcome.evidenceLines,
					changedFiles: [],
				},
				eventsPath: input.classifier.eventsPath,
				runId: input.classifier.runId,
				...(input.classifier.taskId !== undefined ? { taskId: input.classifier.taskId } : {}),
				metricRegistry: input.metricRegistry,
			});
		} catch {
			preGate = undefined; // soft: escalate to the LLM verifier
		}
	}
	const decision = resolveVerifierSpawnDecision(outcome, preGate);
	incMetric(input.metricRegistry, "crew.verification.verify_gate_runs_total", "Deterministic verify_gate executions by verdict", {
		verdict: outcome.verdict,
	});
	if (decision.skipVerifier) {
		incMetric(
			input.metricRegistry,
			"crew.verification.verifier_spawns_skipped_total",
			"LLM verifier spawns saved by the U13 deterministic pre-gate",
			{ reason: decision.reason },
		);
	} else {
		incMetric(
			input.metricRegistry,
			"crew.verification.verifier_spawns_total",
			"LLM verifier spawns that still ran, labeled by the deciding layer",
			{ reason: decision.reason },
		);
	}
	return {
		outcome,
		decision,
		...(preGate ? { preGate } : {}),
		promptContext: decision.attachGateContext ? renderVerifyGateContext(outcome) : "",
	};
}
