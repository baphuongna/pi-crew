# pi-crew Deep Review 2026-07-20 — Remediation Plan

**Target version:** pi-crew v0.9.44 (post-remediation: v0.9.45+)
**Baseline report:** `pi-crew/reports/deep-review-2026-07-20.md`
**Method:** Every cited `file:line` re-read in the current checkout (v0.9.44, last commit 2026-07-19). Findings verified by directly reading source, not trusting the report.
**Verification result:** **14/14 CONFIRMED** (0 changed, 0 resolved, 0 false positives)

---

## 1. Finding Verification Table

| ID | Status | Sev | Area | Verified Notes |
|----|--------|-----|------|----------------|
| FIND-01 | ✅ CONFIRMED | P1 | perf | `mailbox.ts:380` readDeliveryState + `:398` writeDeliveryState full RMW confirmed. Delivery mutations in `appendMailboxMessage` (`:475-490`) and `acknowledgeMailboxMessage` (`:561-573`) both do full read+rewrite under `withFileLockSync`. No in-memory cache exists. |
| FIND-02 | ✅ CONFIRMED | P1 | perf | `mailbox.ts:~467` uses `withEventLogLockSync` → `event-log.ts:165` `sleepSync(50)`. **Also:** `withFileLockSync` used for delivery.json (`mailbox.ts:~483`) ALSO uses `sleepSync` at `locks.ts:420` — same hazard. `@deprecated` + `SECURITY WARNING` at `event-log.ts:75-82`. |
| FIND-03 | ✅ CONFIRMED | P2 | perf | `manifest-cache.ts:281-306` listActive has no TTL cache. `collectRoots` + `activeRunEntries` + per-entry `parseManifestIfChanged` on every call. Comment at `:283-287` confirms deliberate full scan. |
| FIND-04 | ✅ CONFIRMED | P2 | perf | `run-metrics.ts:110-135` reads up to `MAX_METRIC_FILES_TO_SCAN` files via `loadRunMetrics` → `readJsonFile` (sync `readFileSync` + `JSON.parse`) before sorting/slicing. |
| FIND-05 | ✅ CONFIRMED | P2 | perf | `event-log.ts:1168` readEvents does full `readFileSync`+`split("\n")`+`JSON.parse`. `:1227-1244` readEventsCursor calls it on the default path. Tail-cap (5000) + warning log present at `:1229-1237`. |
| FIND-06 | ✅ CONFIRMED | P2 | correctness | `run-coalesced-task-group.ts:89-107` heartbeat `setInterval(async...)` with no in-flight guard. Final result write at `:127-175` via `saveRunTasksAsync(manifest, updatedTasks)`. `clearInterval` in `finally` at `:126` but doesn't await pending heartbeat. |
| FIND-07 | ✅ CONFIRMED | P2 | maint | `widget-renderer.ts:176` exported `renderLines`. Identical private copies at `run-dashboard.ts:162` and `live-run-sidebar.ts:22`. All three: `new Box(0,0)` + `addChild(new Text(line))` + `box.render(width)`. |
| FIND-08 | ✅ CONFIRMED | P2 | maint | `auto-resume.ts`, `notebook-helpers.ts`, `orphan-sentinel.ts`: grep for `import ... from ".*auto-resume"` across `src/` = **0 matches**. Only prose references (comments in `loop-gates.ts`, `compaction-guard.ts`). `dist/index.mjs` bundle: **0 matches**. Test-only refs in `test/unit/{auto-resume,notebook-helpers,orphan-sentinel-cov}.test.ts`. |
| FIND-09 | ✅ CONFIRMED | P2 | types | `resilient-edit.ts:6` ToolLike interface `[key: string]: any`, `:33` `execute(... params: any, signal: any, onUpdate: any)`, `:66` `const piAny = pi as any`, `:97` retryWithReplace `params: any, ... signal: any, onUpdate: any`. All with `eslint-disable @typescript-eslint/no-explicit-any`. |
| FIND-10 | ✅ CONFIRMED | P3 | perf | `event-log.ts:598-604` double-open: `fs.promises.open(eventsPath, "r+")` → `fd.sync()` → `fd.close()` AFTER `appendFile`. Stats at `:537`, `:556`, `:580`, `:630` (3-4 per event). **Correction confirmed:** fsync comment at `:598-600` is intentional seq-integrity protection — **must NOT remove**. |
| FIND-11 | ✅ CONFIRMED | P2 | security | `run-import.ts:58-77` hash recomputed over bundle's own contents (sha256 field stripped) and compared to `manifest.sha256` embedded in same bundle. When absent, check skipped entirely (`:67` `if (parsedForHash.manifest?.sha256)`). |
| FIND-12 | ✅ CONFIRMED | P3 | security | `role-permission.ts:14-37`: `permissionForRole` returns `"workspace_write"` for ANY unrecognized role (line 23: `return "workspace_write"`). **Note:** existing test `role-permission-cov.test.ts:63` explicitly asserts this: `permissionForRole("unknown-role") === "workspace_write"` — fix will break it. |
| FIND-13 | ✅ CONFIRMED | P3 | maint | `task-packet.ts:88` TODO + `discover-agents.ts:123` TODO. Both present, benign. |
| FIND-14 | ✅ CONFIRMED | P3 | security | `async-runner.ts:311-321` `flushStderr` writes raw `${body}` to `background.log` via `fs.appendFileSync` with no `redactSecretString`. **Also:** `async-runner.ts` does NOT import `redactSecretString` at all — import must be added. |

---

## 2. Per-Finding Detailed Design

### FIND-01 · P1 · `delivery.json` O(N²) read-modify-write

**Target:**
- `src/state/mailbox.ts:380-429` — `readDeliveryState` (`:380`), `writeDeliveryState` (`:398`)
- Delivery RMW sites: `appendMailboxMessage` (`:475-490`), `acknowledgeMailboxMessage` (`:561-573`)

**Approach:**
1. Add a module-level in-process delivery cache: `const deliveryCache = new Map<string, { mtimeMs: number; state: MailboxDeliveryState }>()` keyed by `deliveryFile(manifest)`.
2. Modify `readDeliveryState` to check cache first: `stat` the delivery file; if `mtimeMs` matches the cache, return cached state. Otherwise fall through to `readFileSync` + `JSON.parse` (existing logic).
3. After `writeDeliveryState` completes, update the cache with the written state + the post-write `mtimeMs` (from `atomicWriteFile`'s return or a quick `statSync`). This invalidates the cache on our own writes, preventing stale reads by the same process.
4. Cross-process invalidation: The `withFileLockSync` wrapper already serializes writes. The mtime check in `readDeliveryState` handles external writes (another process wrote between our cached read and a concurrent external write — but since we hold the lock during RMW, this is safe within the same process; the mtime check catches cross-process changes).
5. **Alternative (append-only log):** If the cache approach proves insufficient, move delivery status to an append-only `delivery.jsonl` (like the event log) with periodic compaction. This is more invasive — prefer the cache approach first.

**Dependencies / conflicts:** No other finding touches `deliveryCache` or `readDeliveryState`/`writeDeliveryState`. FIND-02 touches the same file's lock mechanism but different code paths.

**Test strategy:**
- **Must stay green:** `test/unit/mailbox-cov.test.ts` (delivery ack roundtrip at `:287-300`), `test/integration/phase8-smoke.test.ts` (delivery state checks at `:194-196`), `test/integration/operator-experience.test.ts` (delivery roundtrip at `:54-98`).
- **New test:** Add a test in `mailbox-cov.test.ts` that verifies: (a) rapid sequential `appendMailboxMessage` calls don't re-read the file (cache hit), (b) after an external write (simulate by `utimesSync` to bump mtime), `readDeliveryState` returns fresh data, (c) cache correctness after `acknowledgeMailboxMessage` (cached state reflects the ack).

**Verification gate:** `npm run typecheck` + `npm test` (all mailbox tests green) + manual: run a 50-message stress test in a temp run, confirm no `delivery.json` corruption or stale entries.

**Regression risk + mitigation:** Report says **medium** — delivery correctness is load-bearing for handoffs. Mitigate: cache invalidation is purely additive (cache miss falls through to existing read path); if any doubt, set `deliveryCache.clear()` at process start.

---

### FIND-02 · P1 · Mailbox append blocks the event loop via `sleepSync`

**Target:**
- `src/state/mailbox.ts:~467` — `withEventLogLockSync` in `appendMailboxMessage`
- `src/state/mailbox.ts:~483` — `withFileLockSync` for delivery RMW in `appendMailboxMessage` (and same in `acknowledgeMailboxMessage` `:562`)
- `src/state/event-log.ts:165` — `sleepSync(50)` (the root cause)

**Approach:**
1. Create `appendMailboxMessageAsync(manifest, message)` as a new async export. This mirrors the sync version but:
   - Replaces `withEventLogLockSync` → `withEventLogLockAsync` (already exists at `event-log.ts:434`, uses promise-chain lock, no `sleepSync`).
   - Replaces `fs.appendFileSync` → `fs.promises.appendFile`.
   - Replaces `rotateMailboxFileIfNeeded` → an async variant (or call the sync version — it's a single `statSync` + optional `renameSync`, very fast, acceptable inside the async lock).
   - Replaces `withFileLockSync` → a new `withFileLockAsync` (add to `src/state/locks.ts` mirroring the promise-chain pattern of `withEventLogLockAsync`, or use the existing `asyncLocks` pattern).
   - Replaces `readDeliveryState`/`writeDeliveryState` → async variants (or reuse sync versions if the cache from FIND-01 makes them cheap enough).
2. Route the **live-session steering send path** through `appendMailboxMessageAsync`. Grep for callers: `appendSteeringMessage` / `appendFollowUpMessage` (mailbox.ts:517-556) — these are called from `handleSteer`/`handleFollowUp` in the live-agent path. Make those callers async.
3. Keep the sync `appendMailboxMessage` as-is for non-live paths (team-runner spawn, which runs synchronously before workers start).

**Dependencies / conflicts:** Touches `src/state/mailbox.ts` (same file as FIND-01). Touches `src/state/locks.ts` (add `withFileLockAsync`). Touches live-agent callers (need to identify exact files — grep for `appendSteeringMessage` / `appendFollowUpMessage` callers).

**Test strategy:**
- **Must stay green:** `test/unit/mailbox-cov.test.ts`, `test/unit/mailbox-semantics.test.ts`, `test/integration/phase8-smoke.test.ts`.
- **New test:** Add `test/unit/mailbox-async.test.ts` — verify `appendMailboxMessageAsync` produces identical results to the sync variant (same message ID format, same delivery state, same mailbox file content). Test that the event loop is not blocked (set a timer that fires during the async append, assert it completes).

**Verification gate:** `npm run typecheck` + `npm test` + manual: in a live session, send a steering message while a worker is executing; confirm no event-loop stall.

**Regression risk + mitigation:** Report says **low-medium**. The sync path remains for non-live callers. The async path is additive — if any issue, callers can fall back to sync. Risk: the promise-chain lock for `withFileLockAsync` is in-process only (not cross-process like the O_EXCL lock). If mailbox writes happen from multiple processes, this is a concern. Check: does pi-crew ever have multiple processes writing to the same mailbox? (Likely no — the team-runner is a single process with child workers that don't write to mailbox directly.)

---

### FIND-03 · P2 · `listActive()` uncached full scan

**Target:**
- `src/runtime/manifest-cache.ts:281-306` — `listActive()` function
- Related: `:305-319` — `fs.watch` + `scheduleListRefresh` already exists for `list()`

**Approach:**
1. Add a module-level `listActiveCache: { result: TeamRunManifest[] | null; expiresAt: number }` scoped to the `createManifestCache` closure.
2. At the top of `listActive`, check `Date.now() < listActiveCache.expiresAt` → return cached result.
3. If expired, run the existing full scan, store result, set `expiresAt = Date.now() + 500` (same TTL as `list()`'s 500ms `listCache`).
4. The existing `scheduleListRefresh` (called by `fs.watch` handler) should also clear `listActiveCache.expiresAt = 0` so the next call re-scans.

**Dependencies / conflicts:** No other finding touches this file.

**Test strategy:**
- **Must stay green:** Grep `test/` for `manifest-cache` or `listActive` — likely `test/unit/manifest-cache*.test.ts` if it exists, plus any crash-recovery tests.
- **New test:** Verify cache hit (second call within TTL returns same array reference), cache invalidation (after `scheduleListRefresh`, next call re-scans), and that "all running" semantics are preserved (not capped by `list()`'s top-N).

**Verification gate:** `npm run typecheck` + `npm test`.

**Regression risk + mitigation:** Report says **low**. The cache is purely a read optimization; TTL is short (500ms); `fs.watch` invalidates immediately on file system changes. Risk: a run starts in the 500ms window and isn't detected by crash-recovery — mitigated by the short TTL and `fs.watch` invalidation.

---

### FIND-04 · P2 · `getRunMetricsSummary` reads up to 500 files synchronously

**Target:**
- `src/state/run-metrics.ts:110-135` — `getRunMetricsSummary`

**Approach:**
1. After `readdirSync`, sort dirents by mtime descending: `entries.sort((a, b) => b.mtimeMs - a.mtimeMs)`. Note: `readdirSync` with `{ withFileTypes: true }` doesn't return `mtimeMs`. Use `fs.statSync(path.join(dir, entry.name)).mtimeMs` per entry — but that's O(N) stats. Better: sort by the run-id timestamp embedded in the filename (run IDs contain timestamps: `team_20260720050617_...`), or do a single `stat` pass + sort.
2. After sorting, read only the first `limit` entries (not `MAX_METRIC_FILES_TO_SCAN`): change the loop condition from `metrics.length >= MAX_METRIC_FILES_TO_SCAN` to `metrics.length >= limit`.
3. Keep `MAX_METRIC_FILES_TO_SCAN` as a safety cap on total dirents scanned.

**Dependencies / conflicts:** No other finding touches this file.

**Test strategy:**
- **Must stay green:** Grep for `getRunMetricsSummary` or `run-metrics` in `test/`.
- **New test:** Create 30 metric files with different timestamps; request `limit=5`; verify only 5 files were read (can instrument `readJsonFile` or check via mock), and they are the 5 newest.

**Verification gate:** `npm run typecheck` + `npm test`.

**Regression risk + mitigation:** Report says **low**. The sort order changes from directory-order to mtime-order, which is the correct order (callers want newest). Risk: files with same mtime — handle with filename tiebreaker.

---

### FIND-05 · P2 · `readEventsCursor` full parse on default path

**Target:**
- `src/state/event-log.ts:1168-1183` — `readEvents` (full read)
- `src/state/event-log.ts:1227-1244` — `readEventsCursor` default path calling `readEvents`
- Hot callers: `src/extension/status.ts`, `src/extension/inspect.ts`, `src/extension/run-export.ts`, `src/extension/attention-events.ts`, `src/extension/diagnostic-export.ts`

**Approach:**
1. In `readEventsCursor`, when `fromByteOffset` is undefined, instead of calling `readEvents` (full read), read the **tail** of the file directly: `fs.statSync` to get size, `fs.read` the last N bytes (e.g., 1MB), split by newline, `JSON.parse` each line. This bounds CPU to O(tail bytes) instead of O(total events).
2. The code at `:1229-1237` already does this conceptually (`all.slice(-5000)` after full parse) — move the slice to a byte-level tail read so the full parse never happens.
3. A `readJsonlSince(eventsPath, byteOffset)` function already exists (referenced in report). Use it or implement a `readJsonlTail(eventsPath, tailBytes)` helper.
4. Migrate hot UI callers (status, inspect) to pass `fromByteOffset` when they only need recent events. The `readEventsCursor` tail-read default makes this optional but callers that know they want the full history should pass `fromByteOffset` explicitly.

**Dependencies / conflicts:** FIND-10 touches `event-log.ts` but a different function (`appendEventAsync` body at `:520-680`). Different code region — safe to parallelize with care.

**Test strategy:**
- **Must stay green:** `test/unit/event-log-seq-uniqueness.test.ts`, any tests referencing `readEventsCursor` or `readEvents`.
- **New test:** Create a 10000-event log; call `readEventsCursor` without `fromByteOffset`; verify it returns only tail events (≤5000) and does NOT do a full `readFileSync` (can verify via timing or mock).

**Verification gate:** `npm run typecheck` + `npm test` + manual: generate a large event log (>5000 events) and verify `readEventsCursor` latency drops.

**Regression risk + mitigation:** Report says **low**. The tail-cap behavior is already documented and tested. Risk: callers that actually need the full history on the default path — but the warning log at `:1229` already flags this. Check: are any callers relying on getting ALL events from the default path?

---

### FIND-06 · P2 · Heartbeat `setInterval` races final result write

**Target:**
- `src/runtime/run-coalesced-task-group.ts:89-107` — heartbeat `setInterval(async () => { ... })`
- `:126` — `clearInterval(heartbeatTimer)` in `finally`
- `:127-175` — final result `updatedTasks.map(...)` + `saveRunTasksAsync(manifest, updatedTasks)`

**Approach:**
1. **In-flight guard:** Add a `let heartbeatInFlight = false` flag. At the top of the heartbeat callback: `if (heartbeatInFlight) return;` — set `heartbeatInFlight = true` before the async work, `false` after `await saveRunTasksAsync` completes (in `finally`).
2. **Await pending heartbeat before final write:** Before the final result `saveRunTasksAsync(manifest, updatedTasks)` at `:175`, add:
   ```
   clearInterval(heartbeatTimer);
   if (heartbeatInFlight) {
   	// Wait for the pending heartbeat save to complete before writing terminal results.
   	// A late heartbeat flush captured a pre-terminal snapshot and could clobber our results.
   	await waitForHeartbeatDrain(); // simple: a promise that resolves when heartbeatInFlight=false
   }
   ```
   Or simpler: track a `heartbeatPromise: Promise<void> | null` set to the current save promise, and `await heartbeatPromise` before the final write.
3. **Terminal-state safety (belt-and-suspenders):** In the heartbeat callback's `saveRunTasksAsync`, skip tasks that are already terminal (`status === "completed" || status === "failed"`): `updatedTasks = updatedTasks.map((t) => { if (taskIds.includes(t.id) && (t.status === "completed" || t.status === "failed")) return t; ... })`. This ensures a late heartbeat can't overwrite terminal status even if it somehow races.

**Dependencies / conflicts:** No other finding touches this file.

**Test strategy:**
- **Must stay green:** Grep for `coalesced` in `test/` — `test/unit/atomic-write-coalesced.test.ts` (related but different file), and any coalesced dispatch tests.
- **New test:** `test/unit/run-coalesced-heartbeat-race.test.ts` — mock `saveRunTasksAsync` to delay >15s on the heartbeat tick; verify the final result write is not clobbered. Assert terminal statuses survive.

**Verification gate:** `npm run typecheck` + `npm test`.

**Regression risk + mitigation:** Report says **low**. The guard is additive (skip-if-in-flight + await-drain). Risk: a stuck heartbeat save blocks the final result indefinitely — mitigate with a timeout on the drain wait (e.g., 5s max).

---

### FIND-07 · P2 · `renderLines()` duplicated ×3

**Target:**
- `src/ui/widget/widget-renderer.ts:176` — exported `renderLines` (keep this as canonical)
- `src/ui/run-dashboard.ts:162` — private `renderLines` (delete)
- `src/ui/live-run-sidebar.ts:22` — private `renderLines` (delete)

**Approach:**
1. In `run-dashboard.ts`: delete the private `renderLines` function (`:162-168`), add `import { renderLines } from "./widget/widget-renderer.ts"` (check existing imports — may already import from this module).
2. In `live-run-sidebar.ts`: delete the private `renderLines` function (`:22-28`), add `import { renderLines } from "./widget/widget-renderer.ts"`.
3. Verify the exported version is API-compatible (same signature `(lines: string[], width: number) => string[]`). Confirmed: all three are identical.

**Dependencies / conflicts:** No other finding touches these UI files.

**Test strategy:**
- **Must stay green:** `test/unit/run-dashboard.test.ts` (renders dashboard), any UI render tests.
- **No new test needed** — behavior is identical; the test suite validates rendering.

**Verification gate:** `npm run typecheck` + `npm test` + `npm run lint` (verify no unused imports).

**Regression risk + mitigation:** Report says **very low**. The functions are byte-for-byte identical. Risk: import path resolution — verify the import path is correct relative to each file.

---

### FIND-08 · P2 · Three orphan modules (test-only)

**Target (delete):**
- `src/runtime/auto-resume.ts` (entire file, 100 LOC)
- `src/runtime/notebook-helpers.ts` (entire file, ~90 LOC)
- `src/runtime/orphan-sentinel.ts` (entire file, no-op placeholder)
- `test/unit/auto-resume.test.ts`
- `test/unit/notebook-helpers.test.ts`
- `test/unit/orphan-sentinel-cov.test.ts`

**Approach:**
1. **Pre-deletion verification (CRITICAL):**
   - Confirmed: `grep 'from ".*auto-resume"' src/` = 0 matches.
   - Confirmed: `grep 'from ".*notebook-helpers"' src/` = 0 matches.
   - Confirmed: `grep 'from ".*orphan-sentinel"' src/` = 0 matches.
   - Confirmed: `grep 'auto-resume|notebook-helpers|orphan-sentinel' dist/*.mjs` = 0 matches (bundle doesn't include them).
   - Check `index.bundle.ts` for any dynamic `import()` references — run `grep` for module names in `index.bundle.ts`.
   - Check `.workflow.md` / `.dwf.ts` / agent config files for any references.
2. Delete the 3 source files + 3 test files.
3. Run `npm run typecheck` + `npm test` to confirm nothing breaks.

**Dependencies / conflicts:** No other finding touches these files.

**Test strategy:**
- **Must stay green:** All tests except the 3 being deleted.
- After deletion, verify `npm test` still passes (the deleted tests only asserted that the modules load).

**Verification gate:** `npm run typecheck` + `npm test` + `npm run check:lazy-imports` + manual: `grep -r 'auto-resume\|notebook-helpers\|orphan-sentinel' src/ test/` returns only the (now-deleted) entries.

**Regression risk + mitigation:** Report says **low** — "confirm no dynamic/bundle reference first." The grep verification above is the mitigation. If any reference is found, abort deletion and wire the module in instead.

---

### FIND-09 · P2 · `resilient-edit.ts` `any` cluster

**Target:**
- `src/runtime/resilient-edit.ts:6-9` — `ToolLike` interface (`execute: (...) => Promise<unknown>`, `[key: string]: any`)
- `:33` — `execute` signature `params: any, signal: any, onUpdate: any`
- `:66` — `const piAny = pi as any`
- `:97` — `retryWithReplace(params: EditParams, ..., signal: any, onUpdate: any)`

**Approach:**
1. Define a minimal `EditToolLike` interface replacing the `any`-typed `ToolLike`:
   ```ts
   interface EditToolExecute {
   	(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown): Promise<unknown>;
   }
   interface EditToolLike {
   	name: string;
   	description: string;
   	parameters: unknown;
   	execute: EditToolExecute;
   }
   ```
2. Replace `params: any` → `params: unknown` in `execute` and `retryWithReplace`. Inside `retryWithReplace`, cast to `EditParams` (already typed): `const p = params as EditParams;`.
3. Replace `signal: any` → `signal: unknown` (it's just passed through to `nativeExecute`).
4. Replace `onUpdate: any` → `onUpdate: unknown` (same pass-through).
5. Remove the `[key: string]: any` index signature from the interface — if any code accesses dynamic properties, use `Record<string, unknown>` or a typed accessor.
6. For `piAny` at `:66`: define a minimal typed accessor:
   ```ts
   interface PiExtensionList {
   	name?: string;
   }
   function getLoadedExtensions(pi: ExtensionAPI): PiExtensionList[] {
   	const any_pi = pi as unknown as { extensions?: PiExtensionList[]; _extensions?: PiExtensionList[] };
   	const ext = any_pi.extensions ?? any_pi._extensions ?? [];
   	return Array.isArray(ext) ? ext : Object.values(ext);
   }
   ```
7. Remove all `eslint-disable @typescript-eslint/no-explicit-any` comments.

**Dependencies / conflicts:** No other finding touches this file.

**Test strategy:**
- **Must stay green:** Grep for `resilient-edit` in `test/` — likely `test/unit/resilient-edit*.test.ts`.
- **New test:** Verify `wrapEditWithResilientReplace` still works with the typed interface (existing tests should cover this).

**Verification gate:** `npm run typecheck` + `npm test` + `npm run lint` (no `no-explicit-any` violations in this file).

**Regression risk + mitigation:** Report says **low**. The `any` is a deliberate boundary shim — replacing with `unknown` is type-safe (callers must cast). Risk: type errors in downstream callers — but `unknown` is strictly safer than `any`.

---

### FIND-10 · P3 · `appendEventAsync` double-open fsync + redundant stats

**Target:**
- `src/state/event-log.ts:598-604` — double-open for fsync (open → sync → close after appendFile)
- `:537` — stat for overflow pre-check
- `:556` — post-compact stat
- `:580` — size-check stat (inside `skippedDueToSize` block)
- `:630` — cache-update stat

**⚠️ CORRECTION APPLIED:** The fsync at `:598-604` is **intentional seq-integrity protection** (comment at `:598-600` documents closing the crash window between `appendFile` and `persistSequence`). **DO NOT remove the fsync.**

**Approach:**
1. **Eliminate double-open:** Replace the `appendFile` → separate `open(r+)` → `sync()` → `close()` sequence with a single-fd approach:
   ```ts
   // Open once, append, fsync, close — single fd lifecycle.
   const fd = await fs.promises.open(eventsPath, "a");
   try {
   	await fd.appendFile(line, "utf-8");
   	await fd.sync(); // fsync while we still hold the fd
   } finally {
   	await fd.close();
   }
   ```
   This uses `flag: "a"` (append mode) with `fd.appendFile` + `fd.sync()` on the same fd — eliminating the second `open`.
2. **Collapse redundant stats:** The stats at `:537` (overflow pre-check), `:556` (post-compact), `:580` (size-check), `:630` (cache-update) serve different purposes. Collapse where possible:
   - Reuse the initial stat (`:537`) result for both the overflow check and the size check if they're in the same code path.
   - The post-compact stat (`:556`) is genuinely needed (file changed after compaction).
   - The cache-update stat (`:630`) could be replaced by the stat from the append operation itself if we track the file size after `fd.appendFile` (via `fd.stat()` on the same fd, avoiding a separate path stat).

**Dependencies / conflicts:** FIND-05 touches the same file (`event-log.ts`) but different functions (`readEvents`/`readEventsCursor` at `:1168+`). Safe to parallelize if both stay in their respective code regions.

**Test strategy:**
- **Must stay green:** `test/unit/event-log-seq-uniqueness.test.ts` (CRITICAL — this test verifies no duplicate seqs under concurrent appends), `test/unit/event-log-rotation.test.ts`, `test/unit/event-log-batch.test.ts`, `test/unit/crew-agent-seq-cache-cap.test.ts`.
- **New test:** Add a test to `event-log-seq-uniqueness.test.ts` that verifies crash-safety: write events, simulate crash (don't call `persistSequence`), restart, verify no seq reuse. (This may already exist — check.)

**Verification gate:** `npm run typecheck` + `npm test` (ALL event-log tests must pass) + manual: run the seq-uniqueness test with `--test-concurrency` to stress-test.

**Regression risk + mitigation:** Report says **medium** — touches the seq-integrity hot path. Mitigate: the fsync is preserved (just done on the same fd); the seq-uniqueness tests are the primary safety net. If `fd.appendFile` doesn't support the append mode correctly on all platforms, fall back to the original double-open approach.

---

### FIND-11 · P2 · Import-bundle SHA-256 self-referential

**Target:**
- `src/extension/run-import.ts:58-77` — integrity check block

**Approach:**
1. **Option A (document + harden, low effort):** Add a prominent comment that the SHA-256 is corruption-detection only, NOT authenticity. Add a `logSecurityEvent` call when importing a bundle, so imports are auditable. This is the pragmatic fix — the blast radius is already bounded (writes to `imports/<runId>/`, no code execution, `isContained` + `assertSafePathId` validated).
2. **Option B (signature, medium effort):** Add an optional HMAC-SHA256 signature verified against a pre-shared key (env var `PI_CREW_IMPORT_KEY`). If the key is set, require a valid signature; if not, fall back to the existing corruption check + security event log.
3. **Recommended:** Option A now, Option B later if import from untrusted sources becomes a use case.

**Dependencies / conflicts:** No other finding touches this file.

**Test strategy:**
- **Must stay green:** Any `run-import` tests (grep `test/` for `run-import` or `importRun`).
- **New test:** Verify that a tampered bundle with a matching hash still triggers the security event log (so it's auditable). Verify that a bundle with no hash is still imported (corruption check skipped) but logged.

**Verification gate:** `npm run typecheck` + `npm test`.

**Regression risk + mitigation:** Report says **low**. Option A is comment + log only — no behavior change. Option B adds an opt-in security layer.

---

### FIND-12 · P3 · Custom roles default to write/spawn

**Target:**
- `src/runtime/role-permission.ts:14-37` — `permissionForRole` function

**⚠️ BREAKING CHANGE:** Line 23 `return "workspace_write"` for unknown roles will change to `return "read_only"` (or an explicit opt-in mechanism).

**Approach:**
1. Change `permissionForRole` to default-deny:
   ```ts
   export function permissionForRole(role: string): RolePermissionMode {
   	if (READ_ONLY_ROLES.has(role)) return "read_only";
   	if (WRITE_ROLES.has(role)) return "workspace_write";
   	// Default-deny: unknown/custom roles get read-only unless explicitly opted in.
   	return "read_only";
   }
   ```
2. **Migration path for custom agents:** Add an opt-in mechanism: check the agent config for a `permissions` field (e.g., `permissions: { workspaceWrite: true }`). If set, return `"workspace_write"` for that custom role.
3. **Update the existing test** `role-permission-cov.test.ts:63` — change the assertion from `"workspace_write"` to `"read_only"` for unknown roles.
4. **Add a CHANGELOG/migration note:** Custom agent roles that relied on the permissive default now need explicit permission configuration.

**Dependencies / conflicts:** No other finding touches this file.

**Test strategy:**
- **Must update:** `test/unit/role-permission-cov.test.ts:63` (change expected from `"workspace_write"` to `"read_only"`).
- **Must stay green:** `test/unit/role-permission.test.ts`, `test/unit/role-permission.spawn.test.ts` (check if they test unknown roles).
- **New test:** Verify that a custom role with `permissions: { workspaceWrite: true }` in agent config returns `"workspace_write"`.

**Verification gate:** `npm run typecheck` + `npm test`.

**Regression risk + mitigation:** Report says **medium** — could break existing custom agents. Mitigate: document the migration path clearly in CHANGELOG. Consider a deprecation period: log a warning when an unknown role gets write access, then enforce default-deny in the next minor version. **Decision needed:** hard break vs. deprecation warning.

---

### FIND-13 · P3 · Two tracked TODOs

**Target:**
- `src/runtime/task-packet.ts:88` — TODO comment
- `src/agents/discover-agents.ts:123` — TODO comment

**Approach:**
1. `task-packet.ts:88`: The TODO says "Once TaskPacket type gains a hashId field, include this in the packet." The `_taskHashId` is computed but unused (prefixed with `_`). Either: (a) add `hashId` to the TaskPacket type and include it, or (b) convert the TODO to a tracked issue and add `// @see ISSUE-XXX` reference.
2. `discover-agents.ts:123`: The TODO says "In production, integrate with project's logging infrastructure." Convert to a tracked issue or add a configurable log sink.

**Dependencies / conflicts:** No other finding touches these files. If option (a) for task-packet is chosen, it touches the `TaskPacket` type (in `task-packet.ts` or `types.ts`).

**Test strategy:** N/A (comment/issue changes).

**Verification gate:** `npm run typecheck` + `npm test` (no behavioral change).

**Regression risk + mitigation:** Report says **none**. These are documentation/issue-tracking changes.

---

### FIND-14 · P3 · Background-runner stderr unredacted

**Target:**
- `src/runtime/async-runner.ts:311-321` — `flushStderr` function
- `:1-12` — imports (need to add `redactSecretString`)

**Approach:**
1. Add import: `import { redactSecretString } from "../utils/redaction.ts";` at the top of `async-runner.ts`.
2. In `flushStderr` (`:311-321`), route `body` through `redactSecretString` before appending:
   ```ts
   const redacted = redactSecretString(body);
   fs.appendFileSync(logPath, `[child stderr] ${redacted}${redacted.endsWith("\n") ? "" : "\n"}`, "utf-8");
   ```
3. Also redact the truncation message at `:321` (though that message is static, no secrets — but for consistency).

**Dependencies / conflicts:** No other finding touches this file.

**Test strategy:**
- **Must stay green:** `test/unit/background-runner*.test.ts` if it exists.
- **New test:** Add a test that captures stderr containing a fake API key pattern and verifies it's redacted in `background.log`.

**Verification gate:** `npm run typecheck` + `npm test`.

**Regression risk + mitigation:** Report says **very low**. Redaction is purely additive — it only removes secret patterns. Risk: false-positive redaction in error messages — but `redactSecretString` is already used throughout the codebase and tested.

---

## 3. Phased Sequencing with Gates + Parallelism Map

### Phase 1: Mailbox Performance (FIND-01 + FIND-02)

**Entry criteria:** Checkout at v0.9.44, all tests green (`npm run typecheck && npm test`).
**Parallelism:** **SERIAL** — both findings touch `src/state/mailbox.ts`. FIND-01 adds the delivery cache (changes `readDeliveryState`/`writeDeliveryState`); FIND-02 adds the async path (changes `appendMailboxMessage`). These must be sequenced: FIND-01 first (cache), then FIND-02 (async, which benefits from the cache).
**Between-phase gate:** `npm run typecheck && npm test` green. Manual: before/after timing of 50-message mailbox stress test (expect O(N²) → O(N) improvement).

### Phase 2: Cheap Hygiene (FIND-07 + FIND-08 + FIND-14)

**Entry criteria:** Phase 1 gate passed.
**Parallelism:** **FULLY PARALLEL** (worktree isolation) — no shared files:
- FIND-07: `src/ui/run-dashboard.ts`, `src/ui/live-run-sidebar.ts` (+ import from `widget-renderer.ts`)
- FIND-08: Delete `src/runtime/{auto-resume,notebook-helpers,orphan-sentinel}.ts` + 3 test files
- FIND-14: `src/runtime/async-runner.ts`
**Between-phase gate:** `npm run typecheck && npm test && npm run lint`.

### Phase 3: State-Read Scan Reductions (FIND-03 + FIND-04 + FIND-05)

**Entry criteria:** Phase 2 gate passed.
**Parallelism:** **FULLY PARALLEL** (worktree isolation) — no shared files:
- FIND-03: `src/runtime/manifest-cache.ts`
- FIND-04: `src/state/run-metrics.ts`
- FIND-05: `src/state/event-log.ts` (functions at `:1168+` — **NOTE:** FIND-10 also touches `event-log.ts` but at `:520-680`, a different region. They CAN be done in the same phase if both stay in their regions, but to be safe, FIND-10 is in Phase 5.)
**Between-phase gate:** `npm run typecheck && npm test`. Manual: before/after timing of `listActive()`, `getRunMetricsSummary()`, and `readEventsCursor()` on a run with 100+ runs/events.

### Phase 4: Heartbeat Race (FIND-06)

**Entry criteria:** Phase 3 gate passed.
**Parallelism:** **SINGLE TASK** — only FIND-06 in this phase.
**Between-phase gate:** `npm run typecheck && npm test`. Manual: coalesced dispatch test with mocked slow heartbeat save.

### Phase 5: Opportunistic (FIND-11 + FIND-12 + FIND-09 + FIND-10 + FIND-13)

**Entry criteria:** Phase 4 gate passed.
**Parallelism:** **MOSTLY PARALLEL** with one dependency note:
- FIND-11: `src/extension/run-import.ts` — parallel ✅
- FIND-12: `src/runtime/role-permission.ts` — parallel ✅ (but BREAKING — requires decision before merge)
- FIND-09: `src/runtime/resilient-edit.ts` — parallel ✅
- FIND-10: `src/state/event-log.ts` (`:520-680`) — parallel ✅ (different region from FIND-05 which was Phase 3)
- FIND-13: `src/runtime/task-packet.ts` + `src/agents/discover-agents.ts` — parallel ✅
**Between-phase gate:** `npm run typecheck && npm test && npm run lint`. FIND-10 additionally requires the full seq-uniqueness test suite to pass.

---

## 4. Cross-Finding File-Ownership Map

| File | FIND(s) Touching | Conflict? | Recommended Owner |
|------|-----------------|-----------|-------------------|
| `src/state/mailbox.ts` | FIND-01, FIND-02 | **YES** — both modify delivery/mailbox-append paths | **Serial:** FIND-01 first, FIND-02 second |
| `src/state/event-log.ts` | FIND-05 (`:1168+`), FIND-10 (`:520-680`) | **Low** — different code regions | FIND-05 in Phase 3, FIND-10 in Phase 5 (or same worktree if both stay in their regions) |
| `src/state/locks.ts` | FIND-02 (adds `withFileLockAsync`) | No other finding | FIND-02 |
| `src/runtime/manifest-cache.ts` | FIND-03 | No other finding | FIND-03 |
| `src/state/run-metrics.ts` | FIND-04 | No other finding | FIND-04 |
| `src/runtime/run-coalesced-task-group.ts` | FIND-06 | No other finding | FIND-06 |
| `src/ui/widget/widget-renderer.ts` | FIND-07 (exported function, read-only) | No other finding | FIND-07 |
| `src/ui/run-dashboard.ts` | FIND-07 (delete + import) | No other finding | FIND-07 |
| `src/ui/live-run-sidebar.ts` | FIND-07 (delete + import) | No other finding | FIND-07 |
| `src/runtime/auto-resume.ts` | FIND-08 (delete) | No other finding | FIND-08 |
| `src/runtime/notebook-helpers.ts` | FIND-08 (delete) | No other finding | FIND-08 |
| `src/runtime/orphan-sentinel.ts` | FIND-08 (delete) | No other finding | FIND-08 |
| `src/runtime/resilient-edit.ts` | FIND-09 | No other finding | FIND-09 |
| `src/extension/run-import.ts` | FIND-11 | No other finding | FIND-11 |
| `src/runtime/role-permission.ts` | FIND-12 | No other finding | FIND-12 |
| `src/runtime/task-packet.ts` | FIND-13 | No other finding | FIND-13 |
| `src/agents/discover-agents.ts` | FIND-13 | No other finding | FIND-13 |
| `src/runtime/async-runner.ts` | FIND-14 | No other finding | FIND-14 |

---

## 5. Risks, Assumptions, Open Questions

### High-Priority Risks

1. **FIND-01 cache invalidation correctness:** The in-process cache is invalidated by mtime check + post-write cache update. **Risk:** Cross-process writes (multiple Pi instances writing to the same run's mailbox). **Question:** Does pi-crew ever have multiple processes writing to the same `delivery.json`? The team-runner is a single process, but crash-recovery or background runners might read it. **Mitigation:** The mtime check catches external writes; if proven insufficient, fall back to no-cache (read-through).

2. **FIND-02 async refactor on live-agent path:** Converting `appendMailboxMessage` to async changes the call chain for steering/follow-up messages sent during live agent execution. **Risk:** If a caller is not async-aware, this breaks. **Mitigation:** Create `appendMailboxMessageAsync` as a NEW export; keep the sync version for non-live callers. Audit all callers of `appendSteeringMessage`/`appendFollowUpMessage` for async compatibility.

3. **FIND-10 touches seq-integrity hot path:** Even though the fsync is preserved, changing from double-open to single-fd-append changes the I/O pattern. **Risk:** `fd.appendFile` in append mode might behave differently on Windows/macOS. **Mitigation:** The seq-uniqueness test suite must pass. If `fd.appendFile` doesn't work correctly, revert to the original double-open approach and only collapse the redundant stats.

4. **FIND-12 is a BREAKING CHANGE:** Changing `permissionForRole("unknown-role")` from `"workspace_write"` to `"read_only"` breaks any custom agent that relied on the permissive default. **Decision needed:** Hard break (next patch) vs. deprecation warning (log for 1 release, then enforce). **Mitigation:** If hard break, document in CHANGELOG; provide opt-in mechanism (`permissions: { workspaceWrite: true }` in agent config).

### Medium-Priority Risks

5. **FIND-08 deletion must verify NO dynamic references:** The grep confirms no static imports, but dynamic `import()` or `require()` calls are not covered by static grep. **Mitigation:** Check `index.bundle.ts`, `.dwf.ts` files, and `scripts/` for any dynamic references before deleting.

6. **FIND-02 `withFileLockAsync` is in-process only:** The existing `withFileLockSync` uses O_EXCL atomic create for cross-process safety. The async version (`withEventLogLockAsync` pattern) is a promise-chain lock — in-process only. **Question:** Does delivery.json ever get written by multiple processes? If so, the async path needs a cross-process async lock. **Mitigation:** Keep the sync `withFileLockSync` for the delivery RMW; only make the mailbox file append async.

### Low-Priority Risks

7. **FIND-05 tail-read semantics:** Callers that need the FULL event log (not just the tail) on the default path would break. **Mitigation:** The existing `fromByteOffset` parameter exists for full-history reads; the tail-cap behavior is already documented and warned.

8. **FIND-06 drain timeout:** If the heartbeat save is stuck, awaiting it before the final result write could block indefinitely. **Mitigation:** Add a max-wait timeout (5s) on the drain.

### Assumptions

- All findings are still current in v0.9.44 (confirmed by re-reading source).
- The test suite (`npm test`) is the primary safety net for all fixes.
- Bundle rebuild (`npm run build:bundle`) is needed after source changes for live Pi session visibility (per knowledge.md).
- `redactSecretString` from `src/utils/redaction.ts:216` is the correct redaction function (used by `child-pi.ts` for stderr).

### Open Questions

1. **FIND-12:** Hard break or deprecation period? This requires a product decision.
2. **FIND-01:** Is a single-process cache sufficient, or do we need cross-process cache invalidation? (Depends on whether multiple processes write to `delivery.json`.)
3. **FIND-02:** Should the delivery.json RMW also become async, or just the mailbox file append? (The delivery RMW is under `withFileLockSync` which also uses `sleepSync`.)
4. **FIND-08:** Is `auto-resume` logic still needed? The report suggests folding it into `loop-gates.ts` if intended. Should we fold or just delete?

---

## 6. "Ready to Execute" Checklist

- [ ] **Phase 0:** Run `npm run typecheck && npm test` on clean v0.9.44 checkout — confirm green baseline.
- [ ] **Phase 0:** Read this plan and the deep-review report (`reports/deep-review-2026-07-20.md`) together.
- [ ] **Phase 1 (FIND-01 + FIND-02):**
  - [ ] FIND-01: Implement delivery cache in `mailbox.ts`. Run mailbox tests.
  - [ ] FIND-02: Implement `appendMailboxMessageAsync` + `withFileLockAsync`. Route live-agent callers.
  - [ ] Gate: `npm run typecheck && npm test` green.
  - [ ] Perf note: Record before/after timing of 50-message stress test.
- [ ] **Phase 2 (FIND-07 + FIND-08 + FIND-14):** All parallel.
  - [ ] FIND-07: Dedupe `renderLines` across 3 UI files.
  - [ ] FIND-08: Delete 3 orphan modules + 3 test files (verify no dynamic refs first).
  - [ ] FIND-14: Add `redactSecretString` to `async-runner.ts` `flushStderr`.
  - [ ] Gate: `npm run typecheck && npm test && npm run lint` green.
- [ ] **Phase 3 (FIND-03 + FIND-04 + FIND-05):** All parallel.
  - [ ] FIND-03: Add TTL cache to `listActive()`.
  - [ ] FIND-04: Sort dirents by mtime before reading in `getRunMetricsSummary`.
  - [ ] FIND-05: Tail-read in `readEventsCursor` default path.
  - [ ] Gate: `npm run typecheck && npm test` green. Record perf timings.
- [ ] **Phase 4 (FIND-06):**
  - [ ] Implement in-flight guard + await-drain + terminal-safety in `run-coalesced-task-group.ts`.
  - [ ] Gate: `npm run typecheck && npm test` green.
- [ ] **Phase 5 (FIND-11 + FIND-12 + FIND-09 + FIND-10 + FIND-13):** Mostly parallel.
  - [ ] FIND-11: Document SHA-256 as corruption-only + security event log.
  - [ ] FIND-12: Default-deny for unknown roles + migration note (**DECISION REQUIRED**).
  - [ ] FIND-09: Type the `any` cluster in `resilient-edit.ts`.
  - [ ] FIND-10: Single-fd fsync + collapse stats (**fsync must NOT be removed**).
  - [ ] FIND-13: Resolve/track the 2 TODOs.
  - [ ] Gate: `npm run typecheck && npm test && npm run lint` green. Seq-uniqueness tests pass.
- [ ] **Post-remediation:**
  - [ ] `npm run build:bundle` (rebuild dist for live sessions).
  - [ ] `npm version patch` → v0.9.45.
  - [ ] Update CHANGELOG.md.
  - [ ] Follow release process: commit → push → wait for CI green → tag → publish.
