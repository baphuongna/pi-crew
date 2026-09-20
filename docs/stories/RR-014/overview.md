# RR-014 — F15: Semaphore waiter có thể abort

- **Lane:** high-risk
- **Status:** planned — **chờ phê duyệt của người** trước khi triển khai
  (`docs/FEATURE_INTAKE.md` → High-Risk: "Ask human confirmation before implementation")
- **Nguồn:** `docs/archive/2026-09-17-pi-crew-review.md` (F15);
  xác minh độc lập `docs/archive/2026-09-17-pi-crew-review-verification.md`
  (F15 — VERIFIED, kèm hiệu chỉnh **C5**);
  lộ trình `docs/superpowers/plans/2026-09-17-review-remediation.md` §5 (RR-014), §6
- **Đợt:** 2 (giảm chi phí điều phối) — nhưng đứng sau RR-011 theo §6 của plan
- **Ngày tạo:** 2026-09-17

## Vấn đề trong một câu

`Semaphore.acquire()` không nhận `AbortSignal`, nên một worker đang **chờ slot**
vẫn phải chờ hết thời gian người giữ slot chạy xong mới settle — dù task đã bị
cancel hoặc đã timeout.

## Nguồn gốc và mức độ

| Mục | Giá trị |
|---|---|
| Verdict xác minh | VERIFIED (phương pháp: probe `Semaphore` thật) |
| Mức trong review | Vừa |
| Hiệu chỉnh quan trọng | **C5** — thiệt hại là **delay**, KHÔNG phải process thừa |
| Lane theo plan §2.3 | high-risk (3 flags: Concurrency, Child process, Error handling) |

## Vì sao high-risk

Hard gate trong `docs/FEATURE_INTAKE.md` → Classification:

- **Concurrency** — sửa một primitive đồng bộ dùng chung cho mọi worker spawn
  (`global-worker-cap.ts` là cap tập trung của cả extension).
- **Child process** — primitive này nằm ngay trước `runChildPi`; sửa sai có thể
  rò slot ⇒ deadlock toàn bộ pool worker.
- **Error handling** — phải chọn một semantics fail-closed cho nhánh abort; nếu
  không, lỗi chuyển từ "chậm" sang "mất capacity".

Plan §6 liệt kê rủi ro chính của RR-014: **"Rò capacity slot nếu xử lý abort sai"**.

### Risk flags (theo `docs/FEATURE_INTAKE.md` → Risk Checklist)

| Risk flag | Áp dụng | Ghi chú |
|---|:-:|---|
| State mutation | | Không ghi state trên disk |
| Concurrency | ● | `#current` / `#queue` là shared mutable state trong process |
| Child process | ● | Primitive nằm trước `runChildPi` (`run-worker.ts:72-77`) |
| Error handling | ● | Cần semantics fail-closed cho nhánh abort |
| External tools | | |
| API contract | ○ | `acquire()` nhận thêm tham số **optional** — additive |
| Platform | | |
| Backward compat | ○ | Mọi call site hiện tại gọi `acquire()` không tham số |
| Dependencies | | Không thêm package |
| Security | | |

## Phạm vi thiệt hại (đọc kỹ trước khi chọn hướng sửa)

Đây là điểm dễ bị phóng đại nhất của finding này, nên ghi rõ:

- **KHÔNG có child process thừa.** `child-pi-spawn.ts:385` trả `kind: "aborted"`
  **trước khi spawn** khi `input.signal?.aborted` — nên sau khi slot cuối cùng
  được cấp, không có process nào bị fork (hiệu chỉnh C5).
- **Chi phí thật là delay:** promise của waiter B (và mọi `drainPendingUnits`
  đang await nó) treo suốt thời gian A còn giữ slot.
- Probe trong verification: cap=1, A giữ slot, B abort ở 20 ms → tại +300 ms B
  **chưa** settle; B chỉ settle khi A nhả ở +300 ms; `acquire()` trả về ở +303 ms
  với `signal.aborted === true` — tức slot được cấp cho một task **đã bị cancel**.
- `budget-enforcement.ts:93-100` là `drainPendingUnits` — nó **xác nhận**
  (corroborates) hậu quả chứ không phải nguyên nhân.
- `Promise.race` duy nhất trên đường liên quan là `run-coalesced-task-group.ts:270`
  (race *heartbeat drain*), không phải semaphore.

## Affected Modules

- `src/runtime/scheduling/semaphore.ts` — primitive cần sửa (`acquire()`, `#queue`)
- `src/runtime/scheduling/global-worker-cap.ts` — `acquireWorkerSlot()`,
  `withWorkerSlot()` (đường truyền signal)
- `src/runtime/run-worker.ts` — facade spawn (`:72-77`) đã có `signal` trong
  `input` nhưng chỉ được đọc sau khi acquire resolve
- `src/runtime/child-pi/child-pi-spawn.ts` — guard `:385` (không sửa; dùng làm
  bằng chứng giới hạn thiệt hại)
- `src/runtime/budget-enforcement.ts` — `drainPendingUnits` (`:93-100`) là
  consumer bị ảnh hưởng
- `test/unit/runtime/scheduling/` — nơi đặt test mới + test hồi quy
- `docs/decisions/` — decision record bắt buộc cho high-risk

## Acceptance Criteria

Mỗi AC dưới đây phải kiểm được bằng test tự động (không cần model, không cần
child process thật trừ khi ghi rõ).

**Nhóm A — waiter abort được**

- **AC-1.** Với cap=1, A giữ slot, B chờ rồi abort ở 20 ms: `acquire()` của B
  **settle trong bound hữu hạn** (test dùng deadline ≤ 100 ms) mà **không** cần
  A release.
- **AC-2.** `acquire()` của một waiter đã bị abort **không** trả về như "đã có
  slot". Giá trị trả về phải phân biệt được trạng thái hủy (reject với lỗi
  abort, hoặc một kiểu kết quả tường minh) — không được là một resolve trần.
- **AC-3.** Sau khi B abort, `semaphore.waiting` giảm đúng 1 (B không còn nằm
  trong queue).

**Nhóm B — slot accounting không rò**

- **AC-4.** Khi `acquire()` bị abort, `semaphore.current` **không** tăng.
  Bất biến `current <= max` đúng tại mọi điểm quan sát.
- **AC-5.** Sau khi A release, slot được handoff cho waiter **còn sống** kế tiếp
  (C) — không bị "đốt" vào waiter đã abort. Test: cap=1, queue [B(abort), C] →
  A release ⇒ C acquire được; `waiting === 0`.
- **AC-6.** Không rò listener: sau khi một waiter được cấp slot hoặc bị abort,
  không còn abort listener gắn trên signal của nó (test dùng một
  `AbortController` và đếm qua spy trên `addEventListener`/`removeEventListener`,
  hoặc chạy N=50 waiter trên cùng signal và assert không có
  `MaxListenersExceededWarning`).

**Nhóm C — race abort ↔ slot handoff**

- **AC-7.** Abort xảy ra **đúng lúc** `release()` đang handoff: kết quả phải
  thuộc đúng một trong hai trạng thái nhất quán — (a) acquire reject và slot vẫn
  còn nguyên cho waiter kế tiếp, hoặc (b) acquire resolve, caller thấy
  `signal.aborted === true` và release lại slot. Không được đồng thời reject và
  tiêu slot; không được leak slot. Test lặp N lần để tăng xác suất chạm cửa sổ.
- **AC-8.** Không spawn child khi abort trước spawn: chạy `runWorker` với
  `signal` đã abort trong lúc chờ slot → số lần spawn = **0**
  (spy/injected spawner; guard `child-pi-spawn.ts:385` là cơ chế sẵn có).

**Nhóm D — drain không treo**

- **AC-9.** `drainPendingUnits` (`budget-enforcement.ts:93-100`) settle trong
  bound hữu hạn khi các unit đang chờ slot bị abort — không chờ hết thời gian
  giữ slot của A.

**Nhóm E — không hồi quy**

- **AC-10.** Semantics cap hiện có giữ nguyên: peak overlap == cap; FIFO;
  release-on-throw; `cap: false` bypass; reject khi queue đầy
  (`Semaphore.MAX_QUEUE = 10_000`).
- **AC-11.** Backward-compat: `acquire()` không tham số vẫn hoạt động; mọi call
  site hiện có không phải sửa.

## Out of scope

- Quyền sở hữu run lock theo async context (F02) — **RR-011**. RR-014 không
  chạm `src/state/coordination/locks.ts`.
- Nested slot budget / anti-deadlock của delegation (ADR-5) — không đổi
  `nested-slots.ts`.
- Priority queue, fairness policy ngoài FIFO, hay timeout/expiry nội tại của
  semaphore — không nằm trong finding này.
- Semantics cancel của child runtime sau khi đã spawn (kill escalation, grace
  turns) — đã có và không sửa.
- Đổi `MAX_QUEUE`, đổi capacity default, hay đổi `PI_CREW_MAX_WORKERS`.
- Tăng `maxConcurrentWorkers` (plan §3 nguyên tắc 3 cấm).

## Dependencies

| Phụ thuộc | Loại | Lý do |
|---|---|---|
| **RR-011** (F02 — run lock theo async context) | Bắt buộc theo thứ tự | Plan §2.4: RR-014 "phụ thuộc RR-011 (cùng miền lock/slot)". Plan §6 xếp RR-014 **sau** RR-011 vì cùng miền lock/slot accounting — hai thay đổi đồng thời trên accounting sẽ khó quy lỗi khi test đỏ. |
| RR-012 (F03+F16 — delegation lifecycle) | Mềm | RR-012 chạm đường spawn grandchild (`cap:false`-style bypass); nếu RR-012 đổi shape của `withWorkerSlot`, RR-014 phải rebase. |
| RR-015 (F05 — CI integrity) | Mềm | RR-015 sửa exit semantics của `scripts/test-runner.mjs`; cho tới khi xong, kết quả test đỏ/xanh của RR-014 chưa hoàn toàn đáng tin (plan §6 lý do #2). |

## Tài liệu liên quan

- `docs/stories/RR-014/design.md` — defect + hướng sửa + phương án bị loại
- `docs/stories/RR-014/exec-plan.md` — các bước RED-first
- `docs/stories/RR-014/validation.md` — thang kiểm chứng + ánh xạ AC→proof
- `docs/decisions/` — decision record (stub trong `design.md`)
- `docs/TEST_MATRIX.md` — thêm hàng khi story đóng
