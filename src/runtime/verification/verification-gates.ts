/**
 * Verification Gates — ECC VERIFICATION_LOOP Pattern Implementation
 *
 * Implements RED/GREEN phase gates for task verification.
 * Sequential execution: cannot skip to Phase N+1 without Phase N passing.
 *
 * Based on: docs/distillation/ECC-10-skills.md §2 (verification-loop)
 *
 * @module verification-gates
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getCrewEnv } from "../../config/env-vars.ts";
import { writeArtifact } from "../../state/stores/artifact-store.ts";
import type { GreenLevel, VerificationCommandResult, VerificationContract } from "../../state/types.ts";
import { WINDOWS_ESSENTIAL_ENV_VARS } from "../../utils/env-allowlist.ts";
import { sanitizeEnvSecrets } from "../../utils/env-filter.ts";
import { redactSecretString } from "../../utils/redaction.ts";

/**
 * Phase 1.5 #1 (RFC 13 §6 info-disclosure mitigation): sanitize the env passed
 * to verification commands so worker-induced output cannot leak model-provider
 * secrets. P1f redaction at artifact-write + judge-bound is regex-best-effort
 * against adversarial workers; this kills the leak at the source by never
 * giving the verification process the secret in the first place.
 *
 * Opt-out via `PI_CREW_VERIFICATION_SANITIZE_ENV=0` or
 * `PI_TEAMS_VERIFICATION_SANITIZE_ENV=0` to disable sanitization (e.g. for
 * tests that legitimately need API access). Escape hatch:
 * `PI_CREW_VERIFICATION_PRESERVE_ENV=KEY1,KEY2,...` lets users explicitly opt
 * specific secrets back in (audited via the allowlist validator).
 */
const VERIFICATION_ENV_ALLOWLIST: readonly string[] = [
	// Essential non-secret vars only — NO model-provider keys by default.
	"PATH",
	"HOME",
	"USER",
	"SHELL",
	"TERM",
	"LANG",
	"LC_ALL",
	"LC_COLLATE",
	"LC_CTYPE",
	"LC_MESSAGES",
	"LC_MONETARY",
	"LC_NUMERIC",
	"LC_TIME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_RUNTIME_DIR",
	// Windows essentials — see WINDOWS_ESSENTIAL_ENV_VARS (src/utils/env-allowlist.ts).
	...WINDOWS_ESSENTIAL_ENV_VARS,
	"NVM_BIN",
	"NVM_DIR",
	"NVM_INC",
	"NODE_PATH",
	"NODE_DISABLE_COLORS",
	"NODE_EXTRA_CA_CERTS",
	"NPM_CONFIG_REGISTRY",
	"NPM_CONFIG_USERCONFIG",
	"NPM_CONFIG_GLOBALCONFIG",
];

/** Whether env sanitization for verification is enabled (opt-out: enabled by default). */
export function isVerificationEnvSanitizeEnabled(): boolean {
	// Opt-out: explicitly disabled via env var set to '0'.
	if (getCrewEnv("PI_CREW_VERIFICATION_SANITIZE_ENV") === "0" || getCrewEnv("PI_TEAMS_VERIFICATION_SANITIZE_ENV") === "0") {
		return false;
	}
	return true;
}

/**
 * Build the env dict for a verification command. When sanitization is enabled,
 * strips everything except VERIFICATION_ENV_ALLOWLIST + any explicitly-preserved
 * keys (PI_CREW_VERIFICATION_PRESERVE_ENV=KEY1,KEY2). Always adds FORCE_COLOR=0
 * to keep output plain-text (matches pre-existing behavior).
 */
function buildVerificationEnv(): Record<string, string> {
	if (!isVerificationEnvSanitizeEnabled()) {
		return { ...process.env, FORCE_COLOR: "0" };
	}
	const preserveRaw = getCrewEnv("PI_CREW_VERIFICATION_PRESERVE_ENV") ?? "";
	const preserve = preserveRaw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const allowList = [...VERIFICATION_ENV_ALLOWLIST, ...preserve];
	return {
		...sanitizeEnvSecrets(process.env, { allowList }),
		FORCE_COLOR: "0",
	};
}

export interface PhaseGateResult {
	phase: number;
	name: string;
	status: "passed" | "failed" | "skipped";
	command: string;
	exitCode?: number | null;
	output?: string;
	durationMs: number;
	error?: string;
}

export interface PhaseGateBundle {
	results: PhaseGateResult[];
	totalDurationMs: number;
	allPassed: boolean;
	stoppedAt?: number; // phase number where stopped
}

/**
 * Standard phase gate definitions for npm/TypeScript projects.
 * Sequential enforcement: each phase must pass before proceeding.
 */
export const NPM_TYPESCRIPT_GATES: Array<{
	name: string;
	command: string;
	critical: boolean;
}> = [
	{ name: "build", command: "npm run build 2>&1", critical: true },
	{ name: "typecheck", command: "npx tsc --noEmit 2>&1", critical: true },
	{ name: "lint", command: "npm run lint 2>&1", critical: false },
	{ name: "tests", command: "npm test 2>&1", critical: true },
];

/**
 * Cargo/Rust project phase gates.
 */
export const CARGO_RUST_GATES: Array<{
	name: string;
	command: string;
	critical: boolean;
}> = [
	{ name: "check", command: "cargo check 2>&1", critical: true },
	{ name: "test", command: "cargo test 2>&1", critical: true },
	{ name: "clippy", command: "cargo clippy 2>&1", critical: false },
];

/**
 * Execute a single command and capture output.
 */
/**
 * P-4 (DR-04 round-7): accumulation cap while STREAMING child output. The
 * final `slice(-100000)` already bounds the RESULT, but the live `output`
 * buffer used to concatenate every chunk until close/timeout — a command
 * emitting gigabytes held them ALL in memory (plus O(n²) string concat).
 * Past this cap we stop concatenating and pin a "[truncated]" marker in the
 * buffer; the final tail slice is unchanged.
 */
const OUTPUT_ACCUMULATION_CAP_CHARS = 200 * 1024;
const OUTPUT_TRUNCATION_MARKER = "\n[truncated]";
/** Characters/patterns that indicate dangerous shell metacharacters. */
// Round 25 (VULN-3/VULN-4): also block raw newlines (sh -c treats \n as a
// command separator -> injection) and bare $VARNAME references (can exfiltrate
// secrets into captured gate output, e.g. `echo $ANTHROPIC_API_KEY`).
// $+word-char is blocked; special vars like $?/$$/$! are left alone. Built-in
// gates use only `2>&1` (no $VAR), so this does not break them.
// M-3/M-4 fix (code-review 2026-06-23): the old pattern used `>>` (append) and
// `<[^^&]` (a confusing char class). It allowed bare `>` (file redirect, e.g.
// `npm test > ~/.ssh/authorized_keys`) and used char-class semantics instead of
// a lookahead. Now `[<>](?![&\d])` blocks BOTH `<` and `>` file redirects while
// still permitting fd-duplication forms (`2>&1`, `1>&2`, `>&2`, `<&3`) via the
// negative lookahead (a `>`/`<` followed by `&` or a digit is allowed). A bare
// `&` is also blocked so an allowed gate cannot background itself and start a
// second command.
const DANGEROUS_SHELL_PATTERNS = /(?:;|&&|\|\||\$\(|`|\$\{|\$\w|\b(eval|exec)\b|[<>](?![&\d])|(?<![<>])&|[\r\n])/;

/**
 * Verification gates intentionally execute project-controlled code, but they
 * must enter through a known build/test runner. Interpreter eval modes and
 * arbitrary utilities are excluded: `node -e`, `python -c`, `curl`, etc. can
 * otherwise execute attacker-provided code without any shell metacharacters.
 *
 * Prefixes are token-bound and each side of a pipeline is checked separately,
 * preventing an allowed prefix such as `npm test | node -e ...` from bypassing
 * the restriction. Keep this list focused on common verification commands.
 */
const ALLOWED_GATE_COMMAND_PATTERNS: readonly RegExp[] = [
	/^npm\s+(?:test(?:\s|$)|run(?:-script)?\s+[A-Za-z0-9_.:-]+(?:\s|$))/,
	/^pnpm\s+(?:test(?:\s|$)|run\s+[A-Za-z0-9_.:-]+(?:\s|$))/,
	/^yarn\s+(?:test(?:\s|$)|run\s+[A-Za-z0-9_.:-]+(?:\s|$))/,
	/^npx\s+(?:--no-install\s+)?(?:biome|eslint|tsc)(?:\s|$)/,
	/^(?:biome|eslint|tsc)(?:\s|$)/,
	/^node\s+(?:(?:--experimental-strip-types|--no-warnings)\s+)*--test(?:\s|$)/,
	/^python(?:3(?:\.\d+)*)?\s+-m\s+(?:pytest|unittest)(?:\s|$)/,
	/^pytest(?:\s|$)/,
	/^cargo\s+(?:build|check|clippy|fmt|test)(?:\s|$)/,
	/^go\s+(?:build|test|vet)(?:\s|$)/,
	/^bun\s+test(?:\s|$)/,
	/^deno\s+(?:check|lint|test)(?:\s|$)/,
	/^dotnet\s+(?:build|test)(?:\s|$)/,
	/^(?:gradle|\.\/gradlew)\s+(?:build|check|test)(?:\s|$)/,
	/^(?:mvn|\.\/mvnw)\s+(?:package|test|verify)(?:\s|$)/,
	/^make\s+(?:build|check|lint|test)(?:\s|$)/,
	// S-3 (deep review 2026-10-31): `printenv` removed — no built-in gate needs
	// it, and it turns any allowlisted gate into an environment-dump read
	// primitive whose output is captured into world-readable artifacts
	// (sanitize survivors + PRESERVE_ENV vars included).
	/^(?:echo|false|printf|true)(?:\s|$)/,
	// S-3: reader commands stay allowlisted ONLY as cwd-scoped evidence
	// extractors — their path arguments are additionally restricted by
	// validateGateReaderPathArgs below (no absolute or ~-prefixed paths).
	/^(?:grep|head|rg|tail)(?:\s|$)/,
];

const NODE_EVAL_MODE_PATTERN = /(?:^|\s)["']?(?:(?:-e|-p)(?!-)|--(?:eval|print)(?:=|\s|["']|$))/;

/** S-3 (deep review 2026-10-31): grep/head/rg/tail are allowlisted as
 *  cwd-scoped evidence extractors. A path argument resolving outside the gate
 *  cwd — absolute (`/etc/passwd`), home-relative (`~/notes`), Windows absolute
 *  (`C:/Windows`, `\\\\host\\share`), or `..`-relative escaping it — is an
 *  out-of-workspace read primitive, so it is rejected outright. Fail-closed:
 *  simpler than allowlisting the cwd's absolute prefix, which quoting and `~`
 *  expansion would defeat. Option flags (`-c`, `-rn`, …) and cwd-relative
 *  paths (`src/`, `dist/index.mjs`) pass. */
const GATE_READER_COMMAND_PATTERN = /^(?:grep|head|rg|tail)(?:\s|$)/;

/** S-3 hardening (2026-10-31, LOW ruling): `rg --pre <cmd>` runs an arbitrary
 *  preprocessor executable on every file the reader touches — an execution
 *  primitive hiding inside a reader allowlist entry. Denied in both the
 *  attached (`--pre=x`) and detached (`--pre x`) spellings. */
const GATE_READER_PREPROCESSOR_PATTERN = /(?:^|\s)--pre(?:\s|=|$)/;

/** S-3 hardening: Windows absolute forms — drive letter (`C:/…`, `C:\\…`) and
 *  UNC (`\\\\host\\share`). */
const WINDOWS_ABSOLUTE_ARG_PATTERN = /^[A-Za-z]:[\\/]/;

/** S-3 hardening: lexical path containment — `child` inside `parent`? Exact
 *  segment boundary on the `..` escape; path.relative never returns a bare
 *  absolute path on the same tree. */
function isPathWithin(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function validateGateReaderPathArgs(pipelineCommand: string, original: string, gateCwd?: string): void {
	if (GATE_READER_PREPROCESSOR_PATTERN.test(pipelineCommand)) {
		throw new Error(`Security: verification gate command rejected (reader --pre runs an arbitrary preprocessor): ${original}`);
	}
	for (const rawArg of pipelineCommand.split(/\s+/).slice(1)) {
		// Strip at most one leading and one trailing quote char: `sh -c`
		// expands quotes before path resolution, so `"/etc/passwd"` (and an
		// unbalanced prefix like `"~/a` from a whitespace-split quoted path)
		// must not slip through.
		let arg = rawArg;
		if (arg.startsWith('"') || arg.startsWith("'")) arg = arg.slice(1);
		if (arg.endsWith('"') || arg.endsWith("'")) arg = arg.slice(0, -1);
		if (arg.length === 0) continue;
		if (arg.startsWith("/") || arg.startsWith("~")) {
			throw new Error(
				`Security: verification gate command rejected (reader path argument escapes the gate cwd — absolute and ~-prefixed paths are not allowed): ${original}`,
			);
		}
		// Windows absolute forms — on POSIX a `C:/x` arg is a cwd-relative
		// filename to US, but sh/spawn on win32 resolves it absolutely.
		if (WINDOWS_ABSOLUTE_ARG_PATTERN.test(arg) || arg.startsWith("\\\\")) {
			throw new Error(
				`Security: verification gate command rejected (reader path argument is a Windows absolute path — must stay cwd-relative): ${original}`,
			);
		}
		if (arg.startsWith("-")) {
			// Flags are not paths we can resolve — but an ATTACHED value carrying a
			// path separator (`-f/etc/x`, `--pre=/usr/bin/id`) smuggles an absolute
			// path past the positional checks above, so reject any separator in a
			// flag token (reader flags are pattern/count selectors — no slashes).
			if (/[\\/]/.test(arg)) {
				throw new Error(
					`Security: verification gate command rejected (reader flag carries a path in its attached value): ${original}`,
				);
			}
			continue;
		}
		// Positional argument (pattern or path): when the gate cwd is known,
		// resolve against it and enforce containment (covers `a/../../etc/x`
		// escapes that do not START with `..`); without a cwd (test helper), fall
		// back to a lexical leading-`..` segment check.
		if (gateCwd !== undefined) {
			const resolved = path.resolve(gateCwd, arg);
			if (!isPathWithin(gateCwd, resolved)) {
				throw new Error(
					`Security: verification gate command rejected (reader path argument resolves outside the gate cwd): ${original}`,
				);
			}
		} else if (arg === ".." || arg.startsWith(`..${path.sep}`) || arg.startsWith("../")) {
			throw new Error(
				`Security: verification gate command rejected (reader path argument escapes the gate cwd — ..-relative paths are not allowed): ${original}`,
			);
		}
	}
}

function validateAllowedGateCommands(normalized: string, original: string, gateCwd?: string): void {
	const pipelineCommands = normalized.split("|").map((part) => part.trim());
	for (const pipelineCommand of pipelineCommands) {
		if (/^node(?:\s|$)/.test(pipelineCommand) && NODE_EVAL_MODE_PATTERN.test(pipelineCommand)) {
			throw new Error(`Security: verification gate command rejected (Node eval/print mode is not allowed): ${original}`);
		}
		if (GATE_READER_COMMAND_PATTERN.test(pipelineCommand)) {
			validateGateReaderPathArgs(pipelineCommand, original, gateCwd);
		}
		if (!pipelineCommand || !ALLOWED_GATE_COMMAND_PATTERNS.some((pattern) => pattern.test(pipelineCommand))) {
			throw new Error(`Security: verification gate command rejected (command is not allowlisted): ${original}`);
		}
	}
}

/**
 * Validate a verification gate command is safe to execute.
 * Rejects commands with shell metacharacters that could enable injection and
 * commands outside the verification-runner allowlist. Allows safe pipelines
 * and stderr fd duplication (`2>&1`).
 */
/** @internal — exported for injection-guard unit testing (Round 25). */
export function __test__validateGateCommand(command: string, gateCwd?: string): void {
	validateGateCommand(command, gateCwd);
}

function validateGateCommand(command: string, gateCwd?: string): void {
	// Round 25 (VULN-3): check the ORIGINAL command for raw newlines BEFORE
	// normalization. The regex below runs on the NORMALIZED command (which
	// collapses \s+ incl. newlines to a single space), so a newline would be
	// hidden from it - but `sh -c` treats a raw newline as a command
	// separator, enabling injection (e.g. `npm test\nrm -rf x`).
	if (/[\r\n]/.test(command)) {
		throw new Error(
			`Security: verification gate command rejected (raw newline - potential command injection): ${JSON.stringify(command)}`,
		);
	}
	const normalized = command
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "") // ANSI escape sequences
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "") // control chars
		.replace(/\\\n/g, " ") // escaped newlines
		.replace(/\s+/g, " ") // collapse whitespace
		.trim();
	if (DANGEROUS_SHELL_PATTERNS.test(normalized)) {
		throw new Error(`Security: verification gate command rejected (dangerous shell pattern): ${command}`);
	}
	validateAllowedGateCommands(normalized, command, gateCwd);
}

/** U13 (upgrade spec 2026-10-09): exported so the deterministic verify_gate
 *  engine (verify-gate.ts) reuses the SAME hardened command runner the
 *  verifier flow already uses — command validation, sanitized env, process-
 *  group kill, output cap, timeout. Additive export, no behavior change. */
export async function executeCommand(
	command: string,
	cwd: string,
	timeoutMs: number = 120000,
): Promise<{ exitCode: number | null; output: string; durationMs: number }> {
	// SECURITY: Validate command before shell execution to prevent injection.
	// The execution cwd IS the gate cwd for reader-path containment — thread it
	// down so `..`-relative escapes resolve against where the command runs.
	validateGateCommand(command, cwd);

	const start = Date.now();
	let output = "";
	let capped = false;
	let exitCode: number | null = null;

	// P-4: single capped appender for BOTH streams — once the cap trips, later
	// chunks are dropped (marker stays in the buffer; final slice keeps it).
	const appendCapped = (chunk: Buffer): void => {
		if (capped) return;
		output += chunk.toString();
		if (output.length > OUTPUT_ACCUMULATION_CAP_CHARS) {
			capped = true;
			output += OUTPUT_TRUNCATION_MARKER;
		}
	};

	return new Promise((resolve) => {
		const shell = spawn("sh", ["-c", command], {
			cwd,
			timeout: timeoutMs,
			env: buildVerificationEnv(),
			detached: true, // CORE-10: own process group so group-wide SIGKILL reaches children
		});

		shell.stdout?.on("data", appendCapped);

		shell.stderr?.on("data", appendCapped);

		// M-9 fix (code-review 2026-06-23): store the timeout handle so it can be
		// cleared when the process exits normally, and unref it so it does not
		// keep the Node.js event loop alive for the full timeoutMs after all work
		// is done (previously it fired shell.kill() on an already-dead process).
		const timer = setTimeout(() => {
			// CORE-10: kill the entire process group (negative PID) so child processes
			// spawned by the shell are also terminated. Fall back to shell.kill() if the
			// group kill fails (e.g. process already reaped).
			try {
				if (shell.pid) process.kill(-shell.pid, "SIGKILL");
			} catch {
				shell.kill("SIGKILL");
			}
			resolve({
				exitCode: -1,
				output: output + "\n[TIMEOUT: Command exceeded limit]",
				durationMs: Date.now() - start,
			});
		}, timeoutMs);
		timer.unref();
		const clearTimer = (): void => clearTimeout(timer);

		shell.on("close", (code) => {
			clearTimer();
			exitCode = code;
			resolve({
				exitCode,
				output: output.slice(-100000), // Cap at 100KB
				durationMs: Date.now() - start,
			});
		});

		shell.on("error", (err) => {
			clearTimer();
			resolve({
				exitCode: -1,
				output: `Execution error: ${err.message}`,
				durationMs: Date.now() - start,
			});
		});
	});
}

/**
 * Run phase gates sequentially, stopping on first critical failure.
 *
 * @param gates - Array of phase gate definitions
 * @param cwd - Working directory to execute commands in
 * @param signal - Optional abort signal
 * @param onPhase - Optional callback for each phase completion
 * @returns Phase gate bundle with all results
 */
export async function runPhaseGates(
	gates: Array<{ name: string; command: string; critical: boolean }>,
	cwd: string,
	signal?: AbortSignal,
	onPhase?: (result: PhaseGateResult) => void,
): Promise<PhaseGateBundle> {
	const results: PhaseGateResult[] = [];
	const startTime = Date.now();
	let stoppedAt: number | undefined;

	for (let i = 0; i < gates.length; i++) {
		// Check abort signal
		if (signal?.aborted) {
			results.push({
				phase: i + 1,
				name: gates[i].name,
				status: "skipped",
				command: gates[i].command,
				durationMs: 0,
				error: "Aborted",
			});
			stoppedAt = i + 1;
			break;
		}

		const gate = gates[i];
		const phaseStart = Date.now();

		// Execute the gate command
		const { exitCode, output, durationMs } = await executeCommand(
			gate.command,
			cwd,
			120000, // 2 minute timeout
		);

		const passed = exitCode === 0;
		const result: PhaseGateResult = {
			phase: i + 1,
			name: gate.name,
			status: passed ? "passed" : "failed",
			command: gate.command,
			exitCode,
			output,
			durationMs,
			error: passed ? undefined : `Exit code: ${exitCode}`,
		};

		results.push(result);
		onPhase?.(result);

		// Stop on critical failure
		if (!passed && gate.critical) {
			stoppedAt = i + 1;
			break;
		}
	}

	return {
		results,
		totalDurationMs: Date.now() - startTime,
		allPassed: results.every((r) => r.status === "passed"),
		stoppedAt,
	};
}

/**
 * Execute verification commands from a task's verification contract.
 * Maps the contract commands to phase gates and runs them sequentially.
 *
 * @param contract - Verification contract with commands to execute
 * @param cwd - Working directory
 * @param runId - Run ID for artifact naming
 * @param taskId - Task ID for artifact naming
 * @param artifactsRoot - Artifacts root directory
 * @param signal - Optional abort signal
 * @returns Array of verification command results
 */
export async function executeVerificationCommands(
	contract: VerificationContract,
	cwd: string,
	runId: string,
	taskId: string,
	artifactsRoot: string,
	signal?: AbortSignal,
	/** Phase 1.5 #2 (RFC 16): when provided, run verification commands in this
	 *  pristine git-worktree path instead of `cwd`. The caller is responsible
	 *  for preparing + cleaning up the worktree (see verification-worktree.ts).
	 *  When undefined, behavior is unchanged (run in `cwd`). */
	worktreeCwd?: string,
): Promise<VerificationCommandResult[]> {
	if (!contract.commands || contract.commands.length === 0) {
		return [];
	}

	const results: VerificationCommandResult[] = [];

	// Map commands to phase gates
	const gates = contract.commands.map((cmd, index) => ({
		name: `verification-${index + 1}`,
		command: cmd,
		critical: true, // All verification commands are critical by default
	}));

	// Create artifacts directory
	const gatesDir = path.join(artifactsRoot, "verification-gates");
	if (!fs.existsSync(gatesDir)) {
		fs.mkdirSync(gatesDir, { recursive: true });
	}

	// Phase 1.5 #2: run phase gates inside the worktree when provided.
	const execCwd = worktreeCwd ?? cwd;

	// Run phase gates
	const bundle = await runPhaseGates(gates, execCwd, signal, (phaseResult) => {
		// P1f: redact secrets from verification output BEFORE persisting to the
		// world-readable artifact file. redactSecretString is best-effort vs
		// adversarial workers (RFC §6 — Med-High residual). writeArtifact ALSO
		// redacts (defense-in-depth); this explicit pass sanitizes the raw output
		// at the source so the in-memory bundle and the summary below are clean.
		const safeOutput = redactSecretString(phaseResult.output || "");
		// Write phase artifact immediately for observability
		const phaseArtifact = writeArtifact(artifactsRoot, {
			kind: "log",
			relativePath: `verification-gates/${taskId}-phase-${phaseResult.phase}-${phaseResult.name}.log`,
			content: [
				`# Phase ${phaseResult.phase}: ${phaseResult.name}`,
				`Status: ${phaseResult.status.toUpperCase()}`,
				`Command: ${phaseResult.command}`,
				`Duration: ${phaseResult.durationMs}ms`,
				phaseResult.exitCode != null ? `Exit Code: ${phaseResult.exitCode}` : "",
				phaseResult.error ? `Error: ${phaseResult.error}` : "",
				"",
				"## Output",
				safeOutput || "(no output)",
			].join("\n"),
			producer: taskId,
		});

		results.push({
			cmd: phaseResult.command,
			status: phaseResult.status === "passed" ? "passed" : "failed",
			exitCode: phaseResult.exitCode,
			outputArtifact: phaseArtifact,
		});
	});

	// Write summary artifact. Redact the whole bundle JSON (it embeds the raw
	// per-phase output strings) BEFORE writeArtifact persists it.
	const summaryArtifact = writeArtifact(artifactsRoot, {
		kind: "metadata",
		relativePath: `verification-gates/${taskId}-summary.json`,
		content: redactSecretString(JSON.stringify(bundle, null, 2)),
		producer: taskId,
	});

	// Fill in any remaining results (in case of early exit)
	for (let i = results.length; i < gates.length; i++) {
		results.push({
			cmd: gates[i].command,
			status: "not_run",
		});
	}

	return results;
}

/**
 * Compute observed green level from verification results.
 * Maps verification outcomes to green levels per ECC pattern.
 *
 * @param commands - Array of verification command results
 * @param requiredLevel - Required green level from contract
 * @returns Observed green level
 */
export function computeGreenLevelFromResults(commands: VerificationCommandResult[], requiredLevel: GreenLevel): GreenLevel {
	if (commands.length === 0) {
		return "none";
	}

	const passed = commands.filter((c) => c.status === "passed").length;
	const failed = commands.filter((c) => c.status === "failed").length;
	const notRun = commands.filter((c) => c.status === "not_run").length;

	// If any critical verification failed, return none
	if (failed > 0) {
		return "none";
	}

	// If all passed, return the required level (capped at merge_ready)
	if (passed === commands.length) {
		return requiredLevel === "none" ? "targeted" : requiredLevel;
	}

	// Partial pass - return targeted
	if (passed > 0) {
		return "targeted";
	}

	// Nothing run
	return "none";
}

/**
 * Create a verification gate report artifact.
 * Formatted for human review per ECC verification-loop pattern.
 */
/** @internal */
function createVerificationGateReport(
	taskId: string,
	contract: VerificationContract,
	results: VerificationCommandResult[],
	bundle: PhaseGateBundle,
): string {
	const lines = [
		`# Verification Gate Report: ${taskId}`,
		"",
		`## Contract`,
		`- Required Green Level: ${contract.requiredGreenLevel}`,
		`- Allow Manual Evidence: ${contract.allowManualEvidence}`,
		`- Commands: ${contract.commands.length}`,
		"",
		`## Results`,
		"",
		`| Phase | Command | Status | Exit Code | Duration |`,
		`|-------|---------|--------|-----------|----------|`,
	];

	for (const result of results) {
		const phaseIndex = results.indexOf(result) + 1;
		const statusIcon = result.status === "passed" ? "✅" : result.status === "failed" ? "❌" : "⏭️";
		lines.push(
			`| ${phaseIndex} | \`${truncate(result.cmd, 40)}\` | ${statusIcon} ${result.status} | ${result.exitCode ?? "-"} | ${result.durationMs ?? 0}ms |`,
		);
	}

	lines.push("");
	lines.push(`## Summary`);
	lines.push(`- Total Phases: ${bundle.results.length}`);
	lines.push(`- Passed: ${bundle.results.filter((r) => r.status === "passed").length}`);
	lines.push(`- Failed: ${bundle.results.filter((r) => r.status === "failed").length}`);
	lines.push(`- Skipped: ${bundle.results.filter((r) => r.status === "skipped").length}`);
	lines.push(`- Total Duration: ${bundle.totalDurationMs}ms`);
	lines.push(`- All Passed: ${bundle.allPassed ? "YES ✅" : "NO ❌"}`);

	if (bundle.stoppedAt) {
		lines.push(`- Stopped At: Phase ${bundle.stoppedAt}`);
	}

	lines.push("");
	lines.push("## VERIFICATION");
	lines.push(bundle.allPassed ? "**PASSED** - All gates green ✅" : "**FAILED** - One or more gates red ❌");

	return lines.join("\n");
}

function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return str.slice(0, maxLen - 3) + "...";
}
