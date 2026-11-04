import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_PATHS } from "../../config/defaults.ts";
import type { ManifestSummary } from "../../runtime/task-health.ts";
import { computeRunHealth } from "../../runtime/task-health.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { atomicWriteFile } from "../atomic-write.ts";

// Relative to the crew root (`<cwd>/.crew`). BUG A fix (pts/2 hang
// investigation 2026-06-16): this was `.crew/state/health`, which double-joined
// to `<crewRoot>/state/.crew/state/health` because the caller passed the state
// dir (not the crew root). Now the caller passes the real crew root, so this is
// a plain `state/health` suffix.
const HEALTH_DIR = "state/health";

export interface HealthSnapshot {
	runId: string;
	timestamp: number;
	gitRef?: string;
	score: number;
	grade: string;
	penalties: { reason: string; deduction: number }[];
}

export class HealthStore {
	private readonly crewRoot: string;
	constructor(crewRoot: string) {
		this.crewRoot = crewRoot;
	}

	private healthDir(): string {
		return path.join(this.crewRoot, HEALTH_DIR);
	}

	saveSnapshot(manifest: ManifestSummary): HealthSnapshot {
		const health = computeRunHealth(manifest);
		const snapshot: HealthSnapshot = {
			runId: manifest.runId,
			timestamp: Date.now(),
			score: health.score,
			grade: health.grade,
			penalties: health.penalties,
		};
		const dir = this.healthDir();
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${manifest.runId}.json`);
		// ST-2: atomic (temp + rename + fsync) — a crash mid-writeFileSync would truncate
		// the snapshot and loadAllSnapshots() silently skips unparseable files.
		atomicWriteFile(file, JSON.stringify(snapshot, null, 2) + "\n");
		return snapshot;
	}

	loadLatestSnapshot(): HealthSnapshot | null {
		const dir = this.healthDir();
		if (!fs.existsSync(dir)) return null;
		const snapshots = this.loadAllSnapshots();
		if (snapshots.length === 0) return null;
		// Sort by timestamp descending (most recent first)
		snapshots.sort((a, b) => b.timestamp - a.timestamp);
		return snapshots[0];
	}

	loadAllSnapshots(): HealthSnapshot[] {
		const dir = this.healthDir();
		if (!fs.existsSync(dir)) return [];
		const snapshots = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				try {
					return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
				} catch {
					return null;
				}
			})
			.filter(Boolean) as HealthSnapshot[];
		// Sort by timestamp ascending (oldest first) for consistent ordering
		snapshots.sort((a, b) => a.timestamp - b.timestamp);
		return snapshots;
	}
}

/**
 * FIX 1 (retention): delete one run's health snapshot. The snapshot lives
 * OUTSIDE the run dir (`<crewRoot>/state/health/<runId>.json` vs stateRoot
 * `<crewRoot>/state/runs/<runId>/`), so prune/forget paths that rmSync the
 * stateRoot must call this too or the snapshot is orphaned forever — 2,322
 * files / 9.3 MB accumulated that way (oldest 2026-06-18). Path knowledge
 * stays in this module (HEALTH_DIR); runId trust matches saveSnapshot
 * (both sides are pi-crew-authored manifest runIds).
 */
export function removeHealthSnapshot(crewRoot: string, runId: string): boolean {
	try {
		fs.unlinkSync(path.join(crewRoot, HEALTH_DIR, `${runId}.json`));
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return false;
		logInternalError("health-store.remove-snapshot", error, `runId=${runId}`);
		return false;
	}
}

/** Default bound for the orphan sweep: files examined per call. 2,322
 *  orphans existed on the dev box at discovery, so 5,000 leaves headroom
 *  while keeping the scan bounded on pathological dirs. */
export const SWEEP_ORPHAN_HEALTH_MAX_FILES = 5000;

/**
 * FIX 1 (retention): sweep pre-existing orphaned health snapshots — files
 * under `<crewRoot>/state/health/` whose `<runId>` has NO run dir under
 * `<crewRoot>/state/runs/` (left behind by pre-fix prunes). CONSERVATIVE:
 * a run dir that exists but is unreadable (stat error other than ENOENT)
 * is KEPT — only a positively-confirmed-absent run dir proves the snapshot
 * is garbage. Bounded + best-effort: never throws, malformed entries are
 * skipped (kept).
 */
export function sweepOrphanHealthSnapshots(crewRoot: string, opts: { maxFiles?: number } = {}): { removed: string[]; kept: number } {
	const removed: string[] = [];
	let kept = 0;
	try {
		const dir = path.join(crewRoot, HEALTH_DIR);
		if (!fs.existsSync(dir)) return { removed, kept };
		const files = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.slice(0, opts.maxFiles ?? SWEEP_ORPHAN_HEALTH_MAX_FILES);
		for (const file of files) {
			const runId = file.slice(0, -".json".length);
			const runDir = path.join(crewRoot, DEFAULT_PATHS.state.runsSubdir, runId);
			try {
				fs.statSync(runDir);
				kept++; // run dir exists → snapshot still owned
				continue;
			} catch (error) {
				// ENOENT = positively absent → orphan candidate. ANY other error
				// (EACCES, EPERM on a parent…) = exists-but-unreadable → KEEP.
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
					kept++;
					continue;
				}
			}
			try {
				fs.unlinkSync(path.join(dir, file));
				removed.push(runId);
			} catch {
				kept++; // unlink failed → not removed → still on disk
			}
		}
	} catch (error) {
		logInternalError("health-store.sweep-orphans", error, `crewRoot=${crewRoot}`);
	}
	return { removed, kept };
}
