# RR-013 — Validation: bảo toàn execution result qua ranh giới branch

- **Story:** `docs/stories/RR-013/overview.md` · **Design:** `docs/stories/RR-013/design.md`
- **Exec plan:** `docs/stories/RR-013/exec-plan.md`
- **Status:** planned — chưa có evidence (mục §6 để trống, điền sau khi implement)
- **Baseline:** `pi-crew@0.11.1`, commit `0b9fa771`

## 1. Thang kiểm chứng (validation ladder)

Bảng lấy từ plan §4; cột "Dùng cho RR-013" nêu lý do cụ thể.

| Level | Command | Expected | Dùng cho RR-013 |
|---|---|---|---|
| quick | `npm run typecheck` | pass (tsc + strip-types import) | **Đặc biệt quan trọng ở story này:** hai field là optional nên typecheck **xanh suốt cả khi bug tồn tại** — typecheck không phải proof, chỉ là gate |
| targeted | `node scripts/test-runner.mjs <file>` | 0 fail | Vòng lặp RED→GREEN cho 3 test mới |
| critical | `npm run test:critical` | 14 file, 0 fail | Trước commit fix (bước 5) |
| unit | `npm run test:unit` | 0 fail (trừ 2 test flaky đã biết — §5) | Trước khi đóng story |
| lint | `npm run lint && npm run format:check` | pass | Story sửa `src/` (2 file) ⇒ bắt buộc |
| gates | `npm run check:event-types`, `check:lazy-imports`, `check:wc-gate`, `check:decision-drift` | pass | `task.surface_lost` là event đã có; gate này bắt drift nếu fix vô tình đổi tập event |
| integration | `npm run test:integration` | 0 fail (4 skip là bình thường) | Plan §4 xếp F04 vào nhóm cần integration; test boundary chính đặt ở đây |
| bundle | `npm run build:bundle && npm run test:bundle` | bundle rebuild, 2 pass | Bắt buộc: `dist/index.mjs` là bundle mặc định từ v0.9.17 |
| full | `npm run ci` | toàn chuỗi xanh | Trước publish |

**Chạy targeted cho test mới của story:**

```bash
node scripts/test-runner.mjs \
  test/integration/task-runner-surface-lost-boundary.test.ts \
  test/unit/runtime/task-runner/task-runner-result-boundary.test.ts \
  test/unit/runtime/surface/degrade-replay-surface-lost.test.ts
```

**Chạy regression chống over-correction (quan trọng nhất của story này):**

```bash
node scripts/test-runner.mjs \
  test/unit/runtime/task-runner/task-runner-characterization.test.ts \
  test/unit/runtime/task-runner/post-execution-surface-lost.test.ts \
  test/unit/runtime/task-runner/post-execution-stderr-only.test.ts \
  test/unit/runtime/surface/degrade.test.ts \
  test/unit/runtime/child-pi/child-pi-surface.test.ts
```

`task-runner-characterization.test.ts` scenario 3 (yield-exclusion) là **guard
chính** chống over-correction: nếu fix làm nó đỏ, `needs_attention` đã lan sang
task child-process bình thường ⇒ dừng, điều tra.

**Lưu ý chạy từ trong worker** (`.crew/knowledge.md`): scrub `PI_CREW_*` trước khi
đánh giá assert "absence" — story này có nhiều assert absence (`task.completed`
không được có). Và **không** chạy cả một test directory trong một lệnh
`node --test <dir>/` từ trong worker.

## 2. Ánh xạ Acceptance Criteria → proof

| AC | Proof | Test file | Loại proof | Trạng thái |
|---|---|---|---|---|
| AC-1 (`surfaceLost` sống qua `runTeamTask`) | `task.status === "needs_attention"` khi mock trả `surface.degraded` | `task-runner-surface-lost-boundary.test.ts` | integration | planned |
| AC-2 (`rawFinalText` sống qua ranh giới) | footer/spec-evidence đọc được `rawFinalText` khi `finalText` rỗng | `task-runner-result-boundary.test.ts` (3b) | unit | planned — **xem gap §5.1** |
| AC-3 (không artifact giả) | `task.resultArtifact` là `undefined`/`null`; không có `"(no output)"` | `task-runner-surface-lost-boundary.test.ts` (2e) | integration | planned |
| AC-4 (event đúng) | có `task.surface_lost`; không có `task.completed`, không có `task.failed` | `task-runner-surface-lost-boundary.test.ts` (2b/2c/2d) | integration | planned |
| AC-5 (gate bug-026 không còn "bị bỏ qua") | `task.completed` **0 lần** trong `events.jsonl` (proof trực tiếp rằng `:498` không còn cho `"completed"`) | `task-runner-surface-lost-boundary.test.ts` (2b) | integration | planned |
| AC-6 (headless redeploy nhận task) | `planHeadlessRedeplays` requeue task `needs_attention`/`running`, skip task `completed` | `degrade-replay-surface-lost.test.ts` (4a/4b/4c) | unit | planned |
| AC-7 (không requeue kép) | gọi lần hai với cùng `handledTaskIds` ⇒ `requeuedTaskIds` rỗng + lý do `already re-dispatched once for surface loss` | `degrade-replay-surface-lost.test.ts` (4d) | unit | planned |
| AC-8 (test cũ vẫn pass) | `post-execution-surface-lost.test.ts` xanh | (file hiện có) | unit | planned |
| AC-9 (không over-correction) | `task-runner-characterization.test.ts` scenario 2/3/4/5/6 xanh | (file hiện có) | unit | planned |
| AC-10 (task thường không đổi) | child-process lỗi → `failed`; thành công → `completed`; không `needs_attention` lan rộng | `task-runner-characterization.test.ts` | unit | planned |
| AC-11 (gates) | `typecheck`, `lint`, `format:check`, `check:event-types`, `check:wc-gate` | — | gate | planned |

**Không có AC nào cần model thật, LLM, provider, hay tmux thật.** Mock seam
`surface-degraded` (bước 1 của exec-plan) là điều kiện để AC-1..AC-5 khả thi.

## 3. Bằng chứng "trước fix" — chạy ngay ở bước 0

Đây là **static proof** rằng defect tồn tại, chạy được mà không cần implement
(verification §4 F04 khẳng định cả hai đều 0 hit):

```bash
rg -n "surfaceLost" src/runtime/task-runner.ts      # kỳ vọng: 0 hit
rg -n "rawFinalText" src/runtime/task-runner.ts     # kỳ vọng: 0 hit
```

Ghi output thật vào §6. Nếu **không** phải 0 hit, defect đã được sửa (hoặc mã đã
drift so với baseline) — dừng và kiểm tra lại `design.md` trước khi viết test.

Bằng chứng bổ sung (cấu trúc, không cần chạy):

```bash
rg -n "surfaceLost" src/runtime/task-runner/child-executor.ts    # producer: 815-821
rg -n "surfaceLost" src/runtime/task-runner/post-execution.ts    # consumer: 66-72, 149
rg -n "rawFinalText" src/runtime/task-runner/post-execution.ts   # consumer: 136, 452-458
```

## 4. Kiểm tra thủ công bổ sung (manual evidence)

Story này **không** yêu cầu manual evidence để đóng — mọi AC đều tự động. Tuy
nhiên nếu có điều kiện (surface mode thật + tmux), đây là kiểm chứng end-to-end
có giá trị cao nhất:

```bash
# 1. Bật surface cho một role trong project config (visibleAgents non-empty),
#    chạy một run, và kill pane giữa chừng:
tmux list-panes -F '#{pane_id} #{pane_title}'
tmux kill-pane -t <pane_id>

# 2. Kiểm events.jsonl của run:
grep -E '"type":"(task\.surface_lost|task\.completed|task\.failed)"' \
  .crew/state/runs/<runId>/events.jsonl
#    Kỳ vọng TRƯỚC fix: task.completed (phantom).
#    Kỳ vọng SAU fix: task.surface_lost, và KHÔNG có task.completed cho task đó.

# 3. Kiểm status task:
node -e "const t=require('./.crew/state/runs/<runId>/tasks.json');console.log(t.tasks.map(x=>[x.id,x.status]))"
#    Kỳ vọng SAU fix: task ở needs_attention (rồi requeued), không completed.
```

Ghi kết quả vào §6 với nhãn rõ là **manual**, không phải CI.

## 5. Known gaps / rủi ro chưa kiểm được

### 5.1 AC-2 (`rawFinalText`) có thể không có proof quan sát được

Đây là gap **đã biết trước khi implement**, không phải phát hiện sau:

Consumer duy nhất của `rawFinalText` là `post-execution.ts:136` → footer union
`:452-458` → `computeSpecGate`. Quan sát **tác dụng** của nó cần một task packet
có spec (`specId` + `specSnapshot` với acceptance `must`) — fixture này nặng hơn
fixture hiện có trong repo. Nếu không dựng được:

- Cách 1: assert cấp thấp rằng `finalizeTaskResult` nhận `rawFinalText`
  non-undefined (cần một seam/spy — chưa xác nhận có sẵn).
- Cách 2: chấp nhận **proof yếu** (chỉ assert field có mặt qua một test cấu trúc)
  và ghi rõ trong §6 là proof yếu.
- Cách 3: **không** có proof ⇒ AC-2 ở trạng thái "chưa đủ proof". Story vẫn có thể
  đóng nếu §6 ghi rõ điều này và các AC khác đều có proof — **nhưng** không được
  tuyên bố AC-2 pass.

**Quan trọng:** fix `rawFinalText` vẫn phải làm (design §3: cùng lớp lỗi). Việc
thiếu proof không phải lý do để không truyền field.

### 5.2 Run kết thúc khác kỳ vọng khi mock degrade luôn trả degraded

Vì `runMockChildPi` chạy TRƯỚC nhánh surface trong `runChildPi`, mode
`surface-degraded` trả degraded ở **mọi** lần spawn — kể cả lần requeue headless.
Hệ quả: run có thể phát `task.surface_lost` **nhiều hơn một lần**, và lần chạy
đầu tiên của test (i) có thể khác dự kiến (số lần lặp, trạng thái manifest cuối).

Điều này **không** phải bug sản phẩm, nhưng có thể làm test viết theo kỳ vọng
"một lần" bị đỏ vì lý do sai. Xử lý: assert theo **tính chất** (không có
`task.completed`; có `task.surface_lost`; trạng thái cuối `needs_attention`) chứ
không theo số lần. Nếu run **treo** hoặc lặp vô hạn → đó là phát hiện mới: ghi
vào đây và báo leader.

### 5.3 Over-correction là rủi ro chính (và cách phát hiện)

Nếu fix spread `surfaceLost` quá rộng (ví dụ set khi `childResult.surface` tồn tại
nhưng **không** `degraded`), mọi task surface-mode sẽ bị `needs_attention`.
Phát hiện bằng:

- `task-runner-characterization.test.ts` scenario 3 (yield-exclusion).
- `post-execution-surface-lost.test.ts` (assert `resultArtifact` không bị
  fabricate — nếu fix vô tình set `surfaceLost` cho nhánh thường, test này có thể
  vẫn xanh, nên **không** đủ; cần thêm positive control).

Nếu thiếu positive control, bổ sung: chạy `runTeamTask` với mock `json-success`
(hoặc `surface` **không** degraded nếu dựng được) và assert `completed` — đây là
AC-10.

### 5.4 Hai unit test đã đỏ trước story (plan §4, review §6.2)

- `test/unit/interrupt-guard-ack.test.ts` — full suite expected 1 / actual 0;
  chạy riêng 2/2 pass (flaky, chưa rõ root cause).
- `test/unit/runtime/broker/crew-broker-symlink-steering.test.ts` — trả
  `request-timeout` thay vì `ok: true`, cả full suite và chạy riêng. Assertion
  thất bại **trước** kiểm tra escaped write ⇒ **không** phải bằng chứng symlink
  boundary bị vượt.

⇒ RR-013 **không** được coi là "xanh" nếu hai test này còn đỏ. Chúng thuộc phạm vi
RR-015 hoặc story riêng.

### 5.5 CI false-green (F05) chưa sửa

`scripts/test-runner.mjs:142` `process.exit(result.status ?? 0)` ⇒ coordinator bị
SIGKILL cho exit 0. Plan §6 đặt RR-013 **trước** RR-015 vì fix nhỏ + blast radius
hẹp, nhưng điều đó có nghĩa: khi RR-013 đóng, kết luận "xanh" vẫn chưa hoàn toàn
đáng tin. Phải ghi rõ điều này trong §6 khi đóng story.

### 5.6 `TEST_MATRIX.md` đang tuyên bố đã phủ đường này

Hàng "Degrade + classify timeout + lockout + headless resume (§7)" có Status
`implemented` với Evidence gồm `post-execution-surface-lost.test.ts`. Thực tế
đường production bị đứt (verification §4 F04). Đây là **drift tài liệu** cần sửa
trong bước 7 của exec-plan — và là bài học: một test pass không đồng nghĩa đường
production được phủ.

### 5.7 Bundle staleness

Sửa `src/` (cả mock seam ở bước 1 lẫn fix ở bước 5) mà không `npm run build:bundle`
thì session thật vẫn dùng bundle cũ (`.crew/knowledge.md`).

## 6. Evidence — ĐIỀN SAU

Điền sau khi implement. Không đánh dấu story `completed` khi còn ô trống.

| Hạng mục | Bằng chứng |
|---|---|
| §3 — `rg -n "surfaceLost" src/runtime/task-runner.ts` (kỳ vọng 0 hit) | |
| §3 — `rg -n "rawFinalText" src/runtime/task-runner.ts` (kỳ vọng 0 hit) | |
| Bước 1 — mock seam `surface-degraded` (typecheck + surface test không hồi quy) | |
| Bước 2 — output RED (trước fix) | |
| AC-1 (`needs_attention`) | |
| AC-2 (`rawFinalText` tới consumer) | |
| AC-3 (không artifact giả) | |
| AC-4 (event `task.surface_lost`, không `task.completed`/`task.failed`) | |
| AC-5 (gate bug-026 không còn bị bỏ qua) | |
| AC-6 (`planHeadlessRedeplays` requeue) | |
| AC-7 (không requeue kép) | |
| AC-8 (`post-execution-surface-lost.test.ts` xanh) | |
| AC-9 (characterization xanh, đặc biệt scenario 3) | |
| AC-10 (task thường không đổi) | |
| AC-11 (gates) | |
| `npm run typecheck` | |
| `npm run test:critical` | |
| `npm run test:integration` | |
| `npm run lint && npm run format:check` | |
| `npm run build:bundle && npm run test:bundle` | |
| `npm run ci` | |
| Kiểm thủ công (§4, nếu có) | |
| Decision record đã viết | |
| `docs/TEST_MATRIX.md` đã cập nhật (hàng RR-013 + hàng degrade §7) | |

## 7. Điều kiện đóng story

Story chỉ được đánh dấu `completed` khi **tất cả** điều sau đúng:

1. Cả 3 test mới tồn tại và pass; **mỗi** test đã được chứng minh RED trước fix
   (ghi output RED vào §6 — không chỉ trạng thái cuối). Ngoại lệ: test ở bước 4
   là characterization (pass ngay) — ghi rõ nó là test khoá hành vi `degrade.ts`.
2. §3 đã có bằng chứng "trước fix" (0 hit cho cả hai field).
3. AC-9 pass — đặc biệt `task-runner-characterization.test.ts` scenario 3. Đây là
   điều kiện **bắt buộc**, không phải "nice to have".
4. AC-11 pass.
5. Decision record đã tồn tại và được ghi vào `docs/decisions/README.md`.
6. `docs/TEST_MATRIX.md` đã cập nhật **cả** hàng RR-013 **và** hàng
   "Degrade + classify timeout + lockout + headless resume (§7)" (§5.6).
7. §5 (Known gaps) đã cập nhật: mọi gap còn lại được nêu tên, không bị bỏ im.
   Đặc biệt: nếu AC-2 không có proof, phải nói rõ và **không** tuyên bố pass.
8. Có ghi chú release về thay đổi hành vi quan sát được (`completed` →
   `needs_attention` cho task mất surface).
