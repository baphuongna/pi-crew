/**
 * Transparent iteration hooks — runs user-supplied before/after task scripts
 * with structured JSON payload on stdin.
 *
 * Distilled from pi-autoresearch's iteration hook pattern.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveShellForScript } from "../utils/resolve-shell.ts";
import { sanitizeEnvSecrets } from "../utils/env-filter.ts";
import { DENIED_METRIC_NAMES } from "./metric-parser.ts";

/** Hook execution stage. */
export type HookStage = "before" | "after";

/** Payload sent to the hook script via stdin as JSON. */
export interface HookPayload {
	event: HookStage;
	cwd: string;
	taskId: string;
	runId: string;
	taskRole: string;
	lastResult?: {
		status: string;
		description: string;
		diagnostics?: Record<string, unknown>;
	} | null;
	session: {
		teamName: string;
		workflowName: string;
		goal: string;
		completedTasks: number;
		totalTasks: number;
	};
}

/** Result of executing an iteration hook. */
export interface HookResult {
	/** Whether the hook script was actually executed. */
	fired: boolean;
	/** Captured stdout (truncated to 8KB). */
	stdout: string;
	/** Captured stderr. */
	stderr: string;
	/** Exit code of the hook process. */
	exitCode: number | null;
	/** Whether the hook timed out. */
	timedOut: boolean;
	/** Wall-clock duration in milliseconds. */
	durationMs: number;
}

/** Maximum stdout capture size in bytes (8 KB). */
const MAX_STDOUT_BYTES = 8192;

/** Hook execution timeout in milliseconds (30 seconds). */
const HOOK_TIMEOUT_MS = 30_000;

/**
 * Validates that a hook script path is within an allowed directory.
 * Allowed paths:
 * - Relative paths starting with ".hooks/" (case-sensitive)
 * - Absolute paths under $HOME/.pi/hooks/
 * All other paths are rejected to prevent arbitrary script execution.
 * @param hookPath - The hook script path to validate
 * @returns true if the path is allowed, false otherwise
 */
export function isAllowedHookPath(hookPath: string): boolean {
	if (!hookPath || hookPath.trim().length === 0) return false;
	if (!path.isAbsolute(hookPath)) {
		// Use path.posix.normalize to ensure forward-slash normalization on all platforms.
		// On Windows, path.normalize converts .hooks/hook.sh to .hooks\hook.sh (backslash),
		// breaking the startsWith(".hooks/") check. path.posix.normalize always uses /.
		const normalized = path.posix.normalize(hookPath);
		return normalized === ".hooks" || normalized.startsWith(".hooks/");
	}
	// Normalize to forward slashes for consistent cross-platform comparison.
	// e.g., "C:\\Users\\runner\\.pi\\hooks\\hook.sh" matches
	// "C:\\Users\\runner\\.pi\\hooks/hook.sh" from path.join.
	const normalizedHookPath = hookPath.replace(/\\/g, "/");
	const homeHooksNormalized = (process.env.HOME ?? "").replace(/\\/g, "/") + "/.pi/hooks";
	return normalizedHookPath === homeHooksNormalized || normalizedHookPath.startsWith(homeHooksNormalized + "/");
}

/**
 * Create a not-fired result for when the hook script is absent or not executable.
 */
function notFiredResult(): HookResult {
	return {
		fired: false,
		stdout: "",
		stderr: "",
		exitCode: null,
		timedOut: false,
		durationMs: 0,
	};
}

/**
 * Truncate a buffer to the given byte limit, snapping to the last newline
 * boundary for UTF-8 safety.
 */
function truncateToLimit(buf: Buffer, limit: number): Buffer {
	if (buf.byteLength <= limit) return buf;

	const slice = buf.subarray(0, limit);
	// Find the last newline within the truncated region
	const lastNewline = slice.lastIndexOf("\n");
	if (lastNewline >= 0) {
		return slice.subarray(0, lastNewline);
	}
	// No newline found — return the full slice
	return slice;
}

/**
 * Check if a script path exists and is executable.
 */
function isScriptRunnable(scriptPath: string): boolean {
	try {
		if (!fs.existsSync(scriptPath)) return false;

		// On Windows, X_OK is unreliable — just check F_OK (file exists).
		// On Unix, check both F_OK and X_OK.
		if (process.platform === "win32") {
			fs.accessSync(scriptPath, fs.constants.F_OK);
		} else {
			fs.accessSync(scriptPath, fs.constants.F_OK | fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Run an iteration hook script with JSON payload on stdin.
 *
 * Spawns `bash <script>` with the hook payload as JSON on stdin.
 * Captures stdout (capped at 8KB) and stderr. Enforces a 30-second timeout.
 *
 * **Security note:** Hook paths are restricted to `.hooks/` relative paths
 * or `$HOME/.pi/hooks/` absolute paths. All other paths are rejected before
 * execution.
 *
 * @param payload - Structured hook payload
 * @param hookScriptPath - Absolute or relative path to the hook script
 * @returns HookResult indicating whether the hook fired and its output
 */
export async function runIterationHook(
	payload: HookPayload,
	hookScriptPath: string,
	options?: { timeoutMs?: number },
): Promise<HookResult> {
	if (!isAllowedHookPath(hookScriptPath)) {
		return { fired: false, stdout: "", stderr: "hook path not allowed: " + hookScriptPath, exitCode: null, timedOut: false, durationMs: 0 };
	}
	// Resolve relative paths relative to cwd
	const resolvedScript = path.isAbsolute(hookScriptPath) ? hookScriptPath : path.join(payload.cwd, hookScriptPath);
	if (!isScriptRunnable(resolvedScript)) {
		return notFiredResult();
	}

	const startTime = Date.now();
	const stdinJson = JSON.stringify(payload);
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];

	return new Promise<HookResult>((resolve) => {
		const { command, args } = resolveShellForScript(resolvedScript);
		const child = spawn(command, args, {
			cwd: payload.cwd,
			env: { ...sanitizeEnvSecrets(process.env, { allowList: ["PATH", "HOME", "USER", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "ComSpec", "SystemRoot", "PI_CREW_*"] }), PI_CREW_HOOK: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let killed = false;
		const timeoutMs = options?.timeoutMs ?? HOOK_TIMEOUT_MS;
		const timeout = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});

		child.on("close", (code: number | null) => {
			clearTimeout(timeout);
			const durationMs = Date.now() - startTime;

			const rawStdout = Buffer.concat(stdoutChunks);
			const truncatedStdout = truncateToLimit(rawStdout, MAX_STDOUT_BYTES);

			const rawStderr = Buffer.concat(stderrChunks);

			resolve({
				fired: true,
				stdout: truncatedStdout.toString("utf-8"),
				stderr: rawStderr.toString("utf-8"),
				exitCode: code,
				timedOut: killed,
				durationMs,
			});
		});

		child.on("error", (err: Error) => {
			clearTimeout(timeout);
			const durationMs = Date.now() - startTime;
			resolve({
				fired: true,
				stdout: "",
				stderr: err.message,
				exitCode: null,
				timedOut: false,
				durationMs,
			});
		});

		// Write payload to stdin and close it.
		// Handle EPIPE errors gracefully (occurs if the hook script exits before
		// reading all of stdin, which is normal for some hook scripts on certain OS).
		child.stdin.on("error", () => { /* ignore EPIPE — hook exited early */ });
		try {
			child.stdin.write(stdinJson, "utf-8");
			child.stdin.end();
		} catch {
			// ignore
		}
	});
}

/**
 * Derive a steer message from the hook result.
 *
 * - Non-zero exit → error steer message
 * - Timeout → timeout steer message
 * - Empty stdout → null (no steer)
 * - Otherwise → trimmed stdout content
 */
export function steerMessageFromHook(
	stage: HookStage,
	result: HookResult,
): string | null {
	if (!result.fired) return null;

	if (result.timedOut) {
		return `[${stage}-hook] Hook timed out after ${result.durationMs}ms`;
	}

	if (result.exitCode !== null && result.exitCode !== 0) {
		const stderrSnippet = result.stderr.trim().slice(0, 200);
		return `[${stage}-hook] Hook exited with code ${result.exitCode}${stderrSnippet ? `: ${stderrSnippet}` : ""}`;
	}

	const trimmed = result.stdout.trim();
	if (trimmed.length === 0) return null;

	// Filter out prototype-polluting metric names from hook output
	const lines = trimmed.split("\n");
	const safeLines = lines.filter((line) => {
		const match = /^CREW_METRIC\s+(\w+)=/.exec(line);
		if (match) {
			const name = match[1];
			return !DENIED_METRIC_NAMES.has(name);
		}
		return true;
	});

	return safeLines.join("\n");
}

/**
 * Build a log entry for recording hook execution in events.jsonl.
 */
export function hookLogEntry(
	stage: HookStage,
	result: HookResult,
): Record<string, unknown> {
	const entry: Record<string, unknown> = {
		type: "iteration-hook",
		stage,
		fired: result.fired,
		durationMs: result.durationMs,
	};

	if (result.fired) {
		entry.exitCode = result.exitCode;
		entry.timedOut = result.timedOut;

		// Include truncated stdout/stderr for diagnostics
		if (result.stdout.length > 0) {
			entry.stdoutPreview = result.stdout.slice(0, 512);
		}
		if (result.stderr.length > 0) {
			entry.stderrPreview = result.stderr.slice(0, 512);
		}
	}

	return entry;
}