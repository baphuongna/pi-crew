import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest } from "../state/types.ts";
import { projectPiRoot, userPiRoot } from "../utils/paths.ts";

function readManifest(filePath: string): TeamRunManifest | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as TeamRunManifest;
	} catch {
		return undefined;
	}
}

function collectRuns(root: string, maxEntries?: number): TeamRunManifest[] {
	const runsRoot = path.join(root, "state", "runs");
	if (!fs.existsSync(runsRoot)) return [];
	const entries = fs.readdirSync(runsRoot).sort((a, b) => b.localeCompare(a));
	const selected = maxEntries !== undefined ? entries.slice(0, Math.max(0, maxEntries)) : entries;
	return selected
		.map((entry) => readManifest(path.join(runsRoot, entry, "manifest.json")))
		.filter((manifest): manifest is TeamRunManifest => manifest !== undefined);
}

function mergeRuns(userRuns: TeamRunManifest[], projectRuns: TeamRunManifest[], max?: number): TeamRunManifest[] {
	const byId = new Map<string, TeamRunManifest>();
	for (const run of [...userRuns, ...projectRuns]) byId.set(run.runId, run);
	const sorted = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return max !== undefined ? sorted.slice(0, Math.max(0, max)) : sorted;
}

export function listRuns(cwd: string): TeamRunManifest[] {
	return mergeRuns(
		collectRuns(path.join(userPiRoot(), "extensions", "pi-crew", "runs")),
		collectRuns(path.join(projectPiRoot(cwd), "teams")),
	);
}

export function listRecentRuns(cwd: string, max = 20): TeamRunManifest[] {
	return mergeRuns(
		collectRuns(path.join(userPiRoot(), "extensions", "pi-crew", "runs"), max),
		collectRuns(path.join(projectPiRoot(cwd), "teams"), max),
		max,
	);
}
