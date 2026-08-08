import { type Dirent, lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";

/**
 * Phase 2 crash-resume (D1/D1b/D12): locate the latest scratchpad snapshot
 * artifact for a task inside the run's artifact store.
 *
 * Artifacts are written by the worker's flush path as
 * `scratchpad/<taskId>.attempt-<i>.snapshot.json` (C3 per-attempt suffix, i =
 * model-fallback index that resets to 0 on every retry round — so mtime, NOT
 * the attempt number, is the write-order proxy).
 *
 * Selection (D1b): latest mtime wins; equal mtime ties break by LOWEST attempt
 * number (ASC) — a new retry round restarts at i=0, so on a coarse-mtime tie
 * the low-index file belongs to the NEWER round (MINOR-S6).
 *
 * Strictness (D12, cross-agent poisoning): only REGULAR files match; symlinks
 * are rejected at readdir time via dirent (never followed); the name must be
 * exactly `<agentId>.attempt-<digits>.snapshot.json`.
 *
 * Read-only, fail-open: any I/O error (missing dir, EACCES, file vanished in a
 * race) yields null — the caller then simply skips the restore env.
 */

export interface SnapshotHit {
	path: string;
	attempt: number;
	mtimeMs: number;
}

const SNAPSHOT_SUFFIX = ".snapshot.json";

export function findLatestScratchpadSnapshot(artifactsRoot: string, agentId: string): SnapshotHit | null {
	const scratchpadDir = join(artifactsRoot, "scratchpad");
	// SEC-7 (MINOR-CA-1): reject a symlinked scratchpad DIR itself before readdir
	// (entry-level D12 checks cannot see a replaced directory) — fail-open null.
	let dirStat: Stats;
	try {
		dirStat = lstatSync(scratchpadDir);
	} catch {
		return null; // missing dir — fail-open: no snapshot to resume from
	}
	if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
	let entries: Dirent[];
	try {
		entries = readdirSync(scratchpadDir, { withFileTypes: true });
	} catch {
		// EACCES etc. — fail-open: no snapshot to resume from.
		return null;
	}
	const prefix = `${agentId}.attempt-`;
	let best: SnapshotHit | null = null;
	for (const dirent of entries) {
		// D12: reject symlinks at readdir; only regular files match.
		if (dirent.isSymbolicLink() || !dirent.isFile()) continue;
		const name = dirent.name;
		if (!name.startsWith(prefix) || !name.endsWith(SNAPSHOT_SUFFIX)) continue;
		const attemptPart = name.slice(prefix.length, name.length - SNAPSHOT_SUFFIX.length);
		if (!/^\d+$/.test(attemptPart)) continue;
		const attempt = Number.parseInt(attemptPart, 10);
		let stat: Stats;
		try {
			stat = lstatSync(join(scratchpadDir, name)); // lstat: double-check not a symlink (TOCTOU guard)
		} catch {
			continue; // file vanished between readdir and stat — skip
		}
		if (!stat.isFile()) continue;
		const hit: SnapshotHit = { path: join(scratchpadDir, name), attempt, mtimeMs: stat.mtimeMs };
		if (best === null || hit.mtimeMs > best.mtimeMs || (hit.mtimeMs === best.mtimeMs && hit.attempt < best.attempt)) {
			best = hit;
		}
	}
	return best;
}
