export interface ProgressEventSummary {
	eventType: string;
	currentTool?: string;
	toolCount?: number;
	tokens?: number;
	turns?: number;
	activityState?: string;
	lastActivityAt?: string;
}

export interface ProgressEventCoalesceDecision {
	shouldAppend: boolean;
	reason: string;
}

export interface ProgressEventCoalesceInput {
	previous?: ProgressEventSummary;
	next: ProgressEventSummary;
	nowMs: number;
	lastAppendMs?: number;
	minIntervalMs: number;
	force?: boolean;
	tokenThreshold?: number;
}

const DEFAULT_TOKEN_THRESHOLD = 256;

function numericIncrease(previous: number | undefined, next: number | undefined): number {
	return next !== undefined && previous !== undefined ? next - previous : next !== undefined ? next : 0;
}

export function shouldAppendProgressEventUpdate(input: ProgressEventCoalesceInput): ProgressEventCoalesceDecision {
	if (input.force) return { shouldAppend: true, reason: "force" };
	if (!input.previous) return { shouldAppend: true, reason: "first" };
	if (input.previous.activityState !== input.next.activityState) return { shouldAppend: true, reason: "activity_changed" };
	if (input.previous.currentTool !== input.next.currentTool) return { shouldAppend: true, reason: "tool_changed" };
	if (numericIncrease(input.previous.toolCount, input.next.toolCount) > 0) return { shouldAppend: true, reason: "tool_count_increased" };
	if (numericIncrease(input.previous.turns, input.next.turns) > 0) return { shouldAppend: true, reason: "turns_increased" };
	const tokenIncrease = numericIncrease(input.previous.tokens, input.next.tokens);
	if (tokenIncrease >= (input.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD)) return { shouldAppend: true, reason: "tokens_increased" };
	if (input.lastAppendMs === undefined || input.nowMs - input.lastAppendMs >= input.minIntervalMs)
		return { shouldAppend: true, reason: "interval" };
	return { shouldAppend: false, reason: "coalesced" };
}
