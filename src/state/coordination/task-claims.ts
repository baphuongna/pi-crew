import { randomUUID, timingSafeEqual } from "node:crypto";
import type { TeamTaskState } from "../types.ts";

export interface TaskClaimState {
	owner: string;
	token: string;
	leasedUntil: string;
}

export function createTaskClaim(owner: string, leaseMs = 5 * 60_000, now = new Date()): TaskClaimState {
	return {
		owner,
		token: randomUUID(),
		leasedUntil: new Date(now.getTime() + leaseMs).toISOString(),
	};
}

export function isTaskClaimExpired(claim: TaskClaimState | undefined, now = new Date()): boolean {
	if (!claim) return false;
	const parsed = Date.parse(claim.leasedUntil);
	// Corrupt or invalid date strings produce NaN — treat as expired immediately.
	return Number.isFinite(parsed) ? parsed <= now.getTime() : true;
}

export function timingSafeTokenMatch(a: string, b: string): boolean {
	const bufA = Buffer.from(String(a));
	const bufB = Buffer.from(String(b));
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

export function canUseTaskClaim(task: Pick<TeamTaskState, "claim">, owner: string, token: string, now = new Date()): boolean {
	return task.claim?.owner === owner && timingSafeTokenMatch(task.claim.token, token) && !isTaskClaimExpired(task.claim, now);
}

export function claimTask<T extends TeamTaskState>(task: T, owner: string, leaseMs?: number, now = new Date()): T {
	if (task.claim && !isTaskClaimExpired(task.claim, now)) {
		throw new Error(`Task '${task.id}' is already claimed by '${task.claim.owner}'.`);
	}
	return { ...task, claim: createTaskClaim(owner, leaseMs, now) };
}

export function releaseTaskClaim<T extends TeamTaskState>(task: T, owner: string, token: string, now = new Date()): T {
	if (!canUseTaskClaim(task, owner, token, now)) {
		throw new Error(`Task '${task.id}' claim is not held by '${owner}' or has expired.`);
	}
	return { ...task, claim: undefined };
}

export function transitionClaimedTaskStatus<T extends TeamTaskState>(
	task: T,
	owner: string,
	token: string,
	status: T["status"],
	now = new Date(),
): T {
	if (!canUseTaskClaim(task, owner, token, now)) {
		throw new Error(`Task '${task.id}' claim is not held by '${owner}' or has expired.`);
	}
	return { ...task, status };
}
