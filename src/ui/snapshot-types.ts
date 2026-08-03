import type { CrewAgentRecord } from "../runtime/crew-agent-runtime.ts";
import type { TeamEvent } from "../state/event-log/event-log.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import type { DwfPhaseState } from "./dwf-phase-display.ts";

export interface RunUiProgress {
	total: number;
	completed: number;
	running: number;
	failed: number;
	queued: number;
	waiting?: number;
	cancelled?: number;
	skipped?: number;
	needsAttention?: number;
}

export interface RunUiUsage {
	tokensIn: number;
	tokensOut: number;
	toolUses: number;
}

export interface RunUiMailbox {
	inboxUnread: number;
	outboxPending: number;
	needsAttention: number;
	/** Urgent steering messages count. Default 0. */
	steerUnread?: number;
	/** Follow-up / continuation messages count. Default 0. */
	followUpUnread?: number;
	/** Response / reply messages count. Default 0. */
	responseUnread?: number;
	/** Generic messages count. Default 0. */
	messageUnread?: number;
	/** True when counts come from bounded tail reads and older messages may be omitted. */
	approximate?: boolean;
}

export interface RunUiGroupJoin {
	requestId: string;
	messageId: string;
	partial: boolean;
	ack: "pending" | "acknowledged";
}

export interface RunUiSnapshot {
	runId: string;
	cwd: string;
	fetchedAt: number;
	signature: string;
	/**
	 * 1.6 / 1.7 — per-slice signatures so dashboard panes can short-circuit
	 * their own render when the slice they care about hasn't changed:
	 *
	 *     if (snapshot.sliceSignatures?.tasks === lastTaskSig) return cached;
	 *
	 * Optional for backwards-compat; consumers fall back to the full
	 * `signature` when the field is missing.
	 */
	sliceSignatures?: {
		tasks: string;
		agents: string;
		mailbox: string;
		progress: string;
		events: string;
	};
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	agents: CrewAgentRecord[];
	progress: RunUiProgress;
	usage: RunUiUsage;
	mailbox: RunUiMailbox;
	groupJoins?: RunUiGroupJoin[];
	/** Structured cancellation reason from run.cancelled event data, when available. */
	cancellationReason?: string;
	/** DWF phase state derived from `recentEvents`. Null/absent for non-DWF runs. */
	dwfPhaseState?: DwfPhaseState | null;
	recentEvents: TeamEvent[];
	recentOutputLines: string[];
}

export interface RunSnapshotCache {
	get(runId: string): RunUiSnapshot | undefined;
	refresh(runId: string): RunUiSnapshot;
	refreshIfStale(runId: string): RunUiSnapshot;
	invalidate(runId?: string): void;
	snapshotsByKey(): Map<string, RunUiSnapshot>;
	dispose?(): void;
}
