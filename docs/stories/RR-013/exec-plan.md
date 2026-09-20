# RR-013 — Exec plan: bảo toàn execution result qua ranh giới branch

- **Story:** `docs/stories/RR-013/overview.md` · **Design:** `docs/stories/RR-013/design.md`
- **Lane:** high-risk — **chờ phê duyệt của người trước bước 1**
- **Nguyên tắc chung** (plan §3): regression test trước, sửa sau; fail-closed; mọi
  thay đổi high-risk phải có decision record.
- **Ràng buộc cứng của story này:** regression test **BẮT BUỘC** đi qua
  `runTeamTask`, không gọi `finalizeTaskResult` trực tiếp (verification §8 đề xuất #1).

## Ghi chú về "seed regression test"

F04 được xác minh bằng **truy vết tĩnh**, không kèm probe chạy được. Vì vậy seed
là các sự kiện control-flow vô điều kiện mà verification §4 đã chứng minh:

| Seed (từ verification §4 F04) | Chuyển thành assert |
|---|---|
| `task-runner.ts:140-153` copy 11 field, không có `surfaceLost` | Task mất surface qua `runTeamTask` → `needs_attention`, không `completed` |
| `task-runner.ts:208-220` dựng `execResult` cũng thiếu | `task.completed` **không** xuất hiện trong `events.jsonl` |
| `collectYieldEvents = false` cho child-process (`pre-execution.ts:180`) | `noYield === false` ⇒ nhánh `:498` chỉ có thể là `completed` nếu `error` undefined |
| Gate bug-026 cần `resultArtifact?.path` (`post-execution.ts:337`), mà `resultArtifact` là `undefined` | Gate bị bỏ qua ⇒ không có `error` nào được set từ đây |
| `task-runner.ts` có **0** occurrence của `rawFinalText` | `rawFinalText` không tới được footer/spec-evidence |
| `degrade.ts:519` chỉ nhận `running`/`needs_attention` | `planHeadlessRedeplays` phải requeue, không skip |
| Test cũ `post-execution-surface-lost.test.ts:160` gọi finalizer trực tiếp | Test **mới** phải đi qua `runTeamTask` |

## Vấn đề kỹ thuật trung tâm: làm sao đưa `surface.degraded` qua `runTeamTask`

`runTeamTask` → `runChildProcessTask` → `runWorker` → `runChildPi`. Không có
đường inject `surface.providers` từ `runTeamTask` (child-executor **không** truyền
field `surface` vào `runWorker`). Vì vậy để test đi qua `runTeamTask`, cần một
seam sinh ra `ChildPiRunResult` có `surface.degraded`.

**Hai lựa chọn, và lựa chọn được chọn:**

| Cách | Đi qua `runTeamTask`? | Đánh giá |
|---|---|---|
| **(A) Thêm mock mode mới** vào `src/runtime/child-pi/mock-fixtures.ts` (ví dụ `"surface-degraded"`) trả `ChildPiRunResult` có `surface: { kind: "tmux", paneId: "%9", scriptPath: "…", degraded: { cause: "pane-closed", exitReason: "pane-closed", classifiedAt: … } }` | ✔ | **CHỌN.** `mock-fixtures.ts` đã là seam test chính thức (bảo vệ bởi `PI_CREW_ALLOW_MOCK=1` — chỉ bật được từ parent process scope, không kế thừa xuống child). Không cần mạng, không cần tmux, deterministic. Nhánh degrade trong `child-executor.ts` chạy thật. |
| (B) Inject `surface.providers` qua `runChildPi` trực tiếp | ✘ | Test sẽ dừng ở `runChildPi`/`child-executor`, **không** chạm `task-runner.ts` — tức không bắt được defect. Đây chính là loại test đã có (`post-execution-surface-lost.test.ts`) và nó pass dù bug tồn tại. |
| (C) Chạy tmux thật (`npm run test:system`) | ✘ | `test/system` không thuộc `npm test`/CI (`TEST_MATRIX.md`: "opt-in local, CI skip qua guard `CI \|\| !TMUX`"); không thể là regression gate. |

**(A) là thay đổi `src/` duy nhất được phép ngoài fix** — nằm trong bước 1, và phải
làm **trước** test RED để test có thể chạy. Đây là test seam, không phải hành vi
sản phẩm: mode mới chỉ hoạt động khi `PI_CREW_ALLOW_MOCK` được set (parent-only).

## Bảng bước

| # | Mục tiêu | Test/File | RED? | Command |
|---|---|---|---|---|
| 1 | Thêm mock mode `surface-degraded` (test seam) | `src/runtime/child-pi/mock-fixtures.ts` | — | `npm run typecheck` |
| 2 | RED: surfaceLost không sống qua `runTeamTask` | `test/integration/task-runner-surface-lost-boundary.test.ts` (mới) | ✔ | `node scripts/test-runner.mjs test/integration/task-runner-surface-lost-boundary.test.ts` |
| 3 | RED: `rawFinalText` không sống qua ranh giới | `test/unit/runtime/task-runner/task-runner-result-boundary.test.ts` (mới) | ✔ | `node scripts/test-runner.mjs test/unit/runtime/task-runner/task-runner-result-boundary.test.ts` |
| 4 | RED: headless redeploy từ chối phantom `completed` | `test/unit/runtime/surface/degrade-replay-surface-lost.test.ts` (mở rộng `degrade.test.ts`) | ✔ | `node scripts/test-runner.mjs test/unit/runtime/surface/degrade-replay-surface-lost.test.ts` |
| 5 | Fix: truyền hai field qua ranh giới | `src/runtime/task-runner.ts` | — | như bước 2/3 |
| 6 | Regression + gates + decision record | suite hiện có | — | xem §7 |

---

## Bước 0 — Chuẩn bị

1. Xác nhận baseline `git log -1 --format=%H` ≈ `0b9fa771`; nếu khác, **kiểm tra
   lại mọi số dòng** trong `design.md`.
2. Đọc lại 3 file làm chuẩn fixture (không copy file, chỉ tái dùng pattern):
   - `test/unit/runtime/task-runner/task-runner-characterization.test.ts` —
     `makeFixture()`, `setMockEnv()`, `runTask()`, `eventTypes()`; đây là pattern
     **duy nhất** gọi `runTeamTask` với mock child.
   - `test/unit/runtime/task-runner/post-execution-surface-lost.test.ts` — fixture
     surfaceLost ở tầng finalizer (giữ nguyên, không sửa).
   - `test/unit/runtime/surface/degrade.test.ts` — pattern cho
     `planHeadlessRedeplays`.
3. Xác nhận defect còn tồn tại bằng đọc mã (không cần chạy):
   - `rg -n "surfaceLost" src/runtime/task-runner.ts` → kỳ vọng **0 hit**.
   - `rg -n "rawFinalText" src/runtime/task-runner.ts` → kỳ vọng **0 hit**
     (verification §4 F04 khẳng định đúng như vậy).
   Ghi lại output hai lệnh này vào `validation.md` §6 làm bằng chứng "trước fix".
4. **Rollback point R0** = commit hiện tại.

---

## Bước 1 — Thêm test seam: mock mode `surface-degraded`

**File sửa:** `src/runtime/child-pi/mock-fixtures.ts`

Thêm một nhánh trước dòng `return { exitCode: 1, stdout: "", stderr: \`[MOCK] failure: ${mock}\` };`:

```ts
// RR-013 test seam: reproduce the MuxSurface A1 degrade result WITHOUT a real
// multiplexer. child-executor's `childResult.surface?.degraded` branch is the
// only producer of TaskExecutionResult.surfaceLost; no other mock mode can
// reach it, and runTeamTask has no seam to inject surface providers.
// Guarded by the existing PI_CREW_ALLOW_MOCK parent-only check above.
if (mock === "surface-degraded") {
	return {
		exitCode: 0,
		stdout: "",
		stderr: "",
		rawFinalText: "",
		surface: {
			kind: "tmux",
			paneId: "%9",
			scriptPath: "/tmp/pi-crew-mock-launch.sh",
			degraded: {
				cause: "pane-closed",
				exitReason: "pane-closed",
				classifiedAt: new Date().toISOString(),
			},
		},
	};
}
```

**Ghi chú thiết kế (đưa vào comment trong file):** mock này **không** mô phỏng
`classifyOnExit` (2s window) — nó bắt đầu từ đúng điểm mà `classifyOnExit` đã trả
`degraded`. Điều đó là **đúng phạm vi**: defect RR-013 nằm ở ranh giới
`child-executor → task-runner → finalizer`, không nằm ở classify (đã được phủ bởi
`degrade.test.ts` + `child-pi-surface.test.ts`).

**Command:**

```bash
npm run typecheck
node scripts/test-runner.mjs test/unit/runtime/child-pi/child-pi-surface.test.ts
```

**Kỳ vọng:** typecheck pass; `child-pi-surface.test.ts` không hồi quy (mock mode
mới không ảnh hưởng đường surface thật).

**Rollback point R1** = commit chỉ chứa mock seam (revert độc lập, không ảnh
hưởng hành vi production vì cần `PI_CREW_ALLOW_MOCK=1`).

---

## Bước 2 — RED: `surfaceLost` không sống qua `runTeamTask`

**Test file mới:** `test/integration/task-runner-surface-lost-boundary.test.ts`

Đặt ở `test/integration/` vì nó chạy xuyên `runTeamTask` → `child-executor` →
`runChildPi` (mock) → `post-execution` — nhiều module tương tác. **Lưu ý vận
hành:** `test:integration` chạy `--test-concurrency=1`, nên file này sẽ nằm trong
integration suite; nếu thời gian chạy là vấn đề, có thể đặt ở
`test/unit/runtime/task-runner/` (unit runner chạy song song). **Chọn
`test/integration/`** vì tính chất multi-module và vì `npm run test:critical`
không bao gồm nó (giữ gate nhanh gọn).

**Fixture — hai lựa chọn, ưu tiên (i):**

- **(i) Chạy cả run qua `handleTeamTool`** — pattern của
  `test/integration/mock-child-run.test.ts`: set `PI_TEAMS_EXECUTE_WORKERS=1`,
  `PI_CREW_ALLOW_MOCK=1`, `PI_TEAMS_MOCK_CHILD_PI="surface-degraded"`, rồi gọi
  `handleTeamTool({ action: "run", team: "fast-fix", goal: "…" }, { cwd })` và đọc
  `loadRunManifestById(cwd, runId)`. Đây là đường **đầy đủ nhất** (team-runner →
  dispatch-batch → `runTeamTask` → finalizer), và file này là tiền lệ đã chạy
  trong integration suite. Test phải nhớ restore **cả ba** env var trong
  `finally` (bài học Round 19 ghi ngay trong file tiền lệ).
  ⚠️ Run này sẽ kết thúc ở trạng thái **không phải `completed`** sau fix (task
  `needs_attention`), nên **không** assert `manifest.status === "completed"`.
- **(ii) Gọi `runTeamTask` trực tiếp** — pattern của
  `task-runner-characterization.test.ts` (`createRunManifest` + `makeFixture` +
  `setMockEnv`). Kiểm soát tốt hơn, ít phụ thuộc team config, nhưng bỏ qua
  `team-runner`/`dispatch-batch`.

Chọn **(i)** làm test chính (nó chứng minh được đường end-to-end), **(ii)** chỉ
khi (i) quá phức tạp vì surface-degraded làm run abort/block ở tầng team-runner
(trường hợp đó là **phát hiện mới** — ghi vào `validation.md` §5, không tự sửa).

**Assertions (RED trước fix, GREEN sau fix):**

| # | Assert | Trước fix | Sau fix |
|---|---|---|---|
| 2a | `task.status === "needs_attention"` | ✗ (`"completed"`) | ✓ |
| 2b | `events.jsonl` **không** chứa `task.completed` | ✗ | ✓ |
| 2c | `events.jsonl` **không** chứa `task.failed` | ✓ | ✓ |
| 2d | `events.jsonl` **có** chứa `task.surface_lost` | ✗ | ✓ |
| 2e | `task.resultArtifact` là `undefined`/`null` (không fabricate) | ✓ | ✓ |
| 2f | `task.exitCode === null` | ✓ | ✓ |
| 2g | `task.diagnostics.surfaceLost.cause === "pane-closed"` | ✗ (`undefined`) | ✓ |
| 2h | `task.error === undefined` | ✓ | ✓ |

**Đây là AC-1/AC-3/AC-4/AC-5 của `overview.md` §5.** Test này là proof mà
`post-execution-surface-lost.test.ts` **không thể** đưa ra.

**Hình dạng kỳ vọng của một run (i) sau fix — đọc kỹ để không assert sai:**

1. Task degrade lần 1 → `needs_attention`, phát `task.surface_lost`.
2. Drain surface-degrade (`degrade.ts` + `planHeadlessRedeplays`) requeue **một
   lần** (idempotent qua `handledTaskIds` — xem bước 4 assertion 4d).
3. Lần chạy headless thứ hai: mock `surface-degraded` **vẫn** trả degraded
   (`runMockChildPi` chạy TRƯỚC nhánh surface trong `runChildPi`, nên mode này
   không phân biệt headless/surface). Task lại `needs_attention`.
4. Drain lần hai **skip** (`already re-dispatched once for surface loss`) ⇒ run kết thúc.

⇒ Kỳ vọng: `task.surface_lost` có thể xuất hiện **2 lần**; `task.completed`
**0 lần**; trạng thái cuối `needs_attention`. Assert theo tính chất
("không có `task.completed`", "có `task.surface_lost`") chứ **không** assert
số lần xuất hiện chính xác, trừ khi bạn đã xác nhận bằng lần chạy thật.
Nếu run treo hoặc số lần lặp khác dự kiến → đó là **phát hiện mới**, ghi vào
`validation.md` §5 và báo leader; không tự nới guard để test xanh.

**Command:**

```bash
node scripts/test-runner.mjs test/integration/task-runner-surface-lost-boundary.test.ts
```

**RED kỳ vọng:** 2a, 2b, 2d, 2g fail. Nếu 2a **pass ngay**, dừng lại: hoặc
`mock-fixtures.ts` chưa chạy đúng mode, hoặc defect đã được sửa ở nơi khác —
điều tra trước khi tiếp tục.

**Rollback point R2** = R1 + test file.

---

## Bước 3 — RED: `rawFinalText` không sống qua ranh giới

**Test file mới:** `test/unit/runtime/task-runner/task-runner-result-boundary.test.ts`

**Vấn đề:** để kiểm `rawFinalText` tới được consumer, phải quan sát **tác dụng**
của nó, không chỉ sự tồn tại của field. Consumer duy nhất của `rawFinalText` là
`post-execution.ts:136` → footer union ở `:452-458` (truyền vào `computeSpecGate`).
Không có task packet/spec thì gate là `applicable: false` — không quan sát được.

**Hai assertion, chọn cả hai:**

1. **3a — đường ngắn, chắc chắn:** chạy `runTeamTask` với mock `json-success`
   (như characterization scenario 2) và assert rằng **artifact kết quả** phản ánh
   text của worker. Đây là hành vi đã đúng (bug #21 / result artifact path), nên
   dùng làm **positive control**: nếu nó pass cả trước và sau fix, nó chứng minh
   fixture chạy đúng — nhưng **không** phải proof của defect.
2. **3b — proof thật:** dùng task packet có spec (`specId` + `specSnapshot` với ít
   nhất một `must` acceptance) và mock trả assistant text chứa footer
   `SPEC-EVIDENCE:\n<id>: …`, với `parsedOutput.finalText` **rỗng** (kịch bản
   compaction). Assert `task.specGate.footerPresent === true` **hoặc**
   `citedIds` chứa id — nghĩa là footer được đọc từ `rawFinalText` chứ không từ
   `finalText`.

   Nếu dựng fixture spec là quá nặng (cần spec store + snapshot), fallback:
   assert trực tiếp rằng `finalizeTaskResult` **nhận** `rawFinalText` non-undefined
   khi gọi qua `runTeamTask` — bằng cách thêm một assertion cấp thấp vào cùng file
   (đọc `task.diagnostics` hoặc dùng một spy/hook nếu có). **Nếu không làm được
   cách nào**, ghi 3b vào `validation.md` §5 "Known gaps" là **chưa có proof** và
   đánh dấu AC-2 là "chưa đủ proof" — **không** đánh dấu pass.

**Command:**

```bash
node scripts/test-runner.mjs test/unit/runtime/task-runner/task-runner-result-boundary.test.ts
```

**RED kỳ vọng:** 3b fail (nếu dựng được fixture spec).

**Rollback point R3** = R2 + test file.

---

## Bước 4 — RED: headless redeploy từ chối phantom `completed`

**Test file mở rộng:** `test/unit/runtime/surface/degrade-replay-surface-lost.test.ts`
(hoặc thêm một `test(...)` vào `test/unit/runtime/surface/degrade.test.ts` —
chọn **file mới** để không chạm test file đang được người khác sửa; xem ràng buộc
ownership ở §"Ràng buộc file").

**Nội dung:** gọi `planHeadlessRedeplays` với một `SurfaceDegradedEntry` cho task
đang ở `status: "completed"` (đúng trạng thái phantom mà defect tạo ra) và assert
hành vi **hiện tại**. Đây là test **characterization** — pass cả trước và sau fix
(vì guard của `degrade.ts` không đổi); xem ghi chú ⚠️ ngay dưới.

| # | Assert | Trước fix | Sau fix |
|---|---|---|---|
| 4a | Task `completed` **không** được requeue; `plan.skipped` chứa lý do `status completed is owned by another lifecycle` | ✓ | ✓ (khoá hành vi guard) |
| 4b | Task `needs_attention` **được** requeue | ✓ | ✓ |
| 4c | Task `running` **được** requeue | ✓ | ✓ |
| 4d | Gọi lần hai với cùng `handledTaskIds` ⇒ `requeuedTaskIds` rỗng, `skipped` có `already re-dispatched once for surface loss` | ✓ | ✓ |

**Đây là test hai mục đích:** nó đóng băng hành vi guard của `degrade.ts` (không
được nới — xem design §5.3 alternative #7), **và** chứng minh chuỗi nhân quả:
defect ở ranh giới khiến task thành `completed` ⇒ `planHeadlessRedeplays` **từ
chối** cứu nó.

⚠️ **4a là test khoá hành vi, KHÔNG phải test cần GREEN:** sau fix, 4a **vẫn**
pass với input `status: "completed"` — vì guard của `degrade.ts` không đổi.
Điều đổi là `runTeamTask` không còn **tạo ra** task `completed` khi mất surface
(đã kiểm ở bước 2). Nếu ai đó "sửa" 4a bằng cách cho `completed` được requeue →
vi phạm design §5.3 và phải dừng lại.

**Command:**

```bash
node scripts/test-runner.mjs test/unit/runtime/surface/degrade-replay-surface-lost.test.ts
```

**Kỳ vọng:** pass ngay (characterization). Đây là **AC-6/AC-7**.

**Rollback point R4** = R3 + test file.

---

## Bước 5 — Fix: truyền hai field qua ranh giới

**File sửa:** `src/runtime/task-runner.ts` (chỉ file này)

**Thay đổi (3 chỗ):**

1. Thêm hai khai báo local cạnh nhóm `:124-134`:

```ts
// RR-013 (F04): the child-process branch may return these; every other branch
// leaves them undefined. They MUST be forwarded into execResult — the manual
// field list previously dropped surfaceLost (making finalizeTaskResult's
// needs_attention branch unreachable in production) and rawFinalText
// (starving the spec-evidence footer union).
let surfaceLost: TaskExecutionResult["surfaceLost"];
let rawFinalText: string | undefined;
```

2. Trong nhánh `runtimeKind === "child-process"` (`:139-153`), thêm hai dòng
   cạnh các dòng `child.*` hiện có:

```ts
surfaceLost = child.surfaceLost;
rawFinalText = child.rawFinalText;
```

3. Trong literal `execResult` (`:208-220`), thêm hai field:

```ts
surfaceLost,
rawFinalText,
```

**KHÔNG** set hai local này ở nhánh live-session/scaffold — để chúng `undefined`,
giữ nguyên hành vi hai nhánh đó (live-session có đường terminalisation riêng;
scaffold không được hưởng nhánh degrade).

**Cập nhật comment `:120-122`** cho đúng sau fix: comment hiện nói
`finalizeTaskResult's surfaceLost branch ignores it` — vẫn đúng về
`resultArtifact`, nhưng nên nói thêm rằng nhánh đó **giờ chạm tới được** (tránh
để lại dấu vết của defect cũ gây nhầm như trường hợp `crew-broker.ts:1652-1657`).

**Command:**

```bash
node scripts/test-runner.mjs test/integration/task-runner-surface-lost-boundary.test.ts test/unit/runtime/task-runner/task-runner-result-boundary.test.ts
npm run typecheck
```

**GREEN kỳ vọng:** bước 2 toàn bộ pass; bước 3 pass (hoặc 3b ghi vào Known gaps
nếu fixture spec không dựng được); typecheck pass.

**Regression ngay sau fix (bắt buộc — đây là guard chống over-correction):**

```bash
node scripts/test-runner.mjs \
  test/unit/runtime/task-runner/post-execution-surface-lost.test.ts \
  test/unit/runtime/task-runner/task-runner-characterization.test.ts \
  test/unit/runtime/task-runner/post-execution-stderr-only.test.ts
```

Đặc biệt: `task-runner-characterization.test.ts` scenario 3 (yield-exclusion)
phải pass — nếu nó đỏ, fix đã lan `needs_attention` sang task child-process bình
thường (vi phạm AC-9). **Dừng và điều tra.**

**Rollback point R5** = commit fix (một file, revert độc lập).

---

## Bước 6 — (không có bước 6)
Story này không có nhánh "tuỳ kết luận" như RR-012. Bước 5 là fix duy nhất.
Nếu trong bước 2/3 phát hiện defect **bổ sung** (ví dụ field thứ ba cũng bị bỏ),
**không** tự mở rộng phạm vi: ghi vào `validation.md` §5 và báo leader — việc mở
rộng phạm vi cần phê duyệt lại (lane high-risk).

---

## Bước 7 — Regression, gates, harness delta

**Thứ tự chạy (dừng ngay khi đỏ):**

```bash
# 1. Typecheck
npm run typecheck

# 2. Targeted — test mới
node scripts/test-runner.mjs \
  test/integration/task-runner-surface-lost-boundary.test.ts \
  test/unit/runtime/task-runner/task-runner-result-boundary.test.ts \
  test/unit/runtime/surface/degrade-replay-surface-lost.test.ts

# 3. Vùng task-runner + surface (unit)
node scripts/test-runner.mjs \
  test/unit/runtime/task-runner/post-execution-surface-lost.test.ts \
  test/unit/runtime/task-runner/post-execution-stderr-only.test.ts \
  test/unit/runtime/task-runner/task-runner-characterization.test.ts \
  test/unit/runtime/surface/degrade.test.ts \
  test/unit/runtime/child-pi/child-pi-surface.test.ts \
  test/unit/runtime/child-pi/child-pi-env-spread.test.ts

# 4. Critical gate (14 file)
npm run test:critical

# 5. Integration (plan §4: F04 thuộc nhóm cần integration)
npm run test:integration

# 6. Lint + format
npm run lint && npm run format:check

# 7. Gates consistency
npm run check:event-types        # task.surface_lost phải đã đăng ký
npm run check:lazy-imports
npm run check:wc-gate
npm run check:decision-drift

# 8. Unit full
npm run test:unit

# 9. Bundle (bắt buộc: dist/index.mjs là bundle mặc định từ v0.9.17)
npm run build:bundle && npm run test:bundle

# 10. Full gate
npm run ci
```

**Lưu ý về `task.surface_lost`:** event này **đã** được phát ở
`post-execution.ts:171-177` trước fix (nhánh chỉ unreachable, không phải chưa
viết). Vì vậy `check:event-types` phải **đã** xanh cho event này; nếu không, đó là
drift có sẵn (plan §8 ghi `check:event-types` report mode: 89 registered vs 123
emitted) — không quy cho RR-013.

**Harness delta:**

1. `docs/decisions/<YYYY-MM-DD>-execution-result-boundary-fidelity.md` — stub ở
   `design.md` §9.
2. `docs/decisions/README.md` — thêm hàng index.
3. `docs/TEST_MATRIX.md`:
   - thêm hàng RR-013;
   - **cập nhật** hàng "Degrade + classify timeout + lockout + headless resume (§7)"
     (hiện `implemented` với evidence `degrade.test.ts, post-execution-surface-lost.test.ts,
     team-runner-surface-registry-lifecycle.test.ts`) — bổ sung test boundary mới
     vào cột Evidence, vì trước đây hàng này tuyên bố đã phủ trong khi đường
     production bị đứt.
4. `docs/stories/RR-013/validation.md` — điền §6 Evidence.
5. `docs/stories/README.md` — cập nhật trạng thái RR-013.

**Gate đã biết đang đỏ (không thuộc story này — plan §4):**

- `test/unit/interrupt-guard-ack.test.ts` — flaky trong full suite, pass khi chạy riêng.
- `test/unit/runtime/broker/crew-broker-symlink-steering.test.ts` — trả
  `request-timeout` thay vì `ok: true`.
- `npm run check:env-vars` fail: `src/extension/knowledge-injection.ts:466`,
  `src/runtime/stale-reconciler.ts:287`.

**Lưu ý môi trường (`.crew/knowledge.md`):** khi chạy gate từ **bên trong** pi-crew
worker, scrub `PI_CREW_*` trước khi đánh giá assert "absence":

```bash
env -u PI_CREW_SCRATCHPAD -u PI_CREW_TASK_ID -u PI_CREW_ATTEMPT \
    -u PI_CREW_ARTIFACTS_ROOT -u PI_CREW_SCRATCHPAD_SNAPSHOT \
    -u PI_CREW_BROKER_TASK_ID -u PI_CREW_BROKER_RUN_ID \
    node scripts/test-runner.mjs <file>
```

Điều này đặc biệt quan trọng ở bước 2: các assert 2b/2d là assert **absence**
(`task.completed` không được có, `task.surface_lost` phải có).

**Rollback point R7** = commit cuối (gồm doc).

---

## Ràng buộc file (conflict-safe)

Theo `AGENTS.md` → "Conflict-safe task splitting": một owner cho mỗi file.

| File | Bước chạm | Rủi ro trùng |
|---|---|---|
| `src/runtime/child-pi/mock-fixtures.ts` | Bước 1 | Thấp — nhưng **kiểm tra trước** xem có worker/story khác đang sửa (RR-019 chạm `agents/`, `workflows/`; không đụng file này) |
| `src/runtime/task-runner.ts` | Bước 5 | **CAO** — file này cũng là nơi RR-012 **không** chạm, nhưng bất kỳ refactor `runTeamTask` nào khác sẽ trùng. Phải xác nhận ownership trước khi sửa |
| `test/unit/runtime/task-runner/task-runner-characterization.test.ts` | Chỉ **đọc** (regression) | **KHÔNG sửa.** Nếu nó đỏ sau fix, đó là tín hiệu over-correction, không phải test cần cập nhật |
| `test/unit/runtime/surface/degrade.test.ts` | Chỉ **đọc** | **KHÔNG sửa** — dùng file mới `degrade-replay-surface-lost.test.ts` |

## Bảng rollback tổng hợp

| Point | Nội dung | Cách rollback |
|---|---|---|
| R0 | Baseline `0b9fa771` | — |
| R1 | Mock seam `surface-degraded` | `git revert <R1>` |
| R2 | Test boundary (integration) | xoá file test |
| R3 | Test result boundary (unit) | xoá file test |
| R4 | Test degrade replay | xoá file test |
| R5 | Fix `task-runner.ts` | `git revert <R5>` — độc lập với R1 |
| R7 | Docs + TEST_MATRIX + ADR | revert commit doc |

**Thứ tự rollback nếu phải bỏ toàn bộ story:** R7 → R5 → R4 → R3 → R2 → R1.
Mock seam R1 có thể giữ lại độc lập (nó vô hại và hữu ích cho test sau này), miễn
là có ghi chú lý do trong commit.
