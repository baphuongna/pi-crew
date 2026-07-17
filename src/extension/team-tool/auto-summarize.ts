/**
 * Auto-summarize commands for team tool.
 * Provides on/off/status commands for auto-summarization.
 */

import { type AutoSummarizeService, createAutoSummarizeService, DEFAULT_AUTO_SUMMARIZE_CONFIG } from "../../runtime/auto-summarize.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { result, type TeamContext } from "./context.ts";

// Global auto-summarize service instance for CLI usage
let globalAutoSummarize: AutoSummarizeService | null = null;

function getAutoSummarize(): AutoSummarizeService {
	if (!globalAutoSummarize) {
		globalAutoSummarize = createAutoSummarizeService();
	}
	return globalAutoSummarize;
}

export function handleAutoSummarizeOn(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const service = getAutoSummarize();
	const cfg = params.config ?? {};

	// Apply config updates if provided
	if (cfg.threshold !== undefined) {
		const threshold = typeof cfg.threshold === "number" ? cfg.threshold : parseInt(String(cfg.threshold), 10);
		if (!Number.isNaN(threshold) && threshold >= 0) {
			service.setThreshold(threshold);
		}
	}

	if (cfg.minTools !== undefined) {
		const minTools = typeof cfg.minTools === "number" ? cfg.minTools : parseInt(String(cfg.minTools), 10);
		if (!Number.isNaN(minTools) && minTools >= 0) {
			service.setMinToolsUsed(minTools);
		}
	}

	const previousState = service.isEnabled();
	service.enable();
	const config = service.getConfig();

	return result(
		[
			`Auto-summarize enabled.`,
			``,
			`Configuration:`,
			`  Token threshold: ${config.threshold}`,
			`  Min tools: ${config.minToolsUsed}`,
			`  Collapse context: ${config.collapseContext}`,
		].join("\n"),
		{ action: "auto-summarize", status: "ok" },
	);
}

export function handleAutoSummarizeOff(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const service = getAutoSummarize();

	service.disable();

	return result("Auto-summarize disabled.", {
		action: "auto-summarize",
		status: "ok",
	});
}

export function handleAutoSummarizeStatus(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const service = getAutoSummarize();
	const config = service.getConfig();
	const isEnabled = service.isEnabled();

	return result(
		[
			`Auto-summarize Status`,
			`──────────────────`,
			`Enabled: ${isEnabled ? "Yes" : "No"}`,
			``,
			`Configuration:`,
			`  Token threshold: ${config.threshold} (default: ${DEFAULT_AUTO_SUMMARIZE_CONFIG.threshold})`,
			`  Min tools used: ${config.minToolsUsed} (default: ${DEFAULT_AUTO_SUMMARIZE_CONFIG.minToolsUsed})`,
			`  Collapse context: ${config.collapseContext ? "Yes" : "No"} (default: ${DEFAULT_AUTO_SUMMARIZE_CONFIG.collapseContext ? "Yes" : "No"})`,
			``,
			`Triggers:`,
			`  - Token count >= ${config.threshold}`,
			`  - Tool count >= ${config.minToolsUsed}`,
			`  - High token-to-tool ratio (>1000 tokens/tool with 3+ tools)`,
		].join("\n"),
		{ action: "auto-summarize", status: "ok" },
	);
}

export function handleAutoSummarizeConfig(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const service = getAutoSummarize();
	const cfg = params.config ?? {};

	// Parse config options
	const updates: {
		threshold?: number;
		minTools?: number;
		collapseContext?: boolean;
	} = {};

	if (cfg.threshold !== undefined) {
		const threshold = typeof cfg.threshold === "number" ? cfg.threshold : parseInt(String(cfg.threshold), 10);
		if (!Number.isNaN(threshold) && threshold >= 0) {
			updates.threshold = threshold;
		}
	}

	if (cfg.minTools !== undefined) {
		const minTools = typeof cfg.minTools === "number" ? cfg.minTools : parseInt(String(cfg.minTools), 10);
		if (!Number.isNaN(minTools) && minTools >= 0) {
			updates.minTools = minTools;
		}
	}

	if (cfg.collapseContext !== undefined) {
		updates.collapseContext = Boolean(cfg.collapseContext);
	}

	if (Object.keys(updates).length > 0) {
		service.updateConfig(updates);
	}

	const config = service.getConfig();

	return result(
		[
			`Auto-summarize configuration updated.`,
			``,
			`Current settings:`,
			`  Token threshold: ${config.threshold}`,
			`  Min tools used: ${config.minToolsUsed}`,
			`  Collapse context: ${config.collapseContext ? "Yes" : "No"}`,
			`  Enabled: ${config.enabled ? "Yes" : "No"}`,
		].join("\n"),
		{ action: "auto-summarize", status: "ok" },
	);
}
// Re-export for team-tool.ts
export { createAutoSummarizeService } from "../../runtime/auto-summarize.ts";
