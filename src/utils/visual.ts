import { visibleWidth as tuiVisibleWidth } from "@earendil-works/pi-tui";

export const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const WIDTH_CACHE_LIMIT = 256;
const widthCache = new Map<string, number>();

// NOTE: width measurement is delegated to pi-tui's `visibleWidth` (see below).
// pi-tui is the renderer that HARD-ABORTS the session if any line exceeds the
// terminal width by ITS measure, so our truncate/pad/wrap MUST agree with it.
// A previous hand-maintained WIDE_RANGES table diverged from pi-tui's
// grapheme+RGI-emoji model on codepoints like ⏳ U+23F3 (hourglass: we counted
// 1, pi-tui counts 2) → lines we believed fit were rejected →
// "Rendered line N exceeds terminal width (160 > 159)" crash. Delegating makes
// divergence structurally impossible.

export function visibleWidth(value: string): number {
	// Delegate to pi-tui's authoritative width model so our truncate/pad/wrap
	// can never disagree with the renderer's doRender measurement. Keep our own
	// LRU cache on top (pi-tui caches too, but this avoids repeated calls for the
	// hot render path).
	if (value.length > 4096) return tuiVisibleWidth(value);
	const cached = widthCache.get(value);
	if (cached !== undefined) return cached;
	const length = tuiVisibleWidth(value);
	if (widthCache.size >= WIDTH_CACHE_LIMIT) {
		const firstKey = widthCache.keys().next().value;
		if (firstKey !== undefined) widthCache.delete(firstKey);
	}
	widthCache.set(value, length);
	return length;
}

export function __test__clearVisibleWidthCache(): void {
	widthCache.clear();
}

export function __test__visibleWidthCacheSize(): number {
	return widthCache.size;
}

function consumeAnsi(input: string, index: number): number {
	const char = input[index];
	if (!char || char !== "\u001b") return 0;
	if (input[index + 1] !== "[") return 0;
	let i = index + 2;
	while (i < input.length) {
		const code = input.charCodeAt(i);
		if (code >= 0x40 && code <= 0x7e) return i - index + 1;
		i++;
	}
	return 0;
}

function splitGraphemes(value: string): string[] {
	return Array.from(value.replace(ANSI_PATTERN, ""));
}

export function truncateToWidth(value: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	if (visibleWidth(value) <= width) return value;
	if (width <= ellipsis.length) return ellipsis.slice(0, width);
	let output = "";
	let renderedWidth = 0;
	for (let i = 0; i < value.length; ) {
		const ansiLen = consumeAnsi(value, i);
		if (ansiLen) {
			output += value.slice(i, i + ansiLen);
			i += ansiLen;
			continue;
		}
		// Read the codepoint at position i on the FULL string — NOT
		// `value[i].codePointAt(0)`, which for a surrogate pair returns the
		// lone half (≤ 0xFFFF) and slices each half separately. pi-tui's
		// visibleWidth zero-widths lone `\p{Surrogate}` halves, so 🤖 would
		// undercount as 0 and truncation would never cut (latent bug unmasked
		// once visibleWidth delegated to pi-tui).
		const codepoint = value.codePointAt(i) ?? 0;
		const nextIndex = codepoint > 0xffff ? i + 2 : i + 1;
		const segment = value.slice(i, nextIndex);
		const charWidth = visibleWidth(segment);
		if (renderedWidth + charWidth > width - ellipsis.length) {
			return `${output}${ellipsis}`;
		}
		output += segment;
		renderedWidth += charWidth;
		i = nextIndex;
	}
	return output;
}

export const truncate = truncateToWidth;

/**
 * Strip newlines and other terminal-confusing control characters from a
 * single-line label. Without this, embedded `\n`/`\r` in user-provided
 * text (run.goal, run.team, mailbox preview, agent activity, ...) breaks
 * box-drawing rows because the terminal advances to the next line in the
 * middle of a row, leaving the overlay's `│` border misaligned and the
 * dashboard appearing to "duplicate" itself below the original render.
 *
 * Preserves ANSI color/style escape sequences (\u001b[...m) which the
 * caller has already wrapped around the text via the theme adapter.
 */
export function sanitizeLine(value: string): string {
	if (!value) return "";
	let result = "";
	let i = 0;
	while (i < value.length) {
		const ansi = readAnsiCode(value, i);
		if (ansi) {
			result += ansi;
			i += ansi.length;
			continue;
		}
		const code = value.charCodeAt(i);
		// Replace any C0/C1 control char (incl. \n \r \t \v \f and 0x7F-0x9F)
		// with a single space; everything else is passed through verbatim.
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			result += " ";
			i += 1;
			continue;
		}
		result += value[i];
		i += 1;
	}
	return result;
}

export function pad(value: string, width: number): string {
	const current = visibleWidth(value);
	if (current >= width) return value;
	return `${value}${" ".repeat(width - current)}`;
}

export function boxLine(text: string, innerWidth: number): string {
	return `│ ${truncate(text, innerWidth - 4)} │`;
}

function readAnsiCode(input: string, index: number): string | undefined {
	const ansiLength = consumeAnsi(input, index);
	if (ansiLength > 0) return input.slice(index, index + ansiLength);
	return undefined;
}

function takeCodePoint(input: string, index: number): { chunk: string; nextIndex: number } {
	const code = input.codePointAt(index);
	if (code === undefined) return { chunk: "", nextIndex: index + 1 };
	if (code >= 0xd800 && code <= 0xdbff && index + 1 < input.length) {
		return { chunk: input.slice(index, index + 2), nextIndex: index + 2 };
	}
	return { chunk: input[index] ?? "", nextIndex: index + 1 };
}

export function wrapHard(value: string, width: number): string[] {
	if (width <= 0 || !value) return [];
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	let i = 0;
	while (i < value.length) {
		const ansi = readAnsiCode(value, i);
		if (ansi) {
			current += ansi;
			i += ansi.length;
			continue;
		}
		const { chunk, nextIndex } = takeCodePoint(value, i);
		const chunkWidth = visibleWidth(chunk);
		if (chunkWidth > width) {
			lines.push(current ? current + chunk : chunk);
			current = "";
			currentWidth = 0;
			i = nextIndex;
			continue;
		}
		if (currentWidth + chunkWidth > width) {
			if (current) lines.push(current);
			current = chunk;
			currentWidth = chunkWidth;
			i = nextIndex;
			continue;
		}
		current += chunk;
		currentWidth += chunkWidth;
		i = nextIndex;
	}
	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

export interface VisualTruncateResult {
	visualLines: string[];
	skippedCount: number;
}

export function truncateToVisualLines(text: string, maxVisualLines: number, width: number, paddingX = 0): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}
	const effectiveWidth = Math.max(1, width - paddingX * 2);
	const limit = Math.max(1, maxVisualLines);
	const visualLines = text.split("\n").flatMap((line) => wrapHard(pad(line, Math.max(0, effectiveWidth)).trimEnd(), effectiveWidth));
	if (visualLines.length <= limit) return { visualLines, skippedCount: 0 };
	const truncated = visualLines.slice(-limit);
	return { visualLines: truncated, skippedCount: visualLines.length - limit };
}
