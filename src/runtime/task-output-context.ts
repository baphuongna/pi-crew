import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_OUTPUT_CONTEXT } from "../config/defaults.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { atomicWriteFile } from "../state/atomic-write.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";
import { applyCompactPipeline } from "./compact-pipeline.ts";
import { ANSI_STRIP_STAGE, BLANK_COLLAPSE_STAGE, TruncationStage } from "./compact-stages/index.ts";
import { DEFAULT_PRUNE_CONFIG, type FileEditEvent, pruneToolOutputs, type ToolResultEntry } from "./tool-output-pruner.ts";

export interface DependencyContextEntry {
	taskId: string;
	role: string;
	status: string;
	resultSummary: string;
	resultPath?: string;
	/** Absolute path to the FULL (untruncated) result, teed when the inline
	 *  resultSummary was materially truncated (>TEE_THRESHOLD_MULTIPLIER). The
	 *  downstream worker can `read` this to recover the dropped middle. Mirrors
	 *  the sharedReads recovery path so dependency injection is no longer
	 *  circular (re-reading resultPath used to yield the same truncated text). */
	fullOutputPath?: string;
	structuredResults?: Record<string, unknown>;
	artifactsProduced?: string[];
	usage?: { inputTokens: number; outputTokens: number; durationMs: number };
	/** L4 total-budget: byte length of `resultSummary` (UTF-16 code units).
	 *  Populated by `collectDependencyOutputContext` so the trim step can sum
	 *  per-dep sizes without re-computing. Set to 0 when the dep is
	 *  downgraded to path-only. Optional for backward-compat with existing
	 *  test fixtures that build entry objects directly. */
	inlineBytes?: number;
	/** L4 priority sort key: derived from the upstream task's `finishedAt`
	 *  (ms epoch). More recent = higher priority in the trim. Undefined
	 *  when the dep task never finished (treated as 0). */
	recency?: number;
	/** L4 priority sort key: heuristic relevance in [0, 1]. Higher = more
	 *  relevant. Derived from the upstream task's `dependsOn` position in
	 *  the workflow (earlier deps = higher relevance because they were
	 *  explicitly listed first). Defaults to 0.5 (neutral) when unknown. */
	relevance?: number;
}

export interface DependencyOutputContext {
	dependencies: DependencyContextEntry[];
	/**
	 * Each shared artifact read, truncated for inline injection. When truncation
	 * is materially lossy (file size > 2× MAX_RESULT_INLINE_BYTES) the FULL
	 * content is also teed to `${artifactsRoot}/tee/${taskId}-${name}.full.txt`
	 * and the path is exposed via `fullOutputPath` so the downstream worker
	 * can `read` it back if it needs the dropped middle.
	 */
	sharedReads: Array<{
		name: string;
		path: string;
		content: string;
		fullOutputPath?: string;
	}>;
}

function containedExists(filePath: string, baseDir?: string): boolean {
	try {
		const safePath = baseDir ? resolveRealContainedPath(baseDir, filePath) : filePath;
		return fs.existsSync(safePath);
	} catch {
		return false;
	}
}

/**
 * L4 output-handling: single consistent threshold for all artifact reads.
 * Sized from real data (27 result artifacts: max 9226 bytes; 100% < 16KB).
 * 32KB gives 2x headroom over the largest observed real output while still
 * bounding memory. Larger than the old inconsistent per-call-site values
 * (24K/40K/80K) which truncated the same artifact differently depending on
 * which code path read it.
 *
 * Single source of truth: DEFAULT_OUTPUT_CONTEXT.maxResultInlineBytes
 * (Round 25 / L6 — moved from hardcoded constant to config/defaults.ts).
 */
export const MAX_RESULT_INLINE_BYTES = DEFAULT_OUTPUT_CONTEXT.maxResultInlineBytes;

/**
 * L4 total-budget: cap on the SUM of inline bytes across ALL dependencies
 * for a single downstream worker. 96KB is 3× the per-dep cap (3 × 32KB).
 * Sized so a worker with 3 large dep outputs (e.g. 3 × 32KB truncated)
 * stays below budget and the typical 1–2 dep case never hits the trim.
 * When the sum exceeds this, the trim step in
 * {@link collectDependencyOutputContext} downgrades the lowest-priority
 * deps to path-only (resultPath + fullOutputPath, no inline text) so the
 * downstream worker can `read` the full content on demand. The tee
 * write happens BEFORE the trim, so fullOutputPath is always available.
 *
 * Single source of truth: DEFAULT_OUTPUT_CONTEXT.maxTotalDepInlineBytes.
 */
export const MAX_TOTAL_DEP_INLINE_BYTES = DEFAULT_OUTPUT_CONTEXT.maxTotalDepInlineBytes;

/**
 * Tee-recovery multiplier (R2). A shared artifact is teed to disk — so the
 * downstream worker can `read` the dropped middle — when its size exceeds
 * this fraction of {@link MAX_RESULT_INLINE_BYTES}. Lowered from 2.0
 * (64 KB) to 1.25 (40 KB) so the 32–64 KB band, where the head+tail split
 * is already materially lossy for structured content, also gets a recovery
 * path instead of losing the middle forever.
 *
 * Single source of truth: DEFAULT_OUTPUT_CONTEXT.teeThresholdMultiplier.
 */
export const TEE_THRESHOLD_MULTIPLIER = DEFAULT_OUTPUT_CONTEXT.teeThresholdMultiplier;

/**
 * Read a file and return its content, truncating to a head+tail slice if it
 * exceeds {@link MAX_RESULT_INLINE_BYTES} characters. Multi-byte UTF-8
 * sequences are preserved by reading the full file as a UTF-8 string and
 * slicing by character count (not raw bytes).
 */
export interface TeeRecoveryOptions {
	/** Absolute path to write the full (non-truncated) content to. */
	fullOutputPath: string;
}

export interface ReadIfSmallTeeResult {
	/** Truncated content (or full content when no truncation). */
	content: string;
	/** Set only when tee was actually written (file size > 2× threshold + write succeeded). */
	fullOutputPath?: string;
}

/**
 * Sanitize a taskId / artifactName into a flat tee filename. Any character
 * outside [A-Za-z0-9._-] is replaced with underscore so the resulting path
 * is always single-segment and cannot escape the tee directory.
 */
function safeTeeName(taskId: string, artifactName: string): string {
	const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_");
	return `${safe(taskId)}-${safe(artifactName)}.full.txt`;
}

/**
 * Canonical tee path for a shared artifact read.
 *
 * Format: `${artifactsRoot}/tee/${taskId}-${artifactName}.full.txt`
 *
 * The downstream worker prompt includes this path so the worker can `read`
 * the full content when it needs the dropped middle.
 */
export function teePathForArtifact(artifactsRoot: string, taskId: string, artifactName: string): string {
	return path.join(artifactsRoot, "tee", safeTeeName(taskId, artifactName));
}

/**
 * Best-effort tee write. Returns true on success, false on any error (write
 * failures are silent — tee is enhancement, never a hard dependency). The
 * truncated inline content is still returned by the caller either way.
 */
function writeTeeFile(fullOutputPath: string, content: string): boolean {
	try {
		fs.mkdirSync(path.dirname(fullOutputPath), { recursive: true });
		atomicWriteFile(fullOutputPath, content);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read a file with optional tee-recovery (P1-A). Returns the truncated
 * content AND (when tee was actually written) the absolute path to the full
 * file. Returns undefined if the file cannot be read at all.
 *
 * Tee threshold: only when content.length > TEE_THRESHOLD_MULTIPLIER ×
 * MAX_RESULT_INLINE_BYTES (R2: 1.25× = 40 KB; previously 2× = 64 KB). Below
 * the tee threshold the head+tail split is mostly intact and the worker can
 * live with it; at/above the threshold the dropped middle is recoverable via
 * the teed full file. File content is read once and reused for both the
 * pipeline (truncation) and the tee write (full file).
 *
 * Truncation behavior is unchanged from the P0-A pipeline: ANSI strip +
 * blank collapse BEFORE truncation, important-line preservation (P0-B)
 * inside TruncationStage, marker wording matches the pre-P1-A `readIfSmall`
 * output exactly (L4 backward-compat).
 */
export function readIfSmallWithTee(
	filePath: string,
	opts: { baseDir?: string; tee?: TeeRecoveryOptions } = {},
): ReadIfSmallTeeResult | undefined {
	const maxChars = MAX_RESULT_INLINE_BYTES;
	try {
		const safePath = opts.baseDir ? resolveRealContainedPath(opts.baseDir, filePath) : filePath;
		const content = fs.readFileSync(safePath, "utf-8");
		if (content.length > maxChars) {
			let fullOutputPath: string | undefined;
			// Tee when truncation is materially lossy (>TEE_THRESHOLD_MULTIPLIER ×
			// threshold). R2: lowered from 2× (64 KB) to 1.25× (40 KB) so the
			// 32–64 KB band also gets a recovery path.
			if (opts.tee && content.length > maxChars * TEE_THRESHOLD_MULTIPLIER) {
				if (writeTeeFile(opts.tee.fullOutputPath, content)) {
					fullOutputPath = opts.tee.fullOutputPath;
				}
			}
			const result = applyCompactPipeline(content, [
				ANSI_STRIP_STAGE,
				BLANK_COLLAPSE_STAGE,
				new TruncationStage(maxChars, {
					preserveImportant: true,
					marker: {
						verb: "truncated",
						unit: "chars",
						headSeparator: "\n\n",
						tailSeparator: "\n",
					},
				}),
			]);
			return fullOutputPath ? { content: result.text, fullOutputPath } : { content: result.text };
		}
		return { content };
	} catch {
		return undefined;
	}
}

/**
 * Read a file and return its content, truncating to a head+tail slice if it
 * exceeds {@link MAX_RESULT_INLINE_BYTES} characters. Multi-byte UTF-8
 * sequences are preserved by reading the full file as a UTF-8 string and
 * slicing by character count (not raw bytes).
 *
 * Thin wrapper around {@link readIfSmallWithTee} for backward compatibility
 * — callers that do not need tee-recovery metadata get just the content
 * string. New tee-recovery call sites should use {@link readIfSmallWithTee}
 * directly so they can include the full output path in the worker prompt.
 */
export function readIfSmall(filePath: string, baseDir?: string): string | undefined {
	const result = readIfSmallWithTee(filePath, { baseDir });
	return result?.content;
}

function safeSharedName(name: string): string {
	const normalized = name.replaceAll("\\", "/").replace(/^\.\/+/, "");
	if (!normalized || normalized.split("/").some((segment) => segment === "..") || path.isAbsolute(normalized))
		throw new Error(`Invalid shared artifact name: ${name}`);
	return normalized;
}

export function sharedPath(manifest: TeamRunManifest, name: string): string {
	const sharedRoot = path.resolve(manifest.artifactsRoot, "shared");
	const resolved = path.resolve(sharedRoot, safeSharedName(name));
	const relative = path.relative(sharedRoot, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Invalid shared artifact name: ${name}`);
	return resolved;
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// Not valid JSON object — return undefined.
	}
	return undefined;
}

function listTaskArtifacts(manifest: TeamRunManifest, taskId: string): string[] | undefined {
	const produced = manifest.artifacts.filter((a) => a.producer === taskId);
	if (produced.length === 0) return undefined;
	return produced.map((a) => {
		const relative = path.relative(manifest.artifactsRoot, a.path);
		return relative.startsWith("..") ? a.path : relative;
	});
}

function aggregateUsage(task: TeamTaskState): DependencyContextEntry["usage"] {
	if (!task.usage) return undefined;
	const inputTokens = task.usage.input ?? 0;
	const outputTokens = task.usage.output ?? 0;
	const started = task.startedAt ? new Date(task.startedAt).getTime() : 0;
	const finished = task.finishedAt ? new Date(task.finishedAt).getTime() : 0;
	const durationMs = started && finished ? finished - started : 0;
	if (inputTokens === 0 && outputTokens === 0 && durationMs === 0) return undefined;
	return { inputTokens, outputTokens, durationMs };
}

/**
 * L4 total-budget trim. When the SUM of `inlineBytes` across all deps
 * exceeds {@link MAX_TOTAL_DEP_INLINE_BYTES}, downgrade the lowest-priority
 * deps to path-only (clear inline text, keep resultPath + fullOutputPath)
 * so the downstream worker can `read` the full content on demand.
 *
 * Priority order (highest kept first):
 *   1. status in {failed, needs-attention} (worker MUST see the failure)
 *   2. recency descending (newer outputs more relevant)
 *   3. relevance descending (workflow author-declared order)
 *   4. tie-breaker: original array index (stable sort)
 *
 * Algorithm: sort by priority (descending), then walk top-down, keeping
 * each dep until the running total would exceed the budget. The remaining
 * deps are returned with `resultSummary=""` and `inlineBytes=0`; the
 * `resultPath` and `fullOutputPath` fields are preserved so the worker
 * can `read` them. Stable: the original input order is preserved for
 * entries at the same priority level.
 *
 * Pure function — no I/O. Exported for unit testing.
 */
export function enforceDependencyInlineBudget(dependencies: DependencyContextEntry[]): DependencyContextEntry[] {
	if (dependencies.length === 0) return dependencies;
	const totalInlineBytes = dependencies.reduce((sum, dep) => sum + (dep.inlineBytes ?? 0), 0);
	if (totalInlineBytes <= MAX_TOTAL_DEP_INLINE_BYTES) return dependencies;
	// Build an index-keyed array so we can sort AND preserve the original
	// position (for stable output order). Each entry gets a numeric
	// priority score (higher = more important) and a stable tie-breaker.
	const indexed = dependencies.map((dep, originalIndex) => {
		const highPriority = dep.status === "failed" || dep.status === "needs-attention";
		// Score: (highPriority?1000:0) + (recency/1e10) + (relevance*10) - (index*0.001)
		// The 1000 base ensures high-priority wins even with no recency/relevance.
		// recency/1e10 keeps it in [0, 1] for ms timestamps up to 1e13 (~year 2286).
		// relevance*10 puts it in [0, 10].
		// index*0.001 keeps stable order within the same bucket.
		const score = (highPriority ? 1000 : 0) + (dep.recency ?? 0) / 1e10 + (dep.relevance ?? 0) * 10 - originalIndex * 0.001;
		return { dep, originalIndex, score };
	});
	const sorted = [...indexed].sort((a, b) => b.score - a.score);
	let used = 0;
	const keepSet = new Set<number>(); // originalIndex values to KEEP inline
	for (const item of sorted) {
		const next = used + (item.dep.inlineBytes ?? 0);
		if (next <= MAX_TOTAL_DEP_INLINE_BYTES) {
			used = next;
			keepSet.add(item.originalIndex);
		}
	}
	// Return entries in original order; downgrade ones NOT in keepSet.
	return dependencies.map((dep, originalIndex) => {
		if (keepSet.has(originalIndex)) return dep;
		return {
			...dep,
			resultSummary: "",
			structuredResults: undefined,
			inlineBytes: 0,
		};
	});
}

/**
 * Apply staleness-aware pruning to shared reads before they are injected
 * into a downstream worker's prompt. Converts shared reads to generic
 * {@link ToolResultEntry}s (toolName="read") and file edits from dependency
 * artifacts, then delegates to {@link pruneToolOutputs}. Superseded reads
 * (same base file re-read, or file edited by a later dependency) are replaced
 * with compact digest notices, reducing context bloat.
 *
 * OPT-IN: the default prune config protects recent results and only fires
 * when minimum-savings hysteresis is met, so small/unique reads pass through
 * unchanged.
 */
function pruneSharedReads(
	reads: Array<{ name: string; path: string; content: string }>,
	dependencies: DependencyContextEntry[],
	artifactsRoot: string,
): Array<{ name: string; path: string; content: string }> {
	if (reads.length === 0) return reads;
	// Convert shared reads to tool result entries (ordered oldest → newest
	// by position in the reads array — earlier entries are "older").
	const entries: ToolResultEntry[] = reads.map((read, index) => ({
		id: `shared-read-${index}`,
		toolName: "read",
		target: read.path,
		content: read.content,
	}));
	// Collect file edit events from dependency artifacts produced to shared/.
	// A dependency that wrote a shared file after an earlier read invalidates
	// that read (the content is now stale relative to the latest version).
	// Artifact entries from listTaskArtifacts() are already relative to
	// artifactsRoot (e.g. "shared/foo.md"), so resolve directly against
	// artifactsRoot — NOT against a "shared" subdirectory (which would
	// double-prefix to <artifactsRoot>/shared/shared/foo.md).
	const fileEdits: FileEditEvent[] = [];
	for (let depIndex = 0; depIndex < dependencies.length; depIndex++) {
		const dep = dependencies[depIndex]!;
		const produced = dep.artifactsProduced ?? [];
		for (const artifact of produced) {
			if (typeof artifact !== "string") continue;
			// Map artifact path (relative to artifactsRoot) to absolute and
			// check against read targets.
			fileEdits.push({
				target: path.resolve(artifactsRoot, artifact),
				index: reads.length + depIndex,
			});
		}
	}
	const pruned = pruneToolOutputs(entries, DEFAULT_PRUNE_CONFIG);
	if (pruned.prunedCount === 0) return reads;
	// Map pruned entries back to the shared-read shape.
	return pruned.results.map((entry, index) => ({
		...reads[index]!,
		content: entry.content,
	}));
}

export function collectDependencyOutputContext(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	task: TeamTaskState,
	step: WorkflowStep,
): DependencyOutputContext {
	const byStep = new Map(tasks.map((item) => [item.stepId, item]).filter((entry): entry is [string, TeamTaskState] => Boolean(entry[0])));
	const byId = new Map(tasks.map((item) => [item.id, item]));
	// L4 priority keys: build (a) the position of each dep in the workflow's
	// `dependsOn:` list (earlier = more relevant because the workflow author
	// declared it first), and (b) the finishedAt timestamp of each dep task
	// (used for recency sort in the trim step). Both are looked up against
	// `task.dependsOn` (the declared order) and `tasks` (finished timestamps).
	const declaredOrder = new Map<string, number>();
	task.dependsOn.forEach((depId, index) => declaredOrder.set(depId, index));
	const recencyByTaskId = new Map<string, number>();
	for (const item of tasks) {
		if (!item.finishedAt) continue;
		const ms = new Date(item.finishedAt).getTime();
		if (Number.isFinite(ms)) recencyByTaskId.set(item.id, ms);
	}
	const dependencies = task.dependsOn
		.map((dep) => byStep.get(dep) ?? byId.get(dep))
		.filter((item): item is TeamTaskState => Boolean(item))
		.map((item) => {
			const fullOutputPath = item.resultArtifact ? teePathForArtifact(manifest.artifactsRoot, task.id, item.id) : undefined;
			const teeResult = item.resultArtifact
				? readIfSmallWithTee(item.resultArtifact.path, {
						baseDir: manifest.artifactsRoot,
						...(fullOutputPath ? { tee: { fullOutputPath } } : {}),
					})
				: undefined;
			const resultText = teeResult?.content;
			const inlineBytes = resultText?.length ?? 0;
			// L4 priority keys: recency from the dep's finishedAt, relevance
			// from the dep's declared position in `task.dependsOn` (inverted
			// to [0,1]: position 0 → 1.0, position N → max(0, 1 - N*0.1)).
			const position = declaredOrder.get(item.id) ?? declaredOrder.get(item.stepId ?? "") ?? 0;
			const relevance = Math.max(0, 1 - position * 0.1);
			return {
				taskId: item.id,
				role: item.role,
				status: item.status,
				resultSummary: resultText ?? "",
				resultPath: item.resultArtifact?.path,
				...(teeResult?.fullOutputPath ? { fullOutputPath: teeResult.fullOutputPath } : {}),
				structuredResults: resultText ? tryParseJson(resultText) : undefined,
				artifactsProduced: listTaskArtifacts(manifest, item.id),
				usage: aggregateUsage(item),
				inlineBytes,
				recency: recencyByTaskId.get(item.id),
				relevance,
			};
		});
	// L4 total-budget trim: when the SUM of inline bytes across all deps
	// exceeds MAX_TOTAL_DEP_INLINE_BYTES, downgrade the lowest-priority
	// deps to path-only (clear inline text, keep resultPath +
	// fullOutputPath). The downstream worker can `read` the full content
	// on demand. Priority order (highest kept first):
	//   1. status in {failed, needs-attention} (worker MUST see the failure)
	//   2. recency descending (newer outputs more relevant)
	//   3. relevance descending (workflow author-declared order)
	// Tie-breakers within the same priority bucket are stable: the
	// declaration order in `task.dependsOn` (earlier = more relevant).
	const trimmedDependencies = enforceDependencyInlineBudget(dependencies);
	const rawSharedReads = (step.reads === false ? [] : (step.reads ?? []))
		.map((name) => {
			const filePath = sharedPath(manifest, name);
			// P1-A tee-recovery: when the shared artifact is large enough that the
			// 75/25 head+tail split is materially lossy (>2× MAX_RESULT_INLINE_BYTES),
			// tee the full content to ${artifactsRoot}/tee/${taskId}-${name}.full.txt
			// and expose the path so the downstream worker can `read` the full file
			// if it needs the dropped middle. The truncated content is still
			// included inline; tee is an enhancement, not a hard dependency. Tee
			// write is best-effort (writeTeeFile swallows I/O errors and the result
			// simply omits fullOutputPath in that case).
			const teePath = teePathForArtifact(manifest.artifactsRoot, task.id, name);
			const teeResult = readIfSmallWithTee(filePath, {
				baseDir: path.resolve(manifest.artifactsRoot, "shared"),
				tee: { fullOutputPath: teePath },
			});
			if (teeResult === undefined) return { name, path: filePath, content: "" };
			const entry: {
				name: string;
				path: string;
				content: string;
				fullOutputPath?: string;
			} = {
				name,
				path: filePath,
				content: teeResult.content,
			};
			if (teeResult.fullOutputPath) entry.fullOutputPath = teeResult.fullOutputPath;
			return entry;
		})
		.filter((item) => item.content.trim().length > 0);
	// Apply staleness-aware pruning to shared reads: drops superseded reads
	// (same file re-read with different selectors) and replaces stale large
	// outputs with compact digest notices before injecting into the worker
	// prompt. OPT-IN: default config protects recent results.
	const sharedReads = pruneSharedReads(rawSharedReads, trimmedDependencies, manifest.artifactsRoot);
	return { dependencies: trimmedDependencies, sharedReads };
}

export function renderDependencyOutputContext(context: DependencyOutputContext): string {
	const parts: string[] = [];
	if (context.dependencies.length) {
		parts.push("# Dependency Outputs", "");
		for (const dep of context.dependencies) {
			parts.push(
				`## ${dep.taskId} (${dep.role})`,
				`Status: ${dep.status}`,
				dep.resultPath ? `Result artifact: ${dep.resultPath}` : "",
				"",
				dep.resultSummary?.trim() || "(no result output)",
				"",
			);
			// P1-A dependency tee-recovery hint: when the dependency's result was
			// materially truncated (>1.25× MAX_RESULT_INLINE_BYTES) the full RAW
			// content was teed to fullOutputPath. Mirrors the sharedReads hint so the
			// downstream worker can read the dropped middle instead of re-deriving.
			if (dep.fullOutputPath) parts.push(`Full output (if you need the missing middle): ${dep.fullOutputPath}`, "");
			if (dep.structuredResults) parts.push("Structured results:", JSON.stringify(dep.structuredResults, null, 2), "");
			if (dep.artifactsProduced?.length) parts.push(`Artifacts produced: ${dep.artifactsProduced.join(", ")}`, "");
			if (dep.usage)
				parts.push(
					`Usage: ${dep.usage.inputTokens} input tokens, ${dep.usage.outputTokens} output tokens, ${dep.usage.durationMs}ms`,
					"",
				);
		}
	}
	if (context.sharedReads.length) {
		parts.push("# Shared Run Context Reads", "");
		for (const read of context.sharedReads) {
			parts.push(`## shared/${read.name}`, `Path: ${read.path}`);
			// P1-A tee-recovery hint: when the file was materially truncated
			// (>2× threshold) the full content was teed to fullOutputPath so the
			// worker can read the dropped middle if needed. The path is inside
			// artifactsRoot/tee/ and goes through the normal permission gate.
			if (read.fullOutputPath) parts.push(`Full output (if you need the missing middle): ${read.fullOutputPath}`);
			parts.push("", read.content.trim(), "");
		}
	}
	return parts.join("\n").trim();
}

export function writeTaskSharedOutput(manifest: TeamRunManifest, step: WorkflowStep, task: TeamTaskState): ArtifactDescriptor | undefined {
	if (step.output === false) return undefined;
	const name = safeSharedName(step.output || `${task.id}.md`);
	const source = task.resultArtifact ? readIfSmall(task.resultArtifact.path, manifest.artifactsRoot) : undefined;
	if (!source) return undefined;
	return writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `shared/${name}`,
		producer: task.id,
		content: source.endsWith("\n") ? source : `${source}\n`,
	});
}

export function writeTaskInputsArtifact(
	manifest: TeamRunManifest,
	task: TeamTaskState,
	context: DependencyOutputContext,
): ArtifactDescriptor {
	return writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.inputs.json`,
		producer: task.id,
		content: `${JSON.stringify(context, null, 2)}\n`,
	});
}

export function aggregateTaskOutputs(tasks: TeamTaskState[], manifest?: TeamRunManifest): string {
	return tasks
		.map((task, index) => {
			const body = task.resultArtifact ? readIfSmall(task.resultArtifact.path, manifest?.artifactsRoot) : undefined;
			const hasBody = Boolean(body?.trim());
			const expectedMissing = task.resultArtifact && !containedExists(task.resultArtifact.path, manifest?.artifactsRoot);
			const status =
				task.status === "skipped"
					? "SKIPPED"
					: task.status === "failed"
						? `FAILED${task.exitCode !== undefined ? ` (exit code ${task.exitCode ?? "null"})` : ""}${task.error ? `: ${task.error}` : ""}`
						: expectedMissing
							? `EMPTY OUTPUT (expected result artifact missing: ${task.resultArtifact?.path})`
							: !hasBody
								? "EMPTY OUTPUT (no textual response returned)"
								: task.status.toUpperCase();
			return [
				`=== Task ${index + 1}: ${task.id} (${task.agent}) ===`,
				`Status: ${status}`,
				task.role ? `Role: ${task.role}` : "",
				task.resultArtifact?.path ? `Result artifact: ${task.resultArtifact.path}` : "",
				task.logArtifact?.path ? `Log artifact: ${task.logArtifact.path}` : "",
				task.transcriptArtifact?.path ? `Transcript: ${task.transcriptArtifact.path}` : "",
				task.usage ? `Usage: ${JSON.stringify(task.usage)}` : "",
				"",
				hasBody ? body!.trim() : status,
			]
				.filter(Boolean)
				.join("\n");
		})
		.join("\n\n");
}
