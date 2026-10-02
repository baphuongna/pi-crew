# real-test-pi-crew — Run Report (SDD-3 W-C)

**Date**: 2026-10-02
**Trigger**: post-SDD-3 W-C (G12+G4 live-resume refuse, G11 runKind preserve, G13 maxAgentCalls cap, G14 estimateTokens reserve; commits `6f696548`→`2c56529c`); team run `team_20261001162336_8e9bfcf2f99cb02d` (writer task died — battery finished by parent session)
**Repo HEAD**: `2c56529c`
**Bundle md5 (disk)**: `1f27a18e3aaed4480adcfc6503b1747b` (committed — T11j green)
**Pi version**: 0.99.1
**Run by**: parent session (SDD-2 bundle) + cold-start `pi -p` probes in `/tmp/rt-sdd3` (marker: `.crew` + git). Worker model saldo was exhausted ~01:07 (blocked team's in-run battery), recovered by probe time.

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 116/116 (team-run evidence archive `evidence/sdd3-wc-reviewfix/`, 23 files) |
| 3 typecheck + bundle | ✅ | typecheck/lint/format:check/wc-gate (team-tool.ts 1279 < 2000)/event-types `--enforce`/decision-drift/env-vars all exit 0 · bundle staleness + size + test:bundle 2/2 |
| 7 smoke runs | ✅ | sync fast-fix `…adbc00dc` completed; async sleep-100 `…782e1060` completed (workers healthy post-saldo) |
| 9b-W **G12 live-refuse** | ✅ **PROVEN LIVE** | resume on live async run → verbatim refuse: *"Run … is still live (active-run registry, last heartbeat 2026-10-02T01:52:36.979Z) — resume refused to prevent double-dispatch. … force:true bypasses OWNERSHIP checks only — it can never bypass this liveness check."* — plain AND force:true both refused, actionable hint (wait/cancel) present |
| 9b-W **G11 runKind** | ✅ sync / ⚠️ async | **sync resume: completed, runKind `team-run` preserved, 1 resume_requested → re-dispatch → completed** (`…adbc00dc`). **async resume of completed run: FAILS** — see Finding 1 |
| Đỏ-trước evidence | ✅ | red-liveness: 3 fail đúng bug signature on HEAD-old → green 6/6; regression 32/32 |
| 11j committed-hash | ✅ | OK — committed dist matches fresh build (`2c56529c`) |

## Findings

1. **[MED] Resume của async run đã completed → "Async process stale: process does not exist"** — `run.resume_requested` 02:00:53 → `run.failed` 14s sau (`transitionStaleAsyncUnderLock`, `src/extension/team-tool/status.ts:82`). Sync tương phản PASS (cùng probe, cùng code). Nghi vấn: resume path không cập nhật `manifest.async.pid` cho runner mới (hoặc runner mới exit tức thì vì không còn task) → liveness-check lật failed. Chưa xác định pre-existing hay regression G11 — cần work-item follow-up (đề xuất W-C2: async-resume nên fast-forward terminal runs hoặc re-spawn runner + update pid).
2. **[MED] stale-ctx bug giết writer task**: `crew-vibes.publish-quota-status` dùng ctx đã capture sau session replacement ("This extension ctx is stale after ctx.newSession()/fork()/switchSession()/reload()") — worker writer của team-run SDD-3 chết với output rỗng (`usage=0/0/0`). Repro artifact: `team_20261001162336_…/logs/adaptive-07-writer.log`. Đề xuất: crew-vibes move post-replacement work vào `withSession`.
3. **[LOW] `timeout N pi -p` không giết được pi trong một số trường hợp** — 2 zombieObserved trong 24h (PID 2829040 `timeout 850` sống >24h47m; PID 3773158 `timeout 700` sống 8h+; cả hai đều bị SIGTERM mặc định của timeout nhưng không chết — cần SIGKILL thủ công). Pattern: pi print-mode có SIGTERM handler (exit 143) nhưng dường như có đường không trả terminal trong vài state. Đề xuất: battery dùng `timeout -k` (SIGKILL fallback) hoặc `--kill-after`.
4. **[LOW] Orphan self-heal hoạt động**: run bị giết giữa chừng resume (`…2d5e9f9d`, kẹt "running", 0 worker) tự chuyển `cancelled` trong ~15 phút (stale-reconciler) — đúng thiết kế W-D.
5. **[process] Battery-orchestrator LLM tự ý đổi thứ tự bước** (bỏ 2 bước refuse-live, đợi rồi mới resume) — battery quan trọng phải tách probe từng pi -p như đã làm; ghi nhận cho skill (đã có anti-pattern row tương tự).
6. [note] Model saldo chiase/cnb cạn lúc ~01:07 chặn battery in-run của team (executor ghi rõ) — hồi phục sau; không phải lỗi pi-crew.

## What was NOT run + why

- T5/T6/T10/T12/T13 — không có change nào trong src/ui, surface, resource .md, keybinding ở SDD-3 (decision table không yêu cầu).
- T9 FULL 9c–9f — W-C không đụng code path của chúng (khi-required rule); G12/G11 là mục tiêu live chính và đã proven.
- Full test:unit (~12 phút) — không có delayed-write conversion trong SDD-3 (11a census không đổi).

## Restart needed?

- [x] No for battery correctness — mọi probe cold-start dùng bundle SDD-3 (`1f27a18e…`).
- [ ] Parent session vẫn chạy SDD-2 bundle — restart để dùng G12/G11/G13/G14 từ session chính (không bắt buộc cho tính đúng đắn của evidence ở trên).

## Verdict

**PASS với 1 finding mở** — G12+G4 live-proven chuẩn spec; G11 sync-proven; G13/G14 unit-proven đỏ-trước; gates + T11j xanh. Finding 1 (async-resume stale) cần work-item follow-up trước hoặc trong SDD-4. Writer-task stale-ctx (Finding 2) nên fix riêng vì nó đã 2 lần giết task cuối của run implementation.
