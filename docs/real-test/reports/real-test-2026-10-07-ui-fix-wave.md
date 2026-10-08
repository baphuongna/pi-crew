# UI Instability Fix Wave — L1..L9 Verification Report (2026-10-07)

Repo `pi-crew` @ HEAD `3793d32e` (uncommitted wave diff: 32 modified + 6 new files, +897/−163).
Report input: `docs/real-test/reports/real-test-2026-10-07-ui-instability-review.md` (L1–L9 findings).
Verification lanes: executor waves (fixes + pin tests) → adaptive-09 test-engineer (mutation evidence) → **this report (adaptive-11 verifier: gates 1–7)**.

## Verdict: PASS — all 6 gates green, 5/5 mandatory+optional mutation cycles red-under-revert

## Gate results (fresh run, this phase)

| # | Gate | Result | Exact counts |
|---|---|---|---|
| 1 | `npm run test:critical` | ✅ EXIT 0 | **120 pass / 0 fail / 0 skipped**, 11 suites, 18.6s |
| 2 | `npm run typecheck` | ✅ EXIT 0 | `tsc --noEmit` clean + strip-types import ok |
| 3a | `npm run lint` | ✅ EXIT 0 | 1602 files; 1 pre-existing FIXABLE warning (`test/unit/runtime/core/dependency-tee.test.ts:124` useRegexLiterals — file NOT touched by this wave) + 2 biome.json schema infos |
| 3b | `npm run format:check` | ✅ EXIT 0 | 1602 files, no diffs |
| 4 | Targeted suites (32 files: 6 new pin files + 10 wave-modified test files + 16 regression-net files) | ✅ EXIT 0 | **246 pass / 0 fail / 0 skipped**, ~15.6s |
| 5 | `npm run build:bundle` + `node scripts/check-bundle-staleness.mjs` | ✅ EXIT 0 / EXIT 0 | dist/index.mjs 1622.5 KB rebuilt in 413 ms; staleness OK (bundle 281.3 s newer than newest src/) |
| 6 | T13 real-run render sweep (run `team_20261007114327_df97704ad9782c98`, widths 118/50/40) | ✅ 0 hits | 12 frames (DASHBOARD/SIDEBAR/DOCK-done/DOCK-running × 3 widths): **0 undefined, 0 wire-format (tok=/in=/out=/model=/age=/unread=/stale=), 0 mid-token status truncation, 0 wrong plural, 0 retired `->`, 0 NaN/null** |
| 7 | Mutation evidence (phase 3, adaptive-09) | ✅ 5/5 cycles | see table below — every pin test red under minimal revert, green after byte-exact restore; `git diff` sha256 `e7e2a941…` stable across all cycles (zero residue) |

## Per-fix summary

### L1 (HIGH) — bystander dock: crew dock renders active runs in EVERY session
- **Changed**: `src/ui/widget/widget-model.ts` — removed ONLY the display filter `runs.filter(run => !run.ownerSessionId || run.ownerSessionId === workspaceId)` in `activeWidgetRuns()`; `workspaceId` still flows into `reconcileAllStaleRuns` (crash-recovery stays session-scoped); `isDisplayActiveRun`/stale-async filtering untouched.
- **Pin test**: `test/unit/ui/widget-bystander-sessions.test.ts` — 2 tests (foreign-owned + ownerless runs returned @ :81; workspaceId still flows @ :104).
- **Mutation**: re-added the display filter → **2 fails** (`2 !== 3` "ALL active runs render — including the foreign-owned one"; `0 !== 1` "foreign-owned run renders even when this workspace owns no runs"); restore → 2/2 green.

### L2 (HIGH-MED) — render-loop rebuild-in-place (flicker fix invariant restored)
- **Changed**: `src/extension/registration/render-loop.ts` GATE 1 (:336-345) / FIX#1 (:352-356) / GATE 3 (:363) — `snapshotCache.invalidate(runId)` hard-deletes replaced by the rebuild-in-place path (`refreshSnapshotInPlace`/scheduleRefresh), matching the FLICKER FIX invariant at `run-snapshot-cache.ts:1082-1092` and `render-loop.ts:185-194`.
- **Pin test**: `test/unit/extension/registration/render-loop-rebuild-inplace.test.ts` — terminal run keeps `snapshotCache.get(runId)` defined across forced renderTicks (GATE 1) + task-status DIVERGENT case (GATE 3).
- **Mutation**: GATE 1 reverted to `invalidate()` → **1 fail** @ :231 ("GATE 1 must rebuild the snapshot in place — invalidate() leaves get(runId) undefined"); GATE 3 test stayed green (surgical revert). Restore → 2/2 green.

### L3 (MED) — default dashboard placement → "right" (kills centered-90% chopped-background overlay)
- **Changed**: `src/config/defaults.ts:148` (`dashboardPlacement: "right"`), mirrors `install.mjs:60` + `src/extension/team-tool/handle-settings.ts:41` (EFFECTIVE_DEFAULTS, G17 drift lesson), `docs/usage.md:48`. Width default unchanged.
- **Pin tests**: `test/unit/ui/run-dashboard.test.ts` — "M1-8: default ui.dashboardPlacement='right' anchors the overlay top-right (L3 re-pin)"; plus `test/unit/config/defaults.test.ts`, `test/unit/install.test.ts` (install writes default UI config), `test/unit/extension/core/project-init.test.ts`.
- **Mutation**: not mandatory for L3 (packet requires L1/L2/L4 minimum); covered by gate 4 green.

### L4 + L6 (MED, same file) — sidebar auto-close deadline fixed + height lock
- **Changed**: `src/ui/live-run-sidebar.ts` — (a) autoCloseDeadline captured FIXED on first eligibility, re-armed only when the run leaves terminal; (b) rendered height locked (targetHeight pattern from `run-dashboard.ts:644-651`) so pre-load/loading/shrunk frames share one height (no ghost footprint).
- **Pin tests**: `test/unit/ui/live-run-sidebar-regressions.test.ts` — L4 ×4 (deadline fixed @ :271, countdown reads fixed deadline @ :303, cancel on leave-terminal, active-agents reappear cancels), L6 ×1 (stable height).
- **Mutation (L4)**: back to `clearTimeout`+`setTimeout(full)` re-arm per render → **2 fails** @ :271 ("close fires at firstEligibility + autoCloseMs, not at lastRender + autoCloseMs") and @ :303 (countdown frozen); cancel/re-arm tests stayed green. Restore → 7/7 green.

### L5 (MED) — sync full-rebuild OFF the paint path
- **Changed**: `src/ui/run-snapshot-cache.ts:1078-1093` — new `readForRender()` paint-path accessor + coalesced async `scheduleRefresh` (pattern from `crewRunWatcherOnChange`, render-loop.ts:460-475); call sites `live-run-sidebar.ts:180`, `run-dashboard.ts:289`, `render-loop.ts:373-377` now read cached snapshots only.
- **Read-your-writes preserved** (report Tier 11a): keypress paths with an immediate sync reader keep `refreshIfStale` — pinned by "keypress keeps sync refreshIfStale" (run-dashboard.test.ts).
- **Pin tests**: `test/unit/ui/run-snapshot-cache-render-read.test.ts` (5 pins: cache hit no rebuild / stale → coalesced async / unknown runId → undefined without build / LRU touch / fresh-TTL zero work) + sidebar pins @ :160/:176 + dashboard pin.
- **Mutation**: render() back to sync `refreshIfStale` → **2 fails** @ :160 ("the paint path must NOT sync-rebuild") and :176 ("a miss must kick the coalesced async refresh"). Restore → 7/7 green.

### L7 (MED) — TUI dialect sweep (wire-format out)
- **Changed**: `run-dashboard.ts:341-356,397` agentPreviewLine/header (↑/↓ compactUsage via live-run-sidebar.ts:51-57 pattern, formatDuration for age); `dashboard-panes/mailbox-pane.ts:11-21` dialect; `health-pane.ts:20` + `progress-pane.ts:12-33` count-first (`reason=` kept in progress pane — judged diagnostic, pinned as such); `live-conversation-overlay.ts:123,273` formatDuration.
- **Pin tests**: `test/unit/ui/panes-dialect.test.ts` (mailbox dialect :90, health count-first :92, progress :93-94, overlay `5m44s` :95) + `run-dashboard.test.ts` :131 (dashboard preview dialect).
- **Mutation**: not mandatory; covered by gate 4 + T13 sweep (0 wire-format hits on real-run frames).

### L8 (MED) — CURSOR_MARKER defensive resolve (W4/G22)
- **Changed**: `src/ui/settings-overlay.ts` + `src/ui/overlays/mailbox-compose-overlay.ts` — named import replaced by the defensive resolve pattern (`widget-renderer.ts:118-128` hyperlink typeof-guard style).
- **Pin tests**: `test/unit/ui/settings-overlay-cursor-marker.test.ts` :147-152 — marker emission at active-field end + `resolveCursorMarker` fallback `""` when host pi-tui lacks the export.

### L9 (LOW sweep) — plurals, dock truncation priority, dead export
- **Changed**: `formatCount` plurals at `run-dashboard.ts:354`, `run-action-dispatcher.ts:110`, `plan-pane.ts:102,131`, `agents-pane.ts:138`, `tool-renderers/brief-mode.ts:103`; `widget-renderer.ts` dockRow priority budget (never split the status word, drop meta segments first); dead `formatLiveDuration` export deleted (`live-duration.ts:53`).
- **Pin tests**: `widget-truncate.test.ts` :215-218 (dock@40 long-id `1 running` whole; subject clipped at boundary; `⏰` meta dropped before status; width sweep whole-or-absent) + `run-action-dispatcher.test.ts` :38 (ack-all singular) + `panes-dialect.test.ts` :91,:96-99 (plan/agents/brief-mode plurals) + `panes-rail.test.ts` :100 (source guard: formatLiveDuration stays deleted).
- **Mutation (dock)**: back to blind `railLeaders` clip → **4 fails**, headline @ :198 rendered `"┃ ⠋ CREW ▸ abcdef00 · 1 runnin…  ↓·enter"` (the exact live-regression fragment from the review). Restore → 10/10 green.

## Mutation evidence (phase 3 — adaptive-09 test-engineer, 5 cycles)

| Fix | Pin test file | Minimal revert | FAILING assertion (reverted) | GREEN (restored) |
|---|---|---|---|---|
| L1 | widget-bystander-sessions.test.ts | re-add display filter | :81 `2 !== 3`; :104 `0 !== 1` | 2/2, EXIT 0 |
| L2 | render-loop-rebuild-inplace.test.ts | GATE1 → invalidate() | :231 snapshot undefined across renderTicks | 2/2, EXIT 0 |
| L4 | live-run-sidebar-regressions.test.ts | re-arm per render | :271 close slides; :303 countdown frozen | 7/7, EXIT 0 |
| L5-core | live-run-sidebar-regressions.test.ts | render() → sync refreshIfStale | :160 sync rebuild on paint; :176 miss never fills | 7/7, EXIT 0 |
| L9-dock | widget-truncate.test.ts | blind railLeaders clip | :198 `1 runnin…` + 3 more | 10/10, EXIT 0 |

Tree integrity after every cycle: `git diff | sha256sum` = `e7e2a941…` (baseline), 38 porcelain entries unchanged. Batches (phase 3): 16 wave-touched files **133/133**; 14 regression-net files **97/97**; 3× determinism sweep of 5 new files 27/27 each.

## T13 render evidence (gate 6, real run `team_20261007114327_df97704ad9782c98`)

12 frames swept at widths 118/50/40 — 0 hits. Key frames (ANSI-stripped):

```
===== SIDEBAR loaded @118 =====
┏ LIVE ▸ d9782c98
┃ d9782c98 · completed · ⚠ goal · single
┃ fast-fix · ↑1.1k ↓2.1k
┣ ACTIVE ▸ 0 agents
┃ none
┣ DONE ▸ 3 agents
┃ ✓ 01_explore · zai/glm-5.3 · ↑278 ↓582
┃ ✓ 02_execute · zai/glm-5.3 · ↑196 ↓588
┃ ✓ 03_verify · zai/glm-5.3 · ↑616 ↓964
┣ TASKS ▸ 3 tasks

===== DOCK running @40 =====          ← L9 pin: status word WHOLE (review found `1 runnin…`)
┃ ⠹ CREW ▸ fast-fix · 3 running  ↓·enter

===== DOCK done @40 =====             ← elision hits the SUBJECT (fast-…), never the status
┃ ✓ CREW ▸ fast-… · 3/3 done ··· ↓·enter

===== DASHBOARD(real run, completed) @50 =====
┏ DASHBOARD ▸ 1 run  1-8 pane · ↑/↓ move · Enter s
┣ RECENT ▸ 1
┃ › ✓ d9782c98 completed ⚠ · READ-ONLY probe #4: …
```

## Residual risks

- **Full `npm test` (unit+integration, complete) not run** in this wave verification — 600 s watchdog policy; gates = test:critical + targeted files only. Leader may run the full suite before release.
- **Live tmux T5 probe not re-run by verifier lanes** (executors reported green; leader spot-check advised before release).
- **docs/ui-samples captures not regenerated** — no `.md`/catalog text pins the old `dashboardPlacement` default (checked), PNG captures are visual-only; regenerate if the catalog matters for release notes.
- **L1 is an intentional UX surface change**: bystander terminals now render ALL active runs including foreign-owned ones (previously silent). Confirm this is the desired product behavior for multi-terminal users.
- **install.mjs / handle-settings.ts mirrors are hand-synced** (G17 drift lesson) — pinned by install.test.ts + defaults tests; any future default change must update all three sites.
- **dist/index.mjs rebuilt and left uncommitted** (per policy — no commit/push/version bump in this wave; leader owns release).
- Sidebar first frame after mount paints `loading…` by design (L5 async fill); visible for one refresh tick on real cold mounts.

## Provenance

- Gates 1–7 executed 2026-10-07 by adaptive-11-verifier (logs: `/tmp/adaptive11-cache/gate{1,2,3a,3b,4,5a,5b,6}*.log` + t13-frames.txt).
- Mutation table from adaptive-09-test-engineer handoff (phase 3), full text: `.crew/artifacts/team_20261007152204_8c7041a6abbbf63a/results/adaptive-09-test-engineer.txt`.

## Addendum — L10: plan-card flicker (fix cùng ngày, sau khi user restart)

Symptom (user, sau restart bundle abe9baff): "UI phần plan hiển thị nháy nháy liên tục".
Live root-cause (owner-config repro: tmux-pi tự dispatch run, 600 frames @0.2s):
plan card đổi nội dung **544/599 mẫu (~4.5Hz)** — task row running painted
`spinnerFrame("crew-task-list")` (braille quay 160ms) + `:spin=<bucket>` trong
signature của tasks variant → rebuild toàn card mỗi spinner bucket, trái comment
thiết kế "no spinner glyph — changes only on task transitions".

Fix:
- `src/ui/widget/task-list.ts` — running glyph tĩnh `▶` (braille frames bị cấm
  trong plan card), bỏ import spinnerFrame.
- `src/ui/widget/index.ts` — tasks variant strip `:spin=\d+` khỏi cache signature.
- Pin: `task-list.test.ts` — glyph `▶` + doesNotMatch braille range +
  determinism trong cùng elapsed-second; mutation-checked (revert → 1 fail đỏ).

Gates: task-list 12/12 · test:critical 120/120 (30s, máy load 80+ do build song
song — lần đỏ đầu thuần environmental) · typecheck/lint/format xanh · bundle
cf7e5c25d00117bc22bfaec3ece4d942 + staleness OK.
Live re-verify (cùng repro, 600 frames): content changes **36/513** (≈0.3Hz —
chỉ elapsed 1Hz + task transitions), height ổn định 5 rows.

## Addendum 2 — 2026-10-08 livestream deep-review (bundle cf7e5c25)

Surfaces: live-conversation overlay (`V`), agents-jobs browser (`b`), transcript
viewer (`v`), dashboard nav @150/@80, sync + async dispatch.

### P0 (FIXED, commit kế tiếp): autocomplete throw giết cả pi process
- Live-caught: gõ `/team-transcript team_…` → popup completion race làm input
  dính `/team-transcript` vào runId token → `assertSafePathId` (đúng) throw
  `Invalid runId: team_x/team-transcript` → throw thoát ra ngoài
  `CombinedAutocompleteProvider.getSuggestions` của pi core (không catch
  extension errors) → **uncaught_exception, cả pi chết** (crashes.json
  02:41:16Z, full stack qua dist/index.mjs mn/X2/L/vM).
- Fix: `command-completions.ts` — `suggestTaskIds` + `suggestRunIds` wrap
  try/catch → null; mọi completion provider không bao giờ throw. Pin test
  10/10 (mutation: bỏ guard → `Invalid runId` throw đúng message).
- Live re-verify (bundle 4f764574): gõ đúng chuỗi crash → pi sống, 0 crash
  entry; flow hợp lệ vẫn gợi ý `01_explore/02_execute/03_verify`.

### F1 (GAP, chưa fix — cần quyết định): live-conversation chết với child-process runtime
- `V` (live-conversation) + live-section của agents browser đọc
  `listLiveAgents()` — registry **in-process**, chỉ được ghi bởi
  `live-session-runtime.ts`. Runtime mặc định (và bắt buộc với async) là
  **child-process** → registry trống vĩnh viễn → "No live agent found for
  this run." 100% (live-verified cả async lẫn sync run, kể cả khi agent đang
  chạy thật). CONTEXT.md xác nhận live-session path FROZEN (ADR 2026-08-15).
- Đề xuất: (a) khi `runtimeResolution.kind === "child-process"`, ẩn/disabled
  key `V` + error message trỏ sang `v` (transcript viewer đọc file — hoạt
  động tốt), hoặc (b) bridge live-agent qua broker. Không tự fix (ADR).

### F2 (FIXED): "1 lines" plural slip trong transcript viewer footer.
