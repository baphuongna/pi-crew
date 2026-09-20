# RR-013 — F04: Bảo toàn execution result qua ranh giới branch

- **Lane:** high-risk — **chờ phê duyệt của người** trước khi triển khai
  (`docs/FEATURE_INTAKE.md` → High-Risk: "Ask human confirmation before implementation")
- **Status:** planned
- **Đợt:** 1 (bảo vệ dữ liệu và kết quả) — không phụ thuộc story nào (plan §2.4)
- **Thứ tự đề xuất:** **đầu tiên** trong toàn bộ chương trình (plan §6 lý do #1)
- **Ngày tạo:** 2026-09-17
- **Baseline:** `pi-crew@0.11.1`, commit `0b9fa771`. Mọi số dòng trong packet ứng
  với commit này.
- **Nguồn:**
  - `docs/superpowers/plans/2026-09-17-review-remediation.md` §2.3, §2.4, §5 (RR-013), §6
  - `docs/archive/2026-09-17-pi-crew-review.md` §3 (F04 — mức Cao)
  - `docs/archive/2026-09-17-pi-crew-review-verification.md` §4 (F04 — **VERIFIED
    (mạnh hơn)**), §8 đề xuất #1, §7
  - `docs/FEATURE_INTAKE.md` — lane + risk checklist
  - `docs/superpowers/specs/2026-08-26-mux-surface-design.md` §7 D3 (thiết kế
    degrade/terminalisation mà defect này vô hiệu hoá) — dẫn qua TEST_MATRIX

## 1. Vấn đề trong một câu

`surfaceLost` có ở **producer** (`child-executor.ts:815-821`) và ở **consumer**
(`post-execution.ts:149`), nhưng bước chuyển tiếp ở giữa — `task-runner.ts:140-153`
và `:208-220` — chép tay 11 field và **bỏ** `surfaceLost`, nên nhánh
`needs_attention` của finalizer **không thể chạm tới trong production**; task
thành `completed` **một cách tất định** dù không có kết quả.

## 2. Nguồn gốc và mức độ

| Mục | Giá trị |
|---|---|
| Verdict xác minh | **VERIFIED (mạnh hơn)** — review mô tả "có thể thành completed"; thực tế là **tất định** |
| Mức trong review | Cao |
| Phương pháp xác minh | Truy vết tĩnh (một call site, một producer, field vắng trong object literal) |
| Plan §2.3 xếp lane | high-risk — "không thuộc hard gate văn bản, nhưng nâng lane vì thay đổi ngữ nghĩa terminal state và có mất mát tất định" |
| Plan §6 xếp thứ tự | **#1** trong toàn chương trình: "mất mát kết quả *tất định* (không xác suất), fix nhỏ (spread field vào literal), blast radius hẹp, và không phụ thuộc story nào" |

## 3. Vì sao high-risk

Lane high-risk được nâng theo plan §2.3 (không phải hard gate văn bản), dựa trên
ba tính chất:

- **State mutation:** đổi trạng thái terminal mà task nhận (`completed` →
  `needs_attention`). Đây là field mà mọi consumer downstream đọc.
- **Error handling:** defect nằm ở đường **mất** tín hiệu lỗi. Sửa sai theo
  hướng ngược lại (làm mọi task non-yield thành `needs_attention`) sẽ phá vỡ
  completion contract của child-process.
- **Backward compat:** ý nghĩa quan sát được của `completed` thay đổi. Một task
  mất surface trước đây báo `completed`; sau fix báo `needs_attention` và được
  requeue headless. Bất kỳ consumer nào đang dựa vào "completed = xong" (kể cả
  người dùng đọc `team status`) đều thấy khác.

Plan §6 liệt kê rủi ro chính của RR-013: **"`completed` giả, mất kết quả tất định"**.

### Risk flags (theo `docs/FEATURE_INTAKE.md` → Risk Checklist)

Số flag lấy nguyên từ plan §2.3 (F04 = 3 flags → high-risk).

| Risk flag | Áp dụng | Ghi chú |
|---|:-:|---|
| State mutation | ● | `task.status` terminal + `diagnostics.surfaceLost` + event `task.surface_lost` |
| Concurrency | | Không chạm lock; nhánh surfaceLost dùng `withRunLock` sẵn có (`post-execution.ts:166`) |
| Child process | | Không spawn; chỉ truyền field qua ranh giới hàm |
| Error handling | ● | Đây là defect về **mất** tín hiệu lỗi/mất surface |
| External tools | | |
| API contract | | `TaskExecutionResult` shape không đổi (field đã có, chỉ không được truyền) |
| Platform | | |
| Backward compat | ● | `completed` → `needs_attention`; headless requeue trở nên chạm tới được (`degrade.ts:519`) |
| Dependencies | | Không thêm package |
| Security | | |
| **Tổng** | **3** | → **high-risk** |

## 4. Affected Modules

- `src/runtime/task-runner/child-executor.ts` — producer:
  - `:793-822` — return block của nhánh degrade; field ở `:815-821`
  - `:1096` — `rawFinalText` trong return block chính (cùng lớp lỗi, bị bỏ y hệt)
- `src/runtime/task-runner.ts` — **ranh giới bị đứt** (file cần sửa):
  - `:120-122` — comment nói rõ "MuxSurface degrade path returns NO result artifact
    … (finalizeTaskResult's surfaceLost branch ignores it)" ⇒ tác giả **biết**
    nhánh `surfaceLost` tồn tại, nhưng vẫn bỏ field ở dưới
  - `:140-153` — chép tay 11 field từ `child.*` (không có `surfaceLost`, `rawFinalText`)
  - `:208-220` — dựng literal `execResult` (cũng thiếu hai field đó)
- `src/runtime/task-runner/post-execution.ts` — consumer:
  - interface `TaskExecutionResult` — khai báo `surfaceLost?` (docstring nói rõ:
    "When set, {@link finalizeTaskResult} short-circuits into a dedicated degrade
    terminalisation (needs_attention, no fabricated result)") và `rawFinalText?`
    (docstring: "un-trimmed final assistant text (pre-compaction) — the spec
    footer union prefers it")
  - `:136` — `const rawFinalText = execResult.rawFinalText;`
  - `:149-179` — nhánh `if (execResult.surfaceLost)` (terminalisation `needs_attention`)
  - `:240` — `completionMutationGuard` mặc định `"warn"`
  - `:337` — gate bug-026 `if (finalTextEmpty && finalStdoutEmpty && resultArtifact?.path)`
  - `:452-458` — footer union dùng `rawFinalText`
  - `:498` — `status: error ? "failed" : noYield ? "needs_attention" : "completed"`
  - `:639` — phát `task.completed`
- `src/runtime/task-runner/pre-execution.ts:180` — `collectYieldEvents` = false cho
  child-process ⇒ `noYield` luôn false trên đường này
- `src/runtime/surface/degrade.ts:516-523` — `planHeadlessRedeplays`;
  `:519` `requeueable = status === "needs_attention" || status === "running"`
- `test/unit/runtime/task-runner/post-execution-surface-lost.test.ts` — test hiện
  có **lách** adapter bị lỗi: `:160` gọi `finalizeTaskResult` trực tiếp với
  result tự dựng (`:144` inject field)
- `test/unit/runtime/task-runner/task-runner-characterization.test.ts` — pattern
  để đi qua `runTeamTask` với mock child
- `test/integration/` — nơi phù hợp cho test đi qua `runTeamTask` + replay
- `docs/decisions/` — decision record bắt buộc cho high-risk

## 5. Acceptance Criteria

Mọi AC phải kiểm được bằng test tự động, **không cần model thật**: dùng
`PI_TEAMS_MOCK_CHILD_PI` + `PI_CREW_ALLOW_MOCK=1` (pattern của
`task-runner-characterization.test.ts`) hoặc fixture surface degrade.

**Nhóm A — field phải sống qua ranh giới branch**

- **AC-1.** `runTeamTask` truyền `surfaceLost` từ `runChildProcessTask` tới
  `finalizeTaskResult`: với một child result có `surface.degraded` set, task kết
  thúc ở `status === "needs_attention"` — **không** `completed`.
  (Regression test **bắt buộc đi qua `runTeamTask`**, không gọi finalizer trực tiếp.)
- **AC-2.** `rawFinalText` cũng sống qua ranh giới: với child result có
  `rawFinalText` non-empty và `parsedOutput.finalText` rỗng (kịch bản compaction),
  footer/spec-evidence dùng được giá trị đó. Test: assert giá trị nhìn thấy ở
  nơi consumer dùng (`post-execution.ts:136` → footer union `:452-458`), không
  chỉ assert field có mặt.
- **AC-3.** Không tạo artifact giả: khi surfaceLost, `task.resultArtifact` là
  `undefined`/`null` (không có `"(no output)"`), khớp assertion hiện có ở
  `post-execution-surface-lost.test.ts:169-173`.
- **AC-4.** Event đúng: `task.surface_lost` được phát; `task.completed` và
  `task.failed` **không** được phát (khớp assertion hiện có).

**Nhóm B — hệ quả tất định được sửa**

- **AC-5.** Gate bug-026 (`post-execution.ts:337`) không còn bị "bỏ qua do thiếu
  artifact": với `resultArtifact === undefined`, task **không** đi tới
  `post-execution.ts:498` nhánh `"completed"`. Test: assert `task.completed`
  không xuất hiện trong `events.jsonl` (đây là proof trực tiếp của "deterministic
  completed" đã bị loại bỏ).
- **AC-6.** Headless redeploy nhận được task: `planHeadlessRedeplays`
  (`degrade.ts:516-523`) trả task vào `requeuedTaskIds` (thay vì `skipped` với
  lý do `status completed is owned by another lifecycle`), và requeue **đúng một
  lần** khi gọi lặp (idempotent qua `handledTaskIds`).
- **AC-7.** Không có requeue kép: sau replay, gọi lại `planHeadlessRedeplays` với
  cùng `handledTaskIds` ⇒ `requeuedTaskIds` rỗng, `skipped` chứa lý do
  `already re-dispatched once for surface loss`.

**Nhóm C — không hồi quy**

- **AC-8.** `test/unit/runtime/task-runner/post-execution-surface-lost.test.ts`
  giữ nguyên pass (test cũ vẫn hợp lệ; nó chỉ không còn là proof duy nhất).
- **AC-9.** `test/unit/runtime/task-runner/task-runner-characterization.test.ts`
  toàn bộ pass — đặc biệt scenario 3 (yield-exclusion): task child-process **có**
  output bình thường vẫn `completed`, **không** bị đẩy sang `needs_attention`.
  Đây là guard chống over-correction.
- **AC-10.** Task child-process lỗi bình thường vẫn `failed`; task child-process
  thành công vẫn `completed` (không có `needs_attention` lan rộng).
- **AC-11.** Gates: `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run check:event-types` (nếu thêm event mới), `npm run check:wc-gate` pass.

## 6. Out of scope

- Đổi **cơ chế** phát hiện surface degrade (`classifyOnExit`, cửa sổ classify,
  `surface.degraded`) — đã có và không sửa.
- Đổi nội dung/hình dạng của `diagnostics.surfaceLost`, resume note, hay
  `renderSurfaceLostResumeNote`.
- Refactor rộng `TaskExecutionResult` thành discriminated union (đề xuất dài hạn
  của review: "ưu tiên shared discriminated result type thay vì tự chép danh sách
  optional field"). Story này **chỉ** đảm bảo hai field hiện có được truyền đúng;
  việc thay shape là bước riêng, cần ADR.
- Live-session runtime branch (`live-executor.ts`) — defect này ở ranh giới
  child-process; không đổi đường live.
- `task-runner.ts` là **caller duy nhất** của `finalizeTaskResult` (verification
  §4 F04) — không thêm caller mới.
- Retry budget / autoRetry policy — `needs_attention` từ surfaceLost **không**
  tiêu retry budget (spec §7 step 5); giữ nguyên.
- F03/F16 (delegation) — **RR-012**. F02 (run lock) — **RR-011**. F05 (CI
  integrity) — **RR-015**.

## 7. Dependencies

| Phụ thuộc | Loại | Lý do |
|---|---|---|
| **RR-015** (F05 — CI integrity) | Mềm | `scripts/test-runner.mjs:142` trả exit 0 khi coordinator bị kill. Plan §6 đặt RR-013 **trước** RR-015 vì fix RR-013 rất nhỏ và blast radius hẹp, nhưng **kết luận xanh** của RR-013 chỉ thật sự đáng tin sau khi RR-015 xong. Ghi rõ khi đóng story. |
| **RR-012** (F03+F16) | Không | Khác đường mã hoàn toàn (`task-runner.ts` vs `broker/crew-broker.ts`). |
| `docs/superpowers/specs/2026-08-26-mux-surface-design.md` §7 D3 | Bắt buộc đọc | Là spec của cơ chế bị vô hiệu hoá; fix phải khôi phục đúng ý định spec (needs_attention + requeue headless không tiêu retry budget). |
| `docs/decisions/` | Bắt buộc | High-risk lane yêu cầu decision record (plan §3 nguyên tắc 7). Stub ở `design.md` §7. |

## 8. Ghi chú quan trọng cho người implement

1. **Regression test phải đi qua `runTeamTask`.** Test hiện có
   (`post-execution-surface-lost.test.ts:160`) gọi `finalizeTaskResult` trực tiếp
   và do đó **không bao giờ** bắt được defect này — nó bỏ qua đúng adapter bị lỗi.
   Verification §4 (F04) ghi rõ: "Không test nào chạy `surfaceLost` qua
   `runTeamTask`". AC-1 cấm lặp lại sai lầm đó.
2. **Fix tối thiểu đã được review chỉ ra:** spread `child.surfaceLost` (và
   `child.rawFinalText`) vào literal `execResult` tại `task-runner.ts:208-220`
   (verification §8 đề xuất #1). Ngoài ra `:140-153` cũng phải nhận hai field
   này, vì đó là nơi giá trị được lấy ra khỏi `child`.
3. **Đừng "sửa" bằng cách nới gate bug-026.** Gate `:337` yêu cầu
   `resultArtifact?.path`; với surfaceLost thì `resultArtifact` là `undefined`
   **theo thiết kế** (không fabricate kết quả). Sửa gate sẽ tạo artifact giả —
   vi phạm AC-3.
4. **Đừng bỏ assertion cũ trong `post-execution-surface-lost.test.ts`.** Nó vẫn
   là proof hợp lệ cho finalizer; chỉ thiếu phần adapter.

## 9. Tài liệu liên quan

- `docs/stories/RR-013/design.md` — defect + hướng sửa + phương án bị loại
- `docs/stories/RR-013/exec-plan.md` — các bước RED-first + rollback
- `docs/stories/RR-013/validation.md` — thang kiểm chứng + ánh xạ AC→proof + gaps
- `docs/superpowers/specs/2026-08-26-mux-surface-design.md` §7 D3 — spec degrade
- `docs/stories/RR-014/overview.md` — tiền lệ high-risk folder trong đợt này
- `docs/TEST_MATRIX.md` — hàng "Degrade + classify timeout + lockout + headless resume (§7)"
  (đang `implemented`, cần cập nhật evidence sau fix)
