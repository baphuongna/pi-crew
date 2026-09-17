# pi-crew UI Design System — RAIL (v1, 2026-09-16)

> **Status:** authoritative contract for the UI sync (M4). Any surface that
> paints text into the TUI MUST follow it. Primitive source of truth:
> **`src/ui/rail.ts`**. Reference implementation: `src/ui/tool-renderers/index.ts`
> (tool card, shipped in R3).

The audit (`UI-AUDIT-2026-09-15.md`) found every non-tool surface still wearing
the pre-R3 language: rounded boxes `╭─╮│╰─╯`, inline `── label ──` rules, four
overflow dialects, two cursor vocabularies, 27 hand-typed hint strings and
`▸` overloaded three ways. This document replaces all of that with one grammar.

---

## 1. Grammar

| Element | Glyph | Meaning | Helper |
|---|---|---|---|
| Open | `┏` | surface opens, identity follows | `canopyLine()` |
| Section | `┣` | a named section inside a surface (replaces `── label ──`) | `sectionLine()` |
| Body | `┃` | continues the surface | `railLine(RAIL.body, …)` |
| Close | `┗` | outcome + end cap (hints, key chord) | `railLine(RAIL.close, …)` |
| Canopy | `NAME ▸ SUBJECT` | identity: `┏ CREW ▸ implementation` | `canopyLine()` |
| Leaders | `······` | join left/right segments; collapse to a 2-space gap when tight | `railLeaders()` |
| Gauge | `▕████▎░░▏` | progress with eighth-block sub-cell precision | `gaugeBar()` |
| Cursor | `›` | the selected row — **the only selection marker** | `CURSOR` |
| Active | `▸` | active step / section marker (never selection) | `ACTIVE` |
| Overflow | `▲ n above` / `▼ m below` | **the only** overflow dialect | `overflowHint()` |

### Colour roles

- **Rail colour = state.** `statusSlot(status)` → `success` / `error` /
  `borderAccent` (running) / `warning` (attention) / `border` (idle).
  Open half of a card is `border` (outcome unknown), close half takes the
  outcome colour.
- Identity word: `accent` + bold. Subject: `toolTitle` + bold.
- Chrome (glyphs, leaders, dim hints): `dim`. Secondary text: `muted`.

### Text rules

- Hints: **one format**, always `keys label` pairs joined by ` · `, close/cancel
  **last**, keys through `keyToken()` (`Esc` not `ESC`/`esc`; `Enter` not `⏎`;
  bare letters uppercase). Build with `formatHint()` and feed keys from
  `src/ui/keybinding-map.ts` so a remap cannot desync the footer.
- **No `undefined` may ever reach a string.** Every interpolated optional needs
  `?? "…"`. Disk-sourced records (`agents.json`, schedules) are NOT
  schema-validated at read time — guard at render (`?? "?"`).
- Never hand-roll width math: use `padVisual` / `truncVisual` / `visibleWidth`.
  A line must never exceed its budget — escapes are ANSI-aware.

### Width contract

- Multi-line surfaces that paint into a live TUI must defer width through
  **`AdaptiveCard`** (`src/ui/adaptive-card.ts`) or take the real `width` in
  `render(width)`. Baking a width at build time is the R2 bug (a frame built
  for 116 columns tears at 100).
- `budget` = render width − 2 (glyph + space). `railLine` owns the separator.

---

## 2. Surface classes

### A. Tool card — *reference, shipped*
`┏ CREW ▸ team` / `┃ …` / `┗ ● 3/3 · team · 1m59s · 3.5k tok ···· ctrl+o`.

### B. Single-line dock (widget, status bar) — **1 row, never more**
`┃ ⠧ CREW ▸ fast-fix · 2 running · 3/5 done · ⏰ 1 sched ···· ↓·enter`
- Always `┃` (never `┏`/`┗` — those imply multi-line).
- Focused row keeps the `❯ ` prefix.
- Zero runs: `┃ CREW ▸ idle · ⏰ 1 sched ···· ↓·enter`.
  **No schedules → render nothing (`[]`), never a bare hint.**
- Status bar: `┃ CREW ▸ 2r · 2q · 3/5 done · <model>`.

### C. Full-screen frame (dashboard)
- Canopy: `┏ DASHBOARD ▸ 3 runs` + right hint segment (dot-led).
- Every body row is prefixed `┃ ` by the frame owner.
- Sections: `┣ AGENTS ▸ 4` — **no `── label ──` anywhere**.
- Cap: `┗ <hint>` (dot-led right segment for state, e.g. `···· % ctx` gauge).
- Cursor `›`, overflow via `overflowHint()`.

### D. Two-column surface (agents & jobs browser)
- Canopy `┏ AGENTS ▸ 2 agents · 1 job`; footer `┗ <hint>`.
- The two columns are joined by dot leaders: `┃ <left> ····· <right>`.
  **No inner `│` frame column, no flex-table.**
- `│` survives ONLY as an inner column separator inside a two-column *body*
  (mailbox detail/compose), never as a frame edge.

### E. Modal overlay
- `┏ NAME ▸ SUBJECT` (`AGENTS ▸ <runId8>`, `MAILBOX ▸ <runId8>`,
  `COMPOSE ▸ mailbox`, `HELP ▸ dashboard`, `LIVE ▸ <agent>`), `┃` body rows,
  `┗ <hint>`.
- Rounded boxes `╭ ╮ ╰ ╯ ├ ┤` are **retired**.

### F. Dialog / confirm
- `┏ CONFIRM ▸ <title>`, `┃ <question>`, `┗ <hint>`; hint = `formatHint`, close last.

### G. Dashboard panes (content providers)
- A pane returns **content lines only** — the frame owner prefixes the rail and
  prints the `┣ SECTION` header. Panes must not draw frame glyphs or repeat the
  section title.
- Standardize glyphs through `rail.ts` (`statusIcon`, `statusSlot`), overflow
  through `overflowHint()`, and guard every optional field.

---

## 3. Migration contract (per owner, disjoint files)

| Owner | Files | Test file (new) |
|---|---|---|
| **E1 overlays** | `src/ui/overlays/*.ts`, `src/ui/live-conversation-overlay.ts` | `test/unit/ui/overlays-rail.test.ts` |
| **E2 full-screen** | `src/ui/run-dashboard.ts`, `src/ui/agents-jobs-browser.ts`, `src/ui/settings-overlay.ts` | `test/unit/ui/dashboard-rail.test.ts` |
| **E3 panes** | `src/ui/dashboard-panes/*.ts`, `src/ui/transcript-viewer.ts` | `test/unit/ui/panes-rail.test.ts` |
| **E4 dock** | `src/ui/widget/*.ts`, `src/ui/live-run-sidebar.ts`, `src/ui/inline-panel/crew-editor.ts` | `test/unit/ui/dock-rail.test.ts` |

**Not editable by owners** (leader-owned, single source): `src/ui/rail.ts`,
`src/ui/tool-renderers/*`, `src/ui/adaptive-card.ts`, `src/ui/format-helpers.ts`,
`src/ui/keybinding-map.ts`. Need a new primitive? Report it, do not fork it.

**Owner checklist**
1. Import every glyph/helper from `src/ui/rail.ts` — delete local glyph
   constants, local `╭─╮` border builders, local overflow dialects.
2. Replace frame vocabulary; keep structure (panes/tables/scrolling intact).
3. Normalize hints through `formatHint()`; close action last.
4. Guard every optional interpolation on the files touched (`?? "?"`).
5. Fix the `undefined` risks listed in the audit for the owned files.
6. Write the new test file (≥5 assertions/behaviour locks, real render output —
   never a helper in isolation) and keep existing tests green.
7. Gates inside your scope: `npx biome check <files>`, `npm run typecheck`,
   `node --experimental-strip-types --no-warnings --test <your tests + touched existing tests>`.
8. **Do not rebuild `dist/`** — the leader rebuilds once at the end.

---

## 4. Known undefined / correctness risks to fix while migrating

| File:line | Risk |
|---|---|
| `src/ui/widget/index.ts` (zero-run branch) | `schedLine` unguarded → `undefined — ↓·enter` (**fixed by leader**) |
| `src/ui/live-run-sidebar.ts:223,226` | `agent.role`/`agent.agent`/`routing.resolved` from unvalidated JSON |
| `src/ui/overlays/agent-picker-overlay.ts:41` | `${agent.status} · ${agent.role}->${agent.agent}` |
| `src/ui/overlays/help-overlay.ts:33-46` | `keyToken` lacks `\t` → raw TAB inside the table |
| `src/ui/dashboard-panes/schedules-pane.ts:93,119,148-152` | persisted job fields unguarded |
| `src/ui/dashboard-panes/metrics-pane.ts:12` | `Record` label values unguarded |
| `src/ui/settings-overlay.ts:702` | `this.agents[this.selectedIndex]` out-of-range → `Edit undefined model` |
| `src/ui/tool-progress-formatter.ts:186-187` | `${active.role}->${active.agent}` (producer) |

Consistency fixes: `->` → `▸`; `→`-as-cursor → `›`; `── label ──` → `┣ SECTION`;
four overflow dialects → `overflowHint()`; 27 hint variants → `formatHint()`;
`% ctx` footer → `gaugeBar()`.

---

## 5. Release note

This ships as **0.11.1** (patch) together with the M1–M3 fixes and the R1–R3
tool-card redesign. No breaking API change is intended, but internal UI exports
were consolidated into `src/ui/rail.ts`.

---

## 6. Residual (known, not part of the sync)

1. ~~**Orphaned config:** `ui.widgetRowStyle` / `WidgetRowStyle` /
   `model.rowStyle`~~ — **REMOVED 2026-09-16** (user-approved): the whole chain
   (defaults/types/parser/TypeBox schema/schema.json/KNOWN_KEYS/model field +
   tests) is gone; the strict schema now rejects the key as unknown. Tests pin
   both directions so it cannot resurface.
2. **Parallel glyph map:** `src/ui/status-colors.ts:40-61` still carries a
   status-glyph table used for colourising plain text; not yet merged into
   `rail.ts`.
3. **Silent slices:** `progress-pane` (events −10), `transcript-pane` (output
   −12) and `metrics-pane` (counters −10) slice without an `▲/▼` overflow line —
   adding one is a content addition, not a migration.
4. **`pane-theme.ts`** (identity theme for uncoloured panes) may belong in
   `rail.ts` / `theme-adapter.ts` instead of `dashboard-panes/`.
5. **Hint derivation:** hints are built with `formatHint()` but the keys are still
   literals; deriving them from `keybinding-map.ts` needs a reverse
   `action → key` lookup plus `overlay:settings` / `overlay:agents-jobs` entries.
6. **Narrow-width clamp:** `agents-jobs-browser.ts` clamps to a 60-column minimum
   (`Math.max(60, width)`), so a narrower render emits 60-wide lines
   (pre-existing, predates RAIL).
