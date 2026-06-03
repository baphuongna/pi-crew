import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { WorkerExitStatus } from "../state/types.ts";
import { buildPiWorkerArgs, checkCrewDepth, cleanupTempDir } from "./pi-args.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { DEFAULT_CHILD_PI } from "../config/defaults.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { attachPostExitStdioGuard, trySignalChild } from "./post-exit-stdio-guard.ts";
import { redactJsonLine } from "../utils/redaction.ts";
import { sanitizeEnvSecrets } from "../utils/env-filter.ts";
import { registerChildProcess, unregisterChildProcess } from "../extension/crew-cleanup.ts";

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

function appendBoundedTail(current: string, chunk: string, maxBytes = MAX_CAPTURE_BYTES): string {
	const combined = current + chunk;
	if (Buffer.byteLength(combined, "utf-8") <= maxBytes) return combined;
	let tail = combined.slice(Math.max(0, combined.length - maxBytes));
	while (Buffer.byteLength(tail, "utf-8") > maxBytes) tail = tail.slice(1024);
	return `[pi-crew captured output truncated to last ${Math.round(maxBytes / 1024)} KiB]\n${tail}`;
}

function clearHardKillTimer(pid: number | undefined): void {
	if (!pid) return;
	const timer = childHardKillTimers.get(pid);
	if (!timer) return;
	clearTimeout(timer);
	childHardKillTimers.delete(pid);
}

export function killProcessPid(pid: number): void {
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		if (process.platform === "win32") {
			// 3.8: Windows path uses taskkill /T /F (force kill the entire tree).
			// taskkill itself can silently fail (PID gone, permission denied, etc.)
			// so verify after 2s and log a warning if the process is still alive.
			spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
			const verifyTimer = setTimeout(() => {
				try {
					process.kill(pid, 0); // throws ESRCH when dead
					// Still alive — log and retry once.
					logInternalError("child-pi.taskkill-stuck", new Error(`process ${pid} still alive 2s after taskkill /T /F; retrying`), `pid=${pid}`);
					try { spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }); } catch { /* best-effort */ }
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
	/** Run ID for cleanup tracking */
	runId?: string;
	/** Agent ID for cleanup tracking */
	agentId?: string;
	/** Role for tool restrictions (from role-tools.ts) */
	role?: string;
}

export interface ChildPiRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
	exitStatus?: WorkerExitStatus;
	/** True if the agent was hard-aborted (max_turns + grace exceeded). */
	aborted?: boolean;
	/** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
	steered?: boolean;
}

export function buildChildPiSpawnOptions(cwd: string, env: NodeJS.ProcessEnv): SpawnOptions {
	// Filter out env vars whose keys match secret patterns to avoid leaking credentials to child processes.
	// IMPORTANT: preserve model provider API keys — they are needed by the child Pi to call the LLM.
	// Also preserve essential non-secret vars (PATH, HOME, USER, etc.) so the child process can function.
	// Bug #10 fix: allow-list preserves model provider keys.
	// Bug #12 fix: essential env vars (PATH, HOME, etc.) are always preserved so child can find npm/node.
	const filteredEnv = sanitizeEnvSecrets(env, {
		allowList: [
			// Model provider API keys (explicit list — do NOT use wildcards)
			"MINIMAX_API_KEY",
			"MINIMAX_GROUP_ID",
			"OPENAI_API_KEY",
			"OPENAI_ORG_ID",
			"ANTHROPIC_API_KEY",
			"GOOGLE_API_KEY",
			"GOOGLE_GENERATIVE_LANGUAGE_API_KEY",
			"AZURE_OPENAI_API_KEY",
			"AZURE_OPENAI_ENDPOINT",
			"AWS_ACCESS_KEY_ID",
			"AWS_SECRET_ACCESS_KEY",
			"AWS_REGION",
			"ZEU_API_KEY",
			"ZERODEV_API_KEY",
			// SECURITY FIX: Removed dangerous wildcards "*_API_KEY", "*_TOKEN", "*_SECRET"
			// These patterns would leak ALL secrets matching the pattern to child processes.
			// Only add specific, intended provider keys above.
			// Essential non-secret vars for child process to function
			"PATH",
			"HOME",
			"USER",
			"SHELL",
			"TERM",
			"LANG",
			// FIX: Replaced broad wildcards (LC_*, XDG_*, NVM_*, NODE_*, npm_*) with
			// specific names. Previously NPM_TOKEN, NODE_ENV=production, NVM_RC_VERSION
			// all leaked through wildcards.
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
			"NVM_BIN",
			"NVM_DIR",
			"NVM_INC",
			"NODE_PATH",
			"NODE_DISABLE_COLORS",
			"NODE_EXTRA_CA_CERTS",
			"NPM_CONFIG_REGISTRY",
			"NPM_CONFIG_USERCONFIG",
			"NPM_CONFIG_GLOBALCONFIG",
			"PI_*",
			"PI_CREW_*",
			"PI_TEAMS_*",
		],
	});
	// Block execution control vars from leaking to child processes
	delete filteredEnv.PI_CREW_EXECUTE_WORKERS;
	delete filteredEnv.PI_TEAMS_EXECUTE_WORKERS;
	return {
		cwd,
		env: { ...filteredEnv, PI_CREW_PARENT_PID: String(process.pid) },
		stdio: ["ignore", "pipe", "pipe"], // stdin=ignore: child doesn't wait for input; task comes via CLI args
		detached: process.platform !== "win32",
		setsid: true,
		windowsHide: true,
	} as SpawnOptions;
}

function appendTranscript(input: ChildPiRunInput, line: string): void {
	if (!input.transcriptPath) return;
	fs.mkdirSync(path.dirname(input.transcriptPath), { recursive: true });
	fs.appendFileSync(input.transcriptPath, `${redactJsonLine(line)}\n`, "utf-8");
}

function compactString(value: string, maxChars = MAX_COMPACT_CONTENT_CHARS): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n[pi-crew compacted ${value.length - maxChars} chars]`;
}

function compactValue(value: unknown): unknown {
	if (typeof value === "string") return compactString(value);
	if (Array.isArray(value)) return value.slice(0, 20).map(compactValue);
	const record = asRecord(value);
	if (!record) return value;
	const compacted: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record).slice(0, 20)) compacted[key] = compactValue(entry);
	return compacted;
}

function compactContentPart(part: unknown): unknown | undefined {
	const record = asRecord(part);
	if (!record) return undefined;
	if (record.type === "text") return { type: "text", text: typeof record.text === "string" ? compactString(record.text, MAX_ASSISTANT_TEXT_CHARS) : "" };
	if (record.type === "toolCall") return { type: "toolCall", name: record.name, input: compactValue(typeof record.input === "string" ? compactString(record.input, MAX_TOOL_INPUT_CHARS) : record.input) };
	if (record.type === "toolResult") return { type: "toolResult", name: record.name, content: compactValue(typeof record.content === "string" ? compactString(record.content, MAX_TOOL_RESULT_CHARS) : record.content) };
	return undefined;
}

function compactChildPiEvent(event: unknown): unknown | undefined {
	const record = asRecord(event);
	if (!record) return undefined;
	if (record.type === "message_update") return undefined;
	if (record.type === "tool_execution_start" || record.type === "tool_execution_end") {
		return { type: record.type, toolName: record.toolName, args: record.args };
	}
	if (record.type === "tool_result_end" || record.type === "message_end" || record.type === "message") {
		const message = asRecord(record.message);
		if (message?.role === "user" || message?.role === "system") return undefined;
		const content = Array.isArray(message?.content) ? message.content.map(compactContentPart).filter((part) => part !== undefined) : undefined;
		return {
			type: record.type,
			...(typeof record.text === "string" ? { text: record.text } : {}),
			...(message ? { message: { role: message.role, ...(content ? { content } : {}), usage: message.usage, model: message.model, errorMessage: message.errorMessage, stopReason: message.stopReason } } : {}),
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
	const text = content.flatMap((part) => {
		const item = asRecord(part);
		return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
	}).join("\n").trim();
	return text || (typeof record.text === "string" ? record.text : undefined);
}

function compactChildPiLine(line: string): { persistedLine: string; event?: unknown; displayLine?: string; json: boolean } {
	try {
		const parsed = JSON.parse(line);
		const compact = compactChildPiEvent(parsed);
		return { json: true, event: compact, persistedLine: compact ? JSON.stringify(compact) : "", displayLine: displayTextFromCompactEvent(compact) };
	} catch {
		return { json: false, persistedLine: line, displayLine: line };
	}
}

export class ChildPiLineObserver {
	private buffer = "";
	private readonly input: ChildPiRunInput;

	constructor(input: ChildPiRunInput) {
		this.input = input;
	}

	observe(text: string): void {
		this.buffer += text;
		const lines = this.buffer.split(/\r?\n/);
		this.buffer = lines.pop() ?? "";
		for (const line of lines) this.emitLine(line);
	}

	flush(): void {
		if (!this.buffer) return;
		const line = this.buffer;
		this.buffer = "";
		this.emitLine(line);
	}

	private emitLine(line: string): void {
		if (!line.trim()) return;
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
		}
	}
}

/** Mock-only path — real code path reuses a single observer. */
function observeStdoutChunk(input: ChildPiRunInput, text: string): void {
	const observer = new ChildPiLineObserver(input);
	observer.observe(text);
	observer.flush();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isFinalAssistantEvent(event: unknown): boolean {
	const obj = asRecord(event);
	if (!obj || obj.type !== "message_end") return false;
	const message = asRecord(obj.message);
	const role = message?.role;
	if (role !== undefined && role !== "assistant") return false;
	const stopReason = typeof message?.stopReason === "string" ? message.stopReason : typeof obj.stopReason === "string" ? obj.stopReason : undefined;
	if (stopReason !== undefined && stopReason !== "stop") return false;
	const content = Array.isArray(message?.content) ? message.content : [];
	return !content.some((part) => asRecord(part)?.type === "toolCall");
}

export async function runChildPi(input: ChildPiRunInput): Promise<ChildPiRunResult> {
	// Phase 1 (live-session parity): prepend parent context when inheritContext is true.
	// This mirrors the effectivePrompt logic in live-session-runtime.ts so that
	// child-process workers receive the same inherited-context treatment.
	const effectiveTask = input.inheritContext === true && input.parentContext
		? `${input.parentContext}\n\n---\n# Child Worker Task\n${input.task}`
		: input.task;
	const depth = checkCrewDepth(input.maxDepth);
	if (depth.blocked) return { exitCode: 1, stdout: "", stderr: `pi-crew depth guard blocked child worker: depth ${depth.depth} >= max ${depth.maxDepth}` };
	const mock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	if (mock) {
		// SECURITY: Log mock mode activation prominently for audit trail
		console.warn(`[⚠️ PI_CREW_MOCK_MODE] Mock mode active: ${mock} — NOT running real agents!`);
		// SECURITY FIX: Require PI_CREW_ALLOW_MOCK alongside PI_TEAMS_MOCK_CHILD_PI
		const allowMock = process.env.PI_CREW_ALLOW_MOCK === "1" || process.env.PI_CREW_ALLOW_MOCK === "true";
		if (!allowMock) {
			console.error(`[🚨 PI_CREW_MOCK_MODE] SECURITY: PI_TEAMS_MOCK_CHILD_PI is set but PI_CREW_ALLOW_MOCK is not "1". Ignoring mock request for safety.`);
			return { exitCode: 1, stdout: "", stderr: "Mock mode requires PI_CREW_ALLOW_MOCK=1 alongside PI_TEAMS_MOCK_CHILD_PI" };
		}
		if (mock === "success") {
			const stdout = `[MOCK] Success for ${input.agent.name}\n`;
			observeStdoutChunk(input, stdout);
			return { exitCode: 0, stdout, stderr: "" };
		}
		if (mock === "json-success" || mock === "adaptive-plan") {
			const text = mock === "adaptive-plan" && effectiveTask.includes("ADAPTIVE_PLAN_JSON_START")
				? `[MOCK] Adaptive plan\nADAPTIVE_PLAN_JSON_START\n${JSON.stringify({ phases: [{ name: "research", tasks: [{ role: "explorer", task: "Explore adaptive target" }, { role: "analyst", task: "Analyze adaptive target" }, { role: "planner", task: "Plan adaptive target" }] }, { name: "build", tasks: [{ role: "executor", task: "Implement adaptive target" }] }, { name: "check", tasks: [{ role: "reviewer", task: "Review adaptive target" }, { role: "test-engineer", task: "Test adaptive target" }, { role: "writer", task: "Summarize adaptive target" }] }] })}\nADAPTIVE_PLAN_JSON_END`
				: `[MOCK] JSON success for ${input.agent.name}`;
			const stdout = `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n${JSON.stringify({ type: "message_end", usage: { input: 10, output: 5, cost: 0.001, turns: 1 } })}\n`;
			observeStdoutChunk(input, stdout);
			return { exitCode: 0, stdout, stderr: "" };
		}
		if (mock === "retryable-failure") return { exitCode: 1, stdout: "", stderr: "[MOCK] rate limit: mock failure" };
		return { exitCode: 1, stdout: "", stderr: `[MOCK] failure: ${mock}` };
	}
	const built = buildPiWorkerArgs({ task: effectiveTask, agent: input.agent, model: input.model, sessionEnabled: true, maxDepth: input.maxDepth, skillPaths: input.skillPaths, role: input.role });
	const spawnSpec = getPiSpawnCommand(built.args);
	try {
		return await new Promise<ChildPiRunResult>((resolve) => {
			const child = spawn(spawnSpec.command, spawnSpec.args, buildChildPiSpawnOptions(input.cwd, { ...process.env, ...built.env }));
			if (child.pid) {
				activeChildProcesses.set(child.pid, child);
				input.onSpawn?.(child.pid);
				input.onLifecycleEvent?.({ type: "spawned", pid: child.pid, ts: new Date().toISOString() });
				// Register with cleanup handler for graceful shutdown
				if (input.runId && input.agentId) {
					registerChildProcess(child.pid, input.runId, input.agentId);
				}
			} else {
				input.onLifecycleEvent?.({ type: "spawn_error", error: "spawn returned no pid", ts: new Date().toISOString() });
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
			// FIX (Round 14): Bound the env-controlled response timeout to
			// [1_000ms, 3_600_000ms] (1s–1h) so a hostile or accidental value
			// (e.g. 1, or 999_999_999) cannot disable the timeout or cause
			// instant kills. Out-of-range values fall back to the input or
			// built-in default.
			const RESPONSE_TIMEOUT_MIN_MS = 1_000;
			const RESPONSE_TIMEOUT_MAX_MS = 3_600_000;
			const responseTimeoutEnv = Number.parseInt(process.env.PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS ?? "", 10);
			const envInRange = Number.isFinite(responseTimeoutEnv) && responseTimeoutEnv >= RESPONSE_TIMEOUT_MIN_MS && responseTimeoutEnv <= RESPONSE_TIMEOUT_MAX_MS;
			const responseTimeoutMs = envInRange ? responseTimeoutEnv : input.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS;
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
			const maxTurns = input.maxTurns;
			const graceTurns = input.graceTurns;
			let abortDueToParentSignal = false;
			input.signal?.addEventListener("abort", () => { abortDueToParentSignal = true; }, { once: true });
			const restartNoResponseTimer = (): void => {
				if (responseTimeoutMs <= 0) return;
				if (noResponseTimer) clearTimeout(noResponseTimer);
				noResponseTimer = setTimeout(() => {
					responseTimeoutHit = true;
					// Capture stderr at timeout moment for debugging
					const timeoutStderr = stderr.slice(-1024); // Last 1KB of stderr
					input.onLifecycleEvent?.({ type: "response_timeout", pid: child.pid, error: `No output for ${responseTimeoutMs}ms`, ts: new Date().toISOString(), stderr: timeoutStderr || undefined });
					killProcessTree(child.pid, child);
					try {
						child.kill(process.platform === "win32" ? undefined : "SIGTERM");
					} catch (error) {
						logInternalError("child-pi.response-timeout-term", error, `pid=${child.pid}`);
					}
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
									// Inject steer via stdin to tell child to wrap up
									child.stdin?.write(JSON.stringify({ type: "steer", message: "You have reached your turn limit. Wrap up immediately — provide your final answer now." }) + "\n");
								} else if (maxTurns !== undefined && softLimitReached && turnCount >= maxTurns + (graceTurns ?? 5)) {
									// Hard abort — terminate after grace turns
									try { child.kill(process.platform === "win32" ? undefined : "SIGTERM"); } catch { /* best-effort */ }
								}
							}
						}
						completeOperation(eventOpId);
					} catch (err) {
						completeOperation(eventOpId);
						throw err;
					}
					input.onJsonEvent?.(event);
					if (!isFinalAssistantEvent(event) || childExited || settled || finalDrainTimer) return;
					finalDrainTimer = setTimeout(() => {
						if (settled || childExited) return;
						forcedFinalDrain = true;
						input.onLifecycleEvent?.({ type: "final_drain", pid: child.pid, ts: new Date().toISOString() });
						try {
							child.kill(process.platform === "win32" ? undefined : "SIGTERM");
						} catch (error) {
							logInternalError("child-pi.final-drain-term", error, `pid=${child.pid}`);
						}
						hardKillTimer = setTimeout(() => {
							if (settled || childExited) return;
							try {
								hardKilled = true;
								input.onLifecycleEvent?.({ type: "hard_kill", pid: child.pid, ts: new Date().toISOString() });
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

			const settle = (result: ChildPiRunResult): void => {
				if (settled) return;
				settled = true;
				clearChildPiTimeouts();
				lineObserver.flush();
				input.signal?.removeEventListener("abort", abort);
				try {
					cleanupTempDir(built.tempDir);
				} catch (error) {
					cleanupErrors.push(error instanceof Error ? error.message : String(error));
				}
				// Catch all errors from settle to prevent unhandled rejection from propagating
				try {
					resolve({ ...result, exitStatus: result.exitStatus ?? { exitCode: result.exitCode, cancelled: abortRequested, timedOut: responseTimeoutHit, killed: hardKilled, cleanupErrors, finalDrainMs } });
				} catch (resolveError) {
					logInternalError("child-pi.settle-resolve", resolveError, `result=${JSON.stringify({ exitCode: result.exitCode })}`);
				}
			};

			const abort = (): void => {
				abortRequested = true;
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
				try { child.stdout?.resume(); } catch { /* ignore */ }
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
					try { child.stdout.pause(); } catch { /* ignore */ }
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
				const processError = new Error(
					`Child Pi process error: ${error.message}. Stderr: ${stderr.slice(-500) || "(none)"}`,
				);
				rejectPendingOperations(processError);
				try {
					input.onLifecycleEvent?.({ type: "spawn_error", pid: child.pid, error: processError.message, ts: new Date().toISOString(), stderrExcerpt: stderr.slice(-500) || undefined });
				} catch (err) {
					logInternalError("child-pi.on-lifecycle-event", err, `event=error, pid=${child.pid}`);
				}
				settle({ exitCode: null, stdout, stderr, error: processError.message });
			});
			child.on("exit", (code, signal) => {
				if (child.pid) {
					activeChildProcesses.delete(child.pid);
					clearHardKillTimer(child.pid);
					// Unregister from cleanup handler
					unregisterChildProcess(child.pid);
				}
				// Build comprehensive exit error for unexpected exits
				const isUnexpectedExit = !childExited && !settled && !responseTimeoutHit && !abortRequested;
				const exitError = isUnexpectedExit
					? new Error(
						`Child Pi process exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"}). `
						+ `Stderr: ${stderr.slice(-1000) || "(none)"}`,
					)
					: null;
				if (exitError) {
					rejectPendingOperations(exitError);
				}
				try {
					input.onLifecycleEvent?.({ type: "exit", pid: child.pid, exitCode: code, ts: new Date().toISOString(), error: exitError?.message, stderrExcerpt: isUnexpectedExit ? stderr.slice(-1000) || undefined : undefined });
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
					input.onLifecycleEvent?.({ type: "close", pid: child.pid, exitCode, ts: new Date().toISOString() });
				} catch (err) {
					logInternalError("child-pi.on-lifecycle-event", err, `event=close, pid=${child.pid}`);
				}
				const timeoutError = responseTimeoutHit && !stderr.trim() ? { error: `Child Pi produced no new output for ${responseTimeoutMs}ms; process was terminated as unresponsive.` } : responseTimeoutHit && stderr.trim() ? { error: `Child Pi timed out after ${responseTimeoutMs}ms with stderr: ${stderr.slice(-500)}` } : undefined;
				// M6 fix: log when forced final drain converts non-zero exit to 0.
			// This is expected in normal operation (child finished cleanly but linger was killed),
			// but the telemetry helps detect regressions where crashes are hidden.
			if (forcedFinalDrain && !timeoutError && exitCode !== 0) {
				logInternalError("child-pi.final-drain-zero-exit", new Error(`Child exit code overridden to 0 after forced final drain (original=${exitCode})`), `pid=${child.pid}, finalDrainMs=${finalDrainMs}`);
			}
			const finalExitCode = forcedFinalDrain && !timeoutError ? 0 : exitCode;
				const wasGraceAborted = softLimitReached && turnCount >= (maxTurns ?? 0) + (graceTurns ?? 5);
				const wasParentAborted = abortDueToParentSignal && !wasGraceAborted;
				settle({ exitCode: finalExitCode, stdout, stderr, ...(timeoutError ? { error: timeoutError.error } : {}), aborted: wasGraceAborted || wasParentAborted, steered: softLimitReached && !wasGraceAborted, exitStatus: { exitCode: finalExitCode, cancelled: abortRequested, timedOut: responseTimeoutHit, killed: hardKilled, cleanupErrors, finalDrainMs } });
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
