# RR-013 — Design: bảo toàn execution result qua ranh giới branch

- **Story:** `docs/stories/RR-013/overview.md`
- **Lane:** high-risk
- **Status:** planned — **chờ phê duyệt của người**
- **Baseline:** `pi-crew@0.11.1`, commit `0b9fa771`
- **Nguồn số dòng:** `docs/archive/2026-09-17-pi-crew-review-verification.md` §4 (F04)
  và `docs/archive/2026-09-17-pi-crew-review.md` §3 (F04). Mọi số dòng lấy **nguyên**
  từ hai tài liệu đó (đã đối chiếu lại khi đọc mã ở commit hiện tại), không suy diễn thêm.

## 1. Defect

### 1.1 Producer trả field

`src/runtime/task-runner/child-executor.ts:793-822` là return block của nhánh
degrade (khi `childResult.surface?.degraded`). Verification §4 (F04) trích:

```ts
815: surfaceLost: {
816:   taskId: task.id,
817:   paneId: childResult.surface.paneId,
818:   cause: degraded.cause,
```

`rawFinalText` cũng được producer trả ở return block **chính**
(`child-executor.ts:1096`).

### 1.2 Consumer sẵn sàng nhận field

`src/runtime/task-runner/post-execution.ts`:

- `surfaceLost?: { taskId; paneId; cause: "pane-closed" | "mux-dead"; exitReason; ts }`
  trong interface `TaskExecutionResult`, kèm docstring nói rõ mục đích:
  "When set, {@link finalizeTaskResult} short-circuits into a dedicated degrade
  terminalisation (needs_attention, no fabricated result) INSTEAD of the
  yield/mutation/output guards".
- `:136` — `const rawFinalText = execResult.rawFinalText;`
- `:149-179` — nhánh `if (execResult.surfaceLost) { … }` terminalise
  `needs_attention`, ghi `diagnostics.surfaceLost`, `persistSingleTaskUpdate`
  dưới `withRunLock`, phát `task.surface_lost`, và **return sớm**.
- `:452-458` — footer union dùng `rawFinalText`.

### 1.3 Ranh giới bị đứt

`src/runtime/task-runner.ts` chép tay field theo từng branch. Verification §4 (F04):

> Hand-off bỏ nó — `task-runner.ts:140-153` copy 11 field, không có `surfaceLost`;
> `task-runner.ts:208-220` dựng `execResult` cũng thiếu. `runTeamTask` là **caller
> duy nhất** của `finalizeTaskResult`, nên `post-execution.ts:149` **không thể
> chạm tới trong production**.

Hai vị trí cụ thể (đọc lại ở commit hiện tại):

```ts
// task-runner.ts:139-153 — lấy giá trị RA khỏi child bag
const child = await runChildProcessTask(ctx);
task = ctx.task;
tasks = ctx.tasks;
resultArtifact = child.resultArtifact ?? resultArtifact;
logArtifact = child.logArtifact;
transcriptArtifact = child.transcriptArtifact;
exitCode = child.exitCode;
error = child.error;
modelAttempts = child.modelAttempts;
parsedOutput = child.parsedOutput;
finalStdout = child.finalStdout;
transcriptPath = child.transcriptPath;
terminalEvidence = child.terminalEvidence;
startupEvidence = child.startupEvidence;
```

```ts
// task-runner.ts:206-220 — dựng literal execResult
const execResult: TaskExecutionResult = {
	resultArtifact,
	logArtifact,
	transcriptArtifact,
	exitCode,
	error,
	modelAttempts,
	parsedOutput,
	finalStdout,
	transcriptPath,
	terminalEvidence,
	startupEvidence,
};
```

Đúng 11 field, cả hai chiều. `surfaceLost` và `rawFinalText` **không có** ở đâu
trong `task-runner.ts` (verification §4: "0 occurrence của `rawFinalText`").

### 1.4 Tác giả biết nhánh này tồn tại

`task-runner.ts:120-122` — comment ngay trên khai báo `resultArtifact`:

```ts
// MuxSurface degrade path returns NO result artifact — undefined until a
// branch produces one (finalizeTaskResult's surfaceLost branch ignores it).
```

Comment này chứng minh: (a) tác giả **biết** nhánh `surfaceLost` tồn tại ở
finalizer, (b) biết nó "ignores" `resultArtifact`, và (c) — điểm mấu chốt — vẫn
**không** chuyển field `surfaceLost` vào `execResult`. Đây là lý do defect này là
lỗi **cơ học do chép tay danh sách field**, không phải thiếu hiểu biết thiết kế.

## 2. Vì sao hậu quả là TẤT ĐỊNH, không phải xác suất

Đây là phần "mạnh hơn" so với review gốc. Verification §4 (F04) chứng minh bằng
chuỗi control-flow vô điều kiện:

1. **`collectYieldEvents` = false cho child-process** (`pre-execution.ts:180`) ⇒
   `noYield` giữ `false` trên đường này. (Đây là hành vi **cố ý** — xem
   `task-runner-characterization.test.ts` scenario 3: child-process worker không
   có tool `submit_result`, nên không được flag `needs_attention` vì "no yield".)

2. **Gate bug-026 bị bỏ qua** — `post-execution.ts:337`:

   ```ts
   if (finalTextEmpty && finalStdoutEmpty && resultArtifact?.path) {
   ```

   Nhánh degrade trả `resultArtifact: undefined` và `finalStdout: ""` (xem
   `child-executor.ts:793-822`). Vì `resultArtifact` là `undefined`,
   `resultArtifact?.path` là `undefined` ⇒ **toàn bộ điều kiện false** ⇒ gate
   không bao giờ chạy ⇒ không có `error` nào được set từ đây.

3. **Kết luận trạng thái** — `post-execution.ts:498`:

   ```ts
   status: error ? "failed" : noYield ? "needs_attention" : "completed",
   ```

   Với `error === undefined` (bước 2) và `noYield === false` (bước 1) ⇒
   **`"completed"`**. Và `:639` phát `task.completed`.

4. **`error` giữ `undefined` là tất định** khi `completionMutationGuard` ở mặc
   định `"warn"` (`post-execution.ts:240` — `?? "warn"`) và role là read-only.
   Mutation guard chỉ set `error` ở mode `"fail"`.

⇒ Chuỗi này không phụ thuộc timing, không phụ thuộc tải, không phụ thuộc model.
Mọi lần worker mất pane trước khi hoàn thành, trên child-process, đều cho
`completed`.

### 2.1 Mất mát bậc hai: headless redeploy cũng từ chối

`src/runtime/surface/degrade.ts:516-523`:

```ts
// needs_attention là trạng thái mà finalizeSurfaceLoss để lại; running
// phòng khi unit chưa kịp finalize. Các trạng thái khác (queued/completed/
// cancelled/failed…) nghĩa là lifecycle khác đã quyết — không giành quyền.
const requeueable = task.status === "needs_attention" || task.status === "running";
```

Vì task bị terminalise thành `completed` (phantom), `requeueable` là `false` ⇒
`planHeadlessRedeplays` **skip** với lý do
`status completed is owned by another lifecycle`.

Nghĩa là: cơ chế phục hồi được thiết kế để cứu task này **chủ động từ chối nó**.
Task mất kết quả, không artifact, không requeue, và báo `completed`.

## 3. Mất mát cùng lớp: `rawFinalText`

Verification §4 (F04) ghi:

> **Cùng lớp lỗi, chưa được báo:** `rawFinalText` cũng bị bỏ. Producer trả
> (`child-executor.ts:1096`), finalizer dùng (`post-execution.ts:136`, footer
> union 452-458), nhưng `task-runner.ts` có **0** occurrence của `rawFinalText`.

Ý nghĩa: không chỉ nhánh degrade bị ảnh hưởng. **Mọi** task child-process đi qua
`runTeamTask` đều mất `rawFinalText`. Consumer ở `:136` nhận `undefined` ⇒ footer
union `:452-458` mất nguồn "un-trimmed final assistant text (pre-compaction)" mà
docstring của interface mô tả là nguồn được **ưu tiên**:

```ts
/** Round-1: un-trimmed final assistant text (pre-compaction) — the spec
 *  footer union prefers it, mirroring the result-artifact fallback chain. */
rawFinalText?: string;
```

Vì vậy fix phải xử lý **cả hai** field — nếu chỉ thêm `surfaceLost`, defect
"chép tay danh sách field" vẫn còn nguyên và sẽ tái phát ở field tiếp theo.

## 4. Vì sao guard hiện tại không chặn được

| Guard hiện có | Vì sao không đủ |
|---|---|
| Nhánh `if (execResult.surfaceLost)` ở finalizer (`:149`) | Đúng và đầy đủ, nhưng **không bao giờ nhận được field** — unreachable trong production |
| Gate bug-026 (`:337`) | Điều kiện dựa trên `resultArtifact?.path`; nhánh degrade trả `undefined` **theo thiết kế** ⇒ gate bị bỏ qua thay vì bắt lỗi |
| `completionMutationGuard` (`:240`) | Mặc định `"warn"` ⇒ chỉ ghi nhận, không set `error` ⇒ không đổi status |
| Test `post-execution-surface-lost.test.ts` | Gọi `finalizeTaskResult` **trực tiếp** với result tự dựng (`:160` gọi, `:144` inject field) ⇒ bỏ qua đúng adapter bị lỗi. Verification §4: "Không test nào chạy `surfaceLost` qua `runTeamTask`" |
| `planHeadlessRedeplays` (`degrade.ts:519`) | Guard **đúng chủ đích** — nó từ chối can thiệp vào task đã terminal bởi lifecycle khác. Nó không phải guard chống defect, nó là nạn nhân của defect |
| TypeScript | `surfaceLost?` và `rawFinalText?` đều **optional** ⇒ thiếu field không phải lỗi type. Đây là lý do `npm run typecheck` xanh suốt |

## 5. Hướng sửa được chọn

### 5.1 Fix tối thiểu (đúng như review đề xuất)

Verification §8 đề xuất #1:

> Fix tối thiểu: spread `child.surfaceLost` (và `rawFinalText`) vào literal
> `execResult` tại `task-runner.ts:208-220`; regression test phải đi qua
> `runTeamTask`, không qua finalizer trực tiếp.

Cụ thể hai chỗ trong `src/runtime/task-runner.ts`:

1. Khai báo hai local cạnh các local hiện có (nhóm `:124-134`), cùng kiểu:
   ```ts
   let surfaceLost: TaskExecutionResult["surfaceLost"];
   let rawFinalText: string | undefined;
   ```
   (hoặc spread trực tiếp từ `child` ở bước 2 — chọn cách nào cũng được, miễn
   **không** quên nhánh live-session/scaffold để lại `undefined`.)

2. Trong nhánh `runtimeKind === "child-process"` (`:135-153`), thêm:
   ```ts
   surfaceLost = child.surfaceLost;
   rawFinalText = child.rawFinalText;
   ```

3. Trong literal `execResult` (`:208-220`), thêm hai field:
   ```ts
   surfaceLost,
   rawFinalText,
   ```

Nhánh live-session và scaffold không set hai local này ⇒ `undefined` ⇒ hành vi
hiện tại của hai nhánh đó **không đổi** (quan trọng: live-session có đường
terminalisation riêng; scaffold không được hưởng nhánh degrade).

### 5.2 Vì sao đây là hướng đúng (không chỉ là hướng nhỏ nhất)

- Khôi phục **đúng ý định thiết kế** đã có trong spec (`mux-surface-design.md` §7 D3):
  surface mất ⇒ `needs_attention` + requeue headless **không** tiêu retry budget.
- Không đổi shape API (field đã tồn tại, đã có docstring).
- Blast radius: một file, ba chỗ, hai field. Nhưng hệ quả là đổi terminal state
  ⇒ vẫn là high-risk theo lane, và cần decision record.
- Sửa **cả** `rawFinalText` đóng luôn lớp lỗi (chép tay danh sách field) cho
  trường hợp đã biết, không để lại field tiếp theo bị bỏ tương tự.

### 5.3 Phương án bị loại

| Phương án | Lý do loại |
|---|---|
| **Sửa gate bug-026** để bắt "empty result không artifact" | Sẽ tạo artifact giả hoặc đẩy task sang `failed` — vi phạm AC-3 và đảo ngược ý định spec ("mất worker, không phải kết quả rỗng"). Gate yêu cầu `resultArtifact?.path` là **cố ý**: nó chỉ dành cho trường hợp có artifact nhưng rỗng. |
| **Xoá nhánh `surfaceLost` ở finalizer** vì "unreachable" | Xoá dead-code theo nghĩa literal nhưng xoá luôn tính năng phục hồi. Unreachable ở đây là **bug**, không phải thiết kế. |
| **Đặt `surfaceLost` từ `child-executor.ts` thẳng vào `ctx`** (bỏ qua ranh giới) | Phá kiến trúc CORE-5 (branch trả output bag, finalizer quyết định terminal state). Hai nguồn sự thật cho terminal state. |
| **Refactor `TaskExecutionResult` thành discriminated union ngay trong story này** | Đúng hướng dài hạn (review đề xuất "ưu tiên shared discriminated result type"), nhưng đây là refactor shape trên đường terminal state của **mọi** runtime branch — blast radius lớn gấp nhiều lần, cần ADR riêng và lane riêng. Story này khôi phục đúng hai field để có regression test trước; union hoá là story kế tiếp. |
| **Đổi `surfaceLost`/`rawFinalText` thành required (bỏ `?`)** | Buộc mọi caller (kể cả live/scaffold) truyền `undefined` tường minh — cải thiện type-safety, nhưng đổi API contract của một export type dùng ở nhiều nơi; không cần thiết để fix. Ghi vào "future work" của decision record. |
| **Thêm test gọi `finalizeTaskResult` với `surfaceLost` (như test hiện có)** | Chính xác là sai lầm đã có: nó pass dù adapter bị lỗi. AC-1 cấm. |
| **Sửa `planHeadlessRedeplays` để chấp nhận `completed`** | Nới guard đúng chủ đích của `degrade.ts` cho **mọi** task `completed` ⇒ scheduler sẽ requeue cả task đã hoàn thành thật. Không chấp nhận. |

## 6. Data / state implications

| Hạng mục | Thay đổi | Ghi chú |
|---|---|---|
| `task.status` terminal | Task mất surface: `completed` → `needs_attention` | Đây là **mục tiêu** của fix; đổi hành vi quan sát được |
| `task.exitCode` | `null` (nhánh `:157` set `exitCode: null`) | Đã đúng trong finalizer, chỉ chưa chạm tới |
| `task.diagnostics.surfaceLost` | Được ghi `{ ts, cause, paneId, exitReason }` | Field mới xuất hiện trong state task (đã có trong schema — chỉ chưa bao giờ được ghi trên đường này) |
| `task.resultArtifact` | `undefined` (không fabricate) | Không đổi so với hành vi hiện tại (hiện cũng `undefined`) |
| `events.jsonl` | `task.surface_lost` **được phát** thay vì `task.completed` | Đổi loại event terminal quan sát được |
| `rawFinalText` | Được truyền vào footer/spec-evidence | Ảnh hưởng `computeSpecGate` footer union (`:452-458`) trên **mọi** task child-process — cần test hồi quy (AC-9) |
| Requeue headless | Task vào `requeuedTaskIds` thay vì `skipped` | Không tiêu retry budget (spec §7 step 5) |
| Schema file | **Không đổi** | Không thêm field mới vào `TeamTaskState`; `diagnostics.surfaceLost` đã tồn tại trong type |

## 7. Backward compat

- **State format:** không đổi. `diagnostics` là object mở; `surfaceLost` đã có
  trong type (finalizer ghi nó ở `:162-165`).
- **API:** `TaskExecutionResult` không đổi shape. Chỉ có **giá trị** của hai field
  optional được truyền đúng thay vì luôn `undefined`. Không caller nào phải sửa.
- **Hành vi quan sát được — điểm cần ghi rõ cho release:**
  - Task child-process mất surface: trước `completed`, sau `needs_attention` +
    requeue headless. Đây là **sửa** hành vi sai, nhưng người dùng đang dựa vào
    "completed" sẽ thấy khác.
  - Task child-process bình thường: **không đổi** (`rawFinalText` giờ có giá trị,
    nhưng footer union vốn đã có fallback chain — kết quả cuối cùng chỉ đổi khi
    `finalText` bị compaction làm rỗng, đúng kịch bản mà docstring mô tả).
- **Retry budget:** không đổi — requeue surface-lost không tiêu budget (đã đúng
  trong `degrade.ts`; fix chỉ làm đường đó chạm tới được).
- **Test cũ:** `post-execution-surface-lost.test.ts` vẫn pass (nó test finalizer
  trực tiếp, không phụ thuộc adapter). `task-runner-characterization.test.ts`
  scenario 2/3/4/11 phải giữ nguyên — đặc biệt scenario 3 khoá hành vi
  "child-process KHÔNG flag needs_attention vì thiếu submit_result", và fix này
  **không** được phá nó (vì `surfaceLost` chỉ set khi pane degrade, không phải
  khi thiếu yield).

## 8. Security considerations

1. **Không có bề mặt input mới.** Hai field được truyền nội bộ giữa hai hàm cùng
   process; không có dữ liệu từ worker/model đi vào.
2. **Không nới lỏng guard nào.** Nhánh surfaceLost **không** chạy mutation guard,
   output validation, hay yield gate — đó là thiết kế đã có (mất worker ≠ kết quả
   rỗng). Fix không đổi tập guard đó, chỉ làm nó chạm tới được. Cần khẳng định
   trong test rằng guard **không** chạy (assert không có `task.failed`, và
   `resultArtifact` không được fabricate).
3. **Fail-closed:** nhánh này là ví dụ fail-closed đúng nghĩa — không có bằng
   chứng hoàn thành thì **không** báo hoàn thành. Fix khôi phục tính chất đó.
4. **Rủi ro over-correction là rủi ro chính.** Nếu spread quá rộng (ví dụ set
   `surfaceLost` cho mọi lần `childResult.surface` tồn tại, kể cả khi **không**
   `degraded`), mọi task surface-mode sẽ bị terminalise `needs_attention`.
   Verification §4 nhấn: field chỉ có khi `childResult.surface?.degraded` được
   set. Test AC-9/AC-10 là guard chống điều này.
5. **Không chạm secrets/PII.** `rawFinalText` là output của worker; nó đã đi vào
   artifact `results/<id>.txt` theo đường khác (`child-executor.ts`), nên việc
   truyền nó vào footer không mở rộng phạm vi phơi bày.

## 9. Decision record — stub cho lúc triển khai

Chưa viết ADR (story `planned`). Khi triển khai, tạo
`docs/decisions/<YYYY-MM-DD>-execution-result-boundary-fidelity.md` theo
`docs/templates/decision.md`.

```markdown
# ADR-N — Execution result boundary: truyền đủ field thay vì chép tay

## Status
Proposed → Accepted (sau phê duyệt high-risk)

## Context
- F04: surfaceLost có ở producer (child-executor.ts:815-821) và consumer
  (post-execution.ts:149) nhưng task-runner.ts:140-153 và :208-220 chép tay
  11 field và bỏ nó ⇒ nhánh needs_attention không thể chạm tới trong production.
- Hệ quả TẤT ĐỊNH: collectYieldEvents=false cho child-process
  (pre-execution.ts:180) + gate bug-026 yêu cầu resultArtifact?.path
  (post-execution.ts:337) bị bỏ qua vì resultArtifact undefined ⇒
  post-execution.ts:498 cho "completed" + :639 phát task.completed.
- Mất mát bậc hai: degrade.ts:519 chỉ nhận running/needs_attention ⇒
  phantom completed bị headless redeploy từ chối.
- Cùng lớp: rawFinalText bị bỏ y hệt (0 occurrence trong task-runner.ts).
- Test hiện có (post-execution-surface-lost.test.ts:160) gọi finalizer TRỰC TIẾP
  ⇒ bỏ qua adapter bị lỗi, không bao giờ bắt được defect.

## Decision
- Truyền surfaceLost và rawFinalText qua ranh giới branch trong task-runner.ts
  (hai local + hai field trong literal execResult).
- Regression test BẮT BUỘC đi qua runTeamTask (không gọi finalizeTaskResult trực tiếp).
- Không sửa gate bug-026, không sửa planHeadlessRedeplays, không đổi shape
  TaskExecutionResult.
- Future work (ghi nhận, không làm trong ADR này): thay danh sách field chép tay
  bằng shared discriminated result type; cân nhắc bỏ `?` trên hai field.

## Alternatives Considered
1. Sửa gate bug-026 → tạo artifact giả / đảo ý định spec.
2. Xoá nhánh surfaceLost coi như dead code → xoá tính năng phục hồi.
3. Set surfaceLost từ child-executor vào ctx → hai nguồn sự thật cho terminal state.
4. Discriminated union ngay → blast radius trên mọi runtime branch, cần ADR riêng.
5. Bỏ `?` trên hai field → đổi API contract của export type, không cần cho fix.
6. Test qua finalizer trực tiếp → chính là sai lầm đã có.
7. Nới planHeadlessRedeplays nhận `completed` → requeue cả task hoàn thành thật.

## Consequences
Positive:
- Mất surface ⇒ needs_attention + requeue headless đúng một lần (khôi phục spec §7 D3).
- Không còn `completed` giả không artifact (mất mát tất định được loại bỏ).
- rawFinalText tới được footer/spec-evidence như docstring mô tả.
Tradeoffs:
- Đổi hành vi quan sát được của terminal state cho task mất surface (cần release note).
- Vẫn là danh sách field chép tay ⇒ field tương lai có thể bị bỏ tương tự; chỉ
  union hoá mới đóng hẳn (future work).
```

Cập nhật kèm: `docs/decisions/README.md` (index), `docs/TEST_MATRIX.md` (hàng
RR-013 + cập nhật hàng "Degrade + classify timeout + lockout + headless resume (§7)").

## 10. References

- `docs/stories/RR-013/overview.md` — lane, risk flags, AC
- `docs/stories/RR-013/exec-plan.md` — bước RED-first, test phải đi qua `runTeamTask`
- `docs/stories/RR-013/validation.md` — thang kiểm chứng + gaps
- `docs/superpowers/specs/2026-08-26-mux-surface-design.md` §7 D3 — spec degrade/terminalisation
- `docs/archive/2026-09-17-pi-crew-review-verification.md` §4 (F04), §8 đề xuất #1
- `test/unit/runtime/task-runner/post-execution-surface-lost.test.ts` — test cũ (lách adapter)
- `test/unit/runtime/task-runner/task-runner-characterization.test.ts` — pattern đi qua `runTeamTask`
