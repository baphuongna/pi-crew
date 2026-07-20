# UI Flicker — Root Cause & Fix (2026-07-20)

**Target:** pi-crew v0.9.45
**Symptom (reported):** "tất cả UI của pi-crew ... hiển thị không ổn định, nhấp láy liên tục" — all pi-crew UI surfaces (widget, powerbar, live sidebar/dashboard) flickered continuously while a run was active.
**Status:** FIXED in `src/extension/registration/lifecycle-handlers.ts` (3 sites) + regression test added (`test/unit/lifecycle-flicker-regression.test.ts`, 4 tests, mutation-verified). Verified: `npm run typecheck` fully clean, 6 UI unit test files pass (44/44), bundle rebuilt.

---

## TL;DR

The run-snapshot cache has a deliberate **stale-while-revalidate** design so the widget always sees a populated snapshot between refreshes (its own source comment documents that this exact flicker was fixed once). That design was **defeated** by three hot-path call sites in `lifecycle-handlers.ts` that **hard-deleted** cache entries. The worst one wiped the **entire** cache on every ~160ms fallback tick. After each delete, `RunSnapshotCache.get()` returned `undefined`, so `activeWidgetRuns` dropped the run and the widget painted `"(loading…)"` — then the async preload rebuilt it, and the cycle repeated → continuous flicker.

---

## How the render loop works (context)

- `lifecycle-handlers.ts` installs a `RenderScheduler` driving `renderTick` (widget + powerbar + `requestRender`).
- `effectiveRefreshMs()` returns **160ms** while any run is `running/queued/planning` (aligned to the spinner), else the idle `refreshMs`.
- `RenderScheduler` fires from two sources:
  1. **Fallback loop** — `fallbackLoop()` calls `this.schedule()` with **no payload** every `effectiveRefreshMs`.
  2. **Events** — `runEventBus.onAny(...) → sched.schedule({ runId, ... })` on every agent/lifecycle event.
- `RunSnapshotCache` keeps a `Map` of `runId → snapshot`. `get()` returns `undefined` for a missing entry. `activeWidgetRuns` (widget) and `activeWidgetRuns`-equivalent filtering: when `snapshotCache` is present but `get()` is `undefined`, the run is **dropped** (`return null`) by design (P0-6: "render from snapshots only — never read disk on every render tick").

## Root cause (3 sites, all in `lifecycle-handlers.ts`)

### Site 1 — `RenderScheduler.onInvalidate` (the catastrophic one)
```ts
onInvalidate: (payload) => {
  const runId = /* extract runId from payload, else undefined */;
  ctx.getRunSnapshotCache(extensionCtx.cwd).invalidate(runId);  // ← BUG
}
```
`RenderScheduler.invalidate(payload)` forwards a **no-runId** payload straight to `onInvalidate`. Every **fallback tick** (~160ms while active) calls `schedule()` with no payload → `onInvalidate(undefined)` → `snapshotCache.invalidate(undefined)` → **`entries.clear()`** (wipes ALL snapshots). The immediately-following `renderTick` then sees `get() === undefined` for **every** run → all runs dropped → whole widget flashes to `"(loading…)"` → preload rebuilds → repeat every 160ms.

`RunSnapshotCache.invalidate`:
```ts
invalidate(runId?) { if (runId) entries.delete(runId); else entries.clear(); }
```

### Sites 2 & 3 — the two `fs.watch` change handlers
`onRunChange` (inside `buildFrame`) and `crewRunWatcherOnChange` both did:
```ts
ctx.getRunSnapshotCache(...).invalidate(runId);   // ← delete
ctx.renderScheduler?.schedule({ runId });
```
Run state files (`tasks.json`, `manifest.json`, `events.jsonl`) change frequently during a run, so these fired often and left the same empty-entry window → `get()` undefined for a frame → run dropped → flicker.

Note: the cache's **own** `run:state` / `worker:lifecycle` subscription (`scheduleRefresh` → `localRefreshIfStale`, coalesced 80ms) was correct and never deleted — but its guard is `if (entries.has(runId))`, so once an external delete removed the entry, even that self-heal stopped firing until the next full preload cycle.

## Fix

`src/extension/registration/lifecycle-handlers.ts` — replace hard-deletes with populate-preserving refreshes:

1. **`onInvalidate`**
   - no `runId` → **do nothing** (stop clearing the whole cache on every tick; `renderTick` still repaints, and the cache's internal subscription refreshes affected runs).
   - has `runId` → `refreshIfStale(runId)` (stale-while-revalidate: serves the last snapshot if fresh, rebuilds only when stamps changed — entry is never emptied).

2. **`onRunChange` + `crewRunWatcherOnChange`** → `refresh(runId)` instead of `invalidate(runId)`. The file just changed on disk, so force an in-place rebuild while keeping the entry populated (no empty window).

All three wrapped in `try/catch` with `logInternalError`.

Left unchanged: `src/extension/team-tool/cache-control.ts:15` — a user-triggered explicit cache-control action; a hard `invalidate` there is intentional and not on the render hot path.

## Why this removes the flicker

With the cache always populated, `activeWidgetRuns` returns a **stable** run set and `buildSignature` is stable except for `spinnerBucket()` (which changes every 160ms **by design** — that is smooth spinner animation, not flicker). The widget reuses its cached lines and only updates the spinner glyph in the header. The powerbar was already safe (per-segment dedup + 200ms coalescer), so it re-emits only on real content change.

## Verification

- `npm run typecheck`: **clean** (the pre-existing `run-coalesced-heartbeat-race.test.ts` errors noted in the first draft were fixed separately by changing `source: "test"` → `"builtin"`).
- UI unit tests pass (44/44, 0 fail): `run-snapshot-cache`, `render-scheduler`, `render-scheduler-cov`, `render-coalescer`, `powerbar-publisher`, `lifecycle-flicker-regression`.
- **Regression test is mutation-verified**: replacing the fixed `onInvalidate` contract with the old buggy logic (`invalidate(undefined)` on a no-runId tick) makes `lifecycle-flicker-regression.test.ts` test 3 fail, confirming the test catches the exact regression.
- `npm run build:bundle` regenerated `dist/index.mjs` (required — `index.ts` loads the bundle by default) with the fix included.

## Follow-ups

- ✅ **Regression test added** — `test/unit/lifecycle-flicker-regression.test.ts`: characterizes the destructive `invalidate(undefined)` + safe `refresh`/`refreshIfStale` APIs, and drives the full fixed `onInvalidate`/`onRunChange`/`crewRunWatcherOnChange` contract through a real `RenderScheduler` to assert a no-runId fallback tick never empties the cache and the widget never drops to `"(loading…)"`. Mutation-verified (fails on the old buggy logic).
- ✅ **`npm run typecheck` green** — the pre-existing `run-coalesced-heartbeat-race.test.ts` errors (`source: "test"` not assignable to `ResourceSource`) were fixed by changing the literal to `"builtin"`.
- ⏳ **Optional hardening (not done)**: make `activeWidgetRuns` keep the last-known run row (instead of `null`) when `get()` is momentarily `undefined`, as a belt-and-suspenders guard against any future delete path. Low priority now that all render-path deletes are eliminated.
- ⏳ **Optional refactor**: extract the `onInvalidate`/`onRunChange`/`crewRunWatcherOnChange` handlers from the `setupRenderLoop` closure into exported, directly-testable functions, so a future regression test can import the *real* handler rather than replicate its contract.
