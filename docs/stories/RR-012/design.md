# RR-012 — Design: vòng đời delegation (cwd + promote)

- **Story:** `docs/stories/RR-012/overview.md`
- **Lane:** high-risk
- **Status:** planned — **chờ phê duyệt của người**
- **Baseline:** `pi-crew@0.11.1`, commit `0b9fa771`
- **Nguồn số dòng:** `docs/archive/2026-09-17-pi-crew-review-verification.md` §4 (F03, F16)
  và `docs/archive/2026-09-17-pi-crew-review.md` §3 (F03), §4 (F16).
  Mọi số dòng dưới đây lấy **nguyên** từ hai tài liệu đó (đã đối chiếu lại khi đọc
  mã ở commit hiện tại), không suy diễn thêm.

## 1. F03 — Defect: broker spawn grandchild bằng cwd của broker

### 1.1 Luồng dữ liệu thật

```text
lifecycle-handlers.ts:1125   cwd: process.cwd()        ← broker cwd = host session cwd
        │
        ▼
crew-broker.ts:1394          const cwd = this.options.cwd;
        │
        ├─▶ :1457-1463  overlap check:  t.cwd === task.cwd   ← dùng task.cwd
        ├─▶ :1553-1554  shadow record:  cwd: task.cwd        ← dùng task.cwd
        └─▶ :1587-1588  spawner({ cwd, ... })                ← dùng BROKER cwd  ✗
                │
                ▼
delegate-spawn.ts:99         artifactsRoot = join(input.cwd, ".crew", "artifacts", …)
delegate-spawn.ts:114-115    runChildPi({ cwd: input.cwd, … })
        │
        ▼
child-pi.ts:415              cwd: input.cwd
child-pi-spawn.ts:226        spawn()   ← không lớp nào chuẩn hóa lại
```

Trích nguyên văn từ verification §4 (F03):

```ts
1394: const cwd = this.options.cwd;
```

```ts
1587: outcome = await spawner({
1588:   cwd,
```

`onSpawn` vắng mặt (0 hit trong dải 1583-1600). Và `delegate-spawn.ts:114-115`
dùng trực tiếp `input.cwd`.

### 1.2 Vì sao `task.cwd` khác broker cwd (không chỉ trên lý thuyết)

Verification §4 (F03) chỉ ra hai dòng chứng minh:

- `pre-execution.ts:146` — `cwd: workspace.cwd` (task được ghi bằng workspace cwd).
- `worktree-manager.ts:1043,1088-1089` — ở worktree mode, `workspace.cwd` **là**
  worktree path.

Nên khi parent task đã được admission vào worktree riêng rồi gọi `delegate`,
`task.cwd` = `<worktree path>` còn `cwd` (broker) = host session cwd. Grandchild
được spawn ở host cwd.

**Hiệu chỉnh C3 (bắt buộc đọc kèm):** đường lệch là thật, nhưng **mọi builtin
team đều khai `workspaceMode: single`** (`teams/*.team.md`; `state-store.ts:424`
default `"single"`), nên cần `workspaceMode: "worktree"` **tường minh** để chạm.
Đây là exposure opt-in. Comment `team-tool-schema.ts:166` ("Worktree mode is
planned after MVP") đã cũ.

### 1.3 Hậu quả

- Grandchild (đặc biệt khi được cấp role `executor`) đọc/sửa **checkout khác**
  với workspace đã được admission kiểm tra.
- Overlap check (`:1457-1463`) tính trên `task.cwd` trong khi grandchild chạy ở
  host cwd ⇒ cơ chế chống va chạm write-path (`serializeOnPathOverlap`) và
  rejection `workspace-conflict` **đánh giá sai đối tượng**.
- `delegate-spawn.ts:99` suy `artifactsRoot` từ `input.cwd` ⇒ artifacts của
  grandchild ghi vào leader workspace thay vì namespaced root
  `artifacts/<runId>/<parentTaskId>/nested/<subId>/` mà ADR-5 §6 quy định.
  Lưu ý: helper `grandchildArtifactsRoot()` (khai báo ngay trên
  `spawnDelegateGrandchild` trong cùng file) tồn tại nhưng
  `spawnDelegateGrandchild` **không dùng nó** — hai công thức cùng tồn tại,
  drift chỉ là vấn đề thời gian.

### 1.4 Vì sao guard hiện tại không chặn được

| Guard hiện có | Vì sao không đủ |
|---|---|
| Overlap check `t.cwd === task.cwd` (`:1457-1463`) | So sánh trên `task.cwd`; grandchild thực tế chạy ở broker cwd ⇒ so sai bên |
| `nesting.enabled` + trust gate (`spawn-policy`) | Chỉ kiểm "có được delegate hay không", không kiểm "chạy ở đâu" |
| `workspace-conflict` (ADR-5 §9 erratum) | Đếm executor overlap trên `task.cwd`; không thấy grandchild ở broker cwd |
| `workspaceMode: single` mặc định (C3) | Thu hẹp exposure nhưng **không** là guard: worktree mode là opt-in hợp lệ, không phải cấu hình sai |
| Không lớp nào normalize lại cwd trên đường spawn | Verification §4: "Không lớp nào chuẩn hóa lại" |

### 1.5 Hướng sửa được chọn

**Authoritative execution cwd trả về từ admission, và truyền đúng giá trị đó
sang spawner.** Cụ thể:

1. Trong `withRunLockSync` admission (dải từ guard `:1444-1450` tới
   `saveRunTasks` shadow ở `:1545-1558`), sau khi
   tìm thấy `task`, tính **một** biến `executionCwd = task.cwd` (giá trị mà
   overlap check và shadow record đã dùng).
2. Trả `executionCwd` trong `admissionOutcome` (cùng chỗ trả `decision`,
   `reserved`).
3. Call site `spawner({...})` (`:1587-1588`) truyền `cwd: executionCwd`.
4. Giữ `this.options.cwd` cho **manifest lookup** (`loadRunManifestById(cwd, runId)`)
   và các thao tác ownership khác — đúng như review đề xuất: "Giữ broker/root cwd
   riêng cho manifest lookup và artifact ownership, không đổi một biến dùng chung
   một cách cơ học."
5. Trong `delegate-spawn.ts`: dùng `grandchildArtifactsRoot(input.cwd, runId,
   parentTaskId, subId)` thay cho công thức inline ở `:99` — một nguồn duy nhất
   cho công thức artifacts.

Không cần đổi shape `GrandchildSpawnInput` (đã có field `cwd`) — chỉ đổi **giá
trị** truyền vào. Đây là lý do fix nhỏ về bề mặt dù hệ quả lớn.

**Phương án bị loại:**

| Phương án | Lý do loại |
|---|---|
| Đổi `const cwd = this.options.cwd` thành `task.cwd` ngay tại `:1394` | Không được: `cwd` còn dùng cho `loadRunManifestById(cwd, conn.runId)` ở ngay dưới (`:1401+`) và cho các lần `loadRunManifestById(cwd, runId)` trong roll-up. Đổi một biến dùng chung sẽ phá manifest lookup — đúng cái review cảnh báo. |
| Thêm tham số `cwdOverride` vào `GrandchildSpawnInput` và giữ `cwd` cũ | Hai field mang cùng ngữ nghĩa ⇒ drift tương lai; không giải quyết artifacts root (`:99` vẫn dùng field nào?). |
| Resolve worktree path trong `delegate-spawn.ts` (đọc manifest lại) | Thêm một lần đọc state trên đường spawn ngoài run lock ⇒ race với merge-loop; và biến spawner thành stateful trong khi hợp đồng của nó hiện là "spawn theo input". |
| Chặn delegate khi `task.cwd !== this.options.cwd` (fail-closed đơn giản) | Vô hiệu hoá delegation đúng lúc cần nhất (worktree mode), và biến một bug isolation thành feature removal. Không chọn. |
| Bật `workspaceMode: single` bắt buộc (cấm worktree) | Cắt tính năng để che bug; review/plan không đề xuất. |

## 2. F16 — Defect: shadow không bao giờ được promote `running`

### 2.1 Admission yêu cầu `running`, shadow tạo `queued`

Verification §4 (F16) trích admission (`crew-broker.ts:1444-1450`):

```ts
1444: if (task.status !== "running") {
1445:   this.recordDelegateEvent(fresh.manifest, "delegate.rejected", parentTaskId, {
1446:     subId, reason: "parent-not-running",
1450:   return { code: "bad-params" as const, message: `delegate: parent task '${parentTaskId}' is ${task.status}, not running` };
```

Shadow record (`:1544-1558`, dòng `status` là `:1553`):

```ts
1553: status: "queued",
```

Spawner call (`:1587-1600`) **không** truyền `onSpawn` (0 hit trong 1583-1600),
nên `delegate-spawn.ts:133` `onSpawn: input.onSpawn` nhận `undefined`. Chuyển
trạng thái kế tiếp là terminal (`:1658-1669` → `completed`/`failed`).

### 2.2 Không tồn tại promoter nào

Verification §4 (F16) đã **tìm** promoter và kết luận không có:

- Không `onSpawn`, không watcher, không reconcile nào chạm `subId`.
- `stale-reconciler.ts:347-350` chỉ set `cancelled`.
- `stale-reconciler.ts:1947` set `running` **chỉ** cho path `wait.resolve`
  (`waiting → running`) mà shadow không đi vào.

### 2.3 Vì sao lỗi quan sát được (identity binding)

Verification §4 (F16) truy vết identity:

```text
delegate-spawn.ts:126  agentId: input.subId
   → child-pi-spawn.ts:289  PI_CREW_BROKER_TASK_ID
   → prompt-runtime.ts:455/469
```

Nên `delegate.request` của grandchild depth-2 đến với `conn.taskId === subId`;
admission đọc shadow record `queued` ⇒ **từ chối `parent-not-running`** — dù
grandchild có broker credentials và `maxDepth` cho phép.

**Comment gây nhầm (verification §6.6):** `crew-broker.ts:1652-1657` nói terminal
flip tồn tại để tránh `queued` tồn đọng; thực tế cửa sổ `queued` là **toàn bộ**
thời gian thực thi của grandchild.

### 2.4 Hậu quả

- Nesting sâu hơn 2 hop bị chặn vĩnh viễn ở mọi cấu hình (kể cả khi user đã
  raise `nesting.maxDepth` — đó là lý do ADR-5 §3/§4 coi depth-3 là "genuinely
  reachable" khi raise maxDepth, B3 case (d)).
- Bất đối xứng: policy (`spawn-policy`) **cho phép** depth-3, nhưng admission
  **từ chối** vì lý do không liên quan tới policy (`parent-not-running`). Lỗi
  trả về là `bad-params` — thông điệp sai bản chất, gây nhiễu khi debug.
- Record `gc-*` xuất hiện trong `team status` ở trạng thái `queued` trong suốt
  thời gian grandchild chạy ⇒ observability sai.

### 2.5 Hướng sửa được chọn

**Broker sở hữu trọn vòng đời của shadow record.**

1. **Promote khi spawn bắt đầu:** truyền `onSpawn` vào spawner — hiện
   `delegate-spawn.ts:133` đã có `onSpawn: input.onSpawn`, chỉ cần broker cung
   cấp callback. Callback (chạy dưới run lock, một write site duy nhất) set
   `status: "running"`, `startedAt` đã có từ `:1557`.
   - Vị trí đặt promote phải **sau** `saveRunTasks` shadow (không phải trước) và
     **trước** khi spawner thực sự `spawn()`.
   - Promote phải idempotent: spawner có thể gọi `onSpawn(null)` khi spawn fail
     (`GrandchildSpawnInput.onSpawn?: (pid: number | null) => void`) — promote
     chỉ khi `pid !== null`, hoặc promote không điều kiện nhưng terminal flip
     sau đó luôn thắng.
2. **Terminalize mọi outcome:** `:1658-1669` đã flip terminal **vô điều kiện**
   cho `ok`/`!ok`; bổ sung nhánh `catch` của spawner (`:1601-1603` hiện đã bọc
   `try/catch` và tạo `outcome = { ok: false, resultText: … }`) ⇒ vẫn đi tới flip
   terminal. Cần test riêng cho "spawner throw" để khoá hành vi này.
3. **Phân biệt shadow do external spawner quản lý với task do workflow scheduler
   quản lý** (review đề xuất tường minh). Đây là điểm nối sang rủi ro scheduler
   chưa xác minh — xem §3.

**Phương án bị loại:**

| Phương án | Lý do loại |
|---|---|
| Nới admission: chấp nhận `queued` cho parent | Nới lỏng một cổng an toàn dùng chung cho **mọi** task (kể cả task workflow thật chưa chạy) để che một record ghi sai. Không chấp nhận được ở lane high-risk. |
| Promote ngay trong `withRunLockSync` admission (trước khi spawn) | Shadow sẽ `running` kể cả khi spawner chưa hề chạy ⇒ heartbeat/staleness coi là worker sống trong khi chưa có process nào; vi phạm semantics "running = có worker". |
| Thêm watcher/reconcile quét `gc-*` để promote | Thêm tầng polling cho một transition đã biết chính xác thời điểm; và một reconciler đặt `running` là chính xác cái mà `stale-reconciler.ts:347-350` cố tình không làm. |
| Bỏ hẳn shadow record, chỉ dùng depth/role từ parent | Phá ADR-5 amendment S1#1 (unbounded-chain escalation fix): grandchild phải được role/depth-check từ record **của chính nó**. |
| Đặt `status: "running"` ngay trong literal `saveRunTasks` (`:1553`) | Che được F16 nhưng làm shadow "đang chạy" trước khi slot/spawn xảy ra, và không giải quyết rủi ro scheduler (§3) — vẫn là record `gc-*` không `stepId`/`agent` lọt vào selector, chỉ đổi trạng thái. |

## 3. Rủi ro scheduler kề bên — CHƯA XÁC MINH

Đây là mục **6.1** của báo cáo xác minh, tác giả ghi rõ "mức độ chưa được xác
minh end-to-end". **Không được trình bày phần này như sự thật đã kiểm.**

### 3.1 Chuỗi giả thuyết

1. Shadow record (`:1544-1558`) có `dependsOn: []` và **không** có `stepId`
   (nhưng **có** `agent: "delegate"`) — khác mọi task thật.
2. Probe trên scheduler primitive thật: `getReadyTasks` trả shadow là DAG-ready
   (`["01_explore","02_exec","gc-abc"]`) trong khi `taskGraphSnapshot().ready`
   loại nó ⇒ **hai selector không đồng nhất**.
   - `src/runtime/scheduling/task-graph.ts` — `getReadyTasks(plan, completedIds)`
     dựa trên `dependsOn`; task `dependsOn: []` vào wave 0 ⇒ ready.
   - `src/runtime/scheduling/task-graph-scheduler.ts` — `withQueue()` xét
     `task.status === "queued"` + `dependencySatisfied`; shadow `queued` +
     `dependsOn: []` cũng thành `ready` **nếu** record nằm trong danh sách.
     (Điểm này cần đo lại: kết luận "loại nó" trong probe là về
     `taskGraphSnapshot()` trên tập task của **run thật**, không phải về
     `withQueue` trên một mảng chứa shadow.)
3. Shadow **có thể** vào `ctx.tasks`: `merge-loop.ts:95/118` rebuild `ctx.tasks`
   từ `disk.tasks` dưới lock; `mergeTaskUpdatesPreservingTerminal` giữ record
   `gc-*`.
4. Nếu bị chọn vào batch: `dispatch-batch.ts:718 findStep()` throw
   `ResourceNotFound` trên `task.stepId === undefined` (và `findAgent` ở `:719`
   cho `agent: "delegate"`), tại `:681`/`:695` **không có try/catch**.

Trích mã liên quan đã đọc (dùng cho bước verify, không phải kết luận):

```ts
// dispatch-batch.ts:228-235
function findStep(workflow: WorkflowConfig, task: TeamTaskState): WorkflowStep {
	const step = workflow.steps.find((candidate) => candidate.id === task.stepId);
	if (!step)
		throw new CrewError(ErrorCode.ResourceNotFound, `Workflow step '${task.stepId}' not found for task '${task.id}'.`)
```

```ts
// dispatch-batch.ts:715-719 (singleton dispatch path)
const task = batchTasks.find((t) => t.id === unit.taskId)!;
const step = findStep(workflow, task);
const agent = findAgent(input.agents, task);
```

### 3.2 Điều phải làm trong exec-plan

Việc **đầu tiên** của RR-012 là trả lời câu hỏi reachability, không phải sửa.
Bước 1 của `exec-plan.md` là một test đóng băng (characterization) kết luận
"chạm được / không chạm được" kèm bằng chứng. Chỉ khi kết luận là "chạm được"
thì AC-9 mới có hiệu lực và fix mới được thiết kế.

Cách fail-closed nếu **có** chạm: thêm discriminator tường minh trên record
(ví dụ field additive `managedBy: "delegate-broker"` hoặc dùng chính
`agent: "delegate"` làm dấu) và **loại** shadow khỏi batch selection ở đúng một
chỗ, trước `findStep()`. Không dùng try/catch quanh `findStep()` để nuốt lỗi —
đó là che triệu chứng và vi phạm nguyên tắc 4 của plan ("Fail-closed cho mọi
nhánh không xác định").

## 4. Data / state implications

| Hạng mục | Thay đổi | Ghi chú |
|---|---|---|
| Shadow record `TeamTaskState` (`gc-*`) | Thêm transition `queued → running` (F16) | Cùng shape; **không** đổi schema file. Status visible trong `team status` ⇒ đổi hành vi quan sát được (đúng ý định). |
| `tasks.json` write sites | +1 write (promote) mỗi lần delegate | Dưới cùng `withRunLockSync` — single-writer; chấp nhận được, nhưng phải đo lại nếu sau này F06 (RR-017) chạm vùng này. |
| `artifactsRoot` của grandchild | Đổi từ `<broker cwd>/.crew/artifacts/...` sang `<task.cwd>/.crew/artifacts/...` | Chỉ khác khi `task.cwd !== broker cwd`. Artifacts cũ (nếu có) **không** migrate — chúng thuộc run đã kết thúc. |
| `delegate.*` events | Không đổi tên/kind | Nếu thêm event cho promote, phải đăng ký trong `TEAM_EVENT_TYPES` (gate `check:event-types`). Ưu tiên **không** thêm event: dùng `delegate.admitted` đã có. |
| Field mới (nếu AC-8 kết luận "chạm được") | Additive, dual-read | Chỉ thêm nếu thực sự cần discriminator. Không đổi `dependsOn` semantics. |

## 5. Backward compat

- **State format:** không đổi. Shadow record đã tồn tại từ ADR-5 S1#1; chỉ đổi
  tập trạng thái mà nó đi qua. Record cũ trong run đang dở (đang `queued`) không
  bị migrate — chúng terminalize theo đường hiện có.
- **API:** `GrandchildSpawnInput` không đổi shape; `GrandchildSpawnResult` không
  đổi. Nếu thêm `onSpawn` vào call site broker, field **đã có** trong interface
  (`onSpawn?: (pid: number | null) => void`) nên không phải breaking.
- **Config:** không thêm key. `nesting.maxDepth` giữ nguyên ngữ nghĩa (F16 fix
  làm cho nó **thực sự** có hiệu lực ở depth ≥ 3 — đây là hành vi được ADR-5 §3
  dự kiến, không phải hành vi mới).
- **`workspaceMode`:** không đổi default. Fix F03 chỉ có tác dụng khi worktree
  mode được bật tường minh (C3).
- **Test cũ:** `delegate-broker.test.ts` fixture gọi broker với `cwd: s.cwd` và
  task có `cwd` do scaffold sinh — hai giá trị **trùng nhau** trong fixture, nên
  các assertion hiện tại không phát hiện được F03 và không nên đỏ sau fix.
  Test "happy path" khẳng định `spawns[0]?.depthOverride === 2`; không assert
  `cwd` ⇒ an toàn.

## 6. Security considerations

1. **Isolation là mục tiêu chính của F03.** Grandchild `executor` chạy ở broker
   cwd có thể sửa leader workspace — vùng mà admission/overlap check **không**
   đánh giá. Fix đưa execution về đúng workspace đã kiểm.
2. **Không nới lỏng cổng nào.** Fix F16 promote `running` **không** bỏ check
   `task.status !== "running"` ở `:1444-1450` — nó chỉ làm cho record phản ánh
   đúng sự thật (có worker đang chạy). Cổng vẫn từ chối task thật chưa chạy.
3. **Token/credential containment không đổi** (ADR-5 §4): grandchild vẫn nhận
   token scope theo `subId`; F16 fix **không** mở thêm đường cấp token. Lưu ý
   hiện `grandchildCreds` chỉ được mint khi `childDepth < nestingMaxDepth`
   (`:1571-1574`) — fix F16 làm đường depth-3 **thực sự chạm tới được**, nên
   đây là lúc phải chạy lại B3 case (c) và (d) của ADR-5 (env containment +
   depth gate "as a real spawn").
4. **Path traversal / symlink:** đổi `artifactsRoot` sang `task.cwd` nghĩa là
   grandchild ghi dưới worktree path. Không thêm bề mặt mới (cùng công thức
   `path.join(cwd, ".crew", "artifacts", …)`), nhưng `task.cwd` phải là giá trị
   **từ record** — không bao giờ nhận cwd từ worker (worker không truyền cwd
   trong `delegate.request` params; xem danh sách `requested` ở `:1385-1393`).
   Test AC-1 phải khẳng định giá trị đến từ record.
5. **Denial observability:** mọi denial vẫn phải phát `delegate.rejected` kèm
   `reason` + `message` (ADR-5 observability note). Fix F16 không được làm mất
   `reason: "parent-not-running"` cho các trường hợp **thật** (task chưa chạy).
6. **Gate bắt buộc khi merge:** ADR-5 §12 — WP-5 PR cần security-reviewer sign-off
   + cold-verifier. Amendment cho RR-012 phải giữ nguyên yêu cầu đó; B3 battery
   là bằng chứng bảo mật, không chỉ CI.

## 7. Decision record — stub cho lúc triển khai

Chưa viết ADR ở bước này (story đang `planned`, chờ phê duyệt). Khi triển khai,
tạo `docs/decisions/<YYYY-MM-DD>-delegate-execution-cwd-and-shadow-lifecycle.md`
theo `docs/templates/decision.md`, hoặc **amendment** trong
`docs/decisions/2026-08-17-governed-nesting.md` nếu chỉ siết lại ý định đã có.

Điền các mục sau:

```markdown
# ADR-N — Delegate execution cwd + shadow lifecycle

## Status
Proposed → Accepted (sau phê duyệt high-risk + security sign-off)

## Context
- F03: broker ghi shadow theo task.cwd nhưng spawn theo broker cwd
  (crew-broker.ts:1394 vs :1553-1554 vs :1587-1588 → delegate-spawn.ts:114-115
  → child-pi.ts:415); artifacts root suy từ broker cwd (delegate-spawn.ts:99);
  overlap check so sai bên (:1457-1463).
- F16: admission yêu cầu running (:1444-1450), shadow tạo queued (:1553),
  không truyền onSpawn (:1587-1600), không promoter nào tồn tại.
- C3: exposure opt-in qua workspaceMode: "worktree".
- Rủi ro scheduler (verification §6.1): CHƯA xác minh — kết luận ở bước 1 exec-plan.

## Decision
- Execution cwd = giá trị admission trả về (task.cwd), dùng cho overlap check,
  shadow record VÀ spawner input; broker cwd giữ cho manifest lookup.
- delegate-spawn.ts dùng grandchildArtifactsRoot() (một công thức duy nhất).
- Shadow promote `running` khi spawn bắt đầu (onSpawn), terminalize mọi outcome.
- [điền] cách phân biệt shadow do external spawner quản lý vs task do workflow
  scheduler quản lý, và guard tương ứng (nếu AC-8 kết luận "chạm được").

## Alternatives Considered
1. Đổi `cwd` tại :1394 → phá manifest lookup.
2. Thêm cwdOverride song song → hai nguồn ngữ nghĩa.
3. Resolve worktree trong delegate-spawn → đọc state ngoài run lock.
4. Nới admission chấp nhận queued → nới cổng an toàn dùng chung.
5. Promote trong admission lock (trước spawn) → running khi chưa có worker.
6. Watcher/reconcile promote → thêm polling cho transition đã biết thời điểm.
7. Bỏ shadow record → phá ADR-5 S1#1 (unbounded-chain fix).

## Consequences
Positive:
- Delegated executor không thoát workspace đã admission.
- depth ≥ 3 hoạt động đúng như ADR-5 §3/§4 dự kiến.
- `team status` phản ánh đúng grandchild đang chạy.
Tradeoffs:
- +1 tasks.json write mỗi delegate (dưới cùng run lock).
- Trạng thái quan sát được của record `gc-*` đổi (queued → running) — cần nêu
  trong release note.
- Nếu phải thêm discriminator: +1 field additive trên TeamTaskState.
```

Cập nhật kèm: `docs/decisions/README.md` (index), `docs/TEST_MATRIX.md` (hàng
RR-012), và nếu có env var mới thì phải xuất hiện trong `src/` (gate
`check:decision-drift` — gate này chỉ scan `docs/decisions/*.md`, bỏ qua ADR có
status `proposed`).

## 8. References

- `docs/stories/RR-012/overview.md` — lane, risk flags, AC
- `docs/stories/RR-012/exec-plan.md` — bước 1 là verify rủi ro scheduler
- `docs/stories/RR-012/validation.md` — thang kiểm chứng + gaps
- `docs/decisions/2026-08-17-governed-nesting.md` — ADR-5 §1/§3/§4/§6/§9 + amendments S1#1
- `docs/archive/2026-09-17-pi-crew-review-verification.md` — §4 (F03, F16), §6.1, §7
- `test/unit/runtime/broker/delegate-broker.test.ts` — fixture + injected spawner pattern
- `test/integration/delegate-roundtrip-e2e.test.ts` — roundtrip thật qua socket
