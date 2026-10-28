# real-test 2026-10-28 — FULL battery cho diff v0.11.45→f156d0c6 (waves 0.11.46/0.11.47/0.11.48 + battery-gate)

Ngữ cảnh: incident 0.11.46/0.11.47 (silent worker death) bị T7 bắt sau khi 2 bản đã publish (xem
update block 2026-10-28 trong SKILL.md). Battery này chạy FULL decision table cho TOÀN BỘ diff
v0.11.45..HEAD theo meta-rule mới: skill cập nhật trước (commit `f156d0c6`), battery full sau,
không cherry-pick tier.

## Matrix kết quả

| Tier | Triggered bởi diff? | Kết quả | Evidence |
|---|---|---|---|
| T1 critical | luôn | ✅ | 127/127 (battery script; T2-path unset: 115 pass/0 fail) |
| T2 kill-switch 3 đường | chạy đầy đủ (rẻ) | ✅ | unset 0 fail · `PI_CREW_BROKER=0` 127/127 · `=1` 127/127 |
| T3 staleness | dist/ | ✅ | OK — dist mới hơn src 298.5s |
| T4 bundle vào session | dist/ | ✅* | md5 disk == consuming symlink `d25896ab…` |
| T5/T6 TUI probes | ✗ không trigger | — | src/ui + command-completions không đổi trong diff |
| T7 live smoke | broker/child-pi/prompt/ | ✅ | battery script ×4 lần: run.completed clean, 0 fingerprint `empty-or-stderr-only-result` (đợt 0.11.46 pre-hotfix: fingerprint XUẤT HIỆN ×3 attempts — regression được chứng minh dương+tính) |
| T8 md5 session sync | dist/ | ✅* | như T4; session dài hạn đang sống giữ bundle load lúc start (caveat chuẩn — user restart để parent-side mới; mọi headless spawn cold-start dist mới) |
| T9a read-only battery | chạy đầy đủ | ✅ | 8/8 actions (list/health/doctor/recommend/search/get/settings/help) — 0 schema/registration error |
| T9b spawn paths | sync=T7 · Agent-direct | ✅ | Agent-direct probe: spawn + reply chuẩn (đường này chết cả ngày 27/10 pre-hotfix) |
| T9b-W worker tools | broker/ + delegate-request file MỚI | ✅ | message: `delivered to 'parent'` (env-token legacy route); delegate: `requested → admitted → completed → task.completed` live qua `crew-broker-delegate-request.ts`; ask không chạy (wait-resolver không đổi trong diff) |
| T9g steer round-trip | child-pi/ | ✅ | boot-window steer (watcher +0.5s) delivered: token `PROBE_TOKEN_ACK` trong 01_explore result; run 3/3 (~101s) |
| T10 surface panes | ✗ không trigger | — | src/runtime/surface/ không đổi |
| T11c migration validator | config/env-vars.ts | ✅ | offline probe: hasWarnings=true, 2 keys `removed` đúng expected |
| T11j committed-hash | dist/ | ✅ | committed dist == fresh build (battery script) |
| T12 resource contract | skills .md đổi (prose only) | ✅ | agent-output-contracts 1/1; frontmatter/metadata không đổi |
| T13 UI render | ✗ không trigger | — | src/ui/ không đổi |

## Ghi chú

- T9b-W delegate run bị kill bởi timeout 570s của probe (provider glm ~2'/turn) — KHÔNG phải fail;
  delegate round-trip đã hoàn tất trong events trước khi kill (`task.completed` 01_explore).
- Provider 429 rate-limit xuất hiện 1 lần giữa các probe (burst sau chuỗi battery) — retry sau 150s xanh.
- Battery hard-gate (`scripts/pre-publish-battery.mjs`) tự chạy trong pre-push của chính commit skill
  này: T7 not-triggered (diff tooling/docs only) → ALL GREEN 14s — logic path-trigger hoạt động đúng.

## Kết luận

FULL battery theo decision table cho toàn bộ diff 0.11.45→HEAD: **PASS toàn diện**. V0.11.48 trên
npm là bản an toàn để dùng; các tier không-trigger đều ghi lý do minh bạch ở trên.
