# RR-012 — F03+F16: Vòng đời delegation (execution cwd + promote grandchild)

- **Lane:** high-risk — **chờ phê duyệt của người** trước khi triển khai
  (`docs/FEATURE_INTAKE.md` → High-Risk: "Ask human confirmation before implementation")
- **Status:** planned
- **Đợt:** 1 (bảo vệ dữ liệu và kết quả) — không phụ thuộc story nào (plan §2.4)
- **Ngày tạo:** 2026-09-17
- **Baseline:** `pi-crew@0.11.1`, commit `0b9fa771`. Mọi số dòng trong packet ứng
  với commit này (review đã ghi rõ: cần kiểm tra lại khi mã thay đổi).
- **Nguồn:**
  - `docs/superpowers/plans/2026-09-17-review-remediation.md` §2.3, §2.4, §5 (RR-012), §6
  - `docs/archive/2026-09-17-pi-crew-review.md` — F03 (Cao), F16 (Vừa)
  - `docs/archive/2026-09-17-pi-crew-review-verification.md` — F03, F16 (VERIFIED),
    hiệu chỉnh **C3**, mục **6.1** (rủi ro scheduler kề bên — CHƯA xác minh), §7
  - `docs/FEATURE_INTAKE.md` — lane + risk checklist
  - `docs/decisions/2026-08-17-governed-nesting.md` (ADR-5) — hợp đồng thiết kế
    đã sinh ra `delegate` tool + shadow task; là nguồn chuẩn cho §1/§3/§4/§6
  - `docs/TEST_MATRIX.md` — hàng "Delegate mọi role (D8)"

## 1. Vấn đề trong một câu

Broker `delegate` ghi shadow task theo `task.cwd` nhưng **spawn grandchild bằng
cwd của broker**, nên một delegated executor có thể chạy ngoài worktree đã được
admission kiểm tra (F03); đồng thời shadow task không bao giờ được promote
`running`, nên grandchild depth-2 **không thể** delegate tiếp depth-3 dù policy
cho phép (F16).

## 2. Nguồn gốc và mức độ

| Mục | Giá trị |
|---|---|
| F03 — verdict xác minh | VERIFIED (phương pháp: truy vết tĩnh) |
| F16 — verdict xác minh | VERIFIED (phương pháp: truy vết tĩnh) |
| Mức trong review | F03: Cao · F16: Vừa |
| Hiệu chỉnh quan trọng | **C3** — đường lệch cwd là thật, nhưng **mọi builtin team đều khai `workspaceMode: single`**; cần `workspaceMode: "worktree"` tường minh. Đây là exposure **opt-in**, không phải mặc định. |
| Rủi ro mới (mục 6.1 của verification) | Shadow có `dependsOn: []`, **không** có `stepId` (nhưng **có** `agent: "delegate"`) → `getReadyTasks` có thể trả nó là DAG-ready; nếu lọt vào batch thì `dispatch-batch.ts:718 findStep()` throw (và `findAgent` ở `:719` cho `agent: "delegate"`). **CHƯA xác minh end-to-end** — xem §7 (AC-8). |

## 3. Vì sao high-risk

Plan §2.3 xếp cả hai finding vào lane high-risk; hard gate trong
`docs/FEATURE_INTAKE.md` → Classification:

- **F03** — Child process spawning + Security (ranh giới isolation giữa
  worktree đã admission và leader workspace) + State mutation.
- **F16** — Child process spawning + State mutation (vòng đời record
  `queued → running → terminal`) + Backward compat (ý nghĩa status của record
  `gc-*` hiển thị trong `team status` đổi).

Plan §6 liệt kê rủi ro chính của RR-012: **"Thoát workspace đã admission;
nesting bị từ chối"**.

### Risk flags (theo `docs/FEATURE_INTAKE.md` → Risk Checklist)

Hợp của hai finding (số flag từng finding lấy nguyên từ plan §2.3):

| Risk flag | F03 | F16 | Ghi chú |
|---|:-:|:-:|---|
| State mutation | ● | ● | `saveRunTasks` cho shadow record (`crew-broker.ts:1544-1601`) |
| Concurrency | | | `withRunLockSync` bao admission + roll-up; promote thêm một write site dưới cùng lock |
| Child process | ● | ● | `spawnDelegateGrandchild` → `runChildPi` (`delegate-spawn.ts:114-120`, `onSpawn` ở `:133`) |
| Error handling | | ● | Spawner throw / settle `ok:false` phải terminalize shadow |
| External tools | ● (git) | | Overlap/serialization là cơ chế chống va chạm write-path |
| API contract | | | `GrandchildSpawnInput` shape — additive |
| Platform | | | Không chạm path Windows-specific |
| Backward compat | | ● | Shadow chuyển qua `running` (visible trong `team status`); nếu thêm field discriminator thì phải additive + dual-read |
| Dependencies | | | Không thêm package |
| Security | ● | | Isolation: grandchild executor chạy sai workspace |
| **Tổng** | **4** | **4** | hard gate → **high-risk** |

## 4. Affected Modules

- `src/runtime/broker/crew-broker.ts` — handler `delegate.request`:
  - `:1394` — `const cwd = this.options.cwd;` (broker cwd, nguồn gây F03)
  - `:1444-1450` — admission yêu cầu `task.status === "running"` (nguồn gây F16)
  - `:1457-1463` — overlap check `t.cwd === task.cwd`
  - `:1544-1601` — vùng shadow record (literal `status: "queued"` ở `:1553`;
    `agent: "delegate"` và `cwd: task.cwd` cùng nằm trong literal)
  - `:1587-1600` — call `spawner({ cwd, ... })`, **không** truyền `onSpawn`
  - `:1652-1657` — comment nói terminal flip tồn tại để tránh `queued` tồn đọng
  - `:1658-1669` — terminal flip khi spawner settle
- `src/runtime/delegate-spawn.ts` — `spawnDelegateGrandchild`:
  - `:99` — `artifactsRoot` suy từ `input.cwd`
  - `:114-115` — `runChildPi({ cwd: input.cwd, … })`; `onSpawn: input.onSpawn` ở `:133`
  - `grandchildArtifactsRoot()` — helper export (khai báo ngay trên `spawnDelegateGrandchild`), hiện **không** được `spawnDelegateGrandchild` dùng → nguy cơ drift
- `src/runtime/child-pi/child-pi.ts:415` — `cwd: input.cwd` truyền tiếp xuống surface/spawn
- `src/runtime/task-runner/pre-execution.ts:143-149` (dòng cwd là `:146` — `cwd: workspace.cwd`) và `src/worktree/worktree-manager.ts:1043,1088-1089` — chứng minh `task.cwd` **là** worktree path khi bật worktree mode
- `src/extension/registration/lifecycle-handlers.ts:1125` — wiring production `cwd: process.cwd()` (broker cwd = host session cwd)
- `src/runtime/scheduling/task-graph.ts` — `getReadyTasks()` (selector DAG, nguồn rủi ro scheduler chưa xác minh)
- `src/runtime/scheduling/task-graph-scheduler.ts` — `taskGraphSnapshot()` / `refreshTaskGraphQueues()` (selector **khác**, loại shadow)
- `src/runtime/merge-loop.ts:95,118` — rebuild `ctx.tasks` từ `disk.tasks`
- `src/runtime/dispatch-batch.ts:681,695,718,719` — `findStep()`/`findAgent()` (unguarded tại `:681`/`:695`)
- `src/runtime/spawn-policy.ts` — `evaluateDelegateAdmission` (không sửa; dùng để chứng minh depth-3 được phép theo policy)
- `test/unit/runtime/broker/`, `test/integration/` — nơi đặt test mới
- `docs/decisions/` — decision record / amendment ADR-5 (bắt buộc cho high-risk)

## 5. Acceptance Criteria

Mọi AC phải kiểm được bằng test tự động, **không cần model thật**: dùng
`grandchildSpawner` inject (tiền lệ `test/unit/runtime/broker/delegate-broker.test.ts`)
và fixture scaffold (`handleTeamTool` với `runtime.mode: "scaffold"`).

**Nhóm A — execution cwd (F03)**

- **AC-1.** Broker cwd ≠ parent task cwd: injected spawner nhận
  `cwd === task.cwd` (worktree path đã admission), **không** phải broker cwd.
  Test khẳng định trên tham số spawner, không cần model.
- **AC-2.** Artifacts root của grandchild nằm dưới **cùng** cwd đó:
  `artifactsRoot === grandchildArtifactsRoot(<task.cwd>, runId, parentTaskId, subId)`
  và thư mục được tạo trên đĩa dưới `<task.cwd>/.crew/artifacts/...`, không phải
  dưới broker cwd.
- **AC-3.** cwd dùng cho **ba** việc — overlap check, shadow record, spawner
  input — là **một nguồn duy nhất** (giá trị admission trả về). Test: broker cwd
  ≠ task cwd, có executor khác đang `running` tại `task.cwd` → delegate bị từ
  chối (`workspace-conflict`); nếu executor kia ở broker cwd → được admit.
- **AC-4.** Không đổi hành vi khi `workspaceMode: "single"` (mặc định của mọi
  builtin team — hiệu chỉnh C3): broker cwd == task cwd ⇒ spawner nhận đúng giá
  trị như trước.

**Nhóm B — promote & terminalize shadow (F16)**

- **AC-5.** Shadow được promote `running` **khi spawn bắt đầu**: với spawner
  pending (không bao giờ resolve), sau `delegate.admitted` đọc `tasks.json` ⇒
  record `gc-*` có `status === "running"` (không còn `"queued"`).
- **AC-6.** Grandchild depth-2 (đang `running`) gửi `delegate.request` bằng
  identity `subId` ⇒ **không** bị từ chối với `reason: "parent-not-running"`.
  Nếu vượt `maxDepth` thì lỗi phải là `policy-denied` / `depth-exceeded`
  (đúng policy), không phải `bad-params`.
- **AC-7.** Shadow terminalize trong **mọi** outcome: spawner resolve `ok:true`
  → `completed`; resolve `ok:false` → `failed`; spawner **throw** → `failed`.
  Không có outcome nào để record ở `queued`/`running` sau khi spawner settle.
- **AC-8.** (verification-first) Có bằng chứng kết luận **có/không** chạm được
  đường scheduler: shadow record bị `getReadyTasks` trả là DAG-ready và lọt vào
  batch ⇒ `dispatch-batch.ts:718 findStep()` throw `ResourceNotFound`.
  AC này pass **chỉ khi** có kết luận kèm bằng chứng (test tái hiện, **hoặc**
  lập luận + test chứng minh không chạm được). Không được đánh dấu "đã xác minh"
  nếu chưa có một trong hai.
- **AC-9.** (chỉ khi AC-8 kết luận "chạm được") Có guard fail-closed: shadow
  record bị loại khỏi batch selection bằng một discriminator tường minh; test RED
  (throw `ResourceNotFound`) trước fix, GREEN sau fix, và run không abort.

**Nhóm C — không hồi quy**

- **AC-10.** Các test delegation hiện có giữ nguyên kết quả:
  `test/unit/runtime/broker/delegate-broker.test.ts` (6 test),
  `test/integration/delegate-roundtrip-e2e.test.ts` (2 test),
  `test/unit/runtime/spawn-policy.test.ts`,
  `test/unit/runtime/scheduling/nested-slots-deadlock.test.ts`,
  `test/unit/runtime/child-pi/child-pi-env-spread.test.ts`.
- **AC-11.** Gate consistency xanh: `npm run typecheck`, `npm run lint`,
  `npm run format:check`, `npm run check:decision-drift`,
  `npm run check:event-types` (nếu thêm event mới), `npm run check:wc-gate`.

## 6. Out of scope

- Ma trận admission của spawn-policy (trust/depth/slots/budget/model/timeout/
  workspace) — **không** đổi `evaluateDelegateAdmission`; chỉ truyền đúng dữ liệu
  vào nó.
- Cấp phát token broker cho grandchild (ADR-5 §4, S1#1) — không đổi
  `issueRunToken`/`issueForChild`.
- Durable delivery kết quả qua mailbox, fence/sanitize, roll-up budget
  (ADR-5 §1/§5) — không đổi.
- Đổi `workspaceMode` mặc định của team, hay bật worktree mode mặc định.
- Comment cũ `team-tool-schema.ts:166` ("Worktree mode is planned after MVP") —
  đúng là đã cũ (C3) nhưng là doc-only, xử lý ở bước riêng.
- Semaphore/nested-slot abort semantics (F15) — **RR-014**.
- Run lock theo async context (F02) — **RR-011**.
- `surfaceLost` / kết quả qua ranh giới branch (F04) — **RR-013**.

## 7. Rủi ro chưa xác minh (đọc trước khi lên kế hoạch)

Mục **6.1** của báo cáo xác minh ghi một rủi ro **mới**, chưa được chứng minh
end-to-end. Toàn bộ nội dung dưới đây là **giả thuyết cần kiểm chứng**, không
phải sự thật đã kiểm:

1. Shadow record có `dependsOn: []`, **không** có `stepId` (nhưng **có**
   `agent: "delegate"` — xem literal tại `crew-broker.ts:1544-1558`).
2. Probe trên scheduler primitive thật cho thấy `getReadyTasks` (task-graph.ts)
   trả shadow là DAG-ready, trong khi `taskGraphSnapshot().ready`
   (task-graph-scheduler.ts) **loại** nó ⇒ hai selector không đồng nhất.
3. Shadow **có thể** vào `ctx.tasks` (`merge-loop.ts:95,118` rebuild từ
   `disk.tasks` dưới lock; `mergeTaskUpdatesPreservingTerminal` giữ record `gc-*`).
4. Nếu bị chọn vào batch: `dispatch-batch.ts:718 findStep()` throw
   `ResourceNotFound` trên `task.stepId === undefined` (và `findAgent` ở `:719`
   cho `agent: "delegate"`), tại `:681`/`:695` **không có** try/catch.

Điều cần xác minh riêng: **reachability end-to-end** — một tick scheduler thật
có thực sự nhìn thấy shadow record ở trạng thái `queued` (tức trước khi
`onSpawn` promote hoặc trước khi terminal flip) hay không.

## 8. Dependencies

| Phụ thuộc | Loại | Lý do |
|---|---|---|
| **RR-015** (F05 — CI integrity) | Mềm | `scripts/test-runner.mjs:142` trả exit 0 khi coordinator bị kill ⇒ mọi kết luận "xanh" của RR-012 chưa hoàn toàn đáng tin cho tới khi RR-015 xong (plan §6 lý do #2). |
| **RR-014** (F15 — semaphore abort) | Mềm | RR-014 chạm `withWorkerSlot`/slot accounting; grandchild spawn **bypass** cap nên hai bên chỉ giao nhau ở shape của facade `runWorker`. Nếu RR-014 đổi shape đó, RR-012 phải rebase. |
| **RR-013** (F04 — kết quả qua ranh giới branch) | Không | Khác hoàn toàn đường mã (`task-runner.ts`), nhưng cùng đợt 1 và cùng dùng fixture `handleTeamTool`; nên làm RR-013 trước (plan §6 đề xuất RR-013 đầu tiên). |
| ADR-5 (`docs/decisions/2026-08-17-governed-nesting.md`) | Bắt buộc | Là hợp đồng thiết kế của chính vùng mã này; fix phải khớp §1 (delivery durable), §3 (depth từ record), §4 (creds theo subId), §6 (namespaced artifacts) và ghi thành **amendment** hoặc ADR mới. |

## 9. Tài liệu liên quan

- `docs/stories/RR-012/design.md` — defect + hướng sửa + phương án bị loại
- `docs/stories/RR-012/exec-plan.md` — các bước RED-first + điểm rollback
- `docs/stories/RR-012/validation.md` — thang kiểm chứng + ánh xạ AC→proof + gaps
- `docs/decisions/2026-08-17-governed-nesting.md` — ADR-5 (nơi ghi amendment)
- `docs/stories/RR-014/overview.md` — tiền lệ high-risk folder trong đợt này
- `docs/TEST_MATRIX.md` — thêm hàng khi story đóng
