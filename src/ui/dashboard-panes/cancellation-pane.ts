import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";

export interface CancellationPaneOptions {
	maxReasons?: number;
}

export function renderCancellationPane(manifest: TeamRunManifest, tasks: TeamTaskState[], opts: CancellationPaneOptions = {}): string[] {
	const maxReasons = opts.maxReasons ?? 5;
	if (manifest.status !== "cancelled" && manifest.status !== "blocked") {
		const cancellingTasks = tasks.filter((t) => t.status === "cancelled");
		if (cancellingTasks.length === 0) return ["Cancellation pane: no active cancellations"];
	}

	const lines: string[] = ["Cancellation pane"];

	if (manifest.status === "cancelled") {
		lines.push(`  Run status: cancelled`);
	} else if (manifest.status === "blocked") {
		lines.push(`  Run status: blocked`);
	}

	const cancelledTasks = tasks.filter((t) => t.status === "cancelled");
	if (cancelledTasks.length > 0) {
		lines.push(`  Cancelled tasks (${cancelledTasks.length}):`);
		for (const task of cancelledTasks.slice(0, maxReasons)) {
			const reason = task.error ?? "unknown";
			lines.push(`    ✗ ${task.id}: ${reason}`);
		}
		if (cancelledTasks.length > maxReasons) {
			lines.push(`    ... and ${cancelledTasks.length - maxReasons} more`);
		}
	}

	if (manifest.policyDecisions?.length) {
		const decisions = manifest.policyDecisions.slice(0, maxReasons);
		lines.push(`  Policy decisions (${manifest.policyDecisions.length}):`);
		for (const d of decisions) {
			lines.push(`    ${d.action}: ${d.message}`);
		}
	}

	return lines;
}