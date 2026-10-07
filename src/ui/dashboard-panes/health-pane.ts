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
	// L7 judgment: this pane IS the diagnostic surface — `stale`/`dead`/
	// `missing` are the exact vocabulary the K kill-stale / R recovery actions
	// and the diagnostic export act on, so the LABELS stay. But the wire
	// separator goes (report L7 flags `stale=`): the line now speaks the same
	// count-first tally dialect as `1/3 healthy`, not `stale=2` key=value.
	const lines = [
		`Health pane: ${summary.healthy}/${summary.totalTasks} healthy · ${summary.stale} stale · ${summary.dead} dead · ${summary.missing} missing`,
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
