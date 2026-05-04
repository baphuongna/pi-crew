import { logInternalError } from "../utils/internal-error.ts";

export type OverflowPhase = "none" | "compaction" | "retrying" | "recovered" | "failed";

export interface OverflowRecoveryState {
	taskId: string;
	runId: string;
	phase: OverflowPhase;
	startedAt: number;
	lastEventAt: number;
	compactionCount: number;
	retryCount: number;
}

export interface OverflowRecoveryCallbacks {
	onPhaseChange?: (state: OverflowRecoveryState, previousPhase: OverflowPhase) => void;
	onTimeout?: (state: OverflowRecoveryState) => void;
}

const PHASE_TIMEOUT_MS = 120_000; // 120 seconds per phase

export class OverflowRecoveryTracker {
	private states = new Map<string, OverflowRecoveryState>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private callbacks: OverflowRecoveryCallbacks;

	constructor(callbacks: OverflowRecoveryCallbacks = {}) {
		this.callbacks = callbacks;
	}

	feedEvent(taskId: string, runId: string, eventType: string): OverflowPhase {
		const existing = this.states.get(taskId);
		const now = Date.now();

		if (existing && existing.phase === "recovered") return "recovered";
		if (existing && existing.phase === "failed") return "failed";

		let phase: OverflowPhase = existing?.phase ?? "none";
		let compactionCount = existing?.compactionCount ?? 0;
		let retryCount = existing?.retryCount ?? 0;
		const previousPhase = phase;

		switch (eventType) {
			case "compaction_start":
				phase = "compaction";
				compactionCount++;
				break;
			case "compaction_end":
				// After compaction, we expect a retry; stay in compaction until retry starts
				break;
			case "auto_retry_start":
				phase = "retrying";
				retryCount++;
				break;
			case "auto_retry_end":
				// After retry completes, the agent should produce a response
				// We consider this recovered but don't finalize until agent_end
				phase = "recovered";
				break;
			case "agent_end":
				// If we were recovering and agent ends, we're recovered or failed
				if (phase === "compaction" || phase === "retrying") {
					phase = "failed";
				}
				break;
			default:
				// Unknown event type — no phase change
				break;
		}

		const state: OverflowRecoveryState = {
			taskId,
			runId,
			phase,
			startedAt: existing?.startedAt ?? now,
			lastEventAt: now,
			compactionCount,
			retryCount,
		};

		this.states.set(taskId, state);
		this.resetTimeout(taskId);

		if (previousPhase !== phase && this.callbacks.onPhaseChange) {
			try {
				this.callbacks.onPhaseChange(state, previousPhase);
			} catch (error) {
				logInternalError("overflow-recovery.onPhaseChange", error, `taskId=${taskId}`);
			}
		}

		return phase;
	}

	getState(taskId: string): OverflowRecoveryState | undefined {
		return this.states.get(taskId);
	}

	getPhase(taskId: string): OverflowPhase {
		return this.states.get(taskId)?.phase ?? "none";
	}

	removeTask(taskId: string): void {
		this.states.delete(taskId);
		const timer = this.timers.get(taskId);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(taskId);
		}
	}

	dispose(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.states.clear();
	}

	private resetTimeout(taskId: string): void {
		const existing = this.timers.get(taskId);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(() => {
			this.timers.delete(taskId);
			const state = this.states.get(taskId);
			if (!state) return;
			if (state.phase === "recovered" || state.phase === "failed" || state.phase === "none") return;

			const previousPhase = state.phase;
			state.phase = "failed";
			state.lastEventAt = Date.now();

			if (this.callbacks.onTimeout) {
				try {
					this.callbacks.onTimeout(state);
				} catch (error) {
					logInternalError("overflow-recovery.onTimeout", error, `taskId=${taskId}`);
				}
			}
			if (this.callbacks.onPhaseChange) {
				try {
					this.callbacks.onPhaseChange(state, previousPhase);
				} catch (error) {
					logInternalError("overflow-recovery.onPhaseChange-timeout", error, `taskId=${taskId}`);
				}
			}
		}, PHASE_TIMEOUT_MS);

		timer.unref();
		this.timers.set(taskId, timer);
	}
}