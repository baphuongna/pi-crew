import { type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agent-config.ts";
import { DEFAULT_CHILD_PI } from "../config/defaults.ts";
import { registerChildProcess, unregisterChildProcess } from "../extension/crew-cleanup.ts";
import { atomicWriteFile } from "../state/atomic-write.ts";
import type { WorkerExitStatus } from "../state/types.ts";
import { WINDOWS_ESSENTIAL_ENV_VARS } from "../utils/env-allowlist.ts";
import { buildScopedAllowList, sanitizeEnvSecrets } from "../utils/env-filter.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { redactSecretString } from "../utils/redaction.ts";
import { FINAL_DRAIN_MS, HARD_KILL_MS, POST_EXIT_STDIO_GUARD_MS, RESPONSE_TIMEOUT_MS } from "./child-pi-constants.ts";
import { appendBoundedTail, clearHardKillTimer, killProcessTree, registerActiveChild, unregisterActiveChild } from "./child-pi-kill.ts";
import { ChildPiSteeringController } from "./child-pi-steering.ts";
// Internal helpers for active-child bookkeeping (extracted to child-pi-kill.ts).
import { ChildPiLineObserver } from "./child-pi-streams.ts";

// ── Re-exports from child-pi-kill.ts (H-7 decomposition step 2) ──
// killProcessTree is internal (not previously exported) — keep that invariant.
export {
	killProcessPid,
	terminateActiveChildPiProcesses,
} from "./child-pi-kill.ts";
// ── Re-export from child-pi-streams.ts (H-7 decomposition step 4) ──
export { ChildPiLineObserver } from "./child-pi-streams.ts";

import { classifyProcessCrash } from "./crash-classification.ts";
import { buildPiWorkerArgs, checkCrewDepth, cleanupTempDir } from "./pi-args.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { attachPostExitStdioGuard, trySignalChild } from "./post-exit-stdio-guard.ts";

/** Maximum size (bytes) for the ChildPiLineObserver's line accumulation buffer.
 * When exceeded, the buffer is force-flushed to prevent unbounded memory growth
 * from chatty child processes that produce output without newlines.
 * (Constant moved to child-pi-constants.ts.) */

// Periodic cleanup of dead child process entries to prevent memory leaks.
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

/**
 * B6: spawn taskkill and attach an 'error' listener. spawn() emits ENOENT/EACCES
 * asynchronously via the 'error' event (not as a throw), so an unlistened spawn
 * can crash the parent as an uncaught exception. taskkill is a standard Windows
 * binary so this is defensive, but the listener keeps failures bounded.
 */

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
	const allowList = model ? buildScopedAllowList(BASE_ALLOWLIST, [model]) : BASE_ALLOWLIST;
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

// ── Transcript batching + compaction (H-7 decomposition step 1) ────────
// Extracted to ./child-pi-transcript.ts. Re-exported here to preserve the
// existing public API surface.
export {
	appendTranscript,
	compactString,
	compactValue,
	flushPendingTranscriptWrites,
	resetTranscriptBatchState,
} from "./child-pi-transcript.ts";

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
	if (obj?.type !== "message_end") return false;
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
				atomicWriteFile(counterFile, String(count));
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
				registerActiveChild(child.pid, child);
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
			const steeringController = new ChildPiSteeringController(input.maxTurns, input.graceTurns);
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

			const steerInjectionFailed = false;
			let abortDueToParentSignal = false;
			// CP-1: track whether the turn-limit hard-abort has been initiated. Once
			// true, we must NOT restart the no-response timer — the child is already
			// being killed via killProcessTree (SIGTERM → SIGKILL after 3s), and
			// restarting the timer would delay detection of a SIGTERM-ignoring child.
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
					if (!steeringController.isHardAbortInitiated()) restartNoResponseTimer();
					stdout = appendBoundedTail(stdout, `${line}\n`);
					input.onStdoutLine?.(line);
				},
				onJsonEvent: (event) => {
					if (!steeringController.isHardAbortInitiated()) restartNoResponseTimer();
					const eventOpId = startOperation("json_event");
					try {
						// Turn-count-based steering: soft limit steer + hard abort after graceTurns
						if (event && typeof event === "object" && !Array.isArray(event)) {
							const obj = event as Record<string, unknown>;
							if (obj.type === "turn_end") {
								// H-7 step 5: steering state machine extracted to ChildPiSteeringController.
								const action = steeringController.onTurnEnd(child.pid, child, input.steeringFile);
								if (action.kind === "hardAbort") killProcessTree(action.pid, action.child);
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
				// Promise<void>) and drains the module-scoped transcript batch buffer
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
				if (!steeringController.isHardAbortInitiated()) restartNoResponseTimer();
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
				if (!steeringController.isHardAbortInitiated()) restartNoResponseTimer();
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
					unregisterActiveChild(child.pid);
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
					unregisterActiveChild(child.pid);
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
				const wasGraceAborted =
					steeringController.isSoftLimitReached() &&
					steeringController.getTurnCount() >=
						(steeringController.getMaxTurns() ?? 0) + (steeringController.getGraceTurns() ?? 5);
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
					steered: steeringController.isSoftLimitReached() && !wasGraceAborted,
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
