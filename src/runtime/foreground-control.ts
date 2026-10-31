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

/**
 * On-disk control-file shape, parsed leniently: hand-written control files
 * (tests, older writers) may omit `id`, so readers treat it as optional.
 */
type ForegroundControlFile = {
	requests?: Array<{ id?: string; type: string; acknowledged?: boolean }>;
};

const FOREGROUND_CONTROL_LOCK_TIMEOUT_MS = 5000;
const FOREGROUND_CONTROL_LOCK_STALE_MS = 10000;

function isLockContention(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EEXIST";
}

// F1 (2026-10-31 verified review): the previous producer lock used
// `fs.mkdirSync(lockDir, { recursive: true })`, which NEVER throws EEXIST —
// it provided ZERO mutual exclusion and its contention branches were
// unreachable dead code. This is the proven event-log dir-lock protocol
// (withEventLogAppendLockSync, src/state/event-log/event-log.ts): the
// non-recursive mkdir IS the mutex; timeout + mtime-stale reclaim +
// dead-pid awareness + PID-guarded release. Deliberately module-local
// (not extracted next to the event-log lock): that file is owned by a
// parallel fix wave — dedup into a shared helper is a noted follow-up.
// Divergence from the event-log pattern (per spec): contention retries ONLY
// on EEXIST — any other IO error fails fast instead of spinning to timeout.
function withForegroundControlLock<T>(controlPath: string, fn: () => T): T {
	const lockDir = `${controlPath}.lock`;
	const pidFile = path.join(lockDir, "pid");
	// Ensure the parent directory exists before attempting the lock (mirrors event-log).
	fs.mkdirSync(path.dirname(controlPath), { recursive: true });
	const start = Date.now();
	let acquired = false;
	while (true) {
		try {
			fs.mkdirSync(lockDir);
			acquired = true;
			try {
				// Disposable pid file ("wx" open + plain write): the lock dir itself
				// is the mutex; the pid file only feeds stale/dead detection and the
				// guarded release below.
				const pidFd = fs.openSync(pidFile, "wx");
				try {
					fs.writeSync(pidFd, String(process.pid));
				} finally {
					fs.closeSync(pidFd);
				}
			} catch {
				/* best-effort — e.g. EEXIST under a re-taken dir; a missing pid is mtime-detected */
			}
			break;
		} catch (err) {
			// Contend ONLY on EEXIST; any other IO error (ENOTDIR, EACCES, EROFS…)
			// fails fast with a clear error instead of spinning to the timeout.
			if (!isLockContention(err)) {
				const cause = err instanceof Error ? err : new Error(String(err));
				const wrapped = new Error(`Foreground control lock acquire failed for ${controlPath}: ${cause.message}`, {
					cause,
				});
				logInternalError("foreground-control.lock-acquire-failed", wrapped, `controlPath=${controlPath}`);
				throw wrapped;
			}
			if (Date.now() - start > FOREGROUND_CONTROL_LOCK_TIMEOUT_MS) {
				const timeoutErr = new Error(`Foreground control lock timeout for ${controlPath}`);
				logInternalError("foreground-control.lock-timeout", timeoutErr, `controlPath=${controlPath}`);
				throw timeoutErr;
			}
			// Mtime-stale reclaim FIRST, independent of the pid file: a holder
			// that crashed between mkdir and the pid write has no pid file —
			// only an aged mtime can reclaim its dir.
			try {
				const dirStat = fs.statSync(lockDir);
				if (Date.now() - dirStat.mtimeMs > FOREGROUND_CONTROL_LOCK_STALE_MS) {
					fs.rmSync(lockDir, { recursive: true, force: true });
					continue;
				}
			} catch {
				/* dir vanished — let the loop retry */
			}
			// Dead-pid secondary fast-path: a provably dead owner only means keep
			// waiting — NEVER steal a fresh lock on a pid-lookup race; the
			// aged-mtime branch above is the only reclaim.
			try {
				const raw = fs.readFileSync(pidFile, "utf-8").trim();
				const ownerPid = Number.parseInt(raw, 10);
				if (!Number.isNaN(ownerPid) && ownerPid !== process.pid) {
					try {
						process.kill(ownerPid, 0);
					} catch {
						/* dead — but mtime not stale yet, keep waiting */
					}
				}
			} catch {
				/* no pid file — the mtime check above already handles it */
			}
			// Brief sleep to avoid CPU spinning.
			// WI-7.3 (M7 spec §5): kept sync. Making this async would force
			// requestForegroundControl() + its caller chain async (10+
			// callers in message-tool/lifecycle paths). 10ms spin per
			// iteration is bounded by the 5s timeout above (max ~500 iters
			// = 5s total worst-case block, matching the lock-timeout).
			sleepSync(10);
		}
	}
	try {
		return fn();
	} finally {
		if (acquired) {
			// PID-guarded release: only remove the dir if the pid file still
			// records OUR pid — if fn outlived staleMs and a stealer re-took the
			// dir, the stealer owns it now.
			try {
				const currentPid = fs.readFileSync(pidFile, "utf-8").trim();
				if (currentPid === String(process.pid)) {
					fs.rmSync(lockDir, { recursive: true, force: true });
				}
			} catch {
				/* lock stolen or already gone — do not touch */
			}
		}
	}
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
	// F2: this module-level lock is SHARED with the interrupt-guard consumer —
	// the producer append and the consumer ack serialize on the same lock dir
	// (`${controlPath}.lock`), closing the unlocked whole-file RMW race.
	return withForegroundControlLock(controlPath, (): ForegroundControlRequest => {
		let requests: ForegroundControlRequest[] = [];
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
	});
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
// Polling/ack semantics carried over from the previous inline guard in
// background-runner.ts: existsSync+readFileSync+JSON.Parse per tick, interval
// PI_CREW_INTERRUPT_GUARD_INTERVAL_MS (default 1000ms), synchronous atomic ack
// write (now under the producer's dir-lock — F2), once-per-request gate
// (defense-in-depth when the ack write fails),
// appendEventBuffered("async.interrupt_detected"), interval.unref().
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
			const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as ForegroundControlFile;
			const last = parsed.requests?.at(-1);
			if (last?.type === "interrupt" && last?.acknowledged !== true) {
				if (interruptHandled) return;
				interruptHandled = true;
				// RT-4 FIX: write acknowledged:true back SYNCHRONOUSLY so the next
				// tick does not re-fire. Sync because a polling callback cannot await.
				// F2 FIX: the ack is a whole-file read→mutate→write and now runs
				// under the SAME module-level lock as the producer
				// (withForegroundControlLock) with a FRESH read inside the critical
				// section. The old path wrote back the stale tick snapshot
				// unlocked — a producer append racing the tick was clobbered
				// (lost interrupt request).
				try {
					withForegroundControlLock(controlPath, () => {
						if (!fs.existsSync(controlPath)) return;
						let fresh: ForegroundControlFile;
						try {
							fresh = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as ForegroundControlFile;
						} catch {
							return;
						}
						const reqs = fresh.requests;
						if (!Array.isArray(reqs) || reqs.length === 0) return;
						// Ack the exact request that fired (by id when present);
						// fall back to the tail entry so id-less legacy files
						// keep acking like before.
						let target = last.id !== undefined ? reqs.find((r) => r.id === last.id) : undefined;
						if (target === undefined) {
							const tail = reqs[reqs.length - 1];
							if (tail?.type === "interrupt" && tail.acknowledged !== true) target = tail;
						}
						if (target === undefined || target.type !== "interrupt" || target.acknowledged === true) return;
						target.acknowledged = true;
						atomicWriteFile(controlPath, JSON.stringify(fresh, null, 2));
					});
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
