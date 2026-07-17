/**
 * Post-task backpressure checks — runs a configurable shell script after
 * task completion to verify workspace health before proceeding.
 *
 * Distilled from pi-autoresearch's post-check / backpressure pattern.
 */
import { execFileSync } from "node:child_process";
import { WINDOWS_ESSENTIAL_ENV_VARS } from "../utils/env-allowlist.ts";
import { sanitizeEnvSecrets } from "../utils/env-filter.ts";
import { resolveShellForScript } from "../utils/resolve-shell.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";

/** Default timeout for post-check scripts (5 minutes). */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Environment variable name for the post-check script path. */
const POST_CHECK_SCRIPT_ENV = "PI_CREW_POST_CHECK_SCRIPT";

/**
 * Configuration for a post-task check.
 */
export interface PostCheckConfig {
	/** Path to the shell script to execute. */
	scriptPath: string;
	/** Timeout in milliseconds. Defaults to 300000 (5 minutes). */
	timeoutMs: number;
}

/**
 * Result of running a post-task check.
 */
export interface PostCheckResult {
	/** Whether the check passed (exit code 0). */
	passed: boolean;
	/** Combined stdout + stderr from the script. */
	output: string;
	/** Wall-clock duration of the check in milliseconds. */
	durationMs: number;
	/** Whether the check timed out. */
	timedOut: boolean;
}

/**
 * Resolve the effective post-check script path.
 * Prefers config.scriptPath; falls back to the PI_CREW_POST_CHECK_SCRIPT env var.
 */
function resolveScriptPath(config: PostCheckConfig): string | undefined {
	if (config.scriptPath && config.scriptPath.length > 0) {
		return config.scriptPath;
	}
	return process.env[POST_CHECK_SCRIPT_ENV];
}

/**
 * Run a post-task backpressure check script.
 *
 * Executes the configured bash script and returns a structured result.
 * If no script path is available (neither config nor env var), the check
 * passes by default with a note.
 *
 * **Security note:** The script path is validated to stay within `cwd`.
 * Scripts that escape the working directory are rejected.
 *
 * @param config - Post-check configuration (script path and timeout)
 * @param cwd - Working directory for script execution
 * @returns PostCheckResult with pass/fail status, output, and timing
 */
export async function runPostCheck(config: PostCheckConfig, cwd: string): Promise<PostCheckResult> {
	const scriptPath = resolveScriptPath(config);
	const timeoutMs = config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;

	if (!scriptPath) {
		return {
			passed: true,
			output: "No post-check script configured; skipping.",
			durationMs: 0,
			timedOut: false,
		};
	}

	// M-1 fix (code-review 2026-06-23): use the project's safe-path primitive instead
	// of a hand-rolled path.resolve + startsWith check. The lexical check passed a
	// symlinked cwd/scripts -> /usr/local/bin, but execFileSync followed the symlink
	// and executed a script outside the working directory. resolveRealContainedPath
	// walks ancestors with O_NOFOLLOW and re-validates after realpath, defeating
	// symlink-traversal attacks. Throws if the resolved path escapes cwd.
	resolveRealContainedPath(cwd, scriptPath);

	const startTime = Date.now();

	return new Promise<PostCheckResult>((resolve) => {
		try {
			const { command, args } = resolveShellForScript(scriptPath);
			const output = execFileSync(command, args, {
				cwd,
				timeout: timeoutMs,
				encoding: "utf-8",
				maxBuffer: 10 * 1024 * 1024, // 10 MB
				env: {
					...sanitizeEnvSecrets(process.env, {
						allowList: ["PATH", "HOME", "USER", ...WINDOWS_ESSENTIAL_ENV_VARS, "TMPDIR", "LANG", "LC_ALL", "PI_CREW_*"],
					}),
					PI_CREW_POST_CHECK: "1",
				},
			});

			const durationMs = Date.now() - startTime;
			resolve({
				passed: true,
				output: output.trim(),
				durationMs,
				timedOut: false,
			});
		} catch (error: unknown) {
			const durationMs = Date.now() - startTime;

			// Determine if this was a timeout
			// execFileSync throws with code 'ETIMEDOUT' or sets killed:true on timeout
			const isTimedOut =
				Boolean((error as NodeJS.ErrnoException & { killed?: boolean }).killed) ||
				(error as NodeJS.ErrnoException).code === "ETIMEDOUT";

			let output = "";
			if (error instanceof Error) {
				const execError = error as NodeJS.ErrnoException & {
					stdout?: string;
					stderr?: string;
				};
				output = [execError.stdout ?? "", execError.stderr ?? "", execError.message ?? ""].join("\n").trim();
			} else {
				output = String(error);
			}

			resolve({
				passed: false,
				output,
				durationMs,
				timedOut: isTimedOut,
			});
		}
	});
}
