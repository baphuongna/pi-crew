/**
 * conflict-detect.ts — Detect and resolve git merge conflicts.
 *
 * Forked from oh-my-pi packages/coding-agent/src/tools/conflict-detect.ts
 * with adaptations for pi-crew's needs.
 *
 * Workflow:
 *   1. `read` collects lines from disk as usual.
 *   2. `scanConflictLines` inspects those lines (no extra I/O) for
 *      well-formed `<<<<<<<` / `=======` / `>>>>>>>` blocks.
 *   3. Each completed block is registered with the `ConflictHistory`,
 *      which assigns it a stable id.
 *   4. The read output is returned verbatim with a short footer naming
 *      every conflict id surfaced, and the agent calls
 *      `write({ path: "conflict://<id>", content })` to splice the
 *      recorded region with the chosen content.
 *
 * Marker shape is strict: only column-0 markers of the exact prefix length
 * followed by either EOL or a single space + label. Lines that
 * merely start with `<` or `=` never match.
 */
import * as fs from "node:fs";

const OURS_PREFIX = "<<<<<<<";
const BASE_PREFIX = "|||||||";
const SEPARATOR = "=======";
const THEIRS_PREFIX = ">>>>>>>";

export interface ConflictBlock {
	/** 1-indexed line of the `<<<<<<<` marker. */
	startLine: number;
	/** 1-indexed line of the `=======` separator. */
	separatorLine: number;
	/** 1-indexed line of `>>>>>>>` marker. */
	endLine: number;
	/** 1-indexed line of `|||||||` base marker (diff3 only). */
	baseLine?: number;
	oursLabel?: string;
	baseLabel?: string;
	theirsLabel?: string;
	oursLines: string[];
	baseLines?: string[];
	theirsLines: string[];
}

/**
 * Scan an already-collected array of file lines for completed conflict
 * blocks. `firstLineNumber` is the 1-indexed line number of `lines[0]`
 * (so a windowed read starting at line 200 passes `firstLineNumber: 200`).
 *
 * Only fully-closed blocks (opener + separator + closer all present in
 * the window) are returned. A block whose closer is past the window's
 * tail is dropped — the agent will see the open marker and can widen
 * the read.
 */
export function scanConflictLines(lines: readonly string[], firstLineNumber: number): ConflictBlock[] {
	const blocks: ConflictBlock[] = [];
	let phase: "idle" | "ours" | "base" | "theirs" = "idle";
	let partial: {
		startLine: number;
		oursLabel?: string;
		oursLines: string[];
		baseLine?: number;
		baseLabel?: string;
		baseLines?: string[];
		separatorLine?: number;
		theirsLines?: string[];
	} | null = null;

	for (let i = 0; i < lines.length; i++) {
		// Strip a trailing CR so CRLF files (Windows) match markers/separators.
		// The raw line (with CR) is never needed here; content is collected from
		// the normalized line so storage stays consistent across LF/CRLF inputs.
		const rawLine = lines[i];
		const line = rawLine.charCodeAt(rawLine.length - 1) === 13 /* \r */ ? rawLine.slice(0, -1) : rawLine;
		const ln = firstLineNumber + i;

		const oursLabel = matchMarker(line, OURS_PREFIX);
		if (oursLabel !== null) {
			partial = {
				startLine: ln,
				oursLabel: oursLabel || undefined,
				oursLines: [],
			};
			phase = "ours";
			continue;
		}

		if (phase === "idle" || partial === null) continue;

		const baseLabel = matchMarker(line, BASE_PREFIX);
		if (baseLabel !== null) {
			if (phase !== "ours") {
				partial = null;
				phase = "idle";
				continue;
			}
			partial.baseLine = ln;
			partial.baseLabel = baseLabel || undefined;
			partial.baseLines = [];
			phase = "base";
			continue;
		}

		if (line === SEPARATOR) {
			if (phase === "ours" || phase === "base") {
				partial.separatorLine = ln;
				partial.theirsLines = [];
				phase = "theirs";
			} else if (phase === "theirs" && partial?.theirsLines) {
				// ======= inside theirs content — treat as content, not marker
				partial.theirsLines.push(line);
			} else {
				partial = null;
				phase = "idle";
			}
			continue;
		}

		const theirsLabel = matchMarker(line, THEIRS_PREFIX);
		if (theirsLabel !== null) {
			if (phase === "theirs" && partial.separatorLine !== undefined && partial.theirsLines) {
				blocks.push({
					startLine: partial.startLine,
					separatorLine: partial.separatorLine,
					endLine: ln,
					baseLine: partial.baseLine,
					oursLabel: partial.oursLabel,
					baseLabel: partial.baseLabel,
					theirsLabel: theirsLabel || undefined,
					oursLines: partial.oursLines,
					baseLines: partial.baseLines,
					theirsLines: partial.theirsLines,
				});
			}
			partial = null;
			phase = "idle";
			continue;
		}

		if (phase === "ours") partial.oursLines.push(line);
		else if (phase === "base" && partial.baseLines) partial.baseLines.push(line);
		else if (phase === "theirs" && partial.theirsLines) partial.theirsLines.push(line);
	}

	return blocks;
}

const SCAN_FILE_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Scan a whole file for unresolved conflict blocks.
 *
 * Reads at most `maxBytes` (default 10 MB) so this stays cheap on
 * pathological files. Files truncated by the cap report
 * `scanTruncated: true`; only complete blocks within the scanned prefix
 * are returned, so trailing partial markers never invent fake blocks.
 */
export async function scanFileForConflicts(
	absolutePath: string,
	options: { maxBytes?: number } = {},
): Promise<{ blocks: ConflictBlock[]; scanTruncated: boolean }> {
	return scanFileForConflictsSync(absolutePath, options);
}

/**
 * Synchronous version of scanFileForConflicts.
 */
export function scanFileForConflictsSync(
	absolutePath: string,
	options: { maxBytes?: number } = {},
): { blocks: ConflictBlock[]; scanTruncated: boolean } {
	const maxBytes = options.maxBytes ?? SCAN_FILE_DEFAULT_MAX_BYTES;
	let text: string;
	let scanTruncated = false;
	try {
		const stat = fs.statSync(absolutePath);
		if (stat.size > maxBytes) {
			scanTruncated = true;
			const fd = fs.openSync(absolutePath, "r");
			try {
				const buf = Buffer.alloc(maxBytes);
				fs.readSync(fd, buf, 0, maxBytes, 0);
				text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
			} finally {
				fs.closeSync(fd);
			}
		} else {
			text = fs.readFileSync(absolutePath, "utf-8");
		}
	} catch {
		return { blocks: [], scanTruncated: false };
	}
	const lines = text.split("\n");
	return { blocks: scanConflictLines(lines, 1), scanTruncated };
}

/**
 * Return the label after a marker prefix when the line is a valid
 * column-0 marker, or `null` when it isn't. Strict shape: prefix alone,
 * or prefix + single space + label.
 */
function matchMarker(line: string, prefix: string): string | null {
	if (!line.startsWith(prefix)) return null;
	if (line.length === prefix.length) return "";
	if (line.charCodeAt(prefix.length) !== 32 /* space */) return null;
	return line.slice(prefix.length + 1);
}

/**
 * Recorded conflict block keyed by a session-stable id. The history is
 * append-only; ids stay valid even after later writes resolve other
 * blocks in the same file, so retries don't depend on re-reading.
 */
export interface ConflictEntry extends ConflictBlock {
	id: number;
	absolutePath: string;
	displayPath: string;
}

/** Per-session log of conflict regions surfaced by `read`. */
export class ConflictHistory {
	#nextId = 1;
	#entries = new Map<number, ConflictEntry>();

	/**
	 * Register a conflict block. Returns the (possibly pre-existing) entry
	 * — if the same `absolutePath`+`startLine` was registered before, the
	 * earlier id is reused so a re-read does not inflate the counter or
	 * orphan the prior id. The recorded region is overwritten on re-read
	 * so the splice always reflects the current marker positions on disk.
	 */
	register(input: Omit<ConflictEntry, "id">): ConflictEntry {
		for (const existing of this.#entries.values()) {
			if (existing.absolutePath === input.absolutePath && existing.startLine === input.startLine) {
				const merged: ConflictEntry = { ...input, id: existing.id };
				this.#entries.set(existing.id, merged);
				return merged;
			}
		}
		const id = this.#nextId++;
		const entry: ConflictEntry = { ...input, id };
		this.#entries.set(id, entry);
		return entry;
	}

	get(id: number): ConflictEntry | undefined {
		return this.#entries.get(id);
	}

	/** Snapshot every registered entry in insertion (id) order. */
	entries(): ConflictEntry[] {
		return [...this.#entries.values()];
	}

	/** Drop a single entry by id. Used after a successful resolve. */
	invalidate(id: number): void {
		this.#entries.delete(id);
	}

	/** Drop every entry referencing `absolutePath`. Used after a successful resolve. */
	invalidatePath(absolutePath: string): void {
		for (const [id, entry] of this.#entries) {
			if (entry.absolutePath === absolutePath) {
				this.#entries.delete(id);
			}
		}
	}

	/** Number of registered conflicts. */
	get size(): number {
		return this.#entries.size;
	}
}

/** A side of a conflict block that the `read` tool can render via `conflict://N/<scope>`. */
export type ConflictScope = "ours" | "theirs" | "base";

const CONFLICT_SCOPES = new Set<ConflictScope>(["ours", "theirs", "base"]);

/** Parsed `conflict://<N>` / `conflict://<N>/<scope>` / `conflict://*` URI. */
export interface ParsedConflictUri {
	/** `"*"` selects every currently-registered conflict (bulk write only). */
	id: number | "*";
	scope?: ConflictScope;
}

const CONFLICT_URI_RE = /^conflict:\/\/(.+)$/;

/**
 * Parse a `conflict://<N>`, `conflict://<N>/<scope>`, or `conflict://*` URI.
 *
 * Returns `null` for non-conflict paths; throws for a well-formed scheme
 * with an invalid id or scope.
 *
 * `*` is the bulk-write wildcard — only valid as `conflict://*` (no
 * scope segment).
 */
export function parseConflictUri(raw: string): ParsedConflictUri | null {
	const match = raw.match(CONFLICT_URI_RE);
	if (!match) return null;
	const tail = match[1];
	const slashIdx = tail.indexOf("/");
	const idPart = slashIdx === -1 ? tail : tail.slice(0, slashIdx);
	const scopePart = slashIdx === -1 ? undefined : tail.slice(slashIdx + 1);

	if (idPart === "*") {
		if (scopePart !== undefined) {
			throw new Error(
				`Invalid conflict URI '${raw}': wildcard 'conflict://*' does not accept a scope segment. Drop '/${scopePart}' or use a numeric id.`,
			);
		}
		return { id: "*" };
	}

	if (!/^\d+$/.test(idPart)) {
		throw new Error(
			`Invalid conflict URI '${raw}': must be 'conflict://<N>', 'conflict://<N>/<scope>', or 'conflict://*' where N is a positive integer surfaced by a prior read.`,
		);
	}
	const id = Number.parseInt(idPart, 10);
	if (!Number.isFinite(id) || id < 1) {
		throw new Error(`Invalid conflict URI '${raw}': id must be ≥ 1.`);
	}

	let scope: ConflictScope | undefined;
	if (scopePart !== undefined) {
		if (!CONFLICT_SCOPES.has(scopePart as ConflictScope)) {
			throw new Error(`Invalid conflict URI '${raw}': scope must be one of 'ours', 'theirs', 'base', or omitted.`);
		}
		scope = scopePart as ConflictScope;
	}

	return { id, scope };
}

/**
 * Splice the conflict region recorded in `entry` out of `originalText`
 * and replace it with `replacement` (markers and all sides included).
 *
 * Works by locating the recorded marker block by content (anchored to
 * `entry.startLine` as the preferred match), so out-of-band edits earlier
 * in the file that shift line numbers don't break resolution.
 */
export function spliceConflict(originalText: string, entry: ConflictEntry, replacement: string): string {
	// Preserve the original line ending (CRLF or LF) for a byte-accurate round-trip.
	const eol = originalText.includes("\r\n") ? "\r\n" : "\n";
	const lines = originalText.split(/\r?\n/);
	const expected = buildRecordedRegion(entry);
	const match = locateRegion(lines, expected, entry.startLine - 1);
	if (!match) {
		throw new Error(
			`Conflict #${entry.id} no longer present in '${entry.displayPath}': the recorded marker block can't be located. The file changed since the conflict was registered — re-read it to re-register conflicts.`,
		);
	}

	const trimmed = normalizeTrailingNewline(replacement);
	const replacementLines = trimmed.split("\n");
	const next = [...lines.slice(0, match.startIdx), ...replacementLines, ...lines.slice(match.endIdx + 1)];
	return next.join(eol);
}

/** Reconstruct the recorded marker block as it should appear in the file. */
function buildRecordedRegion(entry: ConflictEntry): string[] {
	const out: string[] = [];
	out.push(entry.oursLabel ? `${OURS_PREFIX} ${entry.oursLabel}` : OURS_PREFIX);
	out.push(...entry.oursLines);
	if (entry.baseLines !== undefined) {
		out.push(entry.baseLabel ? `${BASE_PREFIX} ${entry.baseLabel}` : BASE_PREFIX);
		out.push(...entry.baseLines);
	}
	out.push(SEPARATOR);
	out.push(...entry.theirsLines);
	out.push(entry.theirsLabel ? `${THEIRS_PREFIX} ${entry.theirsLabel}` : THEIRS_PREFIX);
	return out;
}

function locateRegion(
	lines: readonly string[],
	expected: readonly string[],
	preferredIdx: number,
): { startIdx: number; endIdx: number } | null {
	if (expected.length === 0 || expected.length > lines.length) return null;
	// Fast path: try the recorded position first.
	if (preferredIdx >= 0 && matchesAt(lines, preferredIdx, expected)) {
		return {
			startIdx: preferredIdx,
			endIdx: preferredIdx + expected.length - 1,
		};
	}
	let best: number | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	const limit = lines.length - expected.length;
	for (let i = 0; i <= limit; i++) {
		if (!matchesAt(lines, i, expected)) continue;
		const dist = Math.abs(i - preferredIdx);
		if (dist < bestDist) {
			best = i;
			bestDist = dist;
		}
	}
	if (best === null) return null;
	return { startIdx: best, endIdx: best + expected.length - 1 };
}

function matchesAt(lines: readonly string[], startIdx: number, expected: readonly string[]): boolean {
	if (startIdx < 0 || startIdx + expected.length > lines.length) return false;
	for (let i = 0; i < expected.length; i++) {
		if (lines[startIdx + i] !== expected[i]) return false;
	}
	return true;
}

function normalizeTrailingNewline(replacement: string): string {
	if (replacement.endsWith("\r\n")) return replacement.slice(0, -2);
	if (replacement.endsWith("\n")) return replacement.slice(0, -1);
	return replacement;
}

/**
 * Expand `@ours` / `@theirs` / `@base` / `@both` line tokens against the
 * recorded sections of `entry`. A token only triggers when it is the
 * entire content of a line (after CRLF normalisation), so `@ours` inside
 * actual code is left alone. Other lines pass through verbatim.
 *
 * - `@ours`    → expands to the recorded `oursLines`
 * - `@theirs`  → expands to the recorded `theirsLines`
 * - `@base`    → expands to `baseLines`; throws if no base section
 * - `@both`    → expands to `oursLines` then `theirsLines`
 */
export function expandContentTokens(content: string, entry: ConflictEntry): string {
	const inputLines = content.split("\n");
	const out: string[] = [];
	for (const rawLine of inputLines) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		switch (line) {
			case "@ours":
				out.push(...entry.oursLines);
				break;
			case "@theirs":
				out.push(...entry.theirsLines);
				break;
			case "@base":
				if (!entry.baseLines) {
					throw new Error(
						`Conflict #${entry.id} has no base section (2-way merge). \`@base\` is only valid for diff3 conflicts.`,
					);
				}
				out.push(...entry.baseLines);
				break;
			case "@both":
				out.push(...entry.oursLines, ...entry.theirsLines);
				break;
			default:
				out.push(rawLine);
				break;
		}
	}
	return out.join("\n");
}

/** Reconstruct a conflict-marker line from prefix and optional label. */
function markerLine(prefix: string, label: string | undefined): string {
	return label && label.length > 0 ? `${prefix} ${label}` : prefix;
}

/**
 * Materialise a conflict block for `conflict://<N>` reads (and their
 * `/ours` / `/theirs` / `/base` scopes).
 *
 * Returns:
 * - `lines`: the lines to render, ordered top-to-bottom.
 * - `startLine`: the 1-indexed file line number `lines[0]` corresponds
 *   to, so the read formatter can label hashline anchors.
 */
export function renderConflictRegion(entry: ConflictEntry, scope: ConflictScope | undefined): { lines: string[]; startLine: number } {
	if (scope === "ours") {
		return { lines: [...entry.oursLines], startLine: entry.startLine + 1 };
	}
	if (scope === "theirs") {
		return {
			lines: [...entry.theirsLines],
			startLine: entry.separatorLine + 1,
		};
	}
	if (scope === "base") {
		if (entry.baseLines === undefined || entry.baseLine === undefined) {
			throw new Error(
				`Conflict #${entry.id} has no base section (2-way merge). 'conflict://${entry.id}/base' is only valid for diff3 conflicts.`,
			);
		}
		return { lines: [...entry.baseLines], startLine: entry.baseLine + 1 };
	}
	const out: string[] = [];
	out.push(markerLine("<<<<<<<", entry.oursLabel));
	out.push(...entry.oursLines);
	if (entry.baseLines !== undefined) {
		out.push(markerLine("|||||||", entry.baseLabel));
		out.push(...entry.baseLines);
	}
	out.push("=======");
	out.push(...entry.theirsLines);
	out.push(markerLine(">>>>>>>", entry.theirsLabel));
	return { lines: out, startLine: entry.startLine };
}

const PREVIEW_SIDE_LINES = 6;

function pickLabel(entries: readonly ConflictEntry[], get: (e: ConflictEntry) => string | undefined): string | undefined {
	for (const e of entries) {
		const label = get(e);
		if (label && label.trim().length > 0) return label;
	}
	return undefined;
}

function sectionsEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function appendBody(out: string[], section: readonly string[]): void {
	if (section.length === 0) {
		out.push("(empty)");
		return;
	}
	const shown = section.slice(0, PREVIEW_SIDE_LINES);
	for (const line of shown) out.push(line);
	const hidden = section.length - shown.length;
	if (hidden > 0) out.push(`… (${hidden} more line${hidden === 1 ? "" : "s"})`);
}

export interface FormatConflictWarningOptions {
	/** Total number of conflicts in the underlying file. */
	totalInFile?: number;
	/** Display path used inside the `:conflicts` hint. */
	displayPath?: string;
	/** Whether the underlying file scan hit its byte cap. */
	scanTruncated?: boolean;
}

/**
 * Build a compact diff-style footer describing the conflicts registered
 * during a read. Designed to be appended after the file content.
 *
 * Format:
 *
 *     ⚠ N unresolved conflicts detected
 *     - ours = HEAD
 *     - theirs = feature/x
 *     NOTICE: …
 *
 *     ──── #1  L42-48 ────
 *     <<< ours
 *     …ours body…
 *     === base ≡ ours
 *     >>> theirs
 *     …theirs body…
 */
export function formatConflictWarning(entries: readonly ConflictEntry[], options: FormatConflictWarningOptions = {}): string {
	if (entries.length === 0) return "";
	const total = options.totalInFile ?? entries.length;
	const partial = total > entries.length;
	const out: string[] = [];
	out.push("");
	const word = total === 1 ? "conflict" : "conflicts";
	if (partial) {
		const hintPath = options.displayPath ?? "<file>";
		out.push(
			`⚠ ${entries.length} of ${total} unresolved ${word} visible in this window (read \`${hintPath}:conflicts\` for the full list).`,
		);
	} else {
		out.push(`⚠ ${total} unresolved ${word} detected`);
	}
	if (options.scanTruncated) {
		out.push("- note: file scan hit the byte cap; additional conflicts may exist beyond the scanned prefix.");
	}

	const oursLabel = pickLabel(entries, (e) => e.oursLabel);
	const theirsLabel = pickLabel(entries, (e) => e.theirsLabel);
	const baseLabel = pickLabel(entries, (e) => (e.baseLines !== undefined ? e.baseLabel : undefined));
	const anyBase = entries.some((e) => e.baseLines !== undefined);
	if (oursLabel) out.push(`- ours = ${oursLabel}`);
	if (theirsLabel) out.push(`- theirs = ${theirsLabel}`);
	if (anyBase) out.push(`- base = ${baseLabel ?? "(no label)"}`);
	out.push(
		'NOTICE: Inspect a block by reading `conflict://<N>` (add `/ours` / `/theirs` / `/base` to render a single side). Resolve with `write({ path: "conflict://<N>", content })`, or bulk-resolve every registered conflict with `write({ path: "conflict://*", content })`.',
	);
	out.push(
		"`content` shorthand: a line that is exactly `@ours` / `@theirs` / `@base` / `@both` expands to that recorded section. Non-token lines pass through verbatim.",
	);

	for (const entry of entries) {
		const range = entry.startLine === entry.endLine ? `L${entry.startLine}` : `L${entry.startLine}-${entry.endLine}`;
		out.push("");
		out.push(`──── #${entry.id}  ${range} ────`);

		const baseEqualsOurs = entry.baseLines !== undefined && sectionsEqual(entry.baseLines, entry.oursLines);
		const baseEqualsTheirs = entry.baseLines !== undefined && sectionsEqual(entry.baseLines, entry.theirsLines);
		const theirsEqualsOurs = sectionsEqual(entry.theirsLines, entry.oursLines);

		out.push("<<< ours");
		appendBody(out, entry.oursLines);

		if (entry.baseLines !== undefined) {
			if (baseEqualsOurs) {
				out.push("=== base ≡ ours");
			} else if (baseEqualsTheirs) {
				out.push("=== base ≡ theirs");
			} else {
				out.push("=== base");
				appendBody(out, entry.baseLines);
			}
		}

		if (theirsEqualsOurs) {
			out.push(">>> theirs ≡ ours");
		} else {
			out.push(">>> theirs");
			appendBody(out, entry.theirsLines);
		}
	}
	return out.join("\n");
}

/**
 * Render a single-line-per-block index of every conflict in a file.
 * Used by `<path>:conflicts` selector.
 */
export function formatConflictSummary(
	entries: readonly ConflictEntry[],
	options: { displayPath: string; scanTruncated?: boolean } = {
		displayPath: "",
	},
): string {
	const lines: string[] = [];
	const total = entries.length;
	const word = total === 1 ? "conflict" : "conflicts";
	lines.push(`⚠ ${total} unresolved ${word} in ${options.displayPath || "<file>"}`);
	if (options.scanTruncated) {
		lines.push("- note: file scan hit the byte cap; additional conflicts may exist beyond the scanned prefix.");
	}
	const oursLabel = pickLabel(entries, (e) => e.oursLabel);
	const theirsLabel = pickLabel(entries, (e) => e.theirsLabel);
	const baseLabel = pickLabel(entries, (e) => (e.baseLines !== undefined ? e.baseLabel : undefined));
	const anyBase = entries.some((e) => e.baseLines !== undefined);
	if (oursLabel) lines.push(`- ours = ${oursLabel}`);
	if (theirsLabel) lines.push(`- theirs = ${theirsLabel}`);
	if (anyBase) lines.push(`- base = ${baseLabel ?? "(no label)"}`);
	lines.push(
		'NOTICE: Bulk-resolve with `write({ path: "conflict://*", content })`, or address a single block with `write({ path: "conflict://<N>", content })`.',
	);
	lines.push(
		"`content` shorthand: `@ours` / `@theirs` / `@base` / `@both` lines expand to the recorded sections. Non-token lines pass through verbatim.",
	);
	lines.push("");
	const idWidth = String(entries[entries.length - 1]?.id ?? 1).length;
	for (const entry of entries) {
		const range = entry.startLine === entry.endLine ? `L${entry.startLine}` : `L${entry.startLine}-${entry.endLine}`;
		const idCell = `#${String(entry.id).padStart(idWidth, " ")}`;
		const kind = entry.baseLines !== undefined ? "  (3-way)" : "";
		lines.push(`${idCell}  ${range}${kind}`);
	}
	return lines.join("\n");
}
