# Xác minh độc lập review pi-crew: 20 phát hiện

## 1. Thông tin và phạm vi

| Thuộc tính | Giá trị |
|---|---|
| Ngày xác minh | 2026-09-17 |
| Package | `pi-crew@0.11.1` |
| Commit được xác minh | `0b9fa771` (HEAD tại thời điểm xác minh) |
| Tài liệu được xác minh | `docs/archive/2026-09-17-pi-crew-review.md` |
| Môi trường | Linux, Node `v22.23.1` |
| Yêu cầu | Kiểm chứng xem 20 phát hiện (F01–F20) có chính xác so với mã nguồn không |
| Thay đổi mã | Không. Chỉ đọc; probe chạy trong `/tmp` và đã xóa |
| Trạng thái | Bản ghi xác minh, không phải đặc tả triển khai |

`HEAD` trùng đúng commit được review (`git merge-base --is-ancestor 0b9fa771 HEAD`
→ true), nên toàn bộ số dòng tham chiếu trong review còn hiệu lực.

Phương pháp: 5 verifier độc lập, mỗi nhóm phụ trách một mảng, chạy song song.
Mỗi verifier được lệnh **không tin review**, phải tự đọc mã và tự viết probe
import **hàm/module thật đã export**. Probe dùng `/tmp`, xóa sau khi chạy.

### Cách đọc kết luận

- **VERIFIED:** mã nguồn làm đúng như phát hiện mô tả; có trích dẫn dòng.
- **VERIFIED (mạnh hơn):** phát hiện đúng, nhưng hậu quả thực tế nặng hơn mô tả.
- **PARTIAL:** cơ chế đúng nhưng có chi tiết sai (ví dụ gán nhầm vị trí).
- **REFUTED:** mã không làm như mô tả (không có mục nào).
- **UNVERIFIABLE:** cần điều kiện runtime không tạo được.

Ghi chú: các probe dùng `strace` cho các phát hiện I/O vì `node:fs` ESM named
export bị frozen, không monkey-patch được (`Cannot assign to read only property
'renameSync'`).

## 2. Kết luận tổng

**Bản review có độ chính xác cao: 19/20 phát hiện VERIFIED, 1 PARTIAL (chỉ sai
vị trí gán, không sai cơ chế), 0 REFUTED.**

Năm phát hiện bị **đánh giá thấp** so với thực tế (F01, F04, F09, F12, F19).
Một phát hiện gán nhầm vị trí (F17). Nhiều phát hiện có thêm chi tiết mà review
chưa nêu, được ghi ở mục 4.

| ID | Verdict | Mức trong review | Phương pháp |
|---|---|---|---|
| F01 | VERIFIED (mạnh hơn) | Cao | probe hàm thật + strace |
| F02 | VERIFIED | Cao | probe 2 async context thật |
| F03 | VERIFIED | Cao | truy vết tĩnh |
| F04 | VERIFIED (mạnh hơn) | Cao | truy vết tĩnh |
| F05 | VERIFIED | Cao | probe `scripts/test-runner.mjs` thật |
| F06 | VERIFIED | Vừa | strace (rename/fsync) |
| F07 | VERIFIED | Vừa | strace (byte đọc) |
| F08 | VERIFIED | Vừa | probe public config loader |
| F09 | VERIFIED (mạnh hơn) | Vừa | probe state thật |
| F10 | VERIFIED | Vừa | strace (rename/unlink) |
| F11 | VERIFIED | Vừa | probe `configureObservability` thật |
| F12 | VERIFIED (mạnh hơn) | Vừa | probe hook + cache thật |
| F13 | VERIFIED | Vừa | probe `registerPiTeams` thật |
| F14 | VERIFIED | Vừa | probe `RenderScheduler` thật |
| F15 | VERIFIED | Vừa | probe `Semaphore` thật |
| F16 | VERIFIED | Vừa | truy vết tĩnh |
| F17 | **PARTIAL** | Vừa | đọc prompt + probe `tee`/`pipefail` |
| F18 | VERIFIED | Vừa | probe repo git tạm |
| F19 | VERIFIED (mạnh hơn) | Vừa | probe binary `pi` thật |
| F20 | VERIFIED | Thấp | probe `runBenchmark` thật |

## 3. Hiệu chỉnh cần thiết

### C1 — F17: command hardcode bị gán nhầm vị trí (PARTIAL)

Review viết: "Các command `npm run test:critical`/`npx tsc --noEmit` bị hardcode"
trong ngữ cảnh bàn về `agents/verifier.md`. Thực tế:

```bash
grep -n "test:critical\|tsc --noEmit" agents/verifier.md
# → 0 kết quả
```

Chúng nằm trong **workflow**, không phải agent body:

- `workflows/fast-fix.workflow.md:24`
- `workflows/plan-execute.workflow.md:30`
- `workflows/review.workflow.md:31`
- `workflows/strict-fast-fix.workflow.md:26`
- `workflows/distill.workflow.md:147,160,176`

**Mâu thuẫn thì vẫn đúng và đã xác nhận.** `agents/verifier.md:16,21-23` bắt
chạy full suite:

```bash
npm test 2>&1 | tee .crew/cache/verify-test-$(date +%s).log
```

trong khi workflow verify step cấm:

> "Do NOT run `npm run test:unit` or `npm test` — too slow (642 files, >4 min)."

Cả hai được inject vào **cùng một prompt** (agent body → system prompt qua
`pi-args.ts:341-348`; workflow section → task arg qua `prompt-builder.ts:334`),
và **không có quy tắc precedence/override nào** (`grep` trong `prompt-builder.ts`
→ 0 hit). Tính không di động vẫn có thật: `discover-workflows.ts:259-263` nạp
workflow builtin từ `packageRoot()/workflows`, nên repo không phải Node vẫn nhận
`npm run test:critical` nguyên văn.

### C2 — F02: phạm vi hẹp hơn mô tả

Mutual exclusion **đúng** cho sync↔sync và sync↔async; **chỉ vỡ** cho
async↔async (`withRunLock` vs `withRunLock`). Test hiện có
(`round30-h1-run-lock-async-context.test.ts:89,163`) chỉ phủ sync-vs-async, và
`locks-async-async-mutual-exclusion.test.ts` chỉ phủ `withFileLockAsync` — nên
tổ hợp duy nhất bị lỗi không được test.

### C3 — F03: cần điều kiện worktree opt-in

Đường mã lệch nhau là thật, nhưng **mọi builtin team đều khai
`workspaceMode: single`** (`teams/*.team.md`; `state-store.ts:424` default
`"single"`). Cần `workspaceMode: "worktree"` tường minh. Comment
`team-tool-schema.ts:166` ("Worktree mode is planned after MVP") đã cũ.

### C4 — F10: blast radius hẹp hơn headline

Chỉ có **một** reader production của `readCrewAgentStatus`:
`src/extension/team-tool/api/read.ts:217`. Các surface UI
(`agents-jobs-browser.ts:461-478`, `run-snapshot-cache.ts`) đọc `agents.json`,
vốn vẫn đúng. Đây là lỗi observability/persistence, **không** phải agent sống lại.

### C5 — F15: thiệt hại là delay, không phải process thừa

`child-pi-spawn.ts:385` trả `kind: "aborted"` **trước khi spawn**, nên không có
child process nào bị fork sau khi slot cuối cùng được cấp. Chi phí thật là
promise của B (và `drainPendingUnits`) treo suốt thời gian A còn giữ slot.

## 4. Chi tiết xác minh

### F01 — Snapshot bị cắt nhưng worktree vẫn bị dọn — VERIFIED (mạnh hơn)

Cap và nhánh truncation (`src/worktree/worktree-manager.ts:686-703`):

```ts
686: const MAX_FILE_BYTES = 256 * 1024;
696: const buf = fs.readFileSync(abs);          // đọc TOÀN BỘ file trước
700: if (originalSize > MAX_FILE_BYTES) {
701:   data = buf.subarray(0, MAX_FILE_BYTES);   // cắt SAU khi đọc
702:   note = ` (truncated: ${originalSize} → ${MAX_FILE_BYTES} bytes)`;
```

`return true` tại `:727` là **lối thoát thành công duy nhất**; `return false`
chỉ có ở `catch` ngoài (`:734`). Cổng sync (`:855-863`):

```ts
855: const snapshotOk = snapshotDirtyWorktree(manifest, task, worktreePath, dirtyStatus);
856: if (snapshotOk) {
862:   git(worktreePath, ["checkout", "--", "."]);
863:   git(worktreePath, ["clean", "-fd"]);
```

Cổng async giống hệt (`:1015-1023`, `await gitAsync`).

- Diff lỗi bị bỏ qua (`:676-681`): `catch { trackedDiff = ""; }` — không fail.
- Entry không đọc được bị bỏ qua (`:716-718`): `continue`, vẫn tới `return true`.

**Probe** (`prepareTaskWorkspaceAsync` thật, file untracked 307200 byte):

```text
first.reused = false
dirtyStatus = "?? big-untracked.bin\n"
second.reused = true
big file still exists after reuse = false          <-- bị hủy
artifact header: ## Untracked file: big-untracked.bin (truncated: 307200 → 262144 bytes)
```

**Mạnh hơn review:** probe thứ hai với file `chmod 000`:
`snapshotDirtyWorktree` trả `true`, artifact **không hề nhắc tới `secret.txt`**
(nội dung dài 111 byte) → mất hoàn toàn, không phải chỉ mất phần đuôi >256 KiB.

### F02 — Run lock cho hai async context cùng process vào critical section — VERIFIED

`src/state/coordination/locks.ts:154-157`:

```ts
154: const isOurOwnHolder = holderPid === process.pid;
156: canSteal: isStale || !isAlive || (treatOwnPidAsStealable && isOurOwnHolder),
```

Async path truyền `true` (`:378-384`), sync path truyền `false` (`:341-343`):

```ts
384: const { canSteal } = readLockSnapshot(filePath, staleMs, { treatOwnPidAsStealable: true });
390:   fs.rmSync(filePath, { force: true });     // phá lock của holder còn sống
```

Release theo PID (`:268-272`) không phân biệt được hai holder cùng process.
Caller thật tồn tại — `src/runtime/task-runner/post-execution.ts:626-629`:

```ts
626: tasks = await withRunLock(manifest, async () => {
627:   await saveRunManifestAsync(manifest);
628:   return persistSingleTaskUpdate(manifest, tasks, task, undefined, true);
```

**Probe** (hai chuỗi `withRunLock` top-level độc lập):

```text
ENTER A (active=1) lockExists=true
ENTER B (active=2) lockExists=true      <-- chồng lấn
MAX CONCURRENT HOLDERS = 2
MUTUAL EXCLUSION VIOLATED
```

Probe thứ hai chứng minh cả steal lẫn lỗi release-theo-PID: token đổi
`f0b30705` → `2fa28d60` khi A còn giữ; sau khi A thoát trước, lock file đã
biến mất (`ENOENT`) trong khi B vẫn trong critical section.

### F03 — Delegated worker có thể chạy ngoài worktree của cha — VERIFIED

Broker cwd, **không phải** task cwd (`src/runtime/broker/crew-broker.ts:1394`):

```ts
1394: const cwd = this.options.cwd;
```

Wiring production đặt nó bằng cwd session host
(`src/extension/registration/lifecycle-handlers.ts:1125`:
`cwd: process.cwd()`). Shadow record thì dùng đúng `task.cwd` (`:1553-1554`),
nhưng spawner nhận broker cwd (`:1587-1588`):

```ts
1587: outcome = await spawner({
1588:   cwd,
```

`onSpawn` vắng mặt (0 hit trong 1583-1600). `delegate-spawn.ts:114-115` dùng
trực tiếp `input.cwd` → `child-pi.ts:415` → `child-pi-spawn.ts:226` → `spawn()`.
Không lớp nào chuẩn hóa lại.

`task.cwd` và broker cwd thực sự khác nhau: `pre-execution.ts:146`
`cwd: workspace.cwd`, và ở worktree mode `workspace.cwd` **là** worktree path
(`worktree-manager.ts:1043,1088-1089`).

**Chi tiết review bỏ sót:** `delegate-spawn.ts:99` cũng suy artifacts root từ
`input.cwd` → artifacts của grandchild ghi vào leader workspace. Và overlap
check (`:1457-1463`, `t.cwd === task.cwd`) tính trên worktree cwd trong khi
grandchild chạy ở host cwd.

**Hiệu chỉnh số dòng:** dải `1397-1398` thực ra là guard `if (!cwd) { sendError }`;
phép gán ở **1394**. `pre-execution.ts:143-149` đúng (dòng cwd là 146).

### F04 — `surfaceLost` bị bỏ trước finalizer — VERIFIED (mạnh hơn)

Producer (`child-executor.ts:793-822`) trả field:

```ts
815: surfaceLost: {
816:   taskId: task.id,
817:   paneId: childResult.surface.paneId,
818:   cause: degraded.cause,
```

Hand-off bỏ nó — `task-runner.ts:140-153` copy 11 field, không có `surfaceLost`;
`task-runner.ts:208-220` dựng `execResult` cũng thiếu. `runTeamTask` là **caller
duy nhất** của `finalizeTaskResult`, nên `post-execution.ts:149` **không thể
chạm tới trong production**.

**Hậu quả mạnh hơn "có thể thành completed" — nó tất định:**

- `collectYieldEvents` = false cho child-process (`pre-execution.ts:180`) →
  `noYield` false.
- Gate bug-026 yêu cầu artifact path — `post-execution.ts:337`:
  `if (finalTextEmpty && finalStdoutEmpty && resultArtifact?.path)`. Vì
  `resultArtifact` là `undefined` → **gate bị bỏ qua**.
- `post-execution.ts:498`:
  `status: error ? "failed" : noYield ? "needs_attention" : "completed"` →
  **`completed`**, và `:639` phát `task.completed`.

Với `completionMutationGuard: "warn"` mặc định (`:240`) và role read-only,
`error` giữ `undefined` → tất định.

**Mất mát bậc hai:** task không tới `needs_attention` nên headless redeploy
cũng từ chối — `degrade.ts:519`: `requeueable = status === "needs_attention" ||
status === "running"` → phantom `completed` bị skip.

**Cùng lớp lỗi, chưa được báo:** `rawFinalText` cũng bị bỏ. Producer trả
(`child-executor.ts:1096`), finalizer dùng (`post-execution.ts:136`, footer
union 452-458), nhưng `task-runner.ts` có **0** occurrence của `rawFinalText`.

**Test hiện có lách adapter bị lỗi:** `post-execution-surface-lost.test.ts:160`
gọi `finalizeTaskResult` trực tiếp với result tự dựng inject field ở `:144`.
Không test nào chạy `surfaceLost` qua `runTeamTask`.

**Hiệu chỉnh số dòng:** branch là **149-179** (không phải 148); return block
`child-executor.ts` là 793-822 với field ở 815-821; `degrade.ts` status gate ở
519, còn ghi `diagnostics.surfaceLost` ở 546-549 là producer khác.

### F05 — Coordinator chết nhưng test runner exit 0 — VERIFIED

`scripts/test-runner.mjs:134-142`:

```js
134: if (result.error) {
136:   process.exit(1);
...
142: process.exit(result.status ?? 0);
```

Không có check `result.signal` nào trong file (0 hit). Chỉ nhánh `--watch`
(`:107-109`) có relay signal — nhánh mặc định của `npm test` không có.

**Probe** (chạy qua `scripts/test-runner.mjs` thật):

```text
kill-coord-kill.mjs (SIGKILL coordinator) → EXIT=0   stdout: "TAP version 13"
kill-coord-term.mjs (SIGTERM)             → EXIT=1
normal-fail.mjs                           → EXIT=1
pass.mjs                                  → EXIT=0
```

Primitive: `spawnSync(node, ['-e','process.kill(process.pid,"SIGKILL")'])` →
`status=null, signal="SIGKILL", error=undefined` → `null ?? 0` = **0**.
`ci.yml:95` chạy `npm test` → sẽ green CI một cách âm thầm.

**Mạnh hơn review:** stdout chỉ có một dòng, nên CI scrape TAP cũng không thấy
`not ok`. Và **không có test nào** phủ exit semantics của `test-runner.mjs`.

### F06 — Agent upsert phá coalescing và ghi lại cả đội — VERIFIED

Read path flush (`crew-agent-records.ts:284-291`):

```ts
284: export function readCrewAgents(manifest: TeamRunManifest): CrewAgentRecord[] {
291:   flushPendingAtomicWrites(agentsPath(manifest));
```

`atomic-write.ts:1147-1152` — scoped flush **không** phải no-op khi có entry.
`upsertCrewAgent` **luôn** đọc (`:461`), nên luôn flush. Save ghi **mọi** record
(`:382-397`):

```ts
382: for (const record of records) {                 // TẤT CẢ, không chỉ record đổi
383:   if (TERMINAL_AGENT_STATUSES.has(record.status ?? "")) {
384:     writeCrewAgentStatus(manifest, record);
```

`grep -cin dirty src/runtime/crew-agent-records.ts` → **0**: không có dirty tracking.

**Probe** (`strace -f -y -e trace=rename,fsync`):

| Kịch bản | Review | Quan sát |
|---|---|---|
| 20 progress upsert, trước drain | 19 index writes | **19 rename `agents.json`, 0 status.json** |
| ... cửa sổ drain | 20 sau drain | **+1 `agents.json` +1 status.json** (=20) |
| Update 1/4 record `completed` | 6 rename, 12 fsync, target ghi 2 lần | **đúng 6 rename, 12 fsync; target 2×, b2/b3/b4 1×** |
| Terminal upsert trên index 2 record | (không nêu) | **4 rename, 8 fsync; target 2×** |

**Chi tiết:** 19 index write trong cửa sổ là best-effort (không fsync); cái thứ
20 là full. Ghi status terminal 2 lần là **cố ý** (comment H2/F4 ở `:383-391`).

### F07 — Agent event cursor đọc lại toàn lịch sử — VERIFIED

`crew-agent-records.ts:676-693` — thứ tự read → parse → filter → slice:

```ts
676: const sinceSeq = ... options.sinceSeq ...;
679: const parsed = fs                                  // đọc TOÀN file, vô điều kiện
680:   .readFileSync(filePath, "utf-8")
681:   .split(/\r?\n/)
683:   .map((line, index) => { ... JSON.parse(line) ... });
692: const filtered = parsed.filter((event) => ... event.seq > sinceSeq);
693: const events = limit !== undefined ? filtered.slice(0, limit) : filtered;
```

Không có `fs.readSync`, byte offset, hay short-circuit mtime/size.

**Incremental reader tồn tại nhưng không ở path này:** `src/utils/incremental-reader.ts`
(`readJsonlSince`, offset-based) được `state/event-log/cursor.ts` dùng cho
run-level `events.jsonl`. Hai consumer của agent cursor
(`inline-panel/agent-transcript.ts:291` poll mỗi `PANE_LIVE_TICK_MS = 700`;
`team-tool/api/read.ts:261`) đều đi qua `readCrewAgentEventsCursor` — chưa migrate.

**Probe** (file 10000 event, 697788 byte — số của review 728894 là do record
hơi dài hơn; không đổi kết luận):

| Poll | Byte đọc |
|---|---|
| 1 | 697788 |
| 2 | 1395576 (697788 × 2) |
| 3 | 2093364 (697788 × 3) |

Cả hai poll trả `events: []`, `total: 0` → chi phí idle poll là **O(file)**, và
UI tick 700 ms làm nó lặp lại.

### F08 — "JSON depth limit" đếm số giá trị — VERIFIED

`src/config/config.ts:284-291`:

```ts
284: const MAX_JSON_DEPTH = 100;
285: let depth = 0;
286: const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"), (_key, value) => {
287:   if (++depth > MAX_JSON_DEPTH) {
288:     throw new Error(`config JSON exceeds max depth ${MAX_JSON_DEPTH}`);
```

Reviver không có depth bookkeeping; `++depth` tăng mỗi value. Ngưỡng là
**callback thứ 101**, không phải nesting level 100. Discard cả file (`:310-316`):

```ts
310: } catch (error) {
312:   return { exists: true, config: {}, warnings: [...] };
```

**Probe** (public `loadConfig`):

| Fixture | Kết quả |
|---|---|
| 47 overrides (99 value) | `keptOverrides=47`, `maxConcurrentWorkers=3` |
| **48 overrides (101 value)** | `keptOverrides=0`, `maxConcurrentWorkers=undefined` |
| config sâu 96 level, 99 value | **được chấp nhận** (chứng minh depth không được đo) |
| config sâu 98 level, 101 value | bị từ chối |

Warning đúng nguyên văn: `invalid config ignored: config JSON exceeds max depth 100`.

**Chi tiết bổ sung:** `updateConfig` **cũng throw** trên file quá hạn
(`:418-424`) → user không thể sửa qua CLI, chỉ hand-edit. Boundary chính xác là
**>100 value**, nên file 100 value vẫn load.

### F09 — Delivery retention replay message đã acknowledged — VERIFIED (mạnh hơn)

Eviction priority (`src/state/coordination/mailbox.ts:553-560`):

```ts
553: const MAX_DELIVERY_MESSAGES = 10000;
555:   const sorted = Object.entries(state.messages).sort(([, a], [, b]) => {
556:     const order = { queued: 0, delivered: 1, acknowledged: 2 };
557:     return (order[a] ?? 3) - (order[b] ?? 3);
559:   const trimmed = sorted.slice(0, MAX_DELIVERY_MESSAGES);
```

Replay chỉ key theo delivery-ack (`:930-932`):

```ts
930: const pending = readAllInboxMessages(manifest).filter(
931:   (message) => message.status !== "acknowledged" && delivery.messages[message.id] !== "acknowledged",
```

Ack **không bao giờ** được ghi lại vào message: `acknowledgeMailboxMessage`
(`:845-855`) chỉ set `delivery.messages[id] = "acknowledged"`;
`appendMailboxMessage:611` stamp `status: message.status ?? "queued"` và không
gì ghi lại dòng inbox JSONL.

**Probe:**

```text
SEED       deliveryEntries=10000  ack1=acknowledged
AFTER-APPEND entries=10000  ack1Entry=(EVICTED)  freshEntry=queued
REPLAY     count=10001  includesAck1=true
```

Replay 3 lần → vẫn `includesAck1=true`, `ack1DeliveryEntry=(absent)`.

**Mạnh hơn review — không tự hồi phục:** `replayPendingMailboxMessages` chỉ set
`"delivered"` (`:933-935`), nên message đã ack trở thành *delivered* và **vẫn
pending ở mọi lần resume sau**. Amplification: dòng inbox gốc còn trong
`inbox.jsonl` và các file `.archive.jsonl` (được `safeReadMailboxFile` `:372-379`
đọc lại) → replay phình tới O(10001) mỗi resume, ack không bao giờ khôi phục được.

### F10 — Cancel xóa record nhưng pending write tạo lại `running` — VERIFIED

`crew-agent-records.ts:422-437`:

```ts
422: const existing = readCrewAgents(manifest);            // chỉ flush agents.json
423: const filtered = existing.filter((r) => r.taskId !== taskId);
425: if (filtered.length !== existing.length) { saveCrewAgents(manifest, filtered); ... }
435: if (fs.existsSync(statusPath)) { fs.unlinkSync(statusPath); removedStatus = true; }
```

Cancel path return sớm, không flush status (`:454-458`). Flush helper chỉ lặp
record **còn trong index** (`:510-517`):

```ts
510: function flushPendingAgentWrites(manifest, records): void {
511:   flushPendingAtomicWrites(agentsPath(manifest));
512:   for (const record of records) flushPendingAtomicWrites(agentStatusPath(manifest, record.taskId));
```

Record đã xóa không nằm trong `records` → status.json không bao giờ được flush.
Không có path-based cancel cho caller: `cancelPendingCoalescedWrite`
(`atomic-write.ts:1117`) là module-private.

**Probe** (strace, thứ tự syscall):

```text
line 16 MARK f10-after-cancel
line 18 rename(agents/c1/status.json.<uuid>.tmp → agents/c1/status.json)   ← TẠO LẠI SAU CANCEL
RESULT existsAtCancel=false  existsAfterDrain=true  indexLen=0
```

Nội dung còn lại: `{"id":"c1",...,"status":"running","progress":{"pct":5}}`.

**Hiệu chỉnh số dòng:** cơ chế ở `454-458` (early return) + `510-517` (flush
helper) + `431-437` (unlink), không phải dải `495-516`. Test hiện có
`cancellation-trace-wipe.test.ts:203-224` chỉ assert trạng thái **đồng bộ** ngay
sau cancel và **pass 15/15** — không phủ lỗi này.

### F11 — Async initialization tái tạo tài nguyên sau cleanup — VERIFIED

Fire-and-forget (`lazy-configurers.ts:46-48`):

```ts
46: ctx.configureObservability = (extCtx: ExtensionContext): void => {
47:   void configureObservabilityImpl(pi, ctx, extCtx);
```

Publish không kiểm tra sau hai `await` boundary (`observability.ts:99-113`).
Chỉ OTLP continuation có guard (`:132`); `:148/176` publish `heartbeatWatcher`
không guard; `lifecycle.ts:119-142` cùng dạng.

**Probe** (dispose ngay sau configure không await — đúng pattern
`lifecycle-handlers.ts:310`): continuation publish
`metricRegistry, eventMetricSub, metricSink, heartbeatWatcher` + một interval
sống + **14 event-bus subscription** **sau khi cleanup đã return**.
Interleaving A-init → cleanup → B-init để lại **4 object orphaned**. Flip
`isCleanedUp` true→false qua gap (đúng thứ tự thật: cleanup set true, session_start
reset ở `lifecycle-handlers.ts:232`) **vẫn** publish đủ 4 tài nguyên.

**Test gap:** `register-observability-lifecycle.test.ts` pass (1/1) nhưng
**vacuous** — `assert.ok(totalSubscriptions() > 0)` được thỏa mãn đồng bộ bởi
RPC subs (28 lúc register), và `assert.equal(totalSubscriptions(), 0)` được
assert **trước khi** init fire-and-forget publish.

### F12 — Hook observability tích lũy context cũ — VERIFIED (mạnh hơn)

`observability.ts:184-191` (đăng ký trong `configureObservability`, chạy mỗi
`session_start`):

```ts
184: deps.pi.on?.("before_agent_start", () => {
185:   if (deps.isCleanedUp()) return;
187:   deps.reconcileStaleRuns(ctx.cwd, deps.getManifestCache(ctx.cwd), extractSessionId(ctx));
```

`disposeObservability` (`:298-322`) dispose watcher/timer/sink/sub/exporter/registry
nhưng **không gỡ hook**. `pi.on` không có đường unregister trong `src/`
(không có `pi.off`). `lifecycle-handlers.ts:232`: `ctx.cleanedUp = false` mỗi session.

**Probe:** session A → 1 hook; dispose → **vẫn 1**; session B → **2**; một turn
trong B kích **2 callback reconcile** (`cwd=…A sid=sess-A` và `cwd=…B sid=sess-B`).

**Mạnh hơn review:** wiring `getManifestCache` thật cho thấy hook cũ **đổi
ngược cwd của shared cache** về thư mục session cũ
(`context-builder.ts:123-131`), và dispose cache của session hiện tại như tác
dụng phụ. Số hook tăng một lần mỗi switch.

### F13 — Session switch gỡ RPC/cache nhưng không khôi phục — VERIFIED

Cài một lần lúc registration (`register.ts:89`:
`installCrossExtensionWiring(pi, ctx);`). Gỡ trong session-switch cleanup
(`runtime-cleanup.ts:96,107-108`):

```ts
96: uninstallCrewGlobalRegistry();
107: ctx.rpcHandle?.unsubscribe();
108: ctx.rpcHandle = undefined;
```

`installCrossExtensionWiring` có **đúng một** call site, chỉ tới từ
`registerPiTeams` lúc extension load; `session_start` không gọi lại.
Cache: `context-builder.ts:123-134` giữ `cacheCwd`, không reset;
`run-snapshot-cache.ts:1145-1149` `dispose()` không set cờ `disposed`.

**Probe** (`registerPiTeams` thật + lifecycle events):

```text
S1 start: 4 pi-crew:rpc:* subscription
sau switch: 0
S2 start (cùng cwd): 0 rpc subs (22 subs khác)
```

→ RPC chết vĩnh viễn suốt vòng đời process, `rpc:ping/run/status/live-control`
ngừng hoạt động sau lần switch đầu tiên. Cache: sau `dispose()` + re-request
cùng cwd, `manifestCache`/`runSnapshotCache` **identity-equal** với instance đã
dispose (`true`/`true`).

### F14 — Preload polling vô hiệu dừng render khi idle — VERIFIED

`lifecycle-handlers.ts:727-731`:

```ts
727: buildFrame()
728:   .then((ok) => {
729:     preloading = false;
730:     if (ok) ctx.renderScheduler?.schedule();
```

`buildFrame` trả `true` mỗi khi `ctx.currentCtx` tồn tại (`:684,:721`) — không
so sánh dữ liệu. `render-scheduler.ts:142-154`: `schedule()` luôn reset
`lastEventAt`, `idleFallbackRenders = 0`, và re-arm `fallbackTimer` — tức re-arm
vòng lặp mà `fallbackLoop()` (`:115-140`) vừa dừng có chủ đích.

**Probe** (cửa sổ idle 12 s, default `maxIdleFallbackRenders=8`, `fallbackMs=1000`):

```text
scheduler đơn lẻ          → 8 render rồi dừng hẳn
có preload wiring thật    → 11 render và vẫn tiếp tục
```

Test hiện có `render-scheduler.test.ts:166-214` chạy scheduler với
`events: undefined` và không có caller preload → không bao giờ thấy lỗi này.

### F15 — Worker chờ semaphore không hủy được ngay — VERIFIED

`semaphore.ts:27-49`: `async acquire(): Promise<void>` — **không** tham số
signal, không abort listener. `global-worker-cap.ts:70-72`:
`acquireWorkerSlot()` → `await semaphore.acquire()`. `run-worker.ts:72-77`: signal
nằm trong `childPiInput`, chỉ được đọc sau khi acquire resolve.

**Probe:**

```text
Semaphore.prototype.acquire.length === 0
Cap=1, A giữ slot; B abort ở 20 ms → tại +300 ms B CHƯA settle
B chỉ settle khi A nhả ở +300 ms
acquire() trả về ở +303 ms với signal.aborted === true   ← slot cấp cho task đã cancel
```

`Promise.race` duy nhất trong path liên quan là `run-coalesced-task-group.ts:270`,
race *heartbeat drain*, không phải semaphore.

**Chi tiết:** `budget-enforcement.ts:93-100` là `drainPendingUnits`, không phải
path acquire — nó **xác nhận** chứ không gây ra lỗi.

### F16 — Grandchild không chuyển running nên nesting tiếp bị từ chối — VERIFIED

Admission yêu cầu `running` (`crew-broker.ts:1444-1450`):

```ts
1444: if (task.status !== "running") {
1445:   this.recordDelegateEvent(fresh.manifest, "delegate.rejected", parentTaskId, {
1446:     subId, reason: "parent-not-running",
1450:   return { code: "bad-params" as const, message: `delegate: parent task '${parentTaskId}' is ${task.status}, not running` };
```

Shadow tạo ở `queued` (`:1553`). Spawner call (`:1587-1600`) **không** truyền
`onSpawn` (0 hit trong 1583-1600), nên `delegate-spawn.ts:133`
`onSpawn: input.onSpawn` nhận `undefined`. Chuyển trạng thái kế tiếp là terminal
(`:1661-1664` → completed/failed).

**Tìm promoter — không có:** không `onSpawn`, không watcher, không reconcile
chạm `subId`. `stale-reconciler.ts:347-350` chỉ set `cancelled`; `:1947` set
`running` chỉ cho path `wait.resolve` (`waiting → running`) mà shadow không vào.

Identity liên kết thật: `delegate-spawn.ts:126 agentId: input.subId` →
`child-pi-spawn.ts:289 PI_CREW_BROKER_TASK_ID` → `prompt-runtime.ts:455/469`.
Nên `delegate.request` của grandchild depth-2 đến với `conn.taskId === subId` →
admission đọc shadow `queued` → **từ chối `parent-not-running`**.

**Hiệu chỉnh số dòng:** terminal flip là **1658-1669** (không phải 1658-1668).

### F17 — Verification prompt mâu thuẫn — PARTIAL

Xem hiệu chỉnh **C1** ở mục 3. Mâu thuẫn, thiếu provenance, `tee`/`pipefail`,
wildcard cleanup đều xác nhận:

- Provenance: `grep -n "version|env|sha|git|HEAD" agents/verifier.md` → **0 hit**;
  rule `:47` "If you already have a cached log, READ it" không ràng buộc
  commit/command/env. `.crew/cache` hiện có 51 log, gồm **7 `verify-test-*.log`**.
- `tee`: `bash -c 'false | tee /dev/null; echo $?'` → `0`; với `pipefail` → `1`;
  `grep -rn pipefail` toàn repo → 0 hit.
- Wildcard `:42` `rm -f .crew/cache/verify-test-*.log` khớp **mọi** log verifier
  trong thư mục chứng minh đang chứa nhiều log như vậy.

### F18 — `test:changed` bỏ qua thay đổi chưa commit — VERIFIED

`scripts/test-changed.mjs:54-55`:

```js
54: const mergeBase = git("merge-base HEAD origin/main 2>/dev/null || true");
55: diffArgs = mergeBase ? `diff --name-only ${mergeBase} HEAD` : `diff --name-only HEAD~1 HEAD`;
```

Mapping chỉ nhận `src/**/*.ts` (`:79-81`). Fallback 3 file broker (`:126-129`).

**Probe** (repo git tạm, `origin/main` = HEAD):

| Kịch bản | Quan sát |
|---|---|
| cây sạch | `(changed files: none (clean tree?))` |
| **unstaged** sửa `src/foo.ts` | `(changed files: none (clean tree?))` — bị bỏ qua |
| **staged** cùng sửa | `(changed files: none (clean tree?))` — bị bỏ qua |
| commit trên branch | `running 1 test file(s)` → `test/unit/foo.test.ts` |
| chỉ đổi `test/unit/foo.test.ts` | fallback, **không chạy test nào** |

Fallback = 3 file, trong khi `test:critical` (`package.json:86`) liệt kê **14**
file → xác nhận "không phải toàn bộ `test:critical`".

**Chi tiết thêm:** (a) nhánh không-phải-git-repo (`:110-116`) chạy **1** file
nhưng in "falling back to test:critical subset"; (b) `:85` là dead code
(`find src -name "*.test.ts"` → rỗng); (c) không CI job nào gọi `test:changed`.

### F19 — Smoke argv không kiểm tra argv đã dựng — VERIFIED (mạnh hơn)

`test/smoke/argv-flags.smoke.ts:33-38` dựng `built.args`; `:41-51` chỉ assert
membership; binary thật chỉ được gọi ở `:57`:

```ts
57: const spec = getPiSpawnCommand(["--version"]);
58: const out = execFileSync(spec.command, spec.args, {
```

`built.args` không bao giờ được truyền cho spawn nào.

**Probe (mạnh hơn review — tiền đề của test sai):**

```text
["--version","--definitely-not-a-flag"] => EXIT 0, out: "0.85.1"
["--definitely-not-a-flag"]             => EXIT 1 | stderr: "Error: Unknown option: --definitely-not-a-flag"
```

`--version` **không validate flag** — nên kể cả nếu append `built.args` vào
`--version`, flag sai vẫn pass. Test **không bao giờ** bắt được regression mà nó
được viết ra để bắt.

**Skip gating:** `_helpers.ts:48-52` `smokeSkipReason()` trả `SMOKE_SKIP_NO_AUTH`
khi `MODEL_AUTH_AVAILABLE` false. Probe không auth:

```text
ok 1 - ... # SKIP smoke tests require a real model/API key ...
# pass 0  # fail 0  # skipped 1        EXIT=0
```

`weekly-smoke.yml` **không có** tham chiếu `secrets.*` nào (0 hit); `env:` chỉ
set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` và `PI_CREW_SMOKE: "1"`. Comment của
chính workflow (`:8-12`) nói argv test "does NOT need LLM credentials" — code
không hiện thực hóa phân biệt đó.

### F20 — Benchmark harness chấp nhận không judge — VERIFIED

`benchmark-runner.ts:163`: `passed: judgeResults.every((j) => j.passed)` —
`every()` trên `[]` là `true`. Allowlist `:53`:
`/^(pytest|grep|npm test|cargo test|cargo clippy|echo) /` — có **dấu cách cuối**,
nên literal phải có ký tự theo sau.

**Probe** (`runBenchmark` thật):

```text
EMPTY-JUDGE passed = true   judgeResults = []
CMD "npm test"      passed=false out="Command not allowed: npm test. Only pytest, grep, npm test, cargo test/clippy, echo allowe"
CMD "npm test -- x" passed=false out="spawnSync npm ETIMEDOUT"   ← validation QUA, fail ở execution
CMD "echo hi"       passed=true  out="hi\n"
```

Thông báo lỗi tự mâu thuẫn: từ chối `npm test` trong khi liệt kê `npm test` là
được phép. `package.json:31` `files` chứa `"!src/benchmark"`; `npm pack --dry-run`
→ **0** entry `src/benchmark`; `grep -c "Command not allowed" dist/index.mjs` → **0**;
chỉ có reference ngoài module là `test/unit/benchmark.test.ts`.

## 5. Xác minh mục 6 của review (kiểm chứng/CI)

| Claim | Verdict | Bằng chứng |
|---|---|---|
| Hai unit test fail tồn tại | VERIFIED | `test/unit/interrupt-guard-ack.test.ts`, `test/unit/runtime/broker/crew-broker-symlink-steering.test.ts` đều tồn tại |
| `check:env-vars` có hai raw env read | VERIFIED | `knowledge-injection.ts:466` (`PI_CREW_KIND`), `stale-reconciler.ts:287` (`PI_CREW_DEBUG_STALE`) |
| Concurrency clamp trên 2 xuống 2 | VERIFIED | `test-runner.mjs:81-84` |

**Hiệu chỉnh thêm về concurrency clamp:** review chỉ nói "nên làm hành vi này rõ
ràng". Thực tế comment (`test-runner.mjs:79-80`) nói "Local dev is unaffected
(developers pass `--test-concurrency=4` explicitly)" là **sai**: `finalArgs.map`
clamp *mọi* `--test-concurrency>2` bất kể môi trường, nên local explicit 4 cũng
bị clamp còn 2.

## 6. Vấn đề mới phát hiện khi xác minh

Không nằm trong review gốc; mức độ chưa được xác minh end-to-end.

1. **F16 — rủi ro scheduler kề bên (chưa chứng minh):** shadow grandchild có
   `dependsOn: []` và **không có `stepId`/`agent`** (khác mọi task thật). Probe
   trên scheduler primitive thật: `getReadyTasks` trả shadow là DAG-ready
   (`["01_explore","02_exec","gc-abc"]`) trong khi `taskGraphSnapshot().ready`
   loại nó. Shadow **có thể** vào `ctx.tasks` (`merge-loop.ts:95/118` rebuild
   `ctx.tasks` từ `disk.tasks` dưới lock; `mergeTaskUpdatesPreservingTerminal`
   giữ record `gc-*`). Nếu bị chọn vào batch, `dispatch-batch.ts:718 findStep()`
   throw `ResourceNotFound` trên `task.stepId === undefined` (và `findAgent` ở
   `:719` cho `agent: "delegate"`), tại `:681/695` **không có try/catch**. Cần
   xác minh riêng khả năng chạm end-to-end.

2. **F11 test pass vacuous** — xem F11.

3. **F08 không thể tự sửa** — `updateConfig` throw trên file quá hạn; xem F08.

4. **F18 nhánh non-git chạy 1 file** trong khi in "test:critical subset".

5. **Comment cũ tại `post-execution.ts:619`** tham chiếu `runLockHeldByUs`, biến
   không còn tồn tại trong source.

6. **Comment gây nhầm tại `crew-broker.ts:1652-1657`** nói terminal flip tồn tại
   để tránh `queued` tồn đọng — thực tế cửa sổ `queued` là **toàn bộ** thời gian
   thực thi của grandchild.

## 7. Phạm vi chưa được chứng minh

- Chưa sửa bất kỳ finding nào.
- Chưa chạy full suite; các kết luận quyết định bởi sự kiện control-flow vô điều
  kiện (một call site, một producer, field vắng trong object literal) hoặc bởi
  probe trên module thật.
- Chưa xác nhận chất lượng model thật, provider latency, hay chi phí end-to-end.
- F02: chưa dựng repro runtime đầy đủ (cần hai async context độc lập gọi
  `withRunLock` cùng run trong khi context đầu đang await).
- F03: mức độ ảnh hưởng thực tế phụ thuộc `workspaceMode: "worktree"` có được
  coi là hỗ trợ chính thức hay không.
- F16 rủi ro scheduler kề bên: chưa xác minh reachability end-to-end.
- Chưa chạy multi-platform hay terminal surface E2E.

## 8. Đề xuất bước tiếp theo

**Không có finding nào bị REFUTED**, nên lộ trình trong review (mục 8) vẫn hợp
lệ. Hai điều chỉnh thứ tự ưu tiên dựa trên kết quả xác minh:

1. **F04 nên lên ngang F01/F05 trong Đợt 1** — đây là mất mát dữ liệu kết quả
   *tất định*, không xác suất: task `completed` không có artifact, và headless
   redeploy từ chối phục hồi. Fix tối thiểu: spread `child.surfaceLost` (và
   `rawFinalText`) vào literal `execResult` tại `task-runner.ts:208-220`; regression
   test phải đi qua `runTeamTask`, không qua finalizer trực tiếp.

2. **F13 RPC teardown** là phá vỡ chức năng vĩnh viễn sau lần session switch đầu
   tiên (đã xác minh end-to-end), nên xếp cùng nhóm session-switch với F11/F12
   (session-generation ownership token + hook unregistration).

3. **F01** cần structured return (`{ ok, truncated: string[] }`) chứ không phải
   `boolean`, vì mất mát không giới hạn ở phần đuôi >256 KiB (entry không đọc
   được biến mất hoàn toàn).

4. **F17** cần quy tắc precedence giữa agent body và workflow verify step, và
   sửa lại phần gán vị trí command hardcode cho đúng `workflows/*.workflow.md`.

**Bằng chứng tái hiện:** mỗi finding đã có probe kèm trong mục 4. Có thể dùng
trực tiếp làm regression test, lưu ý các probe dùng `strace` cần thay bằng
monkey-patch ở lớp atomic-write (không patch được `node:fs` ESM export) hoặc
đếm qua wrapper nội bộ.
