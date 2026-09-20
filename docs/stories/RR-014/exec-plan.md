# RR-014 — Exec plan: Semaphore waiter có thể abort

- **Story:** `docs/stories/RR-014/overview.md` · **Design:** `design.md`
- **Lane:** high-risk — **cần phê duyệt người trước bước 0**
- **Baseline:** `pi-crew@0.11.1`, commit `0b9fa771`
- **Nguyên tắc:** plan §3.1 — "Regression test trước, sửa sau". Mọi bước RED
  dùng probe của verification làm seed.

## Điều kiện tiên quyết (gate)

1. **Người phê duyệt story** (`docs/FEATURE_INTAKE.md` → High-Risk: "Ask human
   confirmation before implementation").
2. **RR-011 đã xong hoặc tối thiểu đã merge phần lock accounting** — plan §2.4
   ghi RR-014 phụ thuộc RR-011 ("cùng miền lock/slot"); plan §6 xếp RR-014 sau
   RR-011.
3. **RR-015 xong (khuyến nghị, không bắt buộc)** — plan §6 lý do #2: khi
   `scripts/test-runner.mjs:142` còn `process.exit(result.status ?? 0)`, một lần
   coordinator bị kill sẽ hiện ra là xanh. Làm RR-015 trước để đọc kết quả
   RR-014 một cách đáng tin.
4. **Ghi decision record** (`design.md` §7) ở trạng thái `proposed` **trước** khi
   sửa `src/`; chuyển `accepted` khi đóng story.
5. **Không có ai khác đang sửa** `src/runtime/scheduling/semaphore.ts`,
   `src/runtime/scheduling/global-worker-cap.ts`, `src/runtime/run-worker.ts`.
   Ba file này thuộc **một owner duy nhất** trong story này. RR-012 (F03+F16)
   chạm đường spawn — nếu RR-012 đang mở, dừng và xin sequencing từ leader.

## Thứ tự công việc (RED-first)

### Bước 1 — RED: test primitive (chưa sửa `src/`)

Tạo **file test mới**:
`test/unit/runtime/scheduling/semaphore-abort.test.ts`

Không sửa `semaphore.ts` ở bước này. Test phải **đỏ** vì `acquire()` hiện không
nhận tham số.

Nội dung tối thiểu (ánh xạ AC trong `overview.md`):

| Test | AC | Kỳ vọng hiện tại (RED) |
|---|---|---|
| `acquire(signal)` với cap=1, A giữ slot, B abort ở 20 ms ⇒ B settle ≤ 100 ms | AC-1 | đỏ: B chưa settle ở 100 ms |
| acquire đã abort ⇒ kết cục phân biệt được (reject), không phải resolve trần | AC-2 | đỏ |
| `s.waiting` giảm 1 sau abort | AC-3 | đỏ |
| `s.current` không tăng khi acquire bị abort | AC-4 | đỏ |
| cap=1, queue [B(abort), C] → A release ⇒ C acquire được, `waiting === 0` | AC-5 | đỏ |
| N waiter trên cùng một `AbortController` ⇒ không `MaxListenersExceededWarning`; listener count trở về baseline sau khi settle | AC-6 | đỏ |
| lặp N vòng: abort đúng lúc release ⇒ luôn đúng một trong hai trạng thái nhất quán, `current <= max` | AC-7 | đỏ/không xác định |
| `acquire()` không tham số vẫn chạy như cũ | AC-11 | **xanh ngay** (guard chống hồi quy) |

Seed RED: probe của verification (F15) —
`Semaphore.prototype.acquire.length === 0`; cap=1, B abort 20 ms, A nhả +300 ms.

**Command (vòng lặp RED→GREEN, một file):**

```bash
node scripts/test-runner.mjs --test-concurrency=1 --test-timeout=30000 --test-force-exit test/unit/runtime/scheduling/semaphore-abort.test.ts
```

Bằng chứng RED cần lưu: output có `fail` > 0 và tên test khớp AC-1..AC-7.

### Bước 2 — GREEN tối thiểu: `Semaphore.acquire(signal?)`

Sửa **một file**: `src/runtime/scheduling/semaphore.ts`.

Phạm vi (theo `design.md` §3.1):

- `#queue: Array<() => void>` → entry có identity (`settle(kind)` idempotent,
  `signal?`).
- `acquire(signal?: AbortSignal): Promise<void>`:
  1. aborted tại entry ⇒ reject, không lấy slot, không vào queue;
  2. còn slot ⇒ `#current++`, kiểm tra lại `signal.aborted` trước khi resolve,
     rollback `#current--` nếu đã abort;
  3. hết slot ⇒ đẩy waiter + gắn abort listener (gỡ entry khỏi queue khi abort);
  4. `removeEventListener` trên **mọi** đường settle.
- `release()`: vòng lặp skip waiter đã settle; không đổi `#current` khi có handoff.
- Gắn listener trên chính `signal` caller truyền vào, **không** qua
  `AbortSignal.any` (listener trên signal dẫn xuất không gỡ được khỏi gốc).

Không `await` xen giữa các thao tác trên `#queue`/`#current` (ràng buộc race —
`design.md` §3.3).

**Command:** lặp lại lệnh ở bước 1 cho tới khi 0 fail.

### Bước 3 — GREEN đường truyền signal

Sửa tiếp (cùng lượt, cùng owner):

- `src/runtime/scheduling/global-worker-cap.ts` — `acquireWorkerSlot(signal?)`
  forward xuống `semaphore.acquire(signal)`; `withWorkerSlot(fn, signal?)`.
- `src/runtime/run-worker.ts` — truyền `childPiInput.signal` vào
  `withWorkerSlot` ở nhánh `cap !== false` (`:72-77`).

Đây là thay đổi **additive**: tham số optional, không call site nào phải sửa
(AC-11).

### Bước 4 — RED→GREEN: test đường `runWorker`

Tạo **file test mới**:
`test/unit/runtime/run-worker-cap-abort.test.ts`

- AC-8: `runWorker` với `signal` đã abort **trong lúc chờ slot** ⇒ số lần spawn
  = 0. Dùng injected spawner/spy — **không** cần model, không cần child process
  thật. Có thể mượn seam env của `test/unit/runtime/run-worker-cap.test.ts`
  (`PI_TEAMS_PI_BIN` + `npm_config_prefix`) hoặc spy ở lớp `runChildPi` tuỳ seam
  nào ít xâm lấn hơn tại thời điểm viết.
- AC-9: `drainPendingUnits` (`src/runtime/budget-enforcement.ts:93-100`) settle
  trong bound hữu hạn khi unit đang chờ slot bị abort. Seed từ mô tả của review
  F15 (`budget-enforcement.ts:93-100` là `drainPendingUnits`).

**Command:**

```bash
node scripts/test-runner.mjs --test-concurrency=1 --test-timeout=30000 --test-force-exit test/unit/runtime/run-worker-cap-abort.test.ts
```

### Bước 5 — Hồi quy cap (AC-10)

Chạy lại toàn bộ test cap hiện có **không sửa gì trong chúng**:

```bash
node scripts/test-runner.mjs --test-concurrency=4 --test-timeout=30000 --test-force-exit \
  test/unit/runtime/scheduling/global-worker-cap.test.ts \
  test/unit/runtime/run-worker-cap.test.ts \
  test/unit/runtime/scheduling/semaphore-cov.test.ts
```

Kỳ vọng: tất cả pass, không test nào bị sửa assertion. Nếu một test cũ phải sửa
⇒ dừng, xem lại `design.md` §5.2 (bất biến) trước khi tiếp tục.

### Bước 6 — Gate tĩnh + typecheck

```bash
npm run typecheck
npm run lint
npm run format:check
```

Nếu `run-worker.ts` / `global-worker-cap.ts` / `semaphore.ts` vượt 2000 dòng:

```bash
npm run check:wc-gate
```

Không chạm env var, event type, ADR ⇒ các gate `check:env-vars`,
`check:event-types`, `check:decision-drift` không cần chạy riêng, nhưng
`check:decision-drift` sẽ chạy trong `npm run ci` sau khi decision record được
thêm.

### Bước 7 — Critical + unit

```bash
npm run test:critical
npm run test:unit
```

Lưu ý tiền đề (plan §4): **hai unit test đang fail sẵn** —
`test/unit/interrupt-guard-ack.test.ts` (flaky, chạy riêng 2/2 pass) và
`test/unit/runtime/broker/crew-broker-symlink-steering.test.ts`. Không story nào
được coi là "xanh" nếu `npm test` còn fail vì hai test này ⇒ ghi rõ trong
`validation.md` rằng chúng fail **trước** RR-014, không do RR-014.

### Bước 8 — Integration + bundle

```bash
npm run test:integration
npm run build:bundle
npm run test:bundle
```

`dist/index.mjs` là bundle mặc định (từ v0.9.17) — **bắt buộc rebuild** để thay
đổi có hiệu lực trong session thật (`.crew/knowledge.md`).

### Bước 9 — Đóng story

- `docs/decisions/2026-09-17-semaphore-signal-aware-acquire.md` → `accepted`.
- Thêm hàng vào `docs/TEST_MATRIX.md`.
- Thêm RR-014 vào bảng Active của `docs/stories/README.md`.
- Ghi bằng chứng vào `docs/stories/RR-014/validation.md` §Evidence.
- `npm run ci` (full gate) trước khi publish.

## Điểm rollback

**Rollback point duy nhất: sau bước 1 (RED), trước bước 2.**

- Bước 1 chỉ **thêm file test mới**, không sửa `src/`. Revert = xóa
  `test/unit/runtime/scheduling/semaphore-abort.test.ts`.
- Bước 2 là commit **đầu tiên** chạm `src/` và là điểm không thể rollback nửa
  vời: `#queue` đổi shape, nên mọi thay đổi phải vào **cùng một commit** với
  `release()`. Không tách "đổi shape queue" và "thêm abort" thành hai commit.
- Bước 3–4 có thể revert độc lập (additive, không caller nào phụ thuộc).
- Nếu bước 5 phát hiện hồi quy cap: revert **toàn bộ** commit bước 2–3 về
  `0b9fa771` (hoặc commit ngay trước), giữ file test RED làm tài liệu. Không cố
  vá nửa vời trên một primitive trung tâm.

**Tiêu chí abort story:** nếu không giữ được đồng thời AC-4 (không rò capacity)
và AC-1 (settle nhanh), **dừng** và báo leader — chọn delay như hiện tại là an
toàn hơn chọn rò capacity (`design.md` §1.4).

## File dự kiến chạm

| File | Loại | Bước |
|---|---|---|
| `test/unit/runtime/scheduling/semaphore-abort.test.ts` | mới | 1 |
| `src/runtime/scheduling/semaphore.ts` | sửa | 2 |
| `src/runtime/scheduling/global-worker-cap.ts` | sửa (additive) | 3 |
| `src/runtime/run-worker.ts` | sửa (additive) | 3 |
| `test/unit/runtime/run-worker-cap-abort.test.ts` | mới | 4 |
| `docs/decisions/2026-09-17-semaphore-signal-aware-acquire.md` | mới | 0, 9 |
| `docs/stories/RR-014/validation.md` | cập nhật | 9 |
| `docs/TEST_MATRIX.md`, `docs/stories/README.md` | cập nhật | 9 |
| `dist/index.mjs` (bundle) | rebuild | 8 |

## Rủi ro đã biết khi thực thi

- **Cửa sổ abort-sau-grant** không loại bỏ được hoàn toàn (`design.md` §3.3).
  Nó được bound bằng đường `kind: "aborted"` của `child-pi-spawn.ts:388`, nên
  slot được trả trong một microtask. Ghi rõ trong decision record là
  **tradeoff đã chấp nhận**, không phải bug còn sót.
- **Listener leak** trên `AbortController` dùng chung của run — AC-6 phủ.
- **`test/unit/runtime/run-worker-cap-abort.test.ts` chạy trong worker shell**
  có thể gặp env gotcha `PI_CREW_*` (`.crew/knowledge.md` 2026-08-15): harness
  export `PI_CREW_SCRATCHPAD`, `PI_CREW_TASK_ID`, `PI_CREW_DEPTH`… Snapshot và
  xoá các biến spawn-relevant như `run-worker-cap.test.ts` đang làm, nếu không
  depth guard sẽ chặn.
- **Không chạy full suite trong vòng lặp RED→GREEN** — 13+ phút (plan §4, và
  review §6.2 ghi ~790 s cho unit). Dùng `node scripts/test-runner.mjs <file>`.
