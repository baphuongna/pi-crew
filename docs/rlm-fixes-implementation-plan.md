# Implementation Plan — RLM/scratchpad Fixes (sau verification 2026-08-12)

> Source of truth: `rlm-deep-review-2026-08-12.md` (đã sửa). Mỗi phần có verification evidence.
> Workflow mỗi phần: **implement → loop review (3 reviewer song song: security / correctness / tests, read-only) → fix findings → typecheck + test → commit note**.

## Scope (6 phần không-blocked)

| # | Phần | File chính | Severity | Effort | Trạng thái |
|---|---|---|---|---|---|
| P1 | Fix global shadow poisoning | `src/runtime/scratchpad/guest.ts` | HIGH (silent corruption, reproduced) | 0.5đ | ✅ **DONE** (8 test, 3-reviewer APPROVE) |
| P2 | Demote `bash` khỏi armed roles | `src/agents/agent-config.ts` | HIGH (root cause 0-adoption) | 0.5đ | ✅ **DONE** (10 test, flag-gated, 3-reviewer APPROVE) |
| P3 | Delete HMAC dead code | `snapshot-hmac.ts` + test | MEDIUM | 0.5đ | ✅ **DONE** (deleted; threat double-conditional, ADR Superseded, roadmap R1-4/R2-2 marked removed) |
| P4 | Document `host_request` reserved-for-future | `protocol.ts` | LOW | 0.1đ | ✅ **DONE** (comment) |
| P5 | Version drift fix | `package.json` | LOW | 0.1đ | ✅ **DONE** (^0.83.0 → ^0.84.0, 4 pkg) |
| P6 | Stack trace sourcemap | `transform.ts` + `guest.ts` | MINOR | 0.5đ | ✅ **DONE** (3-layer line map: esbuild VLQ + import-rewrite + splice tracking; 10 test; loop-reviewed) |

**Skip (blocked / out-of-scope):** cross-agent namespace passing (blocked on adoption), minimal host bridge (blocked on adoption), team-runner split (maintenance, out-of-scope), event-registry type flip (high-risk maintenance), test-suite split.

## P1 — Global shadow poisoning (fix detail)

**Bug:** `installBootstrapBindings()` (guest.ts:231) chỉ register `sh`. Proxy get-trap (guest.ts:128-131) check namespace trước globalThis → cell `const process='poisoned'` poison toàn session (namespace singleton) và survive restore.

**Fix (2 lớp):**
1. Thêm `PROTECTED_GLOBALS` list + `resetProtectedGlobals()`. Trong `installBootstrapBindings()` register các Node global thật vào `INTERNAL_BINDINGS` + namespace → fix **restore path** (re-install overwrite revived shadow).
2. Gọi `resetProtectedGlobals()` ở đầu `runCell()` → fix **in-session cross-cell poisoning** (shadow chỉ local trong cell tạo nó).

**Why not refuse-write (throw):** adoption-hostile (cell fail). Reset-at-cell-start gentler, giữ within-cell shadow hoạt động bình thường, chỉ chặn persistence. snapshotNamespace vẫn skip clean globals (identity ===) nên snapshot sạch không đổi.

**Test:** `test/unit/runtime/scratchpad/guest-global-shadow.test.ts` — 3 case: (a) in-session shadow không leak cell kế, (b) shadow survive? → KHÔNG sau fix, (c) restore overwrite shadow.

## P2 — Demote bash (fix detail)

**Behavioral change có rủi ro** → dùng feature flag `PI_CREW_SCRATCHPAD_DEMOTE_BASH=1` (default off) để safe rollout. Khi flag on + role scratchpad-armed: bỏ `bash` khỏi `tools[]`, thêm vào `excludeTools[]`. Doctrine update note dùng `sh()`.

## P3 — Delete HMAC

Xóa `snapshot-hmac.ts` + `test/unit/runtime/scratchpad/snapshot-hmac.test.ts` + entry trong `index.ts` barrel (nếu có) + README mention. Verify 0 production ref (đã confirm).

## P4 — host_request

KHÔNG xóa (host bridge §5.2F planned). Thêm comment rõ "reserved for future host bridge, not yet wired" ở protocol.ts:48. (Pure documentation — dead surface nhưng forward-looking.)

## P5 — Version drift

`package.json` devDeps `@earendil-works/pi-coding-agent`: `^0.83.0` → `^0.84.0`. Re-run typecheck + test.

## P6 — Sourcemap

`transform.ts:45` bật `sourcemap: 'inline'` trong `transformSync`. Parse inline sourcemap trong error stack (runCell catch) để remap line/col về cell gốc.

---

*Mỗi phần hoàn tất sẽ được mark ✅ kèm commit hash khi commit.*

## Trạng thái cuối (sau implement + loop review)

**Đã implement (6/6):** P1, P2, P3, P4, P5, P6. Typecheck PASS, 65/65 test subset PASS (0 regression).

**Loop review đã chạy (P1, P2, P6):** mỗi phần 3 reviewer song song (security + correctness + test-engineer), read-only skill `review`. Cả 3 APPROVE; test-engineer tìm ra regression-gap/bug → tôi thêm test + fix (P1: +4, P2: +4, P6: +3 test + fix HIGH-1 message-corruption).

**P6 (đã implement sau khi probe refute các giả định naive):**
- Probe G1: esbuild strip-types KHÔNG giữ line count (7→5) → cần esbuild sourcemap thật.
- Probe G5: không có source-map lib → tự viết VLQ decoder (~40 dòng).
- Implement: `stripTypes` bật `sourcemap:'inline'` + decode VLQ (js→rewritten) + `buildImportLineMap` (rewritten→code) + splice tracking (body→js) → compose 3-layer lineMap.
- guest `remapStackLines` remap `<anonymous>:N` (N-2 wrapper offset, nearest-lower-bound identity fallback).
- Loop review: security APPROVE (0 blocking); test-engineer tìm HIGH-1 (error message chứa `<anonymous>:N:C)` bị rewrite) → fix regex anchor frame-only; +3 tests (message corruption, bare-throw no-op, cross-cell).
- KNOWN limitation (documented in test): multi-line type annotation — esbuild maps collapse point (annotation line) not the expression line; import-block lines fall back to no-remap. Cosmetic, MINOR bug, chấp nhận được.

**Bundle note:** source edits KHÔNG tự thấy trong Pi session đang chạy (pi load `dist/index.mjs` bundle). Muốn live: `npm run build:bundle` + restart extension. (Xem `.crew/knowledge.md`.)

## Live status sau build (2026-08-12)

`npm run build:bundle` đã chạy (dist/index.mjs 2.8mb). Phân tích cơ chế runtime:

| Phần | Cơ chế | Live? |
|---|---|---|
| P1 guest.ts | **spawn source** `GUEST_PATH = new URL('./guest.ts', import.meta.url)` — không qua bundle | ✅ live ngay khi edit source |
| P2 agent-config.ts | **trong bundle** (`shouldDemoteBashForScratchpad` count 2 trong dist) | ✅ live sau rebuild này |
| P3 snapshot-hmac | xóa khỏi bundle (0 ref) | ✅ live |
| P4 protocol.ts comment | doc-only | — |
| P5 package.json devDep | không runtime | — |
| P6 transform/guest.ts | **spawn source** (như P1) | ✅ live ngay |

**Còn lại:** bundle rebuild xong, nhưng **Pi session đang chạy dùng bundle cũ trong memory** → cần **cold-start** (restart Pi / extension loader) để pick up dist/index.mjs mới. Sau restart, P1/P2/P3/P6 đều hoạt động.
