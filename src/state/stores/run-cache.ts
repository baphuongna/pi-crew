import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { projectCrewRoot } from "../../utils/paths.ts";
import { atomicWriteJson } from "../atomic-write.ts";
import { withFileLockSync } from "../coordination/locks.ts";
import type { TeamTaskState } from "../types.ts";

export interface CacheEntry {
	key: string;
	runId: string;
	status: string;
	tasks: TeamTaskState[];
	cachedAt: number;
	expiresAt: number;
	goal: string;
	team: string;
}

interface CacheIndex {
	[cacheKey: string]: string;
}

/**
 * Compute a cache key from run parameters.
 * Uses SHA-256 hash of normalized goal + team + workflow.
 */
export function computeRunCacheKey(goal: string, team: string, workflow: string, _cwd: string): string {
	const normalized = goal.trim().toLowerCase().replace(/\s+/g, " ");
	return crypto.createHash("sha256").update(normalized).update(team).update(workflow).update(_cwd).digest("hex").slice(0, 16);
}

/**
 * Get the cache directory path.
 */
function cacheDir(cwd: string): string {
	return path.join(projectCrewRoot(cwd), "cache");
}

/**
 * Get cached run result if exists and valid.
 * Returns null if cache miss or expired.
 */
export function getCachedRun(cwd: string, cacheKey: string): CacheEntry | null {
	const dir = cacheDir(cwd);
	const indexPath = path.join(dir, "index.json");

	if (!fs.existsSync(indexPath)) return null;

	try {
		const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as CacheIndex;
		const entryPath = index[cacheKey];

		if (!entryPath || !fs.existsSync(entryPath)) return null;

		const entry = JSON.parse(fs.readFileSync(entryPath, "utf-8")) as CacheEntry;

		if (Date.now() > entry.expiresAt) {
			// Remove expired entry — use lock + atomic write to prevent index corruption
			withFileLockSync(indexPath, () => {
				try {
					fs.unlinkSync(entryPath);
				} catch {
					/* ignore */
				}
				const updatedIndex = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as CacheIndex;
				delete updatedIndex[cacheKey];
				atomicWriteJson(indexPath, updatedIndex);
			});
			return null;
		}

		return entry;
	} catch {
		return null;
	}
}

/**
 * Get cache stats.
 */
export function getCacheStats(cwd: string): {
	entries: number;
	sizeBytes: number;
} {
	const dir = cacheDir(cwd);
	if (!fs.existsSync(dir)) return { entries: 0, sizeBytes: 0 };

	let sizeBytes = 0;
	let entries = 0;
	const indexPath = path.join(dir, "index.json");

	if (fs.existsSync(indexPath)) {
		try {
			const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as CacheIndex;
			entries = Object.keys(index).length;
			for (const entryPath of Object.values(index)) {
				try {
					const stat = fs.statSync(entryPath);
					sizeBytes += stat.size;
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* ignore */
		}
	}

	return { entries, sizeBytes };
}
