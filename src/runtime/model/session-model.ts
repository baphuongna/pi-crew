/**
 * session-model.ts — track the MAIN session's live model + thinking level.
 *
 * WHY: `ctx.model` from the pi extension API is the session's *saved* model,
 * not necessarily the one currently in use. A session that restored stale
 * state can report `anthropic/claude-sonnet-4-5` while actually running
 * `minimax/MiniMax-M3` (the value shown in the footer). Subagents that
 * inherit the parent model (`model: false`, which every builtin agent uses)
 * therefore "jumped" to whatever a previous session had saved.
 *
 * Pi emits `model_select` (with the real `Model` object) on every set / cycle
 * / restore, and `thinking_level_select` for the thinking level. Recording
 * those gives an authoritative view of what the main session is running right
 * now, which is what a subagent should inherit.
 *
 * This module is process-local state with no I/O. `register.ts` feeds it from
 * the pi events; the spawn paths read it through {@link resolveParentModel}.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { RunModelContext } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { availableModelInfosFromRegistry, modelRefToString, providerOfModelRef } from "./model-fallback.ts";

export type SessionModelSource = "model_select" | "session_start" | "none";

interface SessionModelState {
	model?: string;
	thinking?: string;
	source: SessionModelSource;
	updatedAt?: number;
}

const state: SessionModelState = { source: "none" };

// --- Live-session per-agent quota attribution ---
//
// In the opt-in `live-session` runtime, multiple in-process subagents share
// this ONE module-scoped tracker. The `after_provider_response` event carries
// no sessionId/model field, so the global `currentSessionModel()` returns the
// MAIN session's model regardless of which in-process agent actually produced
// the response. That mis-attributes quota (e.g. a provider-B 429 written under
// provider-A's key).
//
// AsyncLocalStorage propagates each live agent's known model through the
// async call chain. `resolveProviderForResponse()` checks it first, then falls
// back to a guard (skip attribution when live agents are active but context
// is absent — prevents contamination), then the original global tracker (the
// default child-process path, unchanged).

/** Per-agent async context for live-session quota attribution. */
export const liveAgentContext = new AsyncLocalStorage<{ agentId: string; modelRef: string }>();

/** Registered live-session agent models (agentId → "provider/id"). */
const liveAgentModels = new Map<string, string>();

// Cap the tracker to prevent unbounded growth if a caller registers an agent
// but fails to unregister it (e.g. a crashed/disposed live agent). Matches the
// precedent in live-agent-manager.ts (MAX_LIVE_AGENTS). When at cap, evict the
// oldest insertion (Map preserves insertion order); a leaked entry also pins
// hasActiveLiveAgents()=true, so bounding it matters beyond raw memory.
const MAX_LIVE_AGENT_MODELS = 5_000;

/** Record a live-session agent's resolved model for quota attribution. */
export function registerLiveAgentModel(agentId: string, model: string): void {
	if (liveAgentModels.size >= MAX_LIVE_AGENT_MODELS && !liveAgentModels.has(agentId)) {
		const oldestKey = liveAgentModels.keys().next().value;
		if (oldestKey !== undefined) {
			logInternalError(
				"session-model.liveAgentModels.cap",
				new Error(`liveAgentModels at cap ${MAX_LIVE_AGENT_MODELS}; evicting oldest ${oldestKey}`),
			);
			liveAgentModels.delete(oldestKey);
		}
	}
	liveAgentModels.set(agentId, model);
}

/** Remove a live-session agent's model (called in the finally block). */
export function unregisterLiveAgentModel(agentId: string): void {
	liveAgentModels.delete(agentId);
}

/** Whether any live-session agents are currently registered. */
export function hasActiveLiveAgents(): boolean {
	return liveAgentModels.size > 0;
}

/**
 * Resolve the provider for an `after_provider_response` event.
 *
 * Priority:
 *   1. Async context from the live-session agent that issued the request
 *      (correct per-agent attribution — pi-crew knows each agent's model).
 *   2. Live agents are active but the context didn't propagate → skip
 *      attribution entirely (return undefined) to PREVENT cross-agent
 *      contamination.
 *   3. No live agents (default child-process runtime) → original behavior:
 *      attribute to the global session model's provider.
 */
export function resolveProviderForResponse(): string | undefined {
	const ctx = liveAgentContext.getStore();
	if (ctx) return providerOfModelRef(ctx.modelRef);
	if (hasActiveLiveAgents()) return undefined;
	return providerOfModelRef(currentSessionModel());
}

/**
 * Record the model the main session is running. Accepts pi's `Model` object
 * (`{ provider, id }`) or a `"provider/id"` string; anything unrecognized is
 * ignored so a pi API change can never blank out a known-good value.
 */
export function noteSessionModel(model: unknown, source: SessionModelSource = "model_select"): void {
	const normalized = modelRefToString(model);
	if (!normalized) return;
	// `session_start` only seeds: pi may emit `model_select` (source "restore")
	// before session_start, and that value is authoritative. Letting the seed
	// overwrite it would put the stale saved model back.
	if (source === "session_start" && state.source === "model_select") return;
	state.model = normalized;
	state.source = source;
	state.updatedAt = Date.now();
}

/**
 * Record the main session's thinking level. An explicit `"off"`/`""` clears it;
 * a non-string (e.g. `ctx.thinkingLevel` on a context that does not expose one)
 * is ignored so seeding cannot erase a tracked value.
 */
export function noteSessionThinking(level: unknown): void {
	if (typeof level !== "string") return;
	const value = level.trim();
	state.thinking = value && value !== "off" ? value : undefined;
}

/** The main session's live model as `"provider/id"`, when known. */
export function currentSessionModel(): string | undefined {
	return state.model;
}

/** The main session's live thinking level, when known. */
export function currentSessionThinking(): string | undefined {
	return state.thinking;
}

/**
 * Resolve the model a subagent should inherit. The live `model_select` value
 * wins over `ctx.model` because the latter can be stale session state; the
 * caller's value is the fallback for contexts that never saw the event
 * (e.g. a fresh headless run).
 */
export function resolveParentModel(ctxModel: unknown): string | undefined {
	return state.model ?? modelRefToString(ctxModel);
}

/**
 * Snapshot everything the model router needs, for a run that will execute
 * outside this process (background/async). Returns undefined when there is
 * nothing worth persisting, so old manifests stay byte-identical.
 */
export function captureRunModelContext(
	ctx: { model?: unknown; modelRegistry?: unknown; thinkingLevel?: unknown },
	override?: string,
): RunModelContext | undefined {
	const parentModel = resolveParentModel(ctx.model);
	const registryModels = availableModelInfosFromRegistry(ctx.modelRegistry);
	const availableModels = registryModels && registryModels.length > 0 ? registryModels.map((model) => model.fullId) : undefined;
	const parentThinking = currentSessionThinking() ?? (typeof ctx.thinkingLevel === "string" ? ctx.thinkingLevel : undefined);
	const trimmedOverride = override?.trim() || undefined;
	if (!parentModel && !availableModels && !parentThinking && !trimmedOverride) return undefined;
	return {
		...(trimmedOverride ? { override: trimmedOverride } : {}),
		...(parentModel ? { parentModel } : {}),
		...(parentThinking && parentThinking !== "off" ? { parentThinking } : {}),
		...(availableModels ? { availableModels } : {}),
	};
}

/**
 * Rebuild a minimal `ModelRegistry`-shaped object from a persisted catalogue,
 * so the background path feeds `buildConfiguredModelRouting` the same
 * auth-filtered list the caller had instead of falling back to raw models.json.
 */
export function registryFromModelContext(context: RunModelContext | undefined): { getAvailable: () => unknown[] } | undefined {
	const models = context?.availableModels;
	if (!models || models.length === 0) return undefined;
	const entries = models
		.map((fullId) => {
			const slashIdx = fullId.indexOf("/");
			if (slashIdx <= 0) return undefined;
			return { provider: fullId.slice(0, slashIdx), id: fullId.slice(slashIdx + 1) };
		})
		.filter((entry): entry is { provider: string; id: string } => entry !== undefined);
	if (entries.length === 0) return undefined;
	return { getAvailable: () => entries };
}

/** Diagnostic snapshot for `team doctor`. */
export function sessionModelSnapshot(): Readonly<Required<Pick<SessionModelState, "source">> & SessionModelState> {
	return { ...state };
}

/** @internal Test seam — reset tracked state between cases. */
export function __test_resetSessionModel(): void {
	state.model = undefined;
	state.thinking = undefined;
	state.source = "none";
	state.updatedAt = undefined;
	liveAgentModels.clear();
}
