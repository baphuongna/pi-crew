# pi-crew — Review & Upgrade Findings (2026-07)

Tổng hợp review toàn bộ project và các cơ hội nâng cấp/cải thiện, kèm **bằng chứng verification thực tế** (đã chạy lệnh, không suy đoán).

- Phiên bản đánh giá: **v0.9.28**
- Môi trường kiểm chứng: Node **v22.14.0**, npm **10.9.2**, Windows (win32 10.0.22631)
- Quy mô: **453** file nguồn (`src/**/*.ts`, ~**93.206** dòng), **652** file test
- Quy ước mức độ: 🔴 Cao · 🟡 Trung bình · ⚪ Thấp/Hygiene
- Quy ước effort: S (<0.5 ngày) · M (0.5–2 ngày) · L (>2 ngày)

> **Review bộ core** (scheduler, child-process lifecycle, state durability/concurrency, worktree, conflict detection): xem `docs/REVIEW-FINDINGS-2026-07-CORE.md` — 9 finding đã verify trực tiếp + 12 finding cần repro.

## Baseline health (đã verify)

| Kiểm tra | Lệnh | Kết quả | Bằng chứng |
|----------|------|---------|------------|
| Typecheck | `npm run typecheck` | ✅ PASS (16.7s) | `tsc --noEmit` OK + `strip-types import ok` |
| Unit test (mẫu) | `test/unit/{token-counter,conflict-detect,model-fallback}.test.ts` | ✅ 80/80 pass (0.67s) | node:test summary `# fail 0` |
| Unit suite (full) | `npm run test:unit` | ⚠️ chậm — vượt 420s cục bộ (timeout) | ~5800 test, budget CI 15 phút |
| Lint | `npm run lint` | ❌ FAIL — 6 lỗi (FIXABLE) | `assist/source/organizeImports` |
| Deps | `npm outdated` | ⚠️ 5 gói lỗi thời | xem F5/F6 |

## Bảng tổng hợp findings

| ID | Vấn đề | Mức | Effort | Khu vực |
|----|--------|-----|--------|---------|
| F1 | `npm run lint`/`npm run ci` fail — 6 lỗi import-sort | 🟡 | S | Chất lượng |
| F2 | `.gitignore` có dòng nối sai + trùng lặp | 🟡 | S | Hygiene/Git |
| F3 | CI không gate `lint`/`format`/`check:*` (khác local `ci`) | 🟡 | S | CI |
| F4 | Artifact bug: thư mục `undefined/.pi/teams/...` | 🟡 | M | Runtime/paths |
| F5 | Deps minor an toàn cần nâng (biome/tsx/esbuild) | ⚪ | S | Deps |
| F6 | Deps major cần plan (diff 5→9, TypeScript 7) | ⚪ | M-L | Deps |
| F7 | Unit suite chậm (>7 phút cục bộ) — DX | ⚪ | M | Test/DX |
| F8 | API `@deprecated` còn tồn tại — dọn ở bản major | ⚪ | S | Maintainability |
| F9 | Thư mục rác ở root (đã dọn 2026-07) | ⚪ | S | Hygiene |

---

## 🟡 Mức Trung bình

### F1 — `npm run lint` fail với 6 lỗi import-sort

**Bằng chứng:** `npm run lint` → exit 1, `Found 6 errors`, tất cả gắn nhãn `FIXABLE` (`assist/source/organizeImports`).

File liên quan:
- `src/extension/crew-vibes/index.ts`
- `src/prompt/prompt-runtime.ts`
- `src/runtime/cross-extension-rpc.ts`
- `test/unit/api-key-scoping.test.ts`
- `test/unit/rpc-hmac-auth.test.ts`
- `test/unit/token-counter.test.ts`

**Tác động:** `npm run ci` (pipeline "full CI" ghi trong CLAUDE.md) fail cục bộ ở bước `lint`. CI trên GitHub không bắt (xem F3) nên lỗi tồn tại âm thầm.

**Giải pháp:** `biome check --write` (auto-fix reorder import). **Verify:** `npm run lint` → 0 errors.

### F2 — `.gitignore` có dòng nối sai + trùng lặp

**Bằng chứng:** dòng `!.crew/graphs/.gitkeepfallow-audit-report/` — negation `!.crew/graphs/.gitkeep` bị nối nhầm với `fallow-audit-report/` (nghi do merge/paste). Hệ quả: cả 2 pattern đều không hoạt động đúng. Ngoài ra có trùng lặp: `dist/` (x2), `.crew/worktrees/` (x2), `/.crew/` vs `/.crew`.

**Giải pháp:** tách lại thành 2 dòng đúng (`!.crew/graphs/.gitkeep` và `fallow-audit-report/`) + gộp dòng trùng. **Verify:** `git check-ignore -v .crew/graphs/.gitkeep` và `git check-ignore -v fallow-audit-report/x`.

### F3 — CI không gate lint/format/check

**Bằng chứng:** `.github/workflows/ci.yml` job `test` chỉ chạy: `npm run typecheck`, `npm test`, `npm pack --dry-run`. KHÔNG có `npm run lint`, `format:check`, hay `check:*`. Local `npm run ci` thì có → drift (F1 minh chứng: lint đỏ nhưng CI vẫn xanh).

**Giải pháp:** thêm 1 job `quality` chạy `npm run lint && npm run format:check` (hoặc gọi `npm run ci` trực tiếp). **Verify:** push nhánh → xem GitHub Actions.

### F4 — Artifact bug: thư mục `undefined/.pi/teams/...`

**Bằng chứng:** tồn tại thư mục thật ở root: `undefined/.pi/teams/state/runs` (layout `.pi/teams` legacy). Một code path đã resolve base root thành chuỗi `"undefined"` (nhiều khả năng `path.join(String(rootUndefined), ".pi", "teams")` hoặc template literal `${cwd}` với `cwd` undefined). Là dữ liệu untracked (không thuộc git, không match `.gitignore`).

**Giải pháp:**
1. Dọn thư mục (đã thực hiện 2026-07, xem F9).
2. Root-cause + guard: chặn ghi state khi root resolve về undefined/empty (throw hoặc fallback rõ ràng) tại các điểm resolve crewRoot trong `src/utils/paths.ts` / `src/state/crew-init.ts`.

**Verify:** thêm unit test cho path-resolver khi input undefined → không tạo path `"undefined"`.

---

## ⚪ Mức Thấp / Hygiene / Deps

### F5 — Deps minor an toàn

**Bằng chứng (`npm outdated`):**

| Gói | Current | Latest | Loại |
|-----|---------|--------|------|
| `@biomejs/biome` | 2.4.15 | 2.5.3 | minor |
| `tsx` | 4.22.3 | 4.23.0 | minor |
| `esbuild` | 0.28.0 | 0.28.1 | patch |

Lưu ý: `@earendil-works/pi-*` current 0.77.0 > "latest" 0.74.2 → đang dùng kênh pre-release, **không** hạ.

**Giải pháp:** nâng 3 gói trên. **Verify:** `npm run typecheck && npm run lint && npm run test:unit (mẫu)`.

### F6 — Deps major (cần story riêng)

`diff` 5.2.2 → 9.0.0 (đổi ESM/API, ảnh hưởng `conflict-detect`), `typescript` 5.9.3 → 7.0.2 (native compiler, còn sớm cho production typecheck). → tách story: `docs/stories/US-DEPS-major-upgrade.md`.

### F7 — Unit suite chậm (DX)

**Bằng chứng:** `npm run test:unit` vượt 420s cục bộ. `scripts/test-runner.mjs` ghi chú ~5800 test, budget 15 phút trên Windows CI. Có sẵn `npm run test:changed` nhưng không phải mặc định vòng dev.

**Giải pháp (đề xuất):** sharding hoặc khuyến nghị `test:changed` cho vòng dev; giữ full suite cho CI.

### F8 — API `@deprecated` còn tồn tại

**Bằng chứng:** `src/state/event-log.ts` (sync `appendEvent`), `src/ui/tool-render.ts`, `src/runtime/stale-reconciler.ts` (legacy error builder), `src/runtime/team-runner.ts` (`mergeTaskUpdates` cũ), `src/extension/pi-api.ts` (drift detector removed). → gỡ ở bản major kế tiếp sau khi xác nhận không còn caller ngoài test-compat.

### F9 — Dọn thư mục rác ở root (ĐÃ THỰC HIỆN 2026-07)

Đã xóa (được người dùng ủy quyền):
- `undefined/` — artifact bug (F4)
- `tmp-glyph-previews/` — untracked (2 entries)
- `.test-artifacts-tmp/`, `.test-artifacts-tmp2/` — ignored, do test bỏ lại (3 entries mỗi cái)

---

## Ưu tiên đề xuất

1. **P0 (quick win):** F1 (fix lint) + F2 (fix .gitignore).
2. **P1:** F3 (CI gate lint) + F4 (root-cause bug undefined).
3. **P2:** F5 (minor deps) → F7 (test DX).
4. **Backlog:** F6 (major deps, story riêng) + F8 (dọn deprecated ở major).
