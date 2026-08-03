/**
 * DWF phase display — pure functions for extracting DWF phase state from the
 * run's recent event window and rendering phase markers (▶/✓/⏸) in the
 * progress pane.
 *
 * round-15 (P1-4). These functions are side-effect free and perform no I/O;
 * they derive phase state entirely from the `recentEvents` slice already
 * tailed by `run-snapshot-cache.ts`. Non-DWF runs (no `dwf.phase_*` events)
 * yield `null`, so the progress pane stays unchanged for them.
 */
import type { TeamEvent } from "../state/event-log/event-log.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DwfPhaseStatus = "running" | "completed" | "pending";

export interface DwfPhaseEntry {
	/** Phase title as passed to `ctx.phase(title)`. */
	name: string;
	/** Derived lifecycle status for display. */
	status: DwfPhaseStatus;
}

export interface DwfPhaseState {
	/** Ordered list of phases seen in the event window (first-seen order). */
	phases: DwfPhaseEntry[];
	/** Name of the currently running phase, or null if all are completed. */
	currentPhase: string | null;
}

export interface RenderDwfPhaseOptions {
	/** When true, render ASCII fallback markers instead of Unicode glyphs. */
	ascii?: boolean;
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

// Unicode markers — consistent with the ▸/● glyphs already used in the dashboard.
const MARKER_RUNNING = "▶";
const MARKER_COMPLETED = "✓";
const MARKER_PENDING = "⏸";

// ASCII fallbacks for terminals that mis-render the Unicode glyphs above.
const MARKER_RUNNING_ASCII = "[>]";
const MARKER_COMPLETED_ASCII = "[v]";
const MARKER_PENDING_ASCII = "[ ]";

const DWF_PHASE_HEADER = "  ── DWF Phases ──";

function markerFor(status: DwfPhaseStatus, ascii: boolean): string {
	if (ascii) {
		if (status === "running") return MARKER_RUNNING_ASCII;
		if (status === "completed") return MARKER_COMPLETED_ASCII;
		return MARKER_PENDING_ASCII;
	}
	if (status === "running") return MARKER_RUNNING;
	if (status === "completed") return MARKER_COMPLETED;
	return MARKER_PENDING;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function phaseNameFrom(event: TeamEvent): string | undefined {
	const phase = event.data?.phase;
	return typeof phase === "string" && phase.length > 0 ? phase : undefined;
}

/**
 * Derive DWF phase state from a (chronological) event window.
 *
 * Returns `null` when the window contains no `dwf.phase_started` /
 * `dwf.phase_completed` events — i.e. a non-DWF run — so callers can short
 * circuit phase rendering entirely.
 *
 * Because the window is bounded, the oldest phase events may have scrolled
 * off. A phase whose `dwf.phase_started` scrolled off but whose
 * `dwf.phase_completed` is still visible is still tracked (as completed). A
 * phase that started but whose completion scrolled off and which is not the
 * current phase is shown as `pending` (indeterminate).
 */
export function extractDwfPhaseState(events: TeamEvent[]): DwfPhaseState | null {
	const order: string[] = [];
	const seen = new Set<string>();
	const completed = new Set<string>();
	let currentPhase: string | null = null;

	const remember = (phase: string): void => {
		if (!seen.has(phase)) {
			seen.add(phase);
			order.push(phase);
		}
	};

	for (const event of events) {
		if (event.type === "dwf.phase_started") {
			const phase = phaseNameFrom(event);
			if (phase === undefined) continue;
			remember(phase);
			// The most recent phase_started marks the running phase.
			currentPhase = phase;
		} else if (event.type === "dwf.phase_completed") {
			const phase = phaseNameFrom(event);
			if (phase === undefined) continue;
			remember(phase);
			completed.add(phase);
			// If the phase just closed was the running one, it is no longer running.
			if (phase === currentPhase) {
				currentPhase = null;
			}
		}
	}

	if (order.length === 0) return null;

	const phases: DwfPhaseEntry[] = order.map((name) => {
		if (name === currentPhase) return { name, status: "running" as const };
		if (completed.has(name)) return { name, status: "completed" as const };
		return { name, status: "pending" as const };
	});

	return { phases, currentPhase };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render phase marker lines for the progress pane.
 *
 * - One line per phase: `  ▶ Phase: Scan`, `  ✓ Phase: Scan`, `  ⏸ Phase: Review`.
 * - A grouping header is emitted only when more than one phase is present.
 * - When `options.ascii` is true, ASCII fallback markers are used.
 *
 * Always returns a non-empty array (the caller guarantees a non-null state).
 */
export function renderDwfPhaseLines(state: DwfPhaseState, options?: RenderDwfPhaseOptions): string[] {
	const ascii = options?.ascii === true;
	const lines: string[] = [];
	if (state.phases.length > 1) lines.push(DWF_PHASE_HEADER);
	for (const entry of state.phases) {
		lines.push(`  ${markerFor(entry.status, ascii)} Phase: ${entry.name}`);
	}
	return lines;
}
