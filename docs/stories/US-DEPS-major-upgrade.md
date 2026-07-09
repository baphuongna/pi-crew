# US-DEPS-major-upgrade — Nâng cấp dependencies major

- **Lane:** normal (Dependency) — có thể tách thành 2 patch độc lập
- **Status:** planned
- **Nguồn:** `docs/REVIEW-FINDINGS-2026-07.md` (F6)
- **Ngày tạo:** 2026-07-09

## Overview

`npm outdated` (Node v22.14.0, v0.9.28) cho thấy 2 gói lệch **major**:

| Gói | Current | Latest | Rủi ro |
|-----|---------|--------|--------|
| `diff` | 5.2.2 | 9.0.0 | API/ESM breaking |
| `typescript` | 5.9.3 | 7.0.2 | compiler mới (native) |

Cả hai KHÔNG gộp chung; mỗi cái là một patch riêng có validation độc lập.

## Phần A — `diff` 5 → 9

### Design
- `diff` v6+ chuyển sang ESM-first và tinh chỉnh chữ ký hàm (`structuredPatch`, `diffLines`, `applyPatch`...). Cần rà soát mọi import.
- Điểm chạm chính: `src/utils/conflict-detect.ts` (và bất kỳ nơi nào import `diff`).

### Exec plan
1. `git grep -n "from \"diff\"" src test` để liệt kê toàn bộ callsite.
2. Đọc CHANGELOG của `diff` v6/v7/v8/v9, lập bảng breaking → mapping.
3. `npm i diff@9`, sửa callsite theo API mới.
4. Chạy `npm run typecheck` + test liên quan (`conflict-detect.test.ts`, `delta-conflict.test.ts`).

### Validation
- `npm run typecheck` → PASS
- `node scripts/test-runner.mjs ... test/unit/conflict-detect.test.ts test/unit/delta-conflict.test.ts` → pass
- `npm run test:unit` full → không hồi quy

## Phần B — `typescript` 5.9 → 7.0

### Design
- TS 7.0 là compiler native (tsgo). Cần đánh giá:
  - Tương thích flags trong `tsconfig.json` (`allowImportingTsExtensions`, `NodeNext`, `strict`).
  - Tương thích với `tsx`/strip-types runtime path (index.ts import qua `--experimental-strip-types`).
  - Khả năng phát sinh lỗi type mới do compiler chặt hơn.
- Rủi ro cao hơn A; cân nhắc chờ hệ sinh thái ổn định (còn sớm giữa 2026).

### Exec plan
1. Thử trên nhánh riêng: `npm i -D typescript@7`.
2. `npm run typecheck` — thu thập toàn bộ lỗi mới, phân loại.
3. Nếu lỗi ít/định vị được → sửa; nếu diện rộng → hoãn, ghi decision.
4. Xác nhận `tsx` + strip-types vẫn chạy (`node --experimental-strip-types -e "await import('./index.ts')"`).

### Validation
- `npm run typecheck` → PASS
- `npm run test:unit` → không hồi quy
- Cold-start bench (`npm run bench`) → không xấu đi

## Rollback
- Mỗi phần là 1 commit độc lập; revert commit tương ứng nếu hồi quy.
- Giữ `package-lock.json` cũ để pin lại nhanh.

## Ghi chú quyết định
- Ưu tiên Phần A trước (rủi ro thấp hơn, phạm vi hẹp).
- Phần B nên có `docs/decisions/` entry trước khi merge (thay đổi toolchain cốt lõi).
