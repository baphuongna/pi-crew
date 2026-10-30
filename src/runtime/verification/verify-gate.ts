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
 *   - Layer 3 (PHASE 4, U13-ADJ determinism, DEFAULT OFF): when
 *     PI_CREW_VERIFY_DETERMINISM=1 and the default checks are all green, the
 *     most critical check (test-critical in the default preset) is RERUN
 *     once; a disagreement (flaky) or a rerun executor failure downgrades
 *     the verdict to INCONCLUSIVE — never FAILED, never a task failure. It
 *     never changes the FAILED↔spawn logic; flag off keeps the gate
 *     bit-for-bit identical to pre-U13-ADJ.
 *
 * GROUND TRUTH (M1-7, R47-1 fix 2026-10-19): the gate NEVER derives checks
 * from the task cwd's package.json at gate time — a worker-mutable file
 * (shared-cwd mode) whose tampered `scripts.typecheck: "exit 0"` used to
 * yield PASS + skipVerifier (worker self-grading). Ground truth is
 * host-owned: `resolveHostVerifyGateSpec(cwd)` snapshots the project
 * manifests + derives the check preset AT DISPATCH (host process, before
 * any worker runs) and the spec is pinned on the run manifest; the spawn
 * site passes it as `hostSpec`. The gate re-hashes the manifests BEFORE any
 * command runs (drift ⇒ FAILED — tamper evidence, verifier spawns) and
 * AFTER a PASS (drift ⇒ INCONCLUSIVE — mid-gate tamper), mirroring the P1a
 * bookend (verification-integrity.ts). Absence of a spec is fail-closed:
 * no spec + no explicit checks ⇒ zero checks ⇒ INCONCLUSIVE ⇒ the LLM
 * verifier spawns — absence can never produce a skip.
 *
 * WORKTREE GROUND TRUTH (W2 fix wave, 2026-10-29 — findings
 * nonmanifest-ground-truth-self-grading + worktree-verifier-gate-excludes-work
 * + index-tree-key-mismatch): the M1-7 binding pinned only the 8 manifest
 * hashes, so a worker could tamper NON-manifest harness files (tracked-
 * unstaged runners, node_modules shims) and have the pinned checks execute
 * its stubs — grading its own work. Closures, layered:
 *   - hostSpec now also pins a dispatch-time TRACKED-working-tree binding
 *     (treeOid + cleanTree, captured host-side by resolveHostVerifyGateSpec).
 *     At gate time the task cwd's tracked tree is re-derived and ANY divergence
 *     — or an unmeasurable tree while a binding was pinned — fails the gate to
 *     the LLM verifier spawn (never a skip) BEFORE any command runs, mirroring
 *     the manifest bookend. The binding keys on TRACKED content only:
 *     untracked files legitimately differ between the leader workspace and
 *     fresh task worktrees (assertCleanLeader permits them; seeds are
 *     selective), while the self-grading PoC's harness stubs were tracked-
 *     unstaged and always move it.
 *   - the memo key binds the FULL working tree + the workspace path and the
 *     memo is disabled on any dirty tree (verify-gate-memo.ts) — a recorded
 *     PASS can no longer be replayed for a different or merely re-dirtied
 *     tree, nor across worktrees.
 *   - a gate PASS never certifies work it cannot see: when the verified
 *     dependency tasks carry uncommitted changes in their OWN worktrees
 *     (worktree mode — the gate's pristine tree structurally excludes that
 *     work), the skip is refused and the LLM verifier spawns with the guard
 *     note (dependencyWorktreeProbes → reason "unverified_worktree_work").
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
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { getCrewEnvBool, getCrewEnvInt } from "../../config/env-vars.ts";
import type { MetricRegistry } from "../../observability/metric-registry.ts";
import { assertWorktreePointerTrusted, buildGitSafeEnv, hardenGitArgs } from "../../worktree/git-hardening.ts";
import type { VerifierPreGateResult } from "./classifier-pre-gate.ts";
import { executeCommand } from "./verification-gates.ts";
// Static edge is graph-free: verification-integrity.ts is already in the
// index.bundle value-import graph (goal.ts/goal-wrap.ts/goal-loop-runner.ts
// import it), so this adds no bundle-graph file (check-lazy-imports budget).
import { compareSnapshot, snapshotManifests } from "./verification-integrity.ts";
import { captureWorkingTreeBinding, lookupVerifyGateMemo, recordVerifyGateMemo, resolveVerifyGateMemoEnabled } from "./verify-gate-memo.ts";

/** One deterministic check to run. Mirrors the phase-gate shape
 *  (verification-gates.ts) but kept local so the tool schema can reuse it. */
export interface VerifyGateCheck {
	/** Short check name (metrics/events/evidence lines). */
	name: string;
	/** Shell command; exit code 0 = pass. */
	command: string;
	/** Stop the gate on the first failure of this check (default true). */
	critical?: boolean;
	/** W10-9 (v0.11.38, pi-subagents lesson #2): TYPED gate — stdout must be
	 *  valid JSON matching `schema` (minimal subset below). Invalid JSON or a
	 *  schema mismatch FAILS the check even at exit 0. Typed gates NEVER
	 *  memoize (verify-gate-memo.ts guard): a structured-output consumer reads
	 *  fresh structuredOutput every run. */
	output?: "json";
	/** Minimal JSON-schema subset: {type, required?, properties?, items?,
	 *  enum?} — nested one level deep is the intended use (gate summaries). */
	schema?: Record<string, unknown>;
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
	/** W10-9: parsed JSON stdout of a typed gate (present only when the JSON
	 *  was valid — invalid stdout fails and carries the reason in `error`). */
	structuredOutput?: unknown;
	output?: "json";
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
	/** PHASE 4 (U13-ADJ): set ONLY by the layer-3 determinism rerun when it
	 *  detected flakiness or a rerun executor failure — the note is also
	 *  appended to evidenceLines and shapes the rendered context trailer. */
	determinismNote?: string;
	/** M1-7 (R47-1): set when the dispatch-pinned manifest snapshot DRIFTED —
	 *  the note is also appended to evidenceLines and switches the rendered
	 *  context trailer to "results UNTRUSTED". */
	integrityNote?: string;
	/** W2 (2026-10-29): set when the tracked WORKING TREE diverged from the
	 *  dispatch-pinned binding (or could not be proven equal) — like
	 *  integrityNote it is appended to evidenceLines and switches the rendered
	 *  context trailer to "results UNTRUSTED". */
	worktreeIntegrityNote?: string;
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

/** PHASE 4 (U13-ADJ, upgrade 2026-10-13) layer-3 toggle:
 *  PI_CREW_VERIFY_DETERMINISM beats the explicit arg; default OFF (unset →
 *  explicit ?? false). Flag off ⇒ the gate runs exactly as pre-U13-ADJ
 *  (no third check, no rerun, no verdict downgrade — bit-for-bit). */
export function resolveVerifyDeterminismEnabled(explicit?: boolean): boolean {
	const env = getCrewEnvBool("PI_CREW_VERIFY_DETERMINISM");
	if (env !== undefined) return env;
	return explicit ?? false;
}

/**
 * Default check preset — the spec's "check cấu hình" set, resolved from a
 * package.json's scripts:
 *   - `typecheck` script present → `npm run --silent typecheck` (critical);
 *   - `test:critical` script present → `npm run --silent test:critical`
 *     (critical);
 *   - grep evidence lines: no universal marker exists, so they are provided
 *     explicitly via the tool's `checks` param (e.g. the bundle-marker rule
 *     `grep -c "<marker>" dist/index.mjs`) rather than defaulted.
 * Repos without either script resolve ZERO checks → INCONCLUSIVE → the
 * classifier layer (when enabled) or the LLM verifier spawn runs as today.
 *
 * HOST-SIDE ONLY (M1-7, R47-1): this reads a worker-MUTABLE file. It may run
 * only in the host process at DISPATCH time (via resolveHostVerifyGateSpec,
 * before any worker exists) — never as a gate-time fallback from a task cwd.
 * Gate-time consumers must use the dispatch-pinned hostSpec instead.
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

/** Host-owned verify-gate spec (M1-7, R47-1 fix): captured ONCE at dispatch
 *  in the HOST process (pre-worker) and pinned on the run manifest.
 *  `snapshot` is the P1a manifest-hash set (verification-integrity.ts);
 *  `checks` is the preset derived from the host's own read of package.json.
 *  At gate time the task cwd is verified against `snapshot` instead of ever
 *  re-reading the worker-mutable package.json. Structural shape mirrors
 *  TeamRunManifest's `verifyGateSpec` field (the state layer must not import
 *  runtime types). */
export interface VerifyGateHostSpec {
	snapshot: Record<string, string>;
	checks: VerifyGateCheck[];
	/** W2 (2026-10-29, nonmanifest-ground-truth-self-grading): dispatch-time
	 *  TRACKED-working-tree binding — the full tracked content (staged +
	 *  unstaged) the host saw before any worker ran (temp-index
	 *  read-tree HEAD → add -u → write-tree). Absent when it could not be
	 *  computed (non-git cwd, git failure) — the gate then falls back to the
	 *  manifest bookends alone (structural shape on run manifests predates
	 *  this field; old pinned specs simply carry no binding). */
	treeOid?: string;
	/** W2: tracked-clean probe at dispatch (status --porcelain -uno empty).
	 *  Fallback binding when no treeOid is available: a clean-at-dispatch tree
	 *  that is dirty at gate time is drift. Absent when the probe failed. */
	cleanTree?: boolean;
}

/** HOST-SIDE (dispatch) — build the verify spec for `cwd` (the project root
 *  as the host sees it BEFORE any worker runs). Returns undefined when the
 *  directory has neither manifests to hash nor a check preset (nothing to
 *  protect or verify); the gate then resolves no checks (fail-closed). */
export function resolveHostVerifyGateSpec(cwd: string): VerifyGateHostSpec | undefined {
	const snapshot = snapshotManifests(cwd);
	const checks = defaultVerifyGateChecks(cwd);
	if (Object.keys(snapshot).length === 0 && checks.length === 0) return undefined;
	// W2: bind the TRACKED working tree AT DISPATCH (host process, pre-worker)
	// so the gate can prove the task cwd still contains what the host pinned —
	// non-manifest tracked files included. Unavailable measurements are omitted
	// (never guessed): the gate then acts on the manifest bookends alone.
	const binding = captureWorkingTreeBinding(cwd);
	return {
		snapshot,
		checks,
		...(binding.oid !== undefined ? { treeOid: binding.oid } : {}),
		...(binding.clean !== undefined ? { cleanTree: binding.clean } : {}),
	};
}

/** Gate-time integrity probe (M1-7): re-hash the manifests in `cwd` and diff
 *  against the dispatch snapshot. Non-empty result = the drifted relative
 *  paths — the task cwd's ground truth no longer matches what the host
 *  pinned at dispatch (worker tampering or legitimate churn; both fail
 *  closed: the gate must not grade on compromised ground truth). */
export function detectHostSpecDrift(cwd: string, spec: VerifyGateHostSpec): string[] {
	return compareSnapshot(spec.snapshot, snapshotManifests(cwd));
}

/**
 * Gate-time tree probe (W2, nonmanifest-ground-truth-self-grading): re-derive
 * the tracked working tree of `cwd` and compare it against the dispatch
 * binding. Returns a drift note when the gate cwd can NOT be proven
 * bit-identical to the tree the host pinned — changed tracked content, or an
 * unmeasurable tree while a binding was pinned (fail closed on missing
 * evidence) — and undefined when no binding was pinned or equality holds.
 * Untracked files are deliberately NOT part of the binding (they legitimately
 * differ between workspaces; the memo separately refuses dirty trees).
 */
export function detectWorkingTreeDrift(cwd: string, spec: VerifyGateHostSpec): string | undefined {
	const binding = captureWorkingTreeBinding(cwd);
	if (spec.treeOid !== undefined) {
		if (binding.oid === undefined) {
			return "working-tree-integrity: the tracked working tree could not be measured (git unavailable or failed) — the dispatch-pinned tree cannot be proven intact";
		}
		if (binding.oid !== spec.treeOid) {
			return "working-tree-integrity: tracked files changed since the host snapshot taken at dispatch (inspect with git status / git diff)";
		}
		return undefined;
	}
	if (spec.cleanTree === true) {
		if (binding.clean === undefined) {
			return "working-tree-integrity: the working tree could not be probed for changes (git unavailable or failed) — the dispatch-time clean state cannot be proven intact";
		}
		if (binding.clean === false) {
			return "working-tree-integrity: tracked files are modified in the gate's workspace but the tree was clean at dispatch";
		}
	}
	return undefined;
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

/**
 * W10-9: minimal JSON-schema subset validator — {type, required, properties,
 * items, enum}, nested arbitrarily. Returns undefined on success or the first
 * mismatch reason. Deliberately tiny (no new dependency); unsupported schema
 * constructs are IGNORED (permissive), never crash.
 */
export function validateJsonLite(value: unknown, schema: unknown, at = "$"): string | undefined {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
	const s = schema as Record<string, unknown>;
	if (typeof s.type === "string") {
		const t = s.type;
		const ok =
			(t === "object" && !!value && typeof value === "object" && !Array.isArray(value)) ||
			(t === "array" && Array.isArray(value)) ||
			(t === "string" && typeof value === "string") ||
			(t === "number" && typeof value === "number" && Number.isFinite(value)) ||
			(t === "boolean" && typeof value === "boolean") ||
			(t === "null" && value === null);
		if (!ok) return `${at}: expected type ${t}`;
	}
	if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
		return `${at}: not in enum`;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const rec = value as Record<string, unknown>;
		for (const key of Array.isArray(s.required) ? (s.required as string[]) : []) {
			if (!(key in rec)) return `${at}: missing required "${key}"`;
		}
		if (s.properties && typeof s.properties === "object") {
			for (const [k, sub] of Object.entries(s.properties as Record<string, unknown>)) {
				if (k in rec) {
					const err = validateJsonLite(rec[k], sub, `${at}.${k}`);
					if (err) return err;
				}
			}
		}
	}
	if (Array.isArray(value) && s.items !== undefined) {
		for (let i = 0; i < value.length; i++) {
			const err = validateJsonLite(value[i], s.items, `${at}[${i}]`);
			if (err) return err;
		}
	}
	return undefined;
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
		// W10-9: typed gate — validate stdout JSON against the schema; an
		// exit-0 command with invalid/mismatching JSON is a FAIL (the consumer
		// reads structuredOutput; silence must never count as data).
		let typedError: string | undefined;
		let structured: unknown;
		if (check.output === "json") {
			try {
				structured = JSON.parse(execResult.output ?? "");
			} catch {
				typedError = "typed gate: stdout is not valid JSON";
			}
			if (structured !== undefined && check.schema) {
				const mismatch = validateJsonLite(structured, check.schema);
				if (mismatch) typedError = `typed gate: schema mismatch — ${mismatch}`;
			}
		}
		results.push({
			name: check.name,
			command: check.command,
			exitCode: execResult.exitCode,
			passed: execResult.exitCode === 0 && !typedError,
			durationMs: Date.now() - start,
			outputTail: tailOutput(execResult.output ?? ""),
			...(execResult.error ? { error: execResult.error } : {}),
			...(typedError ? { error: typedError } : {}),
			...(check.output === "json" ? { output: "json" } : {}),
			...(structured !== undefined && !typedError ? { structuredOutput: structured } : {}),
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

/** PHASE 4 (U13-ADJ) layer-3 result — one entry per pre-gate execution. */
export interface DeterminismLayerResult {
	/** false → the layer did not run (budget rule / no eligible target). */
	ran: boolean;
	/** Metric label: "deterministic" | "flaky" | "rerun_error" when ran;
	 *  the skip reason ("verdict_failed" | "verdict_inconclusive" |
	 *  "no_critical_pass") otherwise. */
	result: string;
	/** The gate outcome AFTER the layer (the layer-1 outcome when !ran). */
	outcome: VerifyGateOutcome;
	/** Non-empty iff the rerun disagreed (flaky) or its executor failed. */
	note: string;
}

/** Pick the layer-3 rerun target: the MOST critical check — the LAST check
 *  with critical !== false that ran and PASSED (default preset order puts
 *  test-critical last: tests are the strongest determinism signal). Checks
 *  that failed are never rerun (pointless — a failure already escalates). */
function pickDeterminismRerunTarget(
	checks: VerifyGateCheck[],
	results: VerifyGateCheckResult[],
): { check: VerifyGateCheck; result: VerifyGateCheckResult } | undefined {
	let target: { check: VerifyGateCheck; result: VerifyGateCheckResult } | undefined;
	for (let i = 0; i < checks.length; i++) {
		const check = checks[i];
		const result = results[i];
		if (!check || !result || result.skipped || !result.passed) continue;
		if (check.critical === false) continue; // critical undefined = critical
		target = { check, result };
	}
	return target;
}

/** PHASE 4 (U13-ADJ) layer 3 — the determinism rerun. Runs ONLY when the
 *  layer-1 verdict is PASS (budget rule: never rerun an already-FAILED gate)
 *  AND at least one critical check passed. Semantics:
 *  - rerun exit 0 (agrees with run 1) → verdict stays PASS, the rerun is
 *    recorded as a passing `determinism:<name>` check for evidence;
 *  - rerun exit ≠ 0 (DISAGREES — flaky) → verdict INCONCLUSIVE (never
 *    FAILED) + note "deterministic-check: flaky <name>";
 *  - rerun executor failure (exitCode null) → INCONCLUSIVE (soft-degrade,
 *    never FAILED) + note "deterministic-check: rerun executor error".
 *  The layer can ONLY downgrade its own rerun check to INCONCLUSIVE — it
 *  never changes the FAILED↔spawn decision logic. NEVER rejects. */
export async function applyVerifyGateDeterminismLayer(
	checks: VerifyGateCheck[],
	outcome: VerifyGateOutcome,
	exec: VerifyGateExecutor,
	opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<DeterminismLayerResult> {
	// Budget rule: no pointless rerun when the gate already failed / resolved
	// nothing — layer 3 only re-tests a GREEN gate for hidden nondeterminism.
	if (outcome.verdict !== "PASS") {
		return { ran: false, result: `verdict_${outcome.verdict.toLowerCase()}`, outcome, note: "" };
	}
	const target = pickDeterminismRerunTarget(checks, outcome.checks);
	if (!target) {
		return { ran: false, result: "no_critical_pass", outcome, note: "" };
	}
	const timeoutMs = resolveVerifyGateTimeoutMs(opts.timeoutMs);
	const start = Date.now();
	let rerun: VerifyGateExecutorResult;
	try {
		rerun = await exec(target.check.command, { cwd: opts.cwd, timeoutMs, signal: opts.signal });
	} catch (error) {
		// Executor contract says never-reject; defend anyway (soft-degrade).
		rerun = { exitCode: null, output: "", error: error instanceof Error ? error.message : String(error) };
	}
	const rerunCheck: VerifyGateCheckResult = {
		name: `determinism:${target.check.name}`,
		command: target.check.command,
		exitCode: rerun.exitCode,
		passed: rerun.exitCode === 0,
		durationMs: Date.now() - start,
		outputTail: tailOutput(rerun.output ?? ""),
		...(rerun.error ? { error: rerun.error } : {}),
	};
	const base = evaluateVerifyGateResults([...outcome.checks, rerunCheck]);
	if (rerun.exitCode === 0) {
		return { ran: true, result: "deterministic", outcome: base, note: "" };
	}
	const note =
		rerun.exitCode === null
			? `deterministic-check: rerun executor error (${target.check.name})`
			: `deterministic-check: flaky ${target.check.name}`;
	return {
		ran: true,
		result: rerun.exitCode === null ? "rerun_error" : "flaky",
		// The rerun check's failure would otherwise read as gate FAILED — the
		// ONLY thing layer 3 may do is downgrade ITS OWN rerun to INCONCLUSIVE.
		outcome: {
			...base,
			verdict: "INCONCLUSIVE",
			evidenceLines: [...base.evidenceLines, note],
			determinismNote: note,
		},
		note,
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
	// PHASE 4 gap 2 (U13-ADJ): distinguish "executor died" (exit=err — spawn /
	// timer failure, NO exit code) from a real exit≠0. An executor death is
	// NOT evidence the build is broken — asserting it as ground truth would
	// bias the LLM verifier against a possibly-fine build. Real exit≠0 keeps
	// the original wording bit-for-bit; a flaky rerun (layer 3) gets its own
	// trailer because "do NOT re-run / ground truth" would be provably wrong.
	const executorDeath = outcome.checks.some((c) => !c.skipped && c.exitCode === null);
	const trailer = outcome.integrityNote
		? "Manifest integrity check FAILED: project manifest files changed since the host snapshot taken at dispatch. These gate results and any transcript claims about build/test state are UNTRUSTED — inspect what changed and re-run the verification commands yourself before concluding."
		: outcome.worktreeIntegrityNote
			? "Working-tree integrity check FAILED: tracked files in the gate's workspace changed since the host snapshot taken at dispatch (or the tree could not be proven identical to it). These gate results and any transcript claims about build/test state are UNTRUSTED — inspect what changed (git status / git diff) and re-run the verification commands yourself before concluding."
			: executorDeath
				? "A verification command could not run (executor error — exit=err). Treat the build/test state as UNKNOWN; run the build/tests yourself before concluding."
				: outcome.determinismNote
					? "The gate rerun detected NONDETERMINISM (a check passed once and failed on rerun). These gate results are NOT reliable — re-run the affected command yourself and treat the build/test state as UNKNOWN."
					: "The deterministic gate already ran these commands — do NOT re-run them; verify the WORK (diff, files, acceptance), using these results as ground truth for build/test state.";
	lines.push("", trailer);
	return lines.join("\n");
}

/** Human/one-line summary used for the skip path's synthetic result artifact. */
export function renderVerifyGateSummary(outcome: VerifyGateOutcome, reason: string): string {
	return [`verify_gate: ${outcome.verdict} (skip reason: ${reason})`, ...outcome.evidenceLines].join("\n");
}

// ─── W2 finding worktree-verifier-gate-excludes-work: guard probes ──────────

/** One probe per dependency task whose work the verifier is meant to certify.
 *  `worktreePath` absent ⇒ shared-cwd workspace — that task's work lives IN
 *  the gate's own cwd and needs no probe. */
export interface VerifierGateWorkProbe {
	taskId: string;
	worktreePath?: string;
}

/** Dirty probe for a task worktree: TRUE when `git status --porcelain` is
 *  non-empty (tracked modifications AND untracked files — an executor's
 *  typical output is new untracked files; build outputs stay gitignored) or
 *  when the probe FAILS (missing/corrupted worktree — fail closed:
 *  unverifiable work must reach the LLM verifier, never a silent skip).
 *  w9-n4 follow-up: routed through the MED-1 composition (hardenGitArgs +
 *  buildGitSafeEnv + assertWorktreePointerTrusted) with the same deliberate
 *  deviation as verify-gate-memo.ts — the pointer-trust assert sits INSIDE
 *  the try so a corrupted worktree converts to dirty=true (fail closed)
 *  instead of throwing into the gate flow. */
export function worktreeHasUncommittedWork(worktreePath: string): boolean {
	try {
		assertWorktreePointerTrusted(worktreePath);
		const st = execFileSync("git", hardenGitArgs(["status", "--porcelain"]), {
			cwd: worktreePath,
			env: buildGitSafeEnv("en_US.UTF-8"),
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf-8",
			timeout: 10_000,
			windowsHide: true,
		});
		return st.trim().length > 0;
	} catch {
		return true;
	}
}

/** Dependency task ids whose worktree carries uncommitted work that the
 *  gate's evaluated tree does not contain. Probes without a worktree path are
 *  skipped (shared-cwd work is inside the gate cwd itself). */
export function findTasksWithWorktreeWork(probes: VerifierGateWorkProbe[]): string[] {
	const dirty: string[] = [];
	for (const probe of probes) {
		if (!probe.worktreePath) continue;
		if (worktreeHasUncommittedWork(probe.worktreePath)) dirty.push(probe.taskId);
	}
	return dirty;
}

/**
 * W2 guard (worktree-verifier-gate-excludes-work): a gate PASS — fresh or
 * memoized — may only suppress the LLM verifier when the checks evaluated the
 * work under verification. In worktree mode the gate runs in the verifier's
 * own pristine tree while the executor's changes live in a different
 * worktree; a PASS there certifies the untouched base. When any probed
 * dependency worktree carries uncommitted work, the skip is refused and the
 * LLM verifier spawns with the guard evidence (reason
 * "unverified_worktree_work"). Non-skip decisions pass through untouched.
 */
function resolveWorktreeGuardDecision(
	probes: VerifierGateWorkProbe[] | undefined,
	outcome: VerifyGateOutcome,
): { outcome: VerifyGateOutcome; decision: VerifierSpawnDecision; forcedSpawn: boolean } {
	const decision = resolveVerifierSpawnDecision(outcome);
	if (!decision.skipVerifier || !probes || probes.length === 0) return { outcome, decision, forcedSpawn: false };
	const dirtyDeps = findTasksWithWorktreeWork(probes);
	if (dirtyDeps.length === 0) return { outcome, decision, forcedSpawn: false };
	const note = `worktree-guard: dependency task(s) ${dirtyDeps.join(", ")} carry uncommitted changes in their worktrees — the gate evaluated a tree that does not contain that work; refusing the deterministic skip`;
	return {
		outcome: { ...outcome, evidenceLines: [...outcome.evidenceLines, note] },
		decision: { skipVerifier: false, reason: "unverified_worktree_work", attachGateContext: true },
		forcedSpawn: true,
	};
}

export interface VerifierGatePreGateInput {
	cwd: string;
	/** Explicit checks take precedence over every other source (tool path /
	 *  tests). Without them the gate derives NO checks on its own. */
	checks?: VerifyGateCheck[];
	/** M1-7 (R47-1): host-owned spec pinned on the run manifest at dispatch.
	 *  When provided, the gate verifies manifest integrity against the
	 *  snapshot BEFORE running anything (drift ⇒ FAILED — tamper evidence,
	 *  verifier spawns) and re-verifies after a PASS (drift ⇒ INCONCLUSIVE).
	 *  When ABSENT there is NO fallback read of the worker-mutable task-cwd
	 *  package.json: no explicit checks ⇒ zero checks ⇒ INCONCLUSIVE
	 *  (fail-closed on absence — the LLM verifier spawns). */
	hostSpec?: VerifyGateHostSpec;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** @deprecated M3-28 (R47-V2): NEVER consulted — the gate's structured verdict
	 *  can never be pass-shaped, so the U6B classifier could only ever escalate
	 *  (see the call-site note in {@link runVerifierGatePreGate}). Kept only so the
	 *  task-runner dispatch call site still type-checks; delete together with it. */
	classifier?: {
		enabled: boolean;
		modelRegistry: unknown;
		classifierModel: string;
		eventsPath: string;
		runId: string;
		taskId?: string;
	};
	metricRegistry?: MetricRegistry;
	/** PHASE 4 (U13-ADJ): explicit layer-3 determinism toggle — env
	 *  PI_CREW_VERIFY_DETERMINISM beats this; both default OFF. */
	determinism?: boolean;
	/** W2 (worktree-verifier-gate-excludes-work): one probe per dependency task
	 *  whose work this verifier certifies (taskId + its worktree path). When any
	 *  probed worktree carries uncommitted changes, a gate PASS — fresh OR
	 *  memoized — refuses the skipVerifier decision (the gate evaluated a tree
	 *  that structurally excludes that work) and the LLM verifier spawns with
	 *  the guard note (reason "unverified_worktree_work"). */
	dependencyWorktreeProbes?: VerifierGateWorkProbe[];
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
 * Spawn-site orchestration: run the deterministic gate, optionally the U13-ADJ
 * layer-3 determinism rerun (flag-gated, default OFF), consult the U6B
 * classifier layer when inconclusive, resolve the two-layer spawn decision,
 * and emit the acceptance metrics. NEVER rejects — executor failures degrade
 * to INCONCLUSIVE checks, which escalate to the LLM verifier.
 */
export async function runVerifierGatePreGate(input: VerifierGatePreGateInput): Promise<VerifierGatePreGateResult> {
	// ── M1-7 (R47-1): integrity BEFORE any command runs ────────────────────
	// A drifted manifest means the ground truth the host pinned at dispatch is
	// compromised — running ANY check now would be the self-grading exploit
	// (the worker rewrote the scripts the gate was about to run). Fail FAILED
	// (tamper evidence) → the verifier spawns with the drift in its prompt.
	// A tampered package.json can never yield PASS + skipVerifier.
	if (input.hostSpec) {
		const drift = detectHostSpecDrift(input.cwd, input.hostSpec);
		if (drift.length > 0) {
			const note = `manifest-integrity: ${drift.join(", ")} changed since dispatch (host snapshot)`;
			const outcome: VerifyGateOutcome = {
				verdict: "FAILED",
				checks: [],
				evidenceLines: [note],
				allPassed: false,
				totalDurationMs: 0,
				integrityNote: note,
			};
			const decision = resolveVerifierSpawnDecision(outcome);
			incMetric(input.metricRegistry, "crew.verification.verify_gate_runs_total", "Deterministic verify_gate executions by verdict", {
				verdict: outcome.verdict,
			});
			incMetric(
				input.metricRegistry,
				"crew.verification.verifier_spawns_total",
				"LLM verifier spawns that still ran, labeled by the deciding layer",
				{ reason: decision.reason },
			);
			return { outcome, decision, promptContext: renderVerifyGateContext(outcome) };
		}
	}
	// ── W2 (nonmanifest-ground-truth-self-grading): tree binding BEFORE any
	// command runs ────────────────────────────────────────────────────────
	// The manifest bookends pin only the 8 manifest files, but the pinned
	// checks execute whatever harness the WORKING TREE resolves (runners,
	// shims, test files). When the host pinned a dispatch-time tree binding,
	// any tracked divergence — or an unmeasurable tree — means the checks
	// would execute content the host never pinned: the self-grading exploit.
	// Fail the gate to the LLM verifier spawn (never a skip) before running
	// anything, exactly like the manifest drift path above.
	if (input.hostSpec) {
		const treeDriftNote = detectWorkingTreeDrift(input.cwd, input.hostSpec);
		if (treeDriftNote) {
			const outcome: VerifyGateOutcome = {
				verdict: "FAILED",
				checks: [],
				evidenceLines: [treeDriftNote],
				allPassed: false,
				totalDurationMs: 0,
				worktreeIntegrityNote: treeDriftNote,
			};
			const decision = resolveVerifierSpawnDecision(outcome);
			incMetric(input.metricRegistry, "crew.verification.verify_gate_runs_total", "Deterministic verify_gate executions by verdict", {
				verdict: outcome.verdict,
			});
			incMetric(
				input.metricRegistry,
				"crew.verification.verifier_spawns_total",
				"LLM verifier spawns that still ran, labeled by the deciding layer",
				{ reason: decision.reason },
			);
			return { outcome, decision, promptContext: renderVerifyGateContext(outcome) };
		}
	}
	// ── M1-7: NO package.json fallback ─────────────────────────────────────
	// Checks come from the caller or the dispatch-pinned host spec ONLY —
	// nothing here reads the worker-mutable task cwd. Zero resolvable checks
	// ⇒ INCONCLUSIVE ⇒ escalate (fail-closed on absence, pre-R47-1 doctrine).
	const checks = input.checks ?? input.hostSpec?.checks ?? [];
	// ── W10-2 (v0.11.38): memoized green gate by workspace tree-hash ──────
	// Lookup BEFORE any command runs. A hit proves the FULL tree + check list
	// + node version are bit-identical to the tree that produced a recorded
	// PASS (tree equality subsumes the manifest bookends) — re-running
	// deterministic checks on an unchanged tree buys nothing. Miss / disabled
	// / non-git cwd ⇒ ordinary full gate below (fail-open).
	if (resolveVerifyGateMemoEnabled()) {
		const memoHit = lookupVerifyGateMemo(input.cwd, checks);
		if (memoHit) {
			// W2: the guard runs on memo hits too — a recorded PASS for a pristine
			// tree must not skip the verifier when the verified dependency work
			// lives outside this tree (the original finding-3 memo-replay PoC).
			const guarded = resolveWorktreeGuardDecision(input.dependencyWorktreeProbes, memoHit);
			incMetric(input.metricRegistry, "crew.verification.verify_gate_runs_total", "Deterministic verify_gate executions by verdict", {
				verdict: guarded.outcome.verdict,
			});
			incMetric(
				input.metricRegistry,
				"crew.verification.verify_gate_memo_hits_total",
				"W10-2 memoized PASS verdicts served without re-running checks",
				{},
			);
			if (guarded.forcedSpawn) {
				incMetric(
					input.metricRegistry,
					"crew.verification.verifier_gate_worktree_guard_total",
					"W2: PASS-skip refusals — dependency worktree work the gate's evaluated tree does not contain",
					{ result: "spawn_forced" },
				);
			}
			if (guarded.decision.skipVerifier) {
				incMetric(
					input.metricRegistry,
					"crew.verification.verifier_spawns_skipped_total",
					"LLM verifier spawns saved by the U13 deterministic pre-gate",
					{ reason: guarded.decision.reason },
				);
			} else {
				incMetric(
					input.metricRegistry,
					"crew.verification.verifier_spawns_total",
					"LLM verifier spawns that still ran, labeled by the deciding layer",
					{ reason: guarded.decision.reason },
				);
			}
			return {
				outcome: guarded.outcome,
				decision: guarded.decision,
				// A guard-forced spawn must carry the WHY into the verifier's prompt
				// (plain memo hits normally render no context at all).
				promptContext: guarded.forcedSpawn ? renderVerifyGateContext(guarded.outcome) : "",
			};
		}
	}
	const exec = createSubprocessVerifyGateExecutor();
	let outcome = await runVerifyGate(checks, exec, {
		cwd: input.cwd,
		signal: input.signal,
		timeoutMs: input.timeoutMs,
	});
	// ── PHASE 4 (U13-ADJ) layer 3: determinism rerun (DEFAULT OFF) ──────────
	// Only re-tests a GREEN gate: a flaky critical check or a rerun executor
	// failure downgrades PASS→INCONCLUSIVE (never FAILED), so a nondeterministic
	// green gate can no longer skip the LLM verifier. Flag off ⇒ skipped
	// entirely (bit-for-bit pre-U13-ADJ behavior).
	let determinismNote = "";
	if (resolveVerifyDeterminismEnabled(input.determinism)) {
		const layer = await applyVerifyGateDeterminismLayer(checks, outcome, exec, {
			cwd: input.cwd,
			signal: input.signal,
			timeoutMs: input.timeoutMs,
		});
		outcome = layer.outcome;
		determinismNote = layer.note;
		incMetric(
			input.metricRegistry,
			"crew.verification.verify_gate_determinism_runs_total",
			"Layer-3 determinism reruns (U13-ADJ) by result",
			{ result: layer.result },
		);
	}
	// ── M1-7 bookend: integrity AFTER a green gate (mirrors P1a) ───────────
	// A PASS is only trustworthy if the manifests are STILL identical to the
	// dispatch snapshot after the commands ran — a mid-gate tamper downgrades
	// the verdict to INCONCLUSIVE so the LLM verifier spawns. This can only
	// ever DOWNGRADE, never upgrade (the pre-check above already ruled out
	// pre-existing drift, so any drift now appeared during the run).
	if (input.hostSpec && outcome.verdict === "PASS") {
		const drift = detectHostSpecDrift(input.cwd, input.hostSpec);
		if (drift.length > 0) {
			const note = `manifest-integrity: ${drift.join(", ")} changed during the gate run (host snapshot)`;
			outcome = {
				...outcome,
				verdict: "INCONCLUSIVE",
				evidenceLines: [...outcome.evidenceLines, note],
				integrityNote: note,
			};
		}
	}
	// ── W2 bookend: tree binding AFTER a green gate (mirrors the manifest
	// bookend above) ─────────────────────────────────────────────────────
	// A PASS is only trustworthy if the tracked tree that produced it is STILL
	// the dispatch-pinned tree when the gate finishes — a mid-gate harness
	// swap (concurrent writer in a shared cwd) downgrades the verdict to
	// INCONCLUSIVE so the LLM verifier spawns. Downgrade-only, like above.
	if (input.hostSpec && outcome.verdict === "PASS") {
		const treeDriftNote = detectWorkingTreeDrift(input.cwd, input.hostSpec);
		if (treeDriftNote) {
			const note = `${treeDriftNote} (during the gate run)`;
			outcome = {
				...outcome,
				verdict: "INCONCLUSIVE",
				evidenceLines: [...outcome.evidenceLines, note],
				worktreeIntegrityNote: note,
			};
		}
	}
	// ── M3-28 (R47-V2, fix-wave 6): the U6B classifier layer is NOT consulted ──
	// The consult used to live here, guarded by `outcome.verdict === "INCONCLUSIVE"`
	// and fed the literal gate verdict. That input can never be pass-shaped:
	// `classifyVerifierPreGate` blocks only when `isPassShapedVerdict(...)` is true
	// (classifier-pre-gate.ts — PASS vocabulary AND no failure vocabulary), and
	// "INCONCLUSIVE" matches the failure vocabulary (…conclusive → no PASS match
	// at all), so `action` was ALWAYS escalate_verdict_failed ⇒ blockVerifier
	// false ⇒ the same spawn decision the no-classifier branch yields. Net effect
	// of the consult: one model call, one task.verifier_pre_gate event and one
	// decisions_total counter for a decision that could never differ.
	// Wiring it "for real" is not possible from here: a state that says
	// INCONCLUSIVE cannot be conclusive evidence of a pass, so there is nothing
	// for the classifier to legitimately block on. Removed (spend without a
	// decision, plus a misleading `classifier_*` reason label).
	// `input.classifier` stays on the interface (deprecated) because the dispatch
	// call site in task-runner.ts passes it; removing the field is a follow-up
	// that must land with that call site.
	// ── W10-2: record the green verdict for same-tree memoization (AFTER the
	// post-bookend — a drift-downgraded INCONCLUSIVE must never memoize).
	if (outcome.verdict === "PASS" && recordVerifyGateMemo(input.cwd, checks, outcome)) {
		incMetric(
			input.metricRegistry,
			"crew.verification.verify_gate_memo_records_total",
			"W10-2 PASS verdicts recorded for same-tree memoization",
			{},
		);
	}
	const preGate: VerifierPreGateResult | undefined = undefined;
	// W2: the guard runs on fresh verdicts too — a green gate in the verifier's
	// own pristine worktree must not skip the verifier when the dependency work
	// it certifies lives in other, uncommitted worktrees.
	const guarded = resolveWorktreeGuardDecision(input.dependencyWorktreeProbes, outcome);
	if (guarded.forcedSpawn) {
		incMetric(
			input.metricRegistry,
			"crew.verification.verifier_gate_worktree_guard_total",
			"W2: PASS-skip refusals — dependency worktree work the gate's evaluated tree does not contain",
			{ result: "spawn_forced" },
		);
	}
	outcome = guarded.outcome;
	const decision = guarded.decision;
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
		promptContext:
			decision.attachGateContext || (determinismNote !== "" && !decision.skipVerifier) ? renderVerifyGateContext(outcome) : "",
	};
}
