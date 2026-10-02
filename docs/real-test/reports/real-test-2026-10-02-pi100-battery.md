# Real-test battery — pi 1.0.0 host wave (T5/T6/T10/T13) · 2026-10-02

**Scope**: hoàn nốt T5/T6/T10/T13 cho wave pi 1.0.0 (sau `192c8d6b` bump devDeps
`^0.99.1`→`^1.0.0`, bundle không đổi `a0edaed9`). Host `pi` binary = **1.0.0**
theo doctor probe. Đóng gap **G-C** (render fullscreen alt-screen chưa kiểm chứng)
từ `docs/pi-1.0.0-compat-research-2026-10-02.md` §8.

## Kết quả

| Tier | Status | Evidence |
|---|---|---|
| 5 tmux fullscreen (default 1.0.0) | ✅ | scratch `/tmp/rt-t5`, tmux 160x50 `-S /tmp/sock-t5`; `/team-help` render **đầy đủ danh sách lệnh** (/teams, /team-run, /team-status, /team-summary, /team-resume, /team-cancel, /team-retry, /team-respond…); app-cursor-mode `\x1bOA` được nhận — screen coherent sau phím (chỉ scroll bình thường, không garbage) |
| 5 tmux regular (`--tui-mode regular`) | ✅ | `/team-doctor` render báo cáo đầy đủ; **doctor tự xác nhận `pi command: 1.0.0`**; runtime/fs/config 0 errors; model zai/glm-5.3 OK |
| 6 pty bulk-keys | ⏭️ | T5 xanh cả 2 tuiMode (T5\|T6 either theo skill); không có nhu cầu bulk-key cho diff này |
| 10a surface E2E | ✅ | `test/system/surface-tmux.e2e.test.ts` **4/4** · `surface-herdr.e2e.test.ts` **5/5** — cả hai backend thật trên môi trường pi 1.0.0 |
| 13 real-run UI render | ✅ | Harness `/tmp/full-ui.ts` (template skill) render **11 surface** từ run THẬT `team_20261002114852_4b2d2e704b2bebd5` (smoke pi-1.0.0 ở `/tmp/rt-pi100`): CALL/STREAMING(via producer)/COLLAPSED/EXPANDED/EXPANDED@80/DOCK×4/PLAN CARD/SIDEBAR. Sweeps **0 hit**: undefined · `->` · wire-format (input=/cacheRead=) · pluralisation · spinner+0-running · over-width · hint-clipped. Glyph đúng state: `✓` done · `⠦` running (1 running) · `✗` failed. Narrow `done@50`: `↓·enter` **sống** ở 50 cột |
| 13 catalog regen trên pi-tui 1.0.0 | ✅ | `capture.ts` + `render_png.py` chạy với node_modules pi-tui **1.0.0**: 18 captures + 18 PNG, glyph self-check ✓ hết. Diff chỉ là **catch-up nội dung** (keybinding `X cancel` mới hiển thị trong 06-help-overlay + 13-run-dashboard header) — KHÔNG phải regression pi-tui; cấu trúc rail/glyph/dots nguyên vẹn |

## Ghi chú

- T2/T3 không chạy lại: bundle bytes **không đổi** (`a0edaed9`) sau deps bump —
  SDK/pi-tui là bundle-external (nghiên cứu M6), kết quả T2/T3 của bundle này
  vẫn hiệu lực từ battery SDD-4.
- T13 PNG visual-inspect bằng glyph self-check của renderer (model leader không
  xem ảnh); self-check fail-to trên missing glyph nên ✓18/18 là gate đủ.
- Warning môi trường (không liên quan pi-crew): stderr `pi-qwen-mm … system tool
  missing — visualize` từ plugin MCP của user, thấy ở capture T5.

## Phán quyết

**pi-crew trên host pi 1.0.0: T5/T10/T13 xanh cả hai tuiMode. Gap G-C đóng.**
Wave 1.0.0 hoàn tất: research → bump → gates → smoke → battery.
