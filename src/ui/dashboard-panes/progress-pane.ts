import { computePhaseProgress, formatPhaseProgressLine } from "../../runtime/phase-progress.ts";
import { isPlanApprovalPending } from "../../runtime/plan-approval.ts";
import { renderDwfPhaseLines } from "../dwf-phase-display.ts";
import type { RunUiSnapshot } from "../snapshot-types.ts";
import { PLAN_APPROVAL_HINT } from "./plan-pane.ts";

export function renderProgressPane(snapshot: RunUiSnapshot | undefined): string[] {
	if (!snapshot) return ["Progress pane: snapshot unavailable"];
	const progress = snapshot.progress;
	const groupJoins = snapshot.groupJoins ?? [];
	// L7 judgment: the header and group-join lines speak the count-first tally
	// dialect (`1 running · 0 queued`, `req-123 · acknowledged`), not the
	// `running=1`/`ack=acknowledged` wire format. The ONE deliberate
	// key=value survivor is `reason=` below: the cancellation reason is a
	// machine code (`leader_interrupted`) — diagnostic data, not prose, and
	// the shape (not the wording) is what the operator greps for.
	const groupJoinLines = groupJoins.length
		? groupJoins.map((item) => `group join ${item.partial ? "partial" : "completed"}: ${item.requestId} · ${item.ack}`)
		: ["group joins: none"];
	const cancellationLine = snapshot.cancellationReason ? [`cancelled: reason=${snapshot.cancellationReason}`] : [];
	const runProgress = computePhaseProgress(snapshot.tasks);
	const phaseLines =
		runProgress.phases.length > 0
			? runProgress.phases.map((p) => {
					const done = p.completed + p.failed;
					const status = p.running > 0 ? "running" : p.queued > 0 ? "queued" : done >= p.total ? "done" : "waiting";
					return `  Phase ${p.index + 1} ${p.phase ?? "?"}: ${p.percentage}% (${done}/${p.total}) [${status}]`;
				})
			: [];
	const phaseHeader = phaseLines.length > 0 ? [formatPhaseProgressLine(runProgress), ...phaseLines] : [];
	// DWF logical phases (round-15 P1-4): derived from dwf.phase_* events.
	// Null/absent for non-DWF runs → zero visible change.
	const dwfPhaseLines = snapshot.dwfPhaseState ? renderDwfPhaseLines(snapshot.dwfPhaseState) : [];
	// WP-3 (H4-subset): plan-approval gate banner. Mirrors the health-pane
	// hint pattern — plain foreground text, no color codes (pane output is
	// uncolored by design). One line while the run is parked on approval.
	const planBanner = isPlanApprovalPending(snapshot.manifest) ? [`⚠ plan approval pending — ${PLAN_APPROVAL_HINT}`] : [];
	return [
		`Progress pane: ${progress.completed}/${progress.total} completed · ${progress.running} running · ${progress.queued} queued · ${progress.failed} failed`,
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
