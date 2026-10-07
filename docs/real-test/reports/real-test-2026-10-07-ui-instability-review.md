# Real-test report — UI instability review (2026-10-07)

Scope: user complaint "UI hiển thị cực kỳ không ổn định". Battery: T1 + T5 (tmux live
probe) + T13 (real-run render) + 2 parallel read-only source audits (render pipeline,
widget/panes defect classes). HEAD `3793d32e`, bundle md5 `7b7b3c0a125bd02539ff84528747c97b`
(build 2026-10-07 15:27), host pi 1.0.4, node v22.23.1, theme `crew-gruvbox-dark`.

## Verdict: KHÔNG PASS — 2 live defect + 8 source finding cần fix

| # | Severity | Finding | Evidence |
|---|---|---|---|
| L1 | **HIGH** | Crew dock widget KHÔNG BAO GIỜ render trong session không sở hữu run | live probe: 3 async runs + 1 headless run; 198+110 frames qua 85s run active (kể cả ép repaint bằng resize ±1) — 0 frame có dock; widget pi-rlm vẫn update bình thường trong cùng session → lớp widget sống. Root cause: `activeWidgetRuns()` filter `ownerSessionId === workspaceId` (`src/ui/widget/widget-model.ts:59-61`, vào code trong commit `4ed71fa7` không kèm rationale). Với user nhiều terminal: run chạy ở terminal A, terminal B im lặng hoàn toàn |
| L2 | **HIGH-MED** | render-loop GATE 1/FIX#1/GATE 3 hard-delete snapshot entry, mâu thuẫn chính "FLICKER FIX: rebuild-in-place" | `src/extension/registration/render-loop.ts:336-345,352-356,363` gọi `snapshotCache.invalidate()` (entries.delete) cho run terminal/divergent MỖI renderTick ~160ms; flicker-fix invariant ghi tại `run-snapshot-cache.ts:1082-1092` + `render-loop.ts:185-194` cấm đúng việc này → powerbar/widget fallback disk-read branch 1-n frame quanh lúc run kết thúc (nhấp nháy). Explorer audit #1 F3 |
| L3 | **MED** | Dashboard overlay default `90% centered` để lộ mảnh chữ nền bị xé 2 mép | live: margin trái `[Context`/`grap`/`lang`…, margin phải `e,`/`driven,`/`tore,` ở mọi width (160/100/80). Cơ chế: pi-tui `compositeTuiLine` giữ `base.before/base.after` ngoài overlay bounds — by design của host, nhưng pi-crew chọn default `dashboardPlacement` centered + width 90% khiến background text-dense bị xé giữa chữ. `openTeamDashboard` (`commands/shared.ts:508+`). Mitigation có sẵn: `ui.dashboardPlacement: "right"` |
| L4 | **MED** | Sidebar auto-close re-arm mỗi render — deadline lùi vô hạn, countdown "3s…" đứng yên | `live-run-sidebar.ts:338-352` clearTimeout+setTimeout(full) trong nhánh re-render khi event kéo dài >3s với khoảng cách <3s. Explorer #1 F1 |
| L5 | **MED** | Snapshot rebuild SYNC ngay trên render path — frame pacing stutter | `run-snapshot-cache.ts:1078-1093` gọi từ `live-run-sidebar.ts:180`, `run-dashboard.ts:289`, `render-loop.ts:373-377`: 5×stat + full parse + 6×sha256 block event loop giữa paint. Explorer #1 F2 |
| L6 | **MED** | Sidebar không khoá height (3 dòng loading vs 20+ dòng loaded) — ghost footprint | `live-run-sidebar.ts:186-197`; dashboard có `targetHeight()` chống đúng bug này (`run-dashboard.ts:644-651`), sidebar thì không. Explorer #1 F4 |
| L7 | **MED** | Wire-format leak trong dashboard + 3 pane | `run-dashboard.ts:341-356,397` (`model=/tok=/in=/out=/age=`); `mailbox-pane.ts:11-21`, `health-pane.ts:20`, `progress-pane.ts:12-33` (`unread=`, `stale=`, `ack=`). Trái dialect TUI `↑2.8k ↓3.7k`. Explorer #2 F1/F4 |
| L8 | **MED** | `CURSOR_MARKER` named import chết host cũ — trái chính sách W4/G22 | `settings-overlay.ts:7`, `overlays/mailbox-compose-overlay.ts:26` named-import từ `@earendil-works/pi-tui`; pattern defensive đúng đã có mẫu tại `widget-renderer.ts:118-128` (hyperlink typeof-guard). Explorer #2 F2 |
| L9 | **LOW** | Còn lại: raw-seconds `605.3s` thay `5m44s` (`live-conversation-overlay.ts:123,273` + `formatLiveDuration` export chết `live-duration.ts:53`); plural `1 turns/1 messages/1 tasks` (5 call-site); dock@40cols `1 runnin…` cắt giữa token status (T13 sweep); `⚠` hiện trên mọi run `goalAchieved:"unknown"` (goal-flag.ts:19-27) — semantically đúng nhưng nhiễu; dispose-flush emit sau teardown (`powerbar-publisher.ts:505-508`); eventsStamp flip rebuild-mỗi-tick (`run-snapshot-cache.ts:120-137`); sidebar min-width 36 |

Âm tính có bằng chứng (không phải lỗi): render-coalescer/render-scheduler/shared-overlay-scheduler/run-event-bus/adaptive-card không timer-storm, không vòng re-render, không ghi thẳng stdout; undefined-guard, glyph-from-state, truncation-priority, team/workflow dedupe, completedAt-duration đều đúng trong code path chính; đóng dashboard sạch (không vết overlay); navigation j/k/`?` đúng.

## Per-tier evidence

- **T1** `npm run test:critical`: 120/120 pass, 0 fail, 22s (`# duration_ms 21198`).
- **T5 tmux live probe** (socket /tmp/pcsock, 160x50, pi 1.0.4 thật):
  - `/team-dashboard` mở/đóng đúng; navigation j/j/`?` đúng (cursor `›` di chuyển, help pane render đủ).
  - Width sweep 160→100→80: header tự reflow đúng 90% (152/95/76 cols), list row truncate đúng priority (goal bị cắt trước status).
  - Margin-fragment缺陷 xác nhận ở cả 3 width (L3).
  - **Bystander-dock probe**: run `team_20261007113910_d9cd6fdc87db3a8f` (async, 85s) + `team_20261007114327_df97704ad9782c98` (headless-dispatched, ~95s): 308 frames tổng, 0 frame chứa crew dock; chỉ widget pi-rlm thay đổi (3h4m→3h2m). Ép repaint bằng resize ±1 cột mỗi 1.5s không giúp → không phải "idle không repaint" (L1).
- **T13 real-run render battery** (run thật `team_20261007114327_df97704ad9782c98`, 13 surface-states: CALL/STREAMING/COLLAPSED/EXPANDED/EXPANDED@80/DOCK done/done@50/running/running@40/failed/PLAN CARD/SIDEBAR@118/@50):
  - Invariant sweep: 0 `undefined`, 0 retired-frame glyph, 0 `->`, 0 wire-format trong các surface này, 0 spinner+0-running, 0 over-width, 0 plural sai.
  - 1 hit: DOCK running@40 `1 runnin…` (status token xé giữa từ; hint `↓·enter` sống sót đúng).
  - Isolated `RunDashboard.render(144)` pad 144/144 mọi dòng → component pad đúng; mảnh rác mép là base.before/after của host (L3).
- **Source audits** (2 explorer read-only, 10 + ~20 files): 8 + 13 findings như bảng; mọi finding kèm file:line + snippet.

## Runs đã tạo (evidence)

`team_20261007113623_dadfcd90270c7c25` · `team_20260910113910_d9cd6fdc87db3a8f` (đúng: `team_20261007113910_…`) · `team_20261007114125_4a3875bf6c0bdbba` · `team_20261007114327_df97704ad9782c98` — đều 3/3 tasks, consistency=1, read-only goal. `git status` pi-crew sạch sau battery (không edit trái phép).

## Fix-order đề xuất

1. L1 — bỏ/filter-lại `ownerSessionId` (hoặc opt-in `ui.showForeignRuns`) + pin test cross-session.
2. L2 — render-loop chuyển sang `scheduleRefresh` (rebuild-in-place) thay `invalidate()` hard-delete; pin bằng unit dựng lại đúng invariant comment.
3. L3 — đổi default `dashboardPlacement` sang `"right"` (hoặc giảm width default/che nền), cập nhật catalog captures.
4. L4/L5/L6 — sidebar: auto-close deadline cố định (không re-arm), async refresh off the paint path, height lock theo mẫu dashboard.
5. L7/L8/L9 — sweep dialect + CURSOR_MARKER defensive + plural/formatCount + truncation priority ở dock fallback.
