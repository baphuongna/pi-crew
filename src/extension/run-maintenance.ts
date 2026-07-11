import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_PATHS } from "../config/defaults.ts";
import { createCancellationToken } from "../runtime/cancellation-token.ts";
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
		const filePath = path.join(projectCrewRoot(cwd), "audit", "prune.jsonl");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
	const toRemove = finished.slice(keep);
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
		removed.push(run.runId);
	}
	const auditPath = appendPruneAudit(cwd, {
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
export function pruneUserLevelRuns(keep: number): PruneRunsResult {
	const crewRoot = userCrewRoot();
	const runsRoot = path.join(crewRoot, DEFAULT_PATHS.state.runsSubdir);
	if (!fs.existsSync(runsRoot)) return { kept: [], removed: [] };

	// Read all run directories, parse manifests, filter to finished
	const MAX_DIRS = 500;
	const finished: Array<{
		runId: string;
		updatedAt: string;
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
			stateRoot: manifest.stateRoot,
			artifactsRoot: manifest.artifactsRoot,
		});
	}

	// Sort newest first, keep top N, remove the rest
	finished.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
	const kept = finished.slice(0, keep).map((r) => r.runId);
	const removed: string[] = [];
	for (const run of finished.slice(keep)) {
		fs.rmSync(run.stateRoot, { recursive: true, force: true });
		fs.rmSync(run.artifactsRoot, { recursive: true, force: true });
		removed.push(run.runId);
	}

	return { kept, removed: [...removed, ...ghostRemoved] };
}
