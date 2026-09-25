/**
 * health-notify-policy.ts — FINDING 6 (2026-09-23 battery): ambient
 * notification re-delivery storms.
 *
 * Observed live: a zombie-run leak made the health monitor re-fire the same
 * `recovery_missing_heartbeat` notification every cooldown window (5 min) for
 * hours. Each fire queued a follow-up message on the host session while the
 * parent was busy; the host drains follow-ups ONE PER TURN BOUNDARY
 * (followUpMode "one-at-a-time"), so the queued duplicates kept dripping into
 * the parent conversation for ~5 hours AFTER the runs were deleted and the
 * monitor had written its `clear` entries.
 *
 * Policy fixes (both sides of the storm):
 *  1. BOUNDED RE-FIRE — a given notification key may fire at most
 *     MAX_HEALTH_NOTIFY_FIRES times unless the underlying fingerprint changes
 *     (a different dead/missing/task-count shape is a NEW situation and gets a
 *     fresh budget). Previously the 5-min cooldown re-armed forever.
 *  2. RESET-ON-CLEAR — the clear path resets the fire budget, so a genuine
 *     recurrence after a resolved incident notifies again (up to the cap).
 *
 * The host-queue purge of already-queued copies is handled separately
 * (purgeQueuedAmbientNotifications in subagent-helpers.ts) — this module only
 * stops pi-crew from FEEDING the queue.
 */

/** Maximum notifications emitted per key before a fingerprint change. */
export const MAX_HEALTH_NOTIFY_FIRES = 3;

export interface AutoRecoveryEntry {
	insertedAt: number;
	lastAccessAt: number;
	/** Times this key has fired under the current fingerprint. */
	fires?: number;
	/** Shape of the situation last notified (see healthNotifyFingerprint). */
	fingerprint?: string;
}

export interface HealthNotifyState {
	/** Map keyed `${kind}_${runId}` — typically ctx.autoRecoveryLast. */
	entries: Map<string, AutoRecoveryEntry>;
	/** LRU cap — typically ctx.AUTO_RECOVERY_LAST_MAX_ENTRIES. */
	maxEntries: number;
}

/** Compact fingerprint of the health situation: same counts = same situation. */
export function healthNotifyFingerprint(summary: { dead: number; missing: number }, totalTasks: number): string {
	return `${summary.dead}/${summary.missing}/${totalTasks}`;
}

/**
 * Decide whether a health notification may fire now, and record the decision.
 *
 * Fires when: (a) never fired before, (b) cooldown elapsed AND the same
 * fingerprint still has budget, or (c) the fingerprint CHANGED (new situation
 * — fresh budget). Blocks within the cooldown window and after the budget is
 * exhausted. Evicts oldest-access entries at the cap (LRU, mirrors the
 * previous inline behavior).
 */
export function recordHealthNotifyDecision(
	state: HealthNotifyState,
	key: string,
	fingerprint: string,
	now: number,
	cooldownMs = 5 * 60_000,
	maxFires = MAX_HEALTH_NOTIFY_FIRES,
): boolean {
	const previous = state.entries.get(key);
	if (previous !== undefined && now - previous.lastAccessAt < cooldownMs) return false;
	if (previous !== undefined && previous.fires !== undefined && previous.fires >= maxFires && previous.fingerprint === fingerprint) {
		// Budget exhausted for an unchanged situation. Still refresh access so
		// LRU ordering reflects interest in this key.
		previous.lastAccessAt = now;
		return false;
	}
	while (state.entries.size >= state.maxEntries) {
		let oldestKey: string | undefined;
		let oldestAccess = Infinity;
		for (const [k, v] of state.entries) {
			if (v.lastAccessAt < oldestAccess) {
				oldestAccess = v.lastAccessAt;
				oldestKey = k;
			}
		}
		if (oldestKey === undefined) break;
		state.entries.delete(oldestKey);
	}
	const fires = previous?.fingerprint === fingerprint ? (previous.fires ?? 0) + 1 : 1;
	state.entries.set(key, {
		insertedAt: previous?.insertedAt ?? now,
		lastAccessAt: now,
		fires,
		fingerprint,
	});
	return true;
}

/** Reset a key's fire budget (clear path: resolved incident gets fresh budget). */
export function resetHealthNotifyEntry(state: HealthNotifyState, key: string): void {
	state.entries.delete(key);
}
