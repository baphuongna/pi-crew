# Review pi-crew: độ tin cậy, hiệu năng và chất lượng

## 1. Thông tin và phạm vi

| Thuộc tính | Giá trị |
|---|---|
| Ngày review | 2026-09-17 |
| Package | `pi-crew@0.11.1` |
| Commit được review | `0b9fa771` |
| Branch tại thời điểm review | `main` |
| Môi trường kiểm chứng | Linux, Node `v22.23.1` |
| Yêu cầu | Đánh giá pi-crew và đề xuất nâng cấp để cải thiện hiệu năng, chất lượng |
| Thay đổi trong lần review | Không sửa mã, cấu hình hoặc dependency |
| Trạng thái repository cuối audit, trước khi lưu báo cáo | Sạch |
| Trạng thái báo cáo | Bản ghi tại thời điểm review, không phải đặc tả triển khai đã phê duyệt |

Báo cáo này mở rộng phần tổng kết trong hội thoại, lưu cả các phát hiện
chi tiết từ ba mảng rà soát độc lập: runtime/worktree, state/I/O và
extension/UI/config. Phần kiểm chứng bổ sung xem xét test runner, CI,
benchmark và prompt của các agent.

Các đường dẫn mã nguồn dưới đây tính từ root repository `pi-crew/`.
Số dòng tham chiếu ứng với commit được review; cần kiểm tra lại khi mã thay đổi.

### Cách đọc bằng chứng

- **Tái hiện:** đã chạy fixture hoặc probe local và quan sát được hành vi.
- **Luồng mã:** đã truy vết producer, consumer và điều kiện kích hoạt, nhưng
  chưa chạy tình huống end-to-end tương ứng.
- **Quan sát đo đạc:** số đo của fixture cụ thể, không suy rộng thành cam kết
  tốc độ hoặc chất lượng của mọi workflow.
- **Đề xuất:** hướng nâng cấp cần được kiểm chứng bằng benchmark hoặc regression
  test trước khi chấp nhận.

Không chạy model thật, không gọi API LLM, không mở terminal pane thật, không
publish/push và không kiểm tra trạng thái CI từ GitHub. Các bản tái hiện dùng
thư mục tạm hoặc clone tạm; không dùng dữ liệu run thật làm đối tượng phá hủy.

## 2. Kết luận điều hành

**pi-crew có nền tảng tốt, nhưng hướng nâng cấp đáng làm nhất là sửa độ tin cậy
trước, giảm chi phí điều phối sau, rồi mới tinh chỉnh cách chia agent/model.**

Điểm đáng chú ý không phải thiếu tính năng, mà là một số hợp đồng bị đứt ở
ranh giới giữa các thành phần:

1. Snapshot không đầy đủ vẫn được coi là đủ an toàn để xóa dữ liệu worktree.
2. Run lock không loại trừ được hai async context độc lập cùng process.
3. Cwd dùng khi delegate không khớp cwd dùng để kiểm tra isolation.
4. Tín hiệu mất surface bị bỏ trên đường truyền kết quả.
5. Test runner có thể trả thành công khi coordinator chết trước khi có kết quả.

Không nên tăng concurrency hoặc bỏ bớt durability để bù hiệu năng trước khi
giải quyết các vấn đề này.

### Phân loại các phát hiện được lưu

| Mức độ | Số mục | Ý nghĩa trong báo cáo |
|---|---:|---|
| Cao | 5 | Rủi ro dữ liệu, isolation, kết quả hoàn tất hoặc độ tin cậy CI |
| Vừa | 14 | Sai trạng thái, vòng đời, chi phí tăng theo tải hoặc thiếu kiểm chứng |
| Thấp | 1 | Lỗi trong benchmark harness chưa nằm trên đường runtime sản phẩm |

Đây là 20 mục được chọn để hành động, không phải tuyên bố đã tìm hết mọi lỗi.
Các phát hiện qua luồng mã được ghi riêng, không được trình bày như đã chạy
worker/model thật để xác nhận.

### Những điểm mạnh nên giữ

- Kiến trúc durable-first với manifest, task state, event log và artifacts.
- Scheduler đã dùng in-flight/first-settled merging, không bắt buộc đợi toàn bộ
  batch xong mới tiến tiếp.
- Worker cap tập trung; slot được trả trong `finally` khi execution thất bại.
- Nested slot tách khỏi worker slot, có nhánh fail-fast để tránh kiểu deadlock
  parent giữ slot rồi chờ child cùng pool.
- Child runtime có timeout, cancellation escalation, giới hạn output và cleanup.
- Atomic write có temp/rename, durability phân tầng và grouped directory fsync.
- Nhiều cache đã có giới hạn; dependency-result cache và batching đã tồn tại.
- Widget có signature/width cache; dashboard có snapshot resolver theo frame.
- OTLP push đã có single-flight và metric label cardinality có giới hạn.

Không nên đề xuất lại các cơ chế đã có dưới dạng “thêm cache”, “thêm batching”
hoặc “đổi scheduler sang streaming” mà không chỉ ra phần còn thiếu.

## 3. Phát hiện mức Cao

### F01 — Snapshot bị cắt nhưng worktree vẫn bị dọn

**Bằng chứng:** Tái hiện + luồng mã.

**Vị trí:**
- `src/worktree/worktree-manager.ts:685–727`
- `src/worktree/worktree-manager.ts:851–864`
- `src/worktree/worktree-manager.ts:1013–1023`

`snapshotDirtyWorktree()` giới hạn nội dung mỗi untracked file ở 256 KiB.
Khi file lớn hơn giới hạn, hàm chỉ ghi chú rằng nội dung đã bị cắt nhưng vẫn
trả `true`. Cả nhánh sync và async dùng giá trị đó để cho phép:

```ts
git(worktreePath, ["checkout", "--", "."]);
git(worktreePath, ["clean", "-fd"]);
```

**Điều kiện:** tái sử dụng task worktree đang dirty, chứa untracked file lớn
hơn 256 KiB.

**Tái hiện:** trong clone tạm, tạo file 307.200 byte, gọi lại
`prepareTaskWorkspaceAsync()`. Kết quả `reused: true`, file gốc không còn;
recovery artifact có khai báo truncation. Mã snapshot giữ tối đa 262.144 byte.
Fixture là UTF-8 nên payload nằm trong code block văn bản, không phải base64.

**Hậu quả:** phần dữ liệu sau giới hạn không thể phục hồi từ snapshot đó.
Failed tracked-diff capture và unreadable entries cũng bị bỏ qua mà không
làm snapshot thất bại. Ngoài ra, `readFileSync()` đọc cả file trước khi cắt,
nên cap hiện tại không bảo vệ khỏi allocation lớn.

**Đề xuất:**
- Tách preview dễ đọc khỏi backup đầy đủ, có thể phục hồi.
- Chỉ cho phép cleanup tự động sau khi backup hoàn chỉnh và kiểm chứng được.
- Truncation, skipped entry hoặc lỗi diff phải giữ nguyên worktree hoặc yêu cầu
  phê duyệt hành động phá hủy.
- Không dùng “đã ghi một artifact” làm bằng chứng “đã sao lưu đầy đủ”.

**Regression test:** file lớn hơn cap, binary lớn, failed read/diff; chạy cả
sync và async reuse. Khi backup không đầy đủ, bytes gốc phải còn nguyên.

**Test liên quan:** `test/integration/worktree-snapshot-dirs-binary.test.ts`,
`test/unit/worktree/worktree-async.test.ts`.

### F02 — Run lock cho hai async context độc lập cùng vào critical section

**Bằng chứng:** Tái hiện + luồng mã.

**Vị trí:** `src/state/coordination/locks.ts:145–159, 362–402, 648–674`.

Async acquisition gọi `readLockSnapshot()` với
`treatOwnPidAsStealable: true`. Vì vậy, một luồng có thể lấy lại lock chỉ vì
PID của holder trùng với PID hiện tại, dù holder còn sống và đang `await`.
Re-entrance theo AsyncLocalStorage không ngăn nhánh lấy lại lock này.
Nhả lock theo PID cũng không phân biệt hai holder cùng process.

**Tái hiện:**

```text
maxActive = 2
A-enter → B-enter → B-exit → A-exit
```

**Hậu quả:** read-modify-write đồng thời có thể mất cập nhật. Đây không chỉ
là primitive không có caller: đường post-execution sử dụng `withRunLock()`
bao quanh thao tác có `await`, tại
`src/runtime/task-runner/post-execution.ts:626–628`.

**Đề xuất:** queue theo run cho các context độc lập; chỉ re-enter khi đúng
context đang giữ lock; nhả lock bằng ownership token. Không dùng sync sleep
để chờ holder đang cần event loop của cùng process.

**Regression test:** giữ A bằng deferred promise; cho B tranh lock trước
khi thả A; assert `maxActive === 1`, B chỉ vào sau A và không mất cập nhật.
Kiểm tra thêm nested re-entrance, release-on-error và tương tác khác process.

**Test liên quan:** `test/unit/round30-h1-run-lock-async-context.test.ts`.
Test hiện có thả outer trước khi thử sync acquisition, chưa chứng minh tình
huống contention async–async của run lock.

### F03 — Delegated worker có thể chạy ngoài worktree của cha

**Bằng chứng:** Luồng mã, chưa chạy worker thật.

**Vị trí:**
- `src/runtime/broker/crew-broker.ts:1397–1398, 1457–1464, 1548–1601`
- `src/runtime/delegate-spawn.ts:114–120`
- `src/runtime/task-runner/pre-execution.ts:143–149`

Broker kiểm tra overlap và ghi shadow task theo `task.cwd`, nhưng truyền
`cwd` của broker sang grandchild spawner. `spawnDelegateGrandchild()` dùng
trực tiếp `input.cwd` để gọi `runChildPi()`.

**Điều kiện:** parent task đã được đưa vào worktree riêng rồi gọi delegate.

**Hậu quả:** grandchild có thể đọc checkout khác; nếu được cấp role executor,
nó có thể sửa leader workspace thay vì worktree đã được admission kiểm tra.

**Đề xuất:** trả authoritative execution cwd từ kết quả admission và truyền
đúng cwd đó sang spawner. Giữ broker/root cwd riêng cho manifest lookup và
artifact ownership, không đổi một biến dùng chung một cách cơ học.

**Regression test:** broker cwd và parent cwd khác nhau; injected spawner
phải nhận parent worktree. Không cần gọi model để kiểm tra.

**Test liên quan:** `test/unit/runtime/broker/delegate-broker.test.ts:269–333`.
Test hiện bắt spawn arguments nhưng kiểm tra depth, không kiểm tra cwd khác nhau.

### F04 — `surfaceLost` bị bỏ trước finalizer, làm sai recovery

**Bằng chứng:** Luồng mã, chưa chạy tình huống mất pane thật.

**Vị trí:**
- `src/runtime/task-runner/child-executor.ts:796–822`
- `src/runtime/task-runner.ts:140–153, 208–221`
- `src/runtime/task-runner/post-execution.ts:148–179`
- `src/runtime/surface/degrade.ts:516–523`

Child executor trả `surfaceLost`, nhưng task-runner sao chép thủ công các field
và không chuyển field này sang `finalizeTaskResult()`.

**Hậu quả:** dedicated `needs_attention` terminalization không chạy. Với
non-strict/read-only settings, task có thể thành `completed` dù không có result;
guard khác có thể làm nó thành failure thông thường. Headless redeploy chỉ
nhận `running` hoặc `needs_attention`, nên bỏ qua cả hai trạng thái trên.

**Đề xuất:** bảo toàn result qua branch boundary, ưu tiên shared discriminated
result type thay vì tự chép danh sách optional field.

**Regression test:** mocked `runTeamTask()` → finalizer → replay; không có
`task.completed`, không tạo artifact giả và chỉ requeue headless đúng một lần.

**Test liên quan:**
`test/unit/runtime/task-runner/post-execution-surface-lost.test.ts:154–179`
hiện truyền `surfaceLost` thẳng vào finalizer, bỏ qua adapter bị lỗi.

### F05 — Coordinator chết nhưng test runner trả exit code 0

**Bằng chứng:** Tái hiện.

**Vị trí:** `scripts/test-runner.mjs:134–142`.

```js
process.exit(result.status ?? 0);
```

`spawnSync()` có thể trả `status: null` khi child chết bởi signal. Nếu không
có `result.error`, nhánh cuối chuyển trạng thái đó thành thành công.

**Tái hiện:** fixture test gửi `SIGKILL` tới coordinator riêng của fixture.
Wrapper trả `0`, stdout mới có `TAP version 13`, chưa có tổng kết test.
Probe với `SIGTERM` trả `1`; vì vậy không khẳng định mọi signal đều gây lỗi.

**Hậu quả:** một lần test bị kill, chẳng hạn do OOM, có thể tạo CI false-green.

**Đề xuất:** chỉ status `0` và không có signal mới là thành công; mọi signal,
status không xác định hoặc spawn error đều phải fail closed.

**Regression test:** success, assertion failure, SIGTERM, SIGKILL, timeout,
spawn error. Kiểm tra exit code của wrapper, không chỉ text trong stdout.

## 4. Phát hiện mức Vừa

### F06 — Agent upsert phá coalescing và ghi lại cả đội

**Bằng chứng:** Tái hiện bằng đếm filesystem operations.

**Vị trí:** `src/runtime/crew-agent-records.ts:284–315, 371–398, 459–475, 495–516`.

Mỗi upsert đọc agent index qua đường flush pending `agents.json`, buộc update
trước xuống đĩa. Hàm save còn ghi/queue status của mọi record dù chỉ một record
thay đổi. Terminal upsert ghi status mục tiêu thêm lần nữa.

**Số đo:**
- 20 progress upsert liên tiếp: 19 index writes trước drain, 20 sau drain.
- Update một trong bốn completed records: 6 atomic renames, 12 `fsync`;
  status mục tiêu bị ghi hai lần.

**Đề xuất:** đọc pending snapshot trong RAM thay vì flush để read-after-write;
track dirty task; chỉ persist record đổi; bỏ terminal write trùng. Giữ full
durability cho terminal state.

**Regression/benchmark:** số rename/fsync theo N agent, progress burst trong
một coalescing window và N terminal transitions. Đo caller thật, không chỉ
atomic-write primitive.

### F07 — Agent event cursor đọc lại toàn lịch sử khi không có dữ liệu mới

**Bằng chứng:** Tái hiện.

**Vị trí:** `src/runtime/crew-agent-records.ts:643–700`.

Đường đọc thực hiện `readFileSync → split → JSON.parse → filter → slice`.
`sinceSeq` và `limit` chỉ được áp dụng sau khi đã đọc/parse toàn file.

**Số đo:** file 10.000 event, 728.894 byte; hai poll với
`sinceSeq: 10000, limit: 1` trả rỗng nhưng đọc tổng 1.457.788 byte.

**Đề xuất:** incremental reader theo offset, nhận biết inode replacement và
truncation; cache bounded; giữ đúng `total`, legacy sequence và pagination.
Không thay bằng bounded tail nếu việc đó âm thầm làm mất history.

**Regression test:** idle poll không đọc event bytes; append chỉ đọc delta;
Unicode, partial line, rotation, truncate và pagination không mất/trùng event.

### F08 — “Giới hạn độ sâu JSON” thực chất đếm số giá trị

**Bằng chứng:** Tái hiện qua public config loader.

**Vị trí:** `src/config/config.ts:282–291, 301–315, 418–424`.

Reviver tăng một counter sau mỗi callback, không đo nesting depth.
Config nông nhưng có hơn 100 giá trị bị từ chối như JSON quá sâu.

**Tái hiện:**
- 10 model overrides: load đủ, `maxConcurrentWorkers: 3` được giữ.
- 60 model overrides: load 0 override; worker limit không được giữ.
- Warning: `invalid config ignored: config JSON exceeds max depth 100`.

**Hậu quả:** cả file config bị bỏ, không chỉ phần vượt giới hạn; thiết lập
hạn chế tài nguyên và preference không còn được áp dụng từ file đó.

**Đề xuất:** giữ byte-size limit, dùng iterative depth walk để kiểm tra độ sâu
thật trước recursive schema processing.

**Regression test:** config nông rộng vẫn load/update được; config thực sự
vượt depth limit bị từ chối.

### F09 — Delivery retention làm replay message đã acknowledged

**Bằng chứng:** Tái hiện.

**Vị trí:** `src/state/coordination/mailbox.ts:549–566, 925–940`.

Delivery cap 10.000 entry ưu tiên giữ queued, rồi delivered, sau cùng mới
acknowledged. Acknowledgment chỉ có trong delivery state; message gốc còn
`status: "queued"`. Khi ack bị loại, replay coi message đó là pending.

**Tái hiện:** seed 9.999 queued entry và một acknowledged entry, append message
mới; ack cũ bị loại và `replayPendingMailboxMessages()` trả lại message cũ.
Không cần crash để kích hoạt.

**Đề xuất:** chỉ GC acknowledgment/tombstone khi message tương ứng không còn
trong toàn bộ history có thể replay; phối hợp mailbox retention với delivery.

**Regression test:** vượt cap với status trộn, kể cả message trong archive;
acknowledged message không được phát lại.

**Test liên quan:** `test/unit/state/coordination/mailbox-replay.test.ts`.

### F10 — Cancel xóa record nhưng pending write tạo lại status running

**Bằng chứng:** Tái hiện.

**Vị trí:** `src/runtime/crew-agent-records.ts:417–439, 495–516`.

Remove lưu index đã lọc rồi unlink status. Flush helper chỉ xử lý record
còn trong index, bỏ sót pending write của record vừa xóa.

**Tái hiện:** upsert running → upsert cancelled → status không tồn tại ngay
lúc đó; sau atomic drain, `status.json` xuất hiện với `running`, index vẫn rỗng.

**Hậu quả:** reader trực tiếp thấy trạng thái cũ quay lại. Không có bằng chứng
process thực sự được spawn lại; lỗi nằm ở persistence/observability.

**Đề xuất:** hủy pending write của đúng status path trước unlink, hoặc flush
đúng path rồi unlink; bảo đảm exit drain cũng không tái tạo record.

**Regression test:** assert index và status sau timer/drain, không chỉ ngay
sau cancel. Mở rộng `test/unit/runtime/core/cancellation-trace-wipe.test.ts`.

### F11 — Async initialization có thể tái tạo tài nguyên sau cleanup

**Bằng chứng:** Luồng mã.

**Vị trí:**
- `src/extension/registration/lazy-configurers.ts:42–50`
- `src/extension/registration/observability.ts:97–119, 147–176`
- `src/extension/registration/lifecycle.ts:119–142`

Initialization khởi chạy các promise không được lifecycle sở hữu đầy đủ.
Cleanup có thể dispose phần đã tạo, sau đó continuation lại gán metric
subscriptions, sink, watcher hoặc router vào shared state.

OTLP continuation đã có cleanup/registry ownership check, nhưng sự bảo vệ đó
không bao phủ cả pipeline.

**Đề xuất:** capture session generation; tạo resource vào local variables;
kiểm tra ownership sau mỗi async boundary trước khi publish; dispose phần
khởi tạo muộn; theo dõi initialization promises trong teardown.

**Regression test:** pause initialization, shutdown/switch, rồi release;
không có listener/timer/sink thuộc session cũ. Kiểm tra overlap A/B.

**Khoảng trống:** `test/unit/extension/registration/register-observability-lifecycle.test.ts`
kiểm tra đồng bộ mà không await initialization, nên không chứng minh không
có tài nguyên xuất hiện muộn.

### F12 — Hook observability tích lũy context cũ qua session

**Bằng chứng:** Luồng mã.

**Vị trí:** `src/extension/registration/observability.ts:178–193, 298–322`;
`src/extension/registration/lifecycle-handlers.ts:232–235`.

Mỗi configure đăng ký thêm `before_agent_start`, capture `ctx` của session đó.
Dispose không loại bỏ hoặc vô hiệu vĩnh viễn callback. Guard chỉ đọc shared
`cleanedUp`, vốn trở lại false khi session mới bắt đầu.

**Hậu quả:** callback cũ hoạt động lại với cwd/session identity cũ; số lần
reconcile và retained context tăng theo số lần switch.

**Đề xuất:** đăng ký hook một lần cho extension và resolve context hiện tại,
hoặc dùng captured generation để callback cũ không bao giờ tái hoạt động.

**Regression test:** configure A → dispose → configure B → một turn chỉ
reconcile một lần bằng B. Lặp nhiều cycle.

**Test liên quan:** `test/unit/extension/registration/observability-session-threading.test.ts`.

### F13 — Session switch gỡ RPC/cache nhưng không khôi phục đầy đủ

**Bằng chứng:** Luồng mã.

**Vị trí:**
- `src/extension/register.ts:89`
- `src/extension/registration/wire-cross-extension.ts:17–35`
- `src/extension/registration/runtime-cleanup.ts:93–108`
- `src/extension/registration/context-builder.ts:123–134`
- `src/ui/run-snapshot-cache.ts:1099–1109, 1145–1149`

RPC/global registry được cài lúc extension registration, nhưng bị gỡ trong
session-switch cleanup. Session start tiếp theo không cài lại tương ứng.

Cache bị dispose nhưng reference và `cacheCwd` còn giữ; access ở cùng cwd
có thể trả disposed instance. Polling có thể dựng lại snapshot nhưng không
tự khôi phục các subscription đã bị gỡ.

**Đề xuất:** tách tài nguyên sống theo extension khỏi tài nguyên sống theo
session. Giữ hoặc reinstall RPC đúng lifecycle; disposed cache phải được
recreate ngay cả khi cwd không đổi.

**Regression test:** register một lần, ping ở A, switch sang B cùng cwd,
ping lại thành công; cache subscriptions được phục hồi đúng một lần.

### F14 — Preload polling vô hiệu cơ chế dừng render khi idle

**Bằng chứng:** Luồng mã; chưa đo CPU riêng cho tình huống này.

**Vị trí:** `src/extension/registration/lifecycle-handlers.ts:724–748, 891–897, 944`;
`src/ui/render-scheduler.ts:115–146`.

Mỗi preload thành công gọi `schedule()` dù dữ liệu không đổi. Timer preload
vẫn lặp; `schedule()` coi đây là activity và reset idle counter.

**Đề xuất:** so sánh version/signature trước khi schedule; tách maintenance
refresh khỏi genuine activity; giảm tần suất idle preload. Giữ animation tick
riêng khi thực sự có công việc.

**Regression test:** tích hợp preload + scheduler với fake clock, dữ liệu
không đổi thì render dừng sau allowance; một snapshot đổi phải kích hoạt lại.

**Test liên quan:** `test/unit/ui/render-scheduler.test.ts:166–214`
hiện kiểm tra scheduler đơn lẻ, không bao phủ nguồn schedule từ preload.

### F15 — Worker đang chờ semaphore không hủy được ngay

**Bằng chứng:** Luồng mã.

**Vị trí:**
- `src/runtime/scheduling/semaphore.ts:27–49`
- `src/runtime/scheduling/global-worker-cap.ts:90–96`
- `src/runtime/run-worker.ts:72–77`
- `src/runtime/budget-enforcement.ts:93–100`

Acquire slot không nhận `AbortSignal`. Signal chỉ đến child runtime sau
khi acquire xong.

**Điều kiện:** run A giữ hết slot; run B đang đợi rồi bị cancel hoặc timeout.
B vẫn phải chờ A nhả slot trước khi promise có thể settle. Guard về sau có
thể ngăn spawn, nhưng không làm cancellation của queue trở nên nhanh.

**Đề xuất:** signal-aware acquisition; bỏ aborted waiter; xử lý race giữa
abort và slot handoff, không làm rò capacity.

**Regression test:** giữ slot duy nhất, queue rồi cancel B; B settle nhanh,
không spawn, queue không còn B và slot accounting không đổi.

**Test liên quan:** `test/unit/runtime/scheduling/global-worker-cap.test.ts`,
`test/unit/runtime/run-worker-cap.test.ts`.

### F16 — Grandchild không chuyển running nên nesting tiếp bị từ chối

**Bằng chứng:** Luồng mã.

**Vị trí:** `src/runtime/broker/crew-broker.ts:1444–1450, 1544–1601, 1658–1668`;
`src/runtime/delegate-spawn.ts:131–133`.

Admission yêu cầu parent task có status `running`. Shadow grandchild lại
được tạo ở trạng thái `queued`; broker không truyền `onSpawn` để promote.
Transition rõ ràng tiếp theo là completed/failed khi spawner settle.

**Hậu quả:** grandchild depth 2 đang thực thi, dù có broker credentials và
max depth cho phép, có thể bị từ chối khi delegate depth 3 vì record chưa running.

**Đề xuất:** sở hữu đầy đủ lifecycle của grandchild; promote khi spawn thành
công; persist ownership/liveness; terminalize mọi outcome. Phân biệt shadow
task do external spawner quản lý với task do workflow scheduler quản lý.

**Regression test:** injected pending spawner, gửi delegate bằng identity
của grandchild trước khi resolve spawn; kiểm tra depth 3 được nhận đúng policy.

### F17 — Verification prompt mâu thuẫn, cache không có provenance

**Bằng chứng:** Nội dung agent/workflow; chưa tái hiện false verdict bằng model.

**Vị trí:** `agents/verifier.md:20–50`; `workflows/fast-fix.workflow.md:24`;
`workflows/default.workflow.md` phần verification rule.

Verifier system prompt bắt chạy full `npm test`, trong khi workflow yêu cầu
targeted/fast checks và cấm full suite. Prompt cho phép dùng lại cached log
mà không ràng buộc với phiên bản mã, command hoặc môi trường.

Các command `npm run test:critical`/`npx tsc --noEmit` bị hardcode, không phù
hợp mọi repository mà một extension tổng quát có thể hỗ trợ. Pipeline `tee`
không bảo toàn exit code của npm nếu không có `pipefail`; cleanup wildcard
cũng có thể xóa log của verifier khác.

**Đề xuất:**
- Một verification plan thống nhất, suy ra từ project scripts/instructions.
- Artifact ghi command, exit code, git revision + working-tree fingerprint,
  dependency/environment fingerprint và thời điểm.
- Chỉ reuse cache khi provenance còn khớp; sau sửa mã phải kiểm chứng lại.
- Bảo toàn exit code; mỗi attempt chỉ quản lý log của mình.
- Dùng cold verifier cho high-risk gate, không bắt mọi task trả toàn bộ chi phí đó.

**Regression:** prompt/workflow consistency và repo fixtures Node/Python hoặc
repo không có `test:critical`; cache đổi khi source/command/environment đổi.

### F18 — `test:changed` bỏ qua thay đổi chưa commit

**Bằng chứng:** Luồng mã của script, chưa tạo thay đổi trong repository để chạy probe.

**Vị trí:** `scripts/test-changed.mjs:48–57, 79–85, 123–129`.

Đường mặc định diff giữa merge-base và `HEAD`, không xét working tree/index.
Mapping chỉ lấy changed `src/*.ts`, không đưa trực tiếp changed test files vào.
Khi không map được, fallback chỉ chạy ba broker tests, không toàn bộ
`test:critical`.

**Hậu quả:** dùng command này để kiểm tra edit local có thể không chạy test
liên quan mà vẫn trả xanh.

**Đề xuất:** phân biệt rõ branch/CI mode và local mode; local mode bao gồm
staged + unstaged + test file mới phù hợp; chạy trực tiếp changed tests;
fallback phải được mô tả và chọn đúng chủ đích.

**Regression test:** chỉ unstaged edit, chỉ staged edit, test-only change,
file mới và branch diff. Không gọi một subset ba file là toàn critical gate.

### F19 — Smoke argv không kiểm tra argv đã dựng, canary không auth bị skip

**Bằng chứng:** Luồng mã/test và workflow, không chạy model thật.

**Vị trí:** `test/smoke/argv-flags.smoke.ts:33–57`;
`test/smoke/_helpers.ts:34–50`; `.github/workflows/weekly-smoke.yml`.

Test dựng `built.args` và kiểm tra vài flag bằng assertion, nhưng executable
thật chỉ được gọi với `["--version"]`. Các flag vừa dựng không được truyền
cho parser thật.

Đồng thời, test argv không cần model lại dùng cùng `smokeSkipReason()` yêu
cầu auth. Trong môi trường weekly canary không auth, nó cũng bị skip.

**Hậu quả:** canary có thể không cung cấp bằng chứng về argv compatibility
như mô tả. Đây không phải khẳng định argv hiện tại đang sai.

**Đề xuất:** tách auth-free binary/parser probe khỏi LLM-billed smoke;
thiết kế probe buộc parser xử lý argv thật, không dựa vào `--version` nếu
version short-circuit bỏ qua validation. Xác nhận số test thực sự được chạy.

**Regression test:** một flag không hợp lệ phải làm compatibility probe fail;
không có auth vẫn chạy được auth-free canary.

## 5. Phát hiện mức Thấp và khoảng trống đo chất lượng

### F20 — Benchmark harness chấp nhận không có judge, từ chối bare `npm test`

**Bằng chứng:** Tái hiện bằng public `runBenchmark()`.

**Vị trí:** `src/benchmark/benchmark-runner.ts:53, 163–166`.

```text
judges: []  → passed: true
command: "npm test" → "Command not allowed: npm test..."
```

Nguyên nhân: `every()` trên mảng rỗng trả true; regex allowlist yêu cầu một
khoảng trắng phía sau command prefix.

Module này được loại khỏi package files và chỉ thấy caller trong test
harness, không phải đường runtime đang ship. Vì vậy không dùng phát hiện
này để tuyên bố runtime agent đang tự báo PASS sai.

**Đề xuất:** empty judge phải là invalid/inconclusive; validate executable
và args rõ ràng; có test cho bare command hợp lệ.

Một giới hạn khác: `cost: 0` là giá trị cố định; task prompt không được runner
này đem đi thực thi agent. Không thể dùng nó làm bằng chứng chất lượng/chi phí
LLM end-to-end. Nếu mở rộng eval harness, phải lấy cost và outcome thật từ run.

## 6. Kết quả kiểm chứng

### 6.1 Các kiểm tra đã chạy

| Kiểm tra | Kết quả |
|---|---|
| `npm run typecheck` | Qua, bao gồm strip-types import |
| `npm run lint` | Qua; Biome có hai thông tin về schema version/deprecation |
| `npm run format:check` | Qua |
| `npm run check:lockfile-sync` | Qua |
| `npm run check:lazy-imports` | Qua |
| `npm run check:bundle-staleness` | Qua ở mtime mode, không phải committed-hash gate |
| `npm run check:wc-gate` | Qua; 216 runtime files, lớn nhất 1.994 dòng |
| `npm run check:conflict-markers` | Qua |
| `npm run check:decision-drift` | Qua |
| `npm run check:bundle-size` | Qua; bundle khoảng 3,26 MiB, budget 3,5 MiB |
| `npm run test:bundle` | 2 pass, 0 fail |
| `npm test` | Thất bại ở unit; xem chi tiết dưới |
| `npm run test:integration`, chạy riêng | 124 pass, 0 fail, 4 skip |
| `npm run check:env-vars` | Thất bại, hai raw env reads |
| `npm run check:event-types` | Exit 0 ở report mode, nhưng có registry drift |

Không chạy `npm run ci` nguyên chuỗi, rebuild bundle, pack/install smoke,
committed-dist hash, test integration slow tier, system/TUI E2E hoặc LLM smoke.
Bundle test dùng bundle hiện có, không chứng minh reproducible build.

### 6.2 Unit và integration

```text
Unit:
  tests      7873
  suites      862
  pass       7868
  fail          2
  skipped       3
  cancelled     0
  duration 789955 ms, khoảng 13,2 phút
  npm test exit 1

Integration, chạy riêng:
  tests       128
  pass        124
  fail          0
  skipped       4
  cancelled     0
  duration 232756 ms, khoảng 3,9 phút
  exit 0
```

`npm test` dùng `test:unit && test:integration`. Do unit fail, integration
không được chạy bởi chuỗi đó; kết quả integration trên đến từ lệnh riêng.

**Hai unit failures:**

1. `test/unit/interrupt-guard-ack.test.ts`
   - `RT-4: REAL interrupt guard writes acknowledged:true + body fires exactly once`.
   - Trong full suite: expected 1, actual 0.
   - Chạy riêng file: 2/2 pass.
   - Kết luận: thất bại chưa ổn định; chưa xác định root cause. Không gọi full
     suite là xanh chỉ vì chạy riêng qua.

2. `test/unit/runtime/broker/crew-broker-symlink-steering.test.ts`
   - `steer.push does not follow a symlinked steering directory outside artifactsRoot`.
   - Full suite và lần chạy riêng đều trả `request-timeout` thay vì `ok: true`.
   - Test thay timer bằng timeout 100 ms; timing/setup cần được điều tra.
   - Assertion thất bại trước kiểm tra escaped write, nên đây **không phải**
     bằng chứng symlink boundary đã bị vượt qua.

Unit/integration có thời gian chạy chồng nhau; các microbenchmark bổ sung cũng
được chạy trong thời gian kiểm thử. Không quy nguyên nhân test fail cho tải máy
nếu chưa có controlled experiment.

### 6.3 Consistency gates chưa đạt

`check:env-vars` báo:

```text
src/extension/knowledge-injection.ts:466  PI_CREW_KIND
src/runtime/stale-reconciler.ts:287       PI_CREW_DEBUG_STALE
```

`check:event-types` báo 89 registered types, 123 literal emitted types;
75 emitted types chưa có trong registry và 41 registered types không tìm
thấy literal emit site. Nhóm sau có thể là dynamic/legacy, không tự động là
dead code. Script hiện ở report mode; chỉ `--enforce` mới fail khi có drift.

Push/PR CI hiện không gọi `check:env-vars`, `check:event-types` hoặc performance
bench gate như các bảo đảm đầy đủ. Cần đồng bộ ý nghĩa giữa local CI script,
workflow thực tế và nội dung tài liệu.

Một điểm về thời gian test: `scripts/test-runner.mjs:81–84` clamp concurrency
trên 2 xuống 2 trên mọi môi trường, dù comment nói local explicit concurrency
không bị ảnh hưởng. Không nên hứa tăng tốc bằng đổi cap trước khi giải quyết
test isolation/timing, nhưng nên làm hành vi này rõ ràng.

## 7. Số đo hiệu năng

### 7.1 Đếm write operations và durability

Các con số sau là bằng chứng cấu trúc I/O của fixture, đáng tin cậy hơn việc
so sánh wall time giữa các lần chạy khác tải:

| Fixture | Quan sát |
|---|---|
| 20 progress upserts | 20 agent-index writes sau drain |
| Terminal upsert một record trong bốn record | 6 rename, 12 fsync, status mục tiêu ghi hai lần |
| Hai idle event polls, history 10.000 event | 2 full reads, 1.457.788 byte |
| Run lock, hai async context | `maxActive = 2` |
| Cancel rồi drain | Status `running` xuất hiện lại, index vẫn rỗng |
| Delivery cap 10.000 | Acknowledged message bị replay |

`bench/b12-fsync-counts.bench.ts` qua cả 7 case:

| Case | fsync calls |
|---|---:|
| Sync non-terminal event | 0 |
| Sync terminal event | 1 |
| Buffered batch tám non-terminal events | 0 |
| Non-terminal tasks checkpoint, flag off | 2 |
| Non-terminal tasks checkpoint, flag on | 0 |
| Mailbox delivery mark | 0 |
| Coalesced drain bốn file cùng thư mục | 5 |

Kết luận: grouped fsync và durability tiers đã hoạt động ở các path được đo.
Tối ưu trước mắt là bỏ thao tác thừa tại caller, không bỏ durability đại trà.

### 7.2 Microbenchmark thời gian

| Benchmark | Mẫu/fixture | Kết quả |
|---|---|---|
| Task graph scheduler | 20 iterations, DAG 21 task | Full-run simulation p50 0,04 ms, p95 0,12 ms |
| Snapshot cache | 10 iterations, 10 task/200 event | Cold p50 1,08 ms, p95 1,29 ms |
| Terminal persistence | 10 iterations, 60 artifacts | Single terminal block p50 25,76 ms, p95 27,56 ms |
| Spaced terminal persistence | Concurrency fixture 4 | Per-call p50 27,37 ms, p95 41,40 ms |
| Event-loop sampler trong persistence bench | Resolution 1 ms | p95 28,64 ms, max 131,27 ms |
| Bundle startup | Một cold import, hai warm imports | Cold 1.612,46 ms; warm 0,10/0,03 ms |
| Fresh child bundle load | Một subprocess | 1.840,26 ms, gồm process startup |

**Giới hạn diễn giải:**
- Đây là microbenchmarks local, số mẫu nhỏ và chạy cùng test suite.
- Không phải latency end-to-end của workflow hoặc p95 production.
- Không dùng trung bình cold+warm import làm startup metric.
- `b7.childRssDeltaBytes` đo RSS của parent quanh `spawnSync`, không phải RSS
  của worker; không dùng trường đó để kết luận memory footprint của child.
- Terminal benchmark không chứng minh lock contention ngoài process đã hết.
- Không so trực tiếp với baseline Windows/Node khác môi trường.

### 7.3 Khoảng trống của performance gate

`scripts/bench-check.mjs` chỉ đọc `test/bench/results.json`, gate metric
có tên `p95`, bỏ qua benchmark không có baseline. Nó không bao phủ trực tiếp
suite `bench/b*.bench.ts` ghi vào `bench/results/`.

Baseline `test/bench/baseline.json` đang được ghi ngày 2026-05-14 trên Windows,
Node `v24.10.0`, gồm ba benchmark. Đây chưa phải bộ baseline đồng nhất với
môi trường Linux/Node 22 của review.

**Đề xuất:** schema metric thống nhất; baseline theo môi trường; benchmark
thiếu không được âm thầm thành green; tách correctness/count gates ít nhiễu
khỏi latency regression gates; tích hợp rõ vào CI/nightly phù hợp.

## 8. Lộ trình nâng cấp

### Đợt 1 — Bảo vệ dữ liệu và kết quả

Ưu tiên F01–F05, sau đó F08–F10.

1. Thêm regression test tái hiện lỗi trước.
2. Sửa worktree backup/cleanup contract và async lock ownership.
3. Sửa cwd delegation và bảo toàn execution result.
4. Làm test runner fail closed.
5. Sửa config depth, pending cancellation writes và retention/replay.

**Done gates:**
- Backup không đầy đủ không được xóa bytes gốc.
- Critical section của run có tối đa một independent async holder.
- Delegated executor không thoát workspace đã được kiểm tra.
- Mất surface không tạo completed giả và phục hồi đúng một lần.
- Test coordinator bị kill không thể làm CI xanh.
- Không tái tạo status đã hủy hoặc phát lại message đã acknowledged.

Các thay đổi state mutation + concurrency, process spawning hoặc destructive
worktree path thuộc **high-risk lane** theo `docs/FEATURE_INTAKE.md`.
Cần story/design, phê duyệt trước triển khai và regression tests đủ phạm vi.

### Đợt 2 — Giảm chi phí điều phối

Ưu tiên F06, F07, F11–F15.

1. Dirty-record persistence, giữ pending snapshot trong RAM.
2. Incremental event cursor với rotation/truncation semantics đúng.
3. Session initialization có generation ownership, teardown idempotent.
4. Idle UI không render lại khi dữ liệu không đổi.
5. Semaphore waiters có thể abort.
6. Profile import graph trước khi code-split/lazy-load.

**Done gates đề xuất:**
- Progress burst trong một window không ép một index write cho mỗi update.
- Update một agent không viết lại status của mọi agent không đổi.
- Idle event poll không đọc lại event payload cũ.
- Session switch không tăng dần listener/timer và không mất RPC.
- Cancel queued worker settle nhanh, không spawn và không mất slot.
- Latency được đo lại cùng môi trường, có warmup và số mẫu phù hợp.

Không đặt mục tiêu “nhanh hơn X lần” trước khi có baseline hợp lệ. Không
chuyển toàn state sang database hoặc worker pool chỉ vì thấy I/O đồng bộ.

### Đợt 3 — Nâng chất lượng đầu ra dựa trên eval

1. Thống nhất verification plan theo repository và cache provenance.
2. Sửa local changed-test selection và auth-free smoke.
3. Xây tập tác vụ đại diện: bug nhỏ, implementation nhiều file, research,
   worktree/delegation và recovery.
4. So sánh một agent, fast-fix và adaptive workflow trên cùng điều kiện.
5. Chỉ đổi fallback/context/concurrency khi số đo chất lượng không giảm.

**Metric nên theo dõi:**
- First-pass acceptance rate và tỷ lệ đạt acceptance criteria.
- Cost per accepted result, không chỉ cost mỗi run.
- End-to-end p50/p95.
- Slot wait, preparation, spawn, first-output, execution và final-drain time.
- Retry/fallback count, token usage, cache hit rate.
- Isolation violations, replay duplication và recovery failures.

Fallback nên xét context-window/tool capability và mức chất lượng tối thiểu,
không chỉ model còn trả lời được. Context trimming cần eval để tránh giảm token
nhưng tăng lỗi hoặc tăng số vòng sửa.

Cold verifier nên dùng ở gate rủi ro cao. Không chạy full suite cho mọi bước
nhỏ nếu targeted evidence đủ; ngược lại, không dùng cache cũ để bỏ qua bằng
chứng cần thiết sau khi mã đã đổi.

### Những việc chưa nên làm ngay

- Tăng `maxConcurrentWorkers` khi lock và write amplification chưa được xử lý.
- Bật best-effort durability rộng để làm benchmark đẹp.
- Rewrite orchestrator chỉ để giảm số dòng.
- Bổ sung agent/lớp abstractions khi ranh giới lifecycle hiện tại còn lỗi.
- Đưa pooling/session reuse vào mặc định trước khi chứng minh isolation.
- Dùng số task `completed` như thước đo chất lượng giải pháp.
- Xem mọi `sleepSync` là có thể thay bằng `await` độc lập với call graph.
  Các lock sites đã có lịch sử deadlock và ADR riêng, cần kiểm tra từng đường.

## 9. Tài liệu và bằng chứng lưu tạm

Các log sau được tạo trong phiên review trên máy local. Chúng là file tạm,
không được commit cùng báo cáo và có thể không còn tồn tại ở phiên sau:

| Nội dung | Đường dẫn tại thời điểm review |
|---|---|
| Nhóm static gates đầu tiên | `/tmp/droid-bg-1789626762894.out` |
| Full unit run qua `npm test` | `/tmp/droid-bg-1789626773996.out` |
| Integration chạy riêng | `/tmp/droid-bg-1789627077247.out` |
| State reproduction script | `/tmp/pi-crew-state-audit.x3H6JT/repro.mjs` |

State script đã chạy bằng:

```bash
node --experimental-strip-types --no-warnings /tmp/pi-crew-state-audit.x3H6JT/repro.mjs
```

Script dùng assertion xác nhận **hành vi lỗi hiện còn tồn tại**, không phải
regression test đã chuyển sang green sau khi sửa. Nó tạo/xóa fixture trong
`/tmp`; script được giữ lại khi kết thúc review.

Các probe config, test-coordinator death và worktree được chạy qua inline Node
scripts; fixture được dọn sau khi chạy. Báo cáo lưu scenario và outcome, không
tuyên bố đã thêm permanent regression tests vào repository.

### Phạm vi chưa được chứng minh

- Chưa sửa bất kỳ finding nào.
- Chưa audit toàn bộ security boundary hoặc mọi file trong repository.
- Chưa xác nhận live model quality, provider latency hay chi phí end-to-end.
- Chưa chạy multi-platform hoặc terminal surface E2E.
- Chưa xác định root cause cuối cùng của hai unit failures.
- Chưa chứng minh speedup của các phương án tối ưu đề xuất.
- Chưa kiểm tra tất cả failure modes bằng process crash/restart thật.

**Quyết định đề xuất:** bắt đầu bằng một đợt sửa correctness nhỏ, có regression
test rõ, rồi thực hiện delta persistence và incremental cursor. Sau đó mới
dùng eval end-to-end để quyết định cấu hình agent/model tối ưu.
