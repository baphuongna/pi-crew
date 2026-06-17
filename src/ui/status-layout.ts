/**
 * Status-line layout — tiered 3-state collapse, ported from pi-bar.
 *
 * pi-bar's distinctive width-adaptation technique (`statusbar.ts:88-203`, see
 * `research-findings/ui-overhaul-rendering-techniques.md` Part B): instead of
 * just truncating a status line when the terminal narrows, segments degrade
 * through three states — **Full → Collapsed → Hidden** — by `collapseOrder`,
 * so the most important info survives at the narrowest width.
 *
 *   wide:    " run-abc   3/5 tasks   $0.04   claude-sonnet   42% of 200k "
 *   medium:  " run-abc   3/5   $0.04   sonnet   42% "
 *   narrow:  " 3/5   sonnet   42% "
 *   tiny:    " 3/5 "
 *
 * Pure function: given (segments, width) → ordered array of visible segments
 * in their chosen render state. The caller then joins them (optionally via a
 * powerline renderSegmentChain). No rendering/ANSI here — this is layout only,
 * so it's fully testable without a theme.
 *
 * Algorithm (faithful to pi-bar, simplified):
 *  1. Start all segments in Full state.
 *  2. Pass 1 (Full→Collapsed): repeatedly find the HIGHEST collapseOrder
 *     segment still Full where collapsedWidth < fullWidth; collapse it; recompute.
 *     Continue until the total visible width ≤ target OR no collapsible remains.
 *  3. Pass 2 (→Hidden): repeatedly find the HIGHEST collapseOrder segment still
 *     visible; hide it; recompute. Continue until total ≤ target OR none left.
 *  4. Hard backstop: if even fully collapsed + only-one-segment overflows,
 *     truncate the survivor.
 *
 * "Highest collapseOrder collapses first" = lowest-priority info degrades first.
 * collapseOrder is a number; ties resolve to the rightmost segment (so the
 * leftmost/primary segment is preserved longest).
 */

export type SegmentState = "full" | "collapsed" | "hidden";

export interface LayoutSegment<TText = string> {
	/** Full-form text (and its visible width). */
	full: TText;
	/** Visible (ANSI-stripped) width of `full`. */
	fullWidth: number;
	/** Collapsed/short form. Optional — segments without it skip Full→Collapsed. */
	collapsed?: TText;
	/** Visible width of `collapsed`. */
	collapsedWidth?: number;
	/** Higher number = collapses first (lower priority). Omit = never auto-collapse. */
	collapseOrder?: number;
	/** Stable key for dedup/identity (optional). */
	key?: string;
}

export interface ResolvedSegment<TText = string> {
	/** The chosen text for the current state (full/collapsed, or undefined if hidden). */
	text?: TText;
	/** Visible width of the chosen text (0 when hidden). */
	width: number;
	state: SegmentState;
}

/** Strip ANSI SGR sequences for width math. Shared with visual.ts visibleWidth. */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Lay out segments into a target visible width using tiered 3-state collapse.
 *
 * @param segments ordered input segments
 * @param width target visible width (in cells). ≤ 0 → single-segment truncation only.
 * @returns ordered segments in their resolved states (hidden ones included with
 *   state="hidden" and width 0, so the caller can preserve ordering/count if desired).
 */
export function layoutSegments<TText = string>(
	segments: readonly LayoutSegment<TText>[],
	width: number,
): ResolvedSegment<TText>[] {
	// Seed: everything Full.
	const state: SegmentState[] = segments.map(() => "full");

	const visibleWidth = (): number =>
		segments.reduce((sum, seg, i) => {
			if (state[i] === "hidden") return sum;
			if (state[i] === "collapsed") return sum + (seg.collapsedWidth ?? seg.fullWidth);
			return sum + seg.fullWidth;
		}, 0);

	// Separator allowance: the caller will join with a separator (e.g. " " or a
	// powerline glyph). Reserve one cell per gap so the layout matches the joined
	// render. We use a conservative 1 cell/gap (the common case); the caller's
	// final truncation is the hard backstop regardless.
	const gapCells = (count: number): number => (count > 1 ? count - 1 : 0);
	const totalWidth = () => {
		const visibleCount = state.filter((s) => s !== "hidden").length;
		return visibleWidth() + gapCells(visibleCount);
	};

	// Pass 1: Full → Collapsed. Pick the HIGHEST collapseOrder segment still Full
	// whose collapsed form is actually shorter.
	while (totalWidth() > width) {
		const candidate = pickByCollapseOrder(segments, state, "full", (seg) =>
			seg.collapsed !== undefined && (seg.collapsedWidth ?? seg.fullWidth) < seg.fullWidth,
		);
		if (candidate === -1) break;
		state[candidate] = "collapsed";
	}

	// Pass 2: → Hidden. Pick the HIGHEST collapseOrder segment still visible,
	// but NEVER hide the last remaining visible segment (floor of 1) — an empty
	// status line is worse than a truncated one. The join's truncate backstop
	// handles the residual overflow.
	while (totalWidth() > width) {
		const visibleCount = state.filter((s) => s !== "hidden").length;
		if (visibleCount <= 1) break; // floor: keep at least one segment
		const candidate = pickByCollapseOrder(segments, state, "visible", () => true);
		if (candidate === -1) break;
		state[candidate] = "hidden";
	}

	// Build resolved output.
	return segments.map((seg, i) => {
		if (state[i] === "hidden") return { text: undefined, width: 0, state: "hidden" };
		if (state[i] === "collapsed") {
			return { text: seg.collapsed ?? seg.full, width: seg.collapsedWidth ?? seg.fullWidth, state: "collapsed" };
		}
		return { text: seg.full, width: seg.fullWidth, state: "full" };
	});
}

/**
 * Pick the index of the segment to transition next.
 * - `scope="full"`: only Full-state segments.
 * - `scope="visible"`: Full OR Collapsed segments.
 * - Among candidates passing `filter`, pick the HIGHEST collapseOrder; ties →
 *   rightmost (so leftmost/primary survives longest). Segments without a
 *   collapseOrder are ineligible (never auto-collapsed/hidden).
 * Returns -1 if no candidate.
 */
function pickByCollapseOrder<TText>(
	segments: readonly LayoutSegment<TText>[],
	state: SegmentState[],
	scope: "full" | "visible",
	filter: (seg: LayoutSegment<TText>) => boolean,
): number {
	let best = -1;
	let bestOrder = -Infinity;
	for (let i = segments.length - 1; i >= 0; i--) {
		const inScope = scope === "full" ? state[i] === "full" : state[i] !== "hidden";
		if (!inScope) continue;
		const seg = segments[i];
		const order = seg.collapseOrder;
		if (order === undefined) continue; // never auto-degrade
		if (!filter(seg)) continue;
		if (order > bestOrder) {
			bestOrder = order;
			best = i;
		}
	}
	return best;
}

/**
 * Convenience: compute the visible (ANSI-stripped) width of a text string.
 * Mirrors visual.ts visibleWidth so callers can measure segment widths without
 * importing the full visual util (and without an ANSI-escape edge case).
 */
export function segmentVisibleWidth(text: string): number {
	return stripAnsi(text).length;
}

/**
 * Join resolved segments into a single string, truncating to `width` as a hard
 * backstop. Hidden segments are skipped. `separator` is inserted between
 * visible segments (default single space).
 */
export function joinResolvedSegments<TText = string>(
	resolved: readonly ResolvedSegment<TText>[],
	width: number,
	separator = " ",
): string {
	const visible = resolved.filter((r) => r.state !== "hidden" && r.text !== undefined);
	const joined = visible.map((r) => String(r.text)).join(separator);
	// Hard backstop truncation (cell-based; ANSI-naive but safe since separators
	// are plain and the heavy lifting was the tiered collapse above).
	const stripped = stripAnsi(joined);
	if (stripped.length <= width) return joined;
	// Truncate at width, cell-by-cell over ANSI.
	return truncateVisible(joined, width);
}

function truncateVisible(s: string, width: number): string {
	// Walk the string, copying ANSI escapes for free and counting visible cells.
	let out = "";
	let cells = 0;
	let i = 0;
	while (i < s.length) {
		if (s[i] === "\x1b" && s[i + 1] === "[") {
			const end = s.indexOf("m", i);
			if (end !== -1) {
				out += s.slice(i, end + 1);
				i = end + 1;
				continue;
			}
		}
		if (cells >= width) break;
		out += s[i];
		cells += 1;
		i += 1;
	}
	return out;
}
