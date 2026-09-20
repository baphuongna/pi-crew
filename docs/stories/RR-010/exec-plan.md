# RR-010 — Exec plan: hợp đồng snapshot/cleanup worktree (F01)

- **Lane:** high-risk
- **Status:** planned — **không bắt đầu khi chưa có phê duyệt** (plan §6)
- **Nguyên tắc:** regression test trước, sửa sau (plan §3.1). Mỗi bước RED phải
  fail **vì đúng lý do** (assertion về mất dữ liệu), không vì lỗi biên dịch.
- **Không chạy full suite trong vòng lặp RED→GREEN.** Dùng `targeted`; full suite
  ở `validation.md` trước khi đóng story.

## 0. Chuẩn bị

```bash
cd /home/bom/source/my_pi/pi-crew
git status --short          # phải sạch trước khi bắt đầu
npm run typecheck           # baseline phải xanh
```

Ghi lại `git rev-parse HEAD` làm **rollback point R0**.

Seed test từ probe trong
`docs/archive/2026-09-17-pi-crew-review-verification.md` §4 F01:

- **P1:** untracked file 307200 byte (`big-untracked.bin`), gọi lại
  `prepareTaskWorkspaceAsync` → quan sát cũ: `second.reused = true`, file gốc
  không còn, artifact ghi `(truncated: 307200 → 262144 bytes)`.
- **P2:** file `chmod 000` (`secret.txt`, 111 byte) → quan sát cũ:
  `snapshotDirtyWorktree` trả `true`, artifact **không nhắc tới `secret.txt`**.

## Bước 1 — RED (thuần): bất biến `complete` của kết quả snapshot

**Tạo:** `test/unit/worktree/worktree-snapshot-completeness.test.ts`

Nội dung tối thiểu:

1. `shouldDiscardDirtyWorktree({ complete: false, truncated: [...], skipped: [], ... }, false) === false`
2. `shouldDiscardDirtyWorktree({ complete: false, ... }, true) === true`
3. `shouldDiscardDirtyWorktree({ complete: true, truncated: [], skipped: [] }, false) === true`
4. Bất biến: `complete === true` ⇒ `truncated.length === 0 && skipped.length === 0
   && trackedDiffError === undefined && writeError === undefined`
5. `truncated` giữ `originalSize` gốc (không phải kích thước sau cắt).

Ở thời điểm RED, các symbol này **chưa tồn tại** → test fail khi import. Để RED có
ý nghĩa (fail vì hành vi, không vì thiếu symbol), **tách làm hai lần commit**:

- **Bước 1a — RED hành vi:** chỉ viết phần 4/5, gọi `snapshotDirtyWorktree` với
  fixture nhỏ và assert `result.complete`/`result.truncated`. Test fail vì
  `result` là `boolean` (không có thuộc tính `complete`) — **ghi lại dạng fail
  này** trong `validation.md` §Evidence (đây là RED "hành vi", chấp nhận được vì
  bản thân kiểu trả về là khiếm khuyết).
- **Bước 1b — thêm phần 1/2/3** sau khi bước 2 tạo symbol; từ đây test chỉ còn
  khẳng định hành vi.

```bash
node scripts/test-runner.mjs test/unit/worktree/worktree-snapshot-completeness.test.ts
```

**Kỳ vọng RED:** fail (symbol chưa có / `complete` là `undefined`).
**Rollback:** xoá file test mới; không chạm `src/`.

## Bước 2 — GREEN tối thiểu: kết quả có cấu trúc + predicate thuần

**Sửa:** `src/worktree/worktree-manager.ts`

- Thêm `WorktreeSnapshotResult` (design §3.1) và
  `shouldDiscardDirtyWorktree(result, force)` (design §3.2).
- `snapshotDirtyWorktree` dựng result: `truncated` cho entry > cap, `skipped` cho
  nhánh `catch` ở `:716-718`, `trackedDiffError` cho `catch` ở `:676-681`,
  `writeError` cho `catch` ngoài.
- **Ghi tên entry bị bỏ qua vào chính artifact** (ví dụ một mục
  `## Skipped entries (not backed up)` liệt kê `path` + lý do). Điều này là điều
  kiện để Case B ở bước 3 chuyển GREEN — nếu chỉ có `skipped` trong object trả về
  mà artifact vẫn im lặng, Case B vẫn đỏ.
- **Chưa đổi hai cổng cleanup** ở bước này (giữ diff nhỏ, dễ review).

```bash
node scripts/test-runner.mjs test/unit/worktree/worktree-snapshot-completeness.test.ts
npm run typecheck
```

**Kỳ vọng GREEN:** test bước 1 pass.
**Rollback:** `git checkout -- src/worktree/worktree-manager.ts` (R0).

## Bước 3 — RED (integration): bytes gốc phải còn nguyên (AC1, AC3, AC8)

**Tạo:** `test/integration/worktree-snapshot-preserve-dirty.test.ts`
(self-skip khi thiếu `git`, theo tiền lệ `hasGit()` trong
`test/integration/worktree-snapshot-dirs-binary.test.ts`).

Fixture:

- repo git tạm + 1 commit; `git worktree add` một worktree.
- **Case A (AC1, AC10):** tạo `big-untracked.bin` 307200 byte trong worktree; gọi
  `prepareTaskWorkspaceAsync(manifest, task)` lần 2 (reuse); assert (a) file **còn
  tồn tại** và nội dung **khớp từng byte** với buffer đã ghi, (b) artifact snapshot
  **có** được ghi (đọc thư mục `artifactsRoot/worktree-recovery`) — cặp assert (a)+(b)
  là bằng chứng cho AC10: artifact tồn tại không kéo theo việc dọn worktree.
- **Case B (AC3):** tạo `secret.txt` 111 byte rồi `chmod 000`; gọi reuse; assert
  file còn tồn tại, và artifact **có nhắc tên** `secret.txt` (kèm lý do bỏ qua).
  Trên `win32`: `t.skip("chmod 000 không mô phỏng được trên Windows")`.
- **Case C (AC8):** lặp Case A bằng `prepareTaskWorkspace` (sync).

```bash
node scripts/test-runner.mjs test/integration/worktree-snapshot-preserve-dirty.test.ts
```

**Kỳ vọng RED:** Case A và C fail ở assert "file còn tồn tại" (quan sát cũ:
file đã bị `clean -fd` xoá). Case B fail ở assert artifact có tên file.
**Rollback:** xoá file test mới.

**Lưu ý fixture:** `prepareTaskWorkspace` (sync) dùng cache `syncCleanLeaderCache`
nhưng **chỉ cache verdict clean**, và worktree dirty không đi qua nhánh cache đó.
Nếu Case C flaky, gọi `clearCleanLeaderCache()` / `clearGitRootCache()` (đã export
từ `src/worktree/worktree-manager.ts`) giữa các case.

## Bước 4 — GREEN: nối predicate vào hai cổng cleanup

**Sửa:** `src/worktree/worktree-manager.ts` — hai vị trí `:855-863` (sync) và
`:1015-1023` (async):

- Thay `const snapshotOk = snapshotDirtyWorktree(...)` + `if (snapshotOk)` bằng
  result + `shouldDiscardDirtyWorktree(result, options?.force === true)`.
- Nhánh `else` (`worktree.reused.dirtyPreserved`) giữ nguyên, bổ sung lý do vào
  message: số entry truncated, số entry skipped, `trackedDiffError`.
- Thêm tham số options (`{ force?: boolean }`) vào `prepareTaskWorkspace` và
  `prepareTaskWorkspaceAsync`; **không** thêm config key.

```bash
node scripts/test-runner.mjs test/integration/worktree-snapshot-preserve-dirty.test.ts
node scripts/test-runner.mjs test/integration/worktree-snapshot-dirs-binary.test.ts test/unit/worktree/worktree-async.test.ts
npm run typecheck
```

**Kỳ vọng:** Case A/B/C pass; hai file test cũ pass (có thể cần đổi assert
`snapshotOk === true` → `result.complete === true` — xem bước 5 nếu fail).
**Rollback:** R0 hoặc `git checkout -- src/worktree/worktree-manager.ts`.

## Bước 5 — Đồng bộ test cũ theo contract mới

**Sửa:** `test/integration/worktree-snapshot-dirs-binary.test.ts` — hai test ST-1b
và ST-1 hiện assert `assert.equal(snapshotOk, true, ...)`. Đổi sang
`assert.equal(result.complete, true, ...)`; giữ nguyên mọi assert về nội dung
snapshot (non-ASCII, base64 round-trip, `GIT binary patch`). Đây là AC9.

**Kiểm tra thêm:** `test/unit/worktree/worktree-async.test.ts` có test
`prepareTaskWorkspaceAsync reuses existing worktree` (không dirty) — phải vẫn
pass mà không cần sửa; nếu phải sửa, đó là dấu hiệu hồi quy hành vi, dừng và
báo lại leader.

```bash
node scripts/test-runner.mjs test/integration/worktree-snapshot-dirs-binary.test.ts test/unit/worktree/worktree-async.test.ts
```

**Rollback:** `git checkout -- test/integration/worktree-snapshot-dirs-binary.test.ts`.

## Bước 6 — RED→GREEN: allocation bound (AC5)

**Lưu ý tính chất RED:** sau bước 2, `truncated[0].originalSize` **đã** đúng (kết quả
có cấu trúc), nên assertion đó không còn là RED. RED thật của bước này phải là
**số byte được đọc**: test phải khẳng định tiến trình không cấp phát theo kích
thước file. Hai cách, chọn cách không phụ thuộc timing:

- (a) đo RSS quanh lời gọi với fixture sparse lớn — ngưỡng rộng, chỉ Linux/macOS; hoặc
- (b) assert số byte đọc tối đa qua seam đọc file (nếu tách được helper đọc file
  thành hàm riêng để test trực tiếp — cách này tất định hơn, ưu tiên).

Nếu chọn (b), việc tách helper là thay đổi `src/` thuộc bước này.

**Sửa (extend):** `test/unit/worktree/worktree-snapshot-completeness.test.ts`

**Sửa:** `src/worktree/worktree-manager.ts` — thay `fs.readFileSync(abs)` bằng đọc
có trần `MAX_FILE_BYTES + 1` byte qua `openSync`/`readSync`/`closeSync`; đóng file
trong `finally`.

```bash
node scripts/test-runner.mjs test/unit/worktree/worktree-snapshot-completeness.test.ts
npm run typecheck
```

**Kỳ vọng:** test AC5 pass; Case A/B/C ở bước 3 vẫn pass.
**Rollback:** `git checkout -- src/worktree/worktree-manager.ts`.

## Bước 7 — AC6: lỗi diff tracked là "không đầy đủ"

**Lưu ý tính chất RED:** `trackedDiffError` đã được thêm ở bước 2, nên nếu bước 2
đã tính trường này vào `complete` thì bước 7 **không còn RED**. Xử lý theo một
trong hai cách, chốt trước khi code:

- (a) Ở bước 2, cố ý tính `complete` **không** xét `trackedDiffError` (để bước 7
  có RED thật), hoặc
- (b) Chấp nhận bước 7 là non-regression: chạy trước fix, ghi lại kết quả, và nếu
  đã GREEN thì ghi vào `validation.md` §Known gaps là "AC6 chứng minh ở mức hàm,
  không có RED riêng".

**Sửa (extend):** `test/unit/worktree/worktree-snapshot-completeness.test.ts` —
assert `trackedDiffError` set ⇒ `complete === false` ⇒ predicate false (không
`force`). Ở mức integration: bơm lỗi bằng cách làm `git diff` fail (ví dụ trỏ
`worktreePath` tới thư mục không phải repo git sau khi `git status` đã chạy) —
nếu seam này quá giòn, giữ ở mức hàm và ghi rõ trong `validation.md` §Known gaps.

```bash
node scripts/test-runner.mjs test/unit/worktree/worktree-snapshot-completeness.test.ts
```

**Rollback:** revert riêng thay đổi này.

## Bước 8 — Đường `force` và quan sát được (AC7)

**Sửa (extend):** `test/integration/worktree-snapshot-preserve-dirty.test.ts` —
Case D: cùng fixture Case A nhưng gọi với `{ force: true }`; assert worktree
**được** dọn (file biến mất) và log/message nêu lý do (truncation). Case E:
`force` không set ⇒ khẳng định lại Case A.

```bash
node scripts/test-runner.mjs test/integration/worktree-snapshot-preserve-dirty.test.ts
```

**Rollback:** revert Case D/E + nhánh `force`.

## Bước 9 — Harness delta

| File | Thay đổi |
|---|---|
| `docs/decisions/2026-09-XX-worktree-snapshot-completeness.md` | Tạo từ stub ở `design.md` §8 |
| `docs/decisions/README.md` | Thêm hàng index |
| `docs/TEST_MATRIX.md` | Thêm hàng RR-010 (`planned` → `implemented` khi có bằng chứng) |
| `docs/stories/README.md` | Thêm RR-010 vào Active |
| `docs/product/worktree.md` | Cập nhật hợp đồng snapshot/cleanup + `force`. **Lưu ý:** file này được `docs/product/README.md` liệt kê nhưng **không tồn tại** trong repo hôm nay — tạo mới hoặc ghi vào `docs/product/runtime-safety.md` §State Integrity (chốt lúc implement) |
| `CHANGELOG.md` | Ghi thay đổi hành vi (worktree dirty chứa file > cap không còn tự dọn) |

```bash
npm run check:decision-drift    # ADR mới không được chứa token env đã trôi
npm run check:conflict-markers
```

**Lưu ý `check:decision-drift`:** script quét `PI_CREW_*`/`PI_TEAMS_*` trong
`docs/decisions/*.md` và bắt buộc token phải xuất hiện trong `src/`. Decision
record của RR-010 **không nên** nhắc env var nào (không có env var mới) — nếu có,
phải đảm bảo token tồn tại trong `src/`.

## Bước 10 — Bundle + đóng story

`dist/index.mjs` là bundle mặc định (từ v0.9.17) — sửa `src/` **không** có hiệu
lực trong session thật cho tới khi rebuild (plan §4, `.crew/knowledge.md`).

```bash
npm run build:bundle && npm run test:bundle
npm run check:bundle-staleness
```

Sau đó chạy thang kiểm chứng đầy đủ trong `validation.md`.

## Thứ tự rollback

| Điểm | Phạm vi | Cách lùi |
|---|---|---|
| R0 | toàn bộ story | `git checkout -- .` về `rev-parse HEAD` ghi ở bước 0 |
| R1 | chỉ bước 6 (allocation bound) | revert riêng thay đổi `readFileSync` → đọc có trần; giữ predicate + cổng |
| R2 | chỉ bước 8 (`force`) | revert options `force`; giữ contract `complete` (story vẫn đúng nhưng không có lối thoát) |
| R3 | bước 5 (test cũ) | revert test cũ; **không** revert `src/` (hai test sẽ đỏ — chấp nhận tạm) |

Mỗi bước là một commit riêng để lùi được độc lập; commit message theo
conventional commits (`fix:` cho `src/`, `test:` cho test, `docs:` cho harness).

## Ghi chú triển khai

- **Không chạm** `cleanupAgentWorktree` / `cleanupCreatedWorktree` — ngoài scope
  (`overview.md` §6).
- **Không đổi định dạng artifact** — nếu thấy cần, dừng và hỏi leader.
- **`prepareTaskWorkspace` (sync) dùng cache** `syncCleanLeaderCache`; khi viết
  test reuse nhớ hành vi invalidate cache (đã có trong hàm) để tránh flaky.
- Trước khi sửa, liệt kê call-site thật:

```bash
rg -n "snapshotDirtyWorktree|prepareTaskWorkspace" src test --glob '*.ts'
```

- File `worktree-manager.ts` hiện rất lớn; gate `check:wc-gate` chỉ áp cho
  `src/runtime/` nên không chặn, nhưng nếu phần thêm vào vượt ~60 dòng, cân nhắc
  tách helper thuần (predicate + kiểu) sang module riêng trong `src/worktree/`.
