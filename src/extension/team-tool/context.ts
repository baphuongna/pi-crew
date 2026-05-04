import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MetricRegistry } from "../../observability/metric-registry.ts";
import type { TeamToolDetails } from "../team-tool-types.ts";
import { toolResult, type PiTeamsToolResult } from "../tool-result.ts";

export type TeamContext = Pick<ExtensionContext, "cwd"> & Partial<Pick<ExtensionContext, "model">> & {
	modelRegistry?: unknown;
	sessionManager?: { getBranch?: () => unknown[] };
	events?: { emit?: (event: string, data: unknown) => void };
	metricRegistry?: MetricRegistry;
	signal?: AbortSignal;
	startForegroundRun?: (runner: (signal?: AbortSignal) => Promise<void>, runId?: string) => void;
	onRunStarted?: (runId: string) => void;
	onJsonEvent?: (taskId: string, runId: string, event: unknown) => void;
};

export function result(text: string, details: TeamToolDetails, isError = false): PiTeamsToolResult {
	return toolResult(text, details, isError);
}

export function formatScoped(name: string, source: string, description: string): string {
	return `- ${name} (${source}): ${description}`;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => part && typeof part === "object" && !Array.isArray(part) && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").filter(Boolean).join("\n");
}

export function buildParentContext(ctx: TeamContext): string | undefined {
	const branch = ctx.sessionManager?.getBranch?.();
	if (!Array.isArray(branch) || branch.length === 0) return undefined;
	const parts: string[] = [];
	for (const entry of branch.slice(-20)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as { type?: unknown; message?: unknown; summary?: unknown };
		if (record.type === "compaction" && typeof record.summary === "string") parts.push(`[Summary]: ${record.summary}`);
		const message = record.message && typeof record.message === "object" && !Array.isArray(record.message) ? record.message as { role?: unknown; content?: unknown } : undefined;
		if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
		const text = extractTextContent(message.content).trim();
		if (text) parts.push(`[${message.role === "user" ? "User" : "Assistant"}]: ${text}`);
	}
	if (!parts.length) return undefined;
	return [`# Parent Conversation Context`, "The following context was inherited from the parent Pi session. Treat it as reference-only.", "", parts.join("\n\n")].join("\n");
}

export function configRecord(config: unknown): Record<string, unknown> {
	if (!config || typeof config !== "object" || Array.isArray(config)) return {};
	return config as Record<string, unknown>;
}
