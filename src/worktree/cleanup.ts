import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest } from "../state/types.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import { DEFAULT_PATHS } from "../config/defaults.ts";

export interface WorktreeCleanupResult {
	removed: string[];
	preserved: Array<{ path: string; reason: string }>;
	artifactPaths: string[];
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function isDirty(worktreePath: string): boolean {
	try {
		return git(worktreePath, ["status", "--porcelain"]).trim().length > 0;
	} catch {
		return true;
	}
}

function captureDiff(worktreePath: string): string {
	try {
		return [git(worktreePath, ["status", "--porcelain"]), "", git(worktreePath, ["diff", "--stat"]), "", git(worktreePath, ["diff"])].join("\n");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Failed to capture cleanup diff for ${worktreePath}: ${message}`;
	}
}

export function cleanupRunWorktrees(manifest: TeamRunManifest, options: { force?: boolean } = {}): WorktreeCleanupResult {
	const worktreeRoot = path.join(projectCrewRoot(manifest.cwd), DEFAULT_PATHS.state.worktreesSubdir, manifest.runId);
	const result: WorktreeCleanupResult = { removed: [], preserved: [], artifactPaths: [] };
	if (!fs.existsSync(worktreeRoot)) return result;

	for (const entry of fs.readdirSync(worktreeRoot)) {
		const worktreePath = path.join(worktreeRoot, entry);
		if (!fs.statSync(worktreePath).isDirectory()) continue;
		const dirty = isDirty(worktreePath);
		if (dirty && !options.force) {
			const artifact = writeArtifact(manifest.artifactsRoot, {
				kind: "diff",
				relativePath: `cleanup/${entry}.diff`,
				content: captureDiff(worktreePath),
				producer: "worktree-cleanup",
			});
			result.artifactPaths.push(artifact.path);
			result.preserved.push({ path: worktreePath, reason: "dirty worktree preserved" });
			continue;
		}
		try {
			git(manifest.cwd, ["worktree", "remove", options.force ? "--force" : "", worktreePath].filter(Boolean));
			result.removed.push(worktreePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.preserved.push({ path: worktreePath, reason: message });
		}
	}

	try {
		if (fs.existsSync(worktreeRoot) && fs.readdirSync(worktreeRoot).length === 0) fs.rmSync(worktreeRoot, { recursive: true, force: true });
	} catch {
		// Non-critical cleanup.
	}
	return result;
}
