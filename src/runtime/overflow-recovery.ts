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
const TERMINAL_STATE_TTL_MS = 5 * 60_000;

export class OverflowRecoveryTracker {
	private states = new Map<string, OverflowRecoveryState>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private callbacks: OverflowRecoveryCallbacks;

	constructor(callbacks: OverflowRecoveryCallbacks = {}) {
		this.callbacks = callbacks;
	}

	feedEvent(taskId: string, runId: string, eventType: string): OverflowPhase {
		const key = this.keyFor(taskId, runId);
		const existing = this.states.get(key);
		const now = Date.now();

		if (existing && existing.phase === "recovered") {
			existing.lastEventAt = now;
			return "recovered";
		}
		if (existing && existing.phase === "failed") {
			existing.lastEventAt = now;
			return "failed";
		}

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

		this.states.set(key, state);
		this.resetTimeout(key);

		if (previousPhase !== phase && this.callbacks.onPhaseChange) {
			try {
				this.callbacks.onPhaseChange(state, previousPhase);
			} catch (error) {
				logInternalError("overflow-recovery.onPhaseChange", error, `taskId=${taskId}`);
			}
		}

		return phase;
	}

	getState(taskId: string, runId?: string): OverflowRecoveryState | undefined {
		if (runId) return this.states.get(this.keyFor(taskId, runId));
		return [...this.states.values()].find((state) => state.taskId === taskId);
	}

	getPhase(taskId: string, runId?: string): OverflowPhase {
		return this.getState(taskId, runId)?.phase ?? "none";
	}

	removeTask(taskId: string, runId?: string): void {
		const keys = runId
			? [this.keyFor(taskId, runId)]
			: [...this.states.entries()].filter(([, state]) => state.taskId === taskId).map(([key]) => key);
		for (const key of keys) this.removeKey(key);
	}

	dispose(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.states.clear();
	}

	private keyFor(taskId: string, runId: string): string {
		return `${runId}\u0000${taskId}`;
	}

	private removeKey(key: string): void {
		this.states.delete(key);
		const timer = this.timers.get(key);
		if (timer) clearTimeout(timer);
		this.timers.delete(key);
	}

	private resetTimeout(key: string): void {
		const existing = this.timers.get(key);
		if (existing) clearTimeout(existing);
		const current = this.states.get(key);
		const timeoutMs = current?.phase === "recovered" || current?.phase === "failed" || current?.phase === "none"
			? TERMINAL_STATE_TTL_MS
			: PHASE_TIMEOUT_MS;

		const timer = setTimeout(() => {
			this.timers.delete(key);
			const state = this.states.get(key);
			if (!state) return;
			if (state.phase === "recovered" || state.phase === "failed" || state.phase === "none") {
				this.states.delete(key);
				return;
			}

			const previousPhase = state.phase;
			state.phase = "failed";
			state.lastEventAt = Date.now();

			if (this.callbacks.onTimeout) {
				try {
					this.callbacks.onTimeout(state);
				} catch (error) {
					logInternalError("overflow-recovery.onTimeout", error, `taskId=${state.taskId}`);
				}
			}
			if (this.callbacks.onPhaseChange) {
				try {
					this.callbacks.onPhaseChange(state, previousPhase);
				} catch (error) {
					logInternalError("overflow-recovery.onPhaseChange-timeout", error, `taskId=${state.taskId}`);
				}
			}
		}, timeoutMs);

		timer.unref();
		this.timers.set(key, timer);
	}
}