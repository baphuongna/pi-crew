import * as fs from "node:fs";
import * as path from "node:path";
import { getCrewEnv } from "../config/env-vars.ts";
import { atomicWriteFile } from "../state/atomic-write.ts";
import { appendEvent, appendEventBuffered } from "../state/event-log/event-log.ts";
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
				// WI-7.3 (M7 spec §5): kept sync. Making this async would force
				// requestForegroundControl() + its caller chain async (10+
				// callers in message-tool/lifecycle paths). 10ms spin per
				// iteration is bounded by the 5s timeout above (max ~500 iters
				// = 5s total worst-case block, matching the lock-timeout).
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
		// Read-your-writes (CI 2026-09-11, phase6 integration): for a fresh
		// manifest this may be the FIRST event — buffered append leaves
		// events.jsonl nonexistent at the sync read right after (ENOENT).
		// Sync appendEvent (base behavior, b6eba80f pattern).
		try {
			appendEvent(manifest.eventsPath, {
				type: "foreground.interrupt_requested",
				runId: manifest.runId,
				message: reason,
				data: { requestId: request.id, controlPath },
			});
		} catch (e) {
			logInternalError("foreground_control.append", e, "type=foreground.interrupt_requested");
		}
		return request;
	} finally {
		releaseLock();
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// FIX-1 (live catch, run team_20261030044630_3935473bc4886682): the
// foreground-control interrupt CONSUMER. The guard used to live ONLY inside
// background-runner's detached main(); runs executed INLINE in the owner
// session process (executeBackgroundRun core — also the PI_CREW_TEST_ASYNC_INLINE
// seam) never polled foreground-control.json, so cross-session cancels sat
// acknowledged:false forever (two requests in that run) while the worker ran
// ≥75s post-cancel with fresh heartbeats. Colocated with the PRODUCER
// (writeForegroundInterruptRequest above) so the control-file contract has
// one home.
//
// Polling/ack semantics carried over byte-identically from the previous
// inline guard in background-runner.ts: existsSync+readFileSync+JSON.Parse
// per tick, interval PI_CREW_INTERRUPT_GUARD_INTERVAL_MS (default 1000ms),
// synchronous atomic ack write, once-per-request gate (defense-in-depth when
// the ack write fails), appendEventBuffered("async.interrupt_detected"),
// interval.unref().
//
// What an interrupt DOES is host-scoped via onInterrupt:
//  - detached runner (background-runner.startInterruptGuard): process-wide
//    sweep — terminateActiveChildPiProcesses + stopParentGuard + exitCode 130.
//  - inline core (executeBackgroundRun with no host signal): abort ONLY this
//    run's controller. NEVER sweep: the owner session process may host
//    sibling runs whose child-pi processes would be murdered by a global
//    terminateActiveChildPiProcesses() call.
// ═══════════════════════════════════════════════════════════════════════════

export interface RunInterruptGuardOptions {
	manifest: { runId: string; stateRoot: string; eventsPath: string };
	/**
	 * Host-scoped interrupt action. Runs ONCE per unacknowledged request,
	 * after the synchronous ack write. Keep it synchronous: this is a
	 * setInterval polling callback — it cannot await.
	 */
	onInterrupt: () => void;
	/** Message for the async.interrupt_detected event (hosts describe their own follow-up). */
	eventMessage?: string;
}

export function startRunInterruptGuard(opts: RunInterruptGuardOptions): () => void {
	const controlPath = path.join(opts.manifest.stateRoot, "foreground-control.json");
	// PERF (2026-08-24, carried over verbatim): default 1000ms. Each tick does
	// existsSync + readFileSync + JSON.parse for the whole run, and the guard
	// is best-effort interrupt LATENCY, not a correctness deadline — a late
	// trigger merely delays the SIGTERM (children are SIGKILLed after
	// HARD_KILL_MS=3s regardless) and no state machine aborts on a deadline
	// when the guard fires late. Nothing downstream requires a tighter cadence.
	const interruptGuardInterval = Number(getCrewEnv("PI_CREW_INTERRUPT_GUARD_INTERVAL_MS")) || 1000;
	// RT-4 FIX (carried over verbatim): local gate so the interrupt body runs
	// only once per request. The ack write stops the re-fire; this gate is
	// defense-in-depth if the ack write fails (e.g. transient fs error).
	let interruptHandled = false;
	const interval = setInterval(() => {
		try {
			if (!fs.existsSync(controlPath)) return;
			const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as {
				requests?: Array<{ type: string; acknowledged?: boolean }>;
			};
			const last = parsed.requests?.at(-1);
			if (last?.type === "interrupt" && last?.acknowledged !== true) {
				if (interruptHandled) return;
				interruptHandled = true;
				// RT-4 FIX: write acknowledged:true back SYNCHRONOUSLY so the next
				// tick does not re-fire. Sync because a polling callback cannot await.
				try {
					const reqs = parsed.requests ?? [];
					if (reqs.length > 0) {
						reqs[reqs.length - 1].acknowledged = true;
						atomicWriteFile(controlPath, JSON.stringify(parsed, null, 2));
					}
				} catch {
					/* best-effort ack — interruptHandled gate prevents re-fire */
				}
				appendEventBuffered(opts.manifest.eventsPath, {
					type: "async.interrupt_detected",
					runId: opts.manifest.runId,
					message: opts.eventMessage ?? "Background runner detected foreground interrupt — killing child processes and exiting.",
				}).catch((e) => logInternalError("interrupt-guard.buffered", e, "type=async.interrupt_detected"));
				opts.onInterrupt();
				// Cosmetic (verifier-flagged, live catch follow-up): an ALREADY-ACKED
				// interrupt must not fall through to this branch — it used to warn
				// "Ignoring unknown ... interrupt" every tick until guard stop.
			} else if (last && !(last.type === "interrupt" && last.acknowledged === true)) {
				console.warn(`[background-runner] Ignoring unknown foreground control request: ${last.type}`);
			}
		} catch {
			/* ignore read/parse errors */
		}
	}, interruptGuardInterval);
	interval.unref();
	return () => clearInterval(interval);
}
