#!/usr/bin/env node
/**
 * US-031 (docs/specs/US-031.md) — post a pi-crew run report as a PR comment.
 *
 * Create-or-update ONE comment per PR (idempotent, not spam): finds an
 * existing comment carrying the marker `<!-- pi-crew-report -->` and PATCHes
 * it; otherwise POSTs a new one. Uses GITHUB_TOKEN + the REST API via Node
 * 22 global fetch — zero runtime dependencies (stays out of the dist bundle;
 * see the spec's DP-02 note).
 *
 * Usage (from a GitHub Actions pull_request workflow):
 *   GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo \
 *   node scripts/gh-pr-comment.mjs --pr 123 --body-file run-export.md
 *
 * Failure policy: a comment failure does NOT fail the run job by default
 * (warning + exit 0); pass --hard-fail to make it fail the job.
 *
 * Token hygiene (spec AC-3): the token is used ONLY in the Authorization
 * header — never in a URL, and never printed. Error paths redact any
 * Bearer-looking string defensively.
 */
import process from "node:process";

export const COMMENT_MARKER = "<!-- pi-crew-report -->";

/** Strip anything Bearer-looking from a message before it can reach stdout. */
export function redactToken(message) {
	return String(message).replace(/(Bearer\s+)[^\s"']+/gi, "$1***redacted***").replace(/(gh[pousr]_[A-Za-z0-9]{20,})/g, "***redacted***");
}

/** Parse CLI args into a spec object (pure, exported for tests). */
export function parseArgs(argv) {
	const spec = { pr: undefined, bodyFile: undefined, marker: COMMENT_MARKER, hardFail: false, apiBase: "https://api.github.com" };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--pr") spec.pr = Number(argv[++i]);
		else if (arg === "--body-file") spec.bodyFile = argv[++i];
		else if (arg === "--marker") spec.marker = argv[++i];
		else if (arg === "--hard-fail") spec.hardFail = true;
		else if (arg === "--api-base") spec.apiBase = argv[++i];
		else return { ...spec, error: `unknown argument '${arg}'` };
	}
	if (!Number.isInteger(spec.pr) || spec.pr <= 0) return { ...spec, error: "--pr <number> is required" };
	if (!spec.bodyFile) return { ...spec, error: "--body-file <path> is required" };
	return spec;
}

/**
 * Create-or-update the marker comment. All I/O is injected (fetch, readBody)
 * so tests run with zero network. Returns { action: "created"|"updated", id }.
 * Never throws — returns { error } instead (caller decides exit policy).
 */
export async function postPrComment({ spec, token, repository, fetchImpl = fetch, readBody }) {
	const read = readBody ?? ((file) => import("node:fs").then((fs) => fs.readFileSync(file, "utf-8")));
	let markdown;
	try {
		markdown = await read(spec.bodyFile);
	} catch (error) {
		return { error: `cannot read body file: ${error.message}` };
	}
	const body = `${spec.marker}\n${markdown}`;
	const headers = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"content-type": "application/json",
		// Token lives ONLY here — never in a URL, never logged.
		Authorization: `Bearer ${token}`,
	};
	const base = spec.apiBase.replace(/\/+$/, "");
	const listUrl = `${base}/repos/${repository}/issues/${spec.pr}/comments`;
	let existing;
	try {
		const response = await fetchImpl(listUrl, { headers, redirect: "manual" });
		if (!response.ok) return { error: `list comments: HTTP ${response.status}` };
		const comments = (await response.json()) ?? [];
		existing = comments.find((comment) => typeof comment?.body === "string" && comment.body.includes(spec.marker));
	} catch (error) {
		return { error: `list comments: ${redactToken(error.message)}` };
	}
	try {
		if (existing) {
			const response = await fetchImpl(`${listUrl}/${existing.id}`, {
				method: "PATCH",
				headers,
				body: JSON.stringify({ body }),
				redirect: "manual",
			});
			if (!response.ok) return { error: `update comment: HTTP ${response.status}` };
			return { action: "updated", id: existing.id };
		}
		const response = await fetchImpl(listUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({ body }),
			redirect: "manual",
		});
		if (!response.ok) return { error: `create comment: HTTP ${response.status}` };
		const created = await response.json();
		return { action: "created", id: created?.id };
	} catch (error) {
		return { error: redactToken(error.message) };
	}
}

const isEntryPoint = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isEntryPoint) {
	const spec = parseArgs(process.argv.slice(2));
	if (spec.error) {
		console.error(`[gh-pr-comment] ${spec.error}`);
		console.error("Usage: node scripts/gh-pr-comment.mjs --pr <n> --body-file <path> [--marker <m>] [--hard-fail] [--api-base <url>]");
		process.exit(2);
	}
	const token = process.env.GITHUB_TOKEN;
	const repository = process.env.GITHUB_REPOSITORY;
	const prFromEnv = Number(process.env.PR_NUMBER);
	const effective = Number.isInteger(spec.pr) && spec.pr > 0 ? spec : { ...spec, pr: prFromEnv };
	if (!token || !repository || !Number.isInteger(effective.pr) || effective.pr <= 0) {
		console.error("[gh-pr-comment] missing GITHUB_TOKEN, GITHUB_REPOSITORY or PR number — skipping (exit 0).");
		process.exit(0);
	}
	const outcome = await postPrComment({ spec: effective, token, repository });
	if (outcome.error) {
		console.error(`[gh-pr-comment] FAILED: ${outcome.error}`);
		if (effective.hardFail) process.exit(1);
		console.error("[gh-pr-comment] non-fatal mode: job continues (pass --hard-fail to fail the job).");
		process.exit(0);
	}
	console.log(`[gh-pr-comment] ${outcome.action} comment ${outcome.id} on ${repository}#${effective.pr}`);
	process.exit(0);
}
