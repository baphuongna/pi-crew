import { execFileSync } from "node:child_process";
import { buildGitSafeEnv, hardenGitArgs } from "../worktree/git-hardening.ts";

// Read-only git operations only (rev-list, rev-parse, log). C-1 fix
// (code-review 2026-06-23): never inherit the full parent env — API keys
// must not reach git hooks/aliases/credential-helpers. R-A6 (MED-1
// uniformity): env + argv now come from the shared git-hardening helpers
// (sanitizeEnvSecrets allowList, GIT_CONFIG_NOSYSTEM=1, config-injection
// overrides) instead of a drifting local GIT_SAFE_ENV copy.

export type BranchFreshnessStatus = "fresh" | "stale" | "diverged" | "unknown";
export type StaleBranchPolicy = "warn" | "block" | "auto_rebase" | "auto_merge_forward";

export interface BranchFreshness {
	status: BranchFreshnessStatus;
	branch?: string;
	mainRef: string;
	ahead: number;
	behind: number;
	missingFixes: string[];
	message: string;
	error?: string;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", hardenGitArgs(args), {
		cwd,
		env: buildGitSafeEnv(),
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	}).trim();
}

function count(cwd: string, range: string): number {
	const raw = git(cwd, ["rev-list", "--count", range]);
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function checkBranchFreshness(cwd: string, mainRef = "main"): BranchFreshness {
	try {
		git(cwd, ["rev-parse", "--is-inside-work-tree"]);
		const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		const behind = count(cwd, `${branch}..${mainRef}`);
		const ahead = count(cwd, `${mainRef}..${branch}`);
		const missingFixes =
			behind > 0
				? git(cwd, ["log", "--format=%s", `${branch}..${mainRef}`])
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean)
				: [];
		if (behind === 0)
			return {
				status: "fresh",
				branch,
				mainRef,
				ahead,
				behind,
				missingFixes,
				message: `Branch '${branch}' is fresh against ${mainRef}.`,
			};
		if (ahead > 0)
			return {
				status: "diverged",
				branch,
				mainRef,
				ahead,
				behind,
				missingFixes,
				message: `Branch '${branch}' diverged from ${mainRef}: ahead=${ahead}, behind=${behind}.`,
			};
		return {
			status: "stale",
			branch,
			mainRef,
			ahead,
			behind,
			missingFixes,
			message: `Branch '${branch}' is ${behind} commit(s) behind ${mainRef}.`,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			status: "unknown",
			mainRef,
			ahead: 0,
			behind: 0,
			missingFixes: [],
			message: "Branch freshness could not be determined.",
			error: message,
		};
	}
}

export function shouldBlockForBranchFreshness(freshness: BranchFreshness, policy: StaleBranchPolicy = "warn"): boolean {
	return policy === "block" && (freshness.status === "stale" || freshness.status === "diverged");
}
