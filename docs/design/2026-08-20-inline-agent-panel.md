# Inline Agent Panel — design

**Status:** proposed
**Date:** 2026-08-20
**Lane:** normal (per `docs/FEATURE_INTAKE.md`)
**Prior art:** `pi-subtask` v0.7.4 by Victor Mustar (MIT) — cloned to `../source/pi-subtask`, single-file `index.ts`. Attribution goes in `NOTICE.md`.

## 0. Problem

pi-crew's live agent surface is **display-only**. The widget renders rows; every
interaction requires opening a modal overlay (`/team-dashboard`, `alt+c`) which
covers the conversation and captures all input. There is no way to look at one
worker's stream, or to say something to it, without leaving the conversation.

`pi-subtask` solves the same UX problem for conversation forks and is worth
copying structurally. Its four layers, and what pi-crew has today:

| Layer | pi-subtask | pi-crew today |
|---|---|---|
| Status rows | 1 line/agent, width-budgeted | 2 lines/agent, fixed concatenation, capped at 3 |
| Keyboard | `CustomEditor`: `↓` from empty prompt → rows, `enter`/`x` | **none** — overlays only |
| Transcript | widget `placement:"aboveEditor"`, pi's native components | modal center overlay, hand-drawn box strings |
| Steer | type into the prompt, relabeled `@name` | mailbox compose form inside the dashboard |

## 1. Non-goals

- No change to how workers are spawned. In particular **stdio stays
  `["ignore","pipe","pipe"]`** (`src/runtime/child-pi/child-pi-spawn.ts:165`).
  Steering rides the existing durable channel (§5), so the child-process risk
  flag in the intake checklist is not tripped.
- No new team-tool action. The panel is a *consumer* of `team steer` /
  `team cancel`.
- The dashboard overlay stays exactly as it is. The panel is a lighter parallel
  path, not a replacement.

## 2. What pi-subtask gets right (and we should copy)

**2.1 Rows are a Component, not a `string[]`, so `render` sees the width.**
`pi-subtask/index.ts:626-660` computes a column budget instead of truncating a
pre-built string:

```
budget   = width - lead - suffix - separator
actRoom  = min(activityNatural, max(12, budget - nameNatural - 3))
nameRoom = max(12, budget - actRoom - 3)
```

Activity keeps a 12-column floor, the name expands into whatever is left, and a
final `truncateToWidth` over the assembled line is the hard guard — pi's
renderer *throws* on an over-width line. pi-crew already truncates
(`widget-renderer.ts:111,138,140`) but never negotiates: a 200-column terminal
shows the same clipped 60-char description as an 80-column one.

**2.2 Selection is stored by identity, not index.**
`panelSelId: "main" | number` (`index.ts:536-551`). When the list reorders — a
stopped worker sinking into the finished section — the cursor follows *that*
worker instead of landing on whoever took its row. A second `x` therefore acts
on the same target. An index-based cursor gets this wrong.

**2.3 The transcript is an in-document widget, not an overlay.**
The comment at `index.ts:1269-1274` records the reason they migrated away from
an overlay: an overlay is positioned against the *viewport*, so on a tall
terminal with a short session it buried the editor and footer. An `aboveEditor`
widget lives inside pi's document and pi handles the layout. pi-crew's two
transcript surfaces are both center overlays and inherit the problem they fixed.

**2.4 Native components, cached in a `WeakMap`.**
`UserMessageComponent`, `AssistantMessageComponent`, `ToolExecutionComponent`,
`Markdown`, `DynamicBorder` (`index.ts:1173-1198`), keyed on the transcript item
and dropped on theme change or when a tool result lands. Free parity with the
main conversation: real tool cards, diffs, syntax highlighting. All five are
exported from the `@earendil-works/pi-coding-agent` version pi-crew already
depends on (verified in `dist/index.d.ts:28`).

**2.5 Unhandled keys fall through to the editor.**
`index.ts:1481-1487`: any key the panel does not claim clears the selection and
calls `super.handleInput(data)`. The user never gets stuck in a mode.

**2.6 The custom editor defers to other extensions.**
`if (ctx.hasUI && !ctx.ui.getEditorComponent())` (`index.ts:1729-1733`). Only one
extension can own the editor; pi-subtask steps aside rather than clobbering a
modal-editor extension. pi-crew must do the same.

## 3. Architecture

New directory `src/ui/inline-panel/`, each module independently testable:

```
panel-selection.ts     pure state machine: identity cursor + key dispatch
panel-store.ts         observable singleton shared by editor + widget
panel-rows.ts          run list → navigable rows (same order the widget paints)
agent-transcript.ts    per-agent JSONL → typed CrewTranscriptItem[]
agent-pane.ts          CrewAgentPane component (widget, aboveEditor)
crew-editor.ts         CrewInlineEditor extends CustomEditor
index.ts               install/uninstall, wiring to ctx
```

Modified:

| File | Change |
|---|---|
| `src/ui/widget/widget-renderer.ts` | compact 1-line rows, selection marker, focused mode (uncapped) |
| `src/ui/widget/widget-formatters.ts` | `agentCost()`, `budgetedRow()` |
| `src/ui/widget/widget-types.ts`, `widget/index.ts` | `rowStyle` on the model; panel state in the cache key |
| `src/config/types.ts`, `defaults.ts` | `ui.inlinePanel`, `ui.widgetRowStyle` |
| `NOTICE.md` | pi-subtask MIT attribution |

### 3.1 `panel-selection.ts`

```ts
export type PanelTarget = { runId: string; taskId: string };
export type PanelSelection = "main" | PanelTarget | null;   // null = editor has focus
export type PanelAction =
  | { kind: "none" }                                   // key not ours; forward to editor
  | { kind: "consumed" }                               // moved the cursor
  | { kind: "open"; target: PanelTarget | undefined }  // enter; undefined = main
  | { kind: "act"; target: PanelTarget };              // x
```

`resolveIndex(rows, selection)` derives the numeric position and self-corrects to
the main row when the selected agent has vanished — pi-subtask's `panelIndex`
(`index.ts:543-551`). Row 0 is always `main`; agents start at 1.

`dispatchPanelKey(keys, rows, selection, { holdAtMain })` returns the action.
`holdAtMain: true` while the pane is open, so `↑` at the main row does not exit
navigation (`index.ts:1358-1360`). Zero I/O in this module — the whole state
machine is unit-testable with a synthetic row list.

### 3.2 `agent-transcript.ts`

**Source of truth is the on-disk per-agent event JSONL**, the same file
`readRunTranscript` reads (`transcript-viewer.ts:172-236`), written by
`appendCrewAgentEventBuffered` from the single `onJsonEvent` funnel in
`child-executor.ts:652`. Chosen over an in-memory ring buffer because
child-executor only lives in the extension process for **foreground** runs;
async runs execute in a detached spawner, so a memory feed would show an empty
pane for exactly the runs users background. Disk works for both with one parser.

Events are already compacted upstream (`child-pi-streams.ts:52-101`), retaining
`tool_execution_start` / `tool_execution_end` with `toolName` + `args`, and
`message_end` with the full `Message` (content parts, usage, model). That is
precisely the shape the native components want:

```ts
export type CrewTranscriptItem =
  | { type: "user"; text: string; seq: number }
  | { type: "assistant"; text: string; message?: unknown; seq: number }
  | { type: "tool"; name: string; toolCallId: string; args: Record<string, unknown>;
      result?: unknown; isError?: boolean; seq: number }
  | { type: "system"; text: string; seq: number };
```

`tool_execution_end` is folded into the matching `tool_execution_start` item by
`toolCallId` (pi-subtask `index.ts:909-935`) so one tool call renders as one
card. Ring-capped at `MAX_TRANSCRIPT_ITEMS = 500`, tail-read bounded by the
existing `uiConfig.transcriptTailBytes`, parsed results cached 500ms keyed on
`path + size` — the cache discipline already in `transcript-viewer.ts:37-48`.

### 3.3 `agent-pane.ts`

`CrewAgentPane` is registered as widget key `pi-crew-agent-view` with
`placement: "aboveEditor"` through the existing `setExtensionWidget` wrapper
(`src/ui/pi-ui-compat.ts:39-48`).

- Items render through `UserMessageComponent` / `AssistantMessageComponent` /
  `ToolExecutionComponent` / `Markdown`, cached in
  `WeakMap<CrewTranscriptItem, Component>`, evicted in `invalidate()` on theme
  change and when an item gains a tool result.
- Lines are emitted **verbatim at full width**. pi's message components paint
  their own edge-to-edge background and carry their own padding; indenting them
  leaves column 0 unpainted and notches the corners (pi-subtask
  `index.ts:1208-1211`).
- Height is content-sized and capped at `max(6, terminalRows - 14)` so the
  transcript above and the editor/footer below stay reachable.
- `scrollBack` counts wrapped lines from the end; 0 = tailing. Overflow markers
  `↑ N more line(s) (pageUp)` / `↓ N more (pageDown)`.
- Top rule is `DynamicBorder` themed with `theme.fg("border", …)`.
- `dispose()` **detaches only**. The pane is a window onto the run, never its
  owner; closing it must not touch worker state.

Repaint is driven by the existing shared scheduler
(`src/ui/shared-overlay-scheduler.ts:76-96`) — the pane registers alongside the
widget and dashboard rather than adding a second timer.

### 3.4 `crew-editor.ts`

`CrewInlineEditor extends CustomEditor`. Installed on `session_start` only when
`ctx.mode === "tui" && ctx.hasUI && !ctx.ui.getEditorComponent()` and
`config.ui.inlinePanel !== false`.

| Context | Key | Effect |
|---|---|---|
| prompt empty, no selection | `down` | select row 0 (`main`) |
| navigating | `up` `down` | move; `up` at main exits (or holds when pane open) |
| navigating | `return` | main → close pane; agent → open pane on it |
| navigating | `x` | running → `team cancel`; finished → dismiss from linger |
| navigating | `escape` | clear selection, back to typing |
| pane open | `pageUp` `pageDown` | scroll ±10 |
| pane open | `escape` | close pane |
| pane open | text + `return` | steer the viewed agent (§5) |
| pane open | `/…` + `return` | falls through to the **main** session |
| anything else | — | clear selection, `super.handleInput(data)` |

`render(width)` relabels the editor's top border with ` @<agent> ` when the pane
is open, so it is unambiguous where typed text lands (`index.ts:1494-1505`).

## 4. Widget row changes

New `ui.widgetRowStyle: "compact" | "detailed"`, default `"compact"`.
`"detailed"` keeps today's two-line tree renderer verbatim, so the change is
revertable by config and the existing expectations stay reachable.

Compact row, one line per agent, budgeted per §2.1:

```
  ❯ ✻ explore · 🔍 searching… · 12 tools · 45.2k tok · $0.08 · 34% ctx · 12.1 tok/s · 41s
```

- Leading marker column: `❯` selected, space otherwise; `⏺` when this agent is
  the one open in the pane, mirroring pi-subtask's filled/hollow convention.
- Cost comes from `agent.usage?.cost` via `formatCost` (`src/state/usage.ts:63`),
  the same field the dashboard agents pane already shows
  (`dashboard-panes/agents-pane.ts:132-136`). It is currently absent from the
  widget for no reason other than omission.
- `MAX_AGENTS_DISPLAY = 3` applies **only when the panel is unfocused**. With a
  selection active the list is uncapped, so every agent is reachable by keyboard
  — pi-subtask's `widgetRows()` vs `panelRows()` split (`index.ts:507-517`,
  `1098-1105`).
- Fixed-width `alignMetric` stays: it exists to stop per-tick column jitter
  (`widget-formatters.ts:71-82`), which the budget calculation does not replace.

## 5. Steering — reuse, do not rebuild

pi-crew already has the durable channel pi-subtask needed a stdin pipe for:

```
team steer {runId, taskId, message}          src/extension/team-tool.ts:537
  → append <artifactsRoot>/steering/<taskId>.jsonl   :580
      child pollSteering() every 500ms                src/prompt/prompt-runtime.ts:763-800
        → pi.sendMessage({customType:"crew-steer"}, {deliverAs:"steer"})
```

`handleSteer` is the hardened writer: terminal-task refusal, taskId-belongs-to-
manifest validation, `resolveRealContainedPath` traversal guard, growth cap, and
it never throws. The pane calls it and nothing else.

Deliberately **not** used: `nudge-agent`
(`src/extension/team-tool/api/agent-control.ts:28`) only appends to the mailbox
and relies on the broker fanout reaching a connected worker; it has no
steering-file write, so a worker with a dead broker connection silently misses
the message. `handleSteer` is the path with the durable fallback.

Delivery is at the child's next **turn boundary**, not mid-tool-call
(`child-pi-steering.ts:20-27`). The pane must say so — a `── steer queued ──`
system item is appended locally so the user sees the message was accepted even
though the worker will not react for a turn.

## 6. Risk assessment

| Flag | Tripped | Note |
|---|---|---|
| State mutation | no | `team steer` / `team cancel` own their writes |
| Concurrency | no | render path only; existing shared scheduler |
| Child process | **no** | stdio untouched; steering file already exists |
| Error handling | no | additive |
| External tools | no | |
| API contract | no | no new action or parameter |
| Backward compat | no | new config keys default-on, old renderer retained |
| Security | no | reuses `handleSteer`'s validated writer |

0 flags → **normal lane**. The intake hard gate for "child process spawning" is
specifically avoided by §1's stdio non-goal; a stdin-pipe design would have made
this high-risk and required an ADR.

Residual risks:

1. **Editor ownership.** Only one extension can hold the editor component. Guard
   with `getEditorComponent()`; when another extension owns it the panel is
   display-only and `/team-dashboard` remains the full path.
2. **Stale `ctx` across session replacement.** pi-subtask wraps every
   `setWidget` in `try/catch` (`index.ts:664-694`). pi-crew's
   `setExtensionWidget` does not; the panel adds its own guard.
3. **Over-width throw.** Mitigated by the final `truncate` over each assembled
   line and unit tests at widths 40/80/200.
4. **Cancel semantics of `x`.** Cancelling a worker is destructive mid-run, so
   `x` on a running agent asks for confirmation; dismissing a finished row does
   not.

## 7. Phasing

| Phase | Scope | Proof |
|---|---|---|
| P1 | compact budgeted row + cost + `widgetRowStyle` | width safety at 40/80/200; formatter unit tests |
| P2 | `panel-selection.ts` + `CrewInlineEditor` nav (`↓↑`/`x`/`esc`) | state-machine tests incl. reorder-follows-identity |
| P3 | `agent-transcript.ts` + `CrewAgentPane` (`enter`) | JSONL→item parser tests; pane render at 3 widths |
| P4 | steer by typing, `@agent` border label | steer routes to `handleSteer` with the right taskId |

Each phase is independently shippable and revertable by config.
