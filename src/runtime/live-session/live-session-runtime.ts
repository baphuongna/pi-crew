import * as path from "node:path";
import { DEFAULT_LIVE_SESSION } from "../../config/defaults.ts";
import { getCrewEnv } from "../../config/env-vars.ts";
import { appendEvent, appendEventFireAndForget } from "../../state/event-log/event-log.ts";
import type { UsageState } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { redactSecrets } from "../../utils/redaction.ts";
import { BoundedTail } from "../compaction/compact-stages/bounded-tail.ts";
import { createIrcTool } from "../custom-tools/irc-tool.ts";
import { createSubmitResultTool } from "../custom-tools/submit-result-tool.ts";
import {
	foreignMcpExtensionsAgainstAllowlist,
	g2EnforcementDegradationReason,
	McpForeignExtensionError,
	mcpPermittedForRole,
	shouldFailClosedMcpEnforcement,
	stripMcpExtensions,
} from "../mcp-proxy.ts";
import { buildConfiguredModelRouting, modelRefToString, warnOutOfScopeSoft } from "../model/model-fallback.ts";
import { isLiveSessionRuntimeAvailable } from "../model/runtime-resolver.ts";
import { awaitRuntimeWarmup } from "../model/runtime-warmup.ts";
import { liveAgentContext, registerLiveAgentModel, unregisterLiveAgentModel } from "../model/session-model.ts";
import {
	appendBatchedJsonlLine,
	eventToSidechainType,
	flushPendingSidechainWrites,
	sidechainOutputPath,
	writeSidechainEntry,
} from "../output/sidechain-output.ts";
// NOTE: buildMemoryBlock is intentionally NOT imported here. The agent memory
// block is injected via renderTaskPrompt().full (the USER prompt), which is
// shared by both the child-pi path (no system prompt) and the live-session
// path. Adding it to liveSystemPrompt() too duplicated the entire memory
// block (up to 200 lines) in both the user and system prompts. Keep memory
// in a single place: the shared user prompt. See G3 fix.
import { createStreamingOutput, type StreamingOutputHandle } from "../output/streaming-output.ts";
import {
	buildYieldReminder,
	DEFAULT_YIELD_CONFIG,
	extractYieldResult,
	hasYieldInOutput,
	isYieldEvent,
	validateYieldData,
	type YieldResult,
} from "../yield-handler.ts";
import {
	admitEmbeddedSession,
	applyEmbeddedProviderTimeout,
	armTurnWatchdog,
	buildEmbeddedEventSink,
	classifyEmbeddedCatchFault,
	EMBEDDED_DEFAULT_WATCHDOG_GRACE_MS,
	type EmbeddedAdmissionHandle,
	type EmbeddedEventSink,
	enforceEmbeddedBuiltinTools,
	finalizeEmbeddedFaultCheck,
	LiveSessionEmbeddedEnforcementError,
	type LiveSessionFault,
	LiveSessionTurnWatchdogError,
	maybeEmitEmbeddedMemoryMetrics,
	type TurnWatchdogHandle,
} from "./embedded-tier.ts";
import { applyLiveAgentControlRequest, applyLiveAgentControlRequests, type LiveAgentControlCursor } from "./live-agent-control.ts";
import {
	disposeLiveAgentSession,
	dropLiveAgentReference,
	listLiveAgents,
	markLiveAgentCompleted,
	registerLiveAgent,
	terminateLiveAgent,
	trackLiveAgentResponseText,
	trackLiveAgentToolEnd,
	trackLiveAgentToolStart,
	trackLiveAgentTurnEnd,
	updateLiveAgentStatus,
} from "./live-agent-manager.ts";
import { hasLiveControlRealtimeListeners, subscribeLiveControlRealtime } from "./live-control-realtime.ts";
import { buildExtensionBridge } from "./live-extension-bridge.ts";
import { collectLiveSessionHealth, formatLiveSessionDiagnostics } from "./live-session-health.ts";
import {
	applyModelProviderOverride,
	compressSessionToolDescriptions,
	filterActiveTools,
	type LiveSessionLike,
	type LiveSessionSpawnInput,
	liveSystemPrompt,
	modelFromRegistry,
	resolveLiveDefaultSubagentModel,
	resolveLiveModelFallbackPolicy,
	resolveParentModelFromRegistry,
	resolveScopedSessionModels,
	resolveScopeModelsPatterns,
} from "./live-session-prompt-models.ts";
import {
	asRecord,
	eventText,
	extractToolName,
	faultPathUsage,
	finalAssistantText,
	trackUsageFromMessageEndEvent,
	usageFromSessionStats,
} from "./usage-bridge.ts";

export type { LiveSessionSpawnInput } from "./live-session-prompt-models.ts";
export { liveSystemPrompt, resolveParentModelFromRegistry, resolveScopedSessionModels } from "./live-session-prompt-models.ts";

/**
 * Module-scoped latch for the optional peer dependency import. When N
 * in-process live-session subagents spawn CONCURRENTLY (e.g. several
 * `Agent({run_in_background:true})` started at once), each used to call
		// LAZY: defer dynamic import of @earendil-works/pi-coding-agent to its call site.
 * `await import("@earendil-works/pi-coding-agent")` independently. Under the
 * tsx loader (registering load/resolve hooks), concurrent first-imports can
 * each enter the loader and race module-record instantiation, yielding
 * `Cannot read properties of undefined (reading 'existsSync')` /
 * `'validateWorkflowForTeam'` as namespace bindings observed mid-evaluation.
 * Sequential retries always succeed → this is a cold-start race, not a logic
 * bug. ESM engines memoize imports, but that memoization is not guaranteed
 * to be observed synchronously across concurrent evaluation under transpiling
 * loaders, so we add an explicit JS-level latch: the first caller wins, every
 * later caller awaits the same in-flight promise. (Observed 2026-06-16 when 4
 * explorer subagents launched together; 3 of 4 crashed.)
 */
let liveSessionModulePromise: Promise<LiveSessionModule> | undefined;

/**
 * Phase 4 (ADR 2026-08-15-runtime-convergence, decision (a) — freeze):
 * warn-once flag so the experimental-path notice fires at most once per
 * process, not per task.
 */
let experimentalWarned = false;
function loadLiveSessionModule(): Promise<LiveSessionModule> {
	if (!liveSessionModulePromise) {
		liveSessionModulePromise = import("@earendil-works/pi-coding-agent") as unknown as Promise<LiveSessionModule>; // LAZY: defer pi-coding-agent live-session module until first use
	}
	return liveSessionModulePromise;
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
	/**
	 * U11: classified fault for the hybrid layer's 2-fault fallback budget.
	 * Attached only on the embedded path (embeddedMitigations present);
	 * `classifyLiveSessionFault()` (embedded-tier.ts) re-derives kinds for
	 * any result shape.
	 */
	fault?: LiveSessionFault;
	/** Model routing diagnostics for the task state. */
	modelRouting?: {
		requested?: string;
		resolved: string;
		fallbackChain: string[];
		reason?: string;
		droppedRequested?: string;
		autoFallbackCount?: number;
	};
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
	/**
	 * U4 fast path: build the expensive services (ModelRuntime +
	 * SettingsManager + reloaded ResourceLoader) ONCE per (cwd, mcp-mode,
	 * context) and fan out cheap per-task sessions from it via
	 * createAgentSessionFromServices. Measured on pi 1.0.4/1.1.0: services
	 * ≈224ms one-time, each child session 0.5–1.5ms vs ≈2240ms for the old
	 * full reload-per-worker path (probe /tmp/pi-crew-embed-probe/).
	 */
	createAgentSessionServices?: (options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
	createAgentSessionFromServices?: (options?: Record<string, unknown>) => Promise<{
		session: LiveSessionLike;
		modelFallbackMessage?: string;
	}>;
	/** Supplies the built-in mcp extension factory for MCP-permitted roles. */
	createMcpExtension?: (options?: Record<string, unknown>) => unknown;
	DefaultResourceLoader?: new (options: Record<string, unknown>) => { reload?: () => Promise<void> };
	SessionManager?: {
		inMemory?: (cwd?: string) => unknown;
		create?: (cwd?: string, sessionDir?: string) => unknown;
	};
	SettingsManager?: { create?: (cwd?: string, agentDir?: string) => unknown };
	getAgentDir?: () => string;
};

/**
 * U4 — shared live-session services bundle.
 *
 * `createAgentSessionServices` performs the expensive one-time work
 * (ModelRuntime.create + settings + DefaultResourceLoader.reload with full
 * extension/skill/theme discovery). Bundles are cached per (cwd, agentDir,
 * mcp-permission, context-files) — the axes that change WHAT the loader
 * discovers — so the first live worker in a mode pays the bundle cost and
 * every subsequent worker in the same mode creates its session in ~1ms.
 */
interface LiveSessionServicesBundle {
	cwd: string;
	agentDir: string;
	mcpPermitted: boolean;
	loadContextFiles: boolean;
	/** SDK AgentSessionServices ({cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics}). */
	services: Record<string, unknown>;
	resourceLoader: Record<string, unknown>;
	createdAtMs: number;
}

/** Cap: each bundle holds a ModelRuntime + loader (~15MB heap) — bound the cache. */
const MAX_LIVE_SESSION_SERVICES_BUNDLES = 8;

const liveSessionServicesCache = new Map<string, Promise<LiveSessionServicesBundle>>();

function liveSessionServicesCacheKey(cwd: string, agentDir: string, mcpPermitted: boolean, loadContextFiles: boolean): string {
	return [pathResolve(cwd), pathResolve(agentDir), mcpPermitted ? "mcp" : "nomcp", loadContextFiles ? "ctx" : "noctx"].join("|");
}

function pathResolve(input: string): string {
	try {
		return path.resolve(input);
	} catch {
		return input;
	}
}

/** Test seam: inspect the services bundle cache. */
export function liveSessionServicesCacheStatsForTest(): { size: number; keys: string[] } {
	return { size: liveSessionServicesCache.size, keys: [...liveSessionServicesCache.keys()] };
}

/** Test seam: drop all cached bundles (hermetic tests must not share bundles). */
export function clearLiveSessionServicesCacheForTest(): void {
	liveSessionServicesCache.clear();
}

/**
 * Get-or-build the shared services bundle. Failures delete the cache slot so a
 * later task can retry the build instead of latching a rejected promise.
 */
async function getOrCreateLiveSessionServices(
	mod: LiveSessionModule,
	input: { cwd: string; agentDir: string; mcpPermitted: boolean; loadContextFiles: boolean },
): Promise<LiveSessionServicesBundle> {
	const key = liveSessionServicesCacheKey(input.cwd, input.agentDir, input.mcpPermitted, input.loadContextFiles);
	let entry = liveSessionServicesCache.get(key);
	if (!entry) {
		if (liveSessionServicesCache.size >= MAX_LIVE_SESSION_SERVICES_BUNDLES) {
			// FIFO eviction — bundles are stateless services, evicting only drops
			// the warm cache (a later task rebuilds).
			const oldest = liveSessionServicesCache.keys().next().value;
			if (oldest !== undefined) liveSessionServicesCache.delete(oldest);
		}
		entry = (async () => {
			const services = await mod.createAgentSessionServices!({
				cwd: input.cwd,
				agentDir: input.agentDir,
				resourceLoaderOptions: {
					// U4 recursion kill switch (layer 0, loader level): NO discovered/
					// settings/package extensions load in the child — so the pi-crew
					// host extension itself cannot load+initialize inside a worker.
					noExtensions: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: !input.loadContextFiles,
					...(input.mcpPermitted && typeof mod.createMcpExtension === "function"
						? {
								// G2: MCP-permitted (write-capable) roles inherit the parent's
								// MCP servers via the built-in mcp extension ONLY — pinned
								// inline, nothing else loads alongside it.
								extensionFactories: [
									{
										name: "mcp",
										factory: mod.createMcpExtension(),
										builtin: true,
										replaceable: true,
									},
								],
								additionalExtensionPaths: ["builtin:mcp"],
							}
						: {}),
				},
			});
			const resourceLoader = asRecord(services?.resourceLoader);
			if (!resourceLoader) throw new Error("createAgentSessionServices returned no resourceLoader");
			return {
				cwd: input.cwd,
				agentDir: input.agentDir,
				mcpPermitted: input.mcpPermitted,
				loadContextFiles: input.loadContextFiles,
				services,
				resourceLoader,
				createdAtMs: Date.now(),
			};
		})();
		entry.catch(() => liveSessionServicesCache.delete(key));
		liveSessionServicesCache.set(key, entry);
	}
	return entry;
}

/**
 * U4 — per-task delegating ResourceLoader.
 *
 * The shared bundle's loader is reloaded once, but the SYSTEM prompt is
 * per-task (liveSystemPrompt embeds runId/taskId/role/agent). The SDK's
 * systemPromptOverride is a loader-level option evaluated at reload() time,
 * so a shared loader would latch the FIRST task's prompt. This wrapper
 * delegates all reload-derived state (extensions/skills/prompts/themes) to
 * the shared loader while serving per-task system-prompt values — the
 * AgentSession reads the prompt through getSystemPrompt() at build time.
 */
export function buildPerTaskResourceLoader(
	sharedLoader: Record<string, unknown>,
	overrides: { systemPrompt: string },
): Record<string, unknown> {
	const delegate = <T>(method: string, fallback: T): ((...args: unknown[]) => T) => {
		const fn = sharedLoader[method];
		return typeof fn === "function" ? (fn as (...args: unknown[]) => T).bind(sharedLoader) : () => fallback;
	};
	const emptyExtensions = { extensions: [], errors: [], warnings: [], runtime: undefined };
	const emptySkillDiag = { skills: [], diagnostics: [] };
	const emptyPromptDiag = { prompts: [], diagnostics: [] };
	const emptyThemeDiag = { themes: [], diagnostics: [] };
	const emptyAgentsFiles = { agentsFiles: [] };
	return {
		getExtensions: delegate("getExtensions", emptyExtensions),
		getSkills: delegate("getSkills", emptySkillDiag),
		getPrompts: delegate("getPrompts", emptyPromptDiag),
		getThemes: delegate("getThemes", emptyThemeDiag),
		getAgentsFiles: delegate("getAgentsFiles", emptyAgentsFiles),
		getSystemPrompt: () => overrides.systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: delegate("getAppendSystemPrompt", [] as string[]),
		getAppendSystemPromptSources: delegate("getAppendSystemPromptSources", [] as unknown[]),
		extendResources: delegate("extendResources", undefined),
		reload: delegate("reload", Promise.resolve()) as unknown as (options?: unknown) => Promise<void>,
	};
}

/** Extension paths the U4 loader is allowed to load per MCP permission. */
export function allowedLiveExtensionPaths(mcpPermitted: boolean): string[] {
	return mcpPermitted ? ["builtin:mcp"] : [];
}

/**
 * U4 recursion guard layer 1 (post-creation assert, evals harness pattern):
 * list extension paths that loaded but were not sanctioned. `filterActiveTools`
 * remains layer 2 — it only prunes the ACTIVE tool set, it does not unload
 * extension code.
 */
export function collectForeignExtensions(session: LiveSessionLike | undefined, allowedPaths: readonly string[]): string[] {
	const runner = session?.extensionRunner;
	if (typeof runner?.getExtensionPaths !== "function") return [];
	try {
		// N1 (security-audit run-1): the allowlist check itself has exactly ONE
		// implementation — mcp-proxy.ts `foreignMcpExtensionsAgainstAllowlist` —
		// so the fast-path assert and the legacy-loader-route assert below share
		// identical semantics (set membership against allowedLiveExtensionPaths).
		return foreignMcpExtensionsAgainstAllowlist(runner.getExtensionPaths(), allowedPaths);
	} catch {
		return [];
	}
}

/**
 * N1 (security-audit run-1): the post-creation assert DECISION for the LEGACY
 * `DefaultResourceLoader` route (the `!sharedServicesAvailable` branch) — the
 * same backstop the shared-services fast path's own assert gives it, with
 * identical allowlist semantics (`collectForeignExtensions` +
 * `allowedLiveExtensionPaths`). The loader-level `stripMcpExtensions` control
 * is a NAME-based denylist, so a differently-named MCP adapter survives it;
 * for a NON-MCP-permitted role the allowlist is empty, hence ANY extension
 * that still loaded is a violation.
 *
 * Armed ONLY for non-MCP-permitted roles on the legacy route: permitted roles
 * keep their extensions there (no strip is armed for them), and the fast path
 * owns its own assert (pass `sharedServices: true` to disarm this one). The
 * no-loader degradation case never reaches an assert — it already failed
 * closed earlier via `g2EnforcementDegradationReason` +
 * `shouldFailClosedMcpEnforcement`. Returns the offending foreign extension
 * paths; empty = pass.
 */
export function legacyLoaderMcpAllowlistViolation(
	session: LiveSessionLike | undefined,
	route: { sharedServices: boolean; mcpPermitted: boolean },
): string[] {
	if (route.sharedServices || route.mcpPermitted) return [];
	return collectForeignExtensions(session, allowedLiveExtensionPaths(false));
}

function appendTranscript(filePath: string | undefined, event: unknown): void {
	if (!filePath) return;
	// Task 26 (2026-08-24): serialize + redact at queue time, then route
	// through the shared 50ms batched JSONL writer (one mkdir + appendFileSync
	// per path per window instead of one async mkdir+appendFile PER streaming
	// event). child-pi-transcript's batched writer is not generic over plain
	// paths (ChildPiRunInput + artifactsRoot containment + re-redaction), so
	// the identical map lives in sidechain-output.ts.
	appendBatchedJsonlLine(filePath, `${JSON.stringify(redactSecrets(event))}\n`);
}

/**
 * U3 test seam: register a caller-supplied pi-ai `Provider` on the created
 * session's ModelRuntime right after creation. Passive by design — no faux
 * import lives in runtime code; tests construct the provider and pass it via
 * `LiveSessionSpawnInput.modelProviderOverride`. No-op when no override is
 * supplied or the session does not expose a ModelRuntime with
 * `registerNativeProvider` (older/foreign SDK shapes).
 */

// U16 (Fix B): the usageFromStats thin adapter moved to usage-bridge.ts (m5);
// re-exported here so the historical import surface keeps working.
export { usageFromStats } from "./usage-bridge.ts";

/**
 * U4 hung-tool escape hatch marker error. Thrown when a timed-out prompt did
 * NOT settle even after the cooperative session.abort() + grace window — i.e.
 * a tool or provider call is holding the turn and ignoring the AbortSignal
 * (in-process abort is cooperative-only; see agent-loop.ts:798-830).
 */
export class LiveSessionHungToolError extends Error {
	// R3-1: TS parameter properties (`constructor(readonly x)`) are rejected by
	// --experimental-strip-types (strip-only mode), breaking the bench tooling
	// (test/bench loads this file outside tsx). Declare plain fields and assign
	// them in the constructor body instead — same public API.
	readonly timeoutMs: number;
	readonly graceMs: number;

	constructor(label: string, timeoutMs: number, graceMs: number) {
		super(
			`${label} hung: prompt did not settle within ${graceMs}ms after the ${timeoutMs}ms timeout and cooperative abort — dropping session reference and failing the task (escape hatch).`,
		);
		this.timeoutMs = timeoutMs;
		this.graceMs = graceMs;
		this.name = "LiveSessionHungToolError";
	}
}

async function promptWithTimeout(
	session: LiveSessionLike,
	text: string,
	timeoutMs: number,
	label: string,
	hungToolGraceMs = DEFAULT_LIVE_SESSION.hungToolGraceMs,
): Promise<boolean> {
	// CORE-11: pass an AbortSignal into session.prompt so the underlying prompt is
	// genuinely cancelled on timeout instead of being abandoned by Promise.race.
	// U4: streamingBehavior is MANDATORY on every prompt() — without it a prompt
	// landing while the session is already streaming throws "Agent is already
	// processing" (pi agent-session.js:1548). "followUp" queues the message to
	// run after the in-flight turn instead of erroring.
	const ac = new AbortController();
	const promptPromise = session.prompt?.(text, {
		source: "api",
		expandPromptTemplates: false,
		signal: ac.signal,
		streamingBehavior: "followUp",
	});
	if (!promptPromise) return false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promptPromise,
			new Promise<void>((_, reject) => {
				timer = setTimeout(() => {
					ac.abort(); // cancel the underlying prompt
					reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				timer.unref?.();
			}),
		]);
		return true;
	} catch (error) {
		const messageText = error instanceof Error ? error.message : String(error);
		if (messageText.includes("timed out")) {
			// U4 escape hatch: abort() is cooperative — a tool that ignores the
			// AbortSignal keeps the prompt() promise pending forever. Wait a bounded
			// grace for a settle; if none arrives, surface the distinct hung-tool
			// error so the caller can drop the session reference and fail the task
			// instead of leaking a stuck slot.
			const settledEarly = await Promise.race([
				promptPromise.then(
					() => true,
					() => true,
				),
				new Promise<boolean>((resolve) => {
					const graceTimer = setTimeout(() => resolve(false), hungToolGraceMs);
					graceTimer.unref?.();
				}),
			]);
			if (!settledEarly) throw new LiveSessionHungToolError(label, timeoutMs, hungToolGraceMs);
		}
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function probeLiveSessionRuntime(): Promise<LiveSessionUnavailableResult | LiveSessionPlannedResult> {
	const availability = await isLiveSessionRuntimeAvailable();
	if (!availability.available)
		return {
			available: false,
			reason: availability.reason ?? "Live-session runtime is unavailable.",
		};
	return {
		available: true,
		reason: "Live-session SDK exports are available. pi-crew can run in-process live agents when runtime.mode=live-session.",
	};
}

// DR-02 C1: the per-agent control-request dedupe Set previously grew for
// the whole run lifetime — fed by BOTH the 500ms/1000ms control poll and the
// realtime subscription, with no eviction. Bounded FIFO eviction: a Set
// preserves insertion order, so deleting the first-added id evicts the OLDEST
// request id (mirrors the NotificationRouter.SEEN_MAP_MAX_SIZE bounded-seen
// pattern). Worst case after an eviction is one redelivery of a very old
// control request; the consumers (steer / follow-up) are idempotent by design.
export const MAX_SEEN_CONTROL_REQUEST_IDS = 10_000;

class BoundedSeenControlRequestIdSet extends Set<string> {
	override add(id: string): this {
		super.add(id);
		while (this.size > MAX_SEEN_CONTROL_REQUEST_IDS) {
			const oldest = this.values().next().value;
			if (oldest === undefined) break;
			this.delete(oldest);
		}
		return this;
	}
}

/** @internal — test seam for the C1 cap (see live-agent-control-dedupe tests). */
export const __test__BoundedSeenControlRequestIdSet = BoundedSeenControlRequestIdSet;

export async function runLiveSessionTask(input: LiveSessionSpawnInput): Promise<LiveSessionRunResult> {
	// Cold-start race fix: ensure the hot module graph is warm before touching
	// any module. Under tsx, concurrent first-imports race module-record
	// instantiation; awaiting the registration-time warmup eliminates the window.
	await awaitRuntimeWarmup();

	// Phase 4 (ADR 2026-08-15-runtime-convergence, decision (a) — freeze):
	// the live-session path is permanently EXPERIMENTAL and intentionally
	// diverges from the supported child-process path (no worker-cap semaphore,
	// no depth guard, permissive SDK tool surface, single-model-fallback
	// report). Warn once per process so operators see the notice without
	// per-task spam.
	if (!experimentalWarned) {
		experimentalWarned = true;
		logInternalError(
			"live-session.experimental",
			new Error("experimental path"),
			"runtime.mode=live-session is EXPERIMENTAL and frozen (decision (a)); it diverges from child-process semantics (no worker-cap/depth guard, permissive tools) — see docs/decisions/2026-08-15-runtime-convergence.md",
			"warn",
		);
	}

	const isCurrent = input.isCurrent ?? (() => true);
	let streamOut: StreamingOutputHandle | undefined;
	// U4 escape hatch state: set when a timed-out prompt failed to settle even
	// after cooperative abort — the finally block then TERMINATES (abort +
	// dispose + unregister) the handle instead of the soft dispose, so a
	// tool/provider call holding the event loop cannot keep a registry slot.
	let hungToolEscalated = false;

	// G1: Capture yield result from custom tool callback
	let customToolYieldResult: YieldResult | undefined;
	let customToolYieldResolved = false;
	// wave-2b (mock double-gate): the mock session fabricates a success event
	// for the whole run — single-gated, inherited env would silently neuter a
	// worker. Double-gate with PI_CREW_ALLOW_MOCK (mirror mock-fixtures.ts).
	if (
		getCrewEnv("PI_CREW_MOCK_LIVE_SESSION") === "success" &&
		(getCrewEnv("PI_CREW_ALLOW_MOCK") === "1" || getCrewEnv("PI_CREW_ALLOW_MOCK") === "true")
	) {
		const agentId = `${input.manifest.runId}:${input.task.id}`;
		const inherited =
			input.runtimeConfig?.inheritContext === true && input.parentContext ? ` with inherited context: ${input.parentContext}` : "";
		// M3-2 (R47-3/V4): the verifier output contract requires a PASS:/FAIL:
		// verdict line; the mock must emit contract-shaped output for verifier-role
		// tasks or the (now real) verdict consumer marks the evidence unverified
		// and the green contract blocks the run (fail-closed — correct for real
		// verifiers, wrong for the success mock).
		const mockVerdictSuffix = input.task.role === "verifier" ? "\nPASS: mock verifier — mock live-session success" : "";
		const mockText = `Mock live-session success for ${input.agent.name}${inherited}${mockVerdictSuffix}`;
		const event = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: mockText,
					},
				],
			},
		};
		// U4 (D4 fix): the mock session deliberately exposes NO steer/prompt/abort —
		// a steer/followUp arriving in the planning window (between this mock
		// registration and the real session's registerLiveAgent for the same
		// agentId) must be QUEUED on the handle (steerLiveAgent falls back to
		// pendingSteers) so registerLiveAgent can route it to the real session on
		// re-registration. The previous no-op {steer,prompt,abort} stub silently
		// swallowed those messages (lost, not doubled).
		const mockSession = {};
		registerLiveAgent(
			{
				agentId,
				runId: input.manifest.runId,
				taskId: input.task.id,
				role: input.task.role,
				agent: input.agent?.name ?? "mock",
				description: "mock",
				session: mockSession,
				status: "running",
				workspaceId: input.workspaceId,
			},
			appendEvent,
			input.manifest.eventsPath,
		);
		appendTranscript(input.transcriptPath, event);
		const sidechainPath = sidechainOutputPath(input.manifest.stateRoot, input.task.id);
		writeSidechainEntry(sidechainPath, {
			agentId,
			type: "user",
			message: { role: "user", content: input.prompt },
			cwd: input.task.cwd,
		});
		writeSidechainEntry(sidechainPath, {
			agentId,
			type: "message",
			message: event,
			cwd: input.task.cwd,
		});
		// Task 26: the mock path returns before the try/finally below, so drain
		// the batched writers here — tests read these files right after return.
		flushPendingSidechainWrites();
		if (isCurrent()) input.onEvent?.(event);
		const stdout = mockText;
		if (isCurrent()) input.onOutput?.(stdout);
		updateLiveAgentStatus(agentId, "completed");
		markLiveAgentCompleted(agentId);
		// U4 dispose normalization: the mock handle is terminal too — drain any
		// pending steer/followUp that arrived during the mock window and mark the
		// handle terminated so later steers are rejected clearly instead of
		// queueing forever against a mock that will never run again.
		disposeLiveAgentSession(agentId);
		return {
			available: true,
			exitCode: 0,
			stdout,
			stderr: "",
			jsonEvents: 1,
		};
	}
	const availability = await isLiveSessionRuntimeAvailable();
	if (!availability.available)
		return {
			available: true,
			exitCode: 1,
			stdout: "",
			stderr: availability.reason ?? "Live-session runtime unavailable.",
			jsonEvents: 0,
			error: availability.reason,
		};
	// LAZY: optional peer dependency — only loaded when live-session runtime is
	// chosen. Goes through the module-scoped latch (loadLiveSessionModule) so
	// concurrent first-imports share ONE in-flight promise instead of racing
	// module-record instantiation under the tsx loader.
	const mod = await loadLiveSessionModule();
	if (typeof mod.createAgentSession !== "function")
		return {
			available: true,
			exitCode: 1,
			stdout: "",
			stderr: "createAgentSession export is unavailable.",
			jsonEvents: 0,
			error: "createAgentSession export is unavailable.",
		};
	// OPT-03: compute yield-enabled flag early to conditionally allocate
	// collectedJsonEvents — avoids ~1KB array allocation per task when yield
	// detection is disabled. Pattern mirrors task-runner.ts:165. Uses the same
	// `enabled !== false` semantics as the late yield-detection block below so
	// the array is always allocated when (and only when) it will be read.
	const yieldConfig = input.runtimeConfig?.yield ?? { enabled: DEFAULT_YIELD_CONFIG.enabled };
	const yieldEnabled = yieldConfig.enabled !== false;
	let session: LiveSessionLike | undefined;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeControlRealtime: (() => void) | undefined;
	let controlTimer: ReturnType<typeof setInterval> | undefined;
	// PERF (2026-08-24): unbounded string concat re-copies the whole transcript
	// on every chunk; bounded tail keeps whatever the consumer actually reads.
	// Consumer sizing: stdout becomes parsedOutput.finalText + the
	// results/{taskId}.txt artifact — the same downstream consumers the
	// child-pi path already caps at maxCaptureBytes (512 KiB) via BoundedTail,
	// so we match that cap for parity (this is NOT a tail-only preview).
	const stdoutTail = new BoundedTail();
	let jsonEvents = 0;
	const collectedJsonEvents: Record<string, unknown>[] | undefined = yieldEnabled ? [] : undefined;
	const maxCollectedJsonEvents = 1000;
	let yieldResult: YieldResult | undefined;

	const agentId = `${input.manifest.runId}:${input.task.id}`;

	// Round 27 (BUG 4): hoisted to function scope so the finally block can remove
	// it. const inside try{} is block-scoped and invisible to finally{}. The
	// handler resolves `session` lazily at call time (it may be assigned later
	// inside the try), so declaring it here is safe.
	let onSignalAbort: (() => void) | undefined;

	// U11 embedded-tier state (DEFAULT-OFF: gated on `embedded` throughout).
	const embedded = input.embeddedMitigations;
	let embeddedHandle: EmbeddedAdmissionHandle | undefined;
	let faultSignal: Promise<never> | undefined;
	let faultSignalReject: ((error: Error) => void) | undefined;
	let embeddedWatchdogFired = false;
	let embeddedEscalated = false;
	let embeddedProviderRestore: (() => string | undefined) | undefined;
	let embeddedWatchdogTimer: TurnWatchdogHandle | undefined;
	const emitEmbedded: EmbeddedEventSink | undefined = embedded
		? buildEmbeddedEventSink(appendEventFireAndForget, input.manifest.eventsPath, input.manifest.runId, input.task.id)
		: undefined;

	try {
		// U11 admission (fail-closed): factory assert → cap (fail-fast, never
		// queue) → process guard → baseline → memory sample. Inert by default.
		if (embedded && emitEmbedded) {
			const admission = admitEmbeddedSession({
				mod,
				agentId,
				runId: input.manifest.runId,
				taskId: input.task.id,
				role: input.task.role,
				mitigations: embedded,
				emit: emitEmbedded,
				servicesCacheKeys: liveSessionServicesCacheStatsForTest().keys,
			});
			if (admission.status === "rejected") {
				emitEmbedded(admission.event.type, admission.event.data, admission.event.message);
				return {
					available: true,
					exitCode: 1,
					stdout: "",
					stderr: admission.result.stderr,
					jsonEvents: 0,
					error: admission.result.error,
					fault: admission.result.fault,
				};
			}
			embeddedHandle = admission;
			faultSignal = admission.escapeSignal;
			faultSignalReject = (error: Error) => {
				embeddedEscalated = true;
				admission.escalate(error);
			};
		}
		const agentDir = typeof mod.getAgentDir === "function" ? mod.getAgentDir() : undefined;
		// G2 (SDD-2 W-B, least-privilege): live-session workers inherit the
		// parent's MCP servers ONLY when the role is MCP-permitted
		// (write-capable; read-only/unknown/undefined are default-denied —
		// see mcpPermittedForRole). pi ≥0.99 loads MCP as a built-in
		// EXTENSION (`builtin:mcp`, plus any installed replacer such as
		// pi-mcp-adapter) and the pre-0.99 `enableMCP:false` session option
		// no longer exists — so enforcement happens HERE, at the resource
		// loader: the MCP extension(s) are dropped from the child's extension
		// list for non-permitted roles (no MCP code load, no server connect).
		// U11 mitigation (a): embedded tier is builtin-tools-only — MCP
		// inheritance disabled even for MCP-permitted roles (nomcp bundle; the
		// post-creation asserts then expect zero foreign extensions).
		const roleMcpPermitted = mcpPermittedForRole(input.task.role);
		const mcpPermitted = embedded ? false : roleMcpPermitted;
		if (embedded && emitEmbedded && roleMcpPermitted)
			emitEmbedded(
				"live-session.embedded_builtin_only",
				{ role: input.task.role ?? null },
				`Embedded tier forces builtin-tools-only for role "${input.task.role ?? "unknown"}" — MCP inheritance disabled on this path (U11 mitigation a).`,
			);
		// U4 fast path availability: shared services bundle + fromServices. Any
		// missing export (foreign/older SDK) falls back to the legacy per-worker
		// DefaultResourceLoader path below, unchanged.
		const sharedServicesAvailable =
			Boolean(agentDir) &&
			typeof mod.createAgentSessionServices === "function" &&
			typeof mod.createAgentSessionFromServices === "function" &&
			typeof mod.SessionManager?.inMemory === "function";
		let sharedBundle: LiveSessionServicesBundle | undefined;
		if (sharedServicesAvailable) {
			// U4: one services bundle per (cwd, agentDir, mcp-mode, context-files).
			// The bundle's loader is reloaded ONCE; per-task system prompts are
			// served by a delegating wrapper (see buildPerTaskResourceLoader) at
			// session creation, so nothing per-task latches into the shared bundle.
			sharedBundle = await getOrCreateLiveSessionServices(mod, {
				cwd: input.task.cwd,
				agentDir: agentDir!,
				mcpPermitted,
				loadContextFiles: input.runtimeConfig?.inheritContext === true,
			});
			// G2 degraded-enforcement warning (fast path): MCP-permitted role but
			// the SDK no longer exports createMcpExtension → the builtin:mcp pin
			// cannot be armed; surface the fail-open instead of drifting silently.
			if (mcpPermitted && typeof mod.createMcpExtension !== "function") {
				appendEventFireAndForget(input.manifest.eventsPath, {
					type: "task.mcp_enforcement_degraded",
					runId: input.manifest.runId,
					taskId: input.task.id,
					message: `G2 MCP policy NOT enforced for role "${input.task.role ?? "unknown"}" (U4 fast path): pi SDK does not export createMcpExtension — this worker will NOT inherit the parent's MCP servers.`,
					data: { role: input.task.role ?? null, reason: "createMcpExtension-missing" },
				});
			}
		}
		let resourceLoader: unknown;
		// F1 (v0.7.9) NOTE: `agent.excludeExtensions` is applied on the
		// child-pi path (see `pi-args.ts`). The live-session path loads
		// extensions via pi's `DefaultResourceLoader`, which has no explicit
		// per-extension allow/deny API at the point we hand off. For
		// v0.7.9, the denylist is honored on the default async path only;
		// the live-session path (opt-in via `runtime.preferLiveSession`)
		// ignores it. This is a documented limitation, not a silent bug.
		if (!sharedServicesAvailable && mod.DefaultResourceLoader && agentDir) {
			resourceLoader = new mod.DefaultResourceLoader({
				cwd: input.task.cwd,
				agentDir,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: input.runtimeConfig?.inheritContext !== true,
				systemPromptOverride: () => liveSystemPrompt(input),
				appendSystemPromptOverride: () => [],
				// G2: non-permitted roles get the MCP extension(s) stripped.
				...(mcpPermitted ? {} : { extensionsOverride: stripMcpExtensions }),
			});
			await (resourceLoader as { reload?: () => Promise<void> }).reload?.();
		}
		// G2 degraded-enforcement warning (security-review follow-up): if the
		// role is NOT MCP-permitted but the strip above could not be armed (SDK
		// stopped exporting DefaultResourceLoader, or agentDir unresolvable),
		// enforcement silently degrades to fail-open — surface it instead of
		// letting a version drift quietly re-expose the parent's MCP servers.
		const g2DegradationReason = sharedServicesAvailable
			? undefined
			: g2EnforcementDegradationReason({
					mcpPermitted,
					resourceLoaderAvailable: Boolean(mod.DefaultResourceLoader && agentDir),
				});
		if (g2DegradationReason) {
			// R1-M2 part 2 (Wave-3): FAIL CLOSED. Previously the degradation only
			// warned and proceeded — a version-drifted SDK silently re-exposed the
			// parent's MCP servers to a NON-PERMITTED (read-only) role. MCP-permitted
			// roles keep the warn+proceed behavior (their access is intended); every
			// other role ABORTS the spawn with a typed error so the drift is loud.
			const failClosedCode = "mcp-enforcement-fail-closed";
			appendEventFireAndForget(input.manifest.eventsPath, {
				type: mcpPermitted ? "task.mcp_enforcement_degraded" : "task.mcp_enforcement_fail_closed",
				runId: input.manifest.runId,
				taskId: input.task.id,
				message: mcpPermitted
					? `G2 MCP policy NOT enforced for role "${input.task.role ?? "unknown"}": pi SDK resource loader unavailable (${g2DegradationReason}) — this worker may inherit the parent's MCP servers.`
					: `G2 MCP policy ABORTED live-session spawn for role "${input.task.role ?? "unknown"}" (${failClosedCode}): enforcement (MCP extension stripping) could not be armed (${g2DegradationReason}) — refusing fail-open inheritance of the parent's MCP servers.`,
				data: {
					role: input.task.role ?? null,
					reason: g2DegradationReason,
					code: failClosedCode,
				},
			});
			if (g2DegradationReason && shouldFailClosedMcpEnforcement(mcpPermitted, g2DegradationReason)) {
				const message = `[${failClosedCode}] Live-session spawn refused for role "${input.task.role ?? "unknown"}": MCP enforcement degraded (${g2DegradationReason}) and the role is not MCP-permitted — fail-closed instead of inheriting the parent's MCP servers.`;
				return {
					available: true,
					exitCode: 1,
					stdout: "",
					stderr: message,
					jsonEvents: 0,
					error: message,
				};
			}
		}
		const effectiveParentModel = resolveParentModelFromRegistry(input.modelRegistry, input.parentModel);
		const modelRouting = buildConfiguredModelRouting({
			overrideModel: input.modelOverride,
			stepModel: input.step.model,
			teamRoleModel: input.teamRoleModel,
			teamRoleFallbackModels: input.teamRoleFallbackModels,
			agentModel: input.agent.model,
			defaultSubagentModel: resolveLiveDefaultSubagentModel(input.manifest.cwd),
			fallbackModels: input.agent.fallbackModels,
			parentModel: effectiveParentModel,
			modelRegistry: input.modelRegistry,
			cwd: input.manifest.cwd,
			policy: resolveLiveModelFallbackPolicy(input.manifest.cwd),
			scopeModelsPatterns: await resolveScopeModelsPatterns(input.manifest.cwd),
		});
		const resolvedModel =
			modelFromRegistry(input.modelRegistry, modelRouting.candidates[0] ?? modelRouting.requested) ?? input.parentModel;
		const resolvedModelRef = modelRefToString(resolvedModel) ?? modelRouting.candidates[0];
		// Surface a warning when the caller's requested model was silently replaced.
		if (modelRouting.droppedRequested) {
			appendEventFireAndForget(input.manifest.eventsPath, {
				type: "task.model_dropped",
				runId: input.manifest.runId,
				taskId: input.task.id,
				message: `Requested model "${modelRouting.droppedRequested}" is not available; using "${modelRouting.candidates[0] ?? "default"}" instead.`,
				data: {
					requested: modelRouting.droppedRequested,
					resolved: modelRouting.candidates[0],
					fallbackChain: modelRouting.candidates,
				},
			});
		}
		// Sec-M1: surface a non-silent warning when a soft-sourced model is out-of-scope.
		// Only non-caller sources (frontmatter / resolved) get the soft warning —
		// caller sources already throw inside buildConfiguredModelRouting.
		warnOutOfScopeSoft(modelRouting.scopeVerdict, "live-session.model-out-of-scope");
		// H1.a: teamRole.thinking takes precedence over agent.thinking.
		const effectiveThinking = input.teamRoleThinking ?? input.agent.thinking;

		// R3-12: bind the live session's model scope to pi-crew's fallback chain
		// so model cycling (and the extension-visible scope) cannot drift outside
		// the candidates the routing gate approved. Only bound when the chain
		// resolves to at least one registry model (explicit non-empty guard).
		const scopedSessionModels = resolveScopedSessionModels(input.modelRegistry, modelRouting.candidates);

		// G1: Build custom tools (submit_result + irc)
		const submitResultTool = createSubmitResultTool((result) => {
			customToolYieldResult = result;
			customToolYieldResolved = true;
		});
		const ircTool = createIrcTool(agentId);
		const customTools = [submitResultTool, ircTool];

		const sessionCreateStart = Date.now();
		let created: { session: LiveSessionLike; modelFallbackMessage?: string };
		if (sharedBundle) {
			// U4 fast path: createAgentSessionFromServices fans a cheap child
			// session out of the shared bundle. The per-task system prompt rides
			// a delegating loader wrapper (the shared loader's systemPromptOverride
			// latches at reload time and cannot vary per task).
			created = await mod.createAgentSessionFromServices!({
				services: {
					...sharedBundle.services,
					resourceLoader: buildPerTaskResourceLoader(sharedBundle.resourceLoader, {
						systemPrompt: liveSystemPrompt(input),
					}),
				},
				sessionManager: mod.SessionManager!.inMemory!(input.task.cwd),
				...(resolvedModel ? { model: resolvedModel } : {}),
				...(effectiveThinking ? { thinkingLevel: effectiveThinking } : {}),
				// R3-12: cycling/visibility scope = the fallback chain (see helper).
				...(scopedSessionModels.length > 0 ? { scopedModels: scopedSessionModels } : {}),
				customTools,
			});
		} else {
			created = await mod.createAgentSession({
				cwd: input.task.cwd,
				...(agentDir ? { agentDir } : {}),
				...(resourceLoader ? { resourceLoader } : {}),
				...(mod.SessionManager?.inMemory
					? {
							sessionManager: mod.SessionManager.inMemory(input.task.cwd),
						}
					: {}),
				...(mod.SettingsManager?.create && agentDir
					? {
							settingsManager: mod.SettingsManager.create(input.task.cwd, agentDir),
						}
					: {}),
				...(resolvedModel ? { model: resolvedModel } : {}),
				...(effectiveThinking ? { thinkingLevel: effectiveThinking } : {}),
				// R3-12: cycling/visibility scope = the fallback chain (see helper).
				...(scopedSessionModels.length > 0 ? { scopedModels: scopedSessionModels } : {}),
				customTools,
			});
		}
		session = created.session;
		// U4 recursion guard layer 1 (assert, evals harness pattern): the child
		// session must have loaded ONLY sanctioned extensions — nothing for
		// non-MCP roles, exactly `builtin:mcp` for MCP-permitted ones. A
		// violation means the loader-level kill switch (noExtensions) failed and
		// the pi-crew host extension (recursion risk) or a foreign extension
		// loaded inside the worker → fail the task loudly. filterActiveTools
		// remains layer 2 for tool-surface drift.
		if (sharedBundle) {
			const foreignExtensions = collectForeignExtensions(session, allowedLiveExtensionPaths(mcpPermitted));
			if (foreignExtensions.length > 0) {
				appendEventFireAndForget(input.manifest.eventsPath, {
					type: "live-session.foreign_extension_blocked",
					runId: input.manifest.runId,
					taskId: input.task.id,
					message: `U4 recursion guard: child session loaded unsanctioned extension(s) ${foreignExtensions.join(", ")} — failing task.`,
					data: { foreignExtensions, allowed: allowedLiveExtensionPaths(mcpPermitted) },
				});
				throw new Error(
					`live-session recursion guard: child session loaded unsanctioned extension(s): ${foreignExtensions.join(", ")}`,
				);
			}
		}
		// N1 (security-audit run-1, w9-n1): allowlist-shaped post-creation assert
		// for the LEGACY DefaultResourceLoader route — the same backstop the
		// shared-services fast path gets above, with identical semantics (single
		// mcp-proxy check via collectForeignExtensions). stripMcpExtensions is a
		// NAME-based denylist, so a differently-named MCP adapter (e.g.
		// 'mcp-bridge') survives it; any extension that still loaded for a
		// NON-MCP-permitted role is foreign (its allowlist is empty) and must
		// fail the task instead of silently loading and connecting its servers.
		// NOT armed for permitted roles (the legacy route keeps their extensions)
		// and unreachable for the no-loader degradation path (that already failed
		// closed above via g2EnforcementDegradationReason).
		const legacyForeignExtensions = legacyLoaderMcpAllowlistViolation(session, {
			sharedServices: Boolean(sharedBundle),
			mcpPermitted,
		});
		if (legacyForeignExtensions.length > 0) {
			const failClosedCode = "mcp-allowlist-fail-closed";
			const legacyAllowedPaths = allowedLiveExtensionPaths(false);
			appendEventFireAndForget(input.manifest.eventsPath, {
				type: "live-session.foreign_extension_blocked",
				runId: input.manifest.runId,
				taskId: input.task.id,
				message: `G2 MCP policy ABORTED live-session spawn for role "${input.task.role ?? "unknown"}" (${failClosedCode}): child session (legacy loader route) loaded extension(s) ${legacyForeignExtensions.join(
					", ",
				)} not sanctioned for a non-MCP-permitted role — failing closed instead of silently running with them.`,
				data: {
					foreignExtensions: legacyForeignExtensions,
					allowed: legacyAllowedPaths,
					route: "legacy-loader",
					code: failClosedCode,
					role: input.task.role ?? null,
				},
			});
			throw new McpForeignExtensionError({
				foreignExtensions: legacyForeignExtensions,
				allowedExtensions: legacyAllowedPaths,
				role: input.task.role,
			});
		}
		// U3: register the test-only provider override (faux E2E seam) before
		// anything streams. No-op in production (modelProviderOverride stays
		// undefined there).
		applyModelProviderOverride(session, input.modelProviderOverride);
		// U11 mitigation (b): re-register the resolved model's provider wrapped
		// with a default timeoutMs; restored in the finally (shared runtime must
		// not stay mutated).
		if (embedded && emitEmbedded)
			embeddedProviderRestore = applyEmbeddedProviderTimeout({
				session,
				modelRef: resolvedModelRef,
				timeoutMs: embedded.providerTimeoutMs,
				emit: emitEmbedded,
			}).restore;
		// P7 (perf): fire-and-forget — return value not needed, blocks the
		// event loop less than the sync appendEvent under file-lock contention.
		appendEventFireAndForget(input.manifest.eventsPath, {
			type: "live-session.session_created",
			runId: input.manifest.runId,
			taskId: input.task.id,
			data: {
				elapsedMs: Date.now() - sessionCreateStart,
				modelFallbackMessage: created.modelFallbackMessage,
				// U4: true = child session came from the shared services bundle
				// (fast path, ~ms); false = legacy full loader reload (~2.2s).
				sharedServices: Boolean(sharedBundle),
			},
		});
		filterActiveTools(session, input.agent, input.task.role);
		// U11 mitigation (a): builtin-tools-only, fail-closed on degradation.
		if (embedded && emitEmbedded) {
			const enforcement = enforceEmbeddedBuiltinTools(session, input.agent, input.task.role);
			if (!enforcement.ok) {
				emitEmbedded(
					"live-session.embedded_enforcement_degraded",
					{ reason: enforcement.reason, active: enforcement.active ?? null, role: input.task.role ?? null },
					`Embedded builtin-tools-only enforcement degraded (${enforcement.reason}) — failing closed (U11 mitigation a).`,
				);
				throw new LiveSessionEmbeddedEnforcementError(enforcement.reason, enforcement.active ?? []);
			}
		}

		// Diagnostic: log before bindExtensions so we can identify extension-loading hangs
		const bindExtensionsStart = Date.now();
		try {
			await Promise.race([
				session.bindExtensions?.({}) ?? Promise.resolve(),
				new Promise<void>((_, reject) => setTimeout(() => reject(new Error("bindExtensions timed out after 30s")), 30_000)),
			]);
		} catch (bindError) {
			const msg = bindError instanceof Error ? bindError.message : String(bindError);
			// P7: fire-and-forget — return value not needed.
			appendEventFireAndForget(input.manifest.eventsPath, {
				type: "live-session.bind_extensions_error",
				runId: input.manifest.runId,
				taskId: input.task.id,
				data: {
					elapsedMs: Date.now() - bindExtensionsStart,
					error: msg,
				},
			});
			// Continue without extensions — they should not block the session
		}

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
					(
						extRunner as {
							initialize: (apis: unknown, host: unknown) => void;
						}
					).initialize(extensionBridge.apis, extensionBridge.host);
					if (typeof (extRunner as Record<string, unknown>).emit === "function") {
						await (
							extRunner as {
								emit: (event: unknown) => Promise<void>;
							}
						).emit({ type: "session_start" });
					}
				} catch {
					// Extension runner initialization failure should not block the session
				}
			}
		}

		registerLiveAgent(
			{
				agentId,
				runId: input.manifest.runId,
				taskId: input.task.id,
				role: input.task.role,
				agent: input.agent?.name ?? "unknown",
				description: input.task.adaptive?.task ?? input.step?.task ?? "",
				modelName: (resolvedModel as { name?: string })?.name,
				session,
				status: "running",
				workspaceId: input.workspaceId,
			},
			appendEvent,
			input.manifest.eventsPath,
		);
		registerLiveAgentModel(agentId, resolvedModelRef ?? "");
		streamOut = createStreamingOutput(input.manifest, input.task.id);
		let controlCursor: LiveAgentControlCursor = { offset: 0 };
		const seenControlRequestIds: Set<string> = new BoundedSeenControlRequestIdSet();
		let controlBusy = false;
		const pollControl = async () => {
			if (!isCurrent() || controlBusy || !session) return;
			controlBusy = true;
			try {
				// U11: bounded memory metrics on the control-poll cadence (5s rate limit).
				if (emitEmbedded) maybeEmitEmbeddedMemoryMetrics(emitEmbedded);
				controlCursor = await applyLiveAgentControlRequests({
					manifest: input.manifest,
					taskId: input.task.id,
					agentId,
					session,
					cursor: controlCursor,
					seenRequestIds: seenControlRequestIds,
				});
			} finally {
				controlBusy = false;
			}
		};
		unsubscribeControlRealtime = subscribeLiveControlRealtime((request) => {
			if (!isCurrent() || request.runId !== input.manifest.runId || request.taskId !== input.task.id || !session) return;
			// R3A-M1: the applier itself now records failures on the request, but a
			// rejection must never reach unhandledRejection — catch + log here too.
			void applyLiveAgentControlRequest({
				request,
				taskId: input.task.id,
				agentId,
				session,
				seenRequestIds: seenControlRequestIds,
			}).catch((error) => {
				logInternalError("live-session.control-realtime-apply", error, `agentId=${agentId}`);
			});
		});
		await pollControl();
		// PERF (2026-08-24): each poll does existsSync + readFileSync + JSON.parse
		// of the whole control JSONL. With a realtime subscription active for this
		// agent, in-process control requests (team-tool / cross-extension RPC
		// publish) are delivered immediately and the poll only covers cross-process
		// writers → 1000ms. Without realtime, the file poll is the sole delivery
		// path → keep the faster 500ms cadence.
		controlTimer = setInterval(
			() => {
				// R3A-M1: fire-and-forget poll must never reject unhandled.
				if (isCurrent())
					void pollControl().catch((error) => {
						logInternalError("live-session.control-poll", error, `agentId=${agentId}`);
					});
			},
			hasLiveControlRealtimeListeners() ? 1000 : 500,
		);
		let turnCount = 0;
		let softLimitReached = false;
		const maxTurns = input.runtimeConfig?.maxTurns;
		const graceTurns = input.runtimeConfig?.graceTurns ?? 5;
		const sidechainPath = sidechainOutputPath(input.manifest.stateRoot, input.task.id);
		writeSidechainEntry(sidechainPath, {
			agentId,
			type: "user",
			message: { role: "user", content: input.prompt },
			cwd: input.task.cwd,
		});
		if (typeof session.subscribe === "function") {
			unsubscribe = session.subscribe((event) => {
				// Wrap callback body in try/catch to prevent unguarded exceptions from
				// propagating into the session internals and crashing the live session.
				try {
					if (!isCurrent()) return;
					jsonEvents += 1;
					appendTranscript(input.transcriptPath, event);
					const sidechainType = eventToSidechainType(event);
					if (sidechainType)
						writeSidechainEntry(sidechainPath, {
							agentId,
							type: sidechainType,
							message: event,
							cwd: input.task.cwd,
						});
					const obj = asRecord(event);
					if (obj?.type === "turn_end") {
						turnCount += 1;
						trackLiveAgentTurnEnd(agentId);
						if (maxTurns !== undefined && !softLimitReached && turnCount >= maxTurns) {
							softLimitReached = true;
							// R3A-M1: rejection here would crash the host session.
							void session
								?.steer?.("You have reached your turn limit. Wrap up immediately — provide your final answer now.")
								.catch((error) => {
									logInternalError("live-session.turn-limit-steer", error, `agentId=${agentId}`);
								});
						} else if (maxTurns !== undefined && softLimitReached && turnCount >= maxTurns + graceTurns) {
							// U11 mitigation (c): abort + bounded watchdog — if the prompt does
							// not settle within the grace, dispose the session (drop-reference,
							// U4 escape discipline) and fail via the escape signal.
							if (embedded && !embeddedWatchdogFired) {
								embeddedWatchdogFired = true;
								void Promise.resolve(session?.abort?.()).catch((error: unknown) => {
									logInternalError("live-session.watchdog-abort", error, `agentId=${agentId}`);
								});
								embeddedWatchdogTimer = armTurnWatchdog({
									agentId,
									maxTurns,
									graceTurns,
									watchdogGraceMs: embedded.watchdogGraceMs ?? EMBEDDED_DEFAULT_WATCHDOG_GRACE_MS,
									turnCount,
									escalate: (error: Error) => faultSignalReject?.(error),
								});
							} else {
								void Promise.resolve(session?.abort?.()).catch((error: unknown) => {
									logInternalError("live-session.watchdog-abort", error, `agentId=${agentId}`);
								});
							}
						}
					}
					// P1: accumulate lifetime usage that survives compaction — message-level
					// deltas incl. cacheRead + numeric cost (parsed in usage-bridge).
					trackUsageFromMessageEndEvent(input.task.id, event);
					input.onEvent?.(event);
					const text = [...eventText(event), ...finalAssistantText(event)].join("\n");
					if (text.trim()) {
						stdoutTail.push(`${text}\n`);
						streamOut?.write(text + "\n");
						trackLiveAgentResponseText(agentId, text);
						input.onOutput?.(text);
					}
					// G2: Track tool start/end for activity display
					if (obj?.type === "tool_use" || obj?.type === "tool_execution_start") {
						const toolName = extractToolName(obj) ?? "unknown";
						trackLiveAgentToolStart(agentId, toolName);
					}
					if (obj?.type === "tool_result" || obj?.type === "tool_execution_end") {
						const toolName = extractToolName(obj) ?? "unknown";
						trackLiveAgentToolEnd(agentId, toolName);
					}
					// Phase 1: collect events for yield detection
					if (collectedJsonEvents && event && typeof event === "object" && !Array.isArray(event)) {
						collectedJsonEvents.push(event as Record<string, unknown>);
						if (collectedJsonEvents.length > maxCollectedJsonEvents)
							collectedJsonEvents.splice(0, collectedJsonEvents.length - maxCollectedJsonEvents);
					}
				} catch (error) {
					// Prevent unguarded exceptions in the subscribe callback from crashing
					// the live session or propagating into the session internals.
					logInternalError("live-session.subscribe-callback", error, `agentId=${agentId}`);
				}
			});
		}
		// Round 27 (BUG 4): named abort handler (removed in finally below).
		onSignalAbort = (): void => {
			// R3A-M1: abort rejection inside a signal handler must not become an
			// unhandledRejection — catch + log.
			void Promise.resolve(session?.abort?.()).catch((error: unknown) => {
				logInternalError("live-session.signal-abort", error, `agentId=${agentId}`);
			});
		};
		if (input.signal) {
			if (input.signal.aborted) await session.abort?.();
			// Round 27 (BUG 4): named handler so the finally block can remove it.
			// The previous anonymous listener leaked on normal completion (only
			// auto-removed by { once: true } AFTER the signal fires).
			else
				input.signal.addEventListener("abort", onSignalAbort, {
					once: true,
				});
		}
		const effectivePrompt =
			input.runtimeConfig?.inheritContext === true && input.parentContext
				? `${input.parentContext}\n\n---\n# Live Subagent Task\n${input.prompt}`
				: input.prompt;

		// Diagnostic: log prompt size and timing
		const promptStart = Date.now();
		// P7: fire-and-forget — return value not needed.
		appendEventFireAndForget(input.manifest.eventsPath, {
			type: "live-session.prompt_start",
			runId: input.manifest.runId,
			taskId: input.task.id,
			data: {
				promptLength: effectivePrompt.length,
				agent: input.agent.name,
				role: input.task.role,
			},
		});

		// Phase 3: Wrap session.prompt with timeout for graceful cancellation.
		// U4: runtime.liveSession.responseTimeoutMs / hungToolGraceMs override the
		// defaults (DEFAULT_LIVE_SESSION) for testability and operator control.
		const sessionTimeoutMs = input.runtimeConfig?.liveSession?.responseTimeoutMs ?? DEFAULT_LIVE_SESSION.responseTimeoutMs;
		const hungToolGraceMs = input.runtimeConfig?.liveSession?.hungToolGraceMs ?? DEFAULT_LIVE_SESSION.hungToolGraceMs;
		try {
			await liveAgentContext.run({ agentId, modelRef: resolvedModelRef ?? "" }, () => {
				const promptCall = promptWithTimeout(session!, effectivePrompt, sessionTimeoutMs, "Live-session", hungToolGraceMs);
				// U11: race the escape signal (watchdog / process guard) so the task
				// fails fast instead of awaiting a disposed-out session.
				return faultSignal ? Promise.race([promptCall, faultSignal]) : promptCall;
			});
		} catch (promptError) {
			const msg = promptError instanceof Error ? promptError.message : String(promptError);
			// P7: fire-and-forget — return value not needed.
			appendEventFireAndForget(input.manifest.eventsPath, {
				type: "live-session.prompt_error",
				runId: input.manifest.runId,
				taskId: input.task.id,
				data: { elapsedMs: Date.now() - promptStart, error: msg },
			});
			if (msg.includes("timed out")) {
				await session.abort?.();
				updateLiveAgentStatus(agentId, "failed");
				return {
					available: true,
					exitCode: 1,
					stdout: stdoutTail.value().trim(),
					stderr: msg,
					jsonEvents,
					error: msg,
					...(embedded ? { fault: { kind: "response-timeout" as const, detail: msg, countAsFault: true } } : {}),
				};
			}
			throw promptError;
		}
		// P7: fire-and-forget — return value not needed.
		appendEventFireAndForget(input.manifest.eventsPath, {
			type: "live-session.prompt_done",
			runId: input.manifest.runId,
			taskId: input.task.id,
			data: {
				elapsedMs: Date.now() - promptStart,
				jsonEvents,
				outputLength: stdoutTail.value().length,
			},
		});

		// --- Phase 1: Yield enforcement loop ---
		// After the initial prompt completes, check if the worker called submit_result.
		// Priority: 1) custom tool callback (G1), 2) JSON event detection (legacy).
		if (yieldEnabled && session) {
			// Check custom tool callback first (G1)
			if (customToolYieldResolved && customToolYieldResult) {
				yieldResult = customToolYieldResult;
			} else if (collectedJsonEvents) {
				// Legacy: detect from JSON events (only when collection is enabled)
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
						await promptWithTimeout(
							session,
							schemaReminder,
							Math.min(sessionTimeoutMs, DEFAULT_LIVE_SESSION.idleWaitTimeoutMs),
							"Live-session schema reminder",
							hungToolGraceMs,
						);
					} catch (schemaError) {
						if (schemaError instanceof LiveSessionHungToolError) throw schemaError;
						/* ignore */
					}
					await new Promise((resolve) => setTimeout(resolve, DEFAULT_LIVE_SESSION.yieldPollIntervalMs));
					// Check again after schema reminder
					if (customToolYieldResolved && customToolYieldResult) {
						yieldResult = customToolYieldResult;
					} else if (collectedJsonEvents) {
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
			while (
				!customToolYieldResolved &&
				!yieldResult &&
				retryCount < maxReminders &&
				!input.signal?.aborted &&
				!embeddedWatchdogFired &&
				!embeddedEscalated
			) {
				retryCount++;
				const reminder = buildYieldReminder(retryCount, maxReminders, yieldConfig.reminderPrompt);
				const prevTools = typeof session.getActiveToolNames === "function" ? session.getActiveToolNames() : [];
				try {
					// G6: Constrain tool set to submit_result before sending reminder
					if (typeof session.setActiveToolsByName === "function" && prevTools.length > 0) {
						session.setActiveToolsByName(["submit_result"]);
					}
					await promptWithTimeout(
						session,
						reminder,
						Math.min(sessionTimeoutMs, DEFAULT_LIVE_SESSION.idleWaitTimeoutMs),
						"Live-session yield reminder",
						hungToolGraceMs,
					);
				} catch (reminderError) {
					// U4: a hung reminder prompt propagates the escape hatch to the outer
					// handler; ordinary reminder failures just end the reminder loop.
					if (reminderError instanceof LiveSessionHungToolError) throw reminderError;
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
				if (collectedJsonEvents && hasYieldInOutput(collectedJsonEvents.slice(-10))) {
					const yieldEvent = collectedJsonEvents.slice(-10).find((e) => isYieldEvent(e));
					if (yieldEvent) yieldResult = extractYieldResult(yieldEvent);
					break;
				}
			}
			if (!customToolYieldResolved && !yieldResult && !input.signal?.aborted && retryCount >= maxReminders) {
				input.onEvent?.({
					type: "task.attention",
					runId: input.manifest.runId,
					taskId: input.task.id,
					message: "Live-session worker completed without calling submit_result tool.",
					data: {
						activityState: "needs_attention",
						reason: "no_yield",
						attempts: retryCount,
					},
				});
			}
		}

		// U11: post-condition global-state assert + aborted classification
		// (embedded path only — default result shape unchanged).
		const embeddedFault =
			embedded && emitEmbedded
				? finalizeEmbeddedFaultCheck({
						baseline: embeddedHandle?.baseline,
						signalAborted: input.signal?.aborted === true,
						servicesCacheKeys: liveSessionServicesCacheStatsForTest().keys,
						servicesCacheCap: MAX_LIVE_SESSION_SERVICES_BUNDLES,
						emit: emitEmbedded,
					})
				: undefined;
		// U16 (Fix A): the real SDK surface is getSessionStats() — see usage-bridge.
		const usage = usageFromSessionStats(session);
		updateLiveAgentStatus(agentId, "completed");
		markLiveAgentCompleted(agentId);
		return {
			available: true,
			exitCode: 0,
			stdout: stdoutTail.value().trim(),
			stderr: created.modelFallbackMessage ?? "",
			jsonEvents,
			usage,
			yieldResult,
			...(embeddedFault ? { fault: embeddedFault } : {}),
			modelRouting: {
				requested: modelRouting.requested,
				resolved: modelRefToString(resolvedModel) ?? modelRouting.candidates[0] ?? "default",
				fallbackChain: modelRouting.candidates,
				reason: modelRouting.reason,
				droppedRequested: modelRouting.droppedRequested,
				autoFallbackCount: modelRouting.autoFallbackCount,
			},
		};
	} catch (error) {
		// U11 mitigation (c) escape: turn-count watchdog fired — the session was
		// already disposed (drop-reference) by the watchdog timer.
		if (error instanceof LiveSessionTurnWatchdogError) {
			appendEventFireAndForget(input.manifest.eventsPath, {
				type: "live-session.turn_watchdog_escape",
				runId: input.manifest.runId,
				taskId: input.task.id,
				message: `Turn-count watchdog escape: ${error.message}`,
				data: {
					maxTurns: error.maxTurns,
					graceTurns: error.graceTurns,
					watchdogGraceMs: error.watchdogGraceMs,
					turnCount: error.turnCount,
					agentId,
				},
			});
			updateLiveAgentStatus(agentId, "failed");
			// R6-9: turns burned before the watchdog fired still count — capture the
			// partial usage (guarded; session was disposed by the watchdog timer).
			const watchdogUsage = faultPathUsage(session);
			return {
				available: true,
				exitCode: 1,
				stdout: stdoutTail.value().trim(),
				stderr: error.message,
				jsonEvents,
				usage: watchdogUsage,
				error: error.message,
				...(embedded ? { fault: { kind: "turn-watchdog" as const, detail: error.message, countAsFault: true } } : {}),
			};
		}
		// U4 hung-tool escape hatch (drop-reference + fail task): a timed-out
		// prompt that ignored the cooperative abort can never settle — emit the
		// dedicated event, terminate (abort + dispose + unregister) the handle,
		// and fail the task WITHOUT awaiting the abandoned prompt promise.
		if (error instanceof LiveSessionHungToolError) {
			hungToolEscalated = true;
			appendEventFireAndForget(input.manifest.eventsPath, {
				type: "live-session.hung_tool_escape",
				runId: input.manifest.runId,
				taskId: input.task.id,
				message: `Hung tool/provider escape hatch: ${error.message}`,
				data: { timeoutMs: error.timeoutMs, graceMs: error.graceMs, agentId },
			});
			updateLiveAgentStatus(agentId, "failed");
			// drop-reference (synchronous — never awaits the stuck abort): drain +
			// terminate + dispose + UNREGISTER, so the hung session holds no slot.
			dropLiveAgentReference(agentId);
			// R6-9: partial usage from the turns completed before the tool hung.
			const hungUsage = faultPathUsage(session);
			return {
				available: true,
				exitCode: 1,
				stdout: stdoutTail.value().trim(),
				stderr: error.message,
				jsonEvents,
				usage: hungUsage,
				error: error.message,
				...(embedded ? { fault: { kind: "hung-tool" as const, timeoutMs: error.timeoutMs, countAsFault: true } } : {}),
			};
		}
		const message = error instanceof Error ? error.message : String(error);

		// Phase 8: Log diagnostics on failure
		try {
			const agents = listLiveAgents();
			const health = collectLiveSessionHealth(agents, () => undefined);
			const diagnostics = formatLiveSessionDiagnostics(health);
			input.onEvent?.({
				type: "live-session.diagnostics",
				data: diagnostics,
			});
		} catch (diagError) {
			logInternalError("live-session.diagnostics", diagError);
		}

		updateLiveAgentStatus(`${input.manifest.runId}:${input.task.id}`, "failed");
		// U11: classify the failure for the hybrid layer's fault budget (embedded
		// path only — default result shape unchanged).
		const embeddedCatchFault = embedded
			? classifyEmbeddedCatchFault({
					error,
					message,
					quarantined: embeddedEscalated && message.includes("uncaught-exception guard"),
				})
			: undefined;
		return {
			available: true,
			exitCode: 1,
			stdout: stdoutTail.value().trim(),
			stderr: message,
			jsonEvents,
			// R6-9: generic fault path — partial usage from completed turns so the
			// budget sees the real spend even when the task failed.
			usage: faultPathUsage(session),
			error: message,
			...(embeddedCatchFault ? { fault: embeddedCatchFault } : {}),
		};
	} finally {
		// U11 teardown (every exit path): provider restore + admission teardown
		// (guard unregister + capacity release + final memory sample). Inert by default.
		if (embeddedHandle) {
			embeddedWatchdogTimer?.cancel();
			const restoreDrift = embeddedProviderRestore?.();
			if (restoreDrift && emitEmbedded)
				emitEmbedded(
					"live-session.embedded_global_state_drift",
					{ violations: [restoreDrift] },
					`Embedded provider-timeout wrapper not restored: ${restoreDrift}.`,
				);
			embeddedHandle.teardown();
		}
		// Unregister the live-agent model FIRST: a synchronous Map.delete that must run on
		// every exit path. If skipped (e.g. terminateLiveAgent throws on session.abort()),
		// hasActiveLiveAgents() stays true for the process lifetime and permanently disables
		// quota attribution (priority-2 skip) — including the main session's own tracking.
		// (Review finding H1/M1.)
		unregisterLiveAgentModel(agentId);
		// H6: Unsubscribe listeners FIRST before clearing timer to prevent race
		unsubscribe?.();
		unsubscribeControlRealtime?.();
		// Task 26 (2026-08-24): drain the batched sidechain/transcript writers
		// now that no more session events can enqueue, so callers that read the
		// files right after this task settles see complete content.
		flushPendingSidechainWrites();
		// Round 27 (BUG 4): remove the named abort listener to avoid leaking it
		// on the shared AbortSignal across many live-session tasks.
		if (onSignalAbort) input.signal?.removeEventListener("abort", onSignalAbort);
		if (controlTimer) clearInterval(controlTimer);
		streamOut?.close();
		if (hungToolEscalated) {
			// U4 hung-tool escape (drop-reference): synchronous removal only —
			// terminateLiveAgent awaits session.abort() which can itself hang on
			// a stuck session. Idempotent no-op when the outer catch already dropped.
			dropLiveAgentReference(agentId);
		} else if (input.signal?.aborted) {
			await terminateLiveAgent(agentId, "cancelled", appendEvent, input.manifest.eventsPath);
		} else {
			// U4 dispose normalization: dispose the session AND make the handle
			// terminal (drain pendingSteers/pendingFollowUps, reject later steers
			// clearly). The handle stays in the registry for status/health/UI —
			// but steer/followUp/resume on it now fail fast instead of silently
			// queueing into the disposed session.
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
