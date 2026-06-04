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
import { writeArtifact } from "../state/artifact-store.ts";
import type { VerificationContract, VerificationCommandResult, GreenLevel, ArtifactDescriptor } from "../state/types.ts";

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
export const NPM_TYPESCRIPT_GATES: Array<{ name: string; command: string; critical: boolean }> = [
	{ name: "build", command: "npm run build 2>&1", critical: true },
	{ name: "typecheck", command: "npx tsc --noEmit 2>&1", critical: true },
	{ name: "lint", command: "npm run lint 2>&1", critical: false },
	{ name: "tests", command: "npm test 2>&1", critical: true },
];

/**
 * Cargo/Rust project phase gates.
 */
export const CARGO_RUST_GATES: Array<{ name: string; command: string; critical: boolean }> = [
	{ name: "check", command: "cargo check 2>&1", critical: true },
	{ name: "test", command: "cargo test 2>&1", critical: true },
	{ name: "clippy", command: "cargo clippy 2>&1", critical: false },
];

/**
 * Execute a single command and capture output.
 */
/** Characters/patterns that indicate dangerous shell metacharacters. */
const DANGEROUS_SHELL_PATTERNS = /(?:;|&&|\|\||\$\(|`|\$\{|\b(eval|exec)\b|>>|<[^&])/;
// Note: single `>` is NOT blocked here because `2>&1` is a safe redirect used by built-in gates.
// `>>` (append) is still blocked. `<` without `&` (input redirect) is still blocked.

/**
 * Validate a verification gate command is safe to execute.
 * Rejects commands with shell metacharacters that could enable injection.
 * Allows: pipes (|), redirection of stderr (2>&1), and basic npm/cargo/npx commands.
 */
function validateGateCommand(command: string): void {
	const normalized = command
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // ANSI escape sequences
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')  // control chars
		.replace(/\\\n/g, ' ')  // escaped newlines
		.replace(/\s+/g, ' ')  // collapse whitespace
		.trim();
	if (DANGEROUS_SHELL_PATTERNS.test(normalized)) {
		throw new Error(
			`Security: verification gate command rejected (dangerous shell pattern): ${command}`,
		);
	}
}

async function executeCommand(
	command: string,
	cwd: string,
	timeoutMs: number = 120000,
): Promise<{ exitCode: number | null; output: string; durationMs: number }> {
	// SECURITY: Validate command before shell execution to prevent injection.
	validateGateCommand(command);

	const start = Date.now();
	let output = "";
	let exitCode: number | null = null;

	return new Promise((resolve) => {
		const shell = spawn("sh", ["-c", command], {
			cwd,
			timeout: timeoutMs,
			env: { ...process.env, FORCE_COLOR: "0" },
		});

		shell.stdout?.on("data", (data) => {
			output += data.toString();
		});

		shell.stderr?.on("data", (data) => {
			output += data.toString();
		});

		shell.on("close", (code) => {
			exitCode = code;
			resolve({
				exitCode,
				output: output.slice(-100000), // Cap at 100KB
				durationMs: Date.now() - start,
			});
		});

		shell.on("error", (err) => {
			resolve({
				exitCode: -1,
				output: `Execution error: ${err.message}`,
				durationMs: Date.now() - start,
			});
		});

		// Handle timeout
		setTimeout(() => {
			shell.kill("SIGKILL");
			resolve({
				exitCode: -1,
				output: output + "\n[TIMEOUT: Command exceeded limit]",
				durationMs: Date.now() - start,
			});
		}, timeoutMs);
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

	// Run phase gates
	const bundle = await runPhaseGates(gates, cwd, signal, (phaseResult) => {
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
				phaseResult.output || "(no output)",
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

	// Write summary artifact
	const summaryArtifact = writeArtifact(artifactsRoot, {
		kind: "metadata",
		relativePath: `verification-gates/${taskId}-summary.json`,
		content: JSON.stringify(bundle, null, 2),
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
export function computeGreenLevelFromResults(
	commands: VerificationCommandResult[],
	requiredLevel: GreenLevel,
): GreenLevel {
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
