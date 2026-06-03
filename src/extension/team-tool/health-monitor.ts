// watchdog monitored
// Auto-monitored by watchdog
// health monitor support
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listRuns } from "../run-index.ts";
import { readCrewAgents } from "../../runtime/crew-agent-records.ts";
import {
	isActiveRunStatus,
	hasStaleAsyncProcess,
	isLikelyOrphanedActiveRun,
} from "../../runtime/process-status.ts";
import { result, type TeamContext } from "./context.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";

// ── Types ────────────────────────────────────────────────────────────

interface HealthEntry {
	runId: string;
	reason: string;
	detail: string;
}

interface CorruptEntry {
	runId: string;
	reason: string;
}

interface StuckTask {
	runId: string;
	taskId: string;
	staleMs: number;
	detail: string;
}

interface ZombieWorkspace {
	dir: string;
	runCount: number;
}

export interface HealthCounts {
	total: number;
	running: number;
	completed: number;
	failed: number;
	cancelled: number;
	blocked: number;
	queued: number;
	planning: number;
	waiting: number;
	stuck: number;
	zombie: number;
	ghost: number;
	orphaned: number;
	corrupted: number;
}

/** How stale (ms) a task's heartbeat/activity must be before it's considered "stuck". */
export const STUCK_TASK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ── Helpers (exported for testability) ───────────────────────────────

/**
 * Read tasks.json for a given run's stateRoot. Returns empty array on error.
 */
function readRunTasks(stateRoot: string): TeamTaskState[] {
	const tasksPath = path.join(stateRoot, "tasks.json");
	try {
		return JSON.parse(
			fs.readFileSync(tasksPath, "utf-8"),
		) as TeamTaskState[];
	} catch {
		return [];
	}
}

/**
 * Detect "stuck" tasks: tasks with status "running" whose last heartbeat or
 * activity timestamp is older than STUCK_TASK_THRESHOLD_MS.
 */
export function detectStuckTasks(
	run: { runId: string; stateRoot: string },
	now: number,
): StuckTask[] {
	const tasks = readRunTasks(run.stateRoot);
	const stuck: StuckTask[] = [];

	for (const task of tasks) {
		if (task.status !== "running") continue;

		// Check agentProgress.lastActivityAt first, then heartbeat.lastSeenAt, then startedAt
		const activityAt = task.agentProgress?.lastActivityAt
			? new Date(task.agentProgress.lastActivityAt).getTime()
			: Number.NaN;
		const heartbeatAt = task.heartbeat?.lastSeenAt
			? new Date(task.heartbeat.lastSeenAt).getTime()
			: Number.NaN;
		const startedAt = task.startedAt
			? new Date(task.startedAt).getTime()
			: Number.NaN;

		// Use the most recent valid timestamp
		let latest = Number.NaN;
		for (const ts of [activityAt, heartbeatAt, startedAt]) {
			if (
				Number.isFinite(ts) &&
				(!Number.isFinite(latest) || ts > latest)
			) {
				latest = ts;
			}
		}

		if (!Number.isFinite(latest)) continue; // no timestamp to judge

		const staleMs = now - latest;
		if (staleMs > STUCK_TASK_THRESHOLD_MS) {
			stuck.push({
				runId: run.runId,
				taskId: task.id,
				staleMs,
				detail: `stale ${Math.round(staleMs / 60_000)}m (last activity: ${new Date(latest).toISOString()})`,
			});
		}
	}

	return stuck;
}

/**
 * Scan a directory for "pi-crew-*" subdirs that contain
 * .crew/state/runs/ with at least one valid run manifest.
 * Read-only — does NOT mutate anything.
 * Pattern adapted from stale-reconciler.ts:reconcileOrphanedTempWorkspaces().
 */
export function scanZombieTempWorkspaces(
	tmpDir: string,
	now: number,
): ZombieWorkspace[] {
	if (!tmpDir || !fs.existsSync(tmpDir)) return [];
	const zombies: ZombieWorkspace[] = [];

	try {
		const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.startsWith("pi-crew-"))
				continue;
			const workspaceDir = path.join(tmpDir, entry.name);
			const stateRunsDir = path.join(
				workspaceDir,
				".crew",
				"state",
				"runs",
			);
			if (!fs.existsSync(stateRunsDir)) continue;

			let runCount = 0;
			try {
				for (const runDir of fs.readdirSync(stateRunsDir)) {
					const manifestPath = path.join(
						stateRunsDir,
						runDir,
						"manifest.json",
					);
					if (fs.existsSync(manifestPath)) {
						try {
							const manifest = JSON.parse(
								fs.readFileSync(manifestPath, "utf-8"),
							) as { runId?: string; status?: string };
							if (manifest.runId) runCount++;
						} catch {
							/* skip corrupt manifest */
						}
					}
				}
			} catch {
				/* skip unreadable dirs */
			}

			if (runCount > 0) {
				zombies.push({ dir: workspaceDir, runCount });
			}
		}
	} catch {
		/* skip if tmpdir unreadable */
	}

	return zombies;
}

/**
 * Scan a directory for pi-crew-* workspaces and collect their runs.
 * Merges with the primary list, deduping by runId.
 */
export function collectTempWorkspaceRuns(
	primaryRuns: Array<{ runId: string }>,
	tmpDir: string,
): Array<{
	runId: string;
	status: string;
	cwd: string;
	stateRoot: string;
	artifactsRoot: string;
	async?: { pid?: number };
	updatedAt: string;
	summary?: string;
}> {
	if (!tmpDir || !fs.existsSync(tmpDir)) return [];

	const primaryIds = new Set(primaryRuns.map((r) => r.runId));
	const runs: Array<{
		runId: string;
		status: string;
		cwd: string;
		stateRoot: string;
		artifactsRoot: string;
		async?: { pid?: number };
		updatedAt: string;
		summary?: string;
	}> = [];

	try {
		const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.startsWith("pi-crew-"))
				continue;
			const stateRunsDir = path.join(
				tmpDir,
				entry.name,
				".crew",
				"state",
				"runs",
			);
			if (!fs.existsSync(stateRunsDir)) continue;

			try {
				for (const runDir of fs.readdirSync(stateRunsDir)) {
					const manifestPath = path.join(
						stateRunsDir,
						runDir,
						"manifest.json",
					);
					if (!fs.existsSync(manifestPath)) continue;
					try {
						const manifest = JSON.parse(
							fs.readFileSync(manifestPath, "utf-8"),
						) as {
							runId?: string;
							status?: string;
							cwd?: string;
							stateRoot?: string;
							artifactsRoot?: string;
							async?: { pid?: number };
							updatedAt?: string;
							summary?: string;
						};
						if (!manifest.runId || primaryIds.has(manifest.runId))
							continue;
						if (
							manifest.status &&
							manifest.cwd &&
							manifest.stateRoot &&
							manifest.artifactsRoot &&
							manifest.updatedAt
						) {
							runs.push({
								runId: manifest.runId!,
								status: manifest.status,
								cwd: manifest.cwd,
								stateRoot: manifest.stateRoot,
								artifactsRoot: manifest.artifactsRoot,
								async: manifest.async,
								updatedAt: manifest.updatedAt,
								summary: manifest.summary,
							});
						}
					} catch {
						/* skip corrupt manifests */
					}
				}
			} catch {
				/* skip unreadable dirs */
			}
		}
	} catch {
		/* skip if tmpdir unreadable */
	}

	return runs;
}

/**
 * Counts run statuses. Accepts a minimal manifest-like object.
 */
export function countStatuses(
	runs: Array<{ status: string }>,
): Pick<
	HealthCounts,
	| "total"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "blocked"
	| "queued"
	| "planning"
	| "waiting"
> {
	const counts = {
		total: runs.length,
		running: 0,
		completed: 0,
		failed: 0,
		cancelled: 0,
		blocked: 0,
		queued: 0,
		planning: 0,
		waiting: 0,
	};

	for (const run of runs) {
		switch (run.status) {
			case "running":
				counts.running++;
				break;
			case "completed":
				counts.completed++;
				break;
			case "failed":
				counts.failed++;
				break;
			case "cancelled":
				counts.cancelled++;
				break;
			case "blocked":
				counts.blocked++;
				break;
			case "queued":
				counts.queued++;
				break;
			case "planning":
				counts.planning++;
				break;
			case "waiting":
				counts.waiting++;
				break;
		}
	}

	return counts;
}

// ── Internal type for merged run entries ──────────────────────────────

interface RunLike {
	runId: string;
	status: string;
	cwd: string;
	stateRoot: string;
	artifactsRoot: string;
	async?: { pid?: number };
	updatedAt: string;
	summary?: string;
}

// ── Core logic (separated for testability) ───────────────────────────

export interface HealthMonitorOptions {
	tmpDir?: string;
}

export function buildHealthReport(
	ctx: TeamContext,
	_params: TeamToolParamsValue,
	options: HealthMonitorOptions = {},
): { text: string; counts: HealthCounts; hasIssues: boolean } {
	const now = Date.now();
	const tmpDir = options.tmpDir ?? os.tmpdir();

	const primaryRuns = listRuns(ctx.cwd, ctx.signal);
	const tempRuns = collectTempWorkspaceRuns(primaryRuns, tmpDir);

	// Merge/dedup by runId (primaryRuns already deduped internally)
	const allRuns: RunLike[] = [...primaryRuns, ...tempRuns];

	const ghost: HealthEntry[] = [];
	const orphaned: HealthEntry[] = [];
	const corrupted: CorruptEntry[] = [];
	const allStuck: StuckTask[] = [];

	for (const run of allRuns) {
		// 1. Ghost: active status but cwd no longer exists
		if (
			isActiveRunStatus(run.status) &&
			run.cwd &&
			!fs.existsSync(run.cwd)
		) {
			ghost.push({
				runId: run.runId,
				reason: "dead-cwd",
				detail: `cwd=${run.cwd}`,
			});
			continue;
		}

		// 2. Corrupted: state root or artifacts root missing
		if (
			!fs.existsSync(run.stateRoot) ||
			!fs.existsSync(run.artifactsRoot)
		) {
			corrupted.push({
				runId: run.runId,
				reason: "missing-state-or-artifacts",
			});
			continue;
		}

		// 3. Stuck task detection for active runs
		if (isActiveRunStatus(run.status)) {
			const stuck = detectStuckTasks(run, now);
			allStuck.push(...stuck);
		}

		// 4. Only check orphan status for active runs
		if (!isActiveRunStatus(run.status)) continue;

		// 5. Orphaned: stale async PID
		if (hasStaleAsyncProcess(run as TeamRunManifest, now)) {
			orphaned.push({
				runId: run.runId,
				reason: "stale-async-pid",
				detail: `pid=${run.async?.pid}`,
			});
			continue;
		}

		// 6. Orphaned: non-async active run with no recent update
		const agents = readCrewAgents(run as TeamRunManifest);
		if (isLikelyOrphanedActiveRun(run as TeamRunManifest, agents, now)) {
			orphaned.push({
				runId: run.runId,
				reason: "stale-no-progress",
				detail: `status=${run.status}`,
			});
		}
	}

	// Status counts
	const statusCounts = countStatuses(allRuns);

	// Zombie /tmp/ workspace detection
	const zombieWorkspaces = scanZombieTempWorkspaces(tmpDir, now);

	// Build counts object
	const counts: HealthCounts = {
		...statusCounts,
		stuck: allStuck.length,
		zombie: zombieWorkspaces.length,
		ghost: ghost.length,
		orphaned: orphaned.length,
		corrupted: corrupted.length,
	};

	// ── Build text report ─────────────────────────────────────────────

	const lines: string[] = [
		"pi-crew health report",
		`Scanned: ${counts.total} runs`,
		"",
		`Status: running=${counts.running} queued=${counts.queued} planning=${counts.planning} waiting=${counts.waiting} completed=${counts.completed} failed=${counts.failed} cancelled=${counts.cancelled} blocked=${counts.blocked}`,
		"",
		`Ghost (dead cwd): ${ghost.length}`,
		`Orphaned (stale process): ${orphaned.length}`,
		`Corrupted (missing state): ${corrupted.length}`,
		`Stuck tasks (heartbeat >5min): ${allStuck.length}`,
		`Zombie /tmp/ workspaces: ${zombieWorkspaces.length}`,
		"",
	];

	if (ghost.length > 0) {
		lines.push("Ghost runs:");
		for (const entry of ghost) {
			lines.push(`  - ${entry.runId}: ${entry.reason} (${entry.detail})`);
		}
		lines.push("");
	}

	if (orphaned.length > 0) {
		lines.push("Orphaned runs:");
		for (const entry of orphaned) {
			lines.push(`  - ${entry.runId}: ${entry.reason} (${entry.detail})`);
		}
		lines.push("");
	}

	if (corrupted.length > 0) {
		lines.push("Corrupted runs:");
		for (const entry of corrupted) {
			lines.push(`  - ${entry.runId}: ${entry.reason}`);
		}
		lines.push("");
	}

	if (allStuck.length > 0) {
		lines.push("Stuck tasks:");
		for (const s of allStuck) {
			lines.push(`  - ${s.runId}/${s.taskId}: ${s.detail}`);
		}
		lines.push("");
	}

	if (zombieWorkspaces.length > 0) {
		lines.push("Zombie /tmp/ workspaces:");
		for (const z of zombieWorkspaces) {
			lines.push(
				`  - ${z.dir} (${z.runCount} run${z.runCount !== 1 ? "s" : ""})`,
			);
		}
		lines.push("");
	}

	const hasIssues =
		ghost.length > 0 ||
		orphaned.length > 0 ||
		corrupted.length > 0 ||
		allStuck.length > 0 ||
		zombieWorkspaces.length > 0;

	if (!hasIssues) {
		lines.push("All runs healthy.");
	}

	// Compact TUI summary line
	lines.push("");
	lines.push(
		`Summary: total=${counts.total} running=${counts.running} completed=${counts.completed} failed=${counts.failed} cancelled=${counts.cancelled} blocked=${counts.blocked} | stuck=${counts.stuck} zombie=${counts.zombie}`,
	);

	const text = lines.join("\n");
	return { text, counts, hasIssues };
}

// ── Main handler ─────────────────────────────────────────────────────

export function handleHealthMonitor(
	ctx: TeamContext,
	params: TeamToolParamsValue,
): PiTeamsToolResult {
	const { text, counts, hasIssues } = buildHealthReport(ctx, params);

	return result(
		text,
		{
			action: "health",
			status: hasIssues ? "error" : "ok",
			data: { ...counts },
		},
		hasIssues,
	);
}
