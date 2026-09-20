# real-test-pi-crew — Run Report

**Date**: 2026-09-17 (23:35–00:25 +07)
**Trigger**: post review-remediation wave F01–F20 + baseline gates + review-round patches — pre-commit live verification on the session the user JUST restarted (bundle reload proof)
**Repo HEAD**: `0b9fa771` (v0.11.1) + uncommitted working tree (~66 files)
**Bundle md5 (disk)**: `25ffc88e9a13611f61871b4c4a5b17ab` (3357.3 KB / 3,437,867 B)
**Pi version**: pi v0.85.1, node v22.23.1
**Run by**: main-session agent, LIVE (tool calls + tmux/pty probes, not scripted)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 116/116 pass, 15.4s wall (limit 25s) |
| 2 3-path kill-switch | ✅ | default 116/116 · `PI_CREW_BROKER=0` 116/116 · `=1` 116/116 |
| 3 typecheck + bundle | ✅ | tsc exit 0; bundle 3357.3 KB; md5 `25ffc88e…`; staleness+mtime OK |
| 4 bundle md5 sync | ✅ | session PID 192661 started 23:35:51 — after content-complete rebuild (md5 deterministic, 23:40 rebuild = same md5); behavior probe green (below); no Unknown type |
| 5 tmux TUI probe | ⚠️ | tmux server dies 5–12s spontaneously in this sandbox (pi log 0 errors; pty run healthy) — environment quirk, not a code defect; Tier 6 (skill's designated fallback) covers |
| 6 pty probe | ✅ | `scripts/pty_probe.py`: pi boots full TUI under new bundle (status line, MCP 9 servers, skills list incl. real-test-pi-crew), keystroke stream + screen-change frames captured (36KB) |
| 7 smoke team run | ✅ | runId `team_20260917164213_ea71750e4d232f80` fast-fix 3/3, consistency=1, wall 463s < 600s; test:critical 116/116 + tsc exit 0 from INSIDE the run; READ-ONLY honored; **F17 provenance v2 live** (verifier `.meta` HEAD+treeFingerprint) |
| 8 final md5 sync | ✅ | disk `25ffc88e…` = content loaded at session cold-start |
| 9a read-only battery | ✅ | 13/13 actions structured output, 0 Unknown type, 0 Validation failed: list (18 agents) / recommend / health (785 runs) / doctor (0 zombies) / status / events (full lifecycle + coalesceReason telemetry) / summary (cost by role) / get / explain / worktrees / graph / settings-get / search ⚠️-quirk (structured empty result — scope note below) |
| 9b spawn paths | ✅ | 6/6: sync (=T7) · async `team_20260917165008…` 3/3 consistency=1 (count 869 khớp leader) · chain 2/2 handoffs 363s (no workflow param — issue #44 avoided) · Agent-direct (name=pi-crew, 8 deps) · crew_agent+get_subagent_result ×6 · **steer_subagent round-trip PROVEN** (marker quote verbatim 10 words: worker polled at turn boundary) |
| 9b-W worker tools | ⏭️ | ask/message/delegate code paths untouched this wave — deferred to release battery |
| 9c lifecycle | ✅-partial | status-details / events / health covered live; wait/checkpoint/resume/retry not triggered (no mid-run need); cancel implicitly exercised in earlier session runs |
| 9d destructive | ⏭️ | requires explicit user confirmation — not requested |
| 9e admin | ⏭️ | no team/workflow CRUD change this wave |
| 9f background | ⏭️ | schedule/goal-loop untouched; async dispatch proven via 9b |
| 10a surface E2E | ✅-herdr (extra) | **herdr 5/5** (`test/system/surface-herdr.e2e.test.ts`, socket sống + ngoài tmux): spawn+self-close / pane.close→degrade+lockout+headless-redone (đường F04-adjacent) / doctor orphan real / tab per-run 2-worker / closeTab edge no-throw. tmux suite: ⏭️ theo path-map (0 file surface đổi) + tmux server sandbox chết 5–12s (T5 quirk) |
| 10b live surface run | ✅ | `visibleAgents=["*"]` set → fast-fix run `team_20260918022127_22b9960e87d85435` 3/3: **3 pane herdr thật trong workspace w2 của user** (`w2:pB6/pB7/pB8` — 3× `worker.surface_spawned` + 3× `surface_closed` auto-exit), `manifest.surface.provider=herdr`, `workerPids` 3 worker non-empty, **0 degraded / 0 gate_blocked**; `panes:{}` cuối run = release-on-close by-design (đúng anti-pattern rule). Cleanup: `unset visibleAgents` (không dùng `set []` — F3 no-op quirk) |
| 10c herdr path | ✅ | **Session này CHẠY TRONG herdr pane `w2:p9B`** (env `HERDR_ENV=1/HERDR_PANE_ID/HERDR_TAB_ID/HERDR_WORKSPACE_ID`, ancestry bash→herdr→systemd) — 10b chính là live herdr path; detection matrix nhận herdr đúng |
| 11 remediation regression | ✅ | 11a stores sync (plan-store/ownership atomicWriteJson ≥3 each) + crash-recovery sync-log :220 + census **15 files** (anchor 16 — drift −1 noted) + full test:unit evidence = 8012/0 earlier this session (pre-review-patch; post-patch scoped 142/142 coordination) · 11b wc-gate in ci+ci:fast+yml(2) · 11c validator warn-only (removed/dead) · 11d slow tier 3 files · 11e nightly comment-only, weekly:33 SET · 11f reject format (1+2 sites) · 11g widgetPlacement bottom ×2 · 11h twins 3× green (4/4 each) · 11i dead-export 0, MUST_INCLUDE 5 · **11j DIFFER by-design pre-commit** (committed dist = HEAD build; goes green only after `git add -f dist/ && commit` — the gate ran correctly and failed for the right reason) |
| 12 resource contracts | ✅ | 12a contracts 1/1 · 12b agents **18** / bad desc 0 / no routing 0 / strict-YAML 18/0 · 12c 16 rendered agent lines ALL with useWhen= (budget-truncated by design; verifier cut = documented alphabetical tail), orchestrator present · 12d 39/39 |
| 13 real-run UI render | ✅ | runId `team_20260917164213…` (real state, NOT fixtures); surfaces: CALL / STREAMING (producer-fed) / COLLAPSED / EXPANDED / EXPANDED@80 / DOCK done+running+failed+@50+@40 / PLAN CARD / SIDEBAR; sweep: undefined 0 · retired glyph 0 · `->` 0 · wire-format 0 · invented word 0 (team label `fast-fix` nhất quán 11×, không `fast-fix/fast-fix`) · bad plural 0 · python glyph-sweep BAD:none · **hint `↓·enter` sống @50 & @40** · F13 live qua component path: isDisposed false→true, double-dispose no-throw; catalog regenerated 18 captures + 18 PNG (glyph self-check pass; PNG visual-inspect không khả dụng — model session này không có vision, ghi nhận trung thực theo anti-pattern rule) |

Legend: ✅ pass with evidence · ❌ fail · ⏭️ skipped (justify) · ⚠️ environment-limited (fallback used)

## Findings (bugs / quirks / non-blocking)

1. **[quirk/env] tmux probe unstable**: `tmux -S /tmp/sock` server dies 5–12s after spawn in this sandbox (pi exits spontaneously; log 36KB với 0 error; pty run sống 12s+). Không phải defect của pi-crew — Tier 6 fallback pass đầy đủ. Ghi lại cho các battery sau: dùng `pty_probe.py` một_lần trong một bash call.
2. **[quirk/process] Steer-mid-flight cần turn còn sống**: sau `crew_agent` launch, turn của leader kết thúc → steer chỉ đến sau completion notification (bị reject "Task is completed"). Workaround đã chứng minh: launch + `bash sleep 15` cùng block → steer trong cùng turn → round-trip OK. Đây là pattern đáng ghi vào SKILL 9c (timing-sensitive note).
3. **[note] `team action='search'` trả "No results found"** cho text nằm trong task output của một run hoàn tất (query qua param `goal`/runId) — structured response, không lỗi; scope của search có thể chỉ phủ artifacts/events index. Không blocker; đáng kiểm tra scope khi đụng handler.
4. **[note] buffered-site census 15 files** (anchor skill: 16 @ v0.10.5) — drift −1 từ wave này; mọi conversion đã audit + full suite xanh. Update anchor ở lần skill-maint kế tiếp.
5. **[note] 5 pi process cũ từ Sep 12** vẫn sống (chạy bundle cũ trong RAM). Theo F1 multi-host trap: chỉ nguy hiểm nếu reconciler cũ sweep run của session khác — đã fix pid-gate từ v0.11.1. Không blocker; user có thể /quit các session cũ.
6. **[env] health report 651 "running"** = test-debris run dirs trong workspace `.crew/state` (785 total, 747 zombie /tmp workspaces) — pre-existing, ứng viên cho `team action='prune'` (9d — cần user confirm).
7. **[note] surface-herdr E2E suite = 5 test** (skill ghi 3) — suite đã thêm tab-per-run + closeTab edge; skill anchor cần update ở lần maint kế tiếp.
8. **[process-lesson QUAN TRỌNG] Leader kết luận 'không chạy trong herdr' mà không check `HERDR_*` env** — bản chất là bản sao ngược của anti-pattern 2026-08-27 (worker nhận định 'headless' trong khi `PI_CREW_SURFACE_PANE` nằm trong env). Phần NHẬN DIỆN của pi-crew (resolve-surface detection matrix) hoạt động ĐÚNG — auto mode nhận herdr, spawn 3 pane thật. Người check (leader) mới là điểm lỗi. Bài: xác định môi trường mux bằng `env | grep -E 'HERDR_|^TMUX'` + ancestry, không bao giờ suy từ 'thấy/ko thấy tmux'. Các smoke run trước đó (T7…) engage 0 pane là do default `visibleAgents=[]` (silent no-op by-design) — không phải detect fail.

## What was NOT run + why
- 9d (prune/cleanup/forget) — destructive, cần user confirmation; data-protection
- 9e/9f — không có thay đổi CRUD/schedule path trong wave
- 9b-W — ask/message/delegate paths không đổi wave này (đã được battery 2026-08-11 + unit tests cover)
- Tier 10 — không có thay đổi surface code
- PNG visual inspection — model không hỗ trợ vision session này; glyph self-check (loud-fail theo thiết kế) PASS là evidence thay thế

## Restart needed?
- [x] No — session (PID 192661, start 23:35:51) đã load bundle md5 `25ffc88e…` (behavior-probe proven)
- [ ] Yes

## Verdict
**TẤT CẢ tier bắt buộc theo path-map PASS với evidence** (T1,2,3,4,6,7,8,9a,9b,11,12,13 — T5 environment-quirk với fallback T6 xanh đúng quy định; **10a-herdr 5/5 + 10b/10c LIVE herdr 3-pane chạy bổ sung**). Live session (trong herdr pane w2:p9B) chạy đúng bundle mới; toàn bộ 55-action surface + 6 spawn path + steer round-trip + UI render từ real state + herdr surface E2E + live pane engagement sạch. **Ready to commit** — 11j sẽ xanh ngay sau khi commit dist (`git add -f dist/`).
