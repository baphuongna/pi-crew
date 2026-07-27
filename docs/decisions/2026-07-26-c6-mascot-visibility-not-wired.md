# C6 — mascot visibility gate: NOT WIRED (closed)

**Date:** 2026-07-26
**Status:** CLOSED — gate kept (tested), wiring intentionally NOT done
**Supersedes / closes:** finding C6 in `reports/ui-animation-audit-2026-07-24.md`

## Context

UI-animation-audit finding **C6** (LOW): `src/ui/mascot.ts` `tick()` calls
`requestRender()` unconditionally, even when the mascot overlay is obscured by
another overlay on top. The audit suggested adding a visibility flag
(`setVisible()`), gated by a note: *"needs visibility flag infrastructure;
bounded by 7s auto-close so low priority."*

The `setVisible()` gate was implemented + unit-tested (`mascot.ts:440`,
`test/unit/mascot.test.ts` "AnimatedMascot does not requestRender when
invisible (C6)"). The remaining question was whether to **wire** it — i.e.,
have a caller invoke `setVisible(false)` when the mascot is obscured.

## Investigation

Read the pi source (`earendil-works/pi` @ `cee5ff75`) to determine whether an
overlay component can know it is obscured:

- **`ctx.ui.custom()` exposes `onHandle?: (handle: OverlayHandle) => void`**
  (`packages/coding-agent/.../interactive-mode.ts:2448`). The `OverlayHandle`
  offers `isFocused()` — a usable *proxy* for "not obscured" (a capturing
  overlay loses focus when another opens on top). So wiring IS technically
  feasible (~5 lines: `onHandle` → `mascot.setOverlayHandle(h)`; `tick()` sets
  `this.visible = !h || h.isFocused()`).
- **BUT pi composites ALL non-hidden overlays** (`packages/tui/src/tui.ts:1044`
  filters `visibleEntries`, then `component.render()` at `:1054` for each).
  `isOverlayVisible` checks only the `hidden` flag + a terminal-dimension
  callback — **it does not account for obscuring.** So when the mascot is
  obscured, the host STILL calls `mascot.render()` (the output is computed then
  painted over by the overlay above).

## Decision

**Do NOT wire C6.** Keep the tested `setVisible()` gate (harmless, ready if pi
ever exposes a true visibility signal), but do not add the `onHandle`/`isFocused`
wiring.

## Rationale

C6 does not save the work it appears to target:

| Aspect | Saved by C6 wiring? |
|---|---|
| Mascot's `render()` (the actual paint work — ~31-col image) | **No** — host calls it during compositing regardless (`visibleEntries` includes the non-hidden mascot) |
| Mascot's animation state advancement in `tick()` | **No** — the gate is on `requestRender` only; the animation computation still runs |
| Mascot's `requestRender()` pokes | Yes — but these are **cheap + render-coalesced + redundant** whenever the obscuring overlay is itself active (dashboard/settings/mailbox all drive their own repaints) |

The only scenario where C6 saves a *real* repaint is: mascot obscured by a
**static, non-render-requesting** overlay. That is rare, bounded to the
mascot's **7 s auto-close** window, and even there the `render()` work still
runs. Net measurable benefit: near zero.

Contrast with the sibling findings that DID land: **C1** (30→10 fps) cut
repaint pressure 3× on *every* mascot frame and fixed Windows flicker; **C3**
(shared scheduler) cut 9→3 subscriptions/timers and per-event `schedule()` CPU
in active runs. C6 is an order of magnitude below either.

## Consequences

- The `setVisible()` gate stays in `mascot.ts` (tested, documented here as
  intentionally unwired). Future callers can use it if a true visibility signal
  becomes available.
- The **correct** fix for "render the mascot when obscured" is a **pi-core
  compositing optimization**: skip `render()` for overlays fully occluded by a
  higher opaque overlay. That belongs upstream in `packages/tui/src/tui.ts`
  (the `visibleEntries` compositing loop), not in pi-crew. Track as a pi
  upstream suggestion, not a pi-crew task.
- `isFocused()` is an imperfect proxy anyway (a *non-capturing* overlay on top
  would not steal focus, so the mascot would stay "focused" while painted over
  — a false-negative). Wiring it would trade a rare wasted repaint for a
  semantic mismatch; not worth it.

## Verification

- `setVisible()` gate: `test/unit/mascot.test.ts` → 7/7 pass (incl. the C6
  "does not requestRender when invisible" test).
- No production caller of `setVisible()` exists (grep confirms); the gate is
  inert but correct.
