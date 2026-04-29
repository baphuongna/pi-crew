import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest } from "../state/types.ts";
import { DEFAULT_PATHS } from "../config/defaults.ts";
import { findRepoRoot, projectCrewRoot, userCrewRoot } from "../utils/paths.ts";

function readManifest(filePath: string): TeamRunManifest | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as TeamRunManifest;
	} catch {
		return undefined;
	}
}

function collectRuns(root: string, maxEntries?: number): TeamRunManifest[] {
	const runsRoot = path.join(root, DEFAULT_PATHS.state.runsSubdir);
	if (!fs.existsSync(runsRoot)) return [];
	const entries = fs.readdirSync(runsRoot).sort((a, b) => b.localeCompare(a));
	const selected = maxEntries !== undefined ? entries.slice(0, Math.max(0, maxEntries)) : entries;
	return selected
		.map((entry) => readManifest(path.join(runsRoot, entry, DEFAULT_PATHS.state.manifestFile)))
		.filter((manifest): manifest is TeamRunManifest => manifest !== undefined);
}

function mergeRuns(runSets: TeamRunManifest[][], max?: number): TeamRunManifest[] {
	const byId = new Map<string, TeamRunManifest>();
	for (const runs of runSets) for (const run of runs) byId.set(run.runId, run);
	const sorted = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return max !== undefined ? sorted.slice(0, Math.max(0, max)) : sorted;
}

function scopedRunRoots(cwd: string): string[] {
	return [findRepoRoot(cwd) ? projectCrewRoot(cwd) : userCrewRoot()];
}

export function listRuns(cwd: string): TeamRunManifest[] {
	const roots = scopedRunRoots(cwd);
	return mergeRuns(roots.map((root) => collectRuns(root)));
}

export function listRecentRuns(cwd: string, max = 20): TeamRunManifest[] {
	const roots = scopedRunRoots(cwd);
	return mergeRuns(roots.map((root) => collectRuns(root, max)), max);
}
