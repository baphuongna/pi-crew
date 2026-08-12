/**
 * Shared context for extracted `api` operation handlers (H3 phase 1+).
 *
 * The `handleApi` function in `src/extension/team-tool/api.ts` was 1222 lines
 * with 35+ `if (operation === "…")` branches. This file defines the shared
 * bundle of closure dependencies that each extracted handler receives, so
 * sibling modules under `src/extension/team-tool/api/<group>.ts` can be
 * pure-function-shaped without re-establishing the closure.
 *
 * Extraction pattern mirrors `merge-gate.ts` (improvement-plan-2026-08-09
 * phase 5): the extracted module imports its own state/coordination helpers
 * directly; only the request-scoped values (config, loaded run, params,
 * extension context) are passed via this context.
 *
 * Phase 2 (2026-08-10): added `params` + `ctx` and made handlers async-capable
 * (several operations await live-agent or runtime resolution).
 */

import type { TeamToolParamsValue } from "../../../schema/team-tool-schema.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../state/types.ts";
import type { PiTeamsToolResult } from "../../tool-result.ts";
import type { result as resultFn, TeamContext } from "../context.ts";
import type { paramRequired as paramRequiredFn } from "../param-error.ts";

/** The config record produced by `configRecord(params.config)` in handleApi. */
export type ApiConfig = Record<string, unknown>;

/** The loaded run snapshot returned by `loadRunManifestById`. */
export interface ApiLoadedRun {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
}

/**
 * Bundle of closure-scoped dependencies that handleApi establishes once and
 * passes to each extracted handler. Adding a field here is cheaper than
 * growing the closure of a 1200-line function.
 */
export interface ApiHandlerContext {
	cfg: ApiConfig;
	loaded: ApiLoadedRun;
	result: typeof resultFn;
	paramRequired: typeof paramRequiredFn;
	/** The raw tool params (runId, force, etc.) the caller passed. */
	params: TeamToolParamsValue;
	/** The extension TeamContext (cwd, events, metricRegistry, config…). */
	ctx: TeamContext;
}

/** Type alias for an extracted operation handler. Async-capable. */
export type ApiOperationHandler = (ctx: ApiHandlerContext) => PiTeamsToolResult | Promise<PiTeamsToolResult>;

/**
 * Handler for operations that run BEFORE the runId guard (no loaded run).
 * Currently: metrics-snapshot, inventory.
 */
export type ApiPreHandler = (ctx: Omit<ApiHandlerContext, "loaded">) => PiTeamsToolResult | Promise<PiTeamsToolResult>;
