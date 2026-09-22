import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_PATHS } from "../config/defaults.ts";
import { getCrewEnv } from "../config/env-vars.ts";
import { createCancellationToken } from "../runtime/process/cancellation-token.ts";
import type { TeamRunManifest } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { projectCrewRoot, userCrewRoot } from "../utils/paths.ts";
import { redactSecrets } from "../utils/redaction.ts";
import { isSafePathId, resolveRealContainedPath } from "../utils/safe-paths.ts";
import { cleanupRunWorktrees } from "../worktree/cleanup.ts";
import { listRuns } from "./run-index.ts";

export interface PruneRunsResult {
	kept: string[];
	removed: string[];
	auditPath?: string;
}

export interface PruneRunsOptions {
	intent?: string;
	signal?: AbortSignal;
	/** When true, compute the removal list WITHOUT deleting any state/artifacts,
	 *  running worktree cleanup, or writing an audit. Non-destructive preview. */
	dryRun?: boolean;
	/** DP-01: never remove a finished run younger than this, even beyond
	 *  top-keep. Evidence/incident runs must survive a session restart (the
	 *  2026-09-21 battery lost a morning of evidence to the next session start).
	 *  0 disables the floor. Defaults to the PI_CREW_AUTO_PRUNE_AGE_FLOOR_HOURS
	 *  value (24h) for auto-prune callers; manual prune passes 0 explicitly. */
	ageFloorMs?: number;
}

/**
 * DP-01: resolve the auto-prune keep count from PI_CREW_AUTO_PRUNE_KEEP.
 * Invalid/negative/non-finite values fall back to 10 (the historical hard-coded
 * value) with a logged warning — never a crash and never an infinite keep.
 */
export function resolveAutoPruneKeep(env: (name: string) => string | undefined = getCrewEnv): number {
	const raw = env("PI_CREW_AUTO_PRUNE_KEEP")?.trim();
	if (raw === undefined || raw === "") return 10;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		logInternalError(
			"prune.auto-keep-invalid",
			new Error(`PI_CREW_AUTO_PRUNE_KEEP=${JSON.stringify(raw)} is not a non-negative integer; using 10`),
		);
		return 10;
	}
	return parsed;
}

/**
 * DP-01: resolve the auto-prune age floor (ms) from
 * PI_CREW_AUTO_PRUNE_AGE_FLOOR_HOURS (default 24h; 0 disables).
 */
export function resolveAutoPruneAgeFloorMs(env: (name: string) => string | undefined = getCrewEnv): number {
	const raw = env("PI_CREW_AUTO_PRUNE_AGE_FLOOR_HOURS")?.trim();
	if (raw === undefined || raw === "") return 24 * 60 * 60 * 1000;
	const hours = Number.parseFloat(raw);
	if (!Number.isFinite(hours) || hours < 0) {
		logInternalError(
			"prune.auto-age-floor-invalid",
			new Error(`PI_CREW_AUTO_PRUNE_AGE_FLOOR_HOURS=${JSON.stringify(raw)} is not a non-negative number; using 24`),
		);
		return 24 * 60 * 60 * 1000;
	}
	return hours * 60 * 60 * 1000;
}

/** DP-01: rotate prune.jsonl when it exceeds this size (one generation kept). */
export const PRUNE_AUDIT_MAX_BYTES = 512 * 1024;

/**
 * DP-01: size-based rotation for the prune audit log. Best-effort: a rotation
 * failure must never break the prune path (the audit is observability, not
 * correctness). One generation is enough — the audit is for recent forensics
 * (the 2026-09-21 storm RCA read exactly the current window).
 */
function rotatePruneAuditIfNeeded(filePath: string): void {
	try {
		if (!fs.existsSync(filePath)) return;
		if (fs.statSync(filePath).size < PRUNE_AUDIT_MAX_BYTES) return;
		fs.renameSync(filePath, `${filePath}.1`);
	} catch (error) {
		logInternalError("prune.audit-rotate", error, `path=${filePath}`);
	}
}

/**
 * DP-01: record a pruned FAILED/BLOCKED run's reason in a durable index that
 * survives run-dir pruning. Turn-run dirs are aggressively pruned (keep=10 at
 * session start); without this, a failure reason becomes unrecoverable (live
 * incident goal_20260921111305 — see docs/specs/DP-01.md). Best-effort.
 */
function appendPrunedFailureIndex(cwd: string, run: TeamRunManifest): void {
	try {
		const crewRoot = projectCrewRoot(cwd);
		if (!fs.existsSync(crewRoot)) return;
		const filePath = path.join(crewRoot, "state", "pruned-failures.jsonl");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const entry = {
			runId: run.runId,
			status: run.status,
			summary: (run.summary ?? "").split("\n")[0]?.slice(0, 500),
			goal: (run.goal ?? "").split("\n")[0]?.slice(0, 200),
			team: run.team,
			createdAt: run.createdAt,
			prunedAt: new Date().toISOString(),
		};
		fs.appendFileSync(filePath, `${JSON.stringify(redactSecrets(entry))}\n`, "utf-8");
	} catch (error) {
		logInternalError("prune.failure-index-write", error, `runId=${run.runId}`);
	}
}

/**
 * Default age threshold for stale .corrupt-* quarantine files: 7 days.
 * Quarantined manifests older than this are deleted to prevent unbounded growth.
 */
export const DEFAULT_CORRUPT_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sweep and delete .corrupt-* files older than maxAgeMs in a runs directory tree.
 *
 * These files are created by crash-recovery's purgeStaleActiveRunIndex when a
 * manifest fails to parse (SyntaxError) or encounters an unexpected error.
 * Without this sweep, they accumulate indefinitely across runs.
 *
 * @param runsDir Absolute path to the runs directory (<crewRoot>/state/runs/)
 * @returns count of stale .corrupt-* files deleted
 */
export function sweepStaleCorruptFiles(runsDir: string, maxAgeMs = DEFAULT_CORRUPT_FILE_TTL_MS, now = Date.now()): number {
	let deleted = 0;
	let runDirs: fs.Dirent[];
	try {
		runDirs = fs.readdirSync(runsDir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const dir of runDirs) {
		if (!dir.isDirectory()) continue;
		const runDirPath = path.join(runsDir, dir.name);
		let files: string[];
		try {
			files = fs.readdirSync(runDirPath);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.includes(".corrupt-")) continue;
			const filePath = path.join(runDirPath, file);
			try {
				const mtime = fs.statSync(filePath).mtimeMs;
				if (now - mtime > maxAgeMs) {
					fs.unlinkSync(filePath);
					deleted++;
				}
			} catch {
				// Best effort — file may have been removed concurrently
			}
		}
	}
	return deleted;
}

function isFinished(run: TeamRunManifest): boolean {
	// P3: "blocked" is NOT a terminal status — the run is waiting on something
	// (plan approval, mailbox reply, scheduler stall) and can transition to
	// running/cancelled/failed (per TEAM_RUN_STATUS_TRANSITIONS). Pruning a
	// blocked run destroys recoverable state (e.g. a plan the user needs to
	// approve, or a mailbox wait the user needs to answer). Truly stuck
	// blocked runs are handled by the stale-reconciler/crash-recovery, not
	// by prune.
	return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
}

function isSafeToPrune(cwd: string, run: TeamRunManifest): boolean {
	try {
		const crewRoot = run.stateRoot.startsWith(userCrewRoot() + path.sep) ? userCrewRoot() : projectCrewRoot(cwd);
		resolveRealContainedPath(crewRoot, run.stateRoot);
		resolveRealContainedPath(crewRoot, run.artifactsRoot);
		return true;
	} catch {
		return false;
	}
}

function appendPruneAudit(cwd: string, payload: Record<string, unknown>): string | undefined {
	try {
		// RR-020 Fix 2: a no-op prune must NOT materialize the project crew
		// root. `<crewRoot>/audit/` only exists because a real prune removed
		// runs, and a real prune implies the crew root (+ state/runs) exists —
		// so bail out instead of mkdir-ing a `<crewRoot>/audit/` tree on
		// session start for a project that never ran a team.
		const crewRoot = projectCrewRoot(cwd);
		if (!fs.existsSync(crewRoot)) return undefined;
		const filePath = path.join(crewRoot, "audit", "prune.jsonl");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		// DP-01: rotate the audit log before it grows unbounded (it reached
		// 720 KB / 1,436 entries with no cap). Keep the current file under
		// PRUNE_AUDIT_MAX_BYTES; older entries rotate to .1 (one generation).
		rotatePruneAuditIfNeeded(filePath);
		fs.appendFileSync(filePath, `${JSON.stringify(redactSecrets({ ...payload, auditedAt: new Date().toISOString() }))}\n`, "utf-8");
		return filePath;
	} catch (error) {
		logInternalError("prune.audit-write", error, `cwd=${cwd}`);
		return undefined;
	}
}

export function pruneFinishedRuns(cwd: string, keep: number, options: PruneRunsOptions = {}): PruneRunsResult {
	const token = createCancellationToken({ signal: options.signal });
	const finished = listRuns(cwd, options.signal)
		.filter((run) => run.cwd === cwd && isFinished(run))
		.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
	const kept = finished.slice(0, keep).map((run) => run.runId);
	const removed: string[] = [];
	// DP-01: age floor — a finished run younger than the floor is NEVER removed
	// by auto-prune, even beyond top-keep. Manual prune passes 0 (no floor).
	const ageFloorMs = options.ageFloorMs ?? 0;
	const floorCutoff = ageFloorMs > 0 ? Date.now() - ageFloorMs : 0;
	const toRemove = finished.slice(keep).filter((run) => {
		if (floorCutoff === 0) return true;
		const ts = Date.parse(run.updatedAt ?? run.createdAt ?? "");
		// Unparseable timestamps are treated as OLD (removable) to preserve
		// pre-DP-01 behavior for malformed manifests.
		if (!Number.isFinite(ts)) return true;
		return ts < floorCutoff;
	});
	for (let i = 0; i < toRemove.length; i++) {
		if (i % 5 === 0) token.heartbeat(`prune:${i}/${toRemove.length}`);
		const run = toRemove[i];
		if (!isSafeToPrune(cwd, run)) {
			logInternalError(
				"prune.path-unsafe",
				new Error(`Skipping unsafe prune: stateRoot=${run.stateRoot}, artifactsRoot=${run.artifactsRoot}`),
				`runId=${run.runId}`,
			);
			continue;
		}
		// dryRun: stop after the read-only safety check. Do NOT run worktree
		// cleanup (it writes diff artifacts for dirty worktrees), delete state,
		// or write an audit — this is a non-destructive preview. Actual removal
		// may additionally skip dirty-worktree runs (cleanupRunWorktrees preserves
		// them for recovery), so the dryRun list is an upper bound.
		if (options.dryRun) {
			removed.push(run.runId);
			continue;
		}
		// P2: clean up git worktrees BEFORE deleting state. Worktrees live at
		// <crewRoot>/state/worktrees/<runId>/ — a separate path from stateRoot
		// (<crewRoot>/state/runs/<runId>/) and artifactsRoot, so fs.rmSync below
		// does NOT touch them. Without this, every pruned worktree-using run
		// leaks its worktree dir + git branch. cleanupRunWorktrees (no force)
		// preserves dirty worktrees by writing a diff artifact and skipping
		// the removal — in that case we skip the whole prune of this run so
		// the user can recover (no silent data loss). Compare handleForget
		// which calls cleanupRunWorktrees.
		const worktreeCleanup = cleanupRunWorktrees(run, { signal: options.signal });
		if (worktreeCleanup.preserved.length > 0) {
			logInternalError(
				"prune.worktree-preserved",
				new Error(
					`Skipping prune: ${worktreeCleanup.preserved.length} dirty worktree(s) preserved for recovery: ${worktreeCleanup.preserved.map((p) => p.path).join(", ")}`,
				),
				`runId=${run.runId}`,
			);
			continue;
		}
		fs.rmSync(run.stateRoot, { recursive: true, force: true });
		fs.rmSync(run.artifactsRoot, { recursive: true, force: true });
		// DP-01: preserve the reason of a pruned failed/blocked run in a durable
		// index (the run dir that held it is gone now).
		if (run.status === "failed" || run.status === "blocked") appendPrunedFailureIndex(cwd, run);
		removed.push(run.runId);
	}
	// ST-6: Sweep stale .corrupt-* quarantine files to prevent unbounded growth.
	if (!options.dryRun) {
		sweepStaleCorruptFiles(path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.runsSubdir));
	}

	// RR-020 Fix 2 note: appendPruneAudit itself bails when the crew root does
	// not exist, so a no-op prune on a fresh project writes nothing. When the
	// crew root DOES exist, HEAD parity is preserved — a zero-candidate prune
	// still records its `kept:[] removed:[]` audit line (cold-verify correction:
	// the earlier `finished.length === 0` bail suppressed that line).
	const auditPath = options.dryRun
		? undefined
		: appendPruneAudit(cwd, {
				action: "prune",
				keep,
				intent: options.intent,
				kept,
				removed,
			});
	return { kept, removed, auditPath };
}

/**
 * Prune finished run directories at the user level (~/.pi/agent/extensions/pi-crew/state/runs/).
 *
 * This handles runs created without a project root (e.g. `team action='run'` from home directory)
 * that would otherwise accumulate forever.
 *
 * @param keep Number of most recent finished runs to retain
 * @returns kept and removed run IDs
 */
export function pruneUserLevelRuns(keep: number, options: PruneRunsOptions = {}): PruneRunsResult {
	const crewRoot = userCrewRoot();
	const runsRoot = path.join(crewRoot, DEFAULT_PATHS.state.runsSubdir);
	if (!fs.existsSync(runsRoot)) return { kept: [], removed: [] };

	// Read all run directories, parse manifests, filter to finished
	const MAX_DIRS = 500;
	const finished: Array<{
		runId: string;
		updatedAt?: string;
		createdAt?: string;
		status?: string;
		summary?: string;
		goal?: string;
		team?: string;
		stateRoot: string;
		artifactsRoot: string;
	}> = [];
	const ghostRemoved: string[] = [];
	const dirs = fs
		.readdirSync(runsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && isSafePathId(entry.name))
		.slice(0, MAX_DIRS)
		.map((entry) => entry.name);

	for (const dir of dirs) {
		const manifestPath = path.join(runsRoot, dir, DEFAULT_PATHS.state.manifestFile);
		let manifest: TeamRunManifest | undefined;
		try {
			manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as TeamRunManifest;
		} catch {
			continue;
		}

		// Ghost run cleanup: active status but CWD no longer exists.
		// These are deadletter/replay/temp runs from dead Pi sessions.
		const isActive = manifest.status === "queued" || manifest.status === "running" || manifest.status === "planning";
		if (isActive && manifest.cwd && !fs.existsSync(manifest.cwd)) {
			fs.rmSync(path.join(runsRoot, dir), {
				recursive: true,
				force: true,
			});
			ghostRemoved.push(manifest.runId);
			continue;
		}

		if (!isFinished(manifest)) continue;

		// Safety check: ensure stateRoot and artifactsRoot are contained within user crew root
		try {
			resolveRealContainedPath(crewRoot, manifest.stateRoot);
			resolveRealContainedPath(crewRoot, manifest.artifactsRoot);
		} catch {
			continue;
		}

		finished.push({
			runId: manifest.runId,
			updatedAt: manifest.updatedAt,
			createdAt: manifest.createdAt,
			status: manifest.status,
			summary: manifest.summary,
			goal: manifest.goal,
			team: manifest.team,
			stateRoot: manifest.stateRoot,
			artifactsRoot: manifest.artifactsRoot,
		});
	}

	// Sort newest first, keep top N, remove the rest.
	finished.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
	const kept = finished.slice(0, keep).map((r) => r.runId);
	const removed: string[] = [];
	// DP-01: same age floor as the project-level prune (user-level runs are
	// equally easy to lose — the 2026-09-21 incident evidence lived here too).
	const ageFloorMs = options.ageFloorMs ?? 0;
	const floorCutoff = ageFloorMs > 0 ? Date.now() - ageFloorMs : 0;
	for (const run of finished.slice(keep)) {
		if (floorCutoff > 0) {
			const ts = Date.parse(run.updatedAt ?? run.createdAt ?? "");
			if (Number.isFinite(ts) && ts >= floorCutoff) continue; // too young — protect
		}
		fs.rmSync(run.stateRoot, { recursive: true, force: true });
		fs.rmSync(run.artifactsRoot, { recursive: true, force: true });
		// DP-01: preserve a pruned failed/blocked run's reason (the user-level
		// index lives under the user crew root).
		if (run.status === "failed" || run.status === "blocked") {
			appendPrunedFailureIndex(crewRoot, {
				runId: run.runId,
				status: run.status,
				summary: run.summary,
				goal: run.goal,
				team: run.team,
				createdAt: run.createdAt,
			} as TeamRunManifest);
		}
		removed.push(run.runId);
	}

	// ST-6: Sweep stale .corrupt-* quarantine files at user level too.
	sweepStaleCorruptFiles(runsRoot);

	return { kept, removed: [...removed, ...ghostRemoved] };
}
