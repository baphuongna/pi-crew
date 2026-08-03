export interface WorkerHeartbeatState {
	workerId: string;
	pid?: number;
	lastSeenAt: string;
	lastStdoutAt?: string;
	lastEventAt?: string;
	turnCount?: number;
	alive?: boolean;
}

export function createWorkerHeartbeat(workerId: string, pid?: number, now = new Date()): WorkerHeartbeatState {
	return { workerId, pid, lastSeenAt: now.toISOString(), alive: true };
}

export function touchWorkerHeartbeat(
	heartbeat: WorkerHeartbeatState,
	updates: Partial<Omit<WorkerHeartbeatState, "workerId">> = {},
	now = new Date(),
): WorkerHeartbeatState {
	return { ...heartbeat, ...updates, lastSeenAt: now.toISOString() };
}

export function isWorkerHeartbeatStale(heartbeat: WorkerHeartbeatState, staleMs: number, now = new Date()): boolean {
	return now.getTime() - Date.parse(heartbeat.lastSeenAt) > staleMs;
}
