/**
 * Anchor commands for team tool.
 * Provides set/clear/status commands for anchor points.
 */

import {
	type AnchorManager,
	AnchorNotFoundError,
	type AnchorStatus,
	createAnchorManager,
	NoHandoffsError,
} from "../../runtime/anchor-manager.ts";
import type { HandoffSummary } from "../../runtime/handoff-manager.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { result, type TeamContext } from "./context.ts";

// Global anchor manager instance for CLI usage
let globalAnchorManager: AnchorManager | null = null;

function getAnchorManager(): AnchorManager {
	if (!globalAnchorManager) {
		globalAnchorManager = createAnchorManager();
	}
	return globalAnchorManager;
}

/**
 * Get the session ID from context or generate a default.
 */
function getSessionId(ctx: TeamContext): string {
	return ctx.sessionId ?? "default";
}

export function handleAnchorSet(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const manager = getAnchorManager();
	const sessionId = getSessionId(ctx);
	const cfg = params.config ?? {};

	// Parse context from config
	const POLLUTED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
	const context: Record<string, unknown> = {};
	if (cfg.context && typeof cfg.context === "object") {
		const raw = cfg.context as Record<string, unknown>;
		for (const [k, v] of Object.entries(raw)) {
			if (!POLLUTED_KEYS.has(k)) context[k] = v;
		}
	}
	if (cfg.key) {
		// Single key shorthand
		context.key = cfg.key;
	}

	const anchorId = manager.setAnchor(sessionId, context);

	return result(
		[
			`Anchor set successfully.`,
			`Anchor ID: ${anchorId}`,
			`Session: ${sessionId}`,
			context && Object.keys(context).length > 0 ? `Context: ${JSON.stringify(context)}` : "",
		]
			.filter(Boolean)
			.join("\n"),
		{ action: "anchor", status: "ok" },
	);
}

export function handleAnchorClear(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const manager = getAnchorManager();
	const sessionId = getSessionId(ctx);
	const cfg = params.config ?? {};

	let anchorId: string | undefined;
	if (cfg.anchorId) {
		anchorId = cfg.anchorId as string;
	}

	let accumulated: HandoffSummary;
	try {
		if (anchorId) {
			accumulated = manager.clearAnchor(anchorId);
		} else {
			const anchorResult = manager.clearAnchorBySession(sessionId);
			if (!anchorResult) {
				return result("No anchor found for this session.", { action: "anchor", status: "error" }, true);
			}
			accumulated = anchorResult;
		}
	} catch (error) {
		if (error instanceof AnchorNotFoundError) {
			return result(`Anchor not found: ${error.anchorId}`, { action: "anchor", status: "error" }, true);
		}
		if (error instanceof NoHandoffsError) {
			return result("No handoffs have been accumulated to this anchor.", { action: "anchor", status: "error" }, true);
		}
		throw error;
	}

	return result(
		[
			`Anchor cleared successfully.`,
			`Accumulated summary:`,
			``,
			`Task: ${accumulated.task}`,
			`Outcome: ${accumulated.outcome}`,
			``,
			`Metrics:`,
			`  Tokens: ${accumulated.metrics.tokensUsed}`,
			`  Duration: ${Math.round(accumulated.metrics.duration / 1000)}s`,
			`  Iterations: ${accumulated.metrics.iterations}`,
			`  Tools: ${accumulated.metrics.toolsUsed.join(", ") || "(none)"}`,
			``,
			`Files created: ${accumulated.filesCreated.join(", ") || "(none)"}`,
			`Files modified: ${accumulated.filesModified.join(", ") || "(none)"}`,
			`Files deleted: ${accumulated.filesDeleted.join(", ") || "(none)"}`,
			accumulated.decisions.length > 0
				? `\nDecisions:\n${accumulated.decisions.map((d: { rationale: string; outcome: string }) => `  - ${d.rationale}: ${d.outcome}`).join("\n")}`
				: "",
			accumulated.blockers.length > 0 ? `\nBlockers: ${accumulated.blockers.join("; ")}` : "",
			accumulated.nextSteps.length > 0 ? `\nNext steps: ${accumulated.nextSteps.join("; ")}` : "",
		]
			.filter(Boolean)
			.join("\n"),
		{ action: "anchor", status: "ok" },
	);
}

export function handleAnchorStatus(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const manager = getAnchorManager();
	const sessionId = getSessionId(ctx);
	const cfg = params.config ?? {};

	let anchorId: string | undefined;
	if (cfg.anchorId) {
		anchorId = cfg.anchorId as string;
	}

	let status: AnchorStatus | null;
	if (anchorId) {
		status = manager.getAnchorStatus(anchorId);
	} else {
		status = manager.getAnchorStatusBySession(sessionId);
	}

	if (!status) {
		return result(anchorId ? `No anchor found with ID: ${anchorId}` : `No anchor set for session: ${sessionId}`, {
			action: "anchor",
			status: "ok",
		});
	}

	return result(
		[
			`Anchor Status`,
			`─────────────`,
			`Anchor ID: ${status.anchorId}`,
			`Session ID: ${status.sessionId}`,
			`Created: ${new Date(status.createdAt).toISOString()}`,
			`Handoffs: ${status.handoffCount}`,
			`Total tokens: ${status.totalTokens}`,
			`Total duration: ${Math.round(status.totalDuration / 1000)}s`,
			status.context && Object.keys(status.context).length > 0 ? `\nContext: ${JSON.stringify(status.context, null, 2)}` : "",
		]
			.filter(Boolean)
			.join("\n"),
		{ action: "anchor", status: "ok" },
	);
}

export function handleAnchorAccumulate(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	// This would be used to manually accumulate a handoff to the current anchor
	// In practice, this is called internally by HandoffManager when anchor is set
	return result("Use handleAnchorSet to set an anchor, then run tasks normally. Handoffs will be accumulated automatically.", {
		action: "anchor",
		status: "ok",
	});
}
