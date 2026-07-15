import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agent-config.ts";
import { DEFAULT_CHILD_PI } from "../config/defaults.ts";
import { registerChildProcess, unregisterChildProcess } from "../extension/crew-cleanup.ts";
import type { WorkerExitStatus } from "../state/types.ts";
import { WINDOWS_ESSENTIAL_ENV_VARS } from "../utils/env-allowlist.ts";
import { buildScopedAllowList, getExtraEnvAllowlist, sanitizeEnvSecrets } from "../utils/env-filter.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { redactJsonLine, redactSecretString } from "../utils/redaction.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import { applyCompactPipeline } from "./compact-pipeline.ts";
import { TailCaptureStage, TruncationStage } from "./compact-stages/index.ts";
import { classifyProcessCrash } from "./crash-classification.ts";
import { buildPiWorkerArgs, checkCrewDepth, cleanupTempDir } from "./pi-args.ts";
import { extractText } from "./pi-json-output.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { attachPostExitStdioGuard, trySignalChild } from "./post-exit-stdio-guard.ts";

const POST_EXIT_STDIO_GUARD_MS = DEFAULT_CHILD_PI.postExitStdioGuardMs;
const FINAL_DRAIN_MS = DEFAULT_CHILD_PI.finalDrainMs;
const HARD_KILL_MS = DEFAULT_CHILD_PI.hardKillMs;
const RESPONSE_TIMEOUT_MS = DEFAULT_CHILD_PI.responseTimeoutMs;
const MAX_CAPTURE_BYTES = DEFAULT_CHILD_PI.maxCaptureBytes;
const MAX_ASSISTANT_TEXT_CHARS = DEFAULT_CHILD_PI.maxAssistantTextChars;
const MAX_TOOL_RESULT_CHARS = DEFAULT_CHILD_PI.maxToolResultChars;
const MAX_TOOL_INPUT_CHARS = DEFAULT_CHILD_PI.maxToolInputChars;
const MAX_COMPACT_CONTENT_CHARS = DEFAULT_CHILD_PI.maxCompactContentChars;
const activeChildProcesses = new Map<number, ChildProcess>();
const childHardKillTimers = new Map<number, NodeJS.Timeout>();

// Periodic cleanup of dead child process entries to prevent memory leaks.
// If a child process never emits exit/close (zombie), the entry would leak.
setInterval(() => {
	for (const [pid, child] of activeChildProcesses) {
		try {
			process.kill(pid, 0); // Throws ESRCH if dead
		} catch {
			activeChildProcesses.delete(pid);
		}
	}
}, 60_000).unref();

/**
 * SEC-1: Extract a redacted stderr/stdout excerpt for embedding in lifecycle
 * events and error messages. The in-memory stdout/stderr accumulators receive
 * RAW worker output (only structurally compacted via compactChildPiEvent —
 * NOT secret-redacted), so any slice embedded into a persisted event must be
 * redacted here. Otherwise worker-emitted secrets (API keys, tokens returned
 * from a tool call) leak through diagnostic logs that bypass artifact-store
 * redaction.
 *
 * Extracted as a single helper (8 call sites were duplicating this) so the
 * redaction boundary is unit-testable directly. The real spawn error/timeout
 * paths are integration-level and NOT reachable via PI_TEAMS_MOCK_CHILD_PI
 * (the mock returns before the lifecycle-event handlers run), so a behavior
 * test must target this helper rather than the full runChildPi path.
 */
export function redactStderrExcerpt(stderr: string, maxChars: number): string {
	return redactSecretString(stderr.slice(-maxChars));
}

function appendBoundedTail(current: string, chunk: string, maxBytes = MAX_CAPTURE_BYTES): string {
	// Sprint 5: refactored onto TailCaptureStage (P0-A stage-chain). The marker
	// embeds the cap size in KiB so the caller sees how much was dropped. Stage
	// construction per call is cheap (4 fields) and avoids caching concerns.
	return new TailCaptureStage({
		maxBytes,
		marker: `[pi-crew captured output truncated to last ${Math.round(maxBytes / 1024)} KiB]`,
	}).apply(current + chunk);
}

function clearHardKillTimer(pid: number | undefined): void {
	if (!pid) return;
	const timer = childHardKillTimers.get(pid);
	if (!timer) return;
	clearTimeout(timer);
	childHardKillTimers.delete(pid);
}

/**
 * B6: spawn taskkill and attach an 'error' listener. spawn() emits ENOENT/EACCES
 * asynchronously via the 'error' event (not as a throw), so an unlistened spawn
 * can crash the parent as an uncaught exception. taskkill is a standard Windows
 * binary so this is defensive, but the listener keeps failures bounded.
 */
function spawnTaskkillSafe(pid: number): void {
	const taskkillChild = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
		stdio: "ignore",
		windowsHide: true,
	});
	taskkillChild.on("error", (err) => {
		logInternalError("child-pi.taskkill-spawn-error", err instanceof Error ? err : new Error(String(err)), `pid=${pid}`);
	});
}

export function killProcessPid(pid: number): void {
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		if (process.platform === "win32") {
			// 3.8: Windows path uses taskkill /T /F (force kill the entire tree).
			// taskkill itself can silently fail (PID gone, permission denied, etc.)
			// so verify after 2s and log a warning if the process is still alive.
			spawnTaskkillSafe(pid);
			const verifyTimer = setTimeout(() => {
				try {
					process.kill(pid, 0); // throws ESRCH when dead
					// Still alive — log and retry once.
					logInternalError(
						"child-pi.taskkill-stuck",
						new Error(`process ${pid} still alive 2s after taskkill /T /F; retrying`),
						`pid=${pid}`,
						"error",
					);
					try {
						spawnTaskkillSafe(pid);
					} catch {
						/* best-effort */
					}
				} catch {
					// ESRCH or EPERM — process is gone. OK.
				}
			}, 2000);
			verifyTimer.unref();
			return;
		}
		try {
			process.kill(-pid, "SIGTERM");
		} catch (error) {
			logInternalError("child-pi.sigterm", error, `pid=${pid}`);
			try {
				process.kill(pid, "SIGTERM");
			} catch (fallbackError) {
				logInternalError("child-pi.sigterm-absolute", fallbackError, `pid=${pid}`);
			}
		}
		clearHardKillTimer(pid);
		const hardKillTimer = setTimeout(() => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch (error) {
				logInternalError("child-pi.sigkill", error, `pid=${pid}`);
				try {
					process.kill(pid, "SIGKILL");
				} catch (fallbackError) {
					logInternalError("child-pi.sigkill-absolute", fallbackError, `pid=${pid}`);
				}
			}
			childHardKillTimers.delete(pid);
		}, HARD_KILL_MS);
		hardKillTimer.unref();
		childHardKillTimers.set(pid, hardKillTimer);
	} catch (error) {
		logInternalError("child-pi.kill-process-pid", error, `pid=${pid}`);
	}
}

function killProcessTree(pid: number | undefined, child?: ChildProcess): void {
	// Phase-0 diagnostic (HB-003a): capture who invoked killProcessTree so the
	// exit-null race has a provenance trail. .stack is best-effort (may be undefined
	// under deep async), so we take a snapshot lazily.
	try {
		const callerStack = new Error("killProcessTree caller").stack ?? "(no stack)";
		logInternalError(
			"child-pi.kill-process-tree-invoked",
			new Error(`pid=${pid} called from:\n${callerStack.split("\n").slice(0, 8).join("\n")}`),
			`pid=${pid}`,
		);
	} catch {
		/* diagnostic best-effort */
	}
	if (!pid || !Number.isInteger(pid) || pid <= 0) return;
	if (child && child.exitCode !== null) return;
	killProcessPid(pid);
	child?.once("exit", () => clearHardKillTimer(pid));
}

export function terminateActiveChildPiProcesses(): number {
	const entries = [...activeChildProcesses.entries()];
	for (const [pid, child] of entries) killProcessTree(pid, child);
	return entries.length;
}

/** Structured lifecycle event emitted by child-pi for critical transitions. */
export interface ChildPiLifecycleEvent {
	/** Event discriminator. */
	type: "spawned" | "spawn_error" | "response_timeout" | "final_drain" | "hard_kill" | "exit" | "close";
	/** Process ID when available. */
	pid?: number;
	/** Exit code for exit/close events. */
	exitCode?: number | null;
	/** Error message for error events. */
	error?: string;
	/** Stderr captured at timeout moment (for response_timeout events). */
	stderr?: string;
	/** Last N chars of stderr for error context (exit/error events). */
	stderrExcerpt?: string;
	/** Timestamp (ISO). */
	ts: string;
	/** F12: optional cause for `final_drain` events. `"stdout-quiet"` indicates
	 *  the drain was triggered by the quiet-window early-exit rather than the
	 *  default 5 s ceiling. Other drain reasons (default) leave this undefined. */
	reason?: "stdout-quiet";
	/** Phase-0 diagnostic (HB-003a): the signal that killed the child (when
	 *  available). Was previously discarded after building the error string. */
	signal?: string;
	/** Phase-0 diagnostic (HB-003a): final-drain race timing, present only on
	 *  exit events where a drain timer was armed. Surfaces the exit-null race. */
	diagnostic?: {
		finalDrainArmed: boolean;
		forcedFinalDrain: boolean;
		finalDrainFiredMonotonicMs?: number;
		finalAssistantEventMonotonicMs?: number;
		exitMonotonicMs: number;
	};
}

export interface ChildPiRunInput {
	cwd: string;
	task: string;
	agent: AgentConfig;
	model?: string;
	skillPaths?: string[];
	signal?: AbortSignal;
	transcriptPath?: string;
	onStdoutLine?: (line: string) => void;
	onJsonEvent?: (event: unknown) => void;
	onSpawn?: (pid: number) => void;
	/** Structured lifecycle events for durable logging (spawn, crash, timeout, kill, exit). */
	onLifecycleEvent?: (event: ChildPiLifecycleEvent) => void;
	maxDepth?: number;
	finalDrainMs?: number;
	/** F12: early-exit the drain when stdout has been silent for this many ms
	 *  after the final assistant event. Set to ≥ finalDrainMs to disable. */
	finalDrainQuietMs?: number;
	hardKillMs?: number;
	responseTimeoutMs?: number;
	/** Soft limit on assistant turns — inject steer at this count. */
	maxTurns?: number;
	/** Extra turns after soft limit before hard abort. Default: 5. */
	graceTurns?: number;
	/** Parent conversation context to inherit when inheritContext is true. */
	parentContext?: string;
	/** When true, prepend parentContext to the task prompt. */
	inheritContext?: boolean;
	/** Pass to pi to mark certain commands as context-excluded. Default: false */
	excludeContextBash?: boolean;
	/** pi session ID for session naming (aligns with pi-crew run ID) */
	sessionId?: string;
	/** Path to steering JSONL file for real-time steer injection. */
	steeringFile?: string;
	/** Run ID for cleanup tracking */
	runId?: string;
	/** Agent ID for cleanup tracking */
	agentId?: string;
	/** Role for tool restrictions (from role-tools.ts) */
	role?: string;
	/** Root directory for artifacts (used to validate transcriptPath). */
	artifactsRoot?: string;
}

export interface ChildPiRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
	/** RAW (uncapped) final assistant text, captured at stream-parse time BEFORE
	 *  the 16K transcript compaction. This is the AUTHORITATIVE worker output —
	 *  it becomes results/<id>.txt so downstream dependencies are not bounded by
	 *  the transcript's telemetry cap. Undefined when no assistant text was seen
	 *  (mock paths, error paths) — callers MUST fall back to transcript-derived
	 *  finalText. See research-findings/output-handling-deep-dive.md §A. */
	rawFinalText?: string;
	exitStatus?: WorkerExitStatus;
	/** True if the agent was hard-aborted (max_turns + grace exceeded). */
	aborted?: boolean;
	/** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
	steered?: boolean;
	/** #7 hardening: bounded digest of intermediate findings (last N tool results or
	 *  assistant text lines) from the run. Populated by ChildPiLineObserver so that
	 *  workers that exhaust their budget on tool calls (never emit final assistant
	 *  text) still produce a non-empty result. Consumers should prefer rawFinalText
	 *  first — this is a last-resort fallback. */
	intermediateFindings?: string;
}

// Base allowlist of non-provider env vars always passed to child workers.
// Provider API keys are injected dynamically via buildScopedAllowList() only
// when a model is assigned to the task (per-task key scoping).
const BASE_ALLOWLIST: string[] = [
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
	"NODE_DISABLE_COLORS",
	"NODE_EXTRA_CA_CERTS",
	"NPM_CONFIG_REGISTRY",
	"NPM_CONFIG_USERCONFIG",
	"NPM_CONFIG_GLOBALCONFIG",
	"PI_CREW_DEPTH",
	"PI_CREW_MAX_DEPTH",
	"PI_CREW_INHERIT_PROJECT_CONTEXT",
	"PI_CREW_INHERIT_SKILLS",
	"PI_CREW_KIND",
	"PI_CREW_PARENT_PID",
	"PI_TEAMS_DEPTH",
	"PI_TEAMS_MAX_DEPTH",
	"PI_TEAMS_INHERIT_PROJECT_CONTEXT",
	"PI_TEAMS_INHERIT_SKILLS",
	"PI_TEAMS_PI_BIN",
	"PI_TEAMS_MOCK_CHILD_PI",
	"PI_CREW_ALLOW_MOCK",
	"PI_CREW_MAX_OUTPUT",
	"PI_CREW_STEERING_FILE",
];

export function buildChildPiSpawnOptions(cwd: string, env: NodeJS.ProcessEnv, model?: string): SpawnOptions {
	// SECURITY FIX (Issue #1): Validate cwd before passing to spawn.
	// If cwd comes from an untrusted source (user input, workspace config), a malicious cwd
	// could cause the child process to operate in an attacker-controlled directory,
	// enabling path traversal attacks, unintended file access, or exposure of sensitive paths.
	// Use realpathSync to resolve any symlinks and verify the path exists and is a directory.
	let validatedCwd: string;
	try {
		validatedCwd = fs.realpathSync(cwd);
		const stats = fs.statSync(validatedCwd);
		if (!stats.isDirectory()) {
			throw new Error(`cwd is not a directory: ${cwd}`);
		}
	} catch (error) {
		// If cwd doesn't exist (ENOENT) and isn't a security concern, fall back
		// to the lexical path. The child process will create the directory if
		// needed. Throwing would break tests/callers that pass not-yet-existing
		// paths and isn't a security issue for the env-filtering behavior this
		// function is primarily about.
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && error instanceof Error && error.message.includes("ENOENT")) {
			validatedCwd = path.resolve(cwd);
		} else {
			throw new Error(`Invalid cwd: ${cwd} — ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Filter out env vars whose keys match secret patterns to avoid leaking credentials to child processes.
	// IMPORTANT: preserve model provider API keys — they are needed by the child Pi to call the LLM.
	// Also preserve essential non-secret vars (PATH, HOME, USER, etc.) so the child process can function.
	// Bug #12 fix: essential env vars (PATH, HOME, etc.) are always preserved so child can find npm/node.
	//
	// PER-TASK KEY SCOPING: when a model is provided, only the env keys for that
	// provider are injected (via buildScopedAllowList). When no model is given,
	// only BASE_ALLOWLIST system vars pass through — no provider keys leak.
	const baseAllowList = [...BASE_ALLOWLIST, ...getExtraEnvAllowlist()];
	const allowList = model ? buildScopedAllowList(baseAllowList, [model]) : baseAllowList;
	const filteredEnv = sanitizeEnvSecrets(env, { allowList });
	// FIX: Removed delete workarounds — with explicit allowlist, these vars
	// are no longer auto-leaked. The wildcard approach was fragile.

	// SECURITY FIX (Issue #1): Validate NODE_PATH to ensure it only contains standard
	// system locations or legitimate user paths (NVM). NODE_PATH can reveal user
	// environment information and could theoretically be exploited if it contains
	// untrusted entries. Only allow paths under standard system directories
	// (/opt, /lib, /usr) or NVM paths under /home/<user>/.nvm/... which are legitimate
	// for Node.js module loading in user environments.
	if (filteredEnv.NODE_PATH) {
		const validPrefixes = ["/opt/", "/lib/", "/usr/local/", "/usr/", "/home/"];
		const validPaths = filteredEnv.NODE_PATH.split(":").filter((p) => {
			return validPrefixes.some((prefix) => p.startsWith(prefix));
		});
		if (validPaths.length > 0) {
			filteredEnv.NODE_PATH = validPaths.join(":");
		} else {
			// No standard paths found — remove NODE_PATH entirely to avoid
			// passing user-specific paths that could reveal environment info.
			delete filteredEnv.NODE_PATH;
		}
	}

	return {
		cwd: validatedCwd,
		env: { ...filteredEnv, PI_CREW_PARENT_PID: String(process.pid) },
		stdio: ["ignore", "pipe", "pipe"], // stdin=ignore: child doesn't wait for input; task comes via CLI args
		detached: process.platform !== "win32",
		setsid: true,
		// NOTE: setsid creates a new session; the child process becomes the session leader
		// and its parent becomes that session leader (still the team-runner in the same
		// process group). PI_CREW_PARENT_PID is set before spawn using process.pid (team-runner).
		// The parent-guard in the child checks direct parent liveness via process.kill(pid, 0) —
		// it does NOT follow the lineage beyond the direct parent. If the team-runner's parent
		// (the original pi session) dies, the team-runner becomes an orphan but the child still
		// sees its direct parent (team-runner) as alive. This is correct for the parent-guard model.
		windowsHide: true,
	} as SpawnOptions;
}

function appendTranscript(input: ChildPiRunInput, line: string): void {
	if (!input.transcriptPath) return;
	// SECURITY FIX (Issue #1): Validate transcriptPath against artifactsRoot to prevent
	// arbitrary file writes and symlink traversal attacks. An attacker who can influence
	// the task graph could set transcriptPath to /etc/passwd or similar, and mkdirSync
	// with recursive:true would create parent directories. Additionally, appendFileSync
	// follows symlinks, potentially writing to sensitive files.
	let safePath: string;
	try {
		const artifactsRoot = input.artifactsRoot ?? input.cwd;
		safePath = resolveRealContainedPath(artifactsRoot, input.transcriptPath);
	} catch (error) {
		logInternalError("child-pi.transcript-path-rejected", error as Error, `transcriptPath=${input.transcriptPath}`);
		return;
	}
	// Use O_NOFOLLOW | O_CREAT | O_APPEND to safely open the transcript file.
	// O_NOFOLLOW prevents symlink attacks (refuses to follow symlinks).
	// O_CREAT creates the file if it doesn't exist.
	// O_APPEND atomically positions at end for each write (no seek race).
	// O_EXCL was previously used but prevented appending to existing files,
	// causing EBADF on subsequent writes.
	// NOTE: Parent directory must already exist (caller's responsibility).
	// We skip mkdirSync here for security — adding it would create parent
	// directories during validation, contradicting the original design where
	// resolveRealContainedPath validates a pre-existing path.
	// Async optimization: use fire-and-forget async write to avoid blocking the event loop.
	// The caller does not need to await this — transcript writes are best-effort telemetry.
	// OPT-06 follow-up: we still track the write promise in a module-scoped Set so
	// lifecycle boundaries (ChildPiLineObserver.flush, runChildPi settle) can drain
	// them before returning. Without that drain, callers that immediately read the
	// transcript file post-flush (e.g. integration tests at phase3-runtime:50 and
	// phase4-runtime:37/:68/:103) would see ENOENT or empty content because the
	// async file handle had not yet been opened / flushed.
	trackTranscriptWrite(safePath, line);
}

/** Async version of appendTranscript — fire-and-forget for non-blocking writes. */
async function appendTranscriptAsync(safePath: string, line: string): Promise<void> {
	const content = `${redactJsonLine(line)}\n`;
	try {
		// Use async file handle for better performance when many writes occur.
		// O_NOFOLLOW | O_CREAT | O_APPEND ensures security and atomicity.
		const fd = await fs.promises.open(
			safePath,
			fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CREAT | fs.constants.O_APPEND,
			0o600,
		);
		try {
			await fd.write(content, undefined, "utf-8");
		} finally {
			await fd.close();
		}
	} catch (error) {
		logInternalError("child-pi.transcript-write-failed", error as Error, `path=${safePath}`);
	}
}

/**
 * Module-scoped set of in-flight transcript-write promises. Each call to
 * {@link trackTranscriptWrite} registers its promise here; the promise
 * removes itself on completion via `.finally`. Lifecycle boundaries
 * (ChildPiLineObserver.flush, runChildPi settle) call
 * {@link flushPendingTranscriptWrites} before returning so callers that
 * immediately read the transcript file after `runChildPi` / `observer.flush()`
 * await see the full content (and a non-ENOENT file).
 *
 * Module-scoped rather than per-input because all transcript writes for a
 * given run share the same Node fs event loop and serialise through a single
 * fs handle per path; one drain per lifecycle boundary is sufficient.
 */
const pendingTranscriptWrites: Set<Promise<void>> = new Set();

function trackTranscriptWrite(safePath: string, line: string): void {
	const p = appendTranscriptAsync(safePath, line).finally(() => {
		pendingTranscriptWrites.delete(p);
	});
	pendingTranscriptWrites.add(p);
}

/**
 * Drain all currently-pending transcript writes. Awaits every promise in the
 * set; if new writes are scheduled during the drain (i.e. the `.finally`
 * callback has not yet removed them), the loop re-checks `size > 0` and
 * awaits them too. Idempotent and safe to call concurrently / reentrantly —
 * each pending promise is tracked exactly once.
 *
 * Exported so external callers (e.g. integration tests that construct a
 * ChildPiLineObserver directly) can drain explicitly if they need to read
 * the transcript file outside of the observer's lifecycle.
 */
export async function flushPendingTranscriptWrites(): Promise<void> {
	while (pendingTranscriptWrites.size > 0) {
		const drained = [...pendingTranscriptWrites];
		await Promise.allSettled(drained);
	}
}

export function compactString(value: string, maxChars = MAX_COMPACT_CONTENT_CHARS, opts: { preserveImportant?: boolean } = {}): string {
	if (value.length <= maxChars) return value;
	// L4: head + tail instead of head-only. Keeps closing markdown structure
	// (code fences, headings, list tails) instead of dropping them — the old
	// head-only slice left unclosed ``` fences that downstream parsers and
	// output-validator.ts flagged as "output may be truncated". Head gets 75%
	// (opening structure + bulk of content); tail gets 25% (closing structure).
	// P0-A: compose the value through the stage-chain compression pipeline.
	// The default pipeline is just [TruncationStage] (single-stage, equivalent
	// to the pre-P0-A implementation) so plain text with no ANSI / no blank
	// runs / no consecutive duplicates produces bit-identical output (L4
	// regression safety). Callers that want noise stripping can opt into
	// additional stages via the pipeline — but compactString's caller surface
	// keeps the simple `(value, maxChars, opts)` signature.
	// P0-B: the TruncationStage scans the middle slice for important diagnostic
	// lines (error, file:line, HTTP 4xx/5xx, compiler codes) and preserves them
	// within a 15% slack budget. The `preserveImportant` opt propagates here.
	const result = applyCompactPipeline(value, [
		new TruncationStage(maxChars, {
			preserveImportant: opts.preserveImportant,
		}),
	]);
	return result.text;
}

export function compactValue(value: unknown): unknown {
	if (typeof value === "string") return compactString(value);
	if (Array.isArray(value)) {
		// BUG-4: silent .slice(0, 20) lost items 21-50 with no marker.
		// Append a truncation marker when entries are dropped so downstream
		// consumers know data was elided (consistent with compactString style).
		if (value.length > 20) {
			return [...value.slice(0, 20).map(compactValue), `[pi-crew truncated ${value.length - 20} entries]`];
		}
		return value.map(compactValue);
	}
	const record = asRecord(value);
	if (!record) return value;
	const entries = Object.entries(record);
	const compacted: Record<string, unknown> = {};
	for (const [key, entry] of entries.slice(0, 20)) compacted[key] = compactValue(entry);
	// BUG-4: mark elided object keys so consumers know data was dropped.
	if (entries.length > 20) compacted["[truncated]"] = `${entries.length - 20} entries`;
	return compacted;
}

function compactContentPart(part: unknown): unknown | undefined {
	const record = asRecord(part);
	if (!record) return undefined;
	if (record.type === "text")
		return {
			type: "text",
			text:
				typeof record.text === "string"
					? compactString(record.text, MAX_ASSISTANT_TEXT_CHARS, {
							preserveImportant: false,
						})
					: "",
		};
	if (record.type === "toolCall")
		return {
			type: "toolCall",
			name: record.name,
			input: compactValue(typeof record.input === "string" ? compactString(record.input, MAX_TOOL_INPUT_CHARS) : record.input),
		};
	if (record.type === "toolResult")
		return {
			type: "toolResult",
			name: record.name,
			content: compactValue(
				typeof record.content === "string" ? compactString(record.content, MAX_TOOL_RESULT_CHARS) : record.content,
			),
		};
	return undefined;
}

function compactChildPiEvent(event: unknown): unknown | undefined {
	const record = asRecord(event);
	if (!record) return undefined;
	if (record.type === "message_update") return undefined;
	if (record.type === "tool_execution_start" || record.type === "tool_execution_end") {
		return {
			type: record.type,
			toolName: record.toolName,
			args: record.args,
		};
	}
	if (record.type === "tool_result_end" || record.type === "message_end" || record.type === "message") {
		const message = asRecord(record.message);
		if (message?.role === "user" || message?.role === "system") return undefined;
		const content = Array.isArray(message?.content)
			? message.content.map(compactContentPart).filter((part) => part !== undefined)
			: undefined;
		return {
			type: record.type,
			...(typeof record.text === "string" ? { text: record.text } : {}),
			...(message
				? {
						message: {
							role: message.role,
							...(content ? { content } : {}),
							usage: message.usage,
							model: message.model,
							errorMessage: message.errorMessage,
							stopReason: message.stopReason,
						},
					}
				: {}),
			usage: record.usage,
			model: record.model,
			provider: record.provider,
			stopReason: record.stopReason,
		};
	}
	return record.type ? { type: record.type } : undefined;
}

function displayTextFromCompactEvent(event: unknown): string | undefined {
	const record = asRecord(event);
	if (!record) return undefined;
	if (record.type === "tool_execution_start") {
		return typeof record.toolName === "string" ? `tool: ${record.toolName}` : "tool started";
	}
	if (record.type !== "message" && record.type !== "message_end") return undefined;
	const message = asRecord(record.message);
	if (message?.role !== undefined && message.role !== "assistant") return undefined;
	const content = Array.isArray(message?.content) ? message.content : [];
	const text = content
		.flatMap((part) => {
			const item = asRecord(part);
			return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
		})
		.join("\n")
		.trim();
	return text || (typeof record.text === "string" ? record.text : undefined);
}

function compactChildPiLine(line: string): {
	persistedLine: string;
	event?: unknown;
	displayLine?: string;
	json: boolean;
} {
	try {
		const parsed = JSON.parse(line);
		const compact = compactChildPiEvent(parsed);
		return {
			json: true,
			event: compact,
			persistedLine: compact ? JSON.stringify(compact) : "",
			displayLine: displayTextFromCompactEvent(compact),
		};
	} catch {
		return { json: false, persistedLine: line, displayLine: line };
	}
}

export class ChildPiLineObserver {
	private buffer = "";
	private readonly input: ChildPiRunInput;
	/** F9: bounded ring buffer for RAW assistant-text fragments. Consumers
	 * (getRawFinalText) only read the last element, but the legacy implementation
	 * accumulated every fragment unconditionally, which let a verbose/long-running
	 * worker grow this array linearly with output. We retain the last 2 entries:
	 * the consumer needs the last; we keep the second-to-last only as a defensive
	 * fence against a race where a final event arrives just after the consumer
	 * read (the previous "last" is still the most-recent pre-final text in that
	 * window). 2 is well below any plausible consumer's "tail-only" need while
	 * bounding memory. */
	private static readonly MAX_RAW_TEXT_EVENTS = 2;
	private readonly rawTextEvents: string[] = [];
	/** F9: bounded ring buffer for intermediate findings. The downstream digest
	 * (getIntermediateFindings) slices the last 20, but the array previously grew
	 * to 1000s of entries. We keep MAX_INTERMEDIATE_DIGEST_LINES + headroom so
	 * the public API behaviour is preserved (still returns "last 20 lines"). */
	private static readonly MAX_INTERMEDIATE_FINDINGS = 32;
	private readonly intermediateFindings: string[] = [];

	constructor(input: ChildPiRunInput) {
		this.input = input;
	}

	observe(text: string): void {
		this.buffer += text;
		const lines = this.buffer.split(/\r?\n/);
		this.buffer = lines.pop() ?? "";
		for (const line of lines) this.emitLine(line);
	}

	flush(): Promise<void> {
		if (this.buffer) {
			const line = this.buffer;
			this.buffer = "";
			this.emitLine(line);
		}
		// OPT-06 follow-up: appendTranscript is fire-and-forget async, so the file
		// may not exist on disk by the time this returns. Drain the module-scoped
		// pending-write set before resolving so callers that immediately read the
		// transcript file (e.g. integration tests at phase4-runtime:37/:68/:103
		// after `await observer.flush()`) see the full content.
		return flushPendingTranscriptWrites();
	}

	/** Last non-empty RAW assistant text (mirrors {@link parsePiJsonOutput}'s
	 *  finalText semantics but uncapped). Undefined when no assistant text was
	 *  seen by this observer. {@link extractText} already drops empty fragments,
	 *  so the last entry is the final assistant utterance. */
	getRawFinalText(): string | undefined {
		return this.rawTextEvents.length > 0 ? this.rawTextEvents[this.rawTextEvents.length - 1] : undefined;
	}

	/** #7 hardening: returns a bounded digest of intermediate findings accumulated
	 *  during the run. This is NOT the final answer — it is a best-effort capture
	 *  of the last assistant text or tool-result display lines before budget
	 *  exhaustion. Only populated when getRawFinalText() would return undefined.
	 *  @param maxChars - maximum total characters to return (default 500). */
	getIntermediateFindings(maxChars = 500): string {
		const MAX_INTERMEDIATE_DIGEST_LINES = 20;
		if (this.intermediateFindings.length === 0) return "";
		// Take the last N lines and join, then cap.
		const lines = this.intermediateFindings.slice(-MAX_INTERMEDIATE_DIGEST_LINES);
		const joined = lines.join("\n");
		if (joined.length <= maxChars) return joined;
		// Return the tail within the budget.
		return joined.slice(-maxChars);
	}

	private emitLine(line: string): void {
		if (!line.trim()) return;
		// Parse the RAW line once so we can BOTH compact it (telemetry transcript,
		// 16K-capped memory bound) AND capture the uncapped assistant text for the
		// authoritative result. Non-JSON lines contribute no assistant text.
		try {
			const rawParsed = JSON.parse(line);
			const rawTexts = extractText(rawParsed);
			if (rawTexts.length > 0) {
				// F9: trim from the front if the push would exceed the cap. Slice's
				// second arg excludes the index, so this drops the oldest entries
				// while keeping the freshly pushed tail.
				this.rawTextEvents.push(...rawTexts);
				const rawOverflow = this.rawTextEvents.length - ChildPiLineObserver.MAX_RAW_TEXT_EVENTS;
				if (rawOverflow > 0) this.rawTextEvents.splice(0, rawOverflow);
				// Also capture raw assistant text as intermediate findings — the last raw
				// text may be a partial answer before the worker ran out of budget.
				const last = rawTexts[rawTexts.length - 1];
				if (last.trim().length > 0) {
					this.intermediateFindings.push(last.trim());
					const findingsOverflow = this.intermediateFindings.length - ChildPiLineObserver.MAX_INTERMEDIATE_FINDINGS;
					if (findingsOverflow > 0) this.intermediateFindings.splice(0, findingsOverflow);
				}
			}
		} catch {
			// Not valid JSON — compactChildPiLine handles the raw-text fallback below.
		}
		const compact = compactChildPiLine(line);
		if (compact.event !== undefined) {
			try {
				this.input.onJsonEvent?.(compact.event);
			} catch (error) {
				logInternalError("child-pi.on-json-event", error, `line=${compact.persistedLine ?? compact.displayLine ?? ""}`);
			}
		}
		if (compact.persistedLine) appendTranscript(this.input, compact.persistedLine);
		if (compact.displayLine?.trim()) {
			try {
				this.input.onStdoutLine?.(compact.displayLine);
			} catch (error) {
				logInternalError("child-pi.on-stdout-line", error, `line=${compact.displayLine}`);
			}
			// #7 hardening: capture display lines (tool results, stdout) as intermediate
			// findings. This ensures we capture tool output even when no assistant text
			// is emitted (budget exhausted on tool calls).
			this.intermediateFindings.push(compact.displayLine!.trim());
			const findingsOverflow = this.intermediateFindings.length - ChildPiLineObserver.MAX_INTERMEDIATE_FINDINGS;
			if (findingsOverflow > 0) this.intermediateFindings.splice(0, findingsOverflow);
		}
	}
}

/** Mock-only path — real code path reuses a single observer.
 *  OPT-06 follow-up: returns a Promise so callers can await the transcript
 *  drain before resolving runChildPi. Without this, mock-mode callers that
 *  read the transcript file post-run see ENOENT (the async file handle had
 *  not yet been opened). */
async function observeStdoutChunk(input: ChildPiRunInput, text: string): Promise<void> {
	const observer = new ChildPiLineObserver(input);
	observer.observe(text);
	await observer.flush();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isFinalAssistantEvent(event: unknown): boolean {
	const obj = asRecord(event);
	if (!obj || obj.type !== "message_end") return false;
	const message = asRecord(obj.message);
	const role = message?.role;
	if (role !== undefined && role !== "assistant") return false;
	const stopReason =
		typeof message?.stopReason === "string" ? message.stopReason : typeof obj.stopReason === "string" ? obj.stopReason : undefined;
	if (stopReason !== undefined && stopReason !== "stop") return false;
	const content = Array.isArray(message?.content) ? message.content : [];
	return !content.some((part) => asRecord(part)?.type === "toolCall");
}

export async function runChildPi(input: ChildPiRunInput): Promise<ChildPiRunResult> {
	// Phase 1 (live-session parity): prepend parent context when inheritContext is true.
	// This mirrors the effectivePrompt logic in live-session-runtime.ts so that
	// child-process workers receive the same inherited-context treatment.
	const effectiveTask =
		input.inheritContext === true && input.parentContext
			? `${input.parentContext}\n\n---\n# Child Worker Task\n${input.task}`
			: input.task;
	const depth = checkCrewDepth(input.maxDepth);
	if (depth.blocked)
		return {
			exitCode: 1,
			stdout: "",
			stderr: `pi-crew depth guard blocked child worker: depth ${depth.depth} >= max ${depth.maxDepth}`,
		};
	const mock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	if (mock) {
		// SECURITY (Issue #2): Mock mode security model is intentionally asymmetric.
		// PI_TEAMS_MOCK_CHILD_PI is in the allowlist (passed to children) but
		// PI_CREW_ALLOW_MOCK is NOT in the allowlist — it is only checked in the
		// parent process scope. This means:
		//   (1) If an attacker sets PI_CREW_ALLOW_MOCK in the parent's environment,
		//       it will NOT be passed to child processes (safe).
		//   (2) Mock mode activation in the child always fails the PI_CREW_ALLOW_MOCK
		//       check, so mock mode can only be triggered from the parent process.
		// This asymmetry is intentional: PI_CREW_ALLOW_MOCK must be set in the Pi root
		// process (the entry point that spawns children), not inherited from a parent.
		// Setup hooks cannot inject PI_CREW_ALLOW_MOCK into the parent's env.
		const allowMock = process.env.PI_CREW_ALLOW_MOCK === "1" || process.env.PI_CREW_ALLOW_MOCK === "true";
		if (!allowMock) {
			return {
				exitCode: 1,
				stdout: "",
				stderr: "Mock mode requires PI_CREW_ALLOW_MOCK=1",
			};
		}
		// SECURITY: Log mock mode activation prominently for audit trail
		logInternalError("child-pi.mock", new Error(`Mock mode active: ${mock}`), "NOT running real agents");
		if (mock === "success") {
			const stdout = `[MOCK] Success for ${input.agent.name}\n`;
			await observeStdoutChunk(input, stdout);
			return { exitCode: 0, stdout, stderr: "" };
		}
		if (mock === "json-success" || mock === "adaptive-plan") {
			const text =
				mock === "adaptive-plan" && effectiveTask.includes("ADAPTIVE_PLAN_JSON_START")
					? `[MOCK] Adaptive plan\nADAPTIVE_PLAN_JSON_START\n${JSON.stringify({
							phases: [
								{
									name: "research",
									tasks: [
										{
											role: "explorer",
											task: "Explore adaptive target",
										},
										{
											role: "analyst",
											task: "Analyze adaptive target",
										},
										{
											role: "planner",
											task: "Plan adaptive target",
										},
									],
								},
								{
									name: "build",
									tasks: [
										{
											role: "executor",
											task: "Implement adaptive target",
										},
									],
								},
								{
									name: "check",
									tasks: [
										{
											role: "reviewer",
											task: "Review adaptive target",
										},
										{
											role: "test-engineer",
											task: "Test adaptive target",
										},
										{
											role: "writer",
											task: "Summarize adaptive target",
										},
									],
								},
							],
						})}\nADAPTIVE_PLAN_JSON_END`
					: `[MOCK] JSON success for ${input.agent.name}`;
			const stdout = `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n${JSON.stringify({ type: "message_end", usage: { input: 10, output: 5, cost: 0.001, turns: 1 } })}\n`;
			await observeStdoutChunk(input, stdout);
			return { exitCode: 0, stdout, stderr: "" };
		}
		if (mock === "retryable-failure")
			return {
				exitCode: 1,
				stdout: "",
				stderr: "[MOCK] rate limit: mock failure",
			};
		// E2E fallback-chain fixture: invocation #1 returns a SILENT retryable
		// failure (exit code 0, no real assistant text, message_end carries a
		// retryable-pattern errorMessage). Invocation #2+ delegates to the
		// standard json-success shape. Counter lives in os.tmpdir() keyed by
		// process.pid + mock name so concurrent test processes don't collide.
		// The test cleans up the file in its finally block.
		if (mock === "retryable-failure-then-success") {
			const counterFile = path.join(os.tmpdir(), `pi-crew-mock-counter-${process.pid}-retryable-failure-then-success`);
			let count = 0;
			try {
				const raw = fs.readFileSync(counterFile, "utf-8");
				const parsed = Number.parseInt(raw.trim(), 10);
				if (Number.isFinite(parsed) && parsed >= 0) count = parsed;
			} catch {
				// file missing or unreadable — first invocation in this process
			}
			count += 1;
			try {
				fs.writeFileSync(counterFile, String(count));
			} catch (error) {
				logInternalError("child-pi.mock-counter-write", error as Error, `file=${counterFile}`);
			}
			if (count === 1) {
				// Silent retryable failure: exit 0, no real text, message_end
				// carries errorMessage matching `/provider[_ ]?error/i` so that
				// `detectRetryableModelFailureFromOutput` surfaces it as an error
				// and `isRetryableModelFailure` routes the next attempt to the
				// next candidate model. `stopReason:"error"` (NOT "stop") so
				// `isFinalAssistantEvent` does NOT prematurely terminate the run.
				const failureEvent = {
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						errorMessage: "Provider error: api_error",
						stopReason: "error",
					},
				};
				const stdout = `${JSON.stringify(failureEvent)}\n`;
				await observeStdoutChunk(input, stdout);
				return { exitCode: 0, stdout, stderr: "" };
			}
			// Subsequent invocations: delegate to json-success shape so the
			// fallback chain's second attempt succeeds and the run completes.
			const text = `[MOCK] JSON success for ${input.agent.name}`;
			const stdout = `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n${JSON.stringify({ type: "message_end", usage: { input: 10, output: 5, cost: 0.001, turns: 1 } })}\n`;
			await observeStdoutChunk(input, stdout);
			return { exitCode: 0, stdout, stderr: "" };
		}
		return { exitCode: 1, stdout: "", stderr: `[MOCK] failure: ${mock}` };
	}
	const built = buildPiWorkerArgs({
		task: effectiveTask,
		agent: input.agent,
		model: input.model,
		sessionEnabled: true,
		maxDepth: input.maxDepth,
		skillPaths: input.skillPaths,
		role: input.role,
	});
	// Pass steering file path to child for real-time steer injection
	if (input.steeringFile) built.env.PI_CREW_STEERING_FILE = input.steeringFile;
	// B5: if the parent already aborted before we spawn, do not start the child
	// at all. Spawning a doomed process wastes resources, and the abort listener
	// registered below will not re-fire for an already-aborted signal (so the
	// child would only be killed later by the response-timeout path). Return a
	// cancelled-style result immediately.
	if (input.signal?.aborted) {
		return {
			exitCode: null,
			stdout: "",
			stderr: "",
			error: "Aborted before spawn (parent AbortSignal already aborted)",
			aborted: true,
		};
	}
	const spawnSpec = getPiSpawnCommand(built.args);
	try {
		return await new Promise<ChildPiRunResult>((resolve) => {
			// SECURITY (Issue #3): built.env contains only PI_CREW_* execution-control vars (NOT secrets).
			// It is safe to spread built.env after process.env because sanitizeEnvSecrets will filter
			// any secret values before the env reaches spawn(). However, if built.env ever gains
			// secret content without corresponding allowlist filtering, secrets would leak to children.
			// This comment serves as a warning: built.env must never contain secret values.
			//
			// Runtime assertion: verify all built.env keys are execution-control vars (PI_CREW_* or PI_TEAMS_*).
			// This is a canary for future regressions — if someone accidentally adds a secret key to
			// built.env, the assertion will throw before the secret reaches the child process.
			for (const key of Object.keys(built.env)) {
				if (!key.startsWith("PI_CREW_") && !key.startsWith("PI_TEAMS_")) {
					throw new Error(
						`SECURITY: built.env contains unexpected key "${key}"; expected only PI_CREW_* or PI_TEAMS_* execution-control vars`,
					);
				}
			}
			const child = spawn(
				spawnSpec.command,
				spawnSpec.args,
				buildChildPiSpawnOptions(
					input.cwd,
					{
						...process.env,
						...built.env,
					},
					input.model,
				),
			);
			if (child.pid) {
				activeChildProcesses.set(child.pid, child);
				input.onSpawn?.(child.pid);
				input.onLifecycleEvent?.({
					type: "spawned",
					pid: child.pid,
					ts: new Date().toISOString(),
				});
				// Register with cleanup handler for graceful shutdown
				if (input.runId && input.agentId) {
					registerChildProcess(child.pid, input.runId, input.agentId);
				}
			} else {
				input.onLifecycleEvent?.({
					type: "spawn_error",
					error: "spawn returned no pid",
					ts: new Date().toISOString(),
				});
			}
			let stdout = "";
			let stderr = "";
			let settled = false;
			let childExited = false;
			let postExitGuardCleanup: (() => void) | undefined;
			let finalDrainTimer: NodeJS.Timeout | undefined;
			let hardKillTimer: NodeJS.Timeout | undefined;
			let noResponseTimer: NodeJS.Timeout | undefined;
			const finalDrainMs = input.finalDrainMs ?? FINAL_DRAIN_MS;
			const hardKillMs = input.hardKillMs ?? HARD_KILL_MS;
			// Phase-0 diagnostic (HB-003a): track the final-drain race that produces
			// `exit null` for ctx.agent({disableTools:true}). These vars are READ-ONLY
			// instrumentation — no behavior change. finalDrainArmed lets the close
			// handler know a drain timer existed even after clearFinalDrainTimers() ran;
			// spawnMonotonicMs gives us relative timing to distinguish a race from a crash.
			let finalDrainArmed = false;
			// F12: monotonic timestamp of the last stdout JSON event (any event —
			// we want to know when stdout *stopped*, not when the final assistant
			// event arrived). Updated on every onJsonEvent dispatch.
			let lastStdoutActivityMonotonicMs = performance.now();
			let finalDrainFiredMonotonicMs: number | undefined;
			const spawnMonotonicMs = performance.now();
			let finalAssistantEventMonotonicMs: number | undefined;
			// FIX (Round 14): Bound the env-controlled response timeout to
			// [1_000ms, 3_600_000ms] (1s–1h) so a hostile or accidental value
			// (e.g. 1, or 999_999_999) cannot disable the timeout or cause
			// instant kills. Out-of-range values fall back to the input or
			// built-in default.
			const RESPONSE_TIMEOUT_MIN_MS = 1_000;
			const RESPONSE_TIMEOUT_MAX_MS = 3_600_000;
			const responseTimeoutEnv = Number.parseInt(process.env.PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS ?? "", 10);
			const envInRange =
				Number.isFinite(responseTimeoutEnv) &&
				responseTimeoutEnv >= RESPONSE_TIMEOUT_MIN_MS &&
				responseTimeoutEnv <= RESPONSE_TIMEOUT_MAX_MS;
			const responseTimeoutMs = envInRange ? responseTimeoutEnv : (input.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS);
			let responseTimeoutHit = false;
			let forcedFinalDrain = false;
			let abortRequested = input.signal?.aborted === true;
			let hardKilled = false;
			const cleanupErrors: string[] = [];
			let turnCount = 0;
			// Track in-flight operations for proper rejection on unexpected exit
			interface PendingOperation {
				id: string;
				type: "prompt" | "steer" | "json_event";
				startedAt: number;
			}
			const pendingOperations = new Map<string, PendingOperation>();
			let operationIdCounter = 0;

			const startOperation = (type: PendingOperation["type"]): string => {
				const id = `op-${++operationIdCounter}`;
				pendingOperations.set(id, { id, type, startedAt: Date.now() });
				return id;
			};

			const completeOperation = (id: string): void => {
				pendingOperations.delete(id);
			};

			const rejectPendingOperations = (error: Error): void => {
				pendingOperations.forEach((op, id) => {
					logInternalError(
						"child-pi.pending-operation-rejected",
						error,
						`opId=${id} type=${op.type} elapsed=${Date.now() - op.startedAt}ms`,
					);
				});
				pendingOperations.clear();
			};

			let softLimitReached = false;
			const steerInjectionFailed = false;
			const maxTurns = input.maxTurns;
			// FIX (Issue #1): Bound graceTurns to prevent the hard abort condition from
			// never triggering when an arbitrarily large value is passed.
			let graceTurns = input.graceTurns;
			if (graceTurns !== undefined && graceTurns > 1000) graceTurns = 1000;
			let abortDueToParentSignal = false;
			// Round 27 (BUG 4): extract to a named handler so settle() can remove it.
			// The previous anonymous listener was never removed → on runs with >10
			// tasks sharing one AbortSignal (background-runner), Node emitted
			// MaxListenersExceededWarning and each leaked listener pinned the task's
			// stack frame (abortDueToParentSignal closure) in memory. { once: true }
			// only auto-removes AFTER the signal fires; on normal completion it leaks.
			const onParentAbort = (): void => {
				abortDueToParentSignal = true;
			};
			input.signal?.addEventListener("abort", onParentAbort, {
				once: true,
			});
			const restartNoResponseTimer = (): void => {
				if (responseTimeoutMs <= 0) return;
				if (noResponseTimer) clearTimeout(noResponseTimer);
				noResponseTimer = setTimeout(() => {
					responseTimeoutHit = true;
					// Capture stderr at timeout moment for debugging
					// SEC-1: redact secrets before embedding in lifecycle event so
					// worker-emitted secrets (API keys etc.) don't bypass redaction.
					const timeoutStderr = redactStderrExcerpt(stderr, 1024); // Last 1KB of stderr (redacted, SEC-1)
					input.onLifecycleEvent?.({
						type: "response_timeout",
						pid: child.pid,
						error: `No output for ${responseTimeoutMs}ms`,
						ts: new Date().toISOString(),
						stderr: timeoutStderr || undefined,
					});
					killProcessTree(child.pid, child);
					try {
						child.kill(process.platform === "win32" ? undefined : "SIGTERM");
					} catch (error) {
						logInternalError("child-pi.response-timeout-term", error, `pid=${child.pid}`);
					}
					// #3 hardening: if the child never exits (zombie) and neither the
					// 'exit' nor 'close' event ever fires, the promise would hang forever.
					// SIGKILL fires ~3s after SIGTERM via hardKillTimer in killProcessPid,
					// but on platforms where SIGKILL also fails (e.g. permission issues),
					// add a bounded safety settle so the promise always resolves. Using
					// hardKillMs + 2s as the safety window: enough for SIGKILL to work
					// normally, but forces settle if the process is truly immortal.
					// NOTE: we do NOT clear hardKillTimer here (that would defeat its purpose);
					// we intentionally add a parallel safety path.
					const SAFETY_SETTLE_MS = HARD_KILL_MS + 2000;
					const safetyTimer = setTimeout(() => {
						if (settled || childExited) return;
						logInternalError(
							"child-pi.settle-safety-fired",
							new Error(`Child did not exit within ${SAFETY_SETTLE_MS}ms of kill; forcing settle`),
							`pid=${child.pid}, responseTimeoutMs=${responseTimeoutMs}`,
						);
						// Verify the child is still alive before forcing settle.
						// If it somehow exited between childExited=false and here, the
						// settled/childExited guard prevents double-settle (harmless but noisy).
						try {
							process.kill(child.pid!, 0);
							// Child still alive — force settle with timeout error.
							const timeoutErr = `Child Pi produced no new output for ${responseTimeoutMs}ms; killed but did not exit within ${SAFETY_SETTLE_MS}ms (possible zombie).`;
							void settle({
								exitCode: null,
								stdout,
								stderr,
								error: timeoutErr,
								exitStatus: {
									exitCode: null,
									cancelled: abortRequested,
									timedOut: true,
									killed: hardKilled,
									cleanupErrors,
									finalDrainMs,
									crashClass: "timeout",
								},
							});
						} catch {
							// ESRCH / EPERM — child is already gone. The 'exit'/'close' handler
							// will fire shortly (or already fired in a race). Let it settle normally.
						}
					}, SAFETY_SETTLE_MS);
					safetyTimer.unref();
				}, responseTimeoutMs);
				noResponseTimer.unref();
			};
			const clearNoResponseTimer = (): void => {
				if (noResponseTimer) clearTimeout(noResponseTimer);
				noResponseTimer = undefined;
			};
			restartNoResponseTimer();
			const lineObserver = new ChildPiLineObserver({
				...input,
				onStdoutLine: (line) => {
					restartNoResponseTimer();
					stdout = appendBoundedTail(stdout, `${line}\n`);
					input.onStdoutLine?.(line);
				},
				onJsonEvent: (event) => {
					restartNoResponseTimer();
					const eventOpId = startOperation("json_event");
					try {
						// Turn-count-based steering: soft limit steer + hard abort after graceTurns
						if (event && typeof event === "object" && !Array.isArray(event)) {
							const obj = event as Record<string, unknown>;
							if (obj.type === "turn_end") {
								turnCount += 1;
								if (maxTurns !== undefined && !softLimitReached && turnCount >= maxTurns) {
									softLimitReached = true;
									// C8: deliver the "wrap up" advisory by appending to the steering JSONL
									// file the child polls (PI_CREW_STEERING_FILE). The child is spawned with
									// stdio:["ignore",...], so child.stdin is null and the old stdin branch was
									// dead code that only spammed logs on every soft-limit hit. Advisory only —
									// the hard-abort below at maxTurns + graceTurns is the real enforcement, so
									// a failed write must NOT kill the worker.
									if (input.steeringFile) {
										try {
											fs.appendFileSync(
												input.steeringFile,
												JSON.stringify({
													type: "steer",
													message:
														"You have reached your turn limit. Wrap up immediately — provide your final answer now.",
												}) + "\n",
												"utf-8",
											);
										} catch (err) {
											logInternalError(
												"child-pi.steer-write-failed",
												err instanceof Error ? err : new Error(String(err)),
												`pid=${child.pid}`,
											);
										}
									}
								} else if (maxTurns !== undefined && softLimitReached && turnCount >= maxTurns + (graceTurns ?? 5)) {
									// Hard abort — terminate after grace turns
									try {
										child.kill(process.platform === "win32" ? undefined : "SIGTERM");
									} catch {
										/* best-effort */
									}
								}
							}
						}
						completeOperation(eventOpId);
					} catch (err) {
						completeOperation(eventOpId);
						throw err;
					}
					// F12: capture monotonic timestamp BEFORE dispatching — any stdout
					// JSON event counts as activity. This lets the quiet-window
					// detection measure "time since last byte of stdout" accurately
					// regardless of what onJsonEvent does.
					lastStdoutActivityMonotonicMs = performance.now();
					input.onJsonEvent?.(event);
					if (!isFinalAssistantEvent(event) || childExited || settled || finalDrainTimer) return;
					finalAssistantEventMonotonicMs = performance.now();
					finalDrainArmed = true; // Phase-0 diagnostic: track that a drain timer was created.
					// F12: alongside the 5 s ceiling timer, start a polling watcher
					// that fires the drain early if stdout goes quiet for `quietMs`
					// after the final assistant event. Heavy children that emit a
					// stopReason=stop message_end and then sit idle will exit in
					// ~quietMs (default 800 ms) instead of up to up to 5 s. unref() so
					// the poller never holds the event loop on shutdown.
					// NOTE: The polling watcher is NOT explicitly cleared on process exit.
					// This is safe because: (1) it's unref()'d, so it won't prevent exit;
					// (2) the `settled || childExited` guard at the top prevents firing
					// after the child has exited; (3) sending SIGTERM to an already-
					// exiting process is harmless. The `finalDrainQuietMs` config allows
					// disabling this behavior (set >= finalDrainMs, e.g., 10000).
					const quietMs = input.finalDrainQuietMs ?? DEFAULT_CHILD_PI.finalDrainQuietMs;
					if (quietMs < (input.finalDrainMs ?? DEFAULT_CHILD_PI.finalDrainMs)) {
						const pollHandle = setInterval(() => {
							if (settled || childExited) {
								clearInterval(pollHandle);
								pollHandle.unref();
								return;
							}
							const sinceLast = performance.now() - lastStdoutActivityMonotonicMs;
							if (sinceLast >= quietMs) {
								clearInterval(pollHandle);
								pollHandle.unref();
								// Trigger the same drain path as the 5 s timer:
								// mark forced, fire final_drain lifecycle, SIGTERM.
								forcedFinalDrain = true;
								finalDrainFiredMonotonicMs = performance.now();
								input.onLifecycleEvent?.({
									type: "final_drain",
									pid: child.pid,
									ts: new Date().toISOString(),
									reason: "stdout-quiet",
								});
								try {
									child.kill(process.platform === "win32" ? undefined : "SIGTERM");
								} catch (error) {
									logInternalError("child-pi.quiet-drain-term", error, `pid=${child.pid}`);
								}
								// Mark for hard kill fallback so the existing timer is
								// still reaped if it ever fires later.
								hardKillTimer = setTimeout(() => {
									if (settled || childExited) return;
									try {
										hardKilled = true;
										input.onLifecycleEvent?.({
											type: "hard_kill",
											pid: child.pid,
											ts: new Date().toISOString(),
										});
										child.kill(process.platform === "win32" ? undefined : "SIGKILL");
									} catch (error) {
										logInternalError("child-pi.quiet-drain-hard-kill", error, `pid=${child.pid}`);
									}
								}, hardKillMs);
								hardKillTimer.unref();
								// Cancel the 5 s ceiling so we don't double-fire.
								if (finalDrainTimer) {
									clearTimeout(finalDrainTimer);
									finalDrainTimer = undefined;
								}
							}
						}, 200);
						pollHandle.unref();
					}
					finalDrainTimer = setTimeout(() => {
						if (settled || childExited) return;
						forcedFinalDrain = true;
						finalDrainFiredMonotonicMs = performance.now(); // Phase-0 diagnostic: race timing.
						input.onLifecycleEvent?.({
							type: "final_drain",
							pid: child.pid,
							ts: new Date().toISOString(),
						});
						try {
							child.kill(process.platform === "win32" ? undefined : "SIGTERM");
						} catch (error) {
							logInternalError("child-pi.final-drain-term", error, `pid=${child.pid}`);
						}
						hardKillTimer = setTimeout(() => {
							if (settled || childExited) return;
							try {
								hardKilled = true;
								input.onLifecycleEvent?.({
									type: "hard_kill",
									pid: child.pid,
									ts: new Date().toISOString(),
								});
								child.kill(process.platform === "win32" ? undefined : "SIGKILL");
							} catch (error) {
								logInternalError("child-pi.final-drain-kill", error, `pid=${child.pid}`);
							}
						}, hardKillMs);
						hardKillTimer.unref();
					}, finalDrainMs);
					finalDrainTimer.unref();
				},
			});

			const clearFinalDrainTimers = (): void => {
				if (finalDrainTimer) clearTimeout(finalDrainTimer);
				if (hardKillTimer) clearTimeout(hardKillTimer);
				finalDrainTimer = undefined;
				hardKillTimer = undefined;
			};
			const clearPostExitGuard = (): void => {
				if (postExitGuardCleanup) {
					postExitGuardCleanup();
					postExitGuardCleanup = undefined;
				}
			};
			const clearChildPiTimeouts = (): void => {
				clearNoResponseTimer();
				clearFinalDrainTimers();
				clearPostExitGuard();
			};

			const settle = (result: ChildPiRunResult): Promise<void> => {
				if (settled) return Promise.resolve();
				settled = true;
				clearChildPiTimeouts();
				// OPT-06 follow-up: lineObserver.flush() is now async (returns
				// Promise<void>) and drains the module-scoped pending-write set
				// before resolving. We must await it before calling `resolve()`
				// below so callers that read the transcript file post-`runChildPi`
				// see all written lines. Caller invocations of `settle` from
				// sync event handlers (`child.on('close'|'exit'|'error')`,
				// safety timer) use `void settle(...)` — errors are caught and
				// logged inside, and `resolve()` only fires after the drain
				// completes, so runChildPi's outer Promise resolves with a
				// durable transcript on disk.
				return lineObserver
					.flush()
					.then(() => {
						input.signal?.removeEventListener("abort", abort);
						input.signal?.removeEventListener("abort", onParentAbort);
						try {
							cleanupTempDir(built.tempDir);
						} catch (error) {
							cleanupErrors.push(error instanceof Error ? error.message : String(error));
						}
						// Catch all errors from settle to prevent unhandled rejection from propagating
						try {
							resolve({
								...result,
								rawFinalText: lineObserver.getRawFinalText(),
								intermediateFindings: lineObserver.getIntermediateFindings(),
								exitStatus: result.exitStatus ?? {
									exitCode: result.exitCode,
									cancelled: abortRequested,
									timedOut: responseTimeoutHit,
									killed: hardKilled,
									// Phase-0 diagnostic (HB-003a): surface the final-drain race state.
									// finalDrainArmed lets Phase 1 decide whether a signal-death (exitCode=null)
									// should be treated as a forced final drain. READ-ONLY for now.
									...(finalDrainArmed || forcedFinalDrain
										? {
												finalDrainArmed,
												forcedFinalDrain,
												finalDrainFiredMonotonicMs,
											}
										: {}),
									cleanupErrors,
									finalDrainMs,
								},
							});
						} catch (resolveError) {
							logInternalError(
								"child-pi.settle-resolve",
								resolveError,
								`result=${JSON.stringify({ exitCode: result.exitCode })}`,
							);
						}
					})
					.catch((flushError) => {
						// Drain failed — log and still resolve so runChildPi doesn't hang.
						logInternalError(
							"child-pi.settle-flush-failed",
							flushError,
							`result=${JSON.stringify({ exitCode: result.exitCode })}`,
						);
						input.signal?.removeEventListener("abort", abort);
						input.signal?.removeEventListener("abort", onParentAbort);
						try {
							cleanupTempDir(built.tempDir);
						} catch (error) {
							cleanupErrors.push(error instanceof Error ? error.message : String(error));
						}
						try {
							resolve({
								...result,
								rawFinalText: lineObserver.getRawFinalText(),
								intermediateFindings: lineObserver.getIntermediateFindings(),
								exitStatus: result.exitStatus ?? {
									exitCode: result.exitCode,
									cancelled: abortRequested,
									timedOut: responseTimeoutHit,
									killed: hardKilled,
									...(finalDrainArmed || forcedFinalDrain
										? {
												finalDrainArmed,
												forcedFinalDrain,
												finalDrainFiredMonotonicMs,
											}
										: {}),
									cleanupErrors,
									finalDrainMs,
								},
							});
						} catch (resolveError) {
							logInternalError(
								"child-pi.settle-resolve",
								resolveError,
								`result=${JSON.stringify({ exitCode: result.exitCode })}`,
							);
						}
					});
			};

			const abort = (): void => {
				abortRequested = true;
				clearNoResponseTimer();
				killProcessTree(child.pid, child);
				if (process.platform !== "win32") {
					trySignalChild(child, "SIGTERM");
				}
				try {
					child.kill(process.platform === "win32" ? undefined : "SIGTERM");
				} catch {
					// Ignore kill races.
				}
				// 3.5 — fast-escalate to SIGKILL within 200ms on explicit cancel
				// so /team-cancel completes round-trip well under the operator
				// expectation. The standard finalDrainMs / HARD_KILL_MS paths
				// are for graceful drain, not user-initiated cancel.
				const cancelHardKill = setTimeout(() => {
					if (settled || childExited) return;
					try {
						hardKilled = true;
						child.kill(process.platform === "win32" ? undefined : "SIGKILL");
					} catch (error) {
						logInternalError("child-pi.cancel-fast-kill", error, `pid=${child.pid}`);
					}
				}, 200);
				cancelHardKill.unref();
			};

			input.signal?.addEventListener("abort", abort, { once: true });
			// 3.1 — soft watermark backpressure. When inbound stdout exceeds
			// 256KB before the next macrotask, pause for 50ms so the line
			// observer + ancillary handlers get to drain. Prevents the runaway
			// case where a chatty child saturates the parent event loop.
			const BACKPRESSURE_HIGH = 256 * 1024;
			let backpressureBytes = 0;
			const releaseBackpressure = (): void => {
				backpressureBytes = 0;
				try {
					child.stdout?.resume();
				} catch {
					/* ignore */
				}
			};
			child.stdout?.on("data", (chunk: Buffer) => {
				restartNoResponseTimer();
				const text = chunk.toString("utf-8");
				backpressureBytes += text.length;
				try {
					lineObserver.observe(text);
				} catch (err) {
					logInternalError("child-pi.line-observer-observe", err, `text=${text.slice(0, 100)}`);
				}
				if (backpressureBytes > BACKPRESSURE_HIGH && child.stdout && !child.stdout.isPaused()) {
					try {
						child.stdout.pause();
					} catch {
						/* ignore */
					}
					const timer = setTimeout(releaseBackpressure, 50);
					timer.unref();
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				restartNoResponseTimer();
				stderr = appendBoundedTail(stderr, chunk.toString("utf-8"));
			});
			child.on("error", (error) => {
				// Reject pending operations with process error context
				// SEC-1: redact stderr secrets embedded in the error message + excerpt.
				const processError = new Error(
					`Child Pi process error: ${error.message}. Stderr: ${redactStderrExcerpt(stderr, 500) || "(none)"}`,
				);
				rejectPendingOperations(processError);
				try {
					input.onLifecycleEvent?.({
						type: "spawn_error",
						pid: child.pid,
						error: processError.message,
						ts: new Date().toISOString(),
						stderrExcerpt: redactStderrExcerpt(stderr, 500) || undefined,
					});
				} catch (err) {
					logInternalError("child-pi.on-lifecycle-event", err, `event=error, pid=${child.pid}`);
				}
				void settle({
					exitCode: null,
					stdout,
					stderr,
					error: processError.message,
					exitStatus: {
						exitCode: null,
						cancelled: abortRequested,
						timedOut: responseTimeoutHit,
						killed: false,
						cleanupErrors,
						finalDrainMs,
						crashClass: classifyProcessCrash({
							exitCode: null,
							cancelled: abortRequested,
							timedOut: responseTimeoutHit,
							spawnError: error,
							stderrSnippet: stderr ? redactStderrExcerpt(stderr, 1000) : undefined,
						}).crashClass,
					},
				});
			});
			child.on("exit", (code, signal) => {
				if (child.pid) {
					activeChildProcesses.delete(child.pid);
					clearHardKillTimer(child.pid);
					// Unregister from cleanup handler
					unregisterChildProcess(child.pid);
				}
				// Build comprehensive exit error for unexpected exits
				// Round-10 test fix: also require non-zero exit code OR a known abnormal condition.
				// Previously fired "exited unexpectedly" on every clean exit (code=0) because the
				// OS-level 'exit' event fires BEFORE pi's 'agent_end' JSON event reaches the line
				// observer (race). Worker actually succeeded but onLifecycleEvent reported an error.
				const abnormalExit = code !== 0 && code !== null;
				const isUnexpectedExit = !childExited && !settled && !responseTimeoutHit && !abortRequested && abnormalExit;
				const exitError = isUnexpectedExit
					? new Error(
							`Child Pi process exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"}). ` +
								`Stderr: ${redactStderrExcerpt(stderr, 1000) || "(none)"}`,
						)
					: null;
				if (exitError) {
					rejectPendingOperations(exitError);
				}
				try {
					// Phase-0 diagnostic (HB-003a): capture signal + drain timing in the
					// exit lifecycle event so the exit-null race is diagnosable instead of
					// opaque. `signal` was previously discarded after building the error msg.
					input.onLifecycleEvent?.({
						type: "exit",
						pid: child.pid,
						exitCode: code,
						ts: new Date().toISOString(),
						error: exitError?.message,
						stderrExcerpt: isUnexpectedExit ? redactStderrExcerpt(stderr, 1000) || undefined : undefined,
						// Phase-0 diagnostic fields (kept optional — no type change required).
						...(signal ? { signal } : {}),
						...(finalDrainArmed || forcedFinalDrain
							? {
									diagnostic: {
										finalDrainArmed,
										forcedFinalDrain,
										finalDrainFiredMonotonicMs,
										finalAssistantEventMonotonicMs,
										exitMonotonicMs: performance.now() - spawnMonotonicMs,
									},
								}
							: {}),
					});
				} catch (err) {
					logInternalError("child-pi.on-lifecycle-event", err, `event=exit, pid=${child.pid}`);
				}
				childExited = true;
				clearNoResponseTimer();
				clearFinalDrainTimers();
				if (!postExitGuardCleanup) {
					postExitGuardCleanup = attachPostExitStdioGuard(child, {
						idleMs: POST_EXIT_STDIO_GUARD_MS,
						hardMs: HARD_KILL_MS,
					});
				}
			});
			child.on("close", (exitCode) => {
				if (child.pid) {
					activeChildProcesses.delete(child.pid);
					clearHardKillTimer(child.pid);
					// Unregister from cleanup handler
					unregisterChildProcess(child.pid);
				}
				try {
					input.onLifecycleEvent?.({
						type: "close",
						pid: child.pid,
						exitCode,
						ts: new Date().toISOString(),
					});
				} catch (err) {
					logInternalError("child-pi.on-lifecycle-event", err, `event=close, pid=${child.pid}`);
				}
				const timeoutError =
					responseTimeoutHit && !stderr.trim()
						? {
								error: `Child Pi produced no new output for ${responseTimeoutMs}ms; process was terminated as unresponsive.`,
							}
						: responseTimeoutHit && stderr.trim()
							? {
									error: `Child Pi timed out after ${responseTimeoutMs}ms with stderr: ${redactStderrExcerpt(stderr, 500)}`,
								}
							: undefined;
				// M6 fix: log when forced final drain converts non-zero exit to 0.
				// This is expected in normal operation (child finished cleanly but linger was killed),
				// but the telemetry helps detect regressions where crashes are hidden.
				if (forcedFinalDrain && !timeoutError && exitCode !== 0) {
					logInternalError(
						"child-pi.final-drain-zero-exit",
						new Error(`Child exit code overridden to 0 after forced final drain (original=${exitCode})`),
						`pid=${child.pid}, finalDrainMs=${finalDrainMs}`,
					);
				}
				const finalExitCode = forcedFinalDrain && !timeoutError ? 0 : exitCode;
				const wasGraceAborted = softLimitReached && turnCount >= (maxTurns ?? 0) + (graceTurns ?? 5);
				const wasParentAborted = abortDueToParentSignal && !wasGraceAborted;
				// steerInjectionFailed is now always false (Phase-1 fix: steer backpressure
				// is logged, not fatal). The steerError branch is retained for safety in
				// case a future change reintroduces a fatal steer path.
				const steerError = steerInjectionFailed ? "Steer injection failed due to stdin backpressure; process killed" : undefined;
				// P0 crash taxonomy: classify the exit so callers/dashboards can bucket
				// failure modes (timeout vs cancel vs native panic vs signal …).
				// The classifier is a pure function; this is the single integration point.
				const crashClassification = classifyProcessCrash({
					exitCode: finalExitCode,
					signal: child.signalCode ?? undefined,
					cancelled: abortRequested,
					timedOut: responseTimeoutHit,
					killed: hardKilled,
					spawnError: undefined,
					stderrSnippet: stderr ? redactStderrExcerpt(stderr, 1000) : undefined,
				});
				void settle({
					exitCode: finalExitCode,
					stdout,
					stderr,
					...(timeoutError ? { error: timeoutError.error } : {}),
					...(steerError ? { error: steerError } : {}),
					aborted: wasGraceAborted || wasParentAborted,
					steered: softLimitReached && !wasGraceAborted,
					exitStatus: {
						exitCode: finalExitCode,
						cancelled: abortRequested,
						timedOut: responseTimeoutHit,
						killed: hardKilled,
						cleanupErrors,
						finalDrainMs,
						crashClass: crashClassification.crashClass,
					},
				});
			});
		});
	} finally {
		// cleanupTempDir is already called inside settle(), but guard against
		// the case where settle() was never reached (spawn throws synchronously).
		if (built.tempDir && fs.existsSync(built.tempDir)) {
			cleanupTempDir(built.tempDir);
		}
	}
}
