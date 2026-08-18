import { computePhaseProgress, formatPhaseProgressLine } from "../../runtime/phase-progress.ts";
import { isPlanApprovalPending } from "../../runtime/plan-approval.ts";
import { renderDwfPhaseLines } from "../dwf-phase-display.ts";
import type { RunUiSnapshot } from "../snapshot-types.ts";

export function renderProgressPane(snapshot: RunUiSnapshot | undefined): string[] {
	if (!snapshot) return ["Progress pane: snapshot unavailable"];
	const progress = snapshot.progress;
	const groupJoins = snapshot.groupJoins ?? [];
	const groupJoinLines = groupJoins.length
		? groupJoins.map((item) => `group join ${item.partial ? "partial" : "completed"}: ${item.requestId} ack=${item.ack}`)
		: ["group joins: none"];
	const cancellationLine = snapshot.cancellationReason ? [`cancelled: reason=${snapshot.cancellationReason}`] : [];
	const runProgress = computePhaseProgress(snapshot.tasks);
	const phaseLines =
		runProgress.phases.length > 0
			? runProgress.phases.map((p) => {
					const done = p.completed + p.failed;
					const status = p.running > 0 ? "running" : p.queued > 0 ? "queued" : done >= p.total ? "done" : "waiting";
					return `  Phase ${p.index + 1} ${p.phase}: ${p.percentage}% (${done}/${p.total}) [${status}]`;
				})
			: [];
	const phaseHeader = phaseLines.length > 0 ? [formatPhaseProgressLine(runProgress), ...phaseLines] : [];
	// DWF logical phases (round-15 P1-4): derived from dwf.phase_* events.
	// Null/absent for non-DWF runs → zero visible change.
	const dwfPhaseLines = snapshot.dwfPhaseState ? renderDwfPhaseLines(snapshot.dwfPhaseState) : [];
	// WP-3 (H4-subset): plan-approval gate banner. Mirrors the health-pane
	// hint pattern — plain foreground text, no color codes (pane output is
	// uncolored by design). One line while the run is parked on approval.
	const planBanner = isPlanApprovalPending(snapshot.manifest) ? ["⚠ plan approval pending — A approve / n deny"] : [];
	return [
		`Progress pane: ${progress.completed}/${progress.total} completed · running=${progress.running} queued=${progress.queued} failed=${progress.failed}`,
		...planBanner,
		...dwfPhaseLines,
		...phaseHeader,
		...cancellationLine,
		...groupJoinLines,
		...snapshot.recentEvents.slice(-10).map((event) => {
			const seq = event.metadata?.seq !== undefined ? `#${event.metadata.seq}` : "#?";
			return `${seq} ${event.time} ${event.type}${event.taskId ? ` ${event.taskId}` : ""}${event.message ? ` · ${event.message}` : ""}`;
		}),
		...(snapshot.recentEvents.length ? [] : ["No recent events"]),
	];
}
