/**
 * gh-protocol.ts — GitHub URL protocol for issue:// and pr:// URLs.
 *
 * Forked from oh-my-pi packages/coding-agent/src/internal-urls/issue-pr-protocol.ts
 * with adaptations for pi-crew's needs (no SQLite cache, no session registry).
 *
 * URL shapes:
 * - `issue://` — list recent issues (repo derived from cwd)
 * - `issue://owner/repo` — list issues for repo
 * - `issue://123` — single issue (repo from cwd)
 * - `issue://owner/repo/123` — fully qualified
 * - `issue://owner/repo/123?comments=0` — suppress comments
 *
 * - `pr://` — list recent PRs (repo derived from cwd)
 * - `pr://owner/repo` — list PRs for repo
 * - `pr://456` — single PR (repo from cwd)
 * - `pr://owner/repo/456` — fully qualified
 * - `pr://owner/repo/456/diff` — list changed files
 * - `pr://owner/repo/456/diff/all` — full unified diff
 *
 * Requirements: GitHub CLI (`gh`) installed and authenticated.
 * Repo resolution: git remote get-url origin from cwd.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/** Resolve the default repo from `git remote get-url origin` in cwd. */
export function resolveDefaultRepo(cwd: string): string {
	try {
		// FIX (Round 14): Use execFileSync (args as array) instead of execSync
		// (single string) so the command is not interpreted by a shell.
		const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
			cwd,
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		// git@github.com:owner/repo.git or https://github.com/owner/repo.git
		const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^/.]+)/);
		if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;

		const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
		if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;

		throw new Error(`Could not parse git remote URL: ${remoteUrl}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to resolve default repo from git: ${msg}`);
	}
}

interface ParsedListOptions {
	kind: "list";
	repo: string;
	state: "open" | "closed" | "all";
	limit: number;
	author?: string;
	label?: string;
}

interface ParsedSingle {
	kind: "single";
	repo?: string;
	number: number;
	comments: boolean;
}

interface ParsedPrDiff {
	kind: "pr-diff";
	repo?: string;
	number: number;
	mode: "list" | "all" | "slice";
	index?: number;
}

type Parsed = ParsedListOptions | ParsedSingle | ParsedPrDiff;

const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 100;

function parsePositiveInt(value: string): number | undefined {
	const n = Number.parseInt(value, 10);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Parse search params for list options. */
function parseListOptions(url: URL, scheme: "issue" | "pr", repo: string): ParsedListOptions {
	const allowedStates = scheme === "pr" ? ["open", "closed", "merged", "all"] : ["open", "closed", "all"];
	const stateRaw = url.searchParams.get("state");
	const state = (
		stateRaw && (allowedStates as string[]).includes(stateRaw) ? stateRaw : "open"
	) as ParsedListOptions["state"];

	let limit = LIST_LIMIT_DEFAULT;
	const limitRaw = url.searchParams.get("limit");
	if (limitRaw !== null) {
		const parsed = parsePositiveInt(limitRaw);
		if (parsed !== undefined) limit = Math.min(parsed, LIST_LIMIT_MAX);
	}

	return {
		kind: "list",
		repo,
		state,
		limit,
		author: url.searchParams.get("author") ?? undefined,
		label: url.searchParams.get("label") ?? undefined,
	};
}

/**
 * Parse an issue:// or pr:// URL.
 *
 * Supported shapes:
 * - `scheme://` — list default repo
 * - `scheme://<number>` — single item, default repo
 * - `scheme://owner/repo` — list specific repo
 * - `scheme://owner/repo/<number>` — single item, specific repo
 * - `scheme://owner/repo/<number>/diff[/all|<N>]` — PR diff (pr:// only)
 */
export function parseGitHubUrl(raw: string, scheme: "issue" | "pr"): Parsed {
	let url: URL;
	try {
		// Treat as a URL-like path; prepend scheme if missing
		const withScheme = raw.startsWith(`${scheme}://`) ? raw : `${scheme}://${raw}`;
		url = new URL(withScheme);
	} catch {
		throw new Error(
			`Invalid ${scheme}:// URL '${raw}'. Expected ${scheme}://, ${scheme}://<number>, ${scheme}://<owner>/<repo>, or ${scheme}://<owner>/<repo>/<number>.`,
		);
	}

	const host = url.hostname;
	const rawPathname = url.pathname;
	// Strip leading slash
	const stripped = rawPathname.startsWith("/") ? rawPathname.slice(1) : rawPathname;
	const pathParts: string[] = stripped !== "" ? stripped.split("/").filter(Boolean) : [];

	// Empty → list default repo
	if (!host && pathParts.length === 0) {
		return { kind: "list", repo: "", state: "open", limit: LIST_LIMIT_DEFAULT };
	}

	// If host looks like a number, treat as single-item shorthand
	if (parsePositiveInt(host) !== undefined) {
		// pathParts.length === 0 → scheme://N (single item, default repo)
		// pathParts[0] === "diff" → scheme://N/diff[/sub] (PR diff, default repo)
		if (pathParts.length === 0) {
			const commentsParam = url.searchParams.get("comments");
			const comments = !(commentsParam === "0" || (commentsParam?.toLowerCase() === "false"));
			return { kind: "single", repo: undefined, number: parsePositiveInt(host)!, comments };
		}
		if (pathParts[0] === "diff") {
			if (scheme !== "pr") throw new Error(`Invalid ${scheme}:// URL. Diff is only available for pr:// URLs.`);
			const number = parsePositiveInt(host)!;
			const diffParts = pathParts;
			if (diffParts.length === 1) {
				return { kind: "pr-diff", repo: undefined, number, mode: "list" };
			}
			if (diffParts[1] === "all") {
				return { kind: "pr-diff", repo: undefined, number, mode: "all" };
			}
			const idx = parsePositiveInt(diffParts[1]);
			if (idx === undefined) {
				throw new Error(`Invalid pr:// diff sub-path '${diffParts[1]}'. Use 'all' or a 1-indexed file number.`);
			}
			return { kind: "pr-diff", repo: undefined, number, mode: "slice", index: idx };
		}
		// Numeric host with non-diff path — invalid number
		throw new Error(`Invalid ${scheme}:// number: ${host}`);
	}

	// Non-numeric host with 0 path parts
	if (pathParts.length === 0 && host) {
		// If host looks like a domain name (contains dots), it's a partial repo ref
		// (scheme://owner.missing-repo). Otherwise, treat as invalid number.
		if (!host.includes(".")) {
			throw new Error(`Invalid ${scheme}:// number: ${host}`);
		}
		throw new Error(
			`Invalid ${scheme}:// URL. Expected ${scheme}://<owner>/<repo> or ${scheme}://<owner>/<repo>/<number>.`,
		);
	}

	// scheme://owner/repo → list
	if (pathParts.length === 1 && host) {
		const repo = `${host}/${pathParts[0]}`;
		return parseListOptions(url, scheme, repo);
	}

	// scheme://owner/repo/N[/diff[/sub]]]
	if (pathParts.length >= 2 && host) {
		const repo = `${host}/${pathParts[0]}`;
		const numberPart = pathParts[1];

		const num = parsePositiveInt(numberPart);
		if (num === undefined) {
			throw new Error(`Invalid ${scheme}:// number: ${numberPart ?? "(missing)"}`);
		}

		// PR diff path
		const diffParts = pathParts.slice(2);
		if (diffParts.length > 0) {
			if (scheme === "issue") {
				throw new Error(
					`Invalid issue:// URL. Issue views do not have a diff; use pr://<owner>/<repo>/<n>/diff for pull requests.`,
				);
			}
			if (diffParts[0] !== "diff" || diffParts.length > 2) {
				throw new Error(
					`Invalid pr:// URL. Expected pr://<n>/diff, pr://<n>/diff/all, or pr://<n>/diff/<i>.`,
				);
			}
			if (diffParts.length === 1) {
				return { kind: "pr-diff", repo, number: num, mode: "list" };
			}
			const sub = diffParts[1] ?? "";
			if (sub === "all") {
				return { kind: "pr-diff", repo, number: num, mode: "all" };
			}
			const idx = parsePositiveInt(sub);
			if (idx === undefined) {
				throw new Error(`Invalid pr:// diff sub-path '${sub}'. Use 'all' or a 1-indexed file number.`);
			}
			return { kind: "pr-diff", repo, number: num, mode: "slice", index: idx };
		}

		const commentsParam2 = url.searchParams.get("comments");
		const comments = !(commentsParam2 === "0" || (commentsParam2?.toLowerCase() === "false"));
		return { kind: "single", repo, number: num, comments };
	}

	// scheme://N (numeric in path) — single, default repo
	if (pathParts.length === 1 && parsePositiveInt(pathParts[0]) !== undefined) {
		const commentsParam3 = url.searchParams.get("comments");
		const comments = !(commentsParam3 === "0" || (commentsParam3?.toLowerCase() === "false"));
		return { kind: "single", repo: undefined, number: parsePositiveInt(pathParts[0])!, comments };
	}

	// Fallback: unrecognized shape
	throw new Error(
		`Invalid ${scheme}:// URL. Expected ${scheme}://, ${scheme}://<number>, ${scheme}://<owner>/<repo>, or ${scheme}://<owner>/<repo>/<number>.`,
	);
}

interface GitHubListItem {
	number?: number;
	title?: string;
	state?: string;
	stateReason?: string | null;
	author?: { login?: string } | null;
	labels?: Array<{ name?: string }>;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	isDraft?: boolean;
	baseRefName?: string;
	headRefName?: string;
}

function formatListItem(scheme: "issue" | "pr", repo: string, item: GitHubListItem): string {
	const num = item.number ?? "?";
	const title = item.title ?? "(no title)";
	const state = item.state?.toLowerCase() ?? "?";
	const author = item.author?.login ?? "?";
	const updated = item.updatedAt ?? item.createdAt ?? "";
	const draftSuffix = scheme === "pr" && item.isDraft ? " [draft]" : "";
	const labels = (item.labels ?? [])
		.map(l => l.name)
		.filter(Boolean)
		.join(", ");
	const labelSuffix = labels ? `  labels: ${labels}` : "";
	const itemUrl = num === "?" ? `${scheme}://${repo}` : `${scheme}://${repo}/${num}`;
	return `- [${state}${draftSuffix}] #${num}  @${author}  ${updated}\n    ${title}${labelSuffix}\n    ${itemUrl}`;
}

function runGh(cwd: string, args: string[]): string {
	try {
		return execFileSync("gh", args, {
			cwd,
			encoding: "utf-8",
			timeout: 30_000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`gh command failed: ${msg}`);
	}
}

function ghJson<T>(cwd: string, args: string[]): T {
	const jsonOut = execFileSync("gh", args, {
		cwd, encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"],
	});
	try {
		return JSON.parse(jsonOut) as T;
	} catch {
		throw new Error(`gh JSON parse failed for: ${args.join(" ")}\nOutput: ${jsonOut.slice(0, 200)}`);
	}
}

interface GhResult<T> {
	content: string;
	notes: string[];
	data?: T;
}

/**
 * Execute a parsed GitHub URL and return the result.
 *
 * @param parsed Parsed URL result from `parseGitHubUrl`
 * @param scheme "issue" or "pr"
 * @param cwd Working directory for repo resolution
 */
export function resolveGitHubUrl(parsed: Parsed, scheme: "issue" | "pr", cwd: string): GhResult<unknown> {
	// Resolve repo for list operations
	if (parsed.kind === "list") {
		const repo = parsed.repo || resolveDefaultRepo(cwd);
		const fields = scheme === "issue"
			? ["number", "title", "state", "stateReason", "author", "labels", "createdAt", "updatedAt", "url"]
			: ["number", "title", "state", "isDraft", "author", "baseRefName", "headRefName", "labels", "createdAt", "updatedAt", "url"];

		const args = [
			scheme, "list",
			"--repo", repo,
			"--state", parsed.state,
			"--limit", String(parsed.limit),
			"--json", fields.join(","),
		];
		if (parsed.author) args.push("--author", parsed.author);
		if (parsed.label) args.push("--label", parsed.label);

		let items: GitHubListItem[] = [];
		try {
			items = ghJson<GitHubListItem[]>(cwd, args);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`${scheme}:// listing failed: ${msg}`);
		}

		const header = `# ${scheme === "issue" ? "Issues" : "Pull Requests"} in ${repo} (${parsed.state}, up to ${parsed.limit})`;
		const body = items.length === 0
			? "_No matches._"
			: items.map(item => formatListItem(scheme, repo, item)).join("\n\n");
		const footer = `\n\n---\nRead a specific item: \`${scheme}://${repo}/<N>\` (or \`${scheme}://<N>\` for the current repo).`;
		return {
			content: `${header}\n\n${body}${footer}`,
			notes: [`Live listing for ${repo} via gh`],
			data: items,
		};
	}

	// Resolve repo for single items
	let repo = parsed.repo;
	if (!repo) {
		try {
			repo = resolveDefaultRepo(cwd);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`${scheme}://${(parsed as ParsedSingle).number} could not resolve a default repo from cwd '${cwd}': ${msg}\nUse ${scheme}://<owner>/<repo>/${(parsed as ParsedSingle).number} instead.`,
			);
		}
	}

	// PR diff
	if (parsed.kind === "pr-diff") {
		if (parsed.mode === "all") {
			try {
				const diff = execFileSync("gh", ["pr", "diff", String(parsed.number), "--repo", repo], {
					cwd,
					encoding: "utf-8",
					timeout: 30_000,
					stdio: ["pipe", "pipe", "pipe"],
				});
				return {
					content: diff,
					notes: [`Full diff for ${scheme}://${repo}/${parsed.number}`],
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`pr://${parsed.number}/diff failed: ${msg}`);
			}
		}

		if (parsed.mode === "list") {
			try {
				const raw = execFileSync(
					"gh", ["pr", "view", String(parsed.number), "--repo", repo, "--json", "files", "--jq", ".files[] | \"(.filename) +(.additions) -(.deletions) [(.status)]\""],
					{ cwd, encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] },
				);
				const fileLines = raw.split("\n").filter(Boolean);
				const header = `# Pull Request Diff: ${repo}#${parsed.number} (${fileLines.length} file${fileLines.length === 1 ? "" : "s"})`;
				const body = fileLines.length === 0
					? "_No file changes._"
					: fileLines.map((line, i) => `${i + 1}. ${line}\n   pr://${repo}/${parsed.number}/diff/${i + 1}`).join("\n\n");
				const footer = `\n\n---\nRead all: \`pr://${repo}/${parsed.number}/diff/all\`. Each file is also available as \`pr://${repo}/${parsed.number}/diff/<i>\`.`;
				return {
					content: `${header}\n\n${body}${footer}`,
					notes: [`File listing for pr://${repo}/${parsed.number}`],
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`pr://${parsed.number}/diff failed: ${msg}`);
			}
		}

		if (parsed.mode === "slice" && parsed.index !== undefined) {
			try {
				const raw = execFileSync(
					"gh", ["pr", "view", String(parsed.number), "--repo", repo, "--json", "files", "--jq", ".files[] | \"(.filename) +(.additions) -(.deletions) [(.status)]\""],
					{ cwd, encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] },
				);
				const fileLines = raw.split("\n").filter(Boolean);
				const targetIdx = parsed.index - 1;
				if (targetIdx < 0 || targetIdx >= fileLines.length) {
					throw new Error(`File index ${parsed.index} out of range (1..${fileLines.length}).`);
				}
				const fullDiff = execFileSync("gh", ["pr", "diff", String(parsed.number), "--repo", repo], {
					cwd, encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"],
				});
				// Extract the diff for the target file by splitting on "diff --git" headers
				const diffBlocks = fullDiff.split(/(?=diff --git )/);
				const fileName = fileLines[targetIdx]!.split(" ")[0];
				const matched = diffBlocks.find((block) => block.includes(fileName!));
				return {
					content: matched || `File ${fileName} not found in diff.`,
					notes: [`Diff for file ${parsed.index}/${fileLines.length}: ${fileName} in pr://${repo}/${parsed.number}`],
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`pr://${parsed.number}/diff/${parsed.index} failed: ${msg}`);
			}
		}
	}

	// Single issue/PR
	const single = parsed as ParsedSingle;
	try {
		let content: string;
		if (scheme === "issue") {
			const args = ["issue", "view", String(single.number), "--repo", repo];
			if (!single.comments) args.push("--comments", "false");
			content = execFileSync("gh", args, {
				cwd,
				encoding: "utf-8",
				timeout: 30_000,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} else {
			const args = ["pr", "view", String(single.number), "--repo", repo];
			if (!single.comments) args.push("--comments", "false");
			content = execFileSync("gh", args, {
				cwd,
				encoding: "utf-8",
				timeout: 30_000,
				stdio: ["pipe", "pipe", "pipe"],
			});
			// Append diff URL hint
			content += `\n\n---\nDiff: pr://${repo}/${single.number}/diff\nFiles: pr://${repo}/${single.number}/diff/list`;
		}
		return {
			content,
			notes: [`${scheme}://${repo}/${single.number} via gh`],
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`${scheme}://${repo}/${single.number} failed: ${msg}`);
	}
}

/**
 * Resolve a raw `issue://` or `pr://` URL string.
 * Convenience wrapper combining parse + resolve.
 */
export function resolveGitHubProtocol(raw: string, scheme: "issue" | "pr", cwd: string): GhResult<unknown> {
	const parsed = parseGitHubUrl(raw, scheme);
	return resolveGitHubUrl(parsed, scheme, cwd);
}