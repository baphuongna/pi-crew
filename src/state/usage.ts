import type { TeamTaskState, UsageState } from "./types.ts";

export function aggregateUsage(tasks: TeamTaskState[]): UsageState | undefined {
	const total: UsageState = {};
	let found = false;
	for (const task of tasks) {
		if (!task.usage) continue;
		found = true;
		total.input = (total.input ?? 0) + (task.usage.input ?? 0);
		total.output = (total.output ?? 0) + (task.usage.output ?? 0);
		total.cacheRead = (total.cacheRead ?? 0) + (task.usage.cacheRead ?? 0);
		total.cacheWrite = (total.cacheWrite ?? 0) + (task.usage.cacheWrite ?? 0);
		total.cost = (total.cost ?? 0) + (task.usage.cost ?? 0);
		total.turns = (total.turns ?? 0) + (task.usage.turns ?? 0);
	}
	return found ? total : undefined;
}

export function formatUsage(usage: UsageState | undefined): string {
	if (!usage) return "(none)";
	const parts: string[] = [];
	if (usage.input !== undefined) parts.push(`input=${usage.input}`);
	if (usage.output !== undefined) parts.push(`output=${usage.output}`);
	if (usage.cacheRead !== undefined) parts.push(`cacheRead=${usage.cacheRead}`);
	if (usage.cacheWrite !== undefined) parts.push(`cacheWrite=${usage.cacheWrite}`);
	if (usage.cost !== undefined && Number.isFinite(usage.cost)) parts.push(`cost=${usage.cost.toFixed(6)}`);
	if (usage.turns !== undefined) parts.push(`turns=${usage.turns}`);
	return parts.join(", ") || "(none)";
}
