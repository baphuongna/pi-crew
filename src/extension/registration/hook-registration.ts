/**
 * Generic event-hook installer for pi-crew.
 *
 * Owns the non-lifecycle `pi.on(...)` subscribers:
 *   • `tool_call`     — destructive-team-action permission gate.
 *   • `tool_result`   — per-write validation (catches malformed config at
 *                       write time, not at next load).
 *   • `resources_discover` — injects pi-crew skill paths.
 *
 * Session-lifecycle hooks (`session_start`, `session_shutdown`,
 * `session_before_switch`) live in `lifecycle-handlers.ts` because they
 * are heavy and own the deferred-cleanup + scheduler + render-loop setup.
 *
 * Compaction-guard hooks live in `compaction-guard.ts` because they were
 * already extracted; this file does NOT re-register them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { asRecord, loadConfig } from "../../config/config.ts";
import { buildValidationBlocker, extractPathFromInput, validateWrittenFile } from "../../runtime/per-write-validator.ts";
import { shouldBlockDestructiveTeamAction } from "../team-tool/destructive-gate.ts";
import { resolveContainedPath } from "../../utils/safe-paths.ts";
import type { RegistrationContext } from "./registration-types.ts";

/**
 * Register all non-lifecycle event hooks on the ExtensionAPI.
 *
 * Safe to call once during `registerPiTeams`. Does not stack idempotency
 * guards — these hooks are intentionally re-registered on reload (the
 * orchestrator's `previousRuntimeCleanup` handles cleanup of derived state).
 */
export function installPiHooks(pi: ExtensionAPI, ctx: RegistrationContext): void {
	installResourcesDiscoverHook(pi, ctx);
	installToolCallHook(pi, ctx);
	installToolResultHook(pi, ctx);
}

/**
 * Phase 11a: Dynamic resource discovery — inject pi-crew skill paths.
 *
 * Older Pi versions without `resources_discover` are tolerated (try/catch
 * around pi.on; missing support is a no-op).
 */
function installResourcesDiscoverHook(pi: ExtensionAPI, ctx: RegistrationContext): void {
	try {
		pi.on("resources_discover", () => {
			const sessionCwd = ctx.currentCtx?.cwd ?? process.cwd();
			const skillDir = path.resolve(sessionCwd, "skills");
			const extSkillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
			const paths: string[] = [];
			if (fs.existsSync(extSkillDir)) paths.push(extSkillDir);
			if (skillDir !== extSkillDir && fs.existsSync(skillDir)) {
				// Validate skillDir is within sessionCwd to prevent path traversal
				try {
					resolveContainedPath(sessionCwd, "skills");
					paths.push(skillDir);
				} catch {
					// skillDir outside sessionCwd boundary — skip
				}
			}
			return paths.length > 0 ? { skillPaths: paths } : {};
		});
	} catch {
		/* older Pi without resources_discover */
	}
}

/**
 * Phase 1.4: Permission gate for destructive team actions.
 *
 * AGENTS.md requires `confirm: true` for management deletes. We enforce it
 * at the tool_call boundary so the user gets a clear error rather than
 * executing a destructive action silently.
 */
function installToolCallHook(_pi: ExtensionAPI, _ctx: RegistrationContext): void {
	_pi.on("tool_call", async (event) => {
		if (event.toolName !== "team") return;
		const rawInput = event.input;
		if (!rawInput || typeof rawInput !== "object") return;
		const input = asRecord(rawInput);
		if (!input) return;
		const action = typeof input.action === "string" ? input.action : undefined;
		const reason = shouldBlockDestructiveTeamAction(action, input);
		if (!reason) return;
		return {
			block: true as const,
			reason,
		};
	});
}

/**
 * T5 (v0.8.5): per-write validation. On write/edit, run a zero-cost
 * SYNCHRONOUS validator (v1: JSON.parse) and append a 🔴 blocker to the
 * tool result on failure — catches malformed config the moment it's
 * written, not at the next load. Latency-safe by construction: no process
 * spawn, one disk read ONLY for validated extensions, dedup'd by content.
 * Toggle via runtime.reliability.perWriteValidation (default true).
 * Process-spawning validators (.js/.sh/.py) are a future opt-in.
 */
function installToolResultHook(_pi: ExtensionAPI, _ctx: RegistrationContext): void {
	_pi.on("tool_result", (event, ctx) => {
		try {
			if (event.toolName !== "write" && event.toolName !== "edit") return;
			if (loadConfig(ctx.cwd).config.reliability?.perWriteValidation === false) return;
			const filePath = extractPathFromInput(event.input);
			if (!filePath) return;
			const result = validateWrittenFile(filePath);
			if (!result || result.ok) return;
			return {
				content: [...event.content, buildValidationBlocker(filePath, result.error ?? "validation failed")],
			};
		} catch {
			// best-effort: never break a tool result
		}
	});
}
