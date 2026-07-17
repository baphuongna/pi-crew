import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Information about a detected project.
 */
export interface ProjectInfo {
	projectId: string;
	projectName: string;
}

/**
 * Create a SHA256 hash of a string, returning the first 16 characters.
 */
function hashPath(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Extract the repository name from a git remote URL.
 * Handles formats like:
 *   - https://github.com/user/repo.git
 *   - https://github.com/user/repo
 *   - git@github.com:user/repo.git
 *   - ssh://git@github.com/user/repo.git
 */
function extractRepoName(remoteUrl: string): string | null {
	// Remove .git suffix
	const withoutGit = remoteUrl.replace(/\.git$/, "");

	// Handle SSH format: git@github.com:user/repo
	const sshMatch = withoutGit.match(/^git@[^:]+:(.+)$/);
	if (sshMatch) {
		const parts = sshMatch[1].split("/");
		return parts[parts.length - 1] ?? null;
	}

	// Handle HTTPS/HTTP/SSH URL format
	try {
		const url = new URL(withoutGit);
		const pathParts = url.pathname.split("/").filter(Boolean);
		return pathParts[pathParts.length - 1] ?? null;
	} catch {
		// Not a valid URL, try to extract from path-like string
		const parts = withoutGit.split("/").filter(Boolean);
		return parts[parts.length - 1] ?? null;
	}
}

/**
 * Try to get the repository name from git remote origin.
 */
function tryGitRemote(cwd: string): string | null {
	try {
		const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		}).trim();

		if (!remoteUrl) return null;

		const repoName = extractRepoName(remoteUrl);
		if (!repoName) return null;

		// Verify it's a valid directory name (no path traversal attempts)
		if (repoName.includes("..") || repoName.includes("/")) return null;

		return repoName;
	} catch {
		return null;
	}
}

/**
 * Try to get the directory name from git toplevel.
 */
function tryGitToplevel(cwd: string): string | null {
	try {
		const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		}).trim();

		if (!toplevel || !fs.existsSync(toplevel)) return null;

		const dirName = path.basename(toplevel);
		// Verify it's a valid directory name
		if (!dirName || dirName.includes("..") || dirName.includes("/")) return null;

		return dirName;
	} catch {
		return null;
	}
}

/**
 * Detect project information from a working directory.
 * Uses a hierarchy of detection methods, falling through on failure.
 *
 * Detection hierarchy (first successful wins):
 * 1. CLAUDE_PROJECT_DIR env var → hash the path, use dir name as name
 * 2. git remote get-url origin → extract repo name from URL
 * 3. git rev-parse --show-toplevel → use dir name
 * 4. Fallback: hash(cwd) for projectId, path.basename(cwd) for name
 */
export function detectProjectId(cwd: string): ProjectInfo {
	// Normalize the cwd path
	const normalizedCwd = path.resolve(cwd);

	// Method 1: Check CLAUDE_PROJECT_DIR env var
	const claudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
	if (claudeProjectDir?.trim()) {
		const resolvedPath = path.resolve(claudeProjectDir.trim());
		const projectName = path.basename(resolvedPath);
		const projectId = hashPath(resolvedPath);
		return { projectId, projectName };
	}

	// Method 2: Try git remote origin
	const repoName = tryGitRemote(normalizedCwd);
	if (repoName) {
		const projectId = hashPath(normalizedCwd);
		return { projectId, projectName: repoName };
	}

	// Method 3: Try git toplevel
	const toplevelName = tryGitToplevel(normalizedCwd);
	if (toplevelName) {
		const projectId = hashPath(normalizedCwd);
		return { projectId, projectName: toplevelName };
	}

	// Method 4: Fallback - hash the cwd and use basename
	const projectId = hashPath(normalizedCwd);
	const projectName = path.basename(normalizedCwd) || "unknown";
	return { projectId, projectName };
}

/**
 * Get the storage directory for a specific project's instincts.
 * @param projectId - The project identifier (from detectProjectId)
 * @param crewRoot - The crew root directory (e.g., from projectCrewRoot)
 * @returns The path to the project's storage directory
 */
export function getProjectStorageDir(projectId: string, crewRoot: string): string {
	return path.join(crewRoot, "instincts", "projects", projectId);
}

/**
 * Get the global storage directory for instincts.
 * @param crewRoot - The crew root directory
 * @returns The path to the global storage directory
 */
export function getGlobalStorageDir(crewRoot: string): string {
	return path.join(crewRoot, "instincts", "global");
}
