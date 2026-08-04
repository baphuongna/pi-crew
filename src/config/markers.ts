import * as fs from "node:fs";

/**
 * Marker delimiters used to bracket pi-crew guidance sections inside
 * markdown files (e.g. AGENTS.md).  Using HTML comments keeps them
 * invisible when rendered.
 */
export const MARKER_START = "<!-- PI-CREW:GUIDANCE:START -->";
export const MARKER_END = "<!-- PI-CREW:GUIDANCE:END -->";

/** A single guidance section to inject between markers. */
export interface GuidanceBlock {
	/**
	 * Unique identifier for this guidance section (e.g. "team-tool-usage").
	 * Must match `/^[a-zA-Z0-9_-]+$/`.
	 */
	id: string;
	/**
	 * Markdown content to inject.
	 *
	 * **WARNING:** Content must be from trusted sources only. Guidance blocks
	 * are injected into markdown files that AI agents read. Untrusted content
	 * could contain prompt-injection payloads that manipulate agent behavior.
	 */
	content: string;
	/** Higher priority = appears first. Default 0. */
	priority?: number;
}

/** Regex for valid guidance block IDs. */
const VALID_BLOCK_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Sanitize guidance content to reduce prompt-injection risk.
 *
 * Strips HTML comment patterns and instruction-like directives that could
 * be used for prompt injection. This is a best-effort defense — content
 * should still come from trusted sources.
 */
/**
 * Best-effort content sanitizer for guidance blocks.
 *
 * WARNING: This is NOT a security boundary. Content should come from trusted
 * sources only. This sanitizer handles common injection patterns but cannot
 * prevent all bypasses (e.g., base64, ROT13, semantic tricks).
 */
export function sanitizeGuidanceContent(content: string): string {
	let sanitized = content;
	// Strip zero-width and invisible Unicode characters (potential bypass vectors)
	sanitized = sanitized.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "");
	// Strip HTML comments (potential instruction hiding)
	sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, "");
	// Strip lines that look like system directives (e.g. "SYSTEM:", "INSTRUCTION:", "IGNORE PREVIOUS")
	sanitized = sanitized.replace(/^\s*(?:SYSTEM|INSTRUCTION|IGNORE\s+PREVIOUS|OVERRIDE)\s*:.*$/gim, "");
	// Collapse multiple blank lines left by removals
	sanitized = sanitized.replace(/\n{3,}/g, "\n\n");
	return sanitized.trim();
}

/** Result of an injection or removal operation. */
export interface InjectionResult {
	path: string;
	modified: boolean;
	/** Block IDs that were added or updated. */
	added: string[];
	/** Block IDs that were removed (content was empty). */
	removed: string[];
}

/**
 * Render a sorted list of guidance blocks into the markdown content that
 * sits between the START and END markers.
 *
 * Each block is wrapped in its own id-tagged comment so we can later
 * parse individual blocks back out.
 */
function renderBlocks(blocks: GuidanceBlock[]): string {
	const sorted = [...blocks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	return sorted.map((block) => `<!-- PI-CREW:BLOCK:${block.id} -->\n${block.content}\n<!-- PI-CREW:/BLOCK:${block.id} -->`).join("\n\n");
}

/**
 * Parse the inner marker content and return the set of block IDs present.
 */
export function extractGuidanceIds(content: string): string[] {
	const ids: string[] = [];
	const regex = /<!-- PI-CREW:BLOCK:([^\s>]+) -->/g;
	let match: RegExpExecArray | null = regex.exec(content);
	while (match !== null) {
		const captured = match[1];
		if (captured !== undefined) ids.push(captured);
		match = regex.exec(content);
	}
	return ids;
}

/**
 * Parse existing blocks from marker content into a map of id → GuidanceBlock.
 */
function parseExistingBlocks(inner: string): Map<string, GuidanceBlock> {
	const map = new Map<string, GuidanceBlock>();
	const regex = /<!-- PI-CREW:BLOCK:([^\s>]+) -->\n([\s\S]*?)<!-- PI-CREW:\/BLOCK:\1 -->/g;
	let match: RegExpExecArray | null = regex.exec(inner);
	while (match !== null) {
		const id = match[1];
		const blockContent = match[2];
		if (id !== undefined && blockContent !== undefined) {
			map.set(id, { id, content: blockContent.replace(/\n$/, "") });
		}
		match = regex.exec(inner);
	}
	return map;
}

/**
 * Build the full marker section string.
 */
function buildMarkerSection(blocks: GuidanceBlock[]): string {
	const body = renderBlocks(blocks);
	return `\n${MARKER_START}\n${body}\n${MARKER_END}\n`;
}

/**
 * Inject (or update) pi-crew guidance blocks inside `filePath`.
 *
 * - If the file does not exist, it is created with only the marker section.
 * - If the file exists but has no markers, the marker section is appended.
 * - If the file already has markers, existing blocks are merged with the
 *   supplied `blocks`.  Blocks with matching IDs are overwritten; blocks
 *   not present in `blocks` are preserved unless their content is empty
 *   (handled via the `removeGuidance` helper instead).
 * - Blocks whose `content` is an empty string are treated as "remove" —
 *   they are excluded from the merged output.
 * - Content outside the markers is preserved exactly.
 */
export function injectGuidance(filePath: string, blocks: GuidanceBlock[]): InjectionResult {
	// Validate block IDs before processing (M1)
	for (const block of blocks) {
		if (!VALID_BLOCK_ID.test(block.id)) {
			throw new Error(`Invalid guidance block ID '${block.id}': must match /^[a-zA-Z0-9_-]+$/.`);
		}
	}

	// NEW-P4: TOCTOU fix — readFileSync + ENOENT catch instead of existsSync+read
	// (1 syscall, no race). Only ENOENT falls back to ""; any other read error
	// (e.g. EACCES) propagates as before.
	let original = "";
	try {
		original = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const startIdx = original.indexOf(MARKER_START);
	const endIdx = original.indexOf(MARKER_END);

	let existingBlocks = new Map<string, GuidanceBlock>();
	let before = original;
	let after = "";

	if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
		// Extract content around markers
		before = original.slice(0, startIdx);
		after = original.slice(endIdx + MARKER_END.length);

		const inner = original.slice(startIdx + MARKER_START.length, endIdx);
		existingBlocks = parseExistingBlocks(inner);
	} else {
		// No markers: whole file is "before"
		before = original;
		after = "";
	}

	// Merge: apply new blocks on top of existing
	const added: string[] = [];
	const removed: string[] = [];

	for (const block of blocks) {
		if (block.content === "") {
			// Empty content signals removal
			if (existingBlocks.has(block.id)) {
				existingBlocks.delete(block.id);
				removed.push(block.id);
			}
		} else {
			existingBlocks.set(block.id, {
				...block,
				content: sanitizeGuidanceContent(block.content),
			});
			added.push(block.id);
		}
	}

	const merged = [...existingBlocks.values()];

	// Nothing to write if there are no blocks and no markers existed
	const hadMarkers = startIdx !== -1;
	if (merged.length === 0 && !hadMarkers) {
		return { path: filePath, modified: false, added: [], removed: [] };
	}

	// If all blocks removed and markers existed, remove the whole section
	if (merged.length === 0 && hadMarkers) {
		const newContent = trimTrailingNewlines(before) + after;
		if (newContent === original) {
			return { path: filePath, modified: false, added: [], removed };
		}
		fs.writeFileSync(filePath, newContent, "utf-8");
		return { path: filePath, modified: true, added: [], removed };
	}

	const section = buildMarkerSection(merged);
	const newContent = trimTrailingNewlines(before) + section + trimLeadingNewlines(after);

	if (newContent === original) {
		return { path: filePath, modified: false, added: [], removed };
	}

	// Ensure parent directory exists
	const dir = filePath.substring(0, Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")));
	if (dir && !fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	fs.writeFileSync(filePath, newContent, "utf-8");
	return { path: filePath, modified: true, added, removed };
}

/**
 * Remove specific guidance blocks (by ID) or the entire marker section
 * from `filePath`.
 *
 * - If `ids` is `undefined`, the entire marker section is removed.
 * - If `ids` is an array, only the listed block IDs are removed.
 * - Content outside markers is preserved exactly.
 */
export function removeGuidance(filePath: string, ids?: string[]): InjectionResult {
	if (!fs.existsSync(filePath)) {
		return { path: filePath, modified: false, added: [], removed: [] };
	}

	const original = fs.readFileSync(filePath, "utf-8");
	const startIdx = original.indexOf(MARKER_START);
	const endIdx = original.indexOf(MARKER_END);

	if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
		return { path: filePath, modified: false, added: [], removed: [] };
	}

	const before = original.slice(0, startIdx);
	const after = original.slice(endIdx + MARKER_END.length);
	const inner = original.slice(startIdx + MARKER_START.length, endIdx);

	if (ids === undefined) {
		// Remove entire marker section
		const allIds = extractGuidanceIds(inner);
		const newContent = trimTrailingNewlines(before) + after;
		if (newContent === original) {
			return { path: filePath, modified: false, added: [], removed: [] };
		}
		fs.writeFileSync(filePath, newContent, "utf-8");
		return { path: filePath, modified: true, added: [], removed: allIds };
	}

	// Remove specific block IDs
	const existingBlocks = parseExistingBlocks(inner);
	const removed: string[] = [];
	for (const id of ids) {
		if (existingBlocks.delete(id)) {
			removed.push(id);
		}
	}

	if (removed.length === 0) {
		return { path: filePath, modified: false, added: [], removed: [] };
	}

	const merged = [...existingBlocks.values()];

	if (merged.length === 0) {
		const newContent = trimTrailingNewlines(before) + after;
		fs.writeFileSync(filePath, newContent, "utf-8");
		return { path: filePath, modified: true, added: [], removed };
	}

	const section = buildMarkerSection(merged);
	const newContent = trimTrailingNewlines(before) + section + trimLeadingNewlines(after);
	fs.writeFileSync(filePath, newContent, "utf-8");
	return { path: filePath, modified: true, added: [], removed };
}

/**
 * Generate standard pi-crew guidance blocks for injection into project
 * files (e.g. AGENTS.md).
 *
 * @param version — current pi-crew package version for version-aware updates
 */
export function standardGuidanceBlocks(version: string): GuidanceBlock[] {
	return [
		{
			id: "pi-crew-overview",
			priority: 10,
			content: [
				"## pi-crew",
				"",
				`> Managed by **pi-crew v${version}** — do not edit this section manually.`,
				"",
				"pi-crew is a Pi extension for coordinated AI agent teams, workflows,",
				"worktrees, and async task orchestration.",
			].join("\n"),
		},
		{
			id: "pi-crew-commands",
			priority: 5,
			content: [
				"### Quick Commands",
				"",
				"| Command | Description |",
				"|---|---|",
				"| `team action='init'` | Initialize pi-crew for this project |",
				"| `team action='run'` | Start a team run |",
				"| `team action='status'` | Check run status |",
				"| `team action='list'` | List available teams/agents/workflows |",
				"| `team action='recommend'` | Get team/workflow recommendations |",
			].join("\n"),
		},
	];
}

/** Remove trailing newlines from a string, ensuring at most one trailing newline. */
function trimTrailingNewlines(s: string): string {
	return s.replace(/\n+$/, "");
}

/** Remove leading newlines from a string. */
function trimLeadingNewlines(s: string): string {
	return s.replace(/^\n+/, "");
}
