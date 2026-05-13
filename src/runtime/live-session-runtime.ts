import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewRuntimeConfig } from "../config/config.ts";
import type { TeamRunManifest, TeamTaskState, UsageState } from "../state/types.ts";
import { buildMemoryBlock } from "./agent-memory.ts";
import { trackTaskUsage } from "./usage-tracker.ts";
import { createStreamingOutput, type StreamingOutputHandle } from "./streaming-output.ts";
import { registerLiveAgent, disposeLiveAgentSession, terminateLiveAgent, updateLiveAgentStatus, trackLiveAgentToolStart, trackLiveAgentToolEnd, trackLiveAgentTurnEnd, trackLiveAgentResponseText, markLiveAgentCompleted } from "./live-agent-manager.ts";
import { applyLiveAgentControlRequest, applyLiveAgentControlRequests, type LiveAgentControlCursor } from "./live-agent-control.ts";
import { subscribeLiveControlRealtime } from "./live-control-realtime.ts";
import { eventToSidechainType, sidechainOutputPath, writeSidechainEntry } from "./sidechain-output.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";
import { isLiveSessionRuntimeAvailable } from "./runtime-resolver.ts";
import { redactSecrets } from "../utils/redaction.ts";
import { buildConfiguredModelRouting } from "./model-fallback.ts";
import { DEFAULT_LIVE_SESSION } from "../config/defaults.ts";
import { buildYieldReminder, hasYieldInOutput, isYieldEvent, extractYieldResult, validateYieldData, DEFAULT_YIELD_CONFIG, type YieldResult } from "./yield-handler.ts";
import { buildMcpProxyFromSession } from "./mcp-proxy.ts";
import { createSubmitResultTool } from "./custom-tools/submit-result-tool.ts";
import { createIrcTool } from "./custom-tools/irc-tool.ts";
import { buildExtensionBridge } from "./live-extension-bridge.ts";
import { logInternalError } from "../utils/internal-error.ts";
// prose-compressor imported for custom tool descriptions below;
// tool description compression for SDK-managed tools awaits SDK support.
import { compressToolDescription } from "./prose-compressor.ts";
import { buildSensitivePathConstraint } from "./sensitive-paths.ts";
import { collectLiveSessionHealth, formatLiveSessionDiagnostics, type LiveSessionHealth } from "./live-session-health.ts";
import { listLiveAgents } from "./live-agent-manager.ts";

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
	modelOverride?: string;
	teamRoleModel?: string;
	isCurrent?: () => boolean;
	/** Phase 2: Output schema for validating yield data. */
	outputSchema?: unknown;
}

export interface LiveSessionRunResult {
	available: true;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	jsonEvents: number;
	usage?: UsageState;
	error?: string;
	/** Phase 1: Extracted yield result from submit_result tool call. */
	yieldResult?: YieldResult;
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
	dispose?: () => void;
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

/** Communication intensity by role (caveman-inspired token optimization) */
const ROLE_INTENSITY: Record<string, "lite" | "full" | "ultra"> = {
	explorer: "ultra",
	analyst: "full",
	planner: "full",
	critic: "full",
	executor: "full",
	reviewer: "full",
	"security-reviewer": "full",
	"test-engineer": "full",
	verifier: "full",
	writer: "lite",
};

function buildCommunicationStyle(role: string): string {
	const intensity = ROLE_INTENSITY[role] ?? "full";
	if (intensity === "lite") return "## Communication\nProfessional concise. No filler/hedging. Full sentences OK.";
	if (intensity === "ultra") return [
		"## Communication (ultra-compressed)",
		"Drop: articles, filler, hedging, pleasantries. Fragments OK.",
		"Pattern: [thing] [action] [reason].",
		"Code/paths/symbols: exact, never abbreviated. Errors quoted exact.",
		"Abbreviate prose words: DB/auth/config/req/res/fn/impl.",
		"Arrows for causality: X → Y. One word when one word enough.",
		"Security/destructive: write normal English. Resume compressed after.",
	].join("\n");
	return [
		"## Communication (compressed)",
		"Drop: articles (a/an/the), filler (just/really/basically/actually/simply), hedging, pleasantries.",
		"Short synonyms. Fragments OK. Pattern: [thing] [action] [reason]. [next step].",
		"Code/paths/symbols: exact. Errors quoted exact.",
		"Security/destructive: write normal English. Resume compressed after.",
	].join("\n");
}

function buildOutputContract(role: string): string {
	if (role === "explorer") return [
		"## Output Contract",
		"<path>:<line> — `<symbol>` — <≤6 word note>",
		"Group: Defs: / Refs: / Callers: / Tests: / Sites:",
		"Zero hits → \"No match.\"",
		"Last line → totals: N defs, M refs.",
	].join("\n");
	if (role === "executor") return [
		"## Output Contract",
		"<path>:<line-range> — <change ≤10 words>.",
		"verified: <re-read OK | mismatch @ path:line>.",
		"Refusal tokens: too-big. / needs-confirm. / ambiguous. / regressed.",
	].join("\n");
	if (role === "reviewer" || role === "security-reviewer") return [
		"## Output Contract",
		"<path>:<line>: <emoji> <severity>: <problem>. <fix>.",
		"Severity: 🔴 bug, 🟡 risk, 🔵 nit, ❓ question.",
		"Zero findings → \"No issues.\"",
		"Sorted: file order → ascending line numbers.",
	].join("\n");
	if (role === "verifier") return [
		"## Output Contract",
		"PASS: <what verified> — <evidence ≤20 words>.",
		"FAIL: <what failed> — <reason>. <expected vs actual>.",
		"Evidence: file paths, test output, or diffs.",
	].join("\n");
	if (role === "writer") return "## Output Contract\nWrite clear documentation. Full sentences. No compression.";
	return ""; // planner, critic, analyst, test-engineer: no strict format
}

/**
 * Phase 3 (caveman): Compress tool descriptions in a live session to reduce
 * input token cost per tool call. MCP tools often have verbose descriptions
 * (e.g. "This tool allows you to search for files in the filesystem..." → "Search files in filesystem.").
 * Compresses only description text, never modifies tool names or parameters.
 */
function compressSessionToolDescriptions(session: LiveSessionLike): void {
	if (typeof session.getActiveToolNames !== "function") return;
	// The Pi SDK doesn't expose a setDescription API, but we can attempt
	// to compress via setActiveToolsByName if the session supports it.
	// For now, this is a no-op that documents the intent for future SDK support.
	// When Pi SDK adds tool description mutation, this function will compress.
	// Side benefit: the import of compressToolDescription ensures the module
	// is loaded and tree-shakeable, so adding the actual logic later is trivial.
}

function liveSystemPrompt(input: LiveSessionSpawnInput): string {
	const memory = input.agent.memory ? buildMemoryBlock(input.agent.name, input.agent.memory, input.task.cwd, Boolean(input.agent.tools?.some((tool) => tool === "write" || tool === "edit"))) : "";
	const role = input.task.role;
	const styleBlock = buildCommunicationStyle(role);
	const contractBlock = buildOutputContract(role);
	const sensitiveConstraint = buildSensitivePathConstraint();
	return [
		"# pi-crew Live Subagent",
		`Run ID: ${input.manifest.runId}`,
		`Task ID: ${input.task.id}`,
		`Role: ${role}`,
		`Agent: ${input.agent.name}`,
		`Working directory: ${input.task.cwd}`,
		"",
		styleBlock,
		contractBlock,
		sensitiveConstraint,
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

async function promptWithTimeout(session: LiveSessionLike, text: string, timeoutMs: number, label: string): Promise<boolean> {
	const promptPromise = session.prompt?.(text, { source: "api", expandPromptTemplates: false });
	if (!promptPromise) return false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promptPromise,
			new Promise<void>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
				timer.unref?.();
			}),
		]);
		return true;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function probeLiveSessionRuntime(): Promise<LiveSessionUnavailableResult | LiveSessionPlannedResult> {
	const availability = await isLiveSessionRuntimeAvailable();
	if (!availability.available) return { available: false, reason: availability.reason ?? "Live-session runtime is unavailable." };
	return { available: true, reason: "Live-session SDK exports are available. pi-crew can run in-process live agents when runtime.mode=live-session." };
}

export async function runLiveSessionTask(input: LiveSessionSpawnInput): Promise<LiveSessionRunResult> {
	const isCurrent = input.isCurrent ?? (() => true);
	let streamOut: StreamingOutputHandle | undefined;

	// G1: Capture yield result from custom tool callback
	let customToolYieldResult: YieldResult | undefined;
	let customToolYieldResolved = false;
	if (process.env.PI_CREW_MOCK_LIVE_SESSION === "success") {
		const agentId = `${input.manifest.runId}:${input.task.id}`;
		const inherited = input.runtimeConfig?.inheritContext === true && input.parentContext ? ` with inherited context: ${input.parentContext}` : "";
		const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Mock live-session success for ${input.agent.name}${inherited}` }] } };
		const mockSession = { steer: async () => {}, prompt: async () => {}, abort: async () => {} };
		registerLiveAgent({ agentId, runId: input.manifest.runId, taskId: input.task.id, role: input.task.role, agent: input.agent?.name ?? "mock", description: "mock", session: mockSession, status: "running" });
		appendTranscript(input.transcriptPath, event);
		const sidechainPath = sidechainOutputPath(input.manifest.stateRoot, input.task.id);
		writeSidechainEntry(sidechainPath, { agentId, type: "user", message: { role: "user", content: input.prompt }, cwd: input.task.cwd });
		writeSidechainEntry(sidechainPath, { agentId, type: "message", message: event, cwd: input.task.cwd });
		if (isCurrent()) input.onEvent?.(event);
		const stdout = `Mock live-session success for ${input.agent.name}${inherited}`;
		if (isCurrent()) input.onOutput?.(stdout);
		updateLiveAgentStatus(agentId, "completed");
		markLiveAgentCompleted(agentId);
		return { available: true, exitCode: 0, stdout, stderr: "", jsonEvents: 1 };
	}
	const availability = await isLiveSessionRuntimeAvailable();
	if (!availability.available) return { available: true, exitCode: 1, stdout: "", stderr: availability.reason ?? "Live-session runtime unavailable.", jsonEvents: 0, error: availability.reason };
	// LAZY: optional peer dependency — only loaded when live-session runtime is chosen.
	const mod = await import("@mariozechner/pi-coding-agent") as LiveSessionModule;
	if (typeof mod.createAgentSession !== "function") return { available: true, exitCode: 1, stdout: "", stderr: "createAgentSession export is unavailable.", jsonEvents: 0, error: "createAgentSession export is unavailable." };
	let session: LiveSessionLike | undefined;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeControlRealtime: (() => void) | undefined;
	let controlTimer: ReturnType<typeof setInterval> | undefined;
	let stdout = "";
	let jsonEvents = 0;
	const collectedJsonEvents: Record<string, unknown>[] = [];
	const maxCollectedJsonEvents = 1000;
	let yieldResult: YieldResult | undefined;

	const agentId = `${input.manifest.runId}:${input.task.id}`;

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
		const modelRouting = buildConfiguredModelRouting({ overrideModel: input.modelOverride, stepModel: input.step.model, teamRoleModel: input.teamRoleModel, agentModel: input.agent.model, fallbackModels: input.agent.fallbackModels, parentModel: input.parentModel, modelRegistry: input.modelRegistry, cwd: input.manifest.cwd });
		const resolvedModel = modelFromRegistry(input.modelRegistry, modelRouting.candidates[0] ?? modelRouting.requested) ?? input.parentModel;
		// Phase 4: MCP proxy — will be determined after session creation
		// (we check parent's MCP tools and share connections when available)
		const mcpProxy = buildMcpProxyFromSession([], { shareMcp: true });

		// G1: Build custom tools (submit_result + irc)
		const submitResultTool = createSubmitResultTool((result) => {
			customToolYieldResult = result;
			customToolYieldResolved = true;
		});
		const ircTool = createIrcTool(agentId);
		const customTools = [submitResultTool, ircTool];

		const created = await mod.createAgentSession({
			cwd: input.task.cwd,
			...(agentDir ? { agentDir } : {}),
			...(resourceLoader ? { resourceLoader } : {}),
			...(mod.SessionManager?.inMemory ? { sessionManager: mod.SessionManager.inMemory(input.task.cwd) } : {}),
			...(mod.SettingsManager?.create && agentDir ? { settingsManager: mod.SettingsManager.create(input.task.cwd, agentDir) } : {}),
			...(input.modelRegistry ? { modelRegistry: input.modelRegistry } : {}),
			...(resolvedModel ? { model: resolvedModel } : {}),
			...(input.agent.thinking ? { thinkingLevel: input.agent.thinking } : {}),
			...(mcpProxy.enableMcp ? {} : { enableMCP: false }),
			customTools,
		});
		session = created.session;
		filterActiveTools(session, input.agent);
		await session.bindExtensions?.({});

		// Phase 3 (caveman): Compress tool descriptions to reduce input token cost
		compressSessionToolDescriptions(session);

		// Phase 5: Initialize extension runner bridge if available
		// The bridge provides extension-like APIs (sendMessage, setActiveTools, etc.)
		// to the extension runner if the session exposes one.
		const extensionBridge = buildExtensionBridge(session as never);
		if (extensionBridge) {
			const extRunner = (session as Record<string, unknown>).extensionRunner;
			if (extRunner && typeof (extRunner as Record<string, unknown>).initialize === "function") {
				try {
					(extRunner as { initialize: (apis: unknown, host: unknown) => void }).initialize(extensionBridge.apis, extensionBridge.host);
					if (typeof (extRunner as Record<string, unknown>).emit === "function") {
						await (extRunner as { emit: (event: unknown) => Promise<void> }).emit({ type: "session_start" });
					}
				} catch {
					// Extension runner initialization failure should not block the session
				}
			}
		}

		registerLiveAgent({ agentId, runId: input.manifest.runId, taskId: input.task.id, role: input.task.role, agent: input.agent?.name ?? "unknown", description: input.task.adaptive?.task ?? input.step?.task ?? "", modelName: (resolvedModel as { name?: string })?.name, session, status: "running" });
		streamOut = createStreamingOutput(input.manifest, input.task.id);
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
					trackLiveAgentTurnEnd(agentId);
					if (maxTurns !== undefined && !softLimitReached && turnCount >= maxTurns) {
						softLimitReached = true;
						void session?.steer?.("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
					} else if (maxTurns !== undefined && softLimitReached && turnCount >= maxTurns + graceTurns) {
						void session?.abort?.();
					}
				}
				// Accumulate lifetime usage that survives compaction
				if (obj?.type === "message_end" && (obj as any).message?.role === "assistant") {
					const u = (obj as any).message?.usage;
					if (u) {
						trackTaskUsage(input.task.id, {
							input: typeof u.input === "number" ? u.input : 0,
							output: typeof u.output === "number" ? u.output : 0,
							cacheWrite: typeof u.cacheWrite === "number" ? u.cacheWrite : 0,
						});
					}
				}
				input.onEvent?.(event);
				const text = [...eventText(event), ...finalAssistantText(event)].join("\n");
				if (text.trim()) {
					stdout += `${text}\n`;
					streamOut?.write(text + "\n");
					trackLiveAgentResponseText(agentId, text);
					input.onOutput?.(text);
				}
				// G2: Track tool start/end for activity display
				if (obj?.type === "tool_use" || obj?.type === "tool_execution_start") {
					const toolName = (obj as any).tool?.name ?? (obj as any).name ?? "unknown";
					trackLiveAgentToolStart(agentId, toolName);
				}
				if (obj?.type === "tool_result" || obj?.type === "tool_execution_end") {
					const toolName = (obj as any).tool?.name ?? (obj as any).name ?? "unknown";
					trackLiveAgentToolEnd(agentId, toolName);
				}
				// Phase 1: collect events for yield detection
				if (event && typeof event === "object" && !Array.isArray(event)) {
					collectedJsonEvents.push(event as Record<string, unknown>);
					if (collectedJsonEvents.length > maxCollectedJsonEvents) collectedJsonEvents.splice(0, collectedJsonEvents.length - maxCollectedJsonEvents);
				}
			});
		}
		if (input.signal) {
			if (input.signal.aborted) await session.abort?.();
			else input.signal.addEventListener("abort", () => { void session?.abort?.(); }, { once: true });
		}
		const effectivePrompt = input.runtimeConfig?.inheritContext === true && input.parentContext ? `${input.parentContext}\n\n---\n# Live Subagent Task\n${input.prompt}` : input.prompt;

		// Phase 3: Wrap session.prompt with timeout for graceful cancellation
		const sessionTimeoutMs = DEFAULT_LIVE_SESSION.responseTimeoutMs;
		try {
			await promptWithTimeout(session, effectivePrompt, sessionTimeoutMs, "Live-session");
		} catch (promptError) {
			const msg = promptError instanceof Error ? promptError.message : String(promptError);
			if (msg.includes("timed out")) {
				await session.abort?.();
				updateLiveAgentStatus(agentId, "failed");
				return { available: true, exitCode: 1, stdout: stdout.trim(), stderr: msg, jsonEvents, error: msg };
			}
			throw promptError;
		}

		// --- Phase 1: Yield enforcement loop ---
		// After the initial prompt completes, check if the worker called submit_result.
		// Priority: 1) custom tool callback (G1), 2) JSON event detection (legacy).
		const yieldConfig = input.runtimeConfig?.yield ?? { enabled: DEFAULT_YIELD_CONFIG.enabled };
		const yieldEnabled = yieldConfig.enabled !== false;
		if (yieldEnabled && session) {
			// Check custom tool callback first (G1)
			if (customToolYieldResolved && customToolYieldResult) {
				yieldResult = customToolYieldResult;
			} else {
				// Legacy: detect from JSON events
				const alreadyYielded = hasYieldInOutput(collectedJsonEvents);
				if (alreadyYielded) {
					const yieldEvent = collectedJsonEvents.find((e) => isYieldEvent(e));
					if (yieldEvent) yieldResult = extractYieldResult(yieldEvent);
				}
			}
			// Phase 2: Validate yield data against output schema if provided
			let schemaFailures = 0;
			const maxSchemaFailures = 2;
			if (yieldResult && input.outputSchema) {
				const validation = await validateYieldData(yieldResult.structuredData, input.outputSchema);
				if (!validation.valid) {
					schemaFailures++;
					yieldResult = undefined;
					customToolYieldResolved = false;
					const schemaReminder = `Your submit_result data did not match the required schema: ${validation.error}. Please fix and call submit_result again with valid data.`;
					try {
						await promptWithTimeout(session, schemaReminder, Math.min(sessionTimeoutMs, DEFAULT_LIVE_SESSION.idleWaitTimeoutMs), "Live-session schema reminder");
					} catch {
						/* ignore */
					}
					await new Promise((resolve) => setTimeout(resolve, DEFAULT_LIVE_SESSION.yieldPollIntervalMs));
					// Check again after schema reminder
					if (customToolYieldResolved && customToolYieldResult) {
						yieldResult = customToolYieldResult;
					} else {
						const newEvents = collectedJsonEvents.slice(-10);
						if (hasYieldInOutput(newEvents)) {
							const yieldEvent = newEvents.find((e) => isYieldEvent(e));
							if (yieldEvent) {
								const candidate = extractYieldResult(yieldEvent);
								if (candidate && input.outputSchema) {
									const revalidation = await validateYieldData(candidate.structuredData, input.outputSchema);
									if (revalidation.valid || schemaFailures >= maxSchemaFailures) {
										yieldResult = candidate;
									}
								}
							}
						}
					}
				}
			}
			// Reminder loop — only if yield not yet received
			const maxReminders = yieldConfig.maxReminders ?? DEFAULT_LIVE_SESSION.maxYieldRetries;
			let retryCount = 0;
			while (!customToolYieldResolved && !yieldResult && retryCount < maxReminders && !input.signal?.aborted) {
				retryCount++;
				const reminder = buildYieldReminder(retryCount, maxReminders, yieldConfig.reminderPrompt);
				const prevTools = typeof session.getActiveToolNames === "function" ? session.getActiveToolNames() : [];
				try {
					// G6: Constrain tool set to submit_result before sending reminder
					if (typeof session.setActiveToolsByName === "function" && prevTools.length > 0) {
						session.setActiveToolsByName(["submit_result"]);
					}
					await promptWithTimeout(session, reminder, Math.min(sessionTimeoutMs, DEFAULT_LIVE_SESSION.idleWaitTimeoutMs), "Live-session yield reminder");
				} catch {
					break;
				} finally {
					// Restore previous tools even if reminder prompt times out/throws.
					if (typeof session.setActiveToolsByName === "function" && prevTools.length > 0) {
						session.setActiveToolsByName(prevTools);
					}
				}
				const pollInterval = DEFAULT_LIVE_SESSION.yieldPollIntervalMs;
				await new Promise((resolve) => setTimeout(resolve, pollInterval));
				// Check custom tool callback
				if (customToolYieldResolved && customToolYieldResult) {
					yieldResult = customToolYieldResult;
					break;
				}
				// Legacy: check JSON events
				if (hasYieldInOutput(collectedJsonEvents.slice(-10))) {
					const yieldEvent = collectedJsonEvents.slice(-10).find((e) => isYieldEvent(e));
					if (yieldEvent) yieldResult = extractYieldResult(yieldEvent);
					break;
				}
			}
			if (!customToolYieldResolved && !yieldResult && !input.signal?.aborted && retryCount >= maxReminders) {
				input.onEvent?.({ type: "task.attention", runId: input.manifest.runId, taskId: input.task.id, message: "Live-session worker completed without calling submit_result tool.", data: { activityState: "needs_attention", reason: "no_yield", attempts: retryCount } });
			}
		}

		const usage = usageFromStats(typeof session.getStats === "function" ? session.getStats() : session.stats);
		updateLiveAgentStatus(agentId, "completed");
		markLiveAgentCompleted(agentId);
		return { available: true, exitCode: 0, stdout: stdout.trim(), stderr: created.modelFallbackMessage ?? "", jsonEvents, usage, yieldResult };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		// Phase 8: Log diagnostics on failure
		try {
			const agents = listLiveAgents();
			const health = collectLiveSessionHealth(agents, () => undefined);
			const diagnostics = formatLiveSessionDiagnostics(health);
			input.onEvent?.({ type: "live-session.diagnostics", data: diagnostics });
		} catch (diagError) {
			logInternalError("live-session.diagnostics", diagError);
		}

		updateLiveAgentStatus(`${input.manifest.runId}:${input.task.id}`, "failed");
		return { available: true, exitCode: 1, stdout: stdout.trim(), stderr: message, jsonEvents, error: message };
	} finally {
		// H6: Unsubscribe listeners FIRST before clearing timer to prevent race
		unsubscribe?.();
		unsubscribeControlRealtime?.();
		if (controlTimer) clearInterval(controlTimer);
		streamOut?.close();
		if (input.signal?.aborted) {
			await terminateLiveAgent(agentId, "cancelled");
		} else {
			// Dispose the session to free resources, but keep the handle in the registry
			// for resume/follow-up. Removing the handle entirely breaks steer/followUp/resume.
			disposeLiveAgentSession(agentId);
		}

		// Phase 8: Emit final health snapshot
		try {
			const agents = listLiveAgents();
			if (agents.length > 0) {
				const health = collectLiveSessionHealth(agents, () => undefined);
				input.onEvent?.({ type: "live-session.health", data: health });
			}
		} catch (healthError) {
			logInternalError("live-session.health-snapshot", healthError);
		}
	}
}
