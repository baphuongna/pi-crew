/**
 * Auto-initialize .crew directory structure and .gitignore entries.
 * Called on first team run in a workspace to ensure all required
 * directories and files exist.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { projectCrewRoot } from "../utils/paths.ts";
import { updateGitignore } from "./gitignore-manager.ts";

/** README content for the .crew directory. */
const CREW_README = `# .crew — pi-crew Runtime Directory

This directory contains pi-crew runtime state and artifacts.

## What's Here

| Directory | Purpose | Commit? |
|-----------|---------|---------|
| \`state/runs/\` | Run manifests, tasks, events | No |
| \`state/subagents/\` | Subagent state | No |
| \`artifacts/\` | Run outputs (test files, docs, etc.) | Optional |
| \`cache/\` | Cached run results (fingerprint-based) | No |
| \`graphs/\` | Archived run graphs | Optional |
| \`audit/\` | Security event logs | No |

## Cleanup

To prune old runs:
\`\`\`bash
team action='prune' keep=5
\`\`\`

To clear cache:
\`\`\`bash
team action='cache' action='clear'
\`\`\`
`;

/**
 * Ensure the .crew directory structure exists with all required subdirectories,
 * placeholder files, README, and .gitignore entries.
 *
 * Uses `projectCrewRoot()` to resolve the correct root (`.crew/` or `.pi/teams/`
 * for legacy projects). Idempotent — safe to call multiple times.
 */
export async function ensureCrewDirectory(cwd: string): Promise<void> {
	const crewRoot = projectCrewRoot(cwd);

	// 1. Create directory structure
	const dirs = [
		crewRoot,
		path.join(crewRoot, "state", "runs"),
		path.join(crewRoot, "state", "subagents"),
		path.join(crewRoot, "artifacts"),
		path.join(crewRoot, "cache"),
		path.join(crewRoot, "graphs"),
		path.join(crewRoot, "audit"),
	];

	for (const dir of dirs) {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	// 2. Create .gitkeep placeholders in directories that should be tracked
	const placeholders = [
		path.join(crewRoot, "artifacts", ".gitkeep"),
		path.join(crewRoot, "cache", ".gitkeep"),
		path.join(crewRoot, "graphs", ".gitkeep"),
		path.join(crewRoot, "audit", ".gitkeep"),
	];

	for (const placeholder of placeholders) {
		if (!fs.existsSync(placeholder)) {
			fs.writeFileSync(placeholder, "", "utf-8");
		}
	}

	// 3. Write README.md (always overwrite to keep it current)
	fs.writeFileSync(path.join(crewRoot, "README.md"), CREW_README, "utf-8");

	// 4. Update .gitignore — resolve project root to place .gitignore correctly
	// Find the repo root to place .gitignore at the project root (not inside .crew)
	const repoRoot = findRepoRootForGitignore(cwd);
	if (repoRoot) {
		const gitignorePath = path.join(repoRoot, ".gitignore");
		await updateGitignore(gitignorePath);
	}
}

/**
 * Find the appropriate project root for placing the .gitignore.
 * Walks up from cwd to find a directory with project markers.
 */
function findRepoRootForGitignore(cwd: string): string | undefined {
	// Use the same project root markers as paths.ts
	const dirMarkers = [".git", ".pi", ".crew", ".hg", ".svn"];
	const fileMarkers = [
		"package.json",
		"pyproject.toml",
		"Cargo.toml",
		"go.mod",
	];
	const root = path.parse(cwd).root;
	let current = path.resolve(cwd);
	while (current !== root) {
		for (const marker of dirMarkers) {
			if (fs.existsSync(path.join(current, marker))) return current;
		}
		for (const marker of fileMarkers) {
			if (fs.existsSync(path.join(current, marker))) return current;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	// No project root found — don't create .gitignore
	return undefined;
}
