# RR-014 — Validation: Semaphore waiter có thể abort

- **Story:** `docs/stories/RR-014/overview.md` · **Design:** `design.md` ·
  **Exec plan:** `exec-plan.md`
- **Baseline:** `pi-crew@0.11.1`, commit `0b9fa771`
- **Trạng thái:** planned — chưa có bằng chứng (mục §Evidence còn trống)

## 1. Thang kiểm chứng (validation ladder)

Theo `docs/superpowers/plans/2026-09-17-review-remediation.md` §4. Cột
"Áp dụng" cho biết level nào là bắt buộc cho RR-014.

| Level | Command | Khi dùng | Áp dụng |
|---|---|---|---|
| quick | `npm run typecheck` | mọi story | ✅ bắt buộc |
| targeted | `node scripts/test-runner.mjs <file>` | vòng lặp RED→GREEN | ✅ bắt buộc |
| critical | `npm run test:critical` (14 file) | trước commit | ✅ bắt buộc |
| unit | `npm run test:unit` | normal+ trước khi đóng story | ✅ bắt buộc |
| lint | `npm run lint && npm run format:check` | mọi story có sửa `src/` | ✅ bắt buộc |
| gates | `npm run check:wc-gate` | story chạm module lớn | ✅ có điều kiện |
| integration | `npm run test:integration` | F01, F02, F03, F09, F16 | ⚠️ không nằm trong danh sách plan §4, nhưng chạy vì `run-worker.ts` là đường spawn |
| bundle | `npm run build:bundle && npm run test:bundle` | sau khi sửa `src/` | ✅ bắt buộc |
| full | `npm run ci` | trước publish | ✅ bắt buộc khi đóng story |

## 2. Lệnh chính xác và kết quả kỳ vọng

Chạy **từ trong** `/home/bom/source/my_pi/pi-crew`.

### 2.1 Targeted — primitive (RED → GREEN)

```bash
node scripts/test-runner.mjs --test-concurrency=1 --test-timeout=30000 --test-force-exit test/unit/runtime/scheduling/semaphore-abort.test.ts
```

| Thời điểm | Kỳ vọng |
|---|---|
| Sau bước 1 (`exec-plan.md`), chưa sửa `src/` | **fail > 0**; test AC-1..AC-7 đỏ; test AC-11 xanh |
| Sau bước 2 | `fail 0`, `pass` = số test trong file |

Điều kiện "đỏ đúng cách": test AC-1 phải đỏ vì **timeout/deadline**, không phải
vì lỗi biên dịch hay sai đường dẫn import. Test AC-2 phải đỏ vì nhận
`undefined`/resolve trần thay vì một kết cục hủy phân biệt được.

### 2.2 Targeted — đường `runWorker`

```bash
node scripts/test-runner.mjs --test-concurrency=1 --test-timeout=30000 --test-force-exit test/unit/runtime/run-worker-cap-abort.test.ts
```

| Thời điểm | Kỳ vọng |
|---|---|
| Sau bước 4 | `fail 0`; AC-8 (spawn count = 0) và AC-9 (drain settle hữu hạn) xanh |

Nếu file này chạy **trong** một pi-crew worker shell, phải scrub env trước
(`.crew/knowledge.md` 2026-08-15: harness export `PI_CREW_SCRATCHPAD`,
`PI_CREW_TASK_ID`, `PI_CREW_DEPTH`, …), nếu không depth guard sẽ chặn và test
đỏ **sai lý do**.

### 2.3 Hồi quy cap (không sửa test cũ)

```bash
node scripts/test-runner.mjs --test-concurrency=4 --test-timeout=30000 --test-force-exit \
  test/unit/runtime/scheduling/global-worker-cap.test.ts \
  test/unit/runtime/run-worker-cap.test.ts \
  test/unit/runtime/scheduling/semaphore-cov.test.ts
```

Kỳ vọng: `fail 0` và **không** test nào bị sửa assertion. Bao gồm:

- peak overlap == cap (2) và cap=1 serialize;
- FIFO (`["a","b"]`);
- release-on-throw (không rò slot ⇒ không deadlock);
- `cap: false` bypass;
- `Semaphore.MAX_QUEUE === 10_000` và reject khi queue đầy;
- over-release là no-op (`current` không âm).

### 2.4 Typecheck / lint

```bash
npm run typecheck
npm run lint
npm run format:check
```

Kỳ vọng: exit 0 cả ba. `npm run typecheck` chạy `tsc --noEmit` **và** import
`index.ts` qua `--experimental-strip-types` — nghĩa là một lỗi chỉ xuất hiện ở
đường strip-types cũng bị bắt.

### 2.5 wc-gate (nếu có file chạm 2000 dòng)

```bash
npm run check:wc-gate
```

Kỳ vọng: exit 0. Ba file dự kiến chạm đều nhỏ
(`semaphore.ts`, `global-worker-cap.ts`, `run-worker.ts`) nên gate này chủ yếu
là phòng ngừa.

### 2.6 Critical (14 file, trước commit)

```bash
npm run test:critical
```

Kỳ vọng: `fail 0`. **Cảnh báo tiền đề:** `test:critical` chứa
`test/unit/runtime/broker/crew-broker-symlink-steering.test.ts` — một trong hai
unit test **đang fail sẵn** theo plan §4 (trả `request-timeout` thay vì
`ok: true`). Nếu file này đỏ, đó là trạng thái **trước** RR-014; ghi lại làm
baseline, không quy cho RR-014.

### 2.7 Unit (toàn bộ)

```bash
npm run test:unit
```

Kỳ vọng: `fail 0` **trừ** hai test đã biết (plan §4):

- `test/unit/interrupt-guard-ack.test.ts` — flaky trong full suite (expected 1,
  actual 0); chạy riêng 2/2 pass;
- `test/unit/runtime/broker/crew-broker-symlink-steering.test.ts` — fail cả khi
  chạy riêng.

Theo plan §4: **không story nào được coi là "xanh" nếu `npm test` còn fail vì
hai test này.** Nghĩa là RR-014 chỉ có thể đóng sau khi hai test này được xử lý
trước hoặc cùng RR-015. Ghi rõ điều này trong §Gaps.

### 2.8 Integration

```bash
npm run test:integration
```

Kỳ vọng: `fail 0` (baseline review §6.2: 124 pass, 0 fail, 4 skip khi chạy
riêng). Chạy level này vì RR-014 chạm đường spawn worker; `run-coalesced-*` và
`team-runner` đi qua `withWorkerSlot`.

### 2.9 Bundle

```bash
npm run build:bundle
npm run test:bundle
```

Kỳ vọng: build exit 0; `test:bundle` `fail 0`.

**Bắt buộc** vì `dist/index.mjs` là entry mặc định từ v0.9.17
(`.crew/knowledge.md`): sửa `src/` mà không rebuild bundle thì thay đổi **không**
có hiệu lực trong session thật.

### 2.10 Full gate

```bash
npm run ci
```

Kỳ vọng: exit 0 trước khi publish. Lưu ý hai gate đã biết đang đỏ **không liên
quan RR-014** (review §6.3): `check:env-vars` (`knowledge-injection.ts:466`
`PI_CREW_KIND`; `stale-reconciler.ts:287` `PI_CREW_DEBUG_STALE`) và
`check:event-types` (89 registered vs 123 emitted). Nếu chúng vẫn đỏ, RR-014
không được coi là nguyên nhân, nhưng `npm run ci` cũng sẽ không xanh — cần ghi
rõ trong bằng chứng.

### 2.11 CI 3-OS (sau khi push)

GitHub Actions matrix ubuntu/windows/macos × Node 22 (`.github/workflows/ci.yml`).
Kỳ vọng 3/3 green.

## 3. Ánh xạ AC → bằng chứng

| AC (overview.md) | Nội dung | Bằng chứng | Level |
|---|---|---|---|
| AC-1 | Waiter đã abort settle trong bound hữu hạn, không cần A release | `semaphore-abort.test.ts` — cap=1, A giữ slot, B abort 20 ms, deadline ≤ 100 ms | targeted |
| AC-2 | Kết cục hủy phân biệt được (không resolve trần) | `semaphore-abort.test.ts` — assert reject với lỗi abort | targeted |
| AC-3 | `waiting` giảm 1 sau abort | `semaphore-abort.test.ts` — assert `s.waiting` | targeted |
| AC-4 | `current` không tăng khi acquire bị abort; `current <= max` | `semaphore-abort.test.ts` — assert sau abort và trong vòng lặp race | targeted |
| AC-5 | Slot handoff cho waiter còn sống kế tiếp | `semaphore-abort.test.ts` — queue [B(abort), C], A release ⇒ C acquire, `waiting === 0` | targeted |
| AC-6 | Không rò abort listener | `semaphore-abort.test.ts` — N waiter trên một `AbortController`; không `MaxListenersExceededWarning`; listener count về baseline | targeted |
| AC-7 | Race abort ↔ handoff luôn nhất quán, không leak | `semaphore-abort.test.ts` — lặp N vòng, assert một trong hai trạng thái + `current <= max` | targeted |
| AC-8 | Không spawn khi abort trước spawn | `run-worker-cap-abort.test.ts` — spawn count = 0 (spy/injected spawner) | targeted |
| AC-9 | `drainPendingUnits` settle hữu hạn | `run-worker-cap-abort.test.ts` — deadline quanh `drainPendingUnits` (`budget-enforcement.ts:93-100`) | targeted |
| AC-10 | Không hồi quy cap: peak==cap, FIFO, release-on-throw, `cap:false`, queue-full | `global-worker-cap.test.ts`, `run-worker-cap.test.ts`, `semaphore-cov.test.ts` — **không sửa** | critical |
| AC-11 | Backward-compat `acquire()` không tham số | test AC-11 trong `semaphore-abort.test.ts` (xanh từ trước) + toàn bộ suite cũ | targeted + unit |

**Độ phủ:** mọi AC đều có ít nhất một test tự động, không cần model, không cần
LLM, không cần child process thật (trừ seam env tuỳ chọn ở AC-8).

## 4. Gaps và rủi ro chưa được chứng minh

1. **Hai unit test đỏ sẵn** (plan §4). Cho tới khi xử lý, tiêu chí "xanh" của
   RR-014 không đạt được về mặt hình thức. Không thể chứng minh RR-014 không
   góp phần vào flakiness của `interrupt-guard-ack.test.ts` nếu không chạy
   nhiều lần; cách xử lý đúng là làm RR-015 trước.
2. **Không đo được lợi ích end-to-end** bằng số liệu thật. Probe của verification
   là microbenchmark primitive (cap=1, một waiter). Không có baseline p50/p95
   cho "slot wait time" trong production. Plan §3.3 và review §7.2 cấm suy rộng
   microbenchmark thành cam kết latency. Nếu cần số đo, phải lấy từ run thật và
   ghi rõ fixture.
3. **Cửa sổ abort-sau-grant** không thể loại bỏ hoàn toàn ở tầng promise. Được
   bound bằng `child-pi-spawn.ts:388` (`kind: "aborted"`) nên slot trả trong một
   microtask — nhưng điều này dựa vào việc `withWorkerSlot` release trong
   `finally` trên mọi đường. AC-7 phủ bằng test lặp, không phủ bằng chứng minh.
4. **`AbortSignal.any` / signal dẫn xuất** — nếu một call site tương lai truyền
   signal dẫn xuất, listener không gỡ được khỏi signal gốc. Đây là lý do
   implementation gắn listener trên chính signal được truyền vào; nhưng nếu
   caller truyền signal dẫn xuất, rủi ro listener leak quay lại. AC-6 không phủ
   trường hợp đó (chỉ phủ N waiter trên một signal).
5. **Chưa chạy multi-platform.** RR-014 không chạm path/FS, nhưng CI 3-OS vẫn
   phải xanh trước khi publish (quy trình release trong `.crew/knowledge.md`).
6. **`run-worker-cap-abort.test.ts` trong worker shell** cần scrub env — nếu
   quên, test có thể đỏ vì depth guard, không vì defect. Chưa xác minh được
   cho tới khi viết test.
7. **Không kiểm chứng được tác động lên `drainPendingUnits` trong run thật.**
   AC-9 dùng fixture; chưa có bằng chứng từ một run bị cancel giữa lúc queue.

## 5. Evidence

> Điền sau khi thực thi. Không được đánh dấu AC là đạt nếu ô bằng chứng trống.

| Kiểm tra | Ngày | Kết quả | Bằng chứng (command + output/link) |
|---|---|---|---|
| RED bước 1 | | | |
| GREEN bước 2 | | | |
| GREEN bước 3–4 | | | |
| Hồi quy cap (§2.3) | | | |
| `npm run typecheck` | | | |
| `npm run lint` + `format:check` | | | |
| `npm run check:wc-gate` | | | |
| `npm run test:critical` | | | |
| `npm run test:unit` | | | |
| `npm run test:integration` | | | |
| `npm run build:bundle` + `test:bundle` | | | |
| `npm run ci` | | | |
| CI 3-OS | | | |

**Baseline phải ghi kèm (chạy trước khi sửa, để tách lỗi cũ khỏi lỗi mới):**

- `test/unit/interrupt-guard-ack.test.ts` — trạng thái trong full suite;
- `test/unit/runtime/broker/crew-broker-symlink-steering.test.ts` — trạng thái;
- `npm run check:env-vars`, `npm run check:event-types` — trạng thái.

## 6. Điều kiện đóng story

Story chỉ chuyển `completed` khi:

1. Mọi AC-1..AC-11 có ô bằng chứng đã điền ở §5.
2. Decision record `docs/decisions/2026-09-17-semaphore-signal-aware-acquire.md`
   ở trạng thái `accepted`.
3. `docs/TEST_MATRIX.md` có hàng RR-014.
4. `npm test` không fail vì hai test tiền đề (plan §4) — nghĩa là RR-015 đã xong
   hoặc hai test đó đã được sửa.
5. §4 gaps được ghi lại trung thực, không bị xoá.

## 7. Tài liệu liên quan

- `docs/stories/RR-014/overview.md` (AC gốc)
- `docs/stories/RR-014/design.md` (bất biến §5.2, rủi ro §5.3)
- `docs/stories/RR-014/exec-plan.md` (bước ↔ lệnh)
- `docs/superpowers/plans/2026-09-17-review-remediation.md` §3, §4, §6
- `docs/archive/2026-09-17-pi-crew-review-verification.md` §3 (C5), §4 (F15), §7
- `docs/TEST_MATRIX.md`, `docs/templates/validation-report.md`
