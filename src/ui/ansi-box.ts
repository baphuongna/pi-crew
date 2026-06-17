/**
 * Tool-output rendering foundation — ported from pi-pretty.
 *
 * The three building blocks that give pi-crew tool results a real visual
 * structure (background fills + rule separators + gutters), instead of the
 * flat fg-only Text it emits today. See
 * `research-findings/ui-overhaul-rendering-techniques.md` Part A for the
 * file:line grounding (pi-pretty/src/render.ts).
 *
 * Why this matters: a tool box with a subtle background fill (toolSuccessBg /
 * toolErrorBg), a rule separator under the header, and a line-number gutter
 * reads as a polished result panel. fg-only output reads as a raw log.
 *
 * The hard-won technique is `preserveBoxBackground`: highlighted/syntax output
 * is fg-only (Shiki, cli-highlight), and when wrapped in a bg-filled box the
 * inner full resets (`\x1b[0m`) would punch holes through the box bg.
 * preserveBoxBackground rewrites every SGR sequence to (a) neutralize resets
 * into RESET_WITHOUT_BG (no `49` → bg survives) and (b) strip any competing
 * bg codes (`48`, `49`, `40-47`, `100-107`), keeping all fg + text-attribute
 * codes intact.
 */

import { truncateToWidth } from "../utils/visual.ts";

// A "background" is whatever string a theme's bg() returns — a full ANSI
// sequence like "\x1b[48;2;30;30;40m", or "" when the theme has no bg.
export type BgSeq = string;

/** Reset every attribute EXCEPT background. 49 (default bg) is deliberately
 * omitted so a box's bg fill survives an inner full reset. (pi-pretty trick.) */
export const RESET_WITHOUT_BG = "\x1b[22;23;24;25;27;28;29;39m";

/** Full reset. */
export const RESET = "\x1b[0m";

/** Matches a single ANSI CSI Select-Graphic-Rendition sequence `\x1b[...m`. */
const ANSI_SGR_RE = /\x1b\[([0-9;]*)m/g;

/**
 * Rewrite an ANSI string so it is safe to embed inside a bg-filled tool box:
 * - empty / `0` (full reset) → RESET_WITHOUT_BG (bg survives)
 * - `38` foreground-extended sequences (`38;5;n` / `38;2;r;g;b`) → kept verbatim
 * - `48` background-extended / `49` / `40-47` / `100-107` → dropped (no competing bg)
 * - all other codes (bold, dim, italic, underline, …) → kept
 *
 * Pure function; idempotent. Returns the original string if it has no SGR.
 */
export function preserveBoxBackground(ansi: string): string {
	if (!ansi.includes("\x1b[")) return ansi;
	return ansi.replace(ANSI_SGR_RE, (_seq, params: string) => {
		if (!params || params === "0") return RESET_WITHOUT_BG;
		const parts = params.split(";").filter(Boolean);
		const kept: string[] = [];
		let i = 0;
		while (i < parts.length) {
			const code = Number(parts[i]);
			if (code === 38) {
				// Foreground extended — keep the whole sequence.
				kept.push(parts[i]);
				if (parts[i + 1] === "5") {
					kept.push(parts[i + 1]);
					i += 2;
				} else if (parts[i + 1] === "2") {
					kept.push(parts[i + 1], parts[i + 2], parts[i + 3], parts[i + 4]);
					i += 5;
				} else {
					i += 1;
				}
			} else if (code === 48) {
				// Background extended — skip entirely.
				if (parts[i + 1] === "5") i += 3;
				else if (parts[i + 1] === "2") i += 6;
				else i += 1;
			} else if (code === 49 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				// Background single-byte — drop.
				i += 1;
			} else {
				kept.push(parts[i]);
				i += 1;
			}
		}
		return kept.length ? `\x1b[${kept.join(";")}m` : "";
	});
}

/**
 * Wrap every line of `text` with a background fill. Each line is truncated to
 * `width` (if given), run through `preserveBoxBackground` (so embedded resets
 * don't punch through), then prefixed with `bg`. The bg is re-applied per line.
 *
 * Pass `bg = ""` to get a no-op (no fill) — useful when a theme lacks bg
 * support, so the same render path degrades gracefully.
 */
export function fillToolBackground(text: string, bg: BgSeq, width?: number): string {
	const lines = text.split("\n");
	const out = lines.map((line) => {
		const fitted = width ? truncateToWidth(line, width, "") : line;
		const safe = preserveBoxBackground(fitted);
		return bg ? `${bg}${safe}` : safe;
	});
	return out.join("\n");
}

/** Pad a line out to `width` with the trailing bg fill, so the box has a clean
 * right edge. No-op when bg is empty or width is unset. */
export function fillLineToWidth(line: string, bg: BgSeq, width: number, visibleWidth: (s: string) => number): string {
	if (!bg || width <= 0) return line;
	const vw = visibleWidth(line);
	if (vw >= width) return line;
	const pad = " ".repeat(width - vw);
	return `${bg}${preserveBoxBackground(line)}${bg}${pad}`;
}

/** Horizontal rule separator of `width` cells, in a rule color. */
export function rule(width: number, ruleSeq: BgSeq = ""): string {
	const bar = "─".repeat(Math.max(0, width));
	return ruleSeq ? `${ruleSeq}${bar}${RESET}` : bar;
}

/** Right-padded line-number gutter cell: `lnum(n, w)` → width-`w` number. */
export function lnum(n: number, width: number, lnumSeq: BgSeq = ""): string {
	const v = String(n);
	const pad = " ".repeat(Math.max(0, width - v.length));
	return lnumSeq ? `${lnumSeq}${pad}${v}${RESET}` : `${pad}${v}`;
}

/** Compute the gutter width for a code block ending at `endLine` (min 3). */
export function gutterWidth(endLine: number): number {
	return Math.max(3, String(Math.max(1, endLine)).length);
}

export interface ToolMetrics {
	elapsedMs?: number;
	charCount?: number;
}

/** Format a metrics line `· 1.2s · 4.2k`. Empty string when no metrics. */
export function renderToolMetrics(metrics: ToolMetrics, dimSeq: BgSeq = ""): string {
	const parts: string[] = [];
	const elapsed = formatElapsedMs(metrics.elapsedMs);
	const chars = formatCharCount(metrics.charCount);
	if (elapsed) parts.push(elapsed);
	if (chars) parts.push(chars);
	if (!parts.length) return "";
	const body = `· ${parts.join(" · ")}`;
	return dimSeq ? `${dimSeq}${body}${RESET}` : body;
}

function formatElapsedMs(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m${s}s`;
}

function formatCharCount(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n) || n <= 0) return "";
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Compose a complete tool-result panel: header line + rule + body lines +
 * optional footer, all bg-filled. This is the high-level helper tool renderers
 * call after they build their (already-colored) body lines.
 *
 * `bg` empty → no fill (graceful degradation on bg-less themes).
 */
export function renderToolPanel(input: {
	header: string;
	bodyLines: string[];
	footer?: string;
	metrics?: string;
	bg: BgSeq;
	ruleSeq?: BgSeq;
	width: number;
}): string {
	const { header, bodyLines, footer, metrics, bg, ruleSeq, width } = input;
	const parts: string[] = [];
	const fitted = (line: string) => fillToolBackground(line, bg, width);
	parts.push(fitted(header));
	if (width > 0) parts.push(fitted(rule(width, ruleSeq)));
	for (const line of bodyLines) parts.push(fitted(line));
	if (footer) parts.push(fitted(footer));
	if (metrics) parts.push(fitted(metrics));
	return parts.join("\n");
}
