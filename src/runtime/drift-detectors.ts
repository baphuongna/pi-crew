/**
 * Runtime drift detectors — detect state anomalies in pi-crew runs.
 *
 * Pattern origin: GSD-2 ADR-017 drift detection & state reconciliation.
 * Each detector checks for a specific anomaly and returns a report.
 * Repair handlers are idempotent — safe to run multiple times.
 */

import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { logInternalError } from "../utils/internal-error.ts";

// ── Types ────────────────────────────────────────────────────────────────

export type DriftKind =
	| "stale-process"         // Heartbeat timeout (existing)
	| "orphaned-claim"        // Task claim without task
	| "orphaned-worktree"     // Worktree dir without active run
	| "missing-timestamps"    // State files without timestamps
	| "status-divergence"     // Manifest status ≠ status file
	| "unregistered-run";     // State dir but no manifest

export interface DriftReport {
	kind: DriftKind;
	runId: string;
	details: string;
	repaired: boolean;
	repairResult?: string;
}

export interface DriftContext {
	/** Root directory for crew state (.crew/) */
	crewRoot: string;
	/** Active run IDs (from registry) */
	activeRunIds: Set<string>;
	/** Manifest content if available */
	manifest?: { runId: string; status: string; cwd: string; [k: string]: unknown };
}

// ── Detectors ────────────────────────────────────────────────────────────

/**
 * Detect task claims that reference tasks not in the manifest.
 */
export function detectOrphanedClaim(ctx: DriftContext): DriftReport | null {
	if (!ctx.manifest) return null;
	const claimsDir = path.join(ctx.crewRoot, "state", "task-claims");
	if (!existsSync(claimsDir)) return null;

	const claimFiles = readdirSync(claimsDir).filter((f) => f.endsWith(".json"));
	for (const file of claimFiles) {
		try {
			const claim = JSON.parse(readFileSync(path.join(claimsDir, file), "utf-8"));
			if (claim.runId === ctx.manifest.runId && claim.taskId) {
				// Check if task exists in manifest tasks array
				const tasks = (ctx.manifest as Record<string, unknown>).tasks;
				if (Array.isArray(tasks) && !tasks.some((t: Record<string, unknown>) => t.id === claim.taskId)) {
					return {
						kind: "orphaned-claim",
						runId: ctx.manifest.runId,
						details: `Task claim '${claim.taskId}' references non-existent task`,
						repaired: false,
					};
				}
			}
		} catch {
			// Malformed claim file — skip
		}
	}
	return null;
}

/**
 * Detect worktree directories that don't belong to any active run.
 */
export function detectOrphanedWorktree(ctx: DriftContext): DriftReport | null {
	const worktreesDir = path.join(ctx.crewRoot, "worktrees");
	if (!existsSync(worktreesDir)) return null;

	const dirs = readdirSync(worktreesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	for (const dir of dirs) {
		// Extract run ID from worktree dir name (format: <runId>-<taskId> or <runId>)
		const runId = dir.split("-").slice(0, 5).join("-"); // heuristic: run IDs are timestamp-based
		if (!ctx.activeRunIds.has(runId) && !ctx.activeRunIds.has(dir)) {
			return {
				kind: "orphaned-worktree",
				runId: dir,
				details: `Worktree '${dir}' has no active run`,
				repaired: false,
			};
		}
	}
	return null;
}

/**
 * Detect state files missing required timestamps.
 */
export function detectMissingTimestamps(ctx: DriftContext): DriftReport | null {
	if (!ctx.manifest) return null;
	const stateDir = path.join(ctx.crewRoot, "state");
	if (!existsSync(stateDir)) return null;

	// Check manifest has createdAt/updatedAt
	const m = ctx.manifest as Record<string, unknown>;
	if (!m.createdAt && !m.updatedAt) {
		return {
			kind: "missing-timestamps",
			runId: ctx.manifest.runId,
			details: "Manifest missing createdAt/updatedAt timestamps",
			repaired: false,
		};
	}
	return null;
}

/**
 * Detect divergence between manifest status and individual task status files.
 */
export function detectStatusDivergence(ctx: DriftContext): DriftReport | null {
	if (!ctx.manifest) return null;
	const statusPath = path.join(ctx.crewRoot, "state", `${ctx.manifest.runId}.status`);
	if (!existsSync(statusPath)) return null;

	try {
		const status = readFileSync(statusPath, "utf-8").trim();
		if (status !== ctx.manifest.status) {
			return {
				kind: "status-divergence",
				runId: ctx.manifest.runId,
				details: `Manifest says '${ctx.manifest.status}' but status file says '${status}'`,
				repaired: false,
			};
		}
	} catch {
		// Can't read status file — not drift, might be permissions
	}
	return null;
}

/**
 * Detect state directories that have no corresponding manifest.
 */
export function detectUnregisteredRun(ctx: DriftContext): DriftReport | null {
	const runsDir = path.join(ctx.crewRoot, "runs");
	if (!existsSync(runsDir)) return null;

	const runDirs = readdirSync(runsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	for (const runId of runDirs) {
		if (!ctx.activeRunIds.has(runId)) {
			// Check if it has state files (manifest exists)
			const manifestPath = path.join(runsDir, runId, "manifest.json");
			if (existsSync(manifestPath)) {
				try {
					const stat = statSync(manifestPath);
					const ageMs = Date.now() - stat.mtimeMs;
					// Only flag if older than 1 hour (might be in-progress)
					if (ageMs > 60 * 60 * 1000) {
						return {
							kind: "unregistered-run",
							runId,
							details: `Run '${runId}' has manifest but is not in active registry (age: ${Math.round(ageMs / 60000)}m)`,
							repaired: false,
						};
					}
				} catch {
					// Can't stat — skip
				}
			}
		}
	}
	return null;
}

// ── Reconciliation Loop ─────────────────────────────────────────────────

const ALL_DETECTORS = [
	detectOrphanedClaim,
	detectOrphanedWorktree,
	detectMissingTimestamps,
	detectStatusDivergence,
	detectUnregisteredRun,
];

/**
 * Run all drift detectors and collect reports.
 * Capped at maxPasses repair attempts.
 *
 * Pattern origin: GSD-2 ADR-017 — capped at 2 retry passes.
 */
export function runDriftDetection(ctx: DriftContext, maxPasses = 2): DriftReport[] {
	const reports: DriftReport[] = [];

	for (let pass = 0; pass < maxPasses; pass++) {
		let newFindings = 0;

		for (const detector of ALL_DETECTORS) {
			try {
				const report = detector(ctx);
				if (report) {
					reports.push(report);
					newFindings++;
				}
			} catch (error) {
				logInternalError("drift-detectors", error, `detector=${detector.name} runId=${ctx.manifest?.runId}`);
			}
		}

		// If no new findings, stop early
		if (newFindings === 0) break;
	}

	return reports;
}
