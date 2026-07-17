import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../state/atomic-write.ts";
import { appendEvent } from "../state/event-log.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { sleepSync } from "../utils/sleep.ts";
import { readCrewAgents } from "./crew-agent-records.ts";
import { checkProcessLiveness, isActiveRunStatus } from "./process-status.ts";

export type ForegroundControlRequestType = "interrupt" | "status";

export interface ForegroundControlStatus {
	runId: string;
	status: TeamRunManifest["status"];
	active: boolean;
	asyncPid?: number;
	asyncAlive?: boolean;
	runningTasks: string[];
	runningAgents: string[];
	controlPath: string;
	lastRequest?: ForegroundControlRequest;
}

export interface ForegroundControlRequest {
	id: string;
	type: ForegroundControlRequestType;
	createdAt: string;
	reason: string;
	acknowledged: boolean;
}

export function foregroundControlPath(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "foreground-control.json");
}

function readLastRequest(controlPath: string): ForegroundControlRequest | undefined {
	if (!fs.existsSync(controlPath)) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as {
			requests?: ForegroundControlRequest[];
		};
		return parsed.requests?.at(-1);
	} catch {
		return undefined;
	}
}

export function readForegroundControlStatus(manifest: TeamRunManifest, tasks: TeamTaskState[]): ForegroundControlStatus {
	const controlPath = foregroundControlPath(manifest);
	const asyncAlive = manifest.async?.pid !== undefined ? checkProcessLiveness(manifest.async.pid).alive : undefined;
	return {
		runId: manifest.runId,
		status: manifest.status,
		active: isActiveRunStatus(manifest.status),
		asyncPid: manifest.async?.pid,
		asyncAlive,
		runningTasks: tasks.filter((task) => task.status === "running").map((task) => task.id),
		runningAgents: readCrewAgents(manifest)
			.filter((agent) => agent.status === "running")
			.map((agent) => agent.id),
		controlPath,
		lastRequest: readLastRequest(controlPath),
	};
}

export function writeForegroundInterruptRequest(
	manifest: TeamRunManifest,
	reason = "User requested foreground interrupt.",
): ForegroundControlRequest {
	const controlPath = foregroundControlPath(manifest);
	const lockDir = `${controlPath}.lock`;
	const pidFile = path.join(lockDir, "pid");
	let requests: ForegroundControlRequest[] = [];

	// FIX: Use file locking to prevent race condition in read-modify-write
	// Added stale lock detection similar to event-log.ts
	const acquireLock = (): void => {
		const timeout = 5000;
		const staleMs = 10000;
		const start = Date.now();
		while (true) {
			try {
				fs.mkdirSync(lockDir, { recursive: true });
				try {
					atomicWriteFile(pidFile, String(process.pid));
				} catch {
					/* best-effort */
				}
				break;
			} catch {
				if (Date.now() - start > timeout) {
					// Check if lock is stale before giving up
					try {
						const raw = fs.readFileSync(pidFile, "utf-8").trim();
						const ownerPid = Number.parseInt(raw, 10);
						if (!Number.isNaN(ownerPid) && ownerPid !== process.pid) {
							let alive = false;
							try {
								process.kill(ownerPid, 0);
								alive = true;
							} catch {
								/* dead */
							}
							if (!alive) {
								// Lock is stale — clear it and retry
								fs.rmSync(lockDir, {
									recursive: true,
									force: true,
								});
								continue;
							}
							// Lock held by live process — throw
							const err = new Error(`Foreground control lock timeout for ${controlPath}`);
							logInternalError("foreground-control.lock-timeout", err, `controlPath=${controlPath}`);
							throw err;
						}
					} catch {
						/* no pid file — continue to throw */
					}
					const err = new Error(`Foreground control lock timeout for ${controlPath}`);
					logInternalError("foreground-control.lock-timeout", err, `controlPath=${controlPath}`);
					throw err;
				}
				// Stale detection: if the owning process is dead, remove the stale lock
				try {
					const raw = fs.readFileSync(pidFile, "utf-8").trim();
					const ownerPid = Number.parseInt(raw, 10);
					if (!Number.isNaN(ownerPid) && ownerPid !== process.pid) {
						let alive = false;
						try {
							process.kill(ownerPid, 0);
							alive = true;
						} catch {
							/* dead */
						}
						if (!alive) {
							const stat = fs.statSync(lockDir);
							if (Date.now() - stat.mtimeMs > staleMs) {
								fs.rmSync(lockDir, {
									recursive: true,
									force: true,
								});
								continue;
							}
						}
					}
				} catch {
					/* no pid file — fall through to sleep */
				}
				// Brief sleep to avoid CPU spinning
				sleepSync(10);
			}
		}
	};
	const releaseLock = (): void => {
		try {
			fs.rmSync(lockDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	};

	acquireLock();
	try {
		if (fs.existsSync(controlPath)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as { requests?: ForegroundControlRequest[] };
				requests = Array.isArray(parsed.requests) ? parsed.requests : [];
			} catch {
				requests = [];
			}
		}
		const request: ForegroundControlRequest = {
			id: `fg_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
			type: "interrupt",
			createdAt: new Date().toISOString(),
			reason,
			acknowledged: false,
		};
		fs.mkdirSync(path.dirname(controlPath), { recursive: true });
		atomicWriteFile(controlPath, `${JSON.stringify({ requests: [...requests, request] }, null, 2)}\n`);
		appendEvent(manifest.eventsPath, {
			type: "foreground.interrupt_requested",
			runId: manifest.runId,
			message: reason,
			data: { requestId: request.id, controlPath },
		});
		return request;
	} finally {
		releaseLock();
	}
}
