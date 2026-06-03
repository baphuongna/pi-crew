import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TeamRunManifest } from "../state/types.ts";
import { DEFAULT_PATHS } from "../config/defaults.ts";
import { findRepoRoot, projectCrewRoot, userCrewRoot } from "../utils/paths.ts";
import { activeRunEntries } from "../state/active-run-registry.ts";
import { isSafePathId, resolveRealContainedPath } from "../utils/safe-paths.ts";
import { sharedScanCache } from "../utils/scan-cache.ts";
import { createCancellationToken } from "../runtime/cancellation-token.ts";

function readManifest(filePath: string): TeamRunManifest | undefined {
	const cached = sharedScanCache.readAndCache("manifests", filePath, filePath);
	if (cached) return cached.raw as TeamRunManifest;
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as TeamRunManifest;
	} catch {
		return undefined;
	}
}

function collectRuns(root: string, maxEntries?: number, signal?: AbortSignal): TeamRunManifest[] {
	const runsRoot = path.join(root, DEFAULT_PATHS.state.runsSubdir);
	if (!fs.existsSync(runsRoot)) return [];
	if (signal?.aborted) return [];
	// 2.19 — skip temp directories to avoid phantom runs from test/isolated workspaces.
	// Runs in /tmp/ are typically from tests or isolated worktrees and should not
	// appear in production dashboards unless the process is actually alive.
	const tempDirs = [os.tmpdir(), "/var/tmp", "/tmp"];
	const isTempRoot = tempDirs.some((t) => root.startsWith(t + path.sep));
	const token = createCancellationToken({ signal });
	const entries = fs.readdirSync(runsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && isSafePathId(entry.name))
		.map((entry) => entry.name)
		.sort((a, b) => (b ?? "").localeCompare(a ?? ""));
	const selected = maxEntries !== undefined ? entries.slice(0, Math.max(0, maxEntries)) : entries;
	const results: TeamRunManifest[] = [];
	for (let i = 0; i < selected.length; i++) {
		if (i % 10 === 0) token.heartbeat(`collectRuns:${i}/${selected.length}`);
		try {
			const manifest = readManifest(path.join(resolveRealContainedPath(runsRoot, selected[i]), DEFAULT_PATHS.state.manifestFile));
			if (!manifest) continue;
			// Filter out ghost runs: active status but CWD no longer exists.
			// These are deadletter/replay/temp runs whose temp dirs were cleaned up.
			if ((manifest.status === "queued" || manifest.status === "running" || manifest.status === "planning") && manifest.cwd && !fs.existsSync(manifest.cwd)) continue;
			// 2.19 — for runs in temp directories, verify the background process is alive.
			// Without this, runs that completed/crashed but left stale manifests will still show.
			if (isTempRoot && (manifest.status === "running" || manifest.status === "queued" || manifest.status === "planning")) {
				const asyncPidPath = path.join(path.dirname(manifest.stateRoot), "async.pid");
				try {
					const pidData = JSON.parse(fs.readFileSync(asyncPidPath, "utf-8"));
					const pid = pidData?.pid;
					if (pid && typeof pid === "number") {
						try { process.kill(pid, 0); } catch { continue; } // PID dead, skip this run
					}
				} catch { /* no async.pid or parse error — keep the run */ }
			}
			results.push(manifest);
		} catch { /* skip unreadable manifests */ }
	}
	return results;
}

function mergeRuns(runSets: TeamRunManifest[][], max?: number): TeamRunManifest[] {
	const byId = new Map<string, TeamRunManifest>();
	for (const runs of runSets) for (const run of runs) byId.set(run.runId, run);
	const sorted = [...byId.values()].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
	return max !== undefined ? sorted.slice(0, Math.max(0, max)) : sorted;
}

function scopedRunRoots(cwd: string): string[] {
	const roots = new Set<string>();
	roots.add(userCrewRoot());
	const projectRoot = findRepoRoot(cwd);
	if (projectRoot) roots.add(projectCrewRoot(cwd));
	return [...roots];
}

function collectActiveRuns(): TeamRunManifest[] {
	return activeRunEntries()
		.map((entry) => readManifest(entry.manifestPath))
		.filter((manifest): manifest is TeamRunManifest => manifest !== undefined);
}

export function listRuns(cwd: string, signal?: AbortSignal): TeamRunManifest[] {
	const roots = scopedRunRoots(cwd);
	return mergeRuns([...roots.map((root) => collectRuns(root, undefined, signal)), collectActiveRuns()]);
}

export function listRecentRuns(cwd: string, max = 20, signal?: AbortSignal): TeamRunManifest[] {
	const roots = scopedRunRoots(cwd);
	return mergeRuns([...roots.map((root) => collectRuns(root, max, signal)), collectActiveRuns()], max);
}

/**
 * List runs filtered to a specific scope.
 * - "project": only runs in the project crew root
 * - "user": only runs in the user crew root
 * - "all" (default): merge both scopes (current behavior)
 */
export function listRunsByScope(cwd: string, scope: "project" | "user" | "all" = "all", max?: number, signal?: AbortSignal): TeamRunManifest[] {
	const projectRoot = findRepoRoot(cwd);
	switch (scope) {
		case "project":
			return projectRoot ? collectRuns(projectCrewRoot(cwd), max, signal) : [];
		case "user":
			return collectRuns(userCrewRoot(), max, signal);
		case "all":
		default:
			return max !== undefined ? listRecentRuns(cwd, max, signal) : listRuns(cwd, signal);
	}
}
