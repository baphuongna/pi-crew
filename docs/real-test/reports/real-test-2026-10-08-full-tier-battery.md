# Full-tier live battery — 2026-10-08 (bundle 4f764574, HEAD 0dc…/main)

Runner: parent Pi session trực tiếp (PID 239495, user session), mọi spawn là run thật.
Machine: load 0.8–2 (ês sau build); mọi probe read-only với repo (trừ 1 commit test-drift fix).

| Tier | Verdict | Evidence chính |
|---|---|---|
| T1 | ✅ 120/120 | 20.9s |
| T2 | ✅ ×3 | PI_CREW_BROKER 0/1/unset — 120/120 cả ba |
| T3 | ✅ | typecheck ok; bundle 1622.6 KB md5 4f764574 (deterministic rebuild); staleness OK |
| T4 | ✅ | session lstart 09:57:44 > dist mtime; behavior probes xanh |
| T5 | ✅ | /team-help, alt+c, Down/q, \x1bOA; **completion-popup probe (row mới)**: crash-input sống, 0 crash entry, gợi ý hợp lệ 01/02/03 |
| T6 | ✅ | pty_probe.py render TUI thật |
| T7 | ✅ | sync smoke 3/3, verifier `test:critical && tsc` 20s ≪ 600s |
| T8 | ✅ | md5 đĩa = 4f764574; symlink ../pi-crew; node_modules md5 khớp |
| T9a | ✅ 15 action | list/health/doctor/status/events/summary/graph/get/explain/worktrees/search/recommend/settings/api |
| T9b | ✅ | sync ✓ · async ✓ (detached, không inline:true) · chain ✓ 2/2 handoff (bỏ workflow theo #44) · Agent ✓ · crew_agent bg + result ✓; steer_subagent SKIP-timing (5 lần bị completion-notification chặn cửa sổ — machinery steer chứng minh qua 9c/9g) |
| T9b-W | ⚠️ **F-BAT1 (P1)** | ask/delegate/message ENOENT — CẢ sync lẫn async (2 run × 3 worker). Worker CÓ nhận PI_CREW_BROKER_SOCKET=/tmp/pi-crew-1000/pi-crew-4b3a061a.sock nhưng socket không tồn tại; ss: không listener nào; **XDG_RUNTIME_DIR absent trong env session user** (Paseo terminal) → path-divergence /tmp vs /run; graceful-degrade giữ run xanh (silent-failure class). Cần RCA + fix riêng. |
| T9c | ✅ | status details giữa chừng; steer leader-action (delivered + comply ×3); checkpoint (read); invalidate; cancel (+ownership guard từ chối đúng lần đầu, force lần sau); wait ≡ waitState ×3 |
| T9e/9f | ✅ (light) | settings get/set/unset round-trip + restore; api read-manifest; create/delete/schedule/goal-loop SKIP (mutate thật / đắt — không code path nào thay đổi trong wave) |
| T9g | ✅ TRIPLE | boot-window steer +0.5s: file 107B sống truncate-guard; PROBE_TOKEN_9G_ACK ×3 trong result; custom_message trong agent events |
| T10a | ✅ 4/4 | surface-tmux E2E (spawn/self-close, kill-pane→degrade, orphan cleanup) |
| T10b | ✅ | 3× surface_spawned / 3× surface_closed / 0 degraded / 0 gate_blocked; pane %20 thật; auto-close; provider=tmux workerPids=3; visibleAgents đã restore |
| T10c | ⏭️ skip đúng lý do | pi chạy trong Paseo terminal, không herdr pane (probe HERDR_* + process tree) |
| T11 | ✅ a–j | 11a guard + **FULL test:unit 8757/8761: 1 fail = test-drift dock-rail (F-BAT2, đã fix + 15/15)**; 11b/11c/11d/11e/11f/11g (cả 2 mirror "bottom")/11h 3×4/4/11i/11j committed-hash MATCH |
| T12 | ✅ | 12a 1/1; 12b 18/18 BOTH parsers (0 bad desc, 0 no-routing, 0 strict-YAML fail); 12c 16/16 useWhen |
| T13 | ✅ | plan card (▶ tĩnh, 0 braille, ticker 1s) · dock 2 dạng · dashboard @150/@80 right-anchor · HELP ▸ · SETTINGS ▸ · transcript; invariant sweep: undefined 0 · wire-format 0 · (loading 0 · "1 lines" 0 |

## Findings
1. **F-BAT1 (P1, mở)** — worker coordination (ask/message/delegate) ENOENT live, sync lẫn async.
   Bằng chứng: 2 run (sync team_…061857, async team_…061124) × 3 worker; env PI_CREW_BROKER_SOCKET=/tmp/pi-crew-1000/pi-crew-4b3a061a.sock (creds ĐÃ mint); socket file absent (dir trống, mtime 13:23); ss không listener; XDG_RUNTIME_DIR absent trong /proc/239495/environ (broker host fallback /tmp; các session trước bind /run/user/1000 — 2 socket stale 01:05). Unit broker suites xanh → vấn đề runtime/lifecycle, không phải protocol. Không đổi màu run (degrade) — đúng lớp "green nhưng chết".
   Đề xuất RCA: (a) vì sao socket biến mất/không bind được dù start() await thành công; (b) env-divergence XDG_RUNTIME_DIR (user launch pi từ terminal không có biến); (c) sweep /tmp/pi-crew-* (unit battery chạy đồng thời có thể dọn nhầm socket sống — cần phân biệt).
2. **F-BAT2 (đã fix trong battery)** — dock-rail.test.ts pin braille runner cũ (L10 drift), T11a-4 bắt được; fix + 15/15.
3. steer_subagent: SKIP-timing (5 attempt) — ghi nhận, không phải defect.

## Verdict
**12.5/13 tier xanh** (T10c skip đúng lý do). Một P1 mở (F-BAT1) — coordination tools cần RCA trước release. Bundle 4f764574 + 5 commit local chờ push.
