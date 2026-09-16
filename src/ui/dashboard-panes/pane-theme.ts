/**
 * pane-theme.ts — the theme binding dashboard panes render RAIL primitives with.
 *
 * Contract (§2.G of docs/UI-DESIGN-SYSTEM.md): a pane returns CONTENT LINES
 * ONLY and stays uncolored — the frame owner (run-dashboard.ts) prefixes the
 * `┃ ` rail and colorizes embedded status glyphs through
 * `colorizeStatusGlyphs`. The RAIL primitives in `src/ui/rail.ts`
 * (`statusIcon`, `statusSlot`, `overflowHint`, `railLine`, `formatHint`, …)
 * all take a `CrewTheme`, so panes hand them this identity theme: every glyph,
 * overflow dialect and hint still comes from the one shared vocabulary, while
 * no ANSI escapes leak into pane content.
 *
 * Not a fork of a rail primitive — a no-op `CrewTheme` adapter
 * (`asCrewTheme(undefined)` → identity `fg`/`bold`) so uncolored producers can
 * call the colored primitives.
 */

import { asCrewTheme } from "../theme-adapter.ts";

/** Identity theme: `fg(color, text) === text`, `bold(text) === text`. */
export const PANE_THEME = asCrewTheme(undefined);
