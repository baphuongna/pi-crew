# Plan — Khắc phục review 2026-09-17 (RR-010 → RR-019)

- **Ngày:** 2026-09-17
- **Baseline:** `pi-crew@0.11.1`, commit `0b9fa771`
- **Nguồn:** `docs/archive/2026-09-17-pi-crew-review.md` (20 phát hiện)
- **Đã xác minh độc lập:** `docs/archive/2026-09-17-pi-crew-review-verification.md`
  (19/20 VERIFIED, 1 PARTIAL, 0 REFUTED)
- **Trạng thái:** **executed** — phê duyệt "fix all" 2026-09-17 (cuối ngày); toàn bộ 10 story đã triển khai với bằng chứng RED→GREEN (xem `docs/TEST_MATRIX.md`); CI 3-OS pending push
- **Intake:** `docs/FEATURE_INTAKE.md`

## 1. Bối cảnh

Review 2026-09-17 ghi 20 phát hiện (5 Cao, 14 Vừa, 1 Thấp). Một đợt xác minh độc
lập chạy 5 verifier song song, mỗi người đọc mã và viết probe import module thật.
Kết quả: **19 VERIFIED, 1 PARTIAL (chỉ sai vị trí gán), 0 REFUTED**. Năm phát
hiện được xác nhận **nặng hơn** mô tả gốc: F01, F04, F09, F12, F19.

Vì vậy kế hoạch này **không** đánh giá lại tính đúng của review; nó chuyển các
phát hiện đã xác minh thành story packet có acceptance criteria và regression
test, theo lộ trình 3 đợt của review (§8) với hai điều chỉnh thứ tự (§7).

## 2. Phân loại intake (theo `docs/FEATURE_INTAKE.md`)

### 2.1 Input type

| Finding | Type | Ghi chú |
|---|---|---|
| F01 | Bug fix (data integrity) | Snapshot không đầy đủ vẫn cho phép xóa worktree |
| F02 | Bug fix (concurrency) | Run lock cho hai async context cùng process |
| F03 | Bug fix (isolation) | Delegated worker chạy ngoài worktree của cha |
| F04 | Bug fix (result propagation) | `surfaceLost` bị bỏ trước finalizer |
| F05 | Bug fix (CI integrity) | Coordinator chết nhưng wrapper exit 0 |
| F06 | Performance (write amplification) | Agent upsert phá coalescing |
| F07 | Performance (retrieval) | Event cursor đọc lại toàn lịch sử |
| F08 | Bug fix (config) | "Depth limit" đếm số giá trị |
| F09 | Bug fix (durability) | Retention phát lại message đã ack |
| F10 | Bug fix (persistence) | Cancel bị pending write tạo lại status |
| F11 | Bug fix (lifecycle) | Async init tái tạo tài nguyên sau cleanup |
| F12 | Bug fix (lifecycle) | Hook observability tích lũy context cũ |
| F13 | Bug fix (lifecycle) | Session switch gỡ RPC/cache không khôi phục |
| F14 | Performance (UI) | Preload polling vô hiệu idle stop |
| F15 | Bug fix (concurrency) | Semaphore waiter không hủy được |
| F16 | Bug fix (lifecycle) | Grandchild không được promote `running` |
| F17 | Bug fix (quality/prompt) | Verification prompt mâu thuẫn, cache vô provenance |
| F18 | Bug fix (dev tooling) | `test:changed` bỏ qua thay đổi chưa commit |
| F19 | Bug fix (test infra) | Smoke argv không kiểm tra argv; canary bị skip |
| F20 | Bug fix (dead code) | Benchmark harness nhận empty judge |

### 2.2 Affected modules

| Module | Findings |
|---|---|
| `src/worktree/` | F01 |
| `src/state/` | F02, F09, F10 |
| `src/runtime/` (broker, task-runner, scheduling) | F03, F04, F15, F16 |
| `src/runtime/crew-agent-records.ts` | F06, F07, F10 |
| `src/config/` | F08 |
| `src/extension/` | F11, F12, F13 |
| `src/ui/` | F13, F14 |
| `src/benchmark/` | F20 |
| `agents/`, `workflows/` | F17 |
| `scripts/`, `test/smoke/`, `.github/` | F05, F18, F19 |

### 2.3 Risk checklist

| Finding | State mutation | Concurrency | Child process | Error handling | External tools | API contract | Backward compat | Security | # flags | Lane |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| F01 | ● | | ● | ● | ● (git) | | | ● | 5+ | **high-risk** |
| F02 | ● | ● | | ● | | | | | 3 | **high-risk** |
| F03 | ● | | ● | | ● (git) | | | ● | 4 | **high-risk** |
| F04 | ● | | | ● | | | ● | | 3 | **high-risk** |
| F15 | | ● | ● | ● | | | | | 3 | **high-risk** |
| F16 | ● | | ● | ● | | | ● | | 4 | **high-risk** |
| F05 | | | ● | ● | ● | | | | 3 | normal |
| F06 | ● | | | | | | | | 1 | normal |
| F07 | | | | | | | ● | | 1 | normal |
| F08 | | | | ● | | | ● | ● | 3 | normal |
| F09 | ● | | | ● | | | ● | | 3 | normal |
| F10 | ● | | | ● | | | | | 2 | normal |
| F11 | ● | | | ● | | | | | 2 | normal |
| F12 | ● | | | | | | | | 1 | normal |
| F13 | ● | | | | | ● | | | 2 | normal |
| F14 | | | | | | | | | 1 | normal |
| F17 | | | | | | | ● | | 1 | normal |
| F18 | | | | | ● | | | | 1 | normal |
| F19 | | | | | ● | | | | 1 | normal |
| F20 | | | | ● | | | | | 1 | tiny |

**Hard gate áp dụng** (`docs/FEATURE_INTAKE.md` → Classification):

- **F01:** destructive worktree path + external tool execution (git) → high-risk.
  Củng cố bởi luật `AGENTS.md:40`: "Worktree cleanup must preserve dirty worktrees
  unless `force` is explicitly set." F01 là vi phạm luật này.
- **F02:** state mutation + concurrency → hard gate → high-risk.
- **F03:** child process spawning + security boundary → high-risk.
- **F15:** concurrency primitive + child process → high-risk.
- **F16:** child process spawning + state mutation + backward compat → high-risk.
- **F04:** state mutation (terminal task status) + error propagation + backward
  compat (ý nghĩa của `completed`) → high-risk (không thuộc hard gate văn bản,
  nhưng nâng lane vì thay đổi ngữ nghĩa terminal state và có mất mát tất định).

### 2.4 Story packets

10 story, gộp theo module chung + đợt, theo tiền lệ RR-008/RR-009 (một story
nhiều issue).

| Story | Lane | Findings | Đợt | Phụ thuộc |
|---|---|---|---|---|
| RR-010 | high-risk | F01 | 1 | — |
| RR-011 | high-risk | F02 | 1 | — |
| RR-012 | high-risk | F03, F16 (+ rủi ro scheduler mới) | 1 | — |
| RR-013 | high-risk | F04 | 1 | — |
| RR-014 | high-risk | F15 | 2 | RR-011 (cùng miền lock/slot) |
| RR-015 | normal | F05, F18, F19, F20 | 1 | — |
| RR-016 | normal | F08, F09, F10 | 1 | — |
| RR-017 | normal | F06, F07 | 2 | — |
| RR-018 | normal | F11, F12, F13 | 2 | — |
| RR-019 | normal | F14, F17 | 3 | — |

## 3. Nguyên tắc thực thi

1. **Regression test trước, sửa sau.** Mỗi story bắt đầu bằng test tái hiện lỗi
   (RED), dùng probe đã có trong báo cáo xác minh làm seed.
2. **Không nới lỏng durability để đạt hiệu năng.** F06/F07/F14 là tối ưu ở
   caller; giữ nguyên tầng durability đã đo (`bench/b12-fsync-counts.bench.ts`).
3. **Không tăng `maxConcurrentWorkers`** trước khi F02/F06 xong.
4. **Fail-closed cho mọi nhánh không xác định** (F05 là mẫu).
5. **Không dùng "đã ghi artifact" làm bằng chứng "đã sao lưu đầy đủ"** (F01).
6. **Bảo toàn result qua ranh giới branch** bằng discriminated result type, không
   chép tay danh sách optional field (F04).
7. Mọi thay đổi high-risk phải có **decision record** trong `docs/decisions/` và
   cập nhật `docs/TEST_MATRIX.md`.

## 4. Làn kiểm chứng (validation ladder)

| Level | Command | Dùng cho |
|---|---|---|
| quick | `npm run typecheck` | mọi story |
| targeted | `node scripts/test-runner.mjs <file>` | vòng lặp RED→GREEN |
| critical | `npm run test:critical` | trước commit (14 file) |
| unit | `npm run test:unit` | normal+ trước khi đóng story |
| lint | `npm run lint && npm run format:check` | mọi story có sửa `src/` |
| gates | `npm run check:env-vars`, `check:event-types`, `check:decision-drift`, `check:lazy-imports`, `check:wc-gate` | story chạm env/event/ADR |
| integration | `npm run test:integration` | F01, F02, F03, F09, F16 |
| bundle | `npm run build:bundle && npm run test:bundle` | sau khi sửa `src/` (bundle là mặc định) |
| full | `npm run ci` | trước publish |

**Lưu ý bundle:** `dist/index.mjs` là bundle mặc định (từ v0.9.17). Sau khi sửa
`src/`, phải `npm run build:bundle` để thay đổi có hiệu lực trong session thật
(xem `.crew/knowledge.md`). Gate `check:bundle-staleness` chạy ở mặc định; CI
dùng `--committed-hash`.

**Hai unit test đang fail (từ review §6.2) — phải xử lý trước hoặc cùng RR-015:**

- `test/unit/interrupt-guard-ack.test.ts` — "RT-4: REAL interrupt guard writes
  acknowledged:true + body fires exactly once": full suite expected 1, actual 0;
  chạy riêng 2/2 pass. Chưa xác định root cause (flaky).
- `test/unit/runtime/broker/crew-broker-symlink-steering.test.ts` — "steer.push
  does not follow a symlinked steering directory outside artifactsRoot":
  full suite và chạy riêng đều trả `request-timeout` thay vì `ok: true`; test
  thay timer bằng timeout 100 ms.

Không story nào được coi là "xanh" nếu `npm test` còn fail vì hai test này.

## 5. Nội dung từng story

Mỗi story có packet riêng. High-risk có folder 4 file
(`overview.md`, `design.md`, `exec-plan.md`, `validation.md`).

### Đợt 1 — Bảo vệ dữ liệu và kết quả

**RR-010 — F01: Hợp đồng snapshot/cleanup worktree** *(high-risk)*

- Vấn đề: `snapshotDirtyWorktree()` trả `boolean`; truncation ở 256 KiB, diff
  lỗi và entry không đọc được đều không làm snapshot thất bại, nên
  `checkout -- .` + `clean -fd` vẫn chạy.
- Xác minh bổ sung: file `chmod 000` **biến mất hoàn toàn** khỏi artifact mà vẫn
  trả `true` → mất mát không giới hạn ở phần đuôi >256 KiB.
- Vị trí: `src/worktree/worktree-manager.ts:686,696-703,727,855-863,1015-1023`.
- AC: backup không đầy đủ ⇒ bytes gốc còn nguyên (hoặc cần phê duyệt phá hủy).
- AC: `readFileSync` không đọc quá cap (allocation bound).

**RR-011 — F02: Quyền sở hữu run lock theo async context** *(high-risk)*

- Vấn đề: async acquisition dùng `treatOwnPidAsStealable: true`
  (`locks.ts:378-384`) → hai async context độc lập cùng process vào critical
  section (`maxActive = 2`); release theo PID không phân biệt được holder.
- Caller thật: `post-execution.ts:626-629` (`withRunLock` bao `await`).
- Phạm vi chính xác: mutual exclusion **chỉ vỡ** async↔async.
- AC: hai context độc lập ⇒ `maxActive === 1`; B vào sau A, không mất cập nhật.
- AC: nested re-entrance, release-on-error, và tương tác khác process không hồi quy.

**RR-012 — F03+F16: Vòng đời delegation (cwd + promote grandchild)** *(high-risk)*

- F03: broker ghi shadow theo `task.cwd` nhưng spawn grandchild bằng broker cwd
  (`crew-broker.ts:1394,1553-1554,1587-1588` → `delegate-spawn.ts:114-115`).
  Kèm theo: artifacts root cũng suy từ broker cwd (`delegate-spawn.ts:99`).
- F16: admission cần `running` (`:1444-1450`) nhưng shadow tạo `queued` (`:1553`)
  và không truyền `onSpawn` (`:1587-1600`) → delegate depth-3 bị từ chối.
- Rủi ro mới (chưa xác minh end-to-end): shadow thiếu `stepId`/`agent`, có thể
  được chọn là DAG-ready → `dispatch-batch.ts:718 findStep()` throw.
- AC: injected spawner nhận đúng parent worktree cwd; artifacts đúng artifactsRoot.
- AC: shadow được promote `running` khi spawn thành công, terminalize mọi outcome.

**RR-013 — F04: Bảo toàn execution result qua ranh giới branch** *(high-risk)*

- Vấn đề: `surfaceLost` có ở producer (`child-executor.ts:815-821`) và consumer
  (`post-execution.ts:149`), nhưng `task-runner.ts:140-153,208-220` chép tay 11
  field và bỏ nó ⇒ nhánh `needs_attention` **không thể chạm tới** trong production.
- Hệ quả tất định: `completed` không artifact (gate bug-026 ở `:337` bị bỏ qua vì
  `resultArtifact` undefined) + headless redeploy từ chối (`degrade.ts:519`).
- Cùng lớp: `rawFinalText` cũng bị bỏ (0 occurrence trong `task-runner.ts`).
- AC: mất surface ⇒ không có `task.completed`, không artifact giả, replay headless
  đúng một lần.
- AC: regression test đi qua `runTeamTask`, không gọi finalizer trực tiếp.

**RR-015 — F05+F18+F19+F20: Tính toàn vẹn test/CI harness** *(normal)*

- F05: `scripts/test-runner.mjs:142` `process.exit(result.status ?? 0)` — SIGKILL
  → `status: null` → exit 0 (CI false-green). Đã probe: SIGKILL→0, SIGTERM→1.
- F18: `test-changed.mjs:54-55` diff `merge-base..HEAD`; staged **và** unstaged
  đều vô hình; fallback chỉ 3 file (vs 14 trong `test:critical`).
- F19: `argv-flags.smoke.ts:57` chỉ gọi `--version`; probe cho thấy
  `pi --version --flag-sai` vẫn exit 0 ⇒ test **vacuous**; canary không auth bị skip.
- F20: `benchmark-runner.ts:163` `every()` trên `[]` = true; allowlist `:53` từ
  chối `npm test` (module không ship: `files` có `!src/benchmark`).
- AC: SIGKILL ⇒ wrapper exit khác 0; mọi signal/status không xác định fail closed.
- AC: local mode `test:changed` bao staged + unstaged + test file mới.
- AC: có probe auth-free buộc parser xử lý argv thật (không dựa `--version`).

**RR-016 — F08+F09+F10: Tính đúng của state/config** *(normal)*

- F08: reviver đếm số value, không đo depth (`config.ts:284-291`); >100 value ⇒
  bỏ **cả file** (`:310-316`), mất cả `maxConcurrentWorkers`; `updateConfig` cũng
  throw (`:418-424`) nên không sửa được qua CLI.
- F09: cap delivery 10000 ưu tiên loại `acknowledged` (`mailbox.ts:553-560`);
  replay chỉ key theo delivery-ack (`:930-932`), ack không ghi lại vào message
  (`:611,845-855`) ⇒ message đã ack **phát lại mọi lần resume**, không tự hồi phục.
- F10: `removeCrewAgent` unlink status mà không flush/cancel pending write
  (`crew-agent-records.ts:422-437,454-458,510-517`) ⇒ status.json tạo lại `running`.
- AC: config nông rộng vẫn load; config vượt depth thật bị từ chối.
- AC: acknowledged message không bao giờ được replay, kể cả khi vượt cap.
- AC: sau cancel + drain, index và status đều rỗng.

### Đợt 2 — Giảm chi phí điều phối

**RR-014 — F15: Semaphore có thể abort** *(high-risk)*

- Vấn đề: `Semaphore.acquire()` không nhận `AbortSignal` (`semaphore.ts:27-49`);
  signal chỉ tới child runtime sau khi acquire xong. Probe: cap=1, A giữ slot,
  B abort ở 20 ms → B chỉ settle khi A nhả ở +300 ms; `acquire()` trả về với
  `signal.aborted === true`.
- Chi tiết giới hạn thiệt hại: `child-pi-spawn.ts:385` trả `kind: "aborted"`
  trước spawn ⇒ không fork process thừa; chi phí là **delay** settle.
- AC: giữ slot duy nhất, queue rồi cancel B ⇒ B settle nhanh, không spawn,
  queue không còn B, slot accounting không đổi (không rò capacity).
- AC: xử lý race abort ↔ slot handoff.

**RR-017 — F06+F07: Chi phí persistence và retrieval** *(normal)*

- F06: mỗi upsert flush pending qua `readCrewAgents` (`crew-agent-records.ts:461`
  → `:284-291`) và `saveCrewAgents` ghi status **mọi** record (`:382-397`);
  không có dirty tracking (grep `dirty` → 0). Đo: 20 progress upsert → 19 rename
  trước drain + 1 khi drain; update 1/4 completed → 6 rename, 12 fsync, target 2×.
- F07: `readCrewAgentEventsCursor` (`:676-693`) `readFileSync → split → parse →
  filter → slice`; `sinceSeq`/`limit` chỉ áp sau khi đọc/parse toàn file. Đo:
  697788 byte/poll idle (file 10000 event), tăng tuyến tính; UI tick 700 ms.
- AC: progress burst trong một window không ép một index write mỗi update.
- AC: update một agent không ghi lại status của mọi agent không đổi.
- AC: idle poll không đọc lại event payload cũ; giữ đúng `total`, legacy `seq`,
  pagination; Unicode, partial line, rotation, truncate không mất/trùng event.
- Đã có sẵn để tái dùng: `src/utils/incremental-reader.ts` (`readJsonlSince`) —
  đang được `state/event-log/cursor.ts` dùng, chưa migrate cho agent cursor.

**RR-018 — F11+F12+F13: Quyền sở hữu tài nguyên theo session** *(normal)*

- F11: init fire-and-forget (`lazy-configurers.ts:46-48`); continuation publish
  `metricRegistry`/`eventMetricSub`/`metricSink`/`heartbeatWatcher` sau cleanup
  (probe: 14 subscription + interval sống sau khi cleanup return; 4 object
  orphaned); guard `isCleanedUp()` bị vô hiệu vì reset `false` ở
  `lifecycle-handlers.ts:232`.
- F12: mỗi configure đăng ký thêm `before_agent_start` (`observability.ts:184-191`);
  dispose không gỡ hook; probe 1→2 hook, một turn fire 2 reconcile, và hook cũ
  **đổi ngược cwd của shared manifest cache** (`context-builder.ts:123-131`).
- F13: RPC cài một lần ở registration (`register.ts:89`) nhưng gỡ trong
  session-switch cleanup (`runtime-cleanup.ts:96,107-108`) và không cài lại;
  probe 4 rpc subs → 0 → 0 (chết vĩnh viễn); cache disposed nhưng `cacheCwd` giữ.
- AC: session switch không tăng dần listener/timer; không mất RPC.
- AC: một turn chỉ reconcile một lần bằng session hiện tại.
- AC: disposed cache được tạo lại ngay cả khi cwd không đổi.

### Đợt 3 — Chất lượng đầu ra dựa trên eval

**RR-019 — F14+F17: Idle render và chất lượng verification** *(normal)*

- F14: mỗi preload thành công gọi `schedule()` (`lifecycle-handlers.ts:727-731`)
  dù dữ liệu không đổi; `schedule()` reset idle counter (`render-scheduler.ts:142-154`).
  Probe (12 s idle): scheduler đơn lẻ 8 render rồi dừng; có preload wiring 11 và
  vẫn tiếp tục.
- F17: `agents/verifier.md:21-23` bắt chạy full `npm test`; workflow verify step
  cấm (`workflows/fast-fix.workflow.md:24` và 4 file khác); không có quy tắc
  precedence. Cache không provenance (0 hit cho version/env/sha/git/HEAD trong
  `agents/verifier.md`); `tee` không `pipefail` (probe: `false | tee` → 0);
  wildcard cleanup `rm -f .crew/cache/verify-test-*.log` xóa log verifier khác.
  **Hiệu chỉnh:** command hardcode nằm ở `workflows/*.workflow.md`, KHÔNG ở
  `agents/verifier.md`.
- AC: dữ liệu không đổi ⇒ render dừng sau allowance; một snapshot đổi kích hoạt lại.
- AC: một verification plan thống nhất suy ra từ project scripts/instructions.
- AC: artifact ghi command, exit code, git revision + working-tree fingerprint,
  dependency/env fingerprint, thời điểm; chỉ reuse cache khi provenance khớp.

## 6. Cổng phê duyệt (đã qua)

`docs/FEATURE_INTAKE.md` → High-Risk: "Ask human confirmation before
implementation". Ngày 2026-09-17, sau khi review + verification + story packets
được trình bày, người dùng phê duyệt toàn bộ bằng lệnh "fix all". Kết quả:

| Story | Findings | Kết quả |
|---|---|---|
| RR-013 | F04 | ✅ RED→GREEN 67/67 (qua runTeamTask thật) |
| RR-015 | F05,F18,F19,F20 | ✅ 50/50 + mutation-verified |
| RR-010 | F01 | ✅ 28/28 (bytes gốc còn nguyên khi snapshot thiếu) |
| RR-011 | F02 | ✅ 18/18 + 32/32 non-regression (maxActive 2→1) |
| RR-012 | F03,F16 | ✅ 23/23 + 50/50 + 81/81 (scheduler risk PROVEN reachable → guard) |
| RR-016 | F08,F09,F10 | ✅ 52/52 (sau khi khôi phục từ stash) |
| RR-014 | F15 | ✅ 36/36 + 200-round race test |
| RR-017 | F06,F07 | ✅ trong bộ 52/52 (structural counts) |
| RR-018 | F11,F12,F13 | ✅ registration 20 files 0 fail (RPC 4→switch→4) |
| RR-019 | F14,F17 | ✅ idle-render allowance honored + verifier provenance |

Kèm theo baseline-green: env-vars (2 read routed + PI_CREW_DEBUG_STALE đăng
ký), symlink-steering flake (100ms clamp bỏ), event-types (gate phát hiện
ternary + 79 loại đăng ký + `--enforce` vào CI), 3 gate local-only được wired
vào ci.yml, test-runner timeout 900s→1500s + env override.

Thứ tự triển khai thực tế khớp đề xuất §6: RR-013 → RR-015 → RR-010 → RR-011 →
RR-012 → RR-016 → RR-014 → RR-017 → RR-018 → RR-019 (song song theo nhóm file
không giao nhau, 8 executor + 1 writer ADR).

## 7. Việc chưa nên làm ngay (từ review §8, giữ nguyên)

- Không tăng `maxConcurrentWorkers` khi lock và write amplification chưa xử lý.
- Không bật best-effort durability rộng để làm đẹp benchmark.
- Không rewrite orchestrator chỉ để giảm số dòng.
- Không thêm agent/abstraction lớp mới khi ranh giới lifecycle còn lỗi.
- Không đưa pooling/session reuse vào mặc định trước khi chứng minh isolation.
- Không dùng số task `completed` làm thước đo chất lượng giải pháp.
- Không xem mọi `sleepSync` thay được bằng `await` độc lập với call graph.

## 8. Harness delta

| Artifact | Thay đổi |
|---|---|
| `docs/superpowers/plans/2026-09-17-review-remediation.md` | Plan này (mới) |
| `docs/stories/RR-010..RR-019` | 5 high-risk folder (4 file) + 5 normal packet |
| `docs/stories/README.md` | Thêm 10 story vào bảng Active |
| `docs/stories/backlog.md` | Thêm epic "Review 2026-09-17 remediation" |
| `docs/TEST_MATRIX.md` | Thêm 10 hàng (planned) |
| `docs/decisions/` | Decision record cho mỗi story high-risk khi triển khai |
| `docs/decisions/README.md` | Cập nhật index |
| `docs/archive/2026-09-17-pi-crew-review-verification.md` | Báo cáo xác minh (đã có) |

**Gate đã biết cần đồng bộ (từ review §6.3):**

- `check:env-vars` đang fail: `src/extension/knowledge-injection.ts:466`
  (`PI_CREW_KIND`), `src/runtime/stale-reconciler.ts:287` (`PI_CREW_DEBUG_STALE`).
- `check:event-types` report mode: 89 registered vs 123 emitted (75 emitted chưa
  đăng ký, 41 registered không thấy literal emit site).
- Push/PR CI hiện không gọi `check:env-vars`, `check:event-types`, hay perf bench
  gate như bảo đảm đầy đủ → cần đồng bộ ý nghĩa local CI script vs workflow thực tế.

Các mục này xử lý trong RR-015 (CI integrity) và RR-018 (event/env drift) hoặc
story riêng nếu phình to.

## 9. Tham chiếu

- Review: `docs/archive/2026-09-17-pi-crew-review.md`
- Xác minh: `docs/archive/2026-09-17-pi-crew-review-verification.md`
- Intake: `docs/FEATURE_INTAKE.md`
- Harness: `docs/HARNESS.md`
- Template: `docs/templates/story.md`, `docs/templates/decision.md`,
  `docs/templates/validation-report.md`
- Tiền lệ high-risk: `docs/decisions/2026-08-17-governed-nesting.md` (ADR-5)
