export interface ParsedPiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	turns?: number;
}

export interface ParsedPiJsonOutput {
	jsonEvents: number;
	textEvents: string[];
	finalText?: string;
	usage?: ParsedPiUsage;
	/** Unified patches extracted from tool_result events (edit tool patch field) */
	patches?: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function mergeUsage(target: ParsedPiUsage, source: ParsedPiUsage): ParsedPiUsage {
	return {
		input: source.input ?? target.input,
		output: source.output ?? target.output,
		cacheRead: source.cacheRead ?? target.cacheRead,
		cacheWrite: source.cacheWrite ?? target.cacheWrite,
		cost: source.cost ?? target.cost,
		turns: source.turns ?? target.turns,
	};
}

function extractUsage(value: unknown): ParsedPiUsage | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const direct: ParsedPiUsage = {
		input: numberField(obj, ["input", "inputTokens", "input_tokens"]),
		output: numberField(obj, ["output", "outputTokens", "output_tokens"]),
		cacheRead: numberField(obj, ["cacheRead", "cache_read", "cacheReadTokens", "cache_read_tokens"]),
		cacheWrite: numberField(obj, ["cacheWrite", "cache_write", "cacheWriteTokens", "cache_write_tokens"]),
		cost: numberField(obj, ["cost", "costUsd", "cost_usd"]),
		turns: numberField(obj, ["turns", "turnCount", "turn_count"]),
	};
	if (Object.values(direct).some((entry) => entry !== undefined)) return direct;
	for (const key of ["usage", "tokenUsage", "tokens", "stats"]) {
		const nested = extractUsage(obj[key]);
		if (nested) return nested;
	}
	return undefined;
}

function textFromContent(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const text: string[] = [];
	for (const part of content) {
		const obj = asRecord(part);
		if (!obj) continue;
		if (obj.type === "text" && typeof obj.text === "string") text.push(obj.text);
		else if (typeof obj.content === "string") text.push(obj.content);
	}
	return text;
}

function extractText(value: unknown): string[] {
	const obj = asRecord(value);
	if (!obj) return [];
	const message = asRecord(obj.message);
	if (message?.role !== undefined && message.role !== "assistant") return [];
	const text: string[] = [];
	if (typeof obj.text === "string") text.push(obj.text);
	if (typeof obj.output === "string") text.push(obj.output);
	if (typeof obj.finalOutput === "string") text.push(obj.finalOutput);
	if (typeof obj.final_output === "string") text.push(obj.final_output);
	if (!message) text.push(...textFromContent(obj.content));
	if (message) text.push(...textFromContent(message.content));
	return text.filter((entry) => entry.trim().length > 0);
}

export function parsePiJsonOutput(stdout: string): ParsedPiJsonOutput {
	let jsonEvents = 0;
	const textEvents: string[] = [];
	const patches: string[] = [];
	let usage: ParsedPiUsage | undefined;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed) as unknown;
		} catch {
			continue;
		}
		jsonEvents++;
		textEvents.push(...extractText(event));
		// Extract unified patches from tool_result events
		extractPatch(event, patches);
		const eventUsage = extractUsage(event);
		if (eventUsage) usage = mergeUsage(usage ?? {}, eventUsage);
	}
	return {
		jsonEvents,
		textEvents,
		finalText: textEvents.length > 0 ? textEvents[textEvents.length - 1] : undefined,
		usage,
		patches: patches.length > 0 ? patches : undefined,
	};
}

/**
 * Extract unified patches from a tool_result event.
 * pi's edit tool now includes a `patch` field (standard unified diff format).
 * We detect it by looking for lines starting with "---" or "+++" which indicate
 * unified diff format.
 */
function extractPatch(event: unknown, patches: string[]): void {
	const obj = asRecord(event);
	if (!obj || obj.type !== "tool_result") return;

	const content = obj.content;
	if (!Array.isArray(content)) return;

	for (const item of content) {
		const part = asRecord(item);
		if (!part || part.type !== "text") continue;
		const text = typeof part.text === "string" ? part.text : "";

		// Check if this looks like a unified patch (starts with "---" or "+++")
		if (text.includes("--- a/") || text.includes("diff ---")) {
			patches.push(text);
		}
	}
}
