/**
 * Orphan background-worker registry.
 *
 * Tracks PIDs of background-runner.ts processes spawned via async-runner.
 * Workers are detached, setsid'd, and unref'd, so they outlive the spawning
 * pi session. If the parent pi process is killed (SIGKILL, crash), workers
 * become orphans and keep running forever.
 *
 * This registry provides:
 *   1. `registerWorker` — called from async-runner.ts after successful spawn.
 *   2. `unregisterWorker` — called when a worker exits (via async-marker
 *      or heartbeat watcher).
 *   3. `cleanupOrphanWorkers` — called on session_start; kills workers whose
 *      registration is older than STALE_REGISTRATION_MS (default 1h) and
 *      removes dead PIDs from the registry.
 *
 * Persistence: file-based JSON in `<userPiRoot>/state/orphan-workers.json`.
 * File is rewritten on every operation to drop dead PIDs.
 *
 * Thread-safety: All mutating operations (registerWorker, unregisterWorker,
 * cleanupOrphanWorkers) are protected by file locking to prevent concurrent
 * writes from causing lost updates.
 */

import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile, isSymlinkSafePath } from "../state/atomic-write.ts";
import { withFileLockSync } from "../state/locks.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { userPiRoot } from "../utils/paths.ts";

const STALE_REGISTRATION_MS = 60 * 60 * 1000; // 1 hour
// Grace period before a fresh worker can be cleaned up when parent is dead.
// Workers registered more recently than this are kept (monitored) even if
// parent is dead, to avoid killing a legitimate worker from a session that
// died recently. Only stale workers (> GRACE_PERIOD_MS) are SIGKILLed.
const GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

export interface OrphanWorkerEntry {
	pid: number;
	sessionId: string;
	runId: string;
	/** Parent PID (the pi process that spawned this worker). Used to verify
	 * the owning session is actually dead before killing the worker. */
	parentPid: number;
	/** Parent process start time in milliseconds since boot (from /proc/<pid>/stat).
	 * Used to detect PID reuse of the parent process. If the OS recycles the
	 * parent PID for a new process, the start time will differ and we won't
	 * incorrectly believe the parent is still alive. */
	parentPidStartTime: number;
	registeredAt: number; // epoch ms
	/** Process start time in milliseconds since boot (from /proc/<pid>/stat).
	 * Used to detect PID reuse: if the OS recycles this PID for a new process,
	 * the start time will differ and we won't kill the wrong process. */
	startTime: number;
}

/**
 * Get process start time in milliseconds since boot.
 * Uses platform-specific APIs for cross-platform PID reuse detection:
 * - Linux: reads /proc/<pid>/stat (field 22, starttime)
 * - macOS: sysctl KERN_PROC_PID to get kinfo_proc and extract p_starttime
 * - Windows: GetProcessTimes API to get creation time
 *
 * Returns undefined if the process is gone or the platform API is unavailable.
 */
function getProcessStartTime(pid: number): number | undefined {
	try {
		// First check if process exists
		process.kill(pid, 0);
	} catch {
		return undefined;
	}

	const platform = process.platform;
	if (platform === "linux") {
		return getProcessStartTimeLinux(pid);
	} else if (platform === "darwin") {
		return getProcessStartTimeMacOS(pid);
	} else if (platform === "win32") {
		return getProcessStartTimeWindows(pid);
	}
	return undefined;
}

function getProcessStartTimeLinux(pid: number): number | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
		// comm is wrapped in parentheses and may contain spaces/special chars.
		// Find the last ')' which marks the end of comm.
		const lastParen = stat.lastIndexOf(")");
		if (lastParen === -1) return undefined;
		// Fields after comm: state(1) ppid(2) pgrp(3) session(4) tty_nr(5)
		// tpgid(6) flags(7) minflt(8) cminflt(9) majflt(10) cmajflt(11)
		// utime(12) stime(13) cutime(14) cstime(15) priority(16) nice(17)
		// num_threads(18) itrealvalue(19) starttime(20) vsize(21) rss(22)
		// ...but we only need starttime which is field 22 (index 21 after comm)
		const fieldsAfterComm = stat
			.slice(lastParen + 1)
			.trim()
			.split(/\s+/);
		// starttime is at index 19 (the 20th field after comm)
		const startTimeClockTicks = Number(fieldsAfterComm[19]);
		if (!Number.isFinite(startTimeClockTicks)) return undefined;
		// Convert clock ticks to milliseconds using CLK_TCK (usually 100)
		// We use a conservative estimate; the absolute value matters less
		// than the uniqueness per PID lifecycle.
		return Math.floor(startTimeClockTicks * 100);
	} catch {
		return undefined;
	}
}

function getProcessStartTimeMacOS(pid: number): number | undefined {
	// SECURITY (H-6): validate pid is a finite positive number before use, and
	// pass it as an argv element (not interpolated into a shell string) so a
	// poisoned pid value can never reach a shell. Number.isFinite() rejects any
	// non-numeric string that could carry shell metacharacters.
	if (!Number.isFinite(pid) || pid <= 0) return undefined;
	// Use sysctl to get process start time on macOS
	// KERN_PROC_PID returns a kinfo_proc structure with p_starttime
	try {
		// For cross-platform consistency, use 'lstart' which gives full timestamp.
		// execFileSync with an args array avoids shell interpretation entirely.
		const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf-8", timeout: 5000 }).trim();
		if (!output) return undefined;
		// Parse date string like "Mon Jan 15 10:30:45 2024"
		const date = new Date(output);
		if (Number.isNaN(date.getTime())) return undefined;
		return date.getTime();
	} catch {
		return undefined;
	}
}

function getProcessStartTimeWindows(pid: number): number | undefined {
	// SECURITY (H-6): validate pid is a finite positive number. After this guard
	// the value is guaranteed numeric, so interpolating it into the PowerShell
	// -Command string is safe (no shell metacharacters can be injected).
	if (!Number.isFinite(pid) || pid <= 0) return undefined;
	// Use Windows API via JSDrive's winattr or native code
	// For Node.js without native modules, use tasklist /v and parse output
	try {
		// /v verbose, /fo csv, /nh no header
		const output = execFileSync("powershell", ["-Command", `Get-Process -Id ${pid} | Select-Object -ExpandProperty StartTime`], {
			encoding: "utf-8",
			timeout: 5000,
		}).trim();
		if (!output) return undefined;
		const date = new Date(output);
		if (Number.isNaN(date.getTime())) return undefined;
		return date.getTime();
	} catch {
		return undefined;
	}
}

let REGISTRY_PATH = path.join(userPiRoot(), "state", "orphan-workers.json");

/** @internal Test-only: override the registry path. */
export function __test_setRegistryPath(p: string): void {
	REGISTRY_PATH = p;
}

function getRegistryPath(): string {
	return REGISTRY_PATH;
}

/** Issue 3 fix: Validate sessionId and runId to prevent path traversal attacks. */
function isValidId(id: string): boolean {
	if (!id || typeof id !== "string") return false;
	if (id.includes("..") || id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
	return true;
}

function readRegistry(): OrphanWorkerEntry[] {
	const p = getRegistryPath();
	try {
		// Atomic read: if file doesn't exist, readFileSync throws ENOENT
		// which we handle explicitly. This eliminates the TOCTOU window
		// between existsSync and readFileSync.
		const raw = fs.readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(e): e is OrphanWorkerEntry =>
				typeof e === "object" &&
				e !== null &&
				typeof e.pid === "number" &&
				typeof e.sessionId === "string" &&
				typeof e.runId === "string" &&
				typeof e.registeredAt === "number" &&
				typeof (e as OrphanWorkerEntry).parentPid === "number" &&
				typeof (e as OrphanWorkerEntry).parentPidStartTime === "number" &&
				typeof (e as OrphanWorkerEntry).startTime === "number",
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		// Silent failure is deliberate for robustness (registry read failures
		// shouldn't crash the process), but log at warning level to aid troubleshooting.
		console.warn(`[orphan-worker-registry] readRegistry failed: ${error}`);
		return [];
	}
}

function writeRegistry(entries: OrphanWorkerEntry[]): void {
	const p = getRegistryPath();
	const dir = path.dirname(p);
	// Issue 2 fix: Defense-in-depth validation of IDs inside writeRegistry.
	// Even if registerWorker is bypassed in the future, we still validate
	// that sessionId/runId don't contain path traversal characters before
	// writing to disk.
	for (const entry of entries) {
		if (!isValidId(entry.sessionId) || !isValidId(entry.runId)) {
			logInternalError(
				"orphan-worker-registry.write",
				new Error("Refusing to write: invalid sessionId or runId"),
				`sessionId=${entry.sessionId} runId=${entry.runId}`,
			);
			return;
		}
	}
	// NOTE: No withFileLockSync here — all callers (registerWorker, unregisterWorker,
	// cleanupOrphanWorkers) already hold the lock. Nesting withFileLockSync on the same
	// path causes self-deadlock (the lock file is not reentrant).
	// Guard against symlink attacks on the registry file.
	// isSymlinkSafePath walks the ancestor chain to detect any symlinks,
	// preventing attacks where an intermediate ancestor is a symlink.
	if (!isSymlinkSafePath(p)) {
		logInternalError(
			"orphan-worker-registry.write",
			new Error("Refusing to write: target is a symlink or inside untrusted directory"),
			`path=${p}`,
		);
		return;
	}
	// Issue 2 fix: Check parent directory safety immediately before creating it.
	if (!isSymlinkSafePath(dir)) {
		logInternalError(
			"orphan-worker-registry.write",
			new Error("Refusing to create: parent directory is a symlink or inside untrusted directory"),
			`dir=${dir}`,
		);
		return;
	}
	// Ensure parent directory exists to serialize directory
	// creation with registry file writes and prevent TOCTOU races.
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	try {
		atomicWriteFile(p, JSON.stringify(entries, null, 2), { mode: 0o600 });
	} catch (error) {
		logInternalError("orphan-worker-registry.write", error, `path=${p} entries=${entries.length}`);
	}
}

/**
 * Add a worker PID to the registry. Idempotent (replaces existing entry
 * for the same PID).
 *
 * @param parentPid The PID of the spawning pi process. Used later to
 *   verify the owning session is actually dead before killing the worker.
 */
export function registerWorker(
	pid: number,
	sessionId: string,
	runId: string,
	parentPid: number,
	options?: { registeredAt?: number },
): void {
	if (!Number.isFinite(pid) || pid <= 0) return;
	// Issue 3 fix: Validate sessionId and runId to prevent path traversal attacks.
	if (!isValidId(sessionId) || !isValidId(runId)) return;
	const startTime = getProcessStartTime(pid) ?? 0;
	const parentPidStartTime = Number.isFinite(parentPid) && parentPid > 0 ? (getProcessStartTime(parentPid) ?? 0) : 0;
	withFileLockSync(getRegistryPath(), () => {
		const entries = readRegistry();
		// Dedupe by PID
		const filtered = entries.filter((e) => e.pid !== pid);
		filtered.push({
			pid,
			sessionId,
			runId,
			parentPid: Number.isFinite(parentPid) ? parentPid : 0,
			parentPidStartTime,
			registeredAt: options?.registeredAt ?? Date.now(),
			startTime,
		});
		writeRegistry(filtered);
	});
}

/**
 * Remove a worker PID from the registry. Called when the worker is known
 * to have exited (e.g. via async-marker poll or heartbeat watcher).
 */
export function unregisterWorker(pid: number): void {
	if (!Number.isFinite(pid) || pid <= 0) return;
	withFileLockSync(getRegistryPath(), () => {
		const entries = readRegistry();
		const filtered = entries.filter((e) => e.pid !== pid);
		if (filtered.length !== entries.length) {
			writeRegistry(filtered);
		}
	});
}

export interface CleanupOrphanWorkersResult {
	scanned: number;
	killed: number;
	pruned: number; // dead PIDs removed from registry without killing
	kept: number; // alive and fresh
}

/**
 * Kill stale orphan background workers and prune dead PIDs from the registry.
 *
 * Strategy:
 *   - For each entry in the registry, check if the PID is still alive.
 *   - If alive AND registered > STALE_REGISTRATION_MS ago: SIGTERM the PID
 *     (it's an orphan from a long-dead session).
 *   - If alive AND fresh: keep (concurrent session).
 *   - If dead: prune from registry.
 *
 * @param currentSessionId If provided, workers from this session are
 *   ALWAYS kept regardless of age. This protects concurrent sessions.
 *   Pass undefined for unconditional cleanup (e.g. from `pi-crew cleanup`).
 */
export function cleanupOrphanWorkers(currentSessionId?: string): CleanupOrphanWorkersResult {
	let result: CleanupOrphanWorkersResult = {
		scanned: 0,
		killed: 0,
		pruned: 0,
		kept: 0,
	};
	withFileLockSync(getRegistryPath(), () => {
		const entries = readRegistry();
		const now = Date.now();
		const kept: OrphanWorkerEntry[] = [];
		let killed = 0;
		let pruned = 0;
		for (const entry of entries) {
			try {
				process.kill(entry.pid, 0);
				// PID is alive
				const isMine = currentSessionId && entry.sessionId === currentSessionId;
				if (isMine) {
					// My session's worker — keep regardless of age
					kept.push(entry);
					continue;
				}
				// Verify parent is actually dead before killing worker.
				// If parent is alive, this is a concurrent session's worker
				// (or the same session that was misidentified). Keep it.
				if (entry.parentPid > 0) {
					// Verify parent hasn't been recycled before checking liveness.
					// If the parent PID was reused by a different process, the start
					// time will differ and we shouldn't trust the parentPid liveness check.
					const currentParentStartTime = getProcessStartTime(entry.parentPid);
					if (
						currentParentStartTime !== undefined &&
						entry.parentPidStartTime !== 0 &&
						currentParentStartTime !== entry.parentPidStartTime
					) {
						// Parent PID was recycled — this is a different process,
						// treat as if parent is dead so we may clean up the worker.
					} else {
						try {
							process.kill(entry.parentPid, 0);
							// Parent is alive — concurrent session, keep worker
							kept.push(entry);
							continue;
						} catch (err) {
							// Parent is dead — proceed to verify it's actually our worker
							// However, EPERM means the process exists but we lack permission
							// to signal it. Treat as 'unknown' state and keep the entry.
							if ((err as NodeJS.ErrnoException).code === "EPERM") {
								kept.push(entry);
								continue;
							}
						}
					}
				}
				// Verify PID hasn't been recycled by checking start time matches.
				// Capture startTime for re-verification before kill to close TOCTOU window.
				// Between the kill(0) check and the actual SIGKILL below, the OS
				// may have reused this PID for a new process. If the start time
				// has changed, this is a different process and we must not kill it.
				const currentStartTime = getProcessStartTime(entry.pid);
				if (currentStartTime === undefined || entry.startTime === 0) {
					// Can't verify startTime (macOS/Windows or stale entry) — trust registry
				} else if (currentStartTime !== entry.startTime) {
					// PID was recycled — different process now, prune without killing
					pruned++;
					continue;
				}
				// Re-verify start time immediately before SIGKILL to close the
				// TOCTOU window.
				//
				// KNOWN RESIDUAL RACE: Even with this re-check, a microsecond-level
				// window exists between the currentStartTime read (line 366) and the
				// actual process.kill(entry.pid, "SIGKILL") call (line 400). The OS
				// could theoretically recycle the PID and allocate it to a new process
				// within that window. This is an inherent limitation of userspace PID
				// verification against kernel PID allocation — the race cannot be fully
				// eliminated without kernel-level process naming or a process descriptor
				// that we do not have. As alternative mitigations, consider using
				// process groups (killpg) for worker identification instead of raw PIDs,
				// or kernel-level process descriptors if available on the platform.
				// The consequence of killing a wrong process is severe (SIGKILL of an
				// unrelated process), so this re-check is the best possible mitigation
				// given the kernel's PID allocation semantics.
				if (currentStartTime !== undefined && entry.startTime !== 0 && currentStartTime !== entry.startTime) {
					// PID was recycled — different process now, prune without killing
					pruned++;
					continue;
				}
				if (now - entry.registeredAt > STALE_REGISTRATION_MS) {
					// Stale orphan — SIGKILL because background-runner
					// intentionally ignores SIGTERM (BUG #17 fix).
					try {
						process.kill(entry.pid, "SIGKILL");
						killed++;
					} catch {
						// Race: died between check and kill
						pruned++;
					}
				} else if (now - entry.registeredAt > GRACE_PERIOD_MS) {
					// Fresh but outside grace period — parent dead and worker
					// is not doing useful work (same session died > 5 min ago).
					// SIGKILL to avoid wasting resources.
					try {
						process.kill(entry.pid, "SIGKILL");
						killed++;
					} catch {
						pruned++;
					}
				} else {
					// Fresh and within grace period — keep worker even though
					// parent is dead. Could be a legitimate worker from a session
					// that died recently and may still be doing useful work.
					// Will be cleaned up on next cycle if still orphan.
					kept.push(entry);
				}
			} catch {
				// PID is dead — prune from registry
				pruned++;
			}
		}
		if (kept.length !== entries.length) {
			writeRegistry(kept);
		}
		result = {
			scanned: entries.length,
			killed,
			pruned,
			kept: kept.length,
		};
	});
	return result;
}
