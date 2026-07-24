# UI Animation Audit — pi-crew

**Date:** 2026-07-24
**Scope:** All UI animation/render code in `src/ui/` + lifecycle wiring in `src/extension/`
**Method:** 3 parallel read-only reviewer agents (render-core infra, animation consumers, timer-hygiene sweep). Cross-validated — 2 agents independently found the same overlapping issues.
**Context:** Ran against `main` @ `1a2e5f4` (v0.9.49). Commit `1544e5b` "fix(ui): eliminate continuous UI flicker" previously fixed the cache-wipe flicker. Known unfixed: Windows event-log coalescing unreliable.

## Summary

| Severity | Count | Unique findings |
|---|---|---|
| Critical | 0 | — |
| **High** | **2** | T1 (terminal-status SIGTERM hang), C1 (mascot 30fps flicker) |
| Medium | 5 | C2, C3, C4, T2, C5 |
| Low | 8 | R1, R2, R3, R4, C6, C7, C8, C9 |
| **Total** | **15** | (deduplicated from 19 raw findings) |

**Timer hygiene baseline:** 16 timers enumerated (3 `setInterval`, 13 `setTimeout`, 0 `setImmediate`). 12 SAFE, 4 RISKY, **0 LEAKED**. Every timer has *a* clear-path; the gaps are on SIGTERM/programmatic-dismiss paths.

---

## HIGH severity

### T1 — `terminal-status.ts:211` idle re-assert loop hangs process on SIGTERM
- **CATEGORY:** leak (process-won't-exit)
- **WHAT:** `scheduleIdleReassert` is a recursive `setTimeout` with exponential backoff (200ms → 5000ms cap), re-arming itself **indefinitely** until `dispose()`. **No `.unref()`**. `dispose()` is reached from `cleanupRuntime()` on normal quit/reload/switch — but **NOT from `crew-cleanup.ts`'s SIGTERM/SIGHUP handler** (it only kills child PIDs + cleans temp dirs, never calls `cleanupRuntime()`).
- **WHY:** Because a custom SIGTERM handler overrides Node's default exit-on-SIGTERM, after the handler returns the leaked idle-timer keeps the process alive **forever** — re-asserting the terminal title every 5s in a zombie process. This is a genuine process-won't-exit bug.
- **FIX:** (a) Add `state.idleTimer.unref()` after `:211`. (b) Wire `ctx.terminalStatus?.dispose()` into `crew-cleanup.ts` SIGTERM/SIGHUP handler, OR have it call `cleanupRuntime()`.

### C1 — Mascot animates at 30fps (33ms) → Windows flicker
- **FILE:** `src/extension/registration/commands.ts:966` (`frameIntervalMs: style === "armin" ? 33 : 180`)
- **CATEGORY:** jank/flicker (performance)
- **WHAT:** The Armin mascot `tick()` calls `requestRender()` 30×/second for the full 7s auto-close window. Each tick = full TUI repaint of a 31-column image.
- **WHY:** Directly conflicts with the known "Windows terminal coalescing unreliable" constraint → visible flicker on Windows. The 33ms rate was chosen so typewriter reveals (6 chars/tick) finish in the 7s window, but the same completion is achievable at 3× lower frame rate.
- **FIX:** Set `frameIntervalMs ≈ 100` (10fps) and advance 3× more state per tick (`tickTypewriter` 18 chars, `tickScanline` 2 rows). Preserves ~3s completion, cuts repaint pressure 3×.

---

## MEDIUM severity

### C2 — `LiveConversationOverlay` wrapper doesn't expose `dispose()` (leak)
- **FILE:** `src/extension/registration/viewers.ts:88–108` → `src/ui/live-conversation-overlay.ts:59`
- *(found by both Agent 2 #2 and Agent 3 Finding 4 — cross-validated)*
- **WHAT:** The wrapper returned to Pi is `{ render, handleInput, invalidate }` — no `dispose`. Contrast: `RunDashboard`/`LiveRunSidebar`/`AnimatedMascot` are returned directly so Pi reaches `.dispose()`.
- **WHY:** If Pi dismisses the overlay programmatically (overlay replaced, session switch) without routing through `handleInput` (q/Esc), `close()` is never called. The 200ms `pollTimer` keeps firing `refreshSummary()` forever (ghost poll loop) + `session.subscribe` keeps growing the 5000-entry buffer. `.unref()`'d so no exit block, but unbounded CPU/memory.
- **FIX:** Add `dispose() { overlay.dispose(); }` to the wrapper object in `viewers.ts`.

### C3 — Three components each instantiate their own RenderScheduler
- **FILE:** `src/ui/widget/index.ts:163` + `src/ui/live-run-sidebar.ts:82` + `src/ui/run-dashboard.ts:188`
- **WHAT:** Each subscribes independently to the same 3 event channels (`run:state`, `worker:lifecycle`, `ui:invalidate`). With all 3 overlays live: 1 event → 9 callbacks, 15 live timers (3 fallback + 9 subscriptions + 3 debounce).
- **WHY:** The code comments acknowledge the "9 callbacks / ~150 invalidates/sec" problem but the fix was only per-scheduler debounce — each component still owns a scheduler. Measurable overhead during parallel research runs.
- **FIX:** Introduce a shared `RenderScheduler` at extension level; components register `onInvalidate` callbacks. The global `ctx.renderScheduler` already drives repaint — per-component schedulers are largely redundant.

### C4 — `CrewWidgetComponent.render()` computes `buildSignature` every 160ms without TTL cache
- **FILE:** `src/ui/widget/index.ts:206–207`
- **WHAT:** `render()` calls `activeWidgetRuns()` + `buildSignature()` (O(runs×agents) string work) on every invocation *before* the cache check. The dashboard mitigates this with a 100ms TTL signature cache (`SIGNATURE_CACHE_TTL_MS`); the widget has none.
- **WHY:** During active runs the host calls `render()` every ~160ms — repeated O(runs×agents) work that the cache check was supposed to avoid.
- **FIX:** Mirror the dashboard's `SIGNATURE_CACHE_TTL_MS` pattern: store `cachedSignatureAt`, return cached signature if within 100ms.

### T2 — `terminal-status.ts:233` flashTimer not `unref()`'d
- **WHAT:** One-shot 1500ms Ghostty completion-flash clear timer. Same SIGTERM gap as T1.
- **WHY:** Bounded 1500ms process-exit delay if dispose is missed. No `unref()`.
- **FIX:** Add `state.flashTimer.unref()` after `:233`.

### C5 — `live-run-sidebar.ts:273` autoCloseTimeout stacking + no `unref()`
- *(found by both Agent 2 #5 and Agent 3 Finding 3 — cross-validated)*
- **WHAT:** `this.autoCloseTimeout = setTimeout(...)` is set inside `render()` on cache-miss rebuild, overwriting the handle without clearing the prior timer.
- **WHY:** If the signature changes again within 3000ms (manifest `updatedAt` touch, final usage aggregation, agent cleanup write), the rebuild re-runs and orphans the first timer → both fire → `done()` called multiple times (double overlay dismissal). No `unref()` so stacked leaked timers delay exit.
- **FIX:** Clear-before-set: `if (this.autoCloseTimeout) clearTimeout(this.autoCloseTimeout);` before `:273`, plus `this.autoCloseTimeout?.unref()`.

---

## LOW severity

| ID | File:Line | Issue | Fix |
|---|---|---|---|
| R1 | `render-scheduler.ts:99-111` | `fallbackLoop` self-perpetuates via `schedule()`→`lastEventAt`; UI never idles (~160ms forever on a hung run) | Don't update `lastEventAt` from self-tick, or stop re-arming after N unchanged renders when idle |
| R2 | `run-snapshot-cache.ts:1010` | `scheduleRefresh` timer not `unref()` (sole inconsistency across render subsystem) | Add `.unref()` (one-line) |
| R3 | `render-coalescer.ts:68-75` | `flush()` doesn't reset `#dropped` / call `#onDrop` → corrupts UI-lag telemetry | Capture-and-reset `#dropped` in `flush()` before callback |
| R4 | `render-scheduler.ts:133-157` | `flush()` re-entrancy cap re-arms debounce (latent sustained 75ms render loop) | Add backoff on consecutive cap-hits, or defer `schedule()` via `queueMicrotask` |
| C6 | `mascot.ts:259` | `tick()` calls `requestRender` unconditionally even when obscured by another overlay | Add visibility flag; bounded by 7s auto-close so low priority |
| C7 | `lifecycle-handlers.ts:589` | When `RunDashboard` overlay open, global `renderTick` still runs `updateCrewWidget` (sidebar hides widget, dashboard doesn't) | Track `dashboardOpen` in uiState, add to hide-gate |
| C8 | `widget/widget-types.ts:28` | `CrewWidgetState.interval` field never assigned (vestigial from pre-refactor polling) — dead code | Remove field + `clearInterval` guard in `stopCrewWidget` + `lifecycle-handlers.ts:171-172` |
| C9 | `loaders.ts:17,103` | `CrewBorderedLoader` + `CountdownTimer` never instantiated anywhere — ~160 lines untested dead code | Remove or add usage + tests |

---

## Root gaps (cross-cutting)

1. **`crew-cleanup.ts` SIGTERM/SIGHUP handler doesn't call `cleanupRuntime()`** — root cause behind T1 & T2. Only kills child PIDs + cleans temp dirs. All UI timers survive SIGTERM. Wiring UI disposal into the signal handler fixes both.

2. **No test asserts the scheduler ever *stops* rendering when idle** — F1/R1's "never idles" behavior is unverified and could regress silently.

3. **`live-conversation-overlay.ts` + `live-run-sidebar.ts` have no test coverage** for timer cleanup / stacking / unref paths.

---

## Suggested fix order (by impact × risk)

| Priority | Item | Effort | Risk |
|---|---|---|---|
| P0 | T1 + T2 (unref + signal-handler dispose) | small | low |
| P0 | C1 (mascot 10fps) | small | low |
| P1 | C2 (overlay wrapper dispose) | trivial | low |
| P1 | C5 (autoClose clear-before-set) | trivial | low |
| P2 | C4 (widget signature TTL cache) | small | low |
| P2 | R2, R3 (unref + coalescer counter) | trivial | low |
| P3 | C3 (shared RenderScheduler) | medium | medium (refactor) |
| P3 | R1 (fallback idle-stop) | medium | medium (needs regression test) |
| P4 | C8, C9 (dead code removal) | trivial | low |
