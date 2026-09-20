# RR-011 — Quyền sở hữu run lock theo async context (F02)

- **Lane:** high-risk — hard gate: state mutation + concurrency
- **Status:** planned — **chưa triển khai**, cần phê duyệt của người (plan §6)
- **Finding:** F02 (review 2026-09-17, mức Cao) — **VERIFIED**
- **Nguồn:**
  - `docs/superpowers/plans/2026-09-17-review-remediation.md` §2.3, §2.4, §5 (RR-011)
  - `docs/archive/2026-09-17-pi-crew-review.md` §3 F02
  - `docs/archive/2026-09-17-pi-crew-review-verification.md` §3 C2, §4 F02, §7
  - `docs/FEATURE_INTAKE.md` (Risk Checklist; Classification)
- **Ngày tạo:** 2026-09-17
- **Baseline:** `pi-crew@0.11.1`, commit `0b9fa771`
- **Số dòng:** lấy nguyên từ review + báo cáo xác minh tại commit `0b9fa771`
  (`src/state/coordination/locks.ts:154-157,268-272,341-343,378-384,390`). Khi source
  trôi, dùng tên hàm thay vì số dòng.

## 1. Vấn đề (WHY)

`withRunLock` là cơ chế bảo vệ read-modify-write trên `manifest.json` và
`tasks.json` của một run. Hợp đồng của nó là: **tối đa một holder** trong
critical section.

Hợp đồng đó bị vi phạm khi hai **async context độc lập** trong cùng process cùng
tranh lock của một run. Cả hai cùng vào critical section (`maxActive = 2`), nên
read-modify-write chồng lấn và **mất cập nhật**.

Đây không phải primitive không có caller: đường post-execution dùng
`withRunLock` bao quanh một `await` — `src/runtime/task-runner/post-execution.ts:626-629`.
Nghĩa là lỗi nằm trên đường chạy production, không phải trong thư viện chờ dùng.

## 2. Bằng chứng xác minh (đã có, không cần dựng lại)

Nguồn: `docs/archive/2026-09-17-pi-crew-review-verification.md` §4 F02.

Probe 1 — hai chuỗi `withRunLock` top-level độc lập:

```text
ENTER A (active=1) lockExists=true
ENTER B (active=2) lockExists=true      <-- chồng lấn
MAX CONCURRENT HOLDERS = 2
MUTUAL EXCLUSION VIOLATED
```

Probe 2 — chứng minh cả steal lẫn lỗi release-theo-PID:

```text
token đổi f0b30705 → 2fa28d60 khi A còn giữ lock
sau khi A thoát trước: lock file ENOENT trong khi B vẫn trong critical section
```

## 3. Hiệu chỉnh phạm vi (BẮT BUỘC đọc trước khi sửa)

Review gốc mô tả rộng hơn thực tế. Xác minh §3 C2 chốt lại:

> Mutual exclusion **đúng** cho sync↔sync và sync↔async; **chỉ vỡ** cho
> async↔async (`withRunLock` vs `withRunLock`).

Hệ quả trực tiếp cho test:

- Test hiện có `test/unit/round30-h1-run-lock-async-context.test.ts:89,163` chỉ
  phủ **sync-vs-async** — đúng nhưng không phủ tổ hợp lỗi.
- `test/unit/state/coordination/locks-async-async-mutual-exclusion.test.ts` có
  test async↔async thật, nhưng cho **`withFileLockAsync`** (họ file lock), **không**
  phải `withRunLock`.
- ⇒ Tổ hợp duy nhất bị lỗi (run lock async↔async) hiện **không có test nào**.

**Chiều chưa được xác minh:** bằng chứng của C2 chỉ phủ chiều **async giữ + sync
 gọi**. Chiều ngược lại (**sync giữ + async gọi**) không nằm trong test hiện có, và
 đi qua đúng nhánh own-PID steal — xem `design.md` §3. Exec plan bước 4 yêu cầu đo
 trước khi sửa; **không** kết luận chiều này đúng khi chưa có số đo.

Story này **không** được mở rộng sang việc "sửa mutual exclusion nói chung"; phạm
vi là nhánh async của run lock.

## 4. Risk flags (`docs/FEATURE_INTAKE.md` → Risk Checklist)

| Risk flag | Áp dụng | Vì sao |
|---|:-:|---|
| State mutation | ● | lock bảo vệ ghi `manifest.json` + `tasks.json` |
| Concurrency | ● | chính là defect: hai holder cùng process |
| Child process | | không spawn trong path này |
| Error handling | ● | nhánh release trong `finally`; fail-closed khi không xác định được holder |
| External tools | | không có git/shell |
| API contract | | không đổi tool API của `team` |
| Platform | | Windows có nhánh contention EPERM/EBUSY trong retry loop — phải giữ |
| Backward compat | ● | `releaseOwnLock` đổi từ so-PID sang so-token; payload lock file **không** đổi (trường `token` đã tồn tại) |
| Dependencies | | không thêm gói |
| Security | | phải giữ guard symlink + mode `0o600`; nhánh steal là ranh giới tin cậy |

**Kết luận phân loại:** 3 cờ + hard gate "State mutation + concurrency" →
**high-risk** (khớp plan §2.3).

## 5. Affected modules

| Module | File | Vai trò |
|---|---|---|
| State | `src/state/coordination/locks.ts` | `readLockSnapshot`, `acquireLockWithRetryAsync`, `releaseOwnLock`, `withRunLock`, `withRunLockSync` |
| Runtime | `src/runtime/task-runner/post-execution.ts` | caller thật (`:626-629`); sửa comment cũ ở `:619` |
| Tests | `test/unit/state/coordination/`, `test/unit/round30-h1-run-lock-async-context.test.ts` | test mới async↔async + non-regression |
| Docs | `docs/TEST_MATRIX.md`, `docs/decisions/` | harness delta |

## 6. Acceptance criteria

Mỗi AC phải khẳng định được bằng một test cụ thể.

1. **AC1 — Mutual exclusion async↔async.** Hai async context độc lập gọi
   `withRunLock` trên cùng run, A giữ lock và đang `await` (gate bằng deferred),
   B tranh lock trong lúc đó: `maxActive === 1`; B chỉ vào critical section **sau
   khi** A thoát. Thứ tự enter/exit không xen kẽ.
2. **AC2 — Không mất cập nhật.** Cùng bố cục AC1, mỗi context thực hiện
   read-modify-write một bộ đếm (đọc giá trị từ file, `+1`, ghi lại): giá trị cuối
   cùng bằng tổng số lần ghi của cả hai context (không mất bản ghi nào).
3. **AC3 — Re-entrance trong cùng async context không hồi quy.** Gọi lồng
   `withRunLock` (và `withRunLockSync`) bên trong `withRunLock` ở **cùng** context
   vẫn bypass, không deadlock, không ném lỗi; lock không bị nhả sớm cho tới khi
   hàm ngoài cùng kết thúc.
4. **AC4 — sync↔async không hồi quy.** `test/unit/round30-h1-run-lock-async-context.test.ts`
   pass **nguyên trạng** (không sửa assertion).
5. **AC5 — Release không xoá lock của holder khác.** Trong khi B đang ở trong
   critical section, lock file **phải tồn tại** (assert `fs.existsSync(lockFile)
   === true` tại cuối thân hàm của B) — tức không còn trạng thái `ENOENT` khi còn
   holder sống.
6. **AC6 — Release-on-error.** Khi `fn()` ném, lock được nhả (hoặc trạng thái sở
   hữu được cập nhật đúng) và một lần acquire kế tiếp thành công trong deadline;
   lỗi gốc vẫn propagate tới caller.
7. **AC7 — Steal vẫn hoạt động cho holder chết/stale.** Lock file do process khác
   để lại với `pid` đã chết hoặc `createdAt` cũ vẫn stealable bởi async context
   (test dựng lock file giả, theo tiền lệ `test/unit/state/coordination/locks-race.test.ts`).
   Không được biến lock cũ thành chặn vĩnh viễn.
8. **AC8 — Không hồi quy cross-process.** Một process thứ hai (child process thật)
   không vào được critical section khi process thứ nhất đang giữ; nó nhận đúng
   lỗi `locked` (hành vi hiện tại được giữ). **Không hạ `staleMs`** trong test này:
   lock stale được phép steal, nên `staleMs` nhỏ sẽ khiến test vô nghĩa.
9. **AC9 — Kịch bản CI flake mà cờ `treatOwnPidAsStealable` sinh ra không tái
   phát.** N lần acquire **tuần tự** trong cùng process (hình dạng
   parallel-research scaffold mode) đều thành công, không có lỗi `locked` giả.
   Đây là bất biến chống hồi quy cho lý do tồn tại của cờ.
10. **AC10 — Danh tính holder quan sát được và không rò trạng thái holder.** Payload
    lock file chứa danh tính holder phân biệt được giữa hai acquisition (token khác
    nhau), và release chỉ gỡ lock khớp danh tính đó — assert bằng cách đọc lock file
    từ trong critical section của từng context và so sánh. Kèm theo: sau khi mọi
    acquisition kết thúc (thành công **và** sau khi `fn()` ném), không token nào
    còn bị coi là "đang giữ sống" — assert trực tiếp nếu tập quan sát được từ test,
    hoặc gián tiếp bằng cách tạo lock file giả `pid` của chính process + `createdAt`
    cũ và khẳng định vẫn steal được (xem `validation.md` §3.10).

## 7. Out of scope

- **F15 / RR-014** (semaphore có thể abort) — story riêng, phụ thuộc RR-011 nhưng
  không gộp (plan §2.4).
- Họ **file lock** (`withFileLockSync` / `withFileLockAsync`) — đã có fix ST-3-FIX
  và ST-14; RR-011 chỉ giữ chúng như non-regression, không sửa.
- Agents-record lock (`crew-agent-records.ts`) và họ event-log
  (`.mkdirlock`/`.alock`/`.seqlock`) — quyết định α của
  `docs/decisions/2026-08-15-lock-family-unification.md` giữ chúng tách riêng.
- Thiết kế lại giao thức lock liên process (giữ `O_EXCL` + stale deadline).
- Tăng `maxConcurrentWorkers` (plan §7 cấm trước khi F02/F06 xong).
- Thay `sleepSync` bằng `await` ở các lock site khác (plan §7 — cần xét từng call graph).

## 8. Dependencies

- **Không phụ thuộc story nào.** RR-014 phụ thuộc RR-011 ("cùng miền lock/slot",
  plan §2.4).
- Thứ tự triển khai khuyến nghị (plan §6): RR-013 → RR-015 → RR-010 → **RR-011** →
  RR-012 → …
- Phụ thuộc môi trường: AC8 cần spawn child process thật (đã có tiền lệ trong
  `test/unit/state/coordination/locks-race.test.ts` và
  `state-helpers-cas-contention.test.ts`).

## 9. Cổng phê duyệt và harness delta

`docs/FEATURE_INTAKE.md` → High-Risk: "Ask human confirmation before implementation".
Story này **chưa được triển khai**; rủi ro chính là mất cập nhật do hai holder cùng
process (plan §6).

Harness delta dự kiến:

| Artifact | Thay đổi |
|---|---|
| `docs/decisions/` | Decision record mới (stub ở `design.md` §9) |
| `docs/decisions/README.md` | Thêm hàng index |
| `docs/TEST_MATRIX.md` | Thêm hàng RR-011 |
| `docs/stories/README.md` | Thêm RR-011 vào Active |
| `docs/product/state.md` | Cập nhật mô tả run lock (nếu có mô tả quyền sở hữu). **Lưu ý:** `docs/product/README.md` liệt kê `state.md` nhưng file **không tồn tại** hôm nay; chọn tạo mới hoặc bổ sung `docs/product/runtime-safety.md` §State Integrity (`withRunLockSync` đã được nhắc ở đó) |
| `src/runtime/task-runner/post-execution.ts:619` | Sửa comment cũ tham chiếu `runLockHeldByUs` (biến không còn tồn tại) |

## 10. Tham chiếu

- Design chi tiết: `docs/stories/RR-011/design.md`
- Exec plan: `docs/stories/RR-011/exec-plan.md`
- Validation: `docs/stories/RR-011/validation.md`
- ADR liên quan: `docs/decisions/2026-08-15-lock-family-unification.md` (họ lock, quyết định α)
- Tiền lệ fix cùng lớp lỗi trong chính file: ST-3-FIX (`withFileLockAsync`), ST-14, H-1
