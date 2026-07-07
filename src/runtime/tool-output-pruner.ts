/**
 * Staleness-aware tool output pruning.
 *
 * Identifies tool results that have been superseded by a later result for the
 * same target (same file read again, same search re-run) or invalidated by a
 * later successful edit/write to a covered file, and replaces the stale
 * content with a compact digest notice. Protect-window and minimum-savings
 * hysteresis ensure recent results are preserved and pruning only fires when
 * the savings justify it.
 *
 * Ported and adapted from gajae-code's compaction/pruning.ts to pi-crew's
 * data shapes. Pi-crew delegates conversation management to child Pi
 * processes, so this module operates on a generic {@link ToolResultEntry}
 * sequence rather than SessionEntry[]. The primary integration point is
 * task-output-context.ts (dependency output context injected into worker
 * prompts), but the module is designed to be reusable for any in-process
 * tool-result sequence.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single tool result in a sequence (oldest → newest).
 * Adapted to pi-crew's shapes — does not depend on gajae-code's SessionEntry.
 */
export interface ToolResultEntry {
	/** Stable identifier for deduplication and correlation. */
	id: string;
	/** Tool name: "read", "bash", "grep", "search", "edit", "write", etc. */
	toolName: string;
	/**
	 * Target identity: file path for read/edit/write, search pattern for
	 * grep/search, or undefined for tools without a natural target key.
	 */
	target?: string;
	/** The tool result content text. */
	content: string;
	/** Whether the tool result represents an error. */
	isError?: boolean;
}

/** A file mutation event (edit/write) that can invalidate earlier reads. */
export interface FileEditEvent {
	/** The file path that was mutated. */
	target: string;
	/**
	 * Sequence index of this edit relative to tool results. A read at index
	 * `i` is stale if an edit at index `j > i` touches the same file.
	 */
	index: number;
}

export interface PruneConfig {
	/** Keep the most recent tool output tokens intact (protect window). */
	protectTokens: number;
	/** Only prune if total savings meets this threshold (hysteresis). */
	minimumSavings: number;
	/** Tool names that should never be pruned. */
	protectedTools: string[];
	/**
	 * Tools in `protectedTools` whose protection is waived once the result is
	 * superseded (a later result for the same target, or a later successful
	 * edit/write to the covered file). The most recent result per target is
	 * never considered superseded. Optional; defaults to none.
	 */
	staleOverridableTools?: string[];
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
	protectTokens: 40_000,
	minimumSavings: 20_000,
	protectedTools: ["read"],
	staleOverridableTools: ["read"],
};

export interface PruneResult {
	/** Number of entries pruned. */
	prunedCount: number;
	/** Estimated tokens saved. */
	tokensSaved: number;
	/** The pruned result entries (same length as input, content replaced for pruned). */
	results: ToolResultEntry[];
	/** IDs of entries that were pruned. */
	prunedIds: string[];
}

// ---------------------------------------------------------------------------
// Token estimation (rough char/4 heuristic, matching gajae-code)
// ---------------------------------------------------------------------------

import { countTokens } from "../utils/token-counter.ts";

function estimateTokens(text: string): number {
	return countTokens(text);
}

// ---------------------------------------------------------------------------
// Digest notice generation
// ---------------------------------------------------------------------------

const DIGEST_NOTICE_TOKEN_CAP_MULTIPLIER = 1.25;

function firstErrorLine(text: string): string | undefined {
	return text
		.split(/\r?\n/)
		.find((line) => /error|failed|exception|panic/i.test(line))
		?.trim();
}

function truncateField(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 1) return "…";
	return `${value.slice(0, maxLength - 1)}…`;
}

/**
 * Generate a compact digest of a tool result for the digest notice.
 * Supports bash (exit code + tail line), grep/search (match/file counts),
 * and falls back to undefined for tools without a known digest format.
 */
export function resultDigest(toolName: string, content: string, isError?: boolean): string | undefined {
	const name = toolName.toLowerCase();
	const text = content ?? "";
	if (name === "bash") {
		const exitCode = isError ? 1 : 0;
		const tail = text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
		const error = firstErrorLine(text);
		return [`exit=${exitCode}`, tail ? `tail=${tail}` : undefined, error ? `error=${error}` : undefined]
			.filter((part): part is string => part !== undefined)
			.join("; ");
	}
	if (name === "search" || name === "grep") {
		const match = text.match(/(\d+)\s+matches?/i) ?? text.match(/totalMatches["']?:\s*(\d+)/i);
		const files = text.match(/(\d+)\s+files?/i) ?? text.match(/filesWithMatches["']?:\s*(\d+)/i);
		const error = firstErrorLine(text);
		return (
			[match ? `matches=${match[1]}` : undefined, files ? `files=${files[1]}` : undefined, error ? `error=${error}` : undefined]
				.filter((part): part is string => part !== undefined)
				.join("; ") || "search digest unavailable"
		);
	}
	return undefined;
}

function createPrunedNotice(tokens: number, entry: ToolResultEntry): string {
	const generic = `[Output pruned — ${tokens} tokens]`;
	const digest = resultDigest(entry.toolName, entry.content, entry.isError);
	if (!digest) return generic;
	const genericTokens = countTokens(generic);
	const maxTokens = Math.max(genericTokens, Math.floor(genericTokens * DIGEST_NOTICE_TOKEN_CAP_MULTIPLIER));
	const prefix = `[Output pruned — ${tokens} tokens; `;
	const suffix = "]";
	const maxChars = Math.max(0, maxTokens * 4 - prefix.length - suffix.length);
	return `${prefix}${truncateField(digest, maxChars)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Target key resolution
// ---------------------------------------------------------------------------

/**
 * Trailing read selectors (`:50`, `:50-200`, `:50+150`, `:5-16,960-973`,
 * `:raw`, `:conflicts`), possibly stacked. Stripped to resolve the
 * underlying file for edit invalidation.
 */
const READ_SELECTOR_SUFFIX = /:(?:raw|conflicts|\d+(?:[-+]\d+)?(?:,\d+(?:[-+]\d+)?)*)$/;

/** Base file path of a read target with any line/mode selectors stripped. */
function readBasePath(filePath: string): string {
	let base = filePath;
	while (READ_SELECTOR_SUFFIX.test(base)) {
		base = base.replace(READ_SELECTOR_SUFFIX, "");
	}
	return base;
}

/**
 * Stable identity for "the same logical lookup": same tool re-targeting the
 * same subject. A later result with the same key supersedes earlier ones.
 */
function toolTargetKey(entry: ToolResultEntry): string | undefined {
	if (!entry.target || entry.target.length === 0) return undefined;
	return JSON.stringify([entry.toolName, entry.target]);
}

// ---------------------------------------------------------------------------
// Staleness index
// ---------------------------------------------------------------------------

export interface StalenessIndex {
	/** Indices of tool results superseded by a later same-target result or edit. */
	staleIndices: Set<number>;
}

/**
 * Build a staleness index over a sequence of tool results (oldest → newest):
 * - a tool result is stale when a later non-error result shares its target key;
 * - a `read` result is stale when a later edit event touches its file.
 * The most recent result per target is never stale.
 *
 * @param toolResults  Ordered tool result entries (oldest first).
 * @param fileEdits    Optional file mutation events with sequence indices.
 */
export function buildStalenessIndex(toolResults: ToolResultEntry[], fileEdits: FileEditEvent[] = []): StalenessIndex {
	// Map target key → last result index that has it.
	const lastResultIndexByKey = new Map<string, number>();
	for (let i = 0; i < toolResults.length; i++) {
		const entry = toolResults[i]!;
		if (entry.isError) continue;
		const key = toolTargetKey(entry);
		if (key !== undefined) lastResultIndexByKey.set(key, i);
	}

	// Map file path → last edit index.
	const lastEditIndexByPath = new Map<string, number>();
	for (const edit of fileEdits) {
		lastEditIndexByPath.set(edit.target, edit.index);
	}

	const staleIndices = new Set<number>();
	for (let i = 0; i < toolResults.length; i++) {
		const entry = toolResults[i]!;
		// Check superseded by same-target re-read.
		const key = toolTargetKey(entry);
		if (key !== undefined) {
			const lastIndex = lastResultIndexByKey.get(key);
			if (lastIndex !== undefined && lastIndex > i) {
				staleIndices.add(i);
				continue;
			}
		}
		// Check invalidated by later file edit (read-specific).
		if (entry.toolName.toLowerCase() === "read" && entry.target) {
			const basePath = readBasePath(entry.target);
			const editIndex = lastEditIndexByPath.get(basePath);
			if (editIndex !== undefined && editIndex > i) {
				staleIndices.add(i);
			}
		}
	}

	return { staleIndices };
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Prune stale tool outputs from a sequence, replacing superseded content with
 * compact digest notices. Protect-window, protected-tools immunity, and
 * minimum-savings hysteresis are all respected.
 *
 * OPT-IN by default: {@link DEFAULT_PRUNE_CONFIG} protects recent results via
 * a generous `protectTokens` window. Only results outside the window AND not
 * protected AND stale (or old enough) are pruned.
 *
 * @param results  Ordered tool result entries (oldest first).
 * @param config   Prune configuration. Defaults to {@link DEFAULT_PRUNE_CONFIG}.
 */
export function pruneToolOutputs(results: ToolResultEntry[], config: PruneConfig = DEFAULT_PRUNE_CONFIG): PruneResult {
	const { staleIndices } = buildStalenessIndex(results);
	const staleOverridable = new Set(config.staleOverridableTools ?? []);

	let accumulatedTokens = 0;
	let tokensSaved = 0;
	let prunedCount = 0;

	interface Candidate {
		index: number;
		entry: ToolResultEntry;
		tokens: number;
		notice: string;
		savings: number;
	}
	const candidates: Candidate[] = [];
	const prunedIds: string[] = [];

	// Iterate newest → oldest to accumulate the protect window from the tail.
	for (let i = results.length - 1; i >= 0; i--) {
		const entry = results[i]!;
		const tokens = estimateTokens(entry.content);
		const isStale = staleIndices.has(i);

		// Staleness waives protected-tool immunity for overridable tools
		// (e.g. a superseded `read`); the most recent result per target is
		// never stale, so the latest read of each file stays protected.
		const isProtected = config.protectedTools.includes(entry.toolName) && !(isStale && staleOverridable.has(entry.toolName));

		// Stale results are prunable even inside the recency protect window —
		// they are superseded, so recency no longer implies relevance. They
		// still count toward window accounting so non-stale protection is
		// unchanged.
		const insideProtectWindow = accumulatedTokens < config.protectTokens;
		if ((insideProtectWindow && !isStale) || isProtected) {
			accumulatedTokens += tokens;
			continue;
		}

		const notice = createPrunedNotice(tokens, entry);
		candidates.push({
			index: i,
			entry,
			tokens,
			notice,
			savings: Math.max(0, tokens - countTokens(notice)),
		});
		accumulatedTokens += tokens;
	}

	for (const candidate of candidates) {
		tokensSaved += candidate.savings;
	}

	// Hysteresis: only prune if savings meet the threshold.
	if (tokensSaved < config.minimumSavings || candidates.length === 0) {
		return { prunedCount: 0, tokensSaved: 0, results, prunedIds: [] };
	}

	const prunedResults = [...results];
	for (const candidate of candidates) {
		prunedResults[candidate.index] = {
			...candidate.entry,
			content: candidate.notice,
		};
		prunedIds.push(candidate.entry.id);
		prunedCount++;
	}

	return { prunedCount, tokensSaved, results: prunedResults, prunedIds };
}
