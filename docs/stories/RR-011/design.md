# RR-011 — Design: quyền sở hữu run lock theo async context (F02)

- **Lane:** high-risk
- **Status:** planned (design đề xuất — chưa triển khai)
- **Nguồn số dòng:** `docs/archive/2026-09-17-pi-crew-review-verification.md` §4 F02
  (xác minh tại commit `0b9fa771`). Số dòng lấy nguyên từ báo cáo xác minh; khi
  source trôi, dùng tên hàm thay vì số dòng.

## 1. Khiếm khuyết chính xác

### 1.1 Quyết định steal nhận cờ "PID của mình thì steal được" — `src/state/coordination/locks.ts:154-157`

```ts
154: const isOurOwnHolder = holderPid === process.pid;
156: canSteal: isStale || !isAlive || (treatOwnPidAsStealable && isOurOwnHolder),
```

`readLockSnapshot` là điểm quyết định duy nhất cho việc phá lock (Round 26 BUG 1
gộp hai lần đọc thành một snapshot để đóng cửa sổ TOCTOU stale→fresh). Cờ
`treatOwnPidAsStealable` được thêm vào để một lần acquire mới có thể phá "xác lock"
do lần acquire trước trong **cùng process** để lại.

Vấn đề: `holderPid === process.pid` **không** phân biệt được

- (a) xác lock của một acquisition đã kết thúc nhưng file chưa kịp xoá — trường hợp
  cờ được thiết kế cho; và
- (b) lock **đang được giữ** bởi một async context khác trong cùng process, hiện
  đang `await` bên trong critical section.

Trong cả hai trường hợp, biểu thức cho cùng kết quả `canSteal === true`.

### 1.2 Async path truyền `true`, sync path truyền `false`

Async — `:378-384` (cờ) và `:390` (xoá lock):

```ts
378: // FIX (CI flake): treatOwnPidAsStealable=true for the run-lock async path
379: // (withRunLock). Between acquisitions in parallel-research scaffold mode,
380: // the previous releaseOwnLock leaves a microsecond window where the
381: // file still exists with our own pid. Stealing it avoids spurious 'locked'
382: // errors. The sync file-lock path (withFileLockSync) above uses false to
383: // preserve the multi-process safety guarantee.
384: const { canSteal } = readLockSnapshot(filePath, staleMs, { treatOwnPidAsStealable: true });
...
390: fs.rmSync(filePath, { force: true });     // phá lock của holder còn sống
```

Sync — `:341-343`: cùng hình dạng nhưng `treatOwnPidAsStealable: false`.

Đây là toàn bộ khác biệt giữa hai nhánh, và nó giải thích chính xác phạm vi lỗi
(§3): nhánh sync không steal được lock của chính mình, nên **async↔async** là tổ
hợp duy nhất được xác minh là vỡ. Chiều sync-giữ/async-gọi không nằm trong bằng
chứng xác minh — xem ghi chú ở §3.

### 1.3 Re-entrance theo AsyncLocalStorage không chặn nhánh này

`withRunLock` kiểm tra `lockCtx.getStore()?.has(filePath)` **trước**
khi acquire. Hai async context **độc lập** có store khác nhau, nên cả hai đều thấy
"chưa giữ" và cùng đi vào `acquireLockWithRetryAsync`. Guard re-entrance đúng theo
thiết kế (H-1: "a call from a DIFFERENT async context does NOT bypass") — nhưng nó
chỉ ngăn **bypass**, không ngăn **steal**. Hai cơ chế khác nhau, và lỗ hổng nằm ở
cơ chế thứ hai.

### 1.4 Release theo PID không phân biệt holder — `:268-272`

```ts
258: export function releaseOwnLock(filePath: string, _token: string): void {
...
268:   const raw = fs.readFileSync(filePath, "utf-8");
269:   const holderPid = (JSON.parse(raw) as { pid?: unknown })?.pid;
270:   if (holderPid === process.pid) {
271:     fs.rmSync(filePath, { force: true });
272:   }
```

Tham số `token` bị đánh dấu `_token` — **không dùng**. Trong cùng process, mọi
holder đều có `pid === process.pid`, nên release của A xoá lock của B. Probe 2 của
xác minh quan sát đúng hệ quả:

```text
token f0b30705 → 2fa28d60 khi A còn giữ lock
sau khi A thoát trước: lock file ENOENT trong khi B vẫn trong critical section
```

Comment ở `:272` ("holderPid !== process.pid → lock stolen by another process; do
NOT touch") cho thấy mô hình trong đầu người viết là **liên process**. Mô hình đó
đúng cho họ file lock (`releaseLock` — hàm riêng, so token qua
`readLockToken` + `timingSafeTokenMatch`), nhưng sai cho run lock trong process đa
async context.

### 1.5 Caller thật trên đường production

`src/runtime/task-runner/post-execution.ts:626-629`:

```ts
626: tasks = await withRunLock(manifest, async () => {
627:   await saveRunManifestAsync(manifest);
628:   return persistSingleTaskUpdate(manifest, tasks, task, undefined, true);
629: });
```

Critical section chứa **hai** `await` (ghi manifest, rồi persist task). Trong cửa
sổ đó, một async context khác (ví dụ vòng merge batch của team-runner, hoặc một
task khác kết thúc cùng lúc) gọi `withRunLock` cho cùng run sẽ thấy
`holderPid === process.pid` → steal → cả hai vào critical section. Comment ngay
trên khối này nói rõ ý định: "persist manifest + tasks atomically under the run
lock. Without this, the unlocked saveRunManifest here races with the
team-runner batch merge path" — tức cơ chế được viết ra **để** chặn đúng kiểu
chồng lấn mà nó đang không chặn được.

**Comment cũ đã lỗi thời:** xác minh §6.5 ghi `post-execution.ts:619` còn tham
chiếu biến `runLockHeldByUs`, biến này không còn tồn tại trong source. Sửa kèm
trong story này (thuần comment).

## 2. Vì sao các guard hiện tại không chặn được

| Guard hiện có | Vì sao không đủ |
|---|---|
| ALS re-entrance (`lockCtx`) | Phân biệt "cùng context" vs "khác context", nhưng chỉ dùng để **bypass**. Khác context ⇒ đi acquire bình thường ⇒ rơi vào nhánh steal |
| `isStale` | Lock mới (fresh) nên không stale |
| `!isAlive` | Holder là chính process ⇒ `process.kill(pid, 0)` thành công ⇒ `isAlive = true` |
| `treatOwnPidAsStealable` | Cố ý bỏ qua hai guard trên khi PID trùng — chính là lỗ hổng |
| `releaseOwnLock` | So PID, mà PID trùng trong cùng process ⇒ không phân biệt |
| `O_EXCL` (`writeLockFile`) | Chỉ ngăn **tạo** khi file tồn tại; nhánh steal đã `rmSync` file trước đó nên `O_EXCL` không bao giờ thấy chướng ngại |
| Test hiện có | Phủ sync↔async và async↔async-cho-**file lock**, không phủ async↔async-cho-**run lock** (§3) |

Gốc rễ: cơ chế lock đang dùng **PID** làm danh tính holder, nhưng đơn vị loại trừ
cần bảo vệ là **async context**, không phải process. Khi hai khái niệm không trùng
nhau, mọi quyết định dựa trên PID đều sai theo một hướng.

## 3. Phạm vi chính xác (đừng sửa quá tay)

| Tổ hợp | Hiện tại | Sau fix |
|---|---|---|
| sync↔sync | đúng | đúng (không đổi) |
| sync↔async (async giữ, sync gọi) | đúng | đúng (không đổi) |
| sync↔async (sync giữ, async gọi) | **chưa xác minh** — xem ghi chú dưới bảng | cần đo trước |
| async↔async | **VỠ** | đúng |
| cross-process | đúng (stale/dead steal) | đúng (không đổi) |

Lý do sync↔sync đúng: nhánh sync dùng `treatOwnPidAsStealable: false`, nên một
acquisition sync thứ hai gặp lock fresh do chính process mình tạo sẽ **không** steal
mà retry tới deadline rồi ném `locked`. Hành vi đó đúng về loại trừ (dù là fail
thay vì chờ — chấp nhận được vì critical section sync rất ngắn).

Lý do sync↔async đúng: async holder còn sống, sync caller thấy `canSteal === false`
⇒ ném `locked` ⇒ không chồng lấn.

**Chiều còn lại chưa được xác minh bằng probe (suy luận từ mã — cần test để xác nhận):**
xác minh C2 kết luận sync↔async đúng dựa trên test hiện có
`round30-h1-run-lock-async-context.test.ts` (`:89,163`), và test đó chỉ phủ
**async-holder + sync-caller**. Chiều ngược lại (**sync-holder + async-caller**)
không nằm trong bằng chứng xác minh.

Lập luận từ mã: `withRunLockSync` chạy **đồng bộ** và không nhường event loop,
nên trong cùng thread không có continuation async nào chạy xen vào thân nó được —
nghĩa là chiều sync-giữ/async-gọi **không thể** chồng lấn trong cùng process, bất
kể nhánh steal. Đây là suy luận từ cấu trúc mã, **chưa** được probe xác nhận. Bổ
sung một test cho chiều này ở bước 4 của `exec-plan.md` và ghi kết quả đo được vào
`validation.md`. Nếu suy luận sai và chiều này cũng vỡ thì phạm vi F02 rộng hơn C2
mô tả, và hướng sửa ở §4.2 (danh tính theo token) phủ cả hai chiều — nhưng **phải
báo leader** vì điều đó nghĩa là báo cáo xác minh cần chỉnh.

⇒ **Chỉ sửa nhánh async.**

## 4. Hướng sửa được chọn

### 4.1 Nguyên tắc

Loại trừ phải phân biệt được **holder còn sống** với **xác lock còn sót**, và
không được dùng `process.pid` làm danh tính holder: trong một process, mọi holder
đều có cùng PID. Release cũng phải kiểm tra danh tính đó, không chỉ PID.

### 4.2 Điều kiện steal: hỏi "token này có đang được giữ sống trong process không"

Điểm mấu chốt cần phân biệt là **holder còn sống** hay là **xác lock còn sót**, và
câu hỏi đó không thể trả lời bằng cách so token trên đĩa với token của chính mình:
token của một acquisition mới là một `randomUUID()` **mới**, nên nó luôn khác token
của holder đang sống — so sánh kiểu đó vẫn steal được lock của holder sống (tức vẫn
giữ nguyên bug). Cần một tập **token đang được giữ sống trong process**.

Cách làm:

- Thêm module-private `const runLockHeldTokens = new Set<string>()` — process-global,
  **chỉ** trả lời câu hỏi "token này có acquisition nào trong process đang giữ
  không". Đây **không** phải trạng thái re-entrance: re-entrance vẫn do `lockCtx`
  (per-async-context) quyết định, giữ nguyên. Tiền lệ trong cùng file:
  `fileLockHeldByUs` cũng process-global và comment tại chỗ ghi rõ lý do — "it
  tracks actual on-disk holds, not re-entrance".
- `withRunLock` / `withRunLockSync`: sau khi acquire được `token`, thêm
  `runLockHeldTokens.add(token)`; trong `finally`, `runLockHeldTokens.delete(token)`
  **trước** khi gọi `releaseOwnLock(filePath, token)`.
- `readLockSnapshot` nhận thêm một nguồn tra cứu (ví dụ option
  `activeHolderTokens?: ReadonlySet<string>`), và điều kiện steal thành:

```ts
	// Steal theo own-PID CHỈ khi lock không thuộc một acquisition còn sống trong
	// process này. holderToken vắng/không parse được ⇒ không nằm trong tập sống ⇒
	// VẪN steal (giữ hành vi chống CI flake cho lock file cũ không có `token`).
	const holderIsLiveInProcess = holderToken !== undefined && (activeHolderTokens?.has(holderToken) ?? false);
	const ownPidStealable = treatOwnPidAsStealable && isOurOwnHolder && !holderIsLiveInProcess;
	return { canSteal: isStale || !isAlive || ownPidStealable };
```

  Phân biệt đúng hai tình huống mà PID không phân biệt được:
  - holder sống (context khác, cùng process) ⇒ token **có** trong tập ⇒ không steal.
  - xác lock của acquisition đã kết thúc ⇒ token **không** có trong tập ⇒ steal
    (giữ nguyên hành vi chống CI flake mà cờ sinh ra để giải quyết).
- `releaseOwnLock(filePath, token)` dùng token: chỉ `rmSync` khi token trong file
  khớp token của mình (đối chiếu `releaseLock` đã làm đúng cho họ file lock). Khi
  file không đọc được hoặc token không khớp ⇒ **không** xoá.
- **Không cần đổi `lockCtx` thành `Map`** trong hướng này — `Set<string>` giữ
  nguyên. (Nếu vẫn muốn mang holderId trong ALS vì lý do khác, đó là thay đổi tuỳ
  chọn, không bắt buộc cho AC1.)

**Biến thể SAI — ghi lại làm dấu cảnh báo:** so `holderToken` (trên đĩa) với
`ourHolderId` (token của lần acquire hiện tại) và steal khi hai giá trị khác nhau.
Cách này **không** phân biệt holder sống với xác lock: token mỗi lần acquire là
`randomUUID()` mới, nên token của holder sống **luôn** khác token hiện tại ⇒ điều
kiện luôn đúng ⇒ vẫn steal ⇒ bug không được sửa. Đây là biến thể dễ nhầm nhất của
"dùng token làm danh tính"; chỉ đúng khi tra vào **tập token đang sống** như trên.

**Rủi ro cần kiểm khi implement:** `runLockHeldTokens` là trạng thái process-global
mới. Nếu một acquisition rò rỉ (không chạy `finally`), token ở lại tập mãi và lock
đó trở thành không-steal-được cho tới `staleMs` — chấp nhận được (fail-closed),
nhưng phải đảm bảo `finally` luôn chạy (cả hai hàm đã dùng `try/finally`). Cần một
test khẳng định tập rỗng sau acquire thành công + thất bại (xem AC10).

### 4.3 Bỏ hẳn `treatOwnPidAsStealable` (phương án thay thế, không phải mặc định)

Nếu có thể chứng minh kịch bản CI flake gốc (parallel-research scaffold mode:
"previous `releaseOwnLock` leaves a microsecond window where the file still exists
with our own pid") **không còn** sau khi `releaseOwnLock` so token, thì cờ này
không còn lý do tồn tại và nên bị xoá khỏi nhánh async. Xác suất cao là còn: cửa sổ
đó là giữa `rmSync` của holder trước và `O_EXCL` của holder sau — nằm **trong cùng
context tuần tự**, nên `lockCtx` sẽ không giúp. Đó là lý do AC9 tồn tại: đo trước,
quyết định sau. Nếu cờ vẫn cần, nó phải mang thêm điều kiện token (§4.2).

### 4.4 Chờ thay vì ném khi bị giữ bởi context khác trong cùng process (tuỳ chọn, cần duyệt riêng)

Hiện tại nhánh "không steal được" **ném ngay** `Run '<name>' is locked by another
operation.` — đúng cho liên process (deadline là staleMs), nhưng trong cùng process
holder sẽ nhả sau vài mili-giây, và ném ngay biến một tranh chấp bình thường thành
lỗi. Cân nhắc: retry với `await sleep(delay)` tới deadline (đã có hạ tầng trong
vòng lặp) rồi mới ném. **Đây là thay đổi hành vi** (caller hiện nhận lỗi ngay) nên
phải được phê duyệt cùng story; nếu không được duyệt, giữ nguyên hành vi ném và
chỉ đảm bảo tính đúng (không chồng lấn) — an toàn hơn cho phạm vi.

### 4.5 Không dùng cách chờ đồng bộ

Review F02 nói rõ: "Không dùng sync sleep để chờ holder đang cần event loop của
cùng process." Vòng retry async đã dùng `await sleep(delay)` — giữ nguyên.

## 5. Phương án bị loại

| Phương án | Vì sao loại |
|---|---|
| **So token trên đĩa với token của lần acquire hiện tại** (`holderToken !== ourToken` ⇒ steal) | **Sai** — token mỗi lần acquire là `randomUUID()` mới nên luôn khác token của holder đang sống ⇒ vẫn steal ⇒ **không sửa được bug**. Biến thể dễ nhầm nhất của "dùng token làm danh tính"; xem cảnh báo ở §4.2 |
| **Dùng trạng thái process-global để quyết định re-entrance** (quay lại `runLockHeldByUs` kiểu Map toàn cục) | Đúng là bug lớp H-1 — đã sửa bằng `lockCtx` per-context. **Không** nhầm với §4.2: tập token đang sống chỉ trả lời "holder có còn sống không", không tham gia quyết định bypass re-entrance |
| **Queue theo run bằng một Map<runPath, Promise> trong process** | Giải được async↔async nhưng **không** giải cross-process (hai process vẫn chồng lấn), và tạo tầng loại trừ thứ hai song song với lock file ⇒ hai nguồn sự thật. Họ file lock đã đi con đường này (`fileAsyncLocks`) và cần thêm on-disk tier (ST-3) vì lý do đó |
| **Đổi danh tính holder sang `process.pid + threadId`/`worker_threads.threadId`** | Không giúp: hai async context cùng nằm trên một thread |
| **Bỏ nhánh steal hoàn toàn (luôn ném khi bị giữ)** | Cross-process dead-holder recovery biến mất: một process chết để lại lock file sẽ chặn run cho tới khi hết `staleMs` — chấp nhận được, nhưng AC7 yêu cầu giữ steal cho holder chết/stale; bỏ hết là hồi quy chức năng |
| **`fs.watch`/inotify trên lock file để chờ** | Thêm phụ thuộc nền tảng (inotify không có trên Windows), độ trễ không xác định; không cần thiết vì retry loop đã đủ |
| **Dùng flock(2)/LockFileEx qua native module** | Thêm dependency native; `docs/decisions/2026-08-15-lock-family-unification.md` đã chốt giữ mô hình `O_EXCL` + token theo họ; đổi primitive là ADR riêng, không thuộc F02 |
| **Chỉ sửa `releaseOwnLock` (so token) mà không sửa nhánh steal** | Không đủ: AC1 đòi `maxActive === 1`; nếu vẫn steal được thì hai holder vẫn vào critical section, chỉ là hậu quả release khác đi |

## 6. Ảnh hưởng dữ liệu và trạng thái

- **Không đổi định dạng lock file.** Payload hiện đã có `token`
  (`writeLockFile` ghi `{ kind, pid, createdAt, token }`), nên chỉ cần **đọc** nó
  trong `readLockSnapshot` (hiện chỉ đọc `pid` và `createdAt`).
- **Không đổi schema state** (`manifest.json`, `tasks.json`, `events.jsonl`).
- **Trạng thái process-global mới:** `runLockHeldTokens: Set<string>` — chỉ chứa
  token đang giữ sống. Nó **không** phải trạng thái re-entrance (`lockCtx` giữ vai
  đó) và **không** đổi kiểu `lockCtx`. Kích thước tập bị chặn bởi số acquisition
  đang đồng thời, và mọi entry được xoá trong `finally`.
- **Hành vi runtime đổi:** một acquisition thứ hai từ context khác trong cùng
  process sẽ không còn vào critical section. Nếu caller đang **dựa** vào việc chồng
  lấn (không nên có, nhưng phải grep để chắc), đó là bug của caller.
- **Tăng khả năng gặp lỗi `locked`:** nếu có caller nào vô tình acquire lồng từ
  context khác và hiện đang "may mắn" nhờ steal, sau fix nó sẽ ném. Xem §4.4 —
  chọn chờ-tới-deadline hay ném-ngay là quyết định phải chốt trước khi implement.
- **Không thêm event type** ⇒ không chạm `check:event-types`. Không thêm env var ⇒
  không chạm `check:env-vars`.

## 7. Backward compatibility

| Bề mặt | Tác động | Xử lý |
|---|---|---|
| Payload `run.lock` | Không đổi | Đọc thêm trường `token` đã tồn tại |
| `releaseOwnLock(filePath, _token)` | Chữ ký không đổi (đổi `_token` → `token`) | Call-site trong `withRunLock` / `withRunLockSync` đã truyền token; không cần sửa caller ngoài |
| `readLockSnapshot` | Thêm trường trong options object (additive) | Chỉ gọi nội bộ trong file |
| `lockCtx` | **Không đổi** (`Set<string>`) | Re-entrance giữ nguyên |
| `runLockHeldTokens` | Trạng thái module-private mới | Không export; cần test khẳng định rỗng sau acquire thành công/thất bại |
| Hành vi sync↔sync / sync↔async | Không đổi | Test `round30-h1-run-lock-async-context.test.ts` phải pass nguyên trạng (AC4) |
| Hành vi cross-process | Không đổi | AC7/AC8 |
| Hành vi async↔async | **Đổi** (đây là fix) | Test mới; ghi CHANGELOG |
| Caller hiện phụ thuộc steal | Có thể vỡ | Grep `withRunLock(` trong `src/` trước khi implement; nếu có call-site lồng từ context khác, xử lý ở §4.4 |
| Windows | Nhánh contention `EPERM`/`EBUSY` (`isLockContention`) không đổi | Giữ nguyên; AC8 chạy trên cả ba OS |

## 8. Cân nhắc bảo mật

- **Giữ mode `0o600`** của lock file (`writeLockFile` dùng `O_CREAT|O_EXCL` với
  `0o600`) — không đổi.
- **Giữ guard symlink** ở cả ba chỗ: `writeLockFile` (từ chối ghi đè symlink),
  `releaseOwnLock` (`lstatSync().isSymbolicLink()` ⇒ return), `releaseLock` (không
  xoá symlink). Mọi thay đổi release phải giữ các guard này; test bảo vệ symlink
  hiện có không được nới.
- **Token là ownership marker, không phải secret.** So sánh bằng `===` là đủ;
  `releaseLock` dùng `timingSafeTokenMatch` vì token đi kèm đường mạng trong một số
  luồng — với run lock nội bộ, ADR lock-family đã kết luận tương tự cho agents-record
  lock ("the token is an ownership marker, not a secret"). Giữ nhất quán với
  `releaseOwnLock` hiện tại (so sánh trực tiếp) trừ khi có lý do khác.
- **Không nới điều kiện steal cho trường hợp không xác định.** Nếu không đọc được
  payload (lỗi I/O transient), `readLockSnapshot` hiện trả `{ canSteal: false }`
  (conservative) — giữ nguyên. Nếu **parse token** lỗi hoặc token vắng, coi như
  "không nằm trong tập đang giữ" ⇒ nhánh own-PID **vẫn steal**. Đây là lựa chọn có
  chủ đích: payload không có `token` là lock file cũ (bản trước ghi `{pid,
  createdAt}`), và giữ steal cho nó bảo toàn hành vi chống CI flake hiện tại. Rủi
  ro kèm theo: nếu kẻ tấn công/tiến trình khác ghi được một lock file cùng PID mà
  không có `token`, nó vẫn stealable — nhưng điều đó cũng đúng trước fix, và ghi
  được `stateRoot/run.lock` đã đòi quyền ghi vào state của run.
  (Nếu leader muốn fail-closed tuyệt đối ở đây, đó là lựa chọn **khác** và phải
  được ghi rõ trong decision record — đừng đổi ngầm.)
- **Rủi ro DoS cục bộ:** sau fix, một context "quên" nhả lock sẽ chặn context khác
  cho tới `staleMs`. Đây là hành vi mong muốn (đúng hơn là để hai writer chồng
  lấn), và bị chặn bởi stale deadline sẵn có.
- **Không mở bề mặt mới:** không thêm thao tác git/shell, không thêm input người
  dùng, không thêm file ngoài `stateRoot/run.lock`.

## 9. Decision record stub (tạo lúc implement)

Đường dẫn đề xuất: `docs/decisions/2026-09-XX-run-lock-async-context-ownership.md`.

```markdown
# Run lock ownership: exclude async contexts, not just PIDs

Date: YYYY-MM-DD
Status: Proposed | Accepted
Relates to: RR-011 (F02), src/state/coordination/locks.ts,
            docs/decisions/2026-08-15-lock-family-unification.md

## Context

withRunLock's async acquire passed `treatOwnPidAsStealable: true` to
readLockSnapshot. The steal predicate keyed on `holderPid === process.pid`, which
cannot distinguish (a) a leftover lock file from a finished acquisition in this
process from (b) a lock CURRENTLY HELD by another async context of the same
process that is awaiting inside its critical section. Two independent async
contexts therefore both entered the critical section (probe: maxActive = 2), and
releaseOwnLock's PID comparison could not tell the holders apart (probe: lock file
ENOENT while the second holder was still inside). The real caller is
src/runtime/task-runner/post-execution.ts:626-629.

Scope correction (verification C2): mutual exclusion holds for sync↔sync and
sync↔async; ONLY async↔async is verified broken. The sync path passes
treatOwnPidAsStealable: false. The existing async↔async test covers
withFileLockAsync, not withRunLock — the broken combination had no test.
(Verification covers async-holder + sync-caller only; sync-holder + async-caller
was not probed and is asserted here only from code structure.)

## Decision

- A process-global `runLockHeldTokens: Set<string>` records the token of every run
  lock acquisition that is CURRENTLY HELD in this process (added after acquire,
  deleted in `finally` before release). It answers "is this holder alive?" and
  NOTHING else.
- The own-PID steal branch becomes: steal only when the stored token is NOT in
  `runLockHeldTokens`. A missing/unparseable token counts as "not held" → steal
  (preserving the original anti-CI-flake behaviour).
- `releaseOwnLock` deletes the lock only when the stored token matches ours.
- Re-entrance stays where it is: `lockCtx` (AsyncLocalStorage, per async context).
  `lockCtx` keeps its `Set<string>` shape; the new set does not participate in
  bypass decisions.
- The on-disk lock format is UNCHANGED (`{kind, pid, createdAt, token}`).
- [decide at implementation] whether a same-process contention retries until the
  stale deadline instead of throwing immediately.

## Alternatives Considered

1. Compare the on-disk token against the CURRENT acquisition's token and steal
   when they differ — REJECTED, and recorded as a trap: each acquisition mints a
   fresh randomUUID, so a live holder's token ALWAYS differs from ours and the
   predicate would steal anyway. This looks like "use the token as identity" but
   fixes nothing.
2. Reuse a process-global map for RE-ENTRANCE decisions — rejected: that is
   exactly the H-1 bug class already fixed by `lockCtx`. The new set must not be
   consulted for bypass.
3. In-process per-run promise queue only — rejected: does not serialize
   cross-process, and creates a second source of truth (the file lock family
   needed an on-disk tier for exactly this reason, ST-3).
4. Identify holders by threadId — rejected: async contexts share a thread.
5. Drop the steal branch entirely — rejected: dead-holder recovery across
   processes regresses (AC7).
6. Fix releaseOwnLock only — rejected: two holders would still enter the critical
   section (AC1 requires maxActive === 1).

## Consequences

Positive:
- At most one independent async holder per run (AC1), no lost updates (AC2).
- Token-guarded release means a finishing context cannot delete another holder's
  lock.

Tradeoffs:
- A context that fails to release blocks other contexts until the stale deadline
  (30s default). Correct, but a latency regression in the failure case.
- A leaked `finally` leaves the token in `runLockHeldTokens` forever, making that
  lock un-stealable until the stale deadline. Fail-closed, but it is new global
  state that must be exercised by a test (set is empty after success AND after
  failure).
- A second acquisition from a different async context may now surface a `locked`
  error where it previously "succeeded" by stealing. Callers relying on that
  overlap were relying on a data-loss bug.
- The own-PID steal path becomes stricter; if the original CI flake (parallel-
  research scaffold mode) returns, it must be solved by fixing the release window,
  not by widening the steal predicate.
```

## 10. Tham chiếu

- `docs/stories/RR-011/overview.md` — AC, risk flags, out of scope
- `docs/stories/RR-011/exec-plan.md` — thứ tự RED→GREEN
- `docs/stories/RR-011/validation.md` — thang kiểm chứng
- Code: `src/state/coordination/locks.ts`; `src/runtime/task-runner/post-execution.ts:619,626-629`
- ADR: `docs/decisions/2026-08-15-lock-family-unification.md` (bảng họ lock, quyết định α)
- Xác minh: `docs/archive/2026-09-17-pi-crew-review-verification.md` §3 C2, §4 F02, §6.5, §7
- Test cùng lớp: `test/unit/round30-h1-run-lock-async-context.test.ts`,
  `test/unit/state/coordination/locks-async-async-mutual-exclusion.test.ts`,
  `test/unit/state/coordination/locks-race.test.ts`
