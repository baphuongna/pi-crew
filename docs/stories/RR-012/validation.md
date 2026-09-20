# RR-012 — Validation: vòng đời delegation (cwd + promote)

- **Story:** `docs/stories/RR-012/overview.md` · **Design:** `docs/stories/RR-012/design.md`
- **Exec plan:** `docs/stories/RR-012/exec-plan.md`
- **Status:** planned — chưa có evidence (mục §6 để trống, điền sau khi implement)
- **Baseline:** `pi-crew@0.11.1`, commit `0b9fa771`

## 1. Thang kiểm chứng (validation ladder)

Bảng lấy từ plan §4; cột "Dùng cho RR-012" nêu lý do cụ thể cho story này.

| Level | Command | Expected | Dùng cho RR-012 |
|---|---|---|---|
| quick | `npm run typecheck` | pass (tsc + strip-types import) | Bắt buộc sau mỗi bước sửa `src/` |
| targeted | `node scripts/test-runner.mjs <file>` | 0 fail | Vòng lặp RED→GREEN cho 3 test mới |
| critical | `npm run test:critical` | 14 file, 0 fail | Trước mỗi commit fix (bước 4, 5, 6) |
| unit | `npm run test:unit` | 0 fail (trừ 2 test flaky đã biết — §5) | Trước khi đóng story |
| lint | `npm run lint && npm run format:check` | pass | Story sửa `src/` ⇒ bắt buộc |
| gates | `npm run check:decision-drift`, `check:event-types`, `check:lazy-imports`, `check:wc-gate` | pass | Chạm `src/runtime/broker`, `src/runtime/`; có thể thêm event/ADR |
| integration | `npm run test:integration` | 0 fail (4 skip là bình thường) | Plan §4 xếp F03, F16 vào nhóm cần integration |
| bundle | `npm run build:bundle && npm run test:bundle` | bundle rebuild, 2 pass | Bắt buộc: `dist/index.mjs` là bundle mặc định từ v0.9.17 |
| full | `npm run ci` | toàn chuỗi xanh | Trước publish |

**Chạy targeted cho 3 test mới của story:**

```bash
node scripts/test-runner.mjs \
  test/unit/runtime/broker/delegate-execution-cwd.test.ts \
  test/unit/runtime/broker/delegate-shadow-lifecycle.test.ts \
  test/unit/runtime/scheduling/shadow-task-dag-readiness.test.ts
```

**Chạy regression vùng delegation (suite hiện có phải giữ nguyên kết quả):**

```bash
node scripts/test-runner.mjs \
  test/unit/runtime/broker/delegate-broker.test.ts \
  test/integration/delegate-roundtrip-e2e.test.ts \
  test/unit/runtime/spawn-policy.test.ts \
  test/unit/runtime/scheduling/nested-slots-deadlock.test.ts \
  test/unit/runtime/child-pi/child-pi-env-spread.test.ts
```

**Lưu ý chạy từ trong worker** (`.crew/knowledge.md`): scrub `PI_CREW_*` trước khi
đánh giá các assert "absence", và **không** chạy cả một test directory trong một
lệnh `node --test <dir>/` từ trong worker (child runner crash do tranh tài
nguyên) — chạy từng file hoặc nhóm nhỏ.

## 2. Ánh xạ Acceptance Criteria → proof

Mỗi AC trong `overview.md` §5 ánh xạ tới một test cụ thể. Cột "Loại proof" theo
`docs/TEST_MATRIX.md` → Evidence Rules.

| AC | Proof | Test file | Loại proof | Trạng thái |
|---|---|---|---|---|
| AC-1 (spawner nhận `task.cwd`) | assert `spawns[0].cwd === task.cwd` và `!== brokerCwd` | `delegate-execution-cwd.test.ts` | unit | planned |
| AC-2 (artifacts root đúng cwd) | assert `grandchildArtifactsRoot(task.cwd, …)` tồn tại; root dưới broker cwd **không** tồn tại; + test cấu trúc: `delegate-spawn.ts` dùng helper | `delegate-execution-cwd.test.ts` | unit | planned |
| AC-3 (một nguồn cwd cho 3 việc) | broker cwd ≠ task cwd, executor khác `running` tại `task.cwd` ⇒ `workspace-conflict`; executor ở broker cwd ⇒ admitted | `delegate-execution-cwd.test.ts` | unit | planned |
| AC-4 (không hồi quy `workspaceMode: single`) | broker cwd == task cwd ⇒ spawner nhận giá trị như cũ; + `delegate-broker.test.ts` giữ xanh | `delegate-execution-cwd.test.ts`, `delegate-broker.test.ts` | unit | planned |
| AC-5 (promote `running`) | spawner pending → đọc `tasks.json` ⇒ `gc-*` `status === "running"` | `delegate-shadow-lifecycle.test.ts` | unit | planned |
| AC-6 (depth-2 delegate không bị `parent-not-running`) | client thứ hai `hello(..., subId, token)` → `delegate.request` ⇒ lỗi **không** phải `parent-not-running` | `delegate-shadow-lifecycle.test.ts` | unit | planned |
| AC-7 (terminalize mọi outcome) | 3 nhánh: resolve `ok:true` → `completed`; `ok:false` → `failed`; throw → `failed`; không nhánh nào kẹt `queued`/`running` | `delegate-shadow-lifecycle.test.ts` | unit | planned |
| AC-8 (kết luận reachability) | Kết luận (a)-(e) ở §3 + assert characterization | `shadow-task-dag-readiness.test.ts` | unit (proof cấp thấp nếu không dựng được tick thật — ghi rõ) | planned |
| AC-9 (guard nếu chạm được) | RED: `findStep()` throw `ResourceNotFound`; GREEN: shadow không vào `batch`, run không abort | `shadow-task-dag-readiness.test.ts` | unit | planned / **N/A nếu AC-8 = không chạm** |
| AC-10 (không hồi quy) | 6 file regression ở §1 giữ nguyên kết quả | danh sách §1 | unit + integration | planned |
| AC-11 (gates consistency) | `typecheck`, `lint`, `format:check`, `check:decision-drift`, `check:event-types`, `check:wc-gate` | — | gate | planned |

**Không có AC nào cần model thật, LLM, hay provider** — mọi proof dùng injected
spawner hoặc mock child (`PI_TEAMS_MOCK_CHILD_PI`). Đây là điều kiện để AC
"objectively testable" theo yêu cầu lane.

## 3. Kết luận bước 1 (verification-first) — ĐIỀN SAU

Mục 6.1 của `docs/archive/2026-09-17-pi-crew-review-verification.md` ghi rủi ro
scheduler kề bên là **chưa xác minh end-to-end**. Bước 1 của `exec-plan.md` phải
trả lời 5 câu dưới đây **kèm bằng chứng**. Cho tới khi điền xong, AC-8 chưa pass
và AC-9 chưa có hiệu lực.

| # | Câu hỏi | Trả lời | Bằng chứng |
|---|---|---|---|
| a | `getReadyTasks()` (`task-graph.ts`) có trả shadow `gc-*` là DAG-ready? | *(chưa)* | |
| b | `taskGraphSnapshot()` (`task-graph-scheduler.ts`) có trả shadow trong `.ready`? | *(chưa)* | |
| c | Shadow có vào `ctx.tasks` trong một tick scheduler thật? | *(chưa)* | |
| d | `findStep()` (`dispatch-batch.ts:718`) có bị gọi với shadow? | *(chưa)* | |
| e | **Kết luận: chạm được / không chạm được / chưa kết luận** | *(chưa)* | |

**Quy tắc đánh dấu:** AC-8 chỉ được coi là pass khi dòng (e) có một kết luận dứt
khoát **và** một trong hai dạng bằng chứng: (i) test tái hiện được, hoặc (ii) lập
luận + test chứng minh không chạm được. "Chưa kết luận" ⇒ AC-8 **fail** (không
được im lặng bỏ qua).

## 4. Kiểm tra thủ công bổ sung (manual evidence)

Story này có một điểm không thể kiểm hoàn toàn bằng unit test: **worktree mode
là opt-in** (hiệu chỉnh C3), nên đường F03 thật cần `workspaceMode: "worktree"`.
Kiểm thủ công (nếu có điều kiện, không bắt buộc để đóng story):

```bash
# 1. Chạy một run worktree-mode thật (cần model thật — chỉ làm khi có auth)
#    và kiểm rằng grandchild không chạm leader workspace.
# 2. Kiểm artifact root trên đĩa:
find .crew/artifacts -type d -name "nested" | head
#    Kỳ vọng: nested/ nằm dưới <task.cwd>/.crew/artifacts/<runId>/<parentTaskId>/
# 3. Kiểm events.jsonl:
grep -E '"delegate\.(requested|admitted|rejected|rolled_up)"' .crew/state/runs/<runId>/events.jsonl
#    Kỳ vọng: không có delegate.rejected với reason "parent-not-running"
#    cho một grandchild depth-2 đang chạy.
```

Kết quả thủ công ghi vào §6 (Evidence) với nhãn rõ là manual, không phải CI.

## 5. Known gaps / rủi ro chưa kiểm được

1. **Rủi ro scheduler (mục 6.1 của verification) — chưa kết luận.** Đây là gap
   lớn nhất của story. Bước 1 phải đóng. Nếu không dựng được tick scheduler thật
   trong unit test, phải ghi rõ "proof cấp thấp" và để AC-8 ở trạng thái
   "chưa kết luận", **không** đánh dấu pass.
2. **F03 exposure là opt-in (C3).** Mọi builtin team khai `workspaceMode: "single"`
   (`teams/*.team.md`; `state-store.ts:424` default `"single"`). Vì vậy unit test
   phải **tự dựng** `task.cwd !== broker cwd`; không có fixture production nào
   sẵn. Điều này cũng nghĩa: không có bằng chứng end-to-end trong repo rằng bug
   đã từng xảy ra với cấu hình mặc định — chỉ có đường mã sai.
3. **F16 ở depth ≥ 3 chưa có test end-to-end thật.** AC-6 kiểm "không bị
   `parent-not-running`", nhưng một spawn depth-3 **thật** (grandchild của
   grandchild) cần 2 lần spawn lồng nhau. ADR-5 B3 case (d) yêu cầu điều này
   ("as a real spawn"); nếu không chạy được trong CI (không model), ghi vào gap
   này và để B3 làm bằng chứng bảo mật ở PR.
4. **Hai unit test đã đỏ trước story** (plan §4, review §6.2):
   - `test/unit/interrupt-guard-ack.test.ts` — full suite expected 1 / actual 0;
     chạy riêng 2/2 pass (flaky, chưa rõ root cause).
   - `test/unit/runtime/broker/crew-broker-symlink-steering.test.ts` — trả
     `request-timeout` thay vì `ok: true`, cả full suite và chạy riêng. Assertion
     thất bại **trước** kiểm tra escaped write ⇒ **không** phải bằng chứng
     symlink boundary bị vượt.
   ⇒ RR-012 **không** được coi là "xanh" nếu hai test này còn đỏ. Chúng thuộc
   phạm vi RR-015 (CI integrity) hoặc story riêng.
5. **CI false-green (F05) chưa sửa.** `scripts/test-runner.mjs:142`
   `process.exit(result.status ?? 0)` ⇒ coordinator bị SIGKILL cho exit 0. Cho
   tới khi RR-015 xong, kết luận "xanh" từ `npm test` chưa hoàn toàn đáng tin.
   Đây là lý do plan §6 xếp RR-015 ngay sau RR-013.
6. **Bundle staleness.** Sửa `src/` mà không `npm run build:bundle` thì session
   thật vẫn dùng bundle cũ (`.crew/knowledge.md`). Bước 7 của exec-plan có gate
   này; đừng bỏ qua khi kiểm thủ công.
7. **`check:env-vars` đang fail** (2 raw env reads, không thuộc story này):
   `src/extension/knowledge-injection.ts:466`, `src/runtime/stale-reconciler.ts:287`.
   Không được quy cho RR-012.
8. **`workspace-conflict` (AC-3) phụ thuộc erratum ADR-5 §9.** Hành vi shipped là
   REJECT-on-overlap cho write-capable grandchild khi serialization chưa được
   thiết lập (không phải auto-enable). Test AC-3 phải khớp hành vi này, không
   khớp bản prose cũ trong ADR.

## 6. Evidence — ĐIỀN SAU

Điền sau khi implement. Không đánh dấu story `completed` khi còn ô trống.

| Hạng mục | Bằng chứng |
|---|---|
| Bước 1 — kết luận reachability (§3) | |
| AC-1 (`spawns[0].cwd === task.cwd`) | |
| AC-2 (artifacts root dưới `task.cwd`) | |
| AC-3 (overlap check dùng đúng cwd) | |
| AC-4 (`workspaceMode: single` không hồi quy) | |
| AC-5 (shadow `running` trong lúc spawn) | |
| AC-6 (depth-2 delegate không `parent-not-running`) | |
| AC-7 (terminalize 3 outcome) | |
| AC-8 (kết luận reachability) | |
| AC-9 (guard scheduler, nếu cần) | |
| AC-10 (regression 6 file) | |
| AC-11 (gates consistency) | |
| `npm run typecheck` | |
| `npm run test:critical` | |
| `npm run test:integration` | |
| `npm run lint && npm run format:check` | |
| `npm run build:bundle && npm run test:bundle` | |
| `npm run ci` | |
| Kiểm thủ công (§4) | |
| Decision record đã viết | |
| `docs/TEST_MATRIX.md` đã cập nhật | |

## 7. Điều kiện đóng story

Story chỉ được đánh dấu `completed` khi **tất cả** điều sau đúng:

1. Cả 3 test mới tồn tại và pass, và **mỗi** test đã được chứng minh RED trước
   fix (ghi lại output RED vào §6 — không chỉ trạng thái cuối).
2. §3 có kết luận dứt khoát cho câu (e) kèm bằng chứng.
3. AC-10 pass (6 file regression không đổi kết quả).
4. AC-11 pass.
5. Decision record (hoặc amendment ADR-5) đã tồn tại và được ghi vào
   `docs/decisions/README.md`.
6. `docs/TEST_MATRIX.md` có hàng RR-012 với Status và Evidence thật.
7. §5 (Known gaps) đã được cập nhật: mọi gap còn lại được nêu tên, không bị bỏ im.
8. Nếu story chạm worktree mode thật hoặc thay đổi hành vi quan sát được của
   record `gc-*` trong `team status`: có ghi chú cho release.
