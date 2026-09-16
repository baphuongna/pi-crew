import { summarizeHeartbeats } from "../heartbeat-aggregator.ts";
import { formatHint } from "../rail.ts";
import type { RunUiSnapshot } from "../snapshot-types.ts";

export interface HealthPaneOptions {
	staleMs?: number;
	deadMs?: number;
	isForeground?: boolean;
	now?: number | Date;
}

function seconds(ms: number): string {
	return `${Math.round(ms / 1000)}s`;
}

export function renderHealthPane(snapshot: RunUiSnapshot | undefined, opts: HealthPaneOptions = {}): string[] {
	if (!snapshot) return ["Health pane: snapshot unavailable"];
	const summary = summarizeHeartbeats(snapshot, opts);
	const lines = [
		`Health pane: ${summary.healthy}/${summary.totalTasks} healthy · stale=${summary.stale} · dead=${summary.dead} · missing=${summary.missing}`,
	];
	if (summary.worstStaleMs > 0) lines.push(`Worst stale: ${seconds(summary.worstStaleMs)} ago`);
	// One hint format (rail.ts `formatHint`): keys `label` joined by ` · `.
	const hints: Array<readonly [string, string]> = [];
	const foreground = opts.isForeground !== false;
	if ((summary.dead > 0 || summary.missing > 0) && foreground) hints.push(["R", "recovery"]);
	if ((summary.dead > 0 || summary.stale > 0) && foreground) hints.push(["K", "kill stale"]);
	hints.push(["D", "diagnostic export"]);
	lines.push(`Actions: ${formatHint(hints)}`);
	if (!foreground && (summary.dead > 0 || summary.missing > 0 || summary.stale > 0))
		lines.push("Async run: R/K disabled — inspect process manually or use /team-api.");
	return lines;
}
