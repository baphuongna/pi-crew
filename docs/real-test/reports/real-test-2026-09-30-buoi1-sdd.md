# real-test-pi-crew — Run Report

**Date**: 2026-09-30
**Trigger**: post Buổi-1 SDD execution (G1 fence + NEW-1 persistTasks + G18 breakdown + comments + dist rebuild), commits `95529c6f..79112510` trên v0.11.5
**Repo HEAD**: `79112510`
**Bundle md5 (disk)**: `6a0f3c49992fafca6bb247e38fd0f56c` (1578.9 KB)
**Pi version**: 0.99.1 (host `/home/bom/.nvm/versions/node/v22.23.1/bin/pi`)
**Run by**: leader agent (session cũ — old bundle; battery chạy qua fresh cold-start `pi -p`, xem T4)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | `116/116` pass, 0 fail, ~13s (fresh run tại HEAD 79112510) |
| 2 3-path kill-switch | ⏭️ | không đổi `src/config/defaults.ts` / `lifecycle-handlers.ts` — ngoài decision table |
| 3 typecheck + bundle | ✅ | typecheck exit 0 "strip-types import ok" · build 1578.9 KB · md5 `6a0f3c49…` · staleness OK (ARCH-7) · `test:bundle` 2/2 |
| 4 bundle md5 sync | ✅ | extension load qua repo path (`~/.pi/agent/settings.json` → `../../source/my_pi/pi-crew`, KHÔNG phải npm global) · fresh cold-start `pi -p` thấy schema/action mới = chứng minh load bundle mới · md5 disk = repo dist = `6a0f3c49…` |
| 5 tmux TUI probe | ⏭️ | không đổi `src/ui/**` |
| 6 pty probe | ⏭️ | không đổi `src/ui/**` |
| 7 smoke team run | ✅ | runId `team_20260930153252_35699b4f6214c237`, fast-fix 3/3 task, manifest `status: completed`, sync async=false, KHÔNG hang (battery tổng < ~14' gồm 3 worker + verifier) |
| 8 final md5 sync | ✅ | disk `6a0f3c49…` = path session cold-start load (repo dist) — session CHÍNH của leader vẫn old bundle (cần user restart để thấy code mới, xem "Restart needed") |
| 9a read-only battery | ✅ (subset theo thay đổi) | `status` + `breakdown` (action mới) + `events` ngầm qua run — trả structured, 0 "Unknown type"/"Validation failed" (schema mới validate trước handler OK) |
| 9b spawn paths | ✅ (sync path) | sync fast-fix run `consistency` ok, 3 worker spawn, verifier hoàn tất — các path async/chain/Agent/crew_agent không đổi code → không chạy (gi tiết kiệm token) |
| 9b-W worker tools | ⏭️ | không đổi `src/prompt/**` worker tools |
| 9c lifecycle | ⏭️ | không đổi lifecycle path |
| 9d destructive | ⏭️ | không đổi; không chạy không cần thiết |
| 9e admin | ⏭️ | không đổi resource CRUD |
| 9f background | ⏭️ | không đổi background/schedule |
| 10a/10b/10c surface | ⏭️ | không đổi `src/runtime/surface/**` |
| 11 remediation regression | ✅ (11j + pinned) | **11j committed-hash OK** (committed dist == fresh build) · stale-reconciler pinned: `test/unit/runtime/core/stale-reconciler.test.ts` 29/29 (gồm 3 persistTasks mới) — suites rotation/sentinel-reclaim không đổi logic vòng quét (chỉ thêm return field) nên cover qua 29/29 này + đỏ-trước đã chứng minh |
| 12 resource contracts | ⏭️ | không đổi agents/*.md / skills |
| 13 real-run UI render | ⏭️ | không đổi `src/ui/**` |

### G18 end-to-end (mục tiêu chính của battery)
`PI_CREW_PROMPT_BREAKDOWN=1 pi -p` (cold-start, scratch cwd `/tmp/rt-20260930-buoi1` có marker `.crew`):
1. Artifact written: `artifacts/metadata/{01_explore,02_execute,03_verify}.prompt-breakdown.json` — 3/3 file trên đĩa ✓
2. **Indexed**: `manifest.json` chứa 3 descriptor `prompt-breakdown` (grep 6 hits) — fix `8e123d87` hoạt động trên run thật ✓
3. **Action đọc được**: `team action='breakdown'` trả bảng thật — 01_explore ~3251 tok · 02_execute ~3802 · 03_verify ~5120 · run total ~12173, top-5 section mỗi task ✓
4. Seam G1 chạy live: prompt `02_execute.md` + `03_verify.md` chứa fence `<dependency-context>` (03_verify có `dynamic.dependencyContext` ~354 tok = 1417 chars đi qua `renderDependencyOutputContext` đã sanitize) ✓
5. stderr battery: 0 error/unhandled; SIGTERM cleanup sạch ✓
6. `git status` pi-crew sau battery: sạch — không agent nào sửa file trái phép ✓

## Findings (bugs / quirks / non-blocking notes)
- **OBS-1 (non-blocking)**: `pi -p` không tự exit sau khi in `BATTERY_DONE` — process sống đến khi `timeout 850` SIGTERM (cleanup sạch). Không do diff này (không đụng lifecycle/loop); khả năng broker socket giữ event loop trong print mode. Cần baseline old-bundle để khẳng định pre-existing — không làm trong run này. Theo dõi ở lần -p kế tiếp.
- **OBS-2 (note)**: scratch cwd battery `/tmp/rt-20260930-buoi1` — run state + artifacts nằm đó (không dính auto-prune của my_pi). Có thể xoá tự do sau khi đọc evidence.

## What was NOT run + why
- T2/T5/T6/T10/T12/T13, 9b async/chain/subagent paths, 9c-9f — decision table không yêu cầu cho diff này (không đụng broker/ui/surface/agents/config/lifecycle); tiết kiệm token.
- Full `npm test` (~14') — đang tồn đọng riêng (SDD §12 mục 2), chạy trước release.

## Restart needed?
- [x] Yes (cho session CHÍNH của leader) — user `/quit` + reopen để session này thấy bundle mới (md5 old: session-loaded ≠ `6a0f3c49…` → new: `6a0f3c49992fafca6bb247e38fd0f56c`). Các session/worker cold-start sau thời điểm rebuild đã tự động dùng bundle mới (đã chứng minh qua battery).
- [ ] No

## Verdict
**Tất cả tier bắt buộc cho diff Buổi-1 PASS kèm evidence** (T1/T3/T4/T7/T8/T9-subset/11j+stale-pinned). G1 seam + NEW-1 + G18 (write→index→read) hoạt động end-to-end trên run thật với bundle mới. An toàn ship khi user quyết release (sau khi chạy full `npm test` tồn đọng). OBS-1 theo dõi, không chặn.
