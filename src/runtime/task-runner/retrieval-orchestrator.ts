/**
 * M3: Iterative file-retrieval orchestrator.
 *
 * Pattern: workers progressively discover relevant context files
 * (e.g. "which source file handles X?") using ripgrep-driven keyword
 * search + the existing context-retrieval.ts scoring/convergence
 * helpers. Max 3 cycles, fall back to in-memory heuristic when
 * ripgrep is not available (e.g. minimal Windows CI runners).
 *
 * Signal flow:
 *   renderTaskPrompt (in prompt-builder.ts)
 *     → runRetrievalCycle(task, goal, cwd)
 *       → cycle 1: rg --files, then score each file
 *       → cycle 2: refine query, rg --json for keyword filter
 *       → cycle 3: same; if !shouldContinue, stop early
 *     → returns top-N files (5..10)
 *   renderTaskPrompt injects "Suggested files to read (top-N by
 *   retrieval score):" section before final prompt assembly.
 *
 * Production code path — not @experimental. Fallback is mandatory so
 * the prompt is never blocked by a missing ripgrep binary.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RelevanceEvaluation } from "./context-retrieval.ts";
import { hasConverged, scoreRelevance, shouldContinue } from "./context-retrieval.ts";

/** Max retrieval cycles per prompt render. Matches context-retrieval.MAX_CYCLES. */
export const MAX_CYCLES = 3;

/** Hard cap on suggested files injected into the worker prompt. */
export const MAX_SUGGESTED_FILES = 10;

/** Minimum files suggested when retrieval returns anything. */
export const MIN_SUGGESTED_FILES = 5;

/** Stopwords dropped during keyword tokenization (lowercase comparison). */
const STOPWORDS: ReadonlySet<string> = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "for", "on", "is", "are", "be", "with"]);

/** File extensions considered relevant for retrieval. */
const RELEVANT_EXTS: ReadonlySet<string> = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".md",
	".markdown",
	".json",
	".yaml",
	".yml",
]);

/** Result of a single runRetrievalCycle call. */
export interface RetrievalResult {
	files: Array<{ path: string; score: number; reason: string }>;
	cycles: number;
	converged: boolean;
	usedFallback: boolean;
}

interface RipgrepAvailable {
	available: boolean;
	version?: string;
}

let cachedRgCheck: RipgrepAvailable | undefined;

/**
 * Detect ripgrep availability once per process. Uses `rg --version` and
 * catches ENOENT or non-zero exit. Cached so the cost (one spawn) is
 * paid only on the first retrieval cycle.
 */
export async function detectRipgrep(): Promise<RipgrepAvailable> {
	if (cachedRgCheck !== undefined) return cachedRgCheck;
	return await new Promise<RipgrepAvailable>((resolve) => {
		let settled = false;
		try {
			const child = spawn("rg", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			child.stdout?.on("data", (chunk) => {
				stdout += chunk.toString("utf-8");
			});
			child.on("error", () => {
				if (settled) return;
				settled = true;
				cachedRgCheck = { available: false };
				resolve(cachedRgCheck);
			});
			child.on("close", (code) => {
				if (settled) return;
				settled = true;
				if (code === 0) {
					cachedRgCheck = { available: true, version: stdout.split("\n")[0] ?? undefined };
				} else {
					cachedRgCheck = { available: false };
				}
				resolve(cachedRgCheck);
			});
		} catch {
			if (settled) return;
			settled = true;
			cachedRgCheck = { available: false };
			resolve(cachedRgCheck);
		}
	});
}

/** @internal Test-only: reset the ripgrep detection cache. */
export function __test_resetRipgrepCache(): void {
	cachedRgCheck = undefined;
}

/**
 * Tokenize a task + goal string into lowercase keywords, dropping
 * stopwords. Single-letter tokens and pure-punctuation tokens are
 * dropped. Output is deduped, original-order preserved.
 */
export function tokenizeQuery(task: string, goal: string): string[] {
	const combined = `${task}\n${goal}`.toLowerCase();
	const tokens = combined
		.split(/[^a-z0-9_-]+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
	return [...new Set(tokens)];
}

/** Reason template for a discovery hit. Exported for tests. */
export function reasonFor(file: string, keywords: string[]): string {
	const lower = file.toLowerCase();
	const hits = keywords.filter((k) => lower.includes(k));
	if (hits.length === 0) return `matched by relevance score (no direct keyword hit in path)`;
	return `keyword match: ${hits.join(", ")}`;
}

/** Overrides for runRipgrep — exported for the regression test (R11-1). */
export interface RipgrepRunOptions {
	/** Binary to execute (default "rg"). Test-only override. */
	command?: string;
	/** Kill the child with SIGKILL after this many ms (default 30s). */
	timeoutMs?: number;
	/** Reject (and SIGKILL the child) when accumulated stdout exceeds this many bytes (default 10MB). */
	maxStdoutBytes?: number;
}

// R11-1 (MEDIUM, §ROUND 11 security hardening): `rg --files` on a very large
// repo previously accumulated unbounded stdout (OOM risk) and had no timeout.
const DEFAULT_RG_TIMEOUT_MS = 30_000;
const DEFAULT_RG_MAX_STDOUT_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Run ripgrep with the given args, returning stdout as a string.
 * Throws on ENOENT / non-zero exit. Caller handles fallback.
 *
 * Hardening (R11-1): enforces a timeout (SIGKILL on expiry) and a stdout cap
 * (kill + reject when exceeded). Exit code 1 keeps its "no matches" semantics.
 */
export function runRipgrep(args: string[], cwd: string, opts: RipgrepRunOptions = {}): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const command = opts.command ?? "rg";
		const timeoutMs = opts.timeoutMs ?? DEFAULT_RG_TIMEOUT_MS;
		const maxStdoutBytes = opts.maxStdoutBytes ?? DEFAULT_RG_MAX_STDOUT_BYTES;
		let settled = false;
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let timer: NodeJS.Timeout | undefined;
		// Settle-once guard (mirrors verification-gates.ts SIGKILL pattern): the
		// timeout kill, stdout-cap kill, 'error' and 'close' all race — only the
		// first one wins and the timer is cleared so it can't fire on a done child.
		const settleOnce = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			fn();
		};
		try {
			const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
			timer = setTimeout(() => {
				settleOnce(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already reaped */
					}
					reject(new Error(`rg timed out after ${timeoutMs}ms`));
				});
			}, timeoutMs);
			timer.unref();
			child.stdout?.on("data", (chunk) => {
				if (settled) return;
				const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
				stdoutBytes += buf.length;
				if (stdoutBytes > maxStdoutBytes) {
					settleOnce(() => {
						try {
							child.kill("SIGKILL");
						} catch {
							/* already reaped */
						}
						reject(new Error(`rg stdout exceeded ${maxStdoutBytes} bytes`));
					});
					return;
				}
				stdout += buf.toString("utf-8");
			});
			child.stderr?.on("data", (chunk) => {
				if (settled) return;
				stderr += chunk.toString("utf-8");
			});
			child.on("error", (err) => {
				settleOnce(() => reject(err));
			});
			child.on("close", (code) => {
				settleOnce(() => {
					// rg exit code 1 = "no matches" (NOT an error). Any other
					// non-zero exit IS an error.
					if (code === 0 || code === 1) {
						resolve(stdout);
					} else {
						reject(new Error(`rg exited ${code}: ${stderr.slice(0, 200)}`));
					}
				});
			});
		} catch (e) {
			settleOnce(() => reject(e));
		}
	});
}

/**
 * In-memory fallback: walk cwd with readdir({recursive:true}), filter
 * to relevant extensions, score by filename keyword match. Used when
 * ripgrep is not installed. Mirrors the rg --files path closely so
 * downstream scoring behaves the same.
 */
async function walkFilesFallback(cwd: string, keywords: string[]): Promise<Array<{ path: string; score: number; reason: string }>> {
	const out: Array<{ path: string; score: number; reason: string }> = [];
	const lowerCwd = cwd.toLowerCase();
	async function walk(dir: string): Promise<void> {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!entry.isFile()) continue;
			const ext = path.extname(entry.name).toLowerCase();
			if (!RELEVANT_EXTS.has(ext)) continue;
			// scoreRelevance expects file content, but for the fallback we
			// only have the filename. Use the filename as a proxy (the
			// existing scoreRelevance handles short content gracefully —
			// path match contributes 0.3, content match 0.05 × log2(N)).
			const content = "";
			const score = scoreRelevance(full, content, keywords);
			if (score > 0) {
				out.push({ path: path.relative(lowerCwd, full), score, reason: reasonFor(full, keywords) });
			}
		}
	}
	await walk(cwd);
	return out;
}

/**
 * Iterate up to MAX_CYCLES times. Each cycle: discover files, score
 * them, check convergence. Stop early on convergence or when
 * shouldContinue returns false.
 */
export async function runRetrievalCycle(task: string, goal: string, cwd: string): Promise<RetrievalResult> {
	const keywords = tokenizeQuery(task, goal);
	if (keywords.length === 0) {
		return { files: [], cycles: 0, converged: true, usedFallback: false };
	}
	const rg = await detectRipgrep();
	const useRg = rg.available;
	let usedFallback = !useRg;
	const evaluations: RelevanceEvaluation[] = [];
	let cycle = 0;
	let converged = false;
	for (; cycle < MAX_CYCLES; cycle++) {
		let discovered: string[] = [];
		try {
			if (useRg) {
				// Cycle 0: enumerate all relevant files via `rg --files`.
				// Later cycles: filter by keywords via `rg --files | rg pattern`.
				// We use the simpler `rg --files` + filter strategy because
				// `rg --json` parsing adds complexity for marginal gain.
				// `rg --files` respects .gitignore by default; we add an
				// explicit -g '!node_modules' and -g '!.git' to be safe on
				// repos that don't ignore them.
				const stdout = await runRipgrep(["--files", "-g", "!node_modules", "-g", "!.git", cwd], cwd);
				discovered = stdout
					.split("\n")
					.map((p) => p.trim())
					.filter((p) => p && RELEVANT_EXTS.has(path.extname(p).toLowerCase()))
					.map((p) => path.relative(cwd, p));
			} else {
				discovered = (await walkFilesFallback(cwd, keywords)).map((f) => f.path);
			}
		} catch {
			// rg errored mid-run — switch to fallback for this cycle.
			usedFallback = true;
			discovered = (await walkFilesFallback(cwd, keywords)).map((f) => f.path);
		}
		// Score each discovered file. Path-only scoring (no file read) so
		// we don't slow down prompt building for hundreds of files.
		const seenInThisCycle = new Set<string>();
		for (const relPath of discovered) {
			if (seenInThisCycle.has(relPath)) continue;
			seenInThisCycle.add(relPath);
			const absPath = path.isAbsolute(relPath) ? relPath : path.join(cwd, relPath);
			const score = scoreRelevance(absPath, "", keywords);
			if (score > 0) {
				evaluations.push({
					path: absPath,
					relevance: score,
					reason: reasonFor(absPath, keywords),
					missingContext: [],
				});
			}
		}
		converged = hasConverged(evaluations);
		if (converged) break;
		if (!shouldContinue(evaluations, cycle)) break;
	}
	// Sort by score desc, take top N (5..10).
	evaluations.sort((a, b) => b.relevance - a.relevance);
	const cap = Math.min(MAX_SUGGESTED_FILES, Math.max(MIN_SUGGESTED_FILES, evaluations.length));
	const top = evaluations.slice(0, cap).map((e) => ({
		path: path.isAbsolute(e.path) ? path.relative(cwd, e.path) : e.path,
		score: e.relevance,
		reason: e.reason,
	}));
	return { files: top, cycles: cycle, converged, usedFallback };
}

/**
 * Render the "Suggested files to read" section for injection into the
 * worker prompt. Returns an empty string when retrieval returned no
 * files. Format is a markdown bullet list (one line per file) prefixed
 * with a heading so the worker can `grep` for it.
 */
export function renderSuggestedFilesSection(result: RetrievalResult): string {
	if (result.files.length === 0) return "";
	const lines: string[] = [
		`# Suggested files to read (top-${result.files.length} by retrieval score)`,
		`Retrieval ran for ${result.cycles} cycle(s)${result.usedFallback ? " (in-memory fallback, rg unavailable)" : ""}${result.converged ? " and converged" : ""}.`,
		"",
	];
	for (const file of result.files) {
		lines.push(`- ${file.path} — ${file.reason} (score ${file.score.toFixed(2)})`);
	}
	return lines.join("\n");
}
