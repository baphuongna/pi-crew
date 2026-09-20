# RR-010 — Validation: hợp đồng snapshot/cleanup worktree (F01)

- **Lane:** high-risk
- **Status:** planned — bảng dưới đây là **kế hoạch kiểm chứng**, chưa có kết quả
- **Nguyên tắc:** không tuyên bố "xanh" khi chưa chạy đúng lệnh (plan §3.1;
  `docs/HARNESS.md` → Validation Ladder).

## 1. Thang kiểm chứng (validation ladder)

Nguồn lệnh: `package.json` scripts + plan §4.

| Level | Command | Khi nào | Kỳ vọng |
|---|---|---|---|
| quick | `npm run typecheck` | mỗi lần sửa `src/` | exit 0; in `strip-types import ok` |
| targeted | `node scripts/test-runner.mjs test/unit/worktree/worktree-snapshot-completeness.test.ts` | vòng lặp RED→GREEN | RED ở bước 1a (kết quả là `boolean`, không có `complete`); GREEN sau bước 2 |
| targeted | `node scripts/test-runner.mjs test/integration/worktree-snapshot-preserve-dirty.test.ts` | bước 3/4/8 | RED ở bước 3 (file gốc bị xoá); GREEN sau bước 4 |
| targeted | `node scripts/test-runner.mjs test/integration/worktree-snapshot-dirs-binary.test.ts test/unit/worktree/worktree-async.test.ts` | sau bước 5 | pass; **không** có fail mới |
| critical | `npm run test:critical` | trước commit (14 file broker/handshake/config) | pass — không file nào trong danh sách chạm worktree, nên đây là **smoke** chống hồi quy lan rộng. **Lưu ý:** `crew-broker-symlink-steering.test.ts` trong danh sách này đang đỏ sẵn (plan §4) ⇒ `test:critical` sẽ không xanh vì lý do ngoài RR-010 |
| unit | `npm run test:unit` | trước khi đóng story | xem §3 "known gaps" — 2 test đang đỏ từ trước (không thuộc RR-010) |
| lint | `npm run lint && npm run format:check` | sau mọi sửa `src/` + test | exit 0 (biome) |
| gates | `npm run check:decision-drift` | sau khi tạo decision record | exit 0 — ADR mới không chứa env token đã trôi |
| gates | `npm run check:env-vars` | chỉ khi có thêm env var | **không áp dụng** nếu story không thêm env var (dự kiến không thêm). **Lưu ý:** gate này đang **đỏ sẵn** trên `main` (plan §8: `knowledge-injection.ts:466` `PI_CREW_KIND`, `stale-reconciler.ts:287` `PI_CREW_DEBUG_STALE`) — nếu chạy, đối chiếu với baseline thay vì coi là hồi quy do RR-010 |
| gates | `npm run check:event-types` | chỉ khi thêm event type | **không áp dụng** (dự kiến chỉ đổi message của `logInternalError`). **Lưu ý:** gate này ở **report mode** (exit 0) — không chặn; nó báo 89 registered vs 123 emitted (plan §8) |
| gates | `npm run check:lazy-imports` | khi có import động mới | **không áp dụng** (không thêm import động) |
| gates | `npm run check:wc-gate` | khi sửa `src/runtime/` | **không áp dụng** — `worktree-manager.ts` nằm ngoài `src/runtime/`, gate chỉ quét `src/runtime/` (giới hạn 2000 dòng) |
| gates | `npm run check:conflict-markers` | sau khi sửa docs | exit 0 |
| integration | `npm run test:integration` | bắt buộc cho RR-010 (plan §4 liệt F01) | pass; file mới `worktree-snapshot-preserve-dirty.test.ts` nằm trong `test/integration/*.test.ts` nên được nhặt tự động |
| bundle | `npm run build:bundle && npm run test:bundle` | sau khi sửa `src/` | exit 0; bundle mới chứa thay đổi |
| bundle | `npm run check:bundle-staleness` | trước khi kết luận | exit 0 (local mode) |
| full | `npm run ci` | trước publish | toàn chuỗi xanh — **chặn bởi 2 test đỏ có sẵn** (§3) |

**Ghi chú về bundle:** `dist/index.mjs` là bundle mặc định từ v0.9.17. Sửa `src/`
không có hiệu lực trong session Pi thật cho tới khi `npm run build:bundle` và
extension cold-start (plan §4; `.crew/knowledge.md`). Muốn kiểm chứng hành vi
thật ngay từ source: `PI_CREW_USE_BUNDLE=0` (đọc một lần lúc extension load).

## 2. Acceptance criteria → proof

| AC | Nội dung | Bằng chứng | Level |
|---|---|---|---|
| AC1 | Backup không đầy đủ ⇒ bytes gốc còn nguyên | `test/integration/worktree-snapshot-preserve-dirty.test.ts` Case A: assert file tồn tại + `Buffer.compare` khớp từng byte | targeted + integration |
| AC2 | Kết quả snapshot có cấu trúc (không còn `boolean` đơn) | `test/unit/worktree/worktree-snapshot-completeness.test.ts`: assert `complete`/`truncated`/`skipped`/`trackedDiffError` | targeted |
| AC3 | Entry không đọc được không dẫn tới xoá | Case B (`chmod 000`): file còn nguyên **và** artifact nhắc tên file | targeted + integration |
| AC4 | Truncation một file ⇒ không cho phép dọn | `shouldDiscardDirtyWorktree({complete:false,...}, false) === false` (test thuần) + Case A | targeted |
| AC5 | `readFileSync` không đọc quá cap | test AC5 trong file unit: (a) ngưỡng `rssDelta < 64 MiB` với fixture sparse lớn trên Linux/macOS, hoặc (b) số byte đọc tối đa qua seam helper đọc file (ưu tiên — tất định); kèm `complete === false` + `truncated[0].originalSize` đúng | targeted |
| AC6 | Lỗi diff tracked cũng là "không đầy đủ" | test thuần với `trackedDiffError` set ⇒ `complete === false` ⇒ predicate false. **Không có RED riêng** nếu `complete` đã xét `trackedDiffError` từ bước 2 — ghi rõ trong §3 | targeted |
| AC7 | `force` tường minh, quan sát được | Case D (`{force:true}` ⇒ worktree được dọn + log có lý do) và Case E (`force` không set ⇒ giữ nguyên) | targeted + integration |
| AC8 | Cả sync và async | Case A (async) + Case C (sync) trong cùng file integration | integration |
| AC9 | Không hồi quy hành vi hợp lệ | `test/integration/worktree-snapshot-dirs-binary.test.ts` (ST-1b non-ASCII, ST-1 dirs/binary/base64) + `test/unit/worktree/worktree-async.test.ts` pass | targeted + integration |
| AC10 | Artifact không phải bằng chứng đủ | Case A: artifact tồn tại **và** file gốc còn nguyên (assert cả hai trong cùng test) | integration |

Mọi AC đều assert được bằng `assert` trong `node:test`; không AC nào cần quan sát
thủ công.

## 3. Known gaps và rủi ro kiểm chứng

1. **Hai unit test đang đỏ từ trước** (plan §4, review §6.2) — **không** thuộc
   RR-010, nhưng nghĩa là `npm test` / `npm run ci` sẽ **không** xanh:
   - `test/unit/interrupt-guard-ack.test.ts` — "RT-4: REAL interrupt guard writes
     acknowledged:true + body fires exactly once": full suite expected 1, actual 0;
     chạy riêng 2/2 pass (flaky, chưa rõ root cause).
   - `test/unit/runtime/broker/crew-broker-symlink-steering.test.ts` — "steer.push
     does not follow a symlinked steering directory outside artifactsRoot": trả
     `request-timeout` thay vì `ok: true` (cả full suite lẫn chạy riêng).

   ⇒ RR-010 chỉ được coi là xanh khi **không có fail nào khác** hai test này; phải
   ghi rõ trong `evidence` danh sách fail và đối chiếu với baseline.

2. **`chmod 000` không chạy được trên Windows.** Case B self-skip trên `win32`;
   nghĩa là AC3 chỉ được chứng minh trên ubuntu/macos trong CI. Cần nêu trong
   evidence để không ngộ nhận "3/3 OS đã kiểm AC3".

3. **`chmod 000` không có hiệu lực khi chạy với quyền root** (một số container CI).
   Nếu CI chạy root, `readFileSync` vẫn đọc được và Case B sẽ không tái hiện đúng
   nhánh `catch`. Phòng ngừa: trong test, kiểm tra điều kiện tiên quyết
   (`fs.readFileSync(secretPath)` phải ném) và `t.skip` nếu không — kèm lý do.

4. **AC5 đo RSS có thể flaky.** GC và allocator của V8 làm RSS không giảm ngay.
   Ưu tiên assert cấu trúc (số byte đọc tối đa, `truncated` được set) hơn là assert
   RSS; nếu vẫn đo RSS thì dùng ngưỡng rộng và chỉ trên Linux/macOS.

5. **AC6 ở mức integration giòn.** Bơm lỗi `git diff` đòi hỏi can thiệp fixture
   (worktree không còn là repo git sau khi `git status` chạy). Nếu không tạo được
   seam sạch, giữ AC6 ở mức hàm thuần và ghi vào mục này — **không** được đánh dấu
   AC6 là "integration-proven".

6. **Không kiểm chứng được hành vi thật trong session Pi** trong phạm vi story này
   (cần `npm run build:bundle` + cold-start session mới). `test:bundle` chỉ chứng
   minh bundle load được, **không** chứng minh luồng reuse worktree chạy thật trong
   session (`.crew/knowledge.md` → "Real Testing vs Unit Testing").

7. **Chạy test từ trong một pi-crew worker** có thể làm sai các assertion dạng
   "biến phải không tồn tại" do harness export `PI_CREW_*`. RR-010 không có
   absence-assertion như vậy, nhưng nếu chạy `npm run test:unit` từ trong worker,
   scrub `PI_CREW_*` trước khi kết luận, và chạy từng file thay vì cả thư mục.

8. **Chưa chạy multi-platform tại thời điểm viết packet.** Bảng CI 3/3 chỉ được
   điền sau khi có kết quả GitHub Actions thật.

## 4. Evidence (điền lúc implement)

```text
HEAD khi bắt đầu (R0):
Node:
OS:

--- RED (bước 1) ---
command:
result:
lý do fail (phải là mất dữ liệu / symbol thiếu, KHÔNG phải lỗi biên dịch):
ghi chú: bước 1a (RED hành vi) chạy riêng hay gộp?

--- RED (bước 3) ---
command:
result:
quan sát: big-untracked.bin còn tồn tại? <yes/no>
quan sát: artifact có nhắc secret.txt? <yes/no>

--- GREEN targeted ---
command:
result (pass/fail counts):

--- quick / lint / gates ---
npm run typecheck:
npm run lint && npm run format:check:
npm run check:decision-drift:
npm run check:conflict-markers:
(ghi rõ nếu bỏ qua gate nào và vì sao)

--- critical ---
npm run test:critical:
fail list (đối chiếu baseline — kỳ vọng có crew-broker-symlink-steering.test.ts):

--- integration ---
npm run test:integration:
fail list (đối chiếu baseline):

--- unit ---
npm run test:unit:
fail list (đối chiếu baseline — kỳ vọng chỉ 2 test đã biết):

--- bundle ---
npm run build:bundle:
npm run test:bundle:
npm run check:bundle-staleness:

--- full ---
npm run ci:
kết quả (hoặc lý do chưa chạy):

--- CI ---
CI (ubuntu):
CI (windows):
CI (macos):
link run:

--- AC đã chứng minh ---
AC1..AC10: <proven | partial (lý do) | không chứng minh được (lý do)>
AC5: cách đo đã chọn (helper/byte-count hay RSS)?
AC6: có RED riêng hay chấp nhận non-regression?
```

## 5. Điều kiện đóng story

- Mọi AC trong `overview.md` §5 có bằng chứng, hoặc được ghi rõ là partial kèm lý do.
- Không có fail mới ngoài 2 test đã biết ở §3.1.
- Decision record tồn tại trong `docs/decisions/` và đã thêm vào `docs/decisions/README.md`.
- `docs/TEST_MATRIX.md` có hàng RR-010 với bằng chứng.
- Hợp đồng mới + `force` được ghi vào product doc (tạo `docs/product/worktree.md`
  hoặc bổ sung `docs/product/runtime-safety.md` — file `worktree.md` hiện không tồn tại).
- Bundle đã rebuild và `check:bundle-staleness` xanh.
- Phê duyệt của người đã có **trước** khi implement (plan §6).
