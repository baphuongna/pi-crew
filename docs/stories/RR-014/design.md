# RR-014 — Design: Semaphore waiter có thể abort

- **Story:** `docs/stories/RR-014/overview.md`
- **Nguồn:** review F15 + verification F15 (VERIFIED) + hiệu chỉnh **C5**
- **Baseline:** `pi-crew@0.11.1`, commit `0b9fa771`
- **Trạng thái:** proposed — chờ phê duyệt người + decision record

## 1. Defect

### 1.1 Primitive không có chỗ nhận signal

Ghi chú về chính module header (`semaphore.ts:1-11`) — nó liệt kê:

```ts
 * - Explicit acquire/release Semaphore for concurrency control
 * - Fail-fast on first error (via Promise.race)
 * - AbortSignal support for graceful cancellation
 * - Partial results on abort
```

Ba gạch đầu dòng cuối thuộc về `mapWithFailFast` / `ParallelResult` ở nửa sau
file, **không** thuộc `Semaphore`. `AbortSignal support` trong header dễ bị đọc
thành thuộc tính của semaphore — đây là một phần lý do finding này tồn tại lâu.
Khi sửa, header nên nói rõ phạm vi (sửa ở cùng commit, không tách).

`src/runtime/scheduling/semaphore.ts:27-50`:

```ts
27: async acquire(): Promise<void> {
28:   if (this.#current < this.#max) {
29:     this.#current++;
30:     return;
31:   }
32:   // FIX (Round 15): Reject when the waiter queue is full. The previous
33:   // implementation let #queue grow without bound, risking memory
34:   // exhaustion under sustained high concurrency with slow releases.
35:   if (this.#queue.length >= Semaphore.MAX_QUEUE) {
36:     // P1-7: reject (don't throw) so callers can backpressure instead of crashing.
37:     return Promise.reject(
38:       new Error(`Semaphore queue full: ${this.#queue.length} waiters (max ${Semaphore.MAX_QUEUE}); cannot acquire slot`),
39:     );
40:   }
41:   const { promise, resolve } = (() => {
42:     let res: () => void;
43:     const p = new Promise<void>((r) => {
44:       res = r;
45:     });
46:     return { promise: p, resolve: res! };
47:   })();
48:   this.#queue.push(resolve);
49:   return promise;
50: }
```

Hai chi tiết cấu trúc quyết định toàn bộ hướng sửa:

1. **`acquire()` không có tham số** (`acquire(): Promise<void>`) — không có
   `AbortSignal` để lắng nghe. Verification chốt:
   `Semaphore.prototype.acquire.length === 0`.
2. **Queue lưu `resolve` trần** (`#queue: Array<() => void>`,
   `this.#queue.push(resolve)`) — entry không mang identity, nên không có cách
   nào tham chiếu tới một waiter cụ thể để gỡ nó ra. Đây là lý do "chỉ cần thêm
   tham số signal" là chưa đủ: phải đổi shape của entry.

`release()` handoff trực tiếp, **không** chạm `#current` (`semaphore.ts:52-60`):

```ts
release(): void {
  const next = this.#queue.shift();
  if (next) {
    next();
  } else if (this.#current > 0) {
    this.#current--;
  }
  // Guard: over-release is a no-op to prevent #current going negative
}
```

Điểm này quan trọng cho phần race (§4): một slot được **chuyển giao**, không
được cấp mới. Mọi code path "bỏ qua" một waiter phải giữ nguyên `#current`.

### 1.2 Signal chỉ được đọc SAU khi acquire xong

`src/runtime/scheduling/global-worker-cap.ts:70-72`:

```ts
70: export async function acquireWorkerSlot(): Promise<void> {
71:   await semaphore.acquire();
72: }
```

`src/runtime/run-worker.ts:72-77`:

```ts
72: export async function runWorker(input: WorkerSpawnInput): Promise<ChildPiRunResult> {
73:   const { cap = true, ...childPiInput } = input;
74:   if (cap) {
75:     return withWorkerSlot(() => runChildPi(childPiInput));
76:   }
77:   return runChildPi(childPiInput);
78: }
```

`signal` **có** trong `input` (`ChildPiRunInput`), nhưng `withWorkerSlot` chỉ nhận
một closure `fn: () => Promise<T>` — signal bị chôn trong `childPiInput`, chỉ
được đọc khi `runChildPi` chạy, tức **sau** khi `acquire()` resolve. Không lớp
nào trên đường `acquire` biết tới signal.

### 1.3 Hậu quả đo được

Probe của verification (module `Semaphore` thật):

```text
Semaphore.prototype.acquire.length === 0
Cap=1, A giữ slot; B abort ở 20 ms → tại +300 ms B CHƯA settle
B chỉ settle khi A nhả ở +300 ms
acquire() trả về ở +303 ms với signal.aborted === true   ← slot cấp cho task đã cancel
```

### 1.4 Giới hạn thiệt hại (hiệu chỉnh C5 — đọc trước khi chọn hướng sửa)

`src/runtime/child-pi/child-pi-spawn.ts:385`:

```ts
383: // B5: if the parent already aborted before we spawn, do not start the child
384: // at all. Spawning a doomed process wastes resources, and the abort listener
385: // registered below will not re-fire for an already-aborted signal (so the
386: // child would only be killed later by the response-timeout path). Return a
387: // cancelled-style result immediately.
388: if (input.signal?.aborted) {
389:   return {
390:     kind: "aborted",
...
```

Guard này **hoạt động đúng**: khi `signal.aborted` là true, `runChildPi` trả
`kind: "aborted"` trước khi `spawn()` ⇒ **không có child process nào bị fork**.
Chi phí thật là **delay** settle, không phải process thừa.

Hệ quả thiết kế: giá trị của RR-014 nằm ở **latency và tính đúng của accounting**,
không phải ở "chống fork storm". Một bản sửa biến delay thành rò capacity là
**tệ hơn** trạng thái hiện tại — đó là rủi ro chính mà plan §6 ghi cho RR-014.

Consumer trực tiếp của delay: `src/runtime/budget-enforcement.ts:93-100`
(`drainPendingUnits`) `await Promise.allSettled(...)` trên các unit promise; nó
`controller?.abort()` nhưng signal đó không được semaphore đọc, nên drain vẫn
treo theo A. Đây là **corroboration**, không phải nguyên nhân.

## 2. Vì sao các guard hiện có không cứu được

| Guard hiện có | Vị trí | Vì sao không đủ |
|---|---|---|
| `if (input.signal?.aborted)` → `kind: "aborted"` | `child-pi-spawn.ts:388` | Nằm **sau** acquire. Ngăn được process thừa, không rút ngắn được thời gian chờ. |
| `withWorkerSlot` try/finally release | `global-worker-cap.ts:91-97` | Bảo đảm **release**, không bảo đảm **không chờ**. Chỉ chạy sau khi `fn()` được gọi. |
| `Semaphore.MAX_QUEUE` | `semaphore.ts:21,35-39` | Bound **bộ nhớ** của queue, không bound **độ trễ** của một waiter. |
| `drainPendingUnits` gọi `controller.abort()` | `budget-enforcement.ts:98` | Abort controller không tới được semaphore; `allSettled` vẫn chờ promise của unit đang xếp hàng. |
| `Promise.race` trong path liên quan | `run-coalesced-task-group.ts:270` | Race *heartbeat drain* (5 s ceiling), không phải race acquire. |

Không có test nào phủ semantics abort của `acquire()`. Test hiện có chỉ phủ cap
(FIFO, bound, release-on-throw, queue-full):
`test/unit/runtime/scheduling/global-worker-cap.test.ts`,
`test/unit/runtime/run-worker-cap.test.ts`,
`test/unit/runtime/scheduling/semaphore-cov.test.ts`.

## 3. Hướng đã chọn

**Signal-aware `acquire(signal?)` với waiter record có identity và settle
idempotent.** Nguyên tắc: một acquire chỉ có hai kết cục hợp lệ —
**đã nhận slot** hoặc **không nhận slot**; không bao giờ "nhận slot nhưng đã bị
cancel".

### 3.1 Shape

```ts
interface Waiter {
  settle(kind: "granted" | "aborted"): void;  // idempotent — lần gọi đầu thắng
  readonly signal?: AbortSignal;
}

async acquire(signal?: AbortSignal): Promise<void>   // additive, optional
```

Bốn bước:

1. **Aborted tại entry** → reject ngay (fail-closed), không lấy slot, không vào
   queue. Không có nhánh nào "thành công" khi signal đã abort.
2. **Còn slot** → `#current++`, rồi **kiểm tra lại** `signal.aborted` trước khi
   resolve. Nếu đã abort trong cửa sổ đó: `#current--` và reject. Điều này loại
   bỏ đúng kết cục mà probe ghi nhận (`acquire()` trả về với
   `signal.aborted === true`).
3. **Hết slot** → đẩy `Waiter` vào `#queue`, gắn `abort` listener. Khi abort:
   **gỡ entry khỏi queue** và reject. Gỡ là eager (`splice`), không lazy-skip —
   lý do ở §3.2.
4. **Listener cleanup**: `removeEventListener` trên **mọi** đường settle (granted
   hoặc aborted). Gắn listener trên chính `signal` được truyền vào, **không**
   qua `AbortSignal.any`, vì listener gắn trên signal dẫn xuất không gỡ được
   khỏi signal gốc.

`release()` thêm **vòng lặp skip phòng thủ**: `shift()` cho tới khi gặp waiter
chưa settle; nếu queue rỗng thì `#current--`. Vòng lặp này là belt-and-braces cho
trường hợp một entry đã settle nhưng còn sót trong queue (bug tương lai), và nó
**không** đổi semantics FIFO.

### 3.2 Vì sao eager removal chứ không lazy-skip

Lazy-skip (đánh dấu aborted, để `release()` bỏ qua) trông rẻ hơn nhưng **fail
AC-1 và AC-9**: promise của waiter đã abort vẫn pending cho tới lần `release()`
kế tiếp — mà chính xác là điều ta đang sửa. Waiter phải settle ở thời điểm
abort, không phải ở thời điểm A nhả slot.

### 3.3 Idempotency và race abort ↔ handoff

Cửa sổ nguy hiểm: `release()` đã `shift()` một waiter ra và sắp gọi resolve,
trong khi abort listener của chính waiter đó cũng sắp chạy. Nếu cả hai đều hành
động, ta có thể vừa resolve vừa "trả slot về queue" ⇒ **hai** slot ảo (leak
capacity) hoặc slot bốc hơi.

Chốt: `settle()` **idempotent**, lần gọi đầu thắng, và nó **tự gỡ listener**.
- Nếu `granted` thắng trước: waiter giữ slot; abort sau đó là no-op ở tầng
  semaphore. Caller thấy `signal.aborted` và đường của nó **vẫn release bình
  thường** — `runChildPi` trả `kind: "aborted"` (không throw), nên
  `withWorkerSlot` release trong `finally` ngay tick kế tiếp. Slot không bị giữ
  lâu hơn một microtask.
- Nếu `aborted` thắng trước: waiter đã bị gỡ khỏi queue ⇒ `release()` không thể
  `shift()` trúng nó; slot vẫn ở `#queue`/`#current` nguyên vẹn cho waiter kế.

Vì mọi thao tác trên `#queue`/`#current` đều **đồng bộ** (không `await` xen giữa),
không có interleaving nửa vời. Đây là ràng buộc implementation bắt buộc, không
phải chi tiết phong cách.

### 3.4 Hệ quả lên caller

Không call site nào **phải** sửa (AC-11). Đường truyền signal là additive:

- `acquireWorkerSlot(signal?)` forward xuống `semaphore.acquire(signal)`.
- `withWorkerSlot(fn, signal?)` forward xuống `acquireWorkerSlot(signal)`.
- `runWorker` truyền `childPiInput.signal` vào `withWorkerSlot`.

`runWorker` là nơi duy nhất cần sửa để có lợi ích thực tế, vì nó là facade spawn
duy nhất (CORE-13) và đã có `signal` trong input.

## 4. Phương án đã cân nhắc và bị loại

1. **`Promise.race([acquire(), abortPromise])` tại call site** — **loại**.
   Promise `acquire()` gốc vẫn pending và **vẫn tiêu một slot** khi nó resolve,
   mà không caller nào còn giữ nó để release ⇒ **rò capacity**. Đây chính là
   rủi ro plan §6 ghi cho RR-014. `Promise.race` không hủy được gì cả.
2. **Truyền signal xuống `withWorkerSlot` nhưng giữ `acquire()` không signal** —
   **loại**. Không sửa được gì: thời gian chờ nằm trong `acquire()`, không nằm
   trong `fn`.
3. **Lazy-skip trong `release()` (không gỡ entry)** — **loại**. Xem §3.2: waiter
   đã abort vẫn pending tới lần release kế tiếp ⇒ không đạt AC-1/AC-9.
4. **Abort một waiter ⇒ reject cả queue** — **loại**. Blast radius quá rộng:
   waiter không liên quan mất lượt, vi phạm FIFO, có thể làm worker đang sống
   thất bại vì cancel của người khác.
5. **Timeout nội tại thay cho signal** (`acquire({ timeoutMs })`) — **loại**.
   Không tôn trọng semantics cancel của caller; hằng số chọn bao nhiêu cũng sai
   (quá ngắn ⇒ phá lượt chờ hợp lệ, quá dài ⇒ vô dụng). Plan §3 không cho thêm
   magic number để lách vấn đề.
6. **Thay semaphore bằng thư viện promise-queue / primitive có sẵn của Node** —
   **loại**. Thêm dependency + viết lại primitive trung tâm của mọi worker spawn;
   plan §7 cấm "thêm abstraction lớp mới khi ranh giới lifecycle còn lỗi" và
   "rewrite orchestrator chỉ để giảm số dòng".
7. **Đổi `MAX_QUEUE` hoặc capacity default** — **loại**. Không liên quan tới
   latency của một waiter; plan §7 cấm tăng `maxConcurrentWorkers` khi lock và
   write amplification chưa xử lý.

## 5. Ảnh hưởng concurrency và state

### 5.1 State

Không có state trên disk. Chỉ có ba field in-process: `#max` (bất biến sau
constructor), `#current`, `#queue`. Không chạm manifest/tasks/events ⇒ không cần
migration, không đổi state format.

### 5.2 Bất biến phải giữ

| Bất biến | Nguồn | Cách kiểm |
|---|---|---|
| `#current <= #max` tại mọi điểm quan sát | `semaphore.ts:28-30`, `release()` | AC-4 |
| Mỗi slot được cấp có **đúng một** release tương ứng | `withWorkerSlot` try/finally | AC-4, AC-7 |
| `#queue.length <= MAX_QUEUE` (10 000) | `semaphore.ts:35-39` | AC-10 (không hồi quy) |
| FIFO giữa các waiter **còn sống** | `global-worker-cap.test.ts` "FIFO order" | AC-5, AC-10 |
| Handoff **không** chạm `#current` | `release()` nhánh `if (next)` | AC-5, AC-7 |

### 5.3 Rủi ro cụ thể và cách chặn

- **Rò slot khi abort thắng race** → chặn bằng eager removal (§3.2) + vòng lặp
  skip trong `release()` + AC-5/AC-7.
- **Listener leak trên signal dài hạn** (một `AbortController` của run được
  nhiều unit dùng chung) → chặn bằng `removeEventListener` trên mọi đường settle
  + AC-6. Đây là rủi ro thật: `AbortController` của run được share giữa nhiều
  unit, nên N waiter gắn N listener trên cùng một signal.
- **Đổi semantics của `acquire()` không tham số** → chặn bằng cách để tham số
  optional và **không** đổi nhánh `#current < #max` khi không có signal +
  AC-11.
- **Deadlock do "chờ slot mà không bao giờ được cấp"** → không tăng: abort chỉ
  làm **giảm** số waiter; `release()` không bao giờ bỏ đói queue.
- **Sửa `run-worker.ts` làm đổi shape spawn** → RR-012 (F03+F16) cũng chạm đường
  spawn; nếu RR-012 sửa `withWorkerSlot` signature trước, RR-014 rebase (xem
  Dependencies trong `overview.md`).

## 6. Test-first (tóm tắt; chi tiết ở `exec-plan.md`)

RED trước, dùng probe của verification làm seed. Test mới:
`test/unit/runtime/scheduling/semaphore-abort.test.ts` (primitive, không child
process) và `test/unit/runtime/run-worker-cap-abort.test.ts` (đường `runWorker`,
injected spawner/spy — **không** cần model).

## 7. Decision record (stub)

Bắt buộc theo `docs/FEATURE_INTAKE.md` → High-Risk ("Record decision in
`docs/decisions/`").

- **File:** `docs/decisions/2026-09-17-semaphore-signal-aware-acquire.md`
  (đặt tên theo tiền lệ date-prefix của các decision gần đây; số ADR để trống,
  gán khi ghi file thật).
- **Status:** proposed
- **Context:** F15 — `acquire()` không nhận `AbortSignal`; waiter đã cancel vẫn
  chờ hết lượt giữ slot; delay lan tới `drainPendingUnits`.
- **Decision:** thêm `acquire(signal?: AbortSignal)` với waiter record có identity
  và settle idempotent; eager removal khỏi queue; `#current` không đổi khi abort.
  Chấp nhận kết cục "granted rồi caller tự release" cho cửa sổ abort-sau-grant.
- **Alternatives considered:** bảy phương án ở §4 (đặc biệt: `Promise.race` tại
  call site — loại vì rò capacity).
- **Consequences:**
  - Tích cực: waiter đã cancel settle ngay; `drainPendingUnits` không còn treo
    theo thời gian giữ slot của A; không rò capacity.
  - Tradeoff: `#queue` đổi từ `Array<() => void>` sang entry có identity — mọi
    code đọc/ghi `#queue` phải cập nhật cùng lúc (một file, một lớp).
  - Tradeoff: cửa sổ abort-sau-grant vẫn tồn tại (không thể loại bỏ hoàn toàn
    với API promise); nó được bound bằng đường `kind: "aborted"` của
    `child-pi-spawn.ts:388` nên slot được trả trong một microtask.
- **Gate:** human confirmation trước implementation; `docs/TEST_MATRIX.md` thêm
  hàng khi story đóng.

## 8. Tài liệu liên quan

- `docs/stories/RR-014/overview.md`, `exec-plan.md`, `validation.md`
- `docs/archive/2026-09-17-pi-crew-review-verification.md` §3 (C5), §4 (F15)
- `docs/superpowers/plans/2026-09-17-review-remediation.md` §2.3, §5, §6
- `docs/decisions/2026-08-17-governed-nesting.md` — tiền lệ high-risk + bypass
  `cap:false` (ADR-5 §2)
