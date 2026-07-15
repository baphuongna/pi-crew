import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiTeamsConfig } from "../../config/config.ts";
import type { MetricRegistry } from "../../observability/metric-registry.ts";
import type { RunSnapshotCache } from "../../ui/run-snapshot-cache.ts";
import type { TeamToolDetails } from "../team-tool-types.ts";
import { type PiTeamsToolResult, toolResult } from "../tool-result.ts";

export type TeamContext = Pick<ExtensionContext, "cwd"> &
	Partial<Pick<ExtensionContext, "model">> & {
		sessionId?: string;
		modelRegistry?: unknown;
		sessionManager?: { getBranch?: () => unknown[] };
		events?: { emit?: (event: string, data: unknown) => void };
		metricRegistry?: MetricRegistry;
		signal?: AbortSignal;
		startForegroundRun?: (runner: (signal?: AbortSignal) => Promise<void>, runId?: string) => void;
		abortForegroundRun?: (runId: string) => boolean;
		onRunStarted?: (runId: string) => void;
		onJsonEvent?: (taskId: string, runId: string, event: unknown) => void;
		config?: PiTeamsConfig;
		getRunSnapshotCache?: (cwd: string) => RunSnapshotCache;
	};

export function withSessionId<T extends Pick<ExtensionContext, "sessionManager">>(ctx: T): T & { sessionId?: string } {
	const sessionId = ctx.sessionManager?.getSessionId?.();
	return sessionId ? { ...ctx, sessionId } : { ...ctx };
}

export function result(text: string, details: TeamToolDetails, isError = false): PiTeamsToolResult {
	return toolResult(text, details, isError);
}

export function formatScoped(name: string, source: string, description: string): string {
	return `- ${name} (${source}): ${description}`;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && !Array.isArray(part) && typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

/**
 * Maximum character budget for inherited parent context (~3K tokens).
 * When exceeded, oldest messages are dropped first (most-recent-first retention).
 */
export const MAX_PARENT_CONTEXT_CHARS = 12_000;

/** Maximum chars for a single assistant message before truncation. */
const MAX_ASSISTANT_MSG_CHARS = 500;

/** Truncated length for oversized assistant messages. */
const TRUNCATED_ASSISTANT_CHARS = 200;

/** Messages starting with these patterns and exceeding this size are likely
 *  file dumps / bash output — skip them to keep context relevant and compact. */
const NOISY_THRESHOLD = 1_000;
const NOISY_PREFIXES = ["```", "total ", "drwx", "-rw", "import ", "export "];

/**
 * Check if a message looks like noisy file/tool output (code dumps, ls output,
 * import lists) that bloats context without helping the subagent.
 */
function isNoisyContent(text: string): boolean {
	if (text.length < NOISY_THRESHOLD) return false;
	return NOISY_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * Build a compact parent conversation context for subagent inheritance.
 *
 * Extracts recent user messages, assistant reasoning, and compaction summaries
 * from the parent session. Applies a character budget (most-recent-first
 * retention) and filters noisy content (file dumps, long bash output) to keep
 * the inherited context relevant without bloating the subagent's token budget.
 */
export function buildParentContext(ctx: TeamContext): string | undefined {
	const branch = ctx.sessionManager?.getBranch?.();
	// DEBUG: log to /tmp/pi-crew-cold-debug.log
	try {
		const fs = require("node:fs");
		fs.appendFileSync("/tmp/pi-crew-cold-debug.log", `[ctx] hasSessionMgr=${!!ctx.sessionManager} hasGetBranch=${!!ctx.sessionManager?.getBranch} branchLen=${Array.isArray(branch) ? branch.length : "not-array"} branchType=${typeof branch}\n`);
	} catch {}
	if (!Array.isArray(branch) || branch.length === 0) return undefined;
	const parts: string[] = [];
	for (const entry of branch.slice(-20)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as {
			type?: unknown;
			message?: unknown;
			summary?: unknown;
		};
		// Compaction summaries are always valuable — keep in full.
		if (record.type === "compaction" && typeof record.summary === "string") {
			parts.push(`[Summary]: ${record.summary}`);
			continue;
		}
		const message =
			record.message && typeof record.message === "object" && !Array.isArray(record.message)
				? (record.message as { role?: unknown; content?: unknown })
				: undefined;
		if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
		let text = extractTextContent(message.content).trim();
		if (!text) continue;
		// Filter: skip noisy content (file dumps, long bash output).
		if (isNoisyContent(text)) continue;
		// Truncate: long assistant messages get shortened to key points.
		if (message.role === "assistant" && text.length > MAX_ASSISTANT_MSG_CHARS) {
			text = `${text.slice(0, TRUNCATED_ASSISTANT_CHARS)}…`;
		}
		parts.push(`[${message.role === "user" ? "User" : "Assistant"}]: ${text}`);
	}
	if (!parts.length) return undefined;

	// Budget: keep most-recent messages first, drop oldest when over budget.
	let totalChars = 0;
	const budgeted: string[] = [];
	for (const part of [...parts].reverse()) {
		if (totalChars + part.length > MAX_PARENT_CONTEXT_CHARS) break;
		budgeted.unshift(part);
		totalChars += part.length;
	}
	if (!budgeted.length) return undefined;

	return [
		`# Parent Conversation Context`,
		"The following context was inherited from the parent Pi session. Treat it as reference-only.",
		"",
		budgeted.join("\n\n"),
	].join("\n");
}

export function configRecord(config: unknown): Record<string, unknown> {
	if (!config || typeof config !== "object" || Array.isArray(config)) return {};
	return config as Record<string, unknown>;
}
