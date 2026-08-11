/**
 * pi-api.ts — pi-crew's stable seam against the Pi extension API.
 *
 * PURPOSE (roadmap Phase 0 / Pillar 4 "Pi-Native, Protocol-Aware"):
 * Centralize every symbol pi-crew imports from
 * `@earendil-works/pi-coding-agent` so that:
 *   1. The coupling surface is auditable in ONE file (8 symbols today).
 *   2. A Pi API rename/restructure requires updating only this seam.
 *   3. New code imports from here ("./pi-api") rather than the raw package,
 *      establishing the indirection that hedges Pi-coupling risk.
 *
 * COUpling SURFACE (kept intentionally small — public extension API only):
 *   - ExtensionAPI              the registration entry point (pi)
 *   - ExtensionContext          per-event/session context (ctx)
 *   - ExtensionCommandContext   slash-command context
 *   - ToolDefinition            tool schema type
 *   - defineTool                tool factory
 *   - createBashTool            built-in bash tool (for custom tooling)
 *   - AgentSessionEvent         session event type
 *   - BeforeAgentStartEvent     pre-turn system-prompt hook event
 *
 * NEW code should `import { ExtensionAPI, ExtensionContext } from "./pi-api"`.
 * Existing files may keep their direct imports; migrate opportunistically
 * (no big-bang refactor — see roadmap Phase 0 T0.3/T0.4 notes).
 *
 * Note: these are TYPE-level re-exports (erased at runtime). Runtime coupling
 * to Pi is via the `pi` and `ctx` objects passed by Pi's loader — that is
 * unavoidable and correct (pi-crew IS a Pi extension). This seam documents
 * and centralizes the type-level surface.
 */
export type {
	AgentSessionEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export { createBashTool, defineTool } from "@earendil-works/pi-coding-agent";
