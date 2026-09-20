# RR-011 — Exec plan: quyền sở hữu run lock theo async context (F02)

- **Lane:** high-risk
- **Status:** planned — **không bắt đầu khi chưa có phê duyệt** (plan §6)
- **Nguyên tắc:** regression test trước, sửa sau (plan §3.1). RED phải fail vì
  `maxActive === 2` / mất cập nhật, **không** vì lỗi biên dịch.
- **Phạm vi:** chỉ nhánh **async** của run lock (verification C2). Sync↔sync và
  sync↔async phải giữ nguyên hành vi.

## 0. Chuẩn bị

```bash
cd /home/bom/source/my_pi/pi-crew
git status --short
npm run typecheck
git rev-parse HEAD          # ghi làm rollback point R0
rg -n "withRunLock\(|withRunLockSync\(" src --glob '*.ts'   # liệt kê caller thật
```

Đọc trước: `docs/archive/2026-09-17-pi-crew-review-verification.md` §3 C2 và §4 F02.
Seed test từ hai probe trong §4 F02 (probe 1: `maxActive = 2`; probe 2: token đổi
`f0b30705` → `2fa28d60` và lock file `ENOENT` khi holder thứ hai còn sống).

**Quyết định cần chốt trước khi code (hỏi leader nếu chưa rõ):**
§4.4 của `design.md` — khi bị giữ bởi context khác cùng process, **chờ tới
deadline rồi ném** hay **ném ngay như hiện tại**? Mặc định an toàn cho phạm vi:
giữ hành vi ném ngay, chỉ đảm bảo không chồng lấn. Ghi lựa chọn vào decision record.

## Bước 1 — RED: mutual exclusion async↔async cho `withRunLock`

**Tạo:** `test/unit/state/coordination/run-lock-async-async-mutual-exclusion.test.ts`

Hình dạng (theo tiền lệ `locks-async-async-mutual-exclusion.test.ts` — dùng
`createDeferred` để gate caller 2 trên caller 1 **đã vào** critical section; gate
này là bắt buộc, vì `Promise.all` trần có thể không tái hiện lỗi tuỳ microtask):

1. Dựng manifest tối thiểu (theo `mkManifest` trong `locks-race.test.ts` hoặc
   `round30-h1-run-lock-async-context.test.ts`) với `stateRoot` trong thư mục tạm.
2. `let current = 0; let maxConcurrent = 0;`
3. `const aEntered = createDeferred();`
4. `const p1 = withRunLock(manifest, async () => { current++; maxConcurrent =
   Math.max(...); aEntered.resolve(); await sleep(40); current--; });`
5. `await aEntered.promise;`
6. `const p2 = withRunLock(manifest, async () => { current++; maxConcurrent =
   Math.max(...); await sleep(20); current--; });`
7. `await Promise.all([p1, p2]);`
8. `assert.equal(maxConcurrent, 1, ...)` ← **assertion lõi (AC1)**

```bash
node scripts/test-runner.mjs test/unit/state/coordination/run-lock-async-async-mutual-exclusion.test.ts
```

**Kỳ vọng RED:** fail với `maxConcurrent` bằng 2 (probe xác minh:
`MAX CONCURRENT HOLDERS = 2 / MUTUAL EXCLUSION VIOLATED`).

**Vì sao RED tất định:** `staleMs` mặc định là `DEFAULT_LOCKS.staleMs` (30 s), nên
B **không** chờ hết stale — nó steal ngay qua nhánh `treatOwnPidAsStealable`
(`canSteal: isStale || !isAlive || (treatOwnPidAsStealable && isOurOwnHolder)`).
Không cần chỉnh `staleMs` nhỏ cho test này.

**Rollback:** xoá file test mới; không chạm `src/`.

## Bước 2 — RED: không mất cập nhật (AC2) + release không xoá lock của holder khác (AC5)

**Sửa (extend):** cùng file test.

- **AC2:** mỗi context làm read-modify-write một bộ đếm trong một file trong
  `stateRoot` (đọc số, `+1`, ghi lại); sau `Promise.all`, giá trị cuối phải bằng
  số lần ghi của cả hai. Không dùng `await sleep` dài trong thân đọc-ghi để tránh
  flaky; giữ `current++/current--` làm bằng chứng chồng lấn và dùng bộ đếm file
  làm bằng chứng mất cập nhật.
- **AC5:** trong thân critical section của B, assert lock file tồn tại:
  `assert.equal(fs.existsSync(path.join(stateRoot, "run.lock")), true)`. Kèm assert
  bổ sung: sau khi A thoát nhưng B còn trong CS, lock file **vẫn tồn tại** (tái
  hiện đúng probe 2: `ENOENT` khi B còn sống).

```bash
node scripts/test-runner.mjs test/unit/state/coordination/run-lock-async-async-mutual-exclusion.test.ts
```

**Kỳ vọng RED:** AC2 fail (mất một bản ghi), AC5 fail (`existsSync === false`).
**Rollback:** revert file test về trạng thái bước 1.

## Bước 3 — GREEN: danh tính holder theo token

**Sửa:** `src/state/coordination/locks.ts`

1. Thêm module-private `const runLockHeldTokens = new Set<string>()` — tập token
   của mọi run-lock acquisition **đang giữ sống** trong process. Đặt nó cạnh
   `lockCtx` và ghi comment phân biệt rõ: tập này trả lời "holder có còn sống
   không", **không** tham gia quyết định re-entrance (việc đó vẫn là `lockCtx`).
2. `readLockSnapshot(filePath, staleMs, options)` — mở rộng options:
   `{ treatOwnPidAsStealable?: boolean; activeHolderTokens?: ReadonlySet<string> }`.
   Đọc thêm trường `token` từ payload (đã có sẵn — **không** đổi `writeLockFile`).
   Điều kiện steal mới (design §4.2):

```ts
	// Chỉ steal vì "PID là của tôi" khi lock KHÔNG thuộc một acquisition còn sống
	// trong process này (tra vào tập token đang giữ). Token vắng/không parse được
	// ⇒ coi như không thuộc tập ⇒ vẫn steal (giữ hành vi chống CI flake cho lock
	// cũ không có trường token).
	const isOurOwnHolder = holderPid === process.pid;
	const holderIsLiveInProcess = holderToken !== undefined && (activeHolderTokens?.has(holderToken) ?? false);
	const ownPidStealable = treatOwnPidAsStealable && isOurOwnHolder && !holderIsLiveInProcess;
	return { canSteal: isStale || !isAlive || ownPidStealable };
```

   **Cảnh báo (đừng làm theo hướng sai):** so `holderToken` với token của lần
   acquire **hiện tại** (`holderToken !== ourToken`) là **sai** — token mới là
   `randomUUID()` mới nên luôn khác token của holder sống ⇒ vẫn steal ⇒ bug không
   được sửa. Xem `design.md` §4.2 "Biến thể SAI".
3. `acquireLockWithRetryAsync` — truyền `activeHolderTokens: runLockHeldTokens`
   xuống `readLockSnapshot`. (Không truyền token hiện tại; không cần biết token
   trước khi `writeLockFile` thành công.)
4. `withRunLock` / `withRunLockSync` — sau khi acquire thành công:
   `runLockHeldTokens.add(token)`; trong `finally`: `runLockHeldTokens.delete(token)`
   **trước** khi gọi `releaseOwnLock(filePath, token)`. `lockCtx` **giữ nguyên**
   kiểu `Set<string>` và logic re-entrance không đổi.
5. `releaseOwnLock(filePath, token)` — bỏ tiền tố `_`, so token trước khi `rmSync`:

```ts
	const stored = readLockToken(filePath);            // hàm đã có, guard symlink sẵn
	if (stored !== undefined && stored === token) {
		fs.rmSync(filePath, { force: true });
	}
```

   Giữ nguyên guard symlink ở đầu hàm và log lỗi I/O như hiện tại. **Chú ý:** nếu
   `stored === undefined` (file biến mất, payload hỏng) thì **không** xoá; phải
   kiểm tra không gây rò lock file trong luồng bình thường (AC9 +
   `locks-race.test.ts` sẽ bắt).

```bash
node scripts/test-runner.mjs test/unit/state/coordination/run-lock-async-async-mutual-exclusion.test.ts
node scripts/test-runner.mjs test/unit/round30-h1-run-lock-async-context.test.ts test/unit/state/coordination/locks-race.test.ts test/unit/state/coordination/locks-untested.test.ts
npm run typecheck
```

**Kỳ vọng GREEN:** file test mới pass (AC1/AC2/AC5); ba file cũ pass **nguyên
trạng** (AC4 — không sửa assertion của `round30-h1-run-lock-async-context.test.ts`).
**Rollback:** `git checkout -- src/state/coordination/locks.ts` (R0).

**Rủi ro cần theo dõi ở bước này:** `releaseOwnLock` chặt hơn có thể làm lock file
"mồ côi" trong luồng tuần tự nếu token không khớp vì lý do bất ngờ (ví dụ lock bị
steal giữa đường). Nếu AC9 fail, kiểm tra theo thứ tự: (1) `runLockHeldTokens` có
được xoá trong `finally` không, (2) token truyền vào `releaseOwnLock` có phải token
thực sự đã ghi vào lock file không (token sinh ở đầu vòng lặp retry, **không** phải
token của vòng lặp trước), (3) có nhánh nào bỏ qua `releaseOwnLock` không. **Không**
"sửa" bằng cách nới điều kiện steal.

## Bước 4 — Đo chiều chưa xác minh + re-entrance cùng context (AC3)

**Đo trước (quan trọng):** xác minh C2 chỉ chứng minh chiều **async giữ + sync gọi**
(`round30-h1-run-lock-async-context.test.ts:89,163`). Chiều ngược lại
(**sync giữ + async gọi**) chưa có probe nào — `design.md` §3 suy luận từ cấu trúc
mã rằng nó không thể chồng lấn (thân sync không nhường event loop), nhưng suy luận
này chưa được xác nhận. Thêm một test cho chiều này **trước** khi sửa `src/`, và
ghi lại kết quả:

- `withRunLockSync(manifest, () => { ...gate qua deferred... })` giữ lock; trong
  lúc đó gọi `withRunLock` từ một async context khác (ví dụ qua `setTimeout` hoặc
  `await setImmediate`).
- **Chú ý:** `withRunLockSync` là **đồng bộ**, nên không thể `await` bên trong thân
  nó. Cách dựng khả thi: cho thân sync làm một công việc ngắn nhưng **chạy trước**
  khi async caller được schedule, rồi kiểm tra async caller có bị chặn/steal hay
  không. Nếu không dựng được seam tất định, ghi vào `validation.md` §Known gaps là
  "chiều sync→async chưa đo được ở mức unit" — **không** kết luận nó đúng.
- Nếu test này cho thấy chiều sync→async **cũng vỡ**: **dừng, báo leader**. Điều đó
  nghĩa phạm vi F02 rộng hơn C2 mô tả và báo cáo xác minh cần chỉnh. Hướng sửa
  §4.2 (tập token đang giữ sống) phủ cả hai chiều, nhưng phải được duyệt lại.

**Sửa (extend):** file test mới, thêm (AC3):

- `withRunLock` lồng `withRunLock` (cùng context) → bypass, trả giá trị trong, lock
  còn tồn tại tới khi hàm ngoài cùng xong, không deadlock.
- `withRunLock` lồng `withRunLockSync` (cùng context) → bypass (đường H-1/ST-14).
- `withRunLockSync` lồng `withRunLock` — ghi rõ hành vi quan sát được vào test và
  vào `validation.md` §Known gaps nếu hành vi không rõ ràng.

```bash
node scripts/test-runner.mjs test/unit/state/coordination/run-lock-async-async-mutual-exclusion.test.ts
```

**Rollback:** revert phần test AC3.

## Bước 5 — RED→GREEN: steal cho holder chết/stale vẫn hoạt động (AC7)

**Sửa (extend):** file test mới, thêm:

- Ghi lock file giả với `pid` đã chết (ví dụ `99999`) và `createdAt` cũ ⇒
  `withRunLock` acquire thành công.
- Ghi lock file giả với `createdAt` cũ nhưng `pid` còn sống (chính process) ⇒ steal
  thành công (stale).
- Ghi lock file giả **không có** trường `token` (payload cũ) ⇒ **vẫn steal**
  theo nhánh own-PID. Đây là hành vi được chốt ở design §4.2/§7/§8: giữ nguyên
  fix CI flake gốc (parallel-research scaffold mode) cho lock file legacy —
  không token thì không thể phân biệt holder sống, nên giữ hành vi cũ.
  (Hiệu chỉnh 2026-09-17: bản đầu của bullet này viết "không token ⇒ ném
  `locked`" — sai với design; implementation và test AC7-c khẳng định steal.)

Tiền lệ dựng lock file giả: `test/unit/state/coordination/locks-race.test.ts`
(viết `run.lock` với `{pid, createdAt}`).

```bash
node scripts/test-runner.mjs test/unit/state/coordination/run-lock-async-async-mutual-exclusion.test.ts
```

**Rollback:** revert phần test AC7 (và điều kiện token ở bước 3 nếu quyết định đổi).

## Bước 6 — RED→GREEN: release-on-error và cross-process (AC6, AC8)

**Lưu ý tính chất RED:** AC6/AC8 mô tả hành vi **phải giữ**, không phải lỗi đang có.
Chạy chúng **trước** khi sửa `src/` và ghi lại kết quả: kỳ vọng GREEN ở cả hai thời
điểm. Nếu chúng RED trước fix, đó là phát hiện mới — dừng và báo leader.

**Tạo:** `test/unit/state/coordination/run-lock-release-error.test.ts` (AC6)

- `fn()` ném ⇒ lỗi propagate nguyên vẹn tới caller; acquire kế tiếp thành công
  trong deadline; lock file không còn sau khi nhả.

**Sửa (extend):** cùng file, AC8 — child process thật:

- Spawn một `node --experimental-strip-types -e ...` (hoặc `spawn` với script tạm)
  giữ lock; process cha gọi `withRunLock` **với `staleMs` mặc định (30 s)** ⇒ nhận
  lỗi `locked`.
- **Cảnh báo về `staleMs`:** không dùng `staleMs` nhỏ cho test này. Lock stale
  **được phép** steal (`canSteal: isStale || ...`), nên `staleMs` nhỏ sẽ khiến cha
  steal thành công và test trở nên vô nghĩa. Muốn kiểm nhánh stale thì tạo fixture
  `createdAt` cũ (AC7), không hạ `staleMs`.
- Sau khi child thoát (và lock được nhả), acquire thành công.
- Tiền lệ: `test/unit/state/coordination/locks-race.test.ts` và
  `state-helpers-cas-contention.test.ts` (spawn child process thật, tight-loop
  atomic rewrite) — dùng cùng cách dựng, không dùng mock.

```bash
node scripts/test-runner.mjs test/unit/state/coordination/run-lock-release-error.test.ts
```

**Rollback:** xoá file test mới.

## Bước 7 — AC9: canary cho CI flake gốc

**Sửa (extend):** `test/unit/state/coordination/run-lock-release-error.test.ts`

- Vòng lặp N (ví dụ 50) acquire **tuần tự** `withRunLock` trên cùng manifest; tất
  cả phải thành công, không lần nào ném `locked`. Đây là bất biến chống hồi quy cho
  lý do tồn tại của `treatOwnPidAsStealable`
  (`:378-382`: "the previous releaseOwnLock leaves a microsecond window where the
  file still exists with our own pid").
- Nếu test này fail ⇒ **không** nới lại điều kiện steal; thay vào đó sửa cửa sổ
  release (ví dụ `releaseOwnLock` retry `rmSync` một lần, hoặc xoá file trước khi
  thoát `lockCtx.run`) và ghi lại phát hiện này. Báo leader trước khi đổi hướng.

```bash
node scripts/test-runner.mjs test/unit/state/coordination/run-lock-release-error.test.ts
```

**Rollback:** revert phần test AC9 + thay đổi cửa sổ release.

## Bước 8 — AC10: danh tính holder quan sát được + không rò tập token

**Sửa (extend):** file test async↔async — đọc lock file từ trong critical section
của từng context, so sánh token của A và B **khác nhau**, và assert release của A
không xoá lock đang thuộc B (đã phủ một phần ở AC5; AC10 bổ sung phần token).

**Sửa (extend):** `test/unit/state/coordination/run-lock-release-error.test.ts` —
assert **không rò** `runLockHeldTokens`: sau một chuỗi acquire thành công **và** sau
một lần `fn()` ném, tập phải rỗng. Nếu module-private không đọc được từ test, dùng
proxy quan sát được: sau chuỗi acquire, tạo lock file giả với `pid` của chính process
và `createdAt` **cũ** ⇒ vẫn phải steal được (chứng minh không có token nào bị kẹt
làm chặn nhầm).

```bash
node scripts/test-runner.mjs test/unit/state/coordination/run-lock-async-async-mutual-exclusion.test.ts
```

**Rollback:** revert phần test AC10.

## Bước 9 — Dọn comment lỗi thời ở caller

**Sửa:** `src/runtime/task-runner/post-execution.ts:619` — comment còn tham chiếu
`runLockHeldByUs`, biến không còn tồn tại trong source (verification §6.5). Đổi
thành mô tả đúng cơ chế hiện tại (`lockCtx` per-async-context). Thuần comment,
không đổi hành vi; giữ khối `withRunLock` ở `:626-629` nguyên vẹn.

```bash
npm run typecheck
node scripts/test-runner.mjs test/unit/runtime/task-runner/post-execution-surface-lost.test.ts
```

**Rollback:** revert riêng thay đổi comment.

## Bước 10 — Harness delta

| File | Thay đổi |
|---|---|
| `docs/decisions/2026-09-XX-run-lock-async-context-ownership.md` | Tạo từ stub ở `design.md` §9 |
| `docs/decisions/README.md` | Thêm hàng index |
| `docs/TEST_MATRIX.md` | Thêm hàng RR-011 |
| `docs/stories/README.md` | Thêm RR-011 vào Active |
| `CHANGELOG.md` | Ghi thay đổi hành vi (context khác trong cùng process không còn steal lock) |

```bash
npm run check:decision-drift
npm run check:conflict-markers
```

**Lưu ý:** không thêm env var ⇒ **không** chạm `check:env-vars`; không thêm event
type ⇒ **không** chạm `check:event-types`; không thêm import động ⇒ không chạm
`check:lazy-imports`. Nếu quá trình implement phát sinh một trong ba, chạy gate
tương ứng và ghi vào `validation.md`.

## Bước 11 — Bundle + đóng story

```bash
npm run build:bundle && npm run test:bundle
npm run check:bundle-staleness
```

`dist/index.mjs` là bundle mặc định (từ v0.9.17) — sửa `src/` không có hiệu lực
trong session Pi thật cho tới khi rebuild + cold-start (plan §4; `.crew/knowledge.md`).

## Thứ tự rollback

| Điểm | Phạm vi | Cách lùi |
|---|---|---|
| R0 | toàn bộ story | `git checkout -- .` về HEAD ghi ở bước 0 |
| R1 | điều kiện steal mới (bước 3, phần `readLockSnapshot`) | revert riêng; giữ `releaseOwnLock` so token (một nửa fix, vẫn tốt hơn hiện tại) |
| R2 | `releaseOwnLock` so token | revert riêng; giữ điều kiện steal (vẫn đảm bảo AC1, nhưng release vẫn có thể xoá lock của holder khác) |
| R3 | AC9 (bước 7) | revert test + thay đổi cửa sổ release; **không** revert điều kiện steal |
| R4 | comment ở caller (bước 9) | revert comment |

Mỗi bước một commit riêng (conventional commits: `fix:` cho `src/`, `test:` cho
test, `docs:` cho harness).

## Ghi chú triển khai

- **Không sửa họ file lock** (`withFileLockSync` / `withFileLockAsync`) — đã có
  ST-3-FIX/ST-14; chỉ dùng làm non-regression.
- **Không gộp RR-014** (semaphore abort) vào PR này.
- **`lockCtx` KHÔNG đổi kiểu** trong hướng đã chọn (§4.2 dùng tập token riêng).
  Nếu implement lại thấy cần đổi `lockCtx` thành `Map`, làm thành bước riêng và
  chạy lại toàn bộ `test/unit/state/coordination/` sau đó:

```bash
node scripts/test-runner.mjs test/unit/state/coordination/api-locks.test.ts test/unit/state/coordination/lock-suffix-collision.test.ts test/unit/state/coordination/locks-race.test.ts test/unit/state/coordination/locks-untested.test.ts test/unit/state/coordination/locks-reentrance-async-context.test.ts test/unit/state/coordination/locks-async-async-mutual-exclusion.test.ts
```

  (Chạy từng nhóm nhỏ, không chạy cả thư mục trong một lệnh — runner có thể crash
  khi chạy cả directory từ trong worker; xem `.crew/knowledge.md`.)
- **Không chạy full suite trong vòng lặp RED→GREEN** (quá chậm); dùng `targeted`.
