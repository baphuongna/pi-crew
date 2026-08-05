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

import type { RunModelContext } from "../../state/types.ts";
import { availableModelInfosFromRegistry, modelRefToString } from "./model-fallback.ts";

export type SessionModelSource = "model_select" | "session_start" | "none";

interface SessionModelState {
	model?: string;
	thinking?: string;
	source: SessionModelSource;
	updatedAt?: number;
}

const state: SessionModelState = { source: "none" };

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
}
