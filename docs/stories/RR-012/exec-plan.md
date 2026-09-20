# RR-012 — Exec plan: vòng đời delegation (cwd + promote)

- **Story:** `docs/stories/RR-012/overview.md` · **Design:** `docs/stories/RR-012/design.md`
- **Lane:** high-risk — **chờ phê duyệt của người trước bước 1**
- **Nguyên tắc chung** (plan §3): regression test trước, sửa sau; fail-closed cho
  mọi nhánh không xác định; không nới lỏng durability; mọi thay đổi high-risk
  phải có decision record.

## Ghi chú về nguồn "probe" của story này

Khác F01/F02/F05/F07, **F03 và F16 được xác minh bằng truy vết tĩnh**
(verification §2 bảng tổng: "Phương pháp: truy vết tĩnh"), không có probe chạy
được kèm theo. Vì vậy:

- "Seed regression test" của F03/F16 là **các khẳng định rút ra từ truy vết**
  (broker cwd ≠ task cwd ⇒ spawner nhận sai cwd; shadow `queued` ⇒ admission từ
  chối `parent-not-running`), chuyển thành test với **injected spawner** — tiền lệ
  đã có sẵn trong `test/unit/runtime/broker/delegate-broker.test.ts` (fixture
  `scaffoldRunningTask` + `startBroker({ spawner })`).
- Chỉ **rủi ro scheduler** (verification §6.1) có probe thật trên scheduler
  primitive, với output `getReadyTasks` trả `["01_explore","02_exec","gc-abc"]`.
  Output đó là seed cho bước 1.
- Không dùng model thật, không cần socket ngoài; mọi test chạy trong `/tmp` với
  `.git` marker (bài học bug-029 — xem `test/fixtures/test-tempdir.ts`).

## Bảng bước

| # | Mục tiêu | Test file | RED trước | Command |
|---|---|---|---|---|
| 1 | Kết luận reachability của rủi ro scheduler | `test/unit/runtime/scheduling/shadow-task-dag-readiness.test.ts` (mới) | ✗ characterization (pass ngay, đóng băng hành vi) | `node scripts/test-runner.mjs test/unit/runtime/scheduling/shadow-task-dag-readiness.test.ts` |
| 2 | Đóng băng F03: spawner nhận sai cwd | `test/unit/runtime/broker/delegate-execution-cwd.test.ts` (mới) | ✔ | `node scripts/test-runner.mjs test/unit/runtime/broker/delegate-execution-cwd.test.ts` |
| 3 | Đóng băng F16: shadow không promote | `test/unit/runtime/broker/delegate-shadow-lifecycle.test.ts` (mới) | ✔ | `node scripts/test-runner.mjs test/unit/runtime/broker/delegate-shadow-lifecycle.test.ts` |
| 4 | Fix F03 (authoritative cwd) | (2) chuyển GREEN | — | như bước 2 |
| 5 | Fix F16 (promote + terminalize) | (3) chuyển GREEN | — | như bước 3 |
| 6 | Fix rủi ro scheduler (**CHỈ** nếu bước 1 kết luận "chạm được") | (1) chuyển GREEN | — | như bước 1 |
| 7 | Regression + gates + decision record | (1)(2)(3) + suite hiện có | — | xem §7 |

---

## Bước 0 — Chuẩn bị (không sửa `src/`)

1. Xác nhận baseline: `git log -1 --format=%H` phải là `0b9fa771` hoặc một
   descendant; nếu khác, **kiểm tra lại mọi số dòng** trong `design.md` trước khi
   viết test (review đã cảnh báo: "Số dòng tham chiếu ứng với commit được review;
   cần kiểm tra lại khi mã thay đổi").
2. Đọc lại 2 test hiện có để tái dùng fixture, **không** tạo fixture mới:
   - `test/unit/runtime/broker/delegate-broker.test.ts` — `scaffoldRunningTask()`,
     `startBroker({ spawner })`, `sendDelegate()`, `readEventsUntil()`.
   - `test/integration/delegate-roundtrip-e2e.test.ts` — roundtrip qua socket thật.
3. Xác nhận chưa có test nào phủ tổ hợp "broker cwd ≠ task cwd":
   `rg -n "cwd" test/unit/runtime/broker/delegate-broker.test.ts` — review §3 (F03)
   ghi rõ test hiện tại "bắt spawn arguments nhưng kiểm tra depth, không kiểm tra
   cwd khác nhau".
4. **Rollback point R0** = commit hiện tại (chưa có gì thay đổi). Mọi bước sau
   rollback về đây bằng `git checkout -- <files>` / revert commit của bước.

---

## Bước 1 — (VERIFICATION-FIRST) Kết luận reachability của rủi ro scheduler

**Mục tiêu:** trả lời có/không chạm được `dispatch-batch.ts:718 findStep()`.
Không sửa `src/` ở bước này, trừ khi kết luận là "chạm được" (khi đó tách sang
bước 6).

**Test file mới:** `test/unit/runtime/scheduling/shadow-task-dag-readiness.test.ts`

**Seed (từ verification §6.1):** probe trên scheduler primitive thật cho thấy
`getReadyTasks` trả shadow là DAG-ready — `["01_explore","02_exec","gc-abc"]` —
trong khi `taskGraphSnapshot().ready` loại nó.

**Nội dung test (RED-first, đóng băng hành vi hiện tại):**

1. **1a — selector parity.** Dựng mảng `TeamTaskState[]` gồm 2 task thật
   (`dependsOn: []`, có `stepId`) + 1 shadow record theo đúng literal
   `crew-broker.ts:1544-1558` (`id: "gc-abc"`, `role: "explorer"`,
   `agent: "delegate"`, `status: "queued"`, `dependsOn: []`, `depth: 2`,
   **không** `stepId`). Assert:
   - `getReadyTasks(tasks, N)` (`src/runtime/scheduling/task-graph.ts`) **có**
     `gc-abc` ⇒ khoá hành vi "DAG-ready".
   - `taskGraphSnapshot(tasks).ready` (`src/runtime/scheduling/task-graph-scheduler.ts`)
     — ghi lại kết quả quan sát được (kỳ vọng: **có** `gc-abc`, vì
     `withQueue()` xét `status === "queued"` + `dependsOn` rỗng; nếu kết quả
     khác, ghi lại và **không** sửa test cho khớp suy đoán).
   - Ghi rõ trong comment test: khác biệt giữa hai selector (nếu có) là
     **phát hiện**, không phải bug cần fix ở bước này.
2. **1b — `findStep()` throw.** Gọi trực tiếp đường dispatch với shadow record
   trong batch để chứng minh `findStep()` throw. Cách làm:
   - Nếu `findStep` không export: tái hiện qua `selectDispatchBatch` +
     `dispatchBatch` với `SchedulerContext` tối thiểu (theo mẫu các test trong
     `test/unit/runtime/scheduling/`), **hoặc** test cấp thấp hơn bằng cách dựng
     `WorkflowConfig` rồi assert rằng lookup
     `workflow.steps.find((c) => c.id === task.stepId)` với `task.stepId === undefined`
     trả `undefined` ⇒ nhánh throw `ResourceNotFound` trong `findStep()` chạy.
     Chọn cách **thấp hơn** nếu dựng `SchedulerContext` đầy đủ là quá nặng; ghi rõ
     trong test rằng đây là proof cấp thấp (không phải end-to-end).
   - Assert lỗi có `code === ErrorCode.ResourceNotFound` (đúng như `findStep()`
     ném: `new CrewError(ErrorCode.ResourceNotFound, \`Workflow step '${task.stepId}' not found for task '${task.id}'.\`)`).
3. **1c — reachability end-to-end (câu trả lời chính).** Kiểm tra xem một tick
   scheduler thật **có** nhìn thấy shadow ở trạng thái `queued`/`running` không:
   - Đọc `src/runtime/merge-loop.ts:95,118` (rebuild `ctx.tasks` từ `disk.tasks`)
     và `mergeTaskUpdatesPreservingTerminal` — xác nhận record `gc-*` được giữ.
   - Viết test dùng run fixture có shadow record **đang tồn tại** và gọi
     `selectDispatchBatch(ctx)`; assert `ctx.tasks` (và do đó `batch`) có/không
     chứa `gc-*`.
   - **Nếu test không dựng được** (thiếu fixture/hạ tầng): ghi kết luận vào
     `validation.md` mục "Known gaps" là **CHƯA kết luận**, kèm lý do cụ thể.
     Không được đánh dấu AC-8 pass.

**Command:**

```bash
node scripts/test-runner.mjs test/unit/runtime/scheduling/shadow-task-dag-readiness.test.ts
```

**Kết quả mong đợi của bước 1:** test **pass** ở dạng characterization (đóng băng
hành vi hiện tại) — bước này không cần RED vì nó không sửa gì. Nếu một assert
mong đợi "throw" mà không throw, đó là dữ liệu mới: cập nhật `design.md` §3.1 và
`validation.md`.

**Kết luận phải ghi vào `validation.md` §"Kết luận bước 1":**

- (a) `getReadyTasks` có trả shadow không? → …
- (b) `taskGraphSnapshot` có trả shadow không? → …
- (c) shadow có vào `ctx.tasks` trong tick thật không? → …
- (d) `findStep()` có bị gọi với shadow không? → …
- (e) **Kết luận: chạm được / không chạm được / chưa kết luận** + bằng chứng.

**Rollback point R1** = R0 + test file (chỉ test, không sửa `src/`).

---

## Bước 2 — RED: F03, spawner nhận sai cwd

**Test file mới:** `test/unit/runtime/broker/delegate-execution-cwd.test.ts`

**Fixture (copy pattern, không copy file):** `scaffoldRunningTask` + `startBroker`
từ `delegate-broker.test.ts`, nhưng **thay đổi quan trọng**: parent task có
`cwd` **khác** broker cwd.

```text
brokerCwd  = <tmp>/leader            (truyền vào startBroker({ cwd: brokerCwd }))
task.cwd   = <tmp>/leader/.worktrees/<taskId>   (ghi trực tiếp vào tasks.json)
```

Cả hai thư mục đều nằm trong temp tree có `.git` marker. Parent task vẫn phải
`status: "running"`, `depth: 1`, và có `allocation` nếu test truyền `budgetTokens`.

**Assertions (RED trước fix):**

| # | Assert | Trước fix | Sau fix |
|---|---|---|---|
| 2a | `spawns[0].cwd === task.cwd` | ✗ (nhận `brokerCwd`) | ✓ |
| 2b | `spawns[0].cwd !== brokerCwd` | ✗ | ✓ |
| 2c | `grandchildArtifactsRoot(task.cwd, runId, parentTaskId, subId)` tồn tại trên đĩa | ✗ | ✓ |
| 2d | `fs.existsSync(path.join(brokerCwd, ".crew", "artifacts", runId, parentTaskId, "nested"))` **không** tồn tại | ✗ | ✓ |
| 2e | Fenced result vẫn tới mailbox của **parent task** (không hồi quy delivery) | ✓ | ✓ |
| 2f | Event `delegate.admitted` + `delegate.completed` vẫn phát | ✓ | ✓ |

Với 2c/2d: nếu dùng injected spawner thì `spawnDelegateGrandchild` (nơi tạo
`artifactsRoot`) **không** chạy. Có hai cách, chọn một và ghi rõ trong test:
- **(i)** gọi thẳng `spawnDelegateGrandchild({ cwd, ... })` với `runChildPi` mock
  (`PI_TEAMS_MOCK_CHILD_PI=json-success` + `PI_CREW_ALLOW_MOCK=1`) và assert thư
  mục artifacts — kiểm được cả `:99`;
- **(ii)** assert `grandchildArtifactsRoot()` là hàm **duy nhất** sinh công thức
  (test cấu trúc: đọc source, đếm occurrence của `".crew", "artifacts"` trong
  `delegate-spawn.ts`) — rẻ, nhưng yếu hơn.
Khuyến nghị **(i)** cho 2c/2d, **(ii)** làm assert bổ sung.

**Command:**

```bash
node scripts/test-runner.mjs test/unit/runtime/broker/delegate-execution-cwd.test.ts
```

**RED kỳ vọng:** 2a/2b/2c/2d fail; 2e/2f pass. Nếu 2a pass ngay, fixture đang
đặt `task.cwd === brokerCwd` — sửa fixture (đây chính là lý do test cũ không bắt
được F03).

**Rollback point R2** = R1 + test file.

---

## Bước 3 — RED: F16, shadow không promote `running`

**Test file mới:** `test/unit/runtime/broker/delegate-shadow-lifecycle.test.ts`

**Fixture:** như bước 2 nhưng `task.cwd === brokerCwd` (cô lập biến — mỗi test
chỉ kiểm một defect); parent `status: "running"`, `depth: 1`.

**Spawner dùng cho test:** deferred promise (pattern `slowSpawner` trong
`delegate-broker.test.ts`), để quan sát được trạng thái **trong lúc** spawn đang
chạy.

**Assertions (RED trước fix):**

| # | Assert | Trước fix | Sau fix |
|---|---|---|---|
| 3a | Trong lúc spawner pending: record `gc-*` có `status === "running"` | ✗ (`queued`) | ✓ |
| 3b | Sau khi spawner resolve `ok:true`: `gc-*` `status === "completed"` | ✓ | ✓ |
| 3c | Spawner resolve `ok:false`: `gc-*` `status === "failed"` | ✓ | ✓ |
| 3d | Spawner **throw**: `gc-*` `status === "failed"` (không kẹt `queued`) | ✓ (đã có try/catch) | ✓ |
| 3e | Grandchild depth-2 gửi `delegate.request` bằng identity `subId` → **không** nhận `bad-params` với message chứa `parent-not-running` | ✗ | ✓ |
| 3f | Nếu `nestingMaxDepth: 2` và depth-2 delegate: lỗi là `policy-denied` / `depth-exceeded` (không phải `parent-not-running`) | ✗ | ✓ |
| 3g | Task thật **chưa** `running` vẫn bị từ chối `parent-not-running` (cổng không bị nới) | ✓ | ✓ |
| 3h | Event `delegate.rejected` với `reason: "parent-not-running"` vẫn phát cho 3g | ✓ | ✓ |

**Chi tiết 3e/3f (quan trọng):** để depth-2 delegate được, broker phải cấp
`grandchildCreds` — điều kiện `childDepth < nestingMaxDepth` ở `:1571-1574`.
Vậy fixture cần `nestingMaxDepth: 3` (hoặc cao hơn) để depth-2 nhận token; khi đó
depth-3 mới là hop bị chặn bởi policy. Test 3f dùng `nestingMaxDepth: 2` để
chứng minh thông điệp lỗi đúng loại.

Cách mô phỏng "grandchild depth-2 gửi delegate": tạo một `RawClient` thứ hai,
`hello(client2, runId, subId, tokenCủaSubId)` rồi `sendDelegate(client2, {...})`.
Token lấy từ broker (nếu cần) hoặc chỉ cần assert **loại lỗi** — nếu `hello`
thất bại vì lý do khác, ghi rõ trong test và dùng assert thay thế
(`delegate.rejected` event với `reason` tương ứng).

**Command:**

```bash
node scripts/test-runner.mjs test/unit/runtime/broker/delegate-shadow-lifecycle.test.ts
```

**RED kỳ vọng:** 3a, 3e, 3f fail; 3b/3c/3d/3g/3h pass (khoá hành vi hiện có).

**Rollback point R3** = R2 + test file.

---

## Bước 4 — Fix F03 (authoritative execution cwd)

**File sửa:** `src/runtime/broker/crew-broker.ts`, `src/runtime/delegate-spawn.ts`

**Thay đổi tối thiểu:**

1. Trong `withRunLockSync` admission, sau khi có `task`, tính
   `const executionCwd = task.cwd;` — dùng **chính biến này** cho:
   - overlap check (`:1457-1463`) — thay `task.cwd` bằng `executionCwd` (không
     đổi giá trị, chỉ làm nguồn duy nhất tường minh),
   - shadow record `cwd:` (`:1553-1554`).
2. Trả `executionCwd` trong object kết quả `{ code: "ok", decision, reserved }`
   → `{ code: "ok", decision, reserved, executionCwd }`.
3. Destructure ở call site: `const { decision, reserved, executionCwd } = admissionOutcome;`
4. Trong `spawner({ ... })` (`:1587-1588`): `cwd: executionCwd` (thay vì `cwd`).
   **Không** đổi các chỗ `loadRunManifestById(cwd, runId)` — broker cwd vẫn dùng
   cho manifest lookup/ownership.
5. Trong `delegate-spawn.ts:99`, thay công thức inline bằng
   `grandchildArtifactsRoot(input.cwd, input.runId, input.parentTaskId, input.subId)`
   — một công thức duy nhất (helper đã export sẵn ở `:96`).

**Command:**

```bash
node scripts/test-runner.mjs test/unit/runtime/broker/delegate-execution-cwd.test.ts
npm run typecheck
```

**GREEN kỳ vọng:** bước 2 toàn bộ pass; `npm run typecheck` pass.

**Regression ngay sau fix (chạy trước khi sang bước 5):**

```bash
node scripts/test-runner.mjs test/unit/runtime/broker/delegate-broker.test.ts
```

**Rollback point R4** = commit riêng cho fix F03 (revert được độc lập với F16).

---

## Bước 5 — Fix F16 (promote + terminalize shadow)

**File sửa:** `src/runtime/broker/crew-broker.ts`

**Thay đổi tối thiểu:**

1. Thêm hàm nội bộ `promoteShadowToRunning(runId, subId)` (hoặc inline trong
   callback) chạy dưới `withRunLockSync`, `loadRunManifestById` lại, map record
   `gc-*` → `status: "running"`, `saveRunTasks`. Idempotent (nếu đã terminal thì
   không hạ cấp về `running`).
2. Truyền `onSpawn` vào `spawner({...})` (`:1587-1600`):
   - `onSpawn: (pid) => { if (pid !== null) promoteShadowToRunning(runId, subId); }`
   - Guard `pid !== null`: `delegate-spawn.ts:133` chuyển tiếp `input.onSpawn`
     xuống `runChildPi`; `onSpawn` được gọi khi process đã spawn.
3. Giữ nguyên `try/catch` hiện có (`:1593-1595`) và terminal flip **vô điều kiện**
   (`:1658-1669`) — không thêm guard theo `reserved` (comment ở `:1652-1657` đã
   cảnh báo guard đó từng làm mọi shadow kẹt `queued`).
4. Cập nhật comment `:1652-1657` cho đúng sự thật sau fix: cửa sổ `queued` giờ
   chỉ là khoảng giữa `saveRunTasks` shadow và `onSpawn`; trong lúc grandchild
   chạy, record là `running`.

**Command:**

```bash
node scripts/test-runner.mjs test/unit/runtime/broker/delegate-shadow-lifecycle.test.ts
npm run typecheck
```

**GREEN kỳ vọng:** bước 3 toàn bộ pass.

**Regression ngay sau fix:**

```bash
node scripts/test-runner.mjs test/unit/runtime/broker/delegate-broker.test.ts test/integration/delegate-roundtrip-e2e.test.ts
```

Lưu ý: `delegate-roundtrip-e2e.test.ts` hiện assert `shadow!.status === "completed"`
sau roundtrip — vẫn đúng sau fix (terminal flip không đổi). Nếu test này đỏ, dừng
và điều tra trước khi tiếp tục.

**Rollback point R5** = commit riêng cho fix F16.

---

## Bước 6 — Fix rủi ro scheduler (CHỈ khi bước 1 kết luận "chạm được")

Nếu bước 1 kết luận **không chạm được**: đóng băng test 1a/1b làm characterization
(đã có), ghi kết luận + bằng chứng vào `validation.md`, **bỏ qua bước này**, và
đánh dấu AC-8 pass / AC-9 N/A.

Nếu **chạm được**, chọn **một** hướng và ghi vào decision record:

- **(A) Discriminator tường minh.** Thêm field additive (ví dụ
  `managedBy?: "workflow" | "delegate-broker"`) trên shadow record; loại record
  `managedBy === "delegate-broker"` khỏi batch selection **trước** `findStep()`
  (đúng một chỗ, ở `selectDispatchBatch`).
  - Ưu: ý định rõ ràng, không phụ thuộc `agent: "delegate"` (có thể trùng tên agent thật).
  - Nhược: +1 field schema (additive, dual-read).
- **(B) Dùng dấu sẵn có.** Loại record `id.startsWith("gc-")` hoặc
  `agent === "delegate"`.
  - Ưu: không đổi schema.
  - Nhược: ngầm định; `gc-` là convention chứ không phải contract.
- **(C) Guard tại chỗ gọi.** Bọc `findStep()`/`findAgent()` trong
  `try/catch` và skip unit lỗi.
  - **KHÔNG chọn**: nuốt lỗi, vi phạm nguyên tắc 4 của plan ("Fail-closed cho mọi
    nhánh không xác định"). Ghi vào "Alternatives rejected" của decision record.

**Test phải chuyển GREEN:** `shadow-task-dag-readiness.test.ts` — bổ sung assert
"shadow **không** lọt vào `batch`" và "run không abort".

**Command:**

```bash
node scripts/test-runner.mjs test/unit/runtime/scheduling/shadow-task-dag-readiness.test.ts
```

**Rollback point R6** = commit riêng cho guard scheduler (có thể revert mà không
ảnh hưởng R4/R5).

---

## Bước 7 — Regression, gates, harness delta

**Thứ tự chạy (dừng ngay khi đỏ):**

```bash
# 1. Typecheck (quick)
npm run typecheck

# 2. Targeted — 3 test mới
node scripts/test-runner.mjs test/unit/runtime/broker/delegate-execution-cwd.test.ts test/unit/runtime/broker/delegate-shadow-lifecycle.test.ts test/unit/runtime/scheduling/shadow-task-dag-readiness.test.ts

# 3. Vùng delegation hiện có (unit)
node scripts/test-runner.mjs test/unit/runtime/broker/delegate-broker.test.ts test/unit/runtime/spawn-policy.test.ts test/unit/runtime/scheduling/nested-slots-deadlock.test.ts test/unit/runtime/child-pi/child-pi-env-spread.test.ts test/unit/runtime/broker/crew-broker-handshake.test.ts

# 4. Critical gate (14 file)
npm run test:critical

# 5. Integration (plan §4: F03, F16 thuộc nhóm cần integration)
npm run test:integration

# 6. Lint + format
npm run lint && npm run format:check

# 7. Gates consistency (chạm src/, có thể chạm event/ADR)
npm run check:decision-drift
npm run check:event-types
npm run check:lazy-imports
npm run check:wc-gate

# 8. Unit full
npm run test:unit

# 9. Bundle (bắt buộc: dist/index.mjs là bundle mặc định từ v0.9.17)
npm run build:bundle && npm run test:bundle

# 10. Full gate trước publish
npm run ci
```

**Bước 7 kèm harness delta:**

1. `docs/decisions/<YYYY-MM-DD>-delegate-execution-cwd-and-shadow-lifecycle.md`
   (hoặc amendment trong `docs/decisions/2026-08-17-governed-nesting.md`) — stub
   ở `design.md` §7.
2. `docs/decisions/README.md` — thêm hàng index.
3. `docs/TEST_MATRIX.md` — hàng RR-012 (Status `implemented` sau khi có evidence).
4. `docs/stories/RR-012/validation.md` — điền mục Evidence + kết luận bước 1.
5. `docs/stories/README.md` — chuyển RR-012 sang trạng thái tương ứng.
6. Nếu sửa `teams/`, `workflows/`, hay resource nào có `postinstall` copy
   (`SKILL.md`): chạy `npx pi install .` để resource mới có hiệu lực.

**Gate đã biết đang đỏ (không thuộc story này — không được coi RR-012 là "xanh"
nếu chúng còn đỏ, plan §4):**

- `test/unit/interrupt-guard-ack.test.ts` — flaky trong full suite, pass khi chạy riêng.
- `test/unit/runtime/broker/crew-broker-symlink-steering.test.ts` — trả
  `request-timeout` thay vì `ok: true` (cả full suite và chạy riêng).
- `npm run check:env-vars` fail: `src/extension/knowledge-injection.ts:466`
  (`PI_CREW_KIND`), `src/runtime/stale-reconciler.ts:287` (`PI_CREW_DEBUG_STALE`).

**Lưu ý môi trường (từ `.crew/knowledge.md`):** khi chạy gate từ **bên trong** một
pi-crew worker, phải scrub `PI_CREW_*` trước khi đánh giá assert "absence":

```bash
env -u PI_CREW_SCRATCHPAD -u PI_CREW_TASK_ID -u PI_CREW_ATTEMPT \
    -u PI_CREW_ARTIFACTS_ROOT -u PI_CREW_SCRATCHPAD_SNAPSHOT \
    -u PI_CREW_BROKER_TASK_ID -u PI_CREW_BROKER_RUN_ID \
    node scripts/test-runner.mjs <file>
```

**Rollback point R7** = commit cuối (gồm cả doc). Toàn bộ story rollback được
bằng cách revert R4 → R5 → R6 (theo thứ tự ngược) vì mỗi bước là một commit riêng.

---

## Bảng rollback tổng hợp

| Point | Nội dung | Cách rollback |
|---|---|---|
| R0 | Baseline `0b9fa771` | — |
| R1 | + test scheduler (không sửa `src/`) | xoá file test |
| R2 | + test F03 | xoá file test |
| R3 | + test F16 | xoá file test |
| R4 | Fix F03 (`crew-broker.ts`, `delegate-spawn.ts`) | `git revert <R4>` — độc lập |
| R5 | Fix F16 (`crew-broker.ts`) | `git revert <R5>` — độc lập với R4 |
| R6 | Guard scheduler (nếu cần) | `git revert <R6>` — độc lập |
| R7 | Docs + TEST_MATRIX + ADR | revert commit doc (không ảnh hưởng runtime) |

**Ràng buộc:** R4 và R5 cùng chạm `src/runtime/broker/crew-broker.ts` ⇒ nếu hai
người/worker làm song song, **một owner duy nhất cho file này** (xem `AGENTS.md`
→ conflict-safe task splitting). Ưu tiên tuần tự R4 → R5 như trên.
