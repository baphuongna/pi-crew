# UI samples — the pi-crew surface catalog

This directory is the **screenshot catalog** for pi-crew's TUI surfaces. Every
capture is produced by calling the **real render functions** of the shipped
components with fixture data — there are no hand-drawn mockups here. If a
surface migrates to a new design language, the capture changes the next time
the generator runs (the smoke test that the real renderers still run).

- `capture.ts` — renders all 18 surfaces and writes `captures/*.txt`.
- `render_png.py` — turns each `captures/*.txt` into a terminal-style PNG in
  `png/` (mono font, dark background, ANSI stripped) and deletes orphan PNGs.
- `captures/` — one plain-text file per surface (the source of truth).
- `png/` — generated images, one per capture.

## Regenerate

```bash
# from the pi-crew repo root
node --experimental-strip-types --no-warnings docs/ui-samples/capture.ts
python3 docs/ui-samples/render_png.py
```

`capture.ts` exits 0 and rewrites all 18 `.txt` files; `render_png.py` rewrites
every `.png` and removes any PNG whose `.txt` no longer exists, so the two
`ls` listings always match 1:1.

Requirements: Node ≥ 22 (TS runs via `--experimental-strip-types`) and Python 3
with Pillow plus `DejaVuSansMono` (Debian: `fonts-dejavu-core`).

## Surfaces

| # | Capture | Surface | Real render entry point |
|---|---|---|---|
| 1 | `01-dock-widget.txt` | Dock widget row (below the editor) — idle, busy, focused, schedules segment | `buildWidgetLines`, `buildSchedulesWidgetLine` |
| 2 | `02-task-list-widget.txt` | Task-list widget above the editor | `buildTaskListLines` |
| 3 | `03-statusline.txt` | Segment pi-crew registers in Pi's status line | `statusSummary` |
| 4 | `04-powerbar.txt` | The 4 powerbar segments + their update payloads | `updatePiCrewPowerbar` (real event bus) |
| 5 | `05-dashboard-panes.txt` | The 8 dashboard panes (1–8) + schedule detail | `renderAgentsPane`, `renderProgressPane`, … |
| 6 | `06-help-overlay.txt` | Help overlay (`?`) | `HelpOverlay.render` |
| 7 | `07-confirm-overlay.txt` | Destructive-action confirm overlay | `ConfirmOverlay.render` |
| 8 | `08-mascot.txt` | `/team-mascot` (cat + armin styles) | `AnimatedMascot.render` |
| 9 | `09-tool-renderers.txt` | `team` + `agent` tool cards: call, streaming, collapsed, expanded, brief | `teamToolRenderer` / `agentToolRenderer` |
| 10 | `10-dwf-phase.txt` | Progress pane for a dynamic-workflow run | `extractDwfPhaseState` + `renderDwfPhaseLines` |
| 11 | `11-crew-vibes.txt` | crew-vibes provider-quota footer | `renderProviderUsage` |
| 12 | `12-terminal-status.txt` | Ghostty OSC 9;4 progress + tab title sequences | `createTerminalStatusController` (escape strings shown `cat -v`) |
| 13 | `13-run-dashboard.txt` | Run dashboard `/team-dashboard` (alt+c) | `RunDashboard.render(120)` |
| 14 | `14-agents-jobs-browser.txt` | Agents & Jobs browser (`b` in the dashboard) | `AgentsJobsBrowser.render(120)` |
| 15 | `15-inline-panel.txt` | Inline panel (`ui.inlinePanel`): dock row, panel rows, editor border label | `buildWidgetLines`, `panelRowsFromRuns`, `agentBorderLabel` |
| 16 | `16-transcript-viewer.txt` | Transcript viewer `/team-transcript` | `DurableTranscriptViewer.render(100)` |
| 17 | `17-live-conversation-overlay.txt` | Live conversation overlay (`V`) of a live-session agent | `LiveConversationOverlay.render()` @100×24 |
| 18 | `18-settings.txt` | Settings overlay `/team-settings` (alt+s) — Runtime + Themes tabs | `createSettingsOverlay().overlay.render(100)` |

### Surface 15 is a partial capture

`src/ui/inline-panel/crew-editor.ts` is a Pi `CustomEditor` wrapper: it only
renders inside a live Pi TUI, so it cannot be instantiated standalone. The
capture therefore contains only parts that ARE real — the dock row the cursor
lands on (`buildWidgetLines`), the panel rows the cursor walks
(`panelRowsFromRuns`) and the border-label string the editor splices into its
top border (`agentBorderLabel`). Nothing in the file is hand-drawn; the editor
frame itself is simply not captured.

## Fixtures

- Surfaces 1–12 build their fixtures inline (manifests, tasks, agent records,
  scheduled jobs) and call the render path directly.
- Surfaces 13–18 need a run **on disk**, so capture.ts creates a throwaway cwd
  (a real `createRunManifest` → `saveRunManifest` / `saveRunTasks` /
  `saveCrewAgents` → a `transcript.jsonl` written to `agentOutputPath`), renders
  the components against it, then deletes the temp tree.
- A few painted values are live and may differ between two consecutive runs:
  the animated spinner frame, `runId`s (they embed the creation timestamp) and
  live durations. The set of generated files is always identical.

## Rules for this catalog

1. **Never hand-write a capture.** A capture must come from a real render call;
   if a surface cannot be rendered headless, capture the renderable parts and
   say so in the file's first line (as surface 15 does).
2. Keep the RAIL vocabulary of `docs/UI-DESIGN-SYSTEM.md`. The retired
   rounded-box frame glyphs (U+256D `BOX DRAWINGS LIGHT ARC DOWN AND RIGHT`,
   U+256E, U+2570, U+256F) and inline `── label ──` rules must not appear in
   any capture — surfaces open with `┏`, use `┃` bodies and close with `┗`.
3. After changing a component, re-run both commands so `captures/` and `png/`
   stay in sync.

## Known rendering caveats of the PNGs

- **Heavy box-drawing strokes look thin.** `┏ ┃ ┗ ┣` are the RAIL glyphs; the
  rendering font (DejaVu Sans Mono, the best-covered mono font on this box)
  draws their heavy variants with light strokes, so the rail looks thinner in the
  PNG than in a real terminal. The shapes are correct — this is a font trait, not
  a capture bug.
- **Glyphs absent from the font are substituted** (documented in
  `render_png.py`): braille spinner frames → `◐`, `⟳` → `↻`, `⎿` → `└`,
  `⏰`/`⏱` → `o`, `❯` → `>`. `render_png.py` fails loudly if any character has no
  glyph and no mapping, so a catalog image can never silently ship tofu boxes.
- **Live values drift between runs** (spinner frame, run ids embedding the
  creation timestamp, elapsed durations) — re-running is not byte-identical for
  the surfaces that render a live run; that is expected.
