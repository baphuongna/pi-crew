# RR-011 — Validation: quyền sở hữu run lock theo async context (F02)

- **Lane:** high-risk
- **Status:** planned — bảng dưới đây là **kế hoạch kiểm chứng**, chưa có kết quả
- **Nguyên tắc:** không tuyên bố "xanh" khi chưa chạy đúng lệnh (`docs/HARNESS.md`).

## 1. Thang kiểm chứng (validation ladder)

Nguồn lệnh: `package.json` scripts + plan §4.

| Level | Command | Khi nào | Kỳ vọng |
|---|---|---|---|
| quick | `npm run typecheck` | mỗi lần sửa `src/state/coordination/locks.ts` | exit 0; in `strip-types import ok` |
| targeted | `node scripts/test-runner.mjs test/unit/state/coordination/run-lock-async-async-mutual-exclusion.test.ts` | vòng lặp RED→GREEN | RED ở bước 1/2 (`maxConcurrent === 2`, mất cập nhật, lock `ENOENT`); GREEN sau bước 3 |
| targeted | `node scripts/test-runner.mjs test/unit/round30-h1-run-lock-async-context.test.ts` | sau bước 3 | pass **nguyên trạng** (AC4 — không sửa assertion) |
| targeted | `node scripts/test-runner.mjs test/unit/state/coordination/locks-race.test.ts test/unit/state/coordination/locks-untested.test.ts` | sau bước 3 | pass (token trong payload, stale-steal, kind=run, release semantics) |
| targeted | `node scripts/test-runner.mjs test/unit/state/coordination/api-locks.test.ts test/unit/state/coordination/lock-suffix-collision.test.ts` | sau khi đổi kiểu `lockCtx` | pass |
| targeted | `node scripts/test-runner.mjs test/unit/state/coordination/locks-reentrance-async-context.test.ts test/unit/state/coordination/locks-async-async-mutual-exclusion.test.ts` | sau khi đổi `lockCtx` | pass — hai file này là bất biến của **file lock** (ST-14, ST-3-FIX), không được hồi quy |
| targeted | `node scripts/test-runner.mjs test/unit/state/coordination/run-lock-release-error.test.ts` | bước 6/7 | AC6/AC8 là **non-regression** (kỳ vọng GREEN cả trước và sau fix — ghi lại kết quả trước fix để phát hiện hồi quy do thay đổi release); AC9 (N acquire tuần tự) là **canary**: nếu đỏ sau fix thì lý do tồn tại của cờ `treatOwnPidAsStealable` chưa được xử lý — dừng và báo leader |
| targeted | `node scripts/test-runner.mjs test/unit/runtime/task-runner/post-execution-surface-lost.test.ts` | sau bước 9 (comment) | pass — chứng minh sửa comment không chạm hành vi |
| critical | `npm run test:critical` | trước commit (14 file) | pass — **lưu ý:** file `crew-broker-symlink-steering.test.ts` trong danh sách này đang **đỏ sẵn** (xem §3.1), nên `test:critical` sẽ không xanh vì lý do ngoài RR-011 |
| unit | `npm run test:unit` | trước khi đóng story | xem §3 — 2 test đỏ có sẵn |
| lint | `npm run lint && npm run format:check` | sau mọi sửa `src/` + test | exit 0 (biome) |
| gates | `npm run check:decision-drift` | sau khi tạo decision record | exit 0 |
| gates | `npm run check:conflict-markers` | sau khi sửa docs | exit 0 |
| gates | `npm run check:lazy-imports` | nếu có import động mới | **không áp dụng** (dự kiến không có) |
| gates | `npm run check:env-vars` | nếu thêm env var | **không áp dụng** (dự kiến không thêm) |
| gates | `npm run check:event-types` | nếu thêm event type | **không áp dụng** (dự kiến không thêm) |
| gates | `npm run check:wc-gate` | khi sửa `src/runtime/` | áp dụng **chỉ** cho bước 9 (`post-execution.ts` nằm trong `src/runtime/task-runner/`) — sửa comment không đổi số dòng đáng kể, nhưng vẫn phải chạy vì gate quét cả cây `src/runtime/` |
| integration | `npm run test:integration` | bắt buộc cho RR-011 (plan §4 liệt F02) | pass; xác nhận luồng task-runner/post-execution thật không hồi quy |
| integration | `node scripts/test-runner.mjs test/integration/mailbox-sync-async-concurrent.test.ts` | sau khi đổi `lockCtx` | pass — bài kiểm chứng sync↔async ở mức integration |
| bundle | `npm run build:bundle && npm run test:bundle` | sau khi sửa `src/` | exit 0 |
| bundle | `npm run check:bundle-staleness` | trước khi kết luận | exit 0 (local mode) |
| full | `npm run ci` | trước publish | toàn chuỗi xanh — **chặn bởi 2 test đỏ có sẵn** (§3.1) |

**Ghi chú bundle:** `dist/index.mjs` là bundle mặc định từ v0.9.17; sửa `src/`
không có hiệu lực trong session Pi thật cho tới khi rebuild + cold-start
(plan §4; `.crew/knowledge.md`). Muốn kiểm chứng hành vi thật ngay từ source:
`PI_CREW_USE_BUNDLE=0` (đọc một lần lúc extension load, không đổi được giữa session).

## 2. Acceptance criteria → proof

| AC | Nội dung | Bằng chứng | Level |
|---|---|---|---|
| AC1 | Mutual exclusion async↔async (`maxActive === 1`) | `run-lock-async-async-mutual-exclusion.test.ts`: `assert.equal(maxConcurrent, 1)` với gate `createDeferred` trên caller 1 | targeted |
| AC2 | Không mất cập nhật | cùng file: bộ đếm read-modify-write trên file trong `stateRoot`, giá trị cuối = tổng số ghi | targeted |
| AC3 | Re-entrance cùng context không hồi quy | cùng file: `withRunLock` lồng `withRunLock` và lồng `withRunLockSync` bypass, không deadlock | targeted |
| AC4 | sync↔async không hồi quy | `test/unit/round30-h1-run-lock-async-context.test.ts` pass **không sửa** (3 test: nested bypass, cross-context không bypass, concurrent sync+async). **Lưu ý:** ba test này chỉ phủ chiều **async giữ + sync gọi**; chiều ngược lại chưa có bằng chứng — xem §3.5 | targeted |
| AC5 | Release không xoá lock của holder khác | cùng file: `fs.existsSync(run.lock) === true` trong CS của B, và vẫn `true` sau khi A thoát | targeted |
| AC6 | Release-on-error | `run-lock-release-error.test.ts`: `fn()` ném ⇒ lỗi propagate; acquire kế tiếp thành công trong deadline | targeted |
| AC7 | Steal cho holder chết/stale vẫn hoạt động | cùng file: lock giả `pid=99999` (chết) và lock `createdAt` cũ (stale) đều acquire được; lock fresh + pid mình + không token ⇒ ném `locked` | targeted |
| AC8 | Cross-process không hồi quy | cùng file: child process thật giữ lock ⇒ cha nhận `locked`; sau khi child thoát ⇒ acquire thành công | targeted (+ integration qua `test:integration`) |
| AC9 | CI flake gốc không tái phát | cùng file: N acquire **tuần tự** cùng manifest, tất cả thành công, không lần nào ném `locked` | targeted |
| AC10 | Danh tính holder quan sát được và không rò trạng thái holder | cùng file: token của A ≠ token của B (đọc lock file trong CS mỗi context); release của A không gỡ lock thuộc B. Kèm assert **không rò tập token** trong `run-lock-release-error.test.ts` (sau acquire thành công và sau `fn()` ném) — xem §3.10 | targeted |

Mọi AC assert được bằng `assert` trong `node:test`; không AC nào cần quan sát thủ công.

**Lưu ý về tính xác định của test (quan trọng cho AC1/AC2/AC5):** phải **gate**
caller 2 trên "caller 1 đã vào critical section" bằng deferred. Tiền lệ đã ghi rõ
trong `locks-async-async-mutual-exclusion.test.ts`:

> A naive `Promise.all([a, b])` without the gate may or may not catch the bug
> depending on microtask scheduling, so we make it explicit.

Không dùng `Promise.all` trần cho test RED — nếu không, RED có thể pass giả và
toàn bộ story mất giá trị.

## 3. Known gaps và rủi ro kiểm chứng

1. **Hai unit test đang đỏ từ trước** (plan §4, review §6.2) — **không** thuộc
   RR-011, nhưng nghĩa là `npm test` / `npm run ci` / `npm run test:critical` sẽ
   **không** xanh:
   - `test/unit/interrupt-guard-ack.test.ts` — "RT-4: REAL interrupt guard writes
     acknowledged:true + body fires exactly once": full suite expected 1, actual 0;
     chạy riêng 2/2 pass (flaky, chưa rõ root cause).
   - `test/unit/runtime/broker/crew-broker-symlink-steering.test.ts` — trả
     `request-timeout` thay vì `ok: true`; **file này nằm trong `npm run test:critical`**,
     nên gate critical không thể xanh trước khi RR-015 xử lý.

   ⇒ RR-011 chỉ được coi là xanh khi **không có fail nào khác** hai test này; ghi
   rõ danh sách fail và đối chiếu baseline trong `evidence`.

2. **Không có repro runtime đầy đủ cho F02.** Verification §7 ghi rõ: "F02: chưa
   dựng repro runtime đầy đủ (cần hai async context độc lập gọi `withRunLock` cùng
   run trong khi context đầu đang await)". Nghĩa là AC1–AC10 chứng minh ở mức
   primitive + caller, **không** chứng minh một chuỗi production thật (team-runner
   batch merge vs post-execution) chồng lấn. Nếu muốn chứng minh end-to-end, cần
   một integration test dựng đúng hai đường đó — **nằm ngoài phạm vi story này**
   trừ khi leader yêu cầu bổ sung.
   **Hệ quả:** `src/runtime/task-runner/post-execution.ts:626-629` chỉ được đọc để
   xác nhận **có caller thật**, không được dùng làm bằng chứng đã chạy end-to-end.

3. **Không chứng minh được hiệu ứng lên tải thật.** Đo "mất cập nhật" trong test là
   tất định (bộ đếm file), nhưng tần suất thực tế của async↔async trong production
   chưa được đo. Không được tuyên bố "đã loại bỏ mất cập nhật trong production" —
   chỉ được nói "đã đóng đường vào critical section".

4. **Windows: hành vi steal/token chưa được xác minh riêng.** `isLockContention`
   có nhánh `EPERM`/`EBUSY` đặc thù Windows; RR-011 không sửa hàm này nhưng đổi
   vòng lặp quanh nó. AC8/AC9 phải chạy trên windows-latest CI; nếu chỉ xanh trên
   Linux, ghi rõ trong `evidence`.

5. **Chiều sync-holder + async-caller của sync↔async chưa được xác minh.** Xác minh
   C2 kết luận "sync↔async đúng" dựa trên `round30-h1-run-lock-async-context.test.ts`
   (`:89,163`), và cả hai test đó đều có **async giữ lock + sync gọi**. Chiều ngược
   lại chưa có probe. `design.md` §3 suy luận từ cấu trúc mã rằng nó không thể
   chồng lấn (thân `withRunLockSync` chạy đồng bộ, không nhường event loop), nhưng
   **suy luận chưa được probe xác nhận**. Bước 4 của `exec-plan.md` yêu cầu test
   trước khi sửa. Không được ghi AC4 là "proven" cho chiều này khi chưa có bằng chứng.

6. **AC7 ca "payload không có `token`" là quyết định mới.** Payload cũ (do bản
   trước để lại) ghi `{pid, createdAt}` không có `token`. Design §8 chọn: token vắng
   ⇒ coi như không thuộc tập đang giữ ⇒ **vẫn steal** (giữ hành vi chống CI flake).
   Lựa chọn fail-closed ngược lại (không steal) cũng hợp lệ nhưng phải được duyệt
   rõ và ghi vào decision record — **không** đổi ngầm giữa hai lựa chọn.

7. **Chạy test từ trong một pi-crew worker:** harness export `PI_CREW_*`, và
   `.crew/knowledge.md` ghi nhận các assertion dạng "biến phải không tồn tại" có
   thể fail sai. RR-011 không có absence-assertion, nhưng nếu chạy
   `npm run test:unit` từ trong worker, scrub `PI_CREW_*` và chạy từng file thay vì
   cả thư mục (runner có thể crash khi chạy cả directory).

8. **Chưa chạy multi-platform tại thời điểm viết packet.** Bảng CI 3/3 chỉ được
   điền sau khi có kết quả GitHub Actions thật.

9. **`releaseOwnLock` chặt hơn có thể gây rò lock file** trong một luồng chưa được
   nghĩ tới. AC9 là lưới bắt chính, nhưng AC9 chỉ phủ acquire tuần tự cùng process.
   Nếu phát hiện lock file "mồ côi" trong `test:integration`, **dừng** và báo leader
   thay vì nới điều kiện.

10. **`runLockHeldTokens` là trạng thái process-global mới — rủi ro rò.** Nếu một
    acquisition không chạy `finally` (hoặc `finally` chạy nhưng `delete` đặt sai
    chỗ), token kẹt trong tập và lock tương ứng trở thành **không steal được** cho
    tới `staleMs`. Đây là hướng fail-closed (an toàn hơn chồng lấn) nhưng làm tăng
    khả năng gặp `locked`. Bước 8 của `exec-plan.md` có assert chống rò; nếu không
    quan sát được tập từ test (module-private), phải dùng proxy gián tiếp — tạo
    lock file giả `pid` của chính process + `createdAt` cũ, khẳng định vẫn steal
    được — và ghi rõ trong `evidence` là "chứng minh gián tiếp".

11. **Ngưỡng RED của bước 3 phụ thuộc hướng sửa đã chọn.** Nếu implement theo
    hướng khác (ví dụ bỏ hẳn cờ `treatOwnPidAsStealable` như `design.md` §4.3),
    AC9 vẫn phải chạy nhưng kỳ vọng thay đổi (cửa sổ release phải được sửa thay vì
    dựa vào steal). Ghi rõ hướng đã chọn vào `evidence` trước khi đối chiếu kết quả.

## 4. Evidence (điền lúc implement)

```text
HEAD khi bắt đầu (R0):
Node:
OS:
Quyết định §4.4 (ném ngay vs chờ tới deadline):

--- RED (bước 1) ---
command:
result:
maxConcurrent quan sát được: <phải là 2 khi RED>

--- RED (bước 2) ---
command:
result:
bộ đếm cuối cùng (AC2): <giá trị> / kỳ vọng <tổng số ghi>
lock file tồn tại trong CS của B (AC5): <true/false>

--- GREEN targeted ---
command:
result (pass/fail counts):

--- non-regression (AC4 + họ file lock) ---
round30-h1-run-lock-async-context.test.ts:
locks-race.test.ts / locks-untested.test.ts:
locks-reentrance-async-context.test.ts / locks-async-async-mutual-exclusion.test.ts:
api-locks.test.ts / lock-suffix-collision.test.ts:

--- release/steal/cross-process (AC6/AC7/AC8/AC9) ---
command:
result:
N acquire tuần tự (AC9): <số lần thành công>/<N>

--- quick / lint / gates ---
npm run typecheck:
npm run lint && npm run format:check:
npm run check:decision-drift:
npm run check:conflict-markers:
npm run check:wc-gate:

--- critical ---
npm run test:critical:
fail list (đối chiếu baseline — kỳ vọng có crew-broker-symlink-steering.test.ts):

--- integration ---
npm run test:integration:
node scripts/test-runner.mjs test/integration/mailbox-sync-async-concurrent.test.ts:
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

--- rủi ro còn lại ---
chiều sync-holder + async-caller (bước 4): <kết quả đo>
lock file mồ côi quan sát được? <yes/no + bằng chứng>
```

## 5. Điều kiện đóng story

- Mọi AC trong `overview.md` §6 có bằng chứng, hoặc được ghi rõ là partial kèm lý do.
- Không có fail mới ngoài 2 test đã biết ở §3.1.
- AC4 chứng minh bằng cách **không sửa** `round30-h1-run-lock-async-context.test.ts`.
- Decision record tồn tại trong `docs/decisions/` + đã thêm vào `docs/decisions/README.md`.
- `docs/TEST_MATRIX.md` có hàng RR-011 với bằng chứng.
- Quyền sở hữu run lock được ghi vào product doc (tạo `docs/product/state.md` hoặc
  bổ sung `docs/product/runtime-safety.md` §State Integrity — file `state.md` hiện
  không tồn tại).
- Comment lỗi thời ở `post-execution.ts:619` đã sửa.
- Bundle đã rebuild và `check:bundle-staleness` xanh.
- Phê duyệt của người đã có **trước** khi implement (plan §6).
- RR-014 (F15) **chưa** được bắt đầu trước khi RR-011 đóng (plan §2.4: RR-014 phụ
  thuộc RR-011).
