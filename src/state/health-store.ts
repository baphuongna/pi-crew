import * as fs from "node:fs";
import * as path from "node:path";
import type { ManifestSummary, } from "../runtime/task-health.ts";
import { computeRunHealth } from "../runtime/task-health.ts";
import { atomicWriteFile } from "./atomic-write.ts";

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
