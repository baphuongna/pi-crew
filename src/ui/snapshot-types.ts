import type { CrewAgentRecord } from "../runtime/crew-agent-runtime.ts";
import type { TeamEvent } from "../state/event-log.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";

export interface RunUiProgress {
	total: number;
	completed: number;
	running: number;
	failed: number;
	queued: number;
	waiting?: number;
	cancelled?: number;
	skipped?: number;
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
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	agents: CrewAgentRecord[];
	progress: RunUiProgress;
	usage: RunUiUsage;
	mailbox: RunUiMailbox;
	groupJoins?: RunUiGroupJoin[];
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
