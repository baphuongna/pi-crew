import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewRuntimeConfig } from "../config/config.ts";
import type { TeamRunManifest, TeamTaskState, UsageState } from "../state/types.ts";
import { buildMemoryBlock } from "./agent-memory.ts";
import { registerLiveAgent, updateLiveAgentStatus } from "./live-agent-manager.ts";
import { applyLiveAgentControlRequest, applyLiveAgentControlRequests, type LiveAgentControlCursor } from "./live-agent-control.ts";
import { subscribeLiveControlRealtime } from "./live-control-realtime.ts";
import { eventToSidechainType, sidechainOutputPath, writeSidechainEntry } from "./sidechain-output.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";
import { isLiveSessionRuntimeAvailable } from "./runtime-resolver.ts";
import { redactSecrets } from "../utils/redaction.ts";

export interface LiveSessionSpawnInput {
	manifest: TeamRunManifest;
	task: TeamTaskState;
	step: WorkflowStep;
	agent: AgentConfig;
	prompt: string;
	signal?: AbortSignal;
	transcriptPath?: string;
	onEvent?: (event: unknown) => void;
	onOutput?: (text: string) => void;
	runtimeConfig?: CrewRuntimeConfig;
	parentContext?: string;
	parentModel?: unknown;
	modelRegistry?: unknown;
	isCurrent?: () => boolean;
}

export interface LiveSessionRunResult {
	available: true;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	jsonEvents: number;
	usage?: UsageState;
	error?: string;
}

export interface LiveSessionUnavailableResult {
	available: false;
	reason: string;
}

export interface LiveSessionPlannedResult {
	available: true;
	reason: string;
}

type LiveSessionModule = Record<string, unknown> & {
	createAgentSession?: (options?: Record<string, unknown>) => Promise<{ session: LiveSessionLike; modelFallbackMessage?: string }>;
	DefaultResourceLoader?: new (options: Record<string, unknown>) => { reload?: () => Promise<void> };
	SessionManager?: { inMemory?: (cwd?: string) => unknown; create?: (cwd?: string, sessionDir?: string) => unknown };
	SettingsManager?: { create?: (cwd?: string, agentDir?: string) => unknown };
	getAgentDir?: () => string;
};

type LiveSessionLike = {
	subscribe?: (listener: (event: unknown) => void) => (() => void);
	prompt?: (text: string, options?: Record<string, unknown>) => Promise<void>;
	steer?: (text: string) => Promise<void>;
	abort?: () => Promise<void> | void;
	getStats?: () => unknown;
	stats?: unknown;
	bindExtensions?: (bindings?: Record<string, unknown>) => Promise<void>;
	getActiveToolNames?: () => string[];
	setActiveToolsByName?: (names: string[]) => void;
};

function appendTranscript(filePath: string | undefined, event: unknown): void {
	if (!filePath) return;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, `${JSON.stringify(redactSecrets(event))}\n`, "utf-8");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textFromContent(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		const obj = asRecord(part);
		if (!obj) return [];
		if (obj.type === "text" && typeof obj.text === "string") return [obj.text];
		if (typeof obj.content === "string") return [obj.content];
		return [];
	});
}

function eventText(event: unknown): string[] {
	const obj = asRecord(event);
	if (!obj) return [];
	const text: string[] = [];
	if (typeof obj.text === "string") text.push(obj.text);
	text.push(...textFromContent(obj.content));
	const message = asRecord(obj.message);
	if (message) text.push(...textFromContent(message.content));
	return text.filter((entry) => entry.trim());
}

function finalAssistantText(event: unknown): string[] {
	const obj = asRecord(event);
	if (!obj || obj.type !== "message_end") return [];
	const message = asRecord(obj.message);
	if (message?.role !== "assistant") return [];
	return textFromContent(message.content);
}

function numberField(obj: Record<string, unknown> | undefined, keys: string[]): number | undefined {
	if (!obj) return undefined;
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function modelFromRegistry(modelRegistry: unknown, modelId: string | undefined): unknown {
	if (!modelId || !modelId.includes("/")) return undefined;
	const registry = asRecord(modelRegistry);
	const find = registry?.find;
	if (typeof find !== "function") return undefined;
	const [provider, ...modelParts] = modelId.split("/");
	const id = modelParts.join("/");
	try {
		return find.call(modelRegistry, provider, id);
	} catch {
		return undefined;
	}
}

function liveSystemPrompt(input: LiveSessionSpawnInput): string {
	const memory = input.agent.memory ? buildMemoryBlock(input.agent.name, input.agent.memory, input.task.cwd, Boolean(input.agent.tools?.some((tool) => tool === "write" || tool === "edit"))) : "";
	return [
		"# pi-crew Live Subagent",
		`Run ID: ${input.manifest.runId}`,
		`Task ID: ${input.task.id}`,
		`Role: ${input.task.role}`,
		`Agent: ${input.agent.name}`,
		`Working directory: ${input.task.cwd}`,
		"",
		input.agent.systemPrompt || "Follow the user task exactly and report verification evidence.",
		memory ? `\n${memory}` : "",
	].filter(Boolean).join("\n");
}

function filterActiveTools(session: LiveSessionLike, agent: AgentConfig): void {
	if (typeof session.getActiveToolNames !== "function" || typeof session.setActiveToolsByName !== "function") return;
	const recursiveTools = new Set(["team", "Team", "Agent", "get_subagent_result", "steer_subagent"]);
	const allowed = agent.tools?.length ? new Set(agent.tools) : undefined;
	const active = session.getActiveToolNames().filter((name) => !recursiveTools.has(name) && (!allowed || allowed.has(name)));
	session.setActiveToolsByName(active);
}

function usageFromStats(stats: unknown): UsageState | undefined {
	const obj = asRecord(stats);
	if (!obj) return undefined;
	const input = numberField(obj, ["input", "inputTokens", "input_tokens"]);
	const output = numberField(obj, ["output", "outputTokens", "output_tokens"]);
	const cacheRead = numberField(obj, ["cacheRead", "cache_read"]);
	const cacheWrite = numberField(obj, ["cacheWrite", "cache_write"]);
	const cost = numberField(obj, ["cost"]);
	const turns = numberField(obj, ["turns", "turnCount", "turn_count"]);
	return [input, output, cacheRead, cacheWrite, cost, turns].some((value) => value !== undefined) ? { input, output, cacheRead, cacheWrite, cost, turns } : undefined;
}

export async function probeLiveSessionRuntime(): Promise<LiveSessionUnavailableResult | LiveSessionPlannedResult> {
	const availability = await isLiveSessionRuntimeAvailable();
	if (!availability.available) return { available: false, reason: availability.reason ?? "Live-session runtime is unavailable." };
	return { available: true, reason: "Live-session SDK exports are available and pi-crew can run experimental in-process live agents when runtime.mode=live-session." };
}

export async function runLiveSessionTask(input: LiveSessionSpawnInput): Promise<LiveSessionRunResult> {
	const isCurrent = input.isCurrent ?? (() => true);
	if (process.env.PI_CREW_MOCK_LIVE_SESSION === "success") {
		const agentId = `${input.manifest.runId}:${input.task.id}`;
		const inherited = input.runtimeConfig?.inheritContext === true && input.parentContext ? ` with inherited context: ${input.parentContext}` : "";
		const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Mock live-session success for ${input.agent.name}${inherited}` }] } };
		const mockSession = { steer: async () => {}, prompt: async () => {}, abort: async () => {} };
		registerLiveAgent({ agentId, runId: input.manifest.runId, taskId: input.task.id, session: mockSession, status: "running" });
		appendTranscript(input.transcriptPath, event);
		const sidechainPath = sidechainOutputPath(input.manifest.stateRoot, input.task.id);
		writeSidechainEntry(sidechainPath, { agentId, type: "user", message: { role: "user", content: input.prompt }, cwd: input.task.cwd });
		writeSidechainEntry(sidechainPath, { agentId, type: "message", message: event, cwd: input.task.cwd });
		if (isCurrent()) input.onEvent?.(event);
		const stdout = `Mock live-session success for ${input.agent.name}${inherited}`;
		if (isCurrent()) input.onOutput?.(stdout);
		updateLiveAgentStatus(agentId, "completed");
		return { available: true, exitCode: 0, stdout, stderr: "", jsonEvents: 1 };
	}
	const availability = await isLiveSessionRuntimeAvailable();
	if (!availability.available) return { available: true, exitCode: 1, stdout: "", stderr: availability.reason ?? "Live-session runtime unavailable.", jsonEvents: 0, error: availability.reason };
	const mod = await import("@mariozechner/pi-coding-agent") as LiveSessionModule;
	if (typeof mod.createAgentSession !== "function") return { available: true, exitCode: 1, stdout: "", stderr: "createAgentSession export is unavailable.", jsonEvents: 0, error: "createAgentSession export is unavailable." };
	let session: LiveSessionLike | undefined;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeControlRealtime: (() => void) | undefined;
	let controlTimer: ReturnType<typeof setInterval> | undefined;
	let stdout = "";
	let jsonEvents = 0;
	try {
		const agentDir = typeof mod.getAgentDir === "function" ? mod.getAgentDir() : undefined;
		let resourceLoader: unknown;
		if (mod.DefaultResourceLoader && agentDir) {
			resourceLoader = new mod.DefaultResourceLoader({
				cwd: input.task.cwd,
				agentDir,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: input.runtimeConfig?.inheritContext !== true,
				systemPromptOverride: () => liveSystemPrompt(input),
				appendSystemPromptOverride: () => [],
			});
			await (resourceLoader as { reload?: () => Promise<void> }).reload?.();
		}
		const resolvedModel = modelFromRegistry(input.modelRegistry, input.agent.model) ?? input.parentModel;
		const created = await mod.createAgentSession({
			cwd: input.task.cwd,
			...(agentDir ? { agentDir } : {}),
			...(resourceLoader ? { resourceLoader } : {}),
			...(mod.SessionManager?.inMemory ? { sessionManager: mod.SessionManager.inMemory(input.task.cwd) } : {}),
			...(mod.SettingsManager?.create && agentDir ? { settingsManager: mod.SettingsManager.create(input.task.cwd, agentDir) } : {}),
			...(input.modelRegistry ? { modelRegistry: input.modelRegistry } : {}),
			...(resolvedModel ? { model: resolvedModel } : {}),
			...(input.agent.thinking ? { thinkingLevel: input.agent.thinking } : {}),
		});
		session = created.session;
		filterActiveTools(session, input.agent);
		await session.bindExtensions?.({});
		const agentId = `${input.manifest.runId}:${input.task.id}`;
		registerLiveAgent({ agentId, runId: input.manifest.runId, taskId: input.task.id, session, status: "running" });
		let controlCursor: LiveAgentControlCursor = { offset: 0 };
		const seenControlRequestIds = new Set<string>();
		let controlBusy = false;
		const pollControl = async () => {
			if (!isCurrent() || controlBusy || !session) return;
			controlBusy = true;
			try {
				controlCursor = await applyLiveAgentControlRequests({ manifest: input.manifest, taskId: input.task.id, agentId, session, cursor: controlCursor, seenRequestIds: seenControlRequestIds });
			} finally {
				controlBusy = false;
			}
		};
		unsubscribeControlRealtime = subscribeLiveControlRealtime((request) => {
			if (!isCurrent() || request.runId !== input.manifest.runId || request.taskId !== input.task.id || !session) return;
			void applyLiveAgentControlRequest({ request, taskId: input.task.id, agentId, session, seenRequestIds: seenControlRequestIds });
		});
		await pollControl();
		controlTimer = setInterval(() => {
			if (isCurrent()) void pollControl();
		}, 500);
		let turnCount = 0;
		let softLimitReached = false;
		const maxTurns = input.runtimeConfig?.maxTurns;
		const graceTurns = input.runtimeConfig?.graceTurns ?? 5;
		const sidechainPath = sidechainOutputPath(input.manifest.stateRoot, input.task.id);
		writeSidechainEntry(sidechainPath, { agentId, type: "user", message: { role: "user", content: input.prompt }, cwd: input.task.cwd });
		if (typeof session.subscribe === "function") {
			unsubscribe = session.subscribe((event) => {
				if (!isCurrent()) return;
				jsonEvents += 1;
				appendTranscript(input.transcriptPath, event);
				const sidechainType = eventToSidechainType(event);
				if (sidechainType) writeSidechainEntry(sidechainPath, { agentId, type: sidechainType, message: event, cwd: input.task.cwd });
				const obj = asRecord(event);
				if (obj?.type === "turn_end") {
					turnCount += 1;
					if (maxTurns !== undefined && !softLimitReached && turnCount >= maxTurns) {
						softLimitReached = true;
						void session?.steer?.("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
					} else if (maxTurns !== undefined && softLimitReached && turnCount >= maxTurns + graceTurns) {
						void session?.abort?.();
					}
				}
				input.onEvent?.(event);
				const text = [...eventText(event), ...finalAssistantText(event)].join("\n");
				if (text.trim()) {
					stdout += `${text}\n`;
					input.onOutput?.(text);
				}
			});
		}
		if (input.signal) {
			if (input.signal.aborted) await session.abort?.();
			else input.signal.addEventListener("abort", () => { void session?.abort?.(); }, { once: true });
		}
		const effectivePrompt = input.runtimeConfig?.inheritContext === true && input.parentContext ? `${input.parentContext}\n\n---\n# Live Subagent Task\n${input.prompt}` : input.prompt;
		await session.prompt?.(effectivePrompt, { source: "api", expandPromptTemplates: false });
		const usage = usageFromStats(typeof session.getStats === "function" ? session.getStats() : session.stats);
		updateLiveAgentStatus(agentId, "completed");
		return { available: true, exitCode: 0, stdout: stdout.trim(), stderr: created.modelFallbackMessage ?? "", jsonEvents, usage };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		updateLiveAgentStatus(`${input.manifest.runId}:${input.task.id}`, "failed");
		return { available: true, exitCode: 1, stdout: stdout.trim(), stderr: message, jsonEvents, error: message };
	} finally {
		if (controlTimer) clearInterval(controlTimer);
		unsubscribeControlRealtime?.();
		unsubscribe?.();
	}
}
