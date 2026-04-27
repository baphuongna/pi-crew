import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agent-config.ts";
import { buildPiWorkerArgs, checkCrewDepth, cleanupTempDir } from "./pi-args.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";

const POST_EXIT_STDIO_GUARD_MS = 3000;
const FINAL_DRAIN_MS = 5000;
const HARD_KILL_MS = 3000;
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_ASSISTANT_TEXT_CHARS = 8192;
const MAX_TOOL_RESULT_CHARS = 1024;
const MAX_TOOL_INPUT_CHARS = 2048;
const MAX_COMPACT_CONTENT_CHARS = 4096;
const activeChildProcesses = new Map<number, ChildProcess>();

function appendBoundedTail(current: string, chunk: string, maxBytes = MAX_CAPTURE_BYTES): string {
	const combined = current + chunk;
	if (Buffer.byteLength(combined, "utf-8") <= maxBytes) return combined;
	let tail = combined.slice(Math.max(0, combined.length - maxBytes));
	while (Buffer.byteLength(tail, "utf-8") > maxBytes) tail = tail.slice(1024);
	return `[pi-crew captured output truncated to last ${Math.round(maxBytes / 1024)} KiB]\n${tail}`;
}

function killProcessTree(pid: number | undefined): void {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return;
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
			return;
		}
		try { process.kill(-pid, "SIGTERM"); } catch { process.kill(pid, "SIGTERM"); }
		setTimeout(() => {
			try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
		}, HARD_KILL_MS).unref?.();
	} catch {
		// Ignore shutdown races.
	}
}

export function terminateActiveChildPiProcesses(): number {
	const pids = [...activeChildProcesses.keys()];
	for (const pid of pids) killProcessTree(pid);
	return pids.length;
}

export interface ChildPiRunInput {
	cwd: string;
	task: string;
	agent: AgentConfig;
	model?: string;
	signal?: AbortSignal;
	transcriptPath?: string;
	onStdoutLine?: (line: string) => void;
	onJsonEvent?: (event: unknown) => void;
	maxDepth?: number;
	finalDrainMs?: number;
	hardKillMs?: number;
}

export interface ChildPiRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
}

function appendTranscript(input: ChildPiRunInput, line: string): void {
	if (!input.transcriptPath) return;
	fs.mkdirSync(path.dirname(input.transcriptPath), { recursive: true });
	fs.appendFileSync(input.transcriptPath, `${line}\n`, "utf-8");
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
		if (compact.event !== undefined) this.input.onJsonEvent?.(compact.event);
		if (compact.persistedLine) appendTranscript(this.input, compact.persistedLine);
		if (compact.displayLine?.trim()) this.input.onStdoutLine?.(compact.displayLine);
	}
}

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
	const depth = checkCrewDepth(input.maxDepth);
	if (depth.blocked) return { exitCode: 1, stdout: "", stderr: `pi-crew depth guard blocked child worker: depth ${depth.depth} >= max ${depth.maxDepth}` };
	const mock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	if (mock) {
		if (mock === "success") {
			const stdout = `Mock child Pi success for ${input.agent.name}\n`;
			observeStdoutChunk(input, stdout);
			return { exitCode: 0, stdout, stderr: "" };
		}
		if (mock === "json-success" || mock === "adaptive-plan") {
			const text = mock === "adaptive-plan" && input.task.includes("ADAPTIVE_PLAN_JSON_START")
				? `Adaptive mock plan\nADAPTIVE_PLAN_JSON_START\n${JSON.stringify({ phases: [{ name: "research", tasks: [{ role: "explorer", task: "Explore adaptive target" }, { role: "analyst", task: "Analyze adaptive target" }, { role: "planner", task: "Plan adaptive target" }] }, { name: "build", tasks: [{ role: "executor", task: "Implement adaptive target" }] }, { name: "check", tasks: [{ role: "reviewer", task: "Review adaptive target" }, { role: "test-engineer", task: "Test adaptive target" }, { role: "writer", task: "Summarize adaptive target" }] }] })}\nADAPTIVE_PLAN_JSON_END`
				: `Mock JSON success for ${input.agent.name}`;
			const stdout = `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n${JSON.stringify({ type: "message_end", usage: { input: 10, output: 5, cost: 0.001, turns: 1 } })}\n`;
			observeStdoutChunk(input, stdout);
			return { exitCode: 0, stdout, stderr: "" };
		}
		if (mock === "retryable-failure") return { exitCode: 1, stdout: "", stderr: "rate limit: mock failure" };
		return { exitCode: 1, stdout: "", stderr: `mock failure: ${mock}` };
	}
	const built = buildPiWorkerArgs({ task: input.task, agent: input.agent, model: input.model, sessionEnabled: false, maxDepth: input.maxDepth });
	const spawnSpec = getPiSpawnCommand(built.args);
	try {
		return await new Promise<ChildPiRunResult>((resolve) => {
			const child = spawn(spawnSpec.command, spawnSpec.args, {
				cwd: input.cwd,
				env: { ...process.env, ...built.env },
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			if (child.pid) activeChildProcesses.set(child.pid, child);
			let stdout = "";
			let stderr = "";
			let settled = false;
			let childExited = false;
			let postExitGuard: NodeJS.Timeout | undefined;
			let finalDrainTimer: NodeJS.Timeout | undefined;
			let hardKillTimer: NodeJS.Timeout | undefined;
			const finalDrainMs = input.finalDrainMs ?? FINAL_DRAIN_MS;
			const hardKillMs = input.hardKillMs ?? HARD_KILL_MS;
			let forcedFinalDrain = false;
			const lineObserver = new ChildPiLineObserver({
				...input,
				onStdoutLine: (line) => {
					stdout = appendBoundedTail(stdout, `${line}\n`);
					input.onStdoutLine?.(line);
				},
				onJsonEvent: (event) => {
					input.onJsonEvent?.(event);
					if (!isFinalAssistantEvent(event) || childExited || settled || finalDrainTimer) return;
					finalDrainTimer = setTimeout(() => {
						if (settled || childExited) return;
						forcedFinalDrain = true;
						try { child.kill(process.platform === "win32" ? undefined : "SIGTERM"); } catch {}
						hardKillTimer = setTimeout(() => {
							if (settled || childExited) return;
							try { child.kill(process.platform === "win32" ? undefined : "SIGKILL"); } catch {}
						}, hardKillMs);
						hardKillTimer.unref?.();
					}, finalDrainMs);
					finalDrainTimer.unref?.();
				},
			});

			const clearFinalDrainTimers = (): void => {
				if (finalDrainTimer) clearTimeout(finalDrainTimer);
				if (hardKillTimer) clearTimeout(hardKillTimer);
				finalDrainTimer = undefined;
				hardKillTimer = undefined;
			};

			const settle = (result: ChildPiRunResult): void => {
				if (settled) return;
				settled = true;
				if (postExitGuard) clearTimeout(postExitGuard);
				clearFinalDrainTimers();
				lineObserver.flush();
				input.signal?.removeEventListener("abort", abort);
				cleanupTempDir(built.tempDir);
				resolve(result);
			};

			const abort = (): void => {
				killProcessTree(child.pid);
				try {
					child.kill(process.platform === "win32" ? undefined : "SIGTERM");
				} catch {
					// Ignore kill races.
				}
			};

			input.signal?.addEventListener("abort", abort, { once: true });
			child.stdout?.on("data", (chunk: Buffer) => {
				lineObserver.observe(chunk.toString("utf-8"));
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr = appendBoundedTail(stderr, chunk.toString("utf-8"));
			});
			child.on("error", (error) => {
				settle({ exitCode: null, stdout, stderr, error: error.message });
			});
			child.on("exit", () => {
				if (child.pid) activeChildProcesses.delete(child.pid);
				childExited = true;
				clearFinalDrainTimers();
				postExitGuard = setTimeout(() => {
					child.stdout?.destroy();
					child.stderr?.destroy();
				}, POST_EXIT_STDIO_GUARD_MS);
				postExitGuard.unref?.();
			});
			child.on("close", (exitCode) => {
				if (child.pid) activeChildProcesses.delete(child.pid);
				settle({ exitCode, stdout, stderr, ...(forcedFinalDrain && !stderr.trim() ? { error: `Child Pi did not exit within ${finalDrainMs}ms after final assistant message; termination was requested.` } : {}) });
			});
		});
	} finally {
		cleanupTempDir(built.tempDir);
	}
}
