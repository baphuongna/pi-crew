# REVIEW VÒNG 4 (SWEEP 3) — `refactor-plan.md`

> **Vòng**: 4 của chuỗi verify (sweep 1 = 5 fix location, sweep 2 = 3 reframe premise, **sweep 3 = vòng này**).
> **Bản chất**: READ-ONLY verification — 0 source edit. Tiếp tục vòng 4 mà session Droid `d16153d3` bị "Droid Core usage limit" cắt giữa chừng (03:15, đang check large-file baselines + Phase 5 + UI caches + các mục 🔍 còn treo).
> **File review**: `pi-crew/docs/refactor-plan.md` (v0.9.68 baseline). **Repo**: `/home/bom/source/my_pi/pi-crew`.
> **Methodology**: 3 explorer pi-crew subagent song song (batch `v4-verify`) — 1 agent verify 3 file lớn (xong sạch), 2 agent còn lại bị cut sớm → parent tự verify trực tiếp bằng `grep`/`read` READ-ONLY cho nhóm Phase 5/UI/🔍.
> **Quy ước**: TAB indent (AGENTS.md), tiếng Việt communication + tiếng Anh code/docs (HARNESS.md).
> **Trạng thái corrections**: ĐÃ APPLY inline vào `refactor-plan.md` + Execution log (sweep 3 row). File review này là **audit trail độc lập** cho verification round.

---

## 1. Executive summary

**Verdict sweep 3: PASS — 3 large-file baseline CONFIRMED chính xác tuyệt đối; 6 corrections áp dụng; 0 claim sai còn sót.**

- **3/3 file lớn** (`crew-broker.ts`, `worktree-manager.ts`, `state-store.ts`) — **line count khớp 100%** (1280/1268/1260) và **mô tả cấu trúc khớp 100%** (mọi component claim đều có ở line number đã ghi).
- **6 corrections** áp vào plan: 2 sai location/framing (ManifestCache, parent-guard), 2 sai scope (atomic-write KHÔNG phải lock consumer; lock call sites thực tế nhiều file hơn), 1 resolve 🔍 (event-log mkdir lock), 1 resolve 🔍 (env bracket/destructure forms ít hơn tưởng nhiều).
- **Phase 4 divergence reframe**: "progress persist khác" KHÔNG phải runtime-layer divergence — cả 2 executor đều persist qua `state-helpers.ts`; divergence thật ở tool-filter + kill/abort.
- **Phase 5 khả thi**: TypeBox 0.34 hỗ trợ, nhưng `config-schema.ts` hiện **chưa** dùng TypeRegistry/Kind → cần introduce mechanism (no blocker, implementation note).
- **Meta-pattern xác nhận lần 3**: lỗi bắt nguồn từ việc **tin comments/review cũ** (comment "currently UNUSED", "god function ~380 dòng", "ManifestCache across extension/registration"). Mỗi sweep đều bắt được lỗi loại này.

**Plan giờ**: mọi claim checkable đã đối chiếu trực tiếp với code tại HEAD v0.9.68. Execute-ready cho Phase 1 (rủi ro thấp nhất).

---

## 2. ✅ CONFIRMED — không cần sửa (3 file lớn + 4 claim khác)

### 2.1 Baseline 3 file lớn (explorer agent 1 — xong sạch)

| File | Claim dòng | Thực tế | Components claim vs code | Verdict |
|---|---|---|---|---|
| `src/runtime/broker/crew-broker.ts` | 1280 | **1280** ✅ | Socket server (:214 `createServer`) + Handshake (:522 `case "hello"`, :550-606 `handleHello`) + Token registry (:42 import, :101 `new BrokerTokenRegistry()`) + Fanout (:261 observer, :456-488 `fanoutMailboxMessage`, :541 `steer.push`) | ✅ CONFIRMED |
| `src/worktree/worktree-manager.ts` | 1268 | **1268** ✅ | Creation (:805/809 `git worktree add`) + Dirty protection C9 (:770-789 dirty detect+preserve, :586-658 `snapshotDirtyWorktree`) + Cleanup (:663-668 `cleanupCreatedWorktree`, :1168-1210 `cleanupAgentWorktree`) + Seed overlay (:496-526 `normalizeSeedPaths`, :544-574 `overlaySeedPaths`) | ✅ CONFIRMED |
| `src/state/stores/state-store.ts` | 1260 | **1260** ✅ | CRUD (:276 `createRunManifest`, :356/397 `saveRunManifest[Async]`, :455 `saveRunTasks`, :989/1125 `loadRunManifestById[Async]`) + Manifest retry (:43-59 `statManifestWithWindowsRetry`, :95 `LOAD_MANIFEST_RETRY_LIMIT=5`, :1049-1083 sentinel retry loop) + CAS loop KHÔNG ở đây (confirmed ở `task-runner/state-helpers.ts:52`) | ✅ CONFIRMED |

### 2.2 Các claim khác CONFIRMED

| Claim | Bằng chứng | Verdict |
|---|---|---|
| `RunSnapshotCache` TTL 1500ms | `run-snapshot-cache.ts:28` `DEFAULT_TTL_MS = 1500` | ✅ |
| `buildSignature` TTL 100ms | `run-dashboard.ts:117` `SIGNATURE_CACHE_TTL_MS = 100` (+ widget dùng C4 invalidate-on-write thay TTL, `widget/index.ts:163`) | ✅ |
| `child-executor.ts` tồn tại, multi-attempt loop | `src/runtime/task-runner/child-executor.ts` (import `runChildProcessTask` tại `task-runner.ts:11`); `live-executor.ts` là tương ứng live-session | ✅ |
| Phase 5 TypeBox feasibility | `config-schema.ts` (340 dòng) `import { Type } from "@sinclair/typebox"` (^0.34.50) | ✅ (caveat xem §4.6) |

---

## 3. ❌ CORRECTIONS — 6 chỗ đã áp vào plan

Mỗi correction: **claim sai** → **thực tế (code evidence)** → **đã sửa thế nào trong plan**.

### 3.1 ❌ → ✅ `ManifestCache` sai location + thiếu TTL

| | |
|---|---|
| **Claim sai** | Baseline row + Risk register: "`ManifestCache` ✅ exists across extension/registration" (không ghi TTL) |
| **Thực tế** | `ManifestCache` nằm ở **`src/runtime/manifest-cache.ts:10`** (interface) / `:46` (`DEFAULT_TTL_MS = 500`), **TTL 500ms**. KHÔNG ở `src/extension/` hay `src/ui/`. Consumer: `powerbar-publisher.ts`, `ui/widget/index.ts`, `ui/run-dashboard.ts` (import type từ `../../runtime/manifest-cache.ts`). |
| **Bằng chứng** | `grep -rn "ManifestCache" src/` → mọi import đều từ `runtime/manifest-cache.ts`; `wc -l` = 379 dòng; `:46 DEFAULT_TTL_MS = 500` |
| **Đã sửa** | Baseline row + Risk register: rõ location `src/runtime/manifest-cache.ts:46` TTL 500ms, buildSignature 100ms `run-dashboard.ts:117` |

### 3.2 ❌ → ✅ Phase 1.2 — parent-guard KHÔNG phải "never wired"

| | |
|---|---|
| **Claim sai** | Phase 1.2: "Only the child-pi-side parent-guard was never wired, making the `child-pi-spawn.ts:74-75` comment misleading" + "Locate the production reader (zombie scanner, likely via `/proc/<pid>/environ` 🔍)" |
| **Thực tế** | (a) **Production reader CONFIRMED**: `src/runtime/process/zombie-scanner.ts:185` đọc `environ.PI_CREW_PARENT_PID` qua `readProcEnviron` (`/proc/<pid>/environ`, :48-52). 🔍 resolved. (b) **parent-guard ĐÃ wired**: `startParentGuard(parentPid)` được gọi tại `src/runtime/background-runner.ts:615` (`if (parentPid > 0) startParentGuard(parentPid)`) — self-termination khi parent của orchestrator chết. (c) Chỉ **pi binary dist** là không read var / không call `startParentGuard` (grep dist = 0 matches, per `parent-guard.ts:13`, `child-pi-spawn.ts:144-145`) → child-pi workers spawn ra KHÔNG tự terminate, rely zombie scanner reactive. |
| **Bằng chứng** | `grep -rn "startParentGuard\|PI_CREW_PARENT_PID" src/`; `guest-zombie.test.ts` test mechanism đọc `/proc/<pid>/environ` + assert `PI_CREW_KIND=subagent` + `PI_CREW_PARENT_PID` |
| **Đã sửa** | Phase 1.2: reframe — "parent-guard IS wired at background-runner.ts:615; only pi-binary child-pi entry point unwired"; comment `child-pi-spawn.ts:74` "currently UNUSED" misleading (unused *by pi dist*, không phải unused overall); file mapping bổ sung `background-runner.ts:615`, `zombie-scanner.ts:185`, `parent-guard.ts` |

### 3.3 ❌ → ✅ Phase 3.1 — `atomic-write.ts` KHÔNG phải lock consumer

| | |
|---|---|
| **Claim sai** | Phase 3.1 call sites: "in `state-store.ts`, `event-log.ts`, `atomic-write.ts` 🔍" |
| **Thực tế** | `atomic-write.ts` **KHÔNG gọi** `withFileLock*`/`withRunLock*`/`withEventLogLock*` (grep = 0). Nó dùng cơ chế riêng: **O_EXCL atomic temp+rename** (`O_WRONLY \| O_CREAT \| O_EXCL \| O_NOFOLLOW`), không phải lock-family consumer. Consumer thật nhiều file hơn plan liệt kê. |
| **Bằng chứng** | `grep -n "withFileLock\|withRunLock\|withEventLogLock" src/state/atomic-write.ts` = rỗng |
| **Đã sửa** | Phase 3.1: bỏ `atomic-write.ts` khỏi call sites; list consumer thật: **`mailbox.ts`** (lớn nhất, ~10 call sites :586/:600/:701/:710/:792/:839/:872/:899), `blob-store.ts:59`, `run-cache.ts:62/119`, `config.ts:1238/1272`, `decision-ledger.ts`, `state-store.ts:584/613`, `event-log.ts:109/485` (mkdir lock) |

### 3.4 🔍 → ✅ Phase 3.1 — event-log mkdir lock resolved

| | |
|---|---|
| **Claim treo** | "event-log mkdir lock 🔍" (chưa xác định vị trí) |
| **Thực tế** | **Lock family thứ 5** (khác 4 lock trong `locks.ts`): `src/state/event-log/event-log.ts:109` `${eventsPath}.mkdirlock` dir. `fs.mkdirSync(lockDir)` (:127) với O_EXCL semantics (:122-124). Stale detection qua `process.kill(pid, 0)` TOCTOU (:141-152). Async variant `withEventLogLockSync` (:485). Documented tại :472-485. |
| **Đã sửa** | Phase 3.1: liệt kê đầy đủ **5 lock families** (a) locks.ts 4 fn, (b) crew-agent-records.ts, (c) event-log mkdir lock :109/:485, (d) atomic-write O_EXCL (KHÔNG phải consumer); ADR scope = subsume (a)+(b)+(c) |

### 3.5 🔍 → ✅ Phase 3.2 — env bracket/destructure forms resolved

| | |
|---|---|
| **Claim treo** | "plus bracket/destructure forms to catch during codemod 🔍" (chưa quantified) |
| **Thực tế** | Codemod **nhẹ hơn tưởng nhiều**: chỉ **2 bracket sites** (`prompt-runtime.ts:228` `[PI_CREW_MAX_OUTPUT_ENV]` + `:260` `[PI_CREW_STEERING_FILE_ENV]`) và **0 destructure form** trong toàn `src/`. Dot-notation là bulk. |
| **Bằng chứng** | `grep -rn 'process\.env\["PI_CREW' src/` = 2 hits; `grep "const { .*PI_CREW" src/` = 0 |
| **Đã sửa** | Phase 3.2: quantified "2 bracket + 0 destructure", note "codemod far smaller than estimated", gate `check:env-vars` cũng cover bracket forms |

### 3.6 ⚠️ → ✅ Phase 5.1 — TypeBox metadata implementation note

| | |
|---|---|
| **Claim under-specified** | Phase 5.1: "Add `sensitive: true` metadata convention to the config schema (TypeBox)" — không nói cơ chế |
| **Thực tế** | `config-schema.ts` (340 dòng) hiện imports `Type` từ `@sinclair/typebox` ^0.34.50 nhưng **KHÔNG** dùng `TypeRegistry` hay custom `Kind` (grep = 0). Để mark `sensitive: true` phải introduce 1 trong 2: (1) `TypeRegistry.Set(...)` custom Kind, hoặc (2) TypeBox `Options` object (`Type.Object({...}, { additionalProperties: true })`). TypeBox 0.34 hỗ trợ cả 2. |
| **Bằng chứng** | `grep -n "TypeRegistry\|Kind\." src/schema/config-schema.ts` = rỗng |
| **Đã sửa** | Phase 5.1: thêm "Implementation note (sweep 3)" — phải introduce TypeRegistry/Kind hoặc Options; pick one in ADR; "No blocker". Cũng list 17 test files trong `test/unit/config/` (incl. `config-schema-sync`, `config-patch-pollution`, `config-phantom-fields`, `project-config`) để drift gate 5.2 build trên. |

---

## 4. 🔄 Phase 4 divergence — reframe 3 điểm

Plan claim ban đầu (sweep 1 đã sửa fallback): fallback OK, còn 3 divergence 🔍 "Progress persist, tool filtering, kill/abort semantics also differ". Sweep 3 verify chi tiết:

| Divergence | Claim | Thực tế (sweep 3) | Verdict |
|---|---|---|---|
| **Progress persist** | "differ 🔍" | **KHÔNG phải runtime-layer divergence**. Cả `task-runner/child-executor.ts` lẫn `task-runner/live-executor.ts` đều persist qua `state-helpers.ts` (save paths). `live-session-runtime.ts` grep `saveRunTasks*`/`saveRunManifest*` = 0 (không persist trực tiếp, delegate executor). | 🔄 **Reframe**: divergence ở executor layer, KHÔNG phải runtime layer. |
| **Tool filtering** | "differ 🔍" | **Divergent thật**. child-pi: explicit restrictive `--tools` list tại spawn. live-session: `createAgentSession` (`:743`) rely pi's `DefaultResourceLoader`, "no explicit per-extension allow/deny API at the point we hand off" (comment :675-676) → **permissive by default**. | ✅ Confirmed divergent |
| **Kill/abort** | "differ 🔍" | **Confirmed divergent**. child-pi: `killProcessTree` SIGTERM→3s→SIGKILL (`child-pi/child-pi-kill.ts`). live-session: `ac.abort()` (`:522`) + `session.abort?.()` (`:963`/`:1007`). | ✅ Confirmed divergent |

**Đã sửa**: Phase 4 bullets — progress persist reframe (executor layer), tool-filter confirmed với comment evidence, kill/abort confirmed với line numbers.

---

## 5. Verification methodology

| Nhóm | Cách | Kết quả |
|---|---|---|
| 3 file lớn (broker/worktree/state-store) | explorer agent 1 (`agent_msr135fz`), 65s | Xong sạch, all CONFIRMED |
| Phase 5 + UI caches + target dirs | explorer agent 2 (`agent_msr135h4`) — **bị cut sớm**, output rỗng → parent tự verify `grep`/`read` | 6.1/6.3/6.4 xong; ManifestCache fix; buildSignature 100ms confirmed |
| 🔍 items (zombie/mkdir lock/call sites/env/Phase 4) | explorer agent 3 (`agent_msr135hv`) — **bị cut sớm**, output rỗng → parent tự verify `grep`/`read` | All resolved: zombie reader `zombie-scanner.ts:185`, mkdir lock `event-log.ts:109`, call sites mapped, env forms quantified, Phase 4 reframed |

**Tooling**: `wc -l`, `grep -rn`, `sed -n`, `read` tool. READ-ONLY — 0 file source bị sửa.

**Gate**: `npm run typecheck` green sau khi apply corrections vào plan (chỉ doc edit, không code).

---

## 6. Meta-lesson (lần thứ 3 xác nhận)

Cả 3 vòng verification đều bắt được lỗi từ **cùng 1 root cause**: tin comments / review cũ mà không đối chiếu code.

| Sweep | Lỗi do tin comment/review cũ |
|---|---|
| 1 | "god function ~380 dòng" (thực 321), line numbers từ review trước |
| 2 | Comment "currently UNUSED" (`PI_CREW_PARENT_PID`), "state leaks" (thực ra có cleanup) |
| **3** | "ManifestCache across extension/registration" (thực runtime/), "parent-guard never wired" (thực wired ở background-runner), "atomic-write là lock consumer" (thực O_EXCL atomic rename) |

**Nguyên tắc** (đã có trong Risk register): *"Treat comments as hypotheses; verify against code before acting on them."* Sweep 3 củng cố nguyên tắc này — áp dụng cho cả **mô tả trong chính plan** (không chỉ code comments).

---

## 7. Trạng thái cuối

- **Plan state**: mọi claim checkable đã đối chiếu code tại HEAD v0.9.68. Execution log có 3 rows (sweep 1/2/3).
- **Remaining 🔍**: 2 instances — cả 2 đều là (a) status-legend definition (line 11) và (b) self-reference trong sweep 3 row (line 287). **0 claim 🔍 chưa verify**.
- **Execute-ready**: Phase 1 (dead code + cleanup hardening) là entry point rủi ro thấp nhất. Khi user "bắt đầu Phase 1", làm theo plan §Phase 1 với file mapping đã verify.
- **File review này**: audit trail độc lập. Corrections đã apply inline vào `refactor-plan.md`; review file dùng để track verification rounds + làm reference cho reviewer sau.

---

## ROUND 4 — Soundness + Security validation (iterative-audit)

> **Round**: 4 của chuỗi iterative-audit (rounds 1-3 = structural claim verification, all LOW).
> **Focus shift**: SOUNDNESS — liệu 3 premise refactor high-risk có đúng khi đọc CODE, không chỉ tin plan claims.
> **Methodology**: team `review` (4 task: explorer + reviewer + security-reviewer + verifier). 2 perspective độc lập cross-validate. Mọi finding có `file:line` read từ source. False positive lọc per skill.
> **Run**: `team_20260813053349_f46ef69f08925ef6`. **Gate**: `npm run test:critical` 101/101 pass + `tsc --noEmit` clean (verifier task).
> **Line-number note**: verifier flag ±3-24 line drift giữa 2 reviewer (đọc ở revision hơi khác); key actionable lines re-pinned dưới đây against HEAD.

### Executive summary (merged 2 perspectives)

| Premise | Plan claim | Verdict | Severity | Issues (soundness + security) |
|---|---|---|---|---|
| **P1** — Unified `FileLock` | 5 lock families unify được, on-disk format unchanged | **RISKY** | HIGH | 4 soundness + 3 security = 7 findings |
| **P2** — `TaskExecutor` convergence | child + live executor converge qua interface | **RISKY** | HIGH | 4 soundness + 1 security = 5 findings |
| **P3** — Schema-driven sanitize | TypeBox `sensitive` metadata thay hardcode | **SOUND** | LOW | 2 caveat + 1 latent hardening |

**Round metrics**: 12 real issues (2 HIGH, 4 MEDIUM, 6 LOW), **0 CRITICAL / 0 BLOCKED**. 0 false positive (verifier cross-checked 7/7 security findings). 6 positive controls verified. **STOP verdict** — đủ verdict cho 3 premise; phần còn lại là implementation (ADR + code), không cần round 5.

---

### P1 — Phase 3.1 unified `FileLock` — RISKY (HIGH)

**Plan claim**: 5 lock families (locks.ts 4 fn + crew-agent-records + event-log mkdir lock) unify thành 1 `FileLock` với `{staleMs, reentrant}`, on-disk format unchanged.

#### P1-A — staleMs KHÔNG uniform (MEDIUM)

| Family | staleMs | Evidence |
|---|---|---|
| locks.ts (4 fn) | **30,000ms** | `DEFAULT_LOCKS.staleMs = 30_000` (`defaults.ts:43`) |
| crew-agent-records (`withAgentsLock`) | **30,000ms** | `AGENTS_LOCK_STALE_MS = 30_000` (`crew-agent-records.ts:109`) |
| event-log (`withEventLogLockSync`) | **10,000ms** | `staleMs ?? 10000` (`event-log.ts:117,:519`) |

Event-log dùng 10s có chủ đích (high-frequency append lock). Unify về 1 staleMs = behavior change.

#### P1-B — On-disk format + primitives fundamentally divergent (HIGH)

| Family | Primitive | Format | Permission | Token guard? |
|---|---|---|---|---|
| locks.ts | FILE `O_EXCL` | `{kind,pid,createdAt,token}` | **0o600** (`locks.ts:189`) | ✅ `timingSafeTokenMatch` (`:223-229`) |
| crew-agent-records | FILE `O_EXCL` | `{pid,createdAt}` — NO token | **0o644** (`crew-agent-records.ts:158`) | ❌ PID-only (`:180-187`) |
| event-log | **DIRECTORY** `mkdirSync` | dir + `pid` text file (`:129-131`) | dir default | ❌ PID-only (`:152-157`) |

**3 vấn đề_security** đi kèm:
- **S-R1 (MEDIUM)**: lock file `0o644` (crew-agent-records) world-readable → leak PID + timestamp. locks.ts dùng `0o600`. → Unified nên standardize `0o600` (tightening, an toàn).
- **S-R2 (LOW)**: symlink rejection CHỈ có ở locks.ts (`writeLockFile`/`releaseOwnLock`/`releaseLock`). crew-agent-records + event-log stale-cleanup thiếu. → Unified phải carry symlink guards cho mọi family.
- **S-R3 (LOW)**: token-guarded release CHỈ locks.ts. 2 family kia PID-only → PID-recycling risk (process crash → PID tái sử dụng → lock un-stealable đến staleMs). → Unify cần add token cho all (format change) hoặc document limitation.

**Impact**: plan claim "on-disk format unchanged" **vi phạm** — event-log mkdir lock là DIRECTORY không phải file; crew-agent-records thiếu token. Convert sang统一 format = format change.

#### P1-C — Re-entrance semantics KHÔNG uniform (MEDIUM)

| Family | Re-entrance | AsyncLocalStorage? |
|---|---|---|
| locks.ts `withRunLock*` | per-async-context held-set (`lockCtx`, `:491,562`) | ✅ (H-1 fix) |
| locks.ts `withFileLock*` | per-async-context (`fileLockSyncCtx`/`fileAsyncLockCtx`, `:452,536`) | ✅ (ST-14 fix) |
| crew-agent-records | NONE | ❌ |
| event-log | NONE | ❌ |

Plan `{reentrant}` boolean flag không đủ — re-entrance locks.ts là **per-async-context** (call từ context KHÁC vẫn serialize, chỉ same-context nested bypass). Replicate full AsyncLocalStorage machinery (3 ALS instances) hoặc risk re-introduce H-1/ST-14 bugs.

#### P1-D — Cross-tier coordination machinery intertwined (LOW)

locks.ts có 4 coordination structure (fileLockHeldByUs Map `:470`, fileSyncLockHeldByUs Set `:482`, fileAsyncLocks Map `:518`, fileAsyncLockCtx ALS `:529`) cho sync↔async interleaving (ST-3-FIX). 2 family kia không cần. Fold vào = "3 locks in a trench coat" hoặc carry unused machinery.

**P1 verdict**: RISKY. Feasible, nhưng plan claims ("same primitives", "staleMs 30s uniform", "on-disk unchanged") **không hoàn toàn sound**. **Recommendation**: ADR document divergences; **exclude event-log mkdir lock khỏi unify scope** (chỉ subsume (a)+(b)), HOẶC accept format change. Pre-refactor hardening commit: `crew-agent-records.ts:158` `0o644`→`0o600` (S-R1, độc lập, low risk).

---

### P2 — Phase 4 `TaskExecutor` convergence — RISKY (HIGH)

**Plan claim**: child-executor.ts + live-executor.ts converge qua `TaskExecutor` interface; fallback loop + withWorkerSlot + progress persist move shared. Alternative: "freeze live-session" (0.5 ngày).

#### P2-A — Input/output interfaces incompatible (HIGH)

| Aspect | child-executor (`runChildProcessTask`) | live-executor (`runLiveTask`) |
|---|---|---|
| Input | `TaskExecutionContext` (pre-execution.ts) | `RunLiveTaskInput` (~25 fields, local interface) |
| Output | `TaskExecutionResult` (post-execution.ts) — có `modelAttempts`,`finalStdout`,`terminalEvidence`,`startupEvidence` | `RunLiveTaskOutput` (~12 fields) — trả `task`/`tasks` (không mutate ctx) |

Interface cover cả 2 = rất rộng (nhiều optional) hoặc rất hẹp (mất type safety).

#### P2-B — Fallback loop ownership fundamentally different (HIGH)

- child-executor: **explicit multi-attempt loop** (`for (let i...)` `child-executor.ts:372`), one-shot re-resolve, spawn-budget cap.
- live-executor: **NO loop** — delegate `createAgentSession()` (`live-session-runtime.ts:743`), SDK handle fallback internal, report `modelFallbackMessage`.

Plan claim "move fallback loop vào shared" — nhưng live path KHÔNG có loop để move. Share loop = live adapter phải abandon SDK delegation (massive behavior change) hoặc ignore shared loop (interface có loop không dùng). **Not convergence — round peg square hole.**

#### P2-C — withWorkerSlot owned bởi run-worker.ts, KHÔNG child-executor (MEDIUM)

`withWorkerSlot` ở `run-worker.ts:75`, child-executor call qua `runWorker()`. live-executor: **0 reference** (grep confirmed). Move với shared TaskExecutor = live-session acquire global worker semaphore — nhưng live-session chạy **IN-PROCESS** (no child spawned), apply process-spawn cap cho in-process SDK call **semantically wrong** (limit concurrency theo metric không apply).

#### P2-D — Progress persist share primitives nhưng diverge structure (MEDIUM)

| Aspect | child-executor | live-executor |
|---|---|---|
| Shared helpers | `persistSingleTaskUpdate`,`upsertCrewAgent` | `persistSingleTaskUpdate`,`upsertCrewAgent` |
| Event emit | `appendEventBuffered` (coalesced, `:322`) | `appendEventFireAndForget` (`:101`) |
| Throttle | 500ms agent + 1000ms run | 500ms agent + 1000ms run |

Progress persist **structural similar** (same throttle) → đây là area convergence genuine feasible. Nhưng event-emit divergence thật (child: coalesced queue từ stdout; live: sync callback fire-and-forget) → phải stay adapter-specific.

#### P2-S — Trust boundary divergence (S-R4, MEDIUM)

- **Child path**: `runWorker()`→`runChildPi()`→`getPiSpawnCommand()` (`pi-spawn.ts`) — binary validated qua `isWithinAllowedPrefixes` (`:50-91`) + `validateExplicitBin` (`:207-235`), `shell:false`, process isolation.
- **Live path**: `createAgentSession()` in-process SDK — no binary validation (no subprocess), no process isolation.

Shared code chạy ở 2 security context khác nhau. Vulnerability trong shared progress-persist (e.g. path traversal artifact) affect cả 2; child có process isolation defense, live expose direct memory access.

**P2 verdict**: RISKY. Convergence premise overstate shared contract. Chỉ progress-persist (P2-D) có genuine potential. **Recommendation**: option **(a) "freeze live-session" (0.5 ngày) là correct choice**. Full convergence = 3-5 ngày cho design tệ hơn (abandon SDK delegation hoặc build parallel fallback/concurrency layer cho live).

---

### P3 — Phase 5 schema-driven sanitize — SOUND (LOW) + latent hardening

**Plan claim**: derive sanitize drop-list bằng walk `config-schema.ts` với TypeBox `sensitive` metadata thay hardcode.

#### P3-1 — ALL dropped fields exist in schema — 0 GAP (SOUND, cross-validated bởi 2 reviewer)

Cross-reference đầy đủ `sanitizeProjectConfig` (`config.ts:272-356`) drop-list vs `config-schema.ts`:

| Dropped field | In schema? |
|---|---|
| `executeWorkers`, `asyncByDefault`, `requireCleanWorktreeLeader` | ✅ top-level |
| `runtime.{mode,preferLiveSession,allowChildProcessFallback,inheritContext,isolationPolicy,agentExtensions}` + conditional `requirePlanApproval` | ✅ `PiTeamsRuntimeConfigSchema` |
| `autonomous.{profile,enabled,injectPolicy,preferAsyncForLongTasks,allowWorktreeSuggestion}` | ✅ `PiTeamsAutonomousConfigSchema` |
| `worktree.setupHook`, `otlp.{headers,endpoint}` | ✅ nested |
| `agents.{disableBuiltins,overrides}`, `tools.{enableSteer,terminateOnForeground}` | ✅ |

**Result: 0 fields dropped-but-not-in-schema.** ✅ No security gap từ schema-walk. Reverse check (in-schema-but-not-dropped): `otlp.intervalMs`, `runtime.maxTurns`, `runtime.taskTimeoutMs`... — không sensitive, không gap.

#### P3-2 — Implementation caveats (LOW)

- **Caveat A — conditional drop**: `runtime.requirePlanApproval` drop ONLY khi `=== false` (`config.ts:288-291`), không unconditional. `sensitive: true` boolean không express được → cần (a) predicate `sensitive: { when: ... }`, hoặc (b) keep hardcoded special-case, hoặc (c) accept drop unconditional (slight behavior change).
- **Caveat B — nested traversal**: TypeBox Options carry metadata per node; walk recurse nested `Type.Object` (`additionalProperties: false` everywhere → không unknown field sneak in).
- **Caveat C — `config-schema-sync.test.ts` KHÔNG break**: test verify key-name parity, không đọc options. ✅ (verifier confirm 3/3 subtest pass).

#### P3-S — Latent sanitization gap: `policy.*` (S-R5, MEDIUM — latent)

**Evidence**: `sanitizeProjectConfig` KHÔNG drop `policy.requireIntentForDestructiveActions` + `policy.disabledCapabilities` (cả 2 exist `config-schema.ts:187-188`).

**Hiện KHÔNG exploit** vì: (1) merge precedence user-wins (`config.ts:1191`, verifier confirm comment :1185-1186); (2) `shouldRequireIntent()` default `false` (`intent-policy.ts:25`).

**Latent risk**: nếu default future thành `true` (security-hardening), malicious project config set `false` sẽ take effect khi user chưa set. Tương tự `disabledCapabilities: []`.

**Remediation**: P3 refactor nên mark `policy.requireIntentForDestructiveActions` + `policy.disabledCapabilities` `sensitive: true` — defense-in-depth, refactor làm trivial.

#### P3-S2 — `worktree.seedPaths` not sanitized (S-R6, LOW — mitigated)

Không trong drop-list; runtime `normalizeSeedPaths()` (`worktree-manager.ts:496-526`) validate containment + reject symlink. Mitigated. Optional mark `sensitive` defense-in-depth.

#### P3-S3 — Schema-walk completeness regression risk (S-R7, LOW)

Hardcoded drop-list explicit/auditable; schema-walk depend MỌI sensitive field được mark đúng. Missed field = security regression khó spot. **Refactor MUST include migration test**: (1) schema-derived drop-list là SUPERSET của current hardcoded (no regression); (2) mọi `sensitive: true` map existing schema key (no orphan); (3) extend `config-schema-sync.test.ts` verify `sensitive` parity. Đây là safety net critical.

**P3 verdict**: SOUND. 0 gap cho dropped fields. TypeBox 0.34 Options support nested metadata. Recommendation: proceed + thêm `policy.*` defense-in-depth + migration test.

---

### Positive controls verified (no action)

| Control | Evidence | Assessment |
|---|---|---|
| `worktree.setupHook` execution | `worktree-manager.ts:310,334,344` `shell:false`, env sanitized, realpath, symlink reject | ✅ |
| `pi-spawn.ts` binary validation | `:50-91,207-235` prefix allowlist + symlink target | ✅ |
| `locks.ts` token release | `:223-229` `timingSafeEqual` + early length check | ✅ |
| `otlp.{headers,endpoint}` sanitize | `config.ts:329-340` explicit comment | ✅ |
| Config merge precedence | `config.ts:1191` user-wins | ✅ |
| `additionalProperties: false` mọi sub-object | `config-schema.ts` | ✅ |

---

### Verifier gate (task 04)

- `npm run test:critical`: **101 passed / 0 failed / 0 skipped** (8 suites broker + keybinding parity + pi-tui-dispatch + session-utils + **config-schema-sync** + child-pi-env-spread), ~16s.
- `npx tsc --noEmit`: **clean** (exit 0).
- Cross-verified 7/7 security findings vs source — **0 false positive** (1 minor imprecision S-R2 symlink: file có symlink guard chỗ khác, chỉ lock path thiếu — không phải FP).
- **NEW issues từ test**: None. All findings forward-looking (plan premises), không current-code regression.

---

### Round metrics + continue/stop

| Metric | Count |
|---|---|
| Real issues | 12 (2 HIGH: P1-B/P2-B, 4 MEDIUM: P1-A/P1-C/P2-C/S-R5, 6 LOW) |
| CRITICAL / BLOCKED | 0 / 0 |
| False positive | 0 |
| Positive controls | 6 |
| Verdict | **STOP** |

**STOP lý do**: 3 premise đều có verdict evidence-backed. Phần còn lại = implementation (ADR + code). Round 5 không add value — soundness questions đã answered.

### Actionable remediations (cho plan author)

1. **P1 ADR**: document staleMs non-uniform (10s vs 30s), format divergence (dir vs file, token missing), re-entrance ALS complexity. **Exclude event-log mkdir lock khỏi unify** hoặc accept format change.
2. **P1 pre-refactor hardening** (độc lập, low risk): `crew-agent-records.ts:158` `0o644`→`0o600` (S-R1).
3. **P2 ADR**: chọn **option (a) "freeze live-session"** — convergence không sound (SDK delegation + worker-cap semantics).
4. **P3 ADR**: proceed schema-driven; mark `policy.{requireIntentForDestructiveActions,disabledCapabilities}` `sensitive: true` (S-R5 defense-in-depth); handle `requirePlanApproval` conditional (Caveat A).
5. **P3 migration test** (critical safety net): drop-list superset parity + orphan metadata check + extend `config-schema-sync.test.ts`.

---

## ROUND 5 — Defensive Caps (Pattern 2, iterative-audit)

> **Round**: 5. **Pattern**: 2 (unbounded Maps/Sets/Queues/Arrays). **Methodology**: team `review` — explorer (01) audit + reviewer (02) independent verify + security-reviewer (03) independent scan + verifier (04) gate.
> **Runs**: explorer `team_20260813060554_29fbbadf74cd1f50`; security `team_20260813060555...` — đều 4/4 tasks, model `zai/glm-5.2`. **Gate**: reviewer + security cross-verified, verifier confirm. Không chạy test (READ-ONLY audit).
> **Models**: tất cả subagent resolved `zai/glm-5.2` (fallback chain dài, 1 attempt success).

### Executive summary (merged explorer + reviewer + security)

**7 real issues** (0 CRITICAL · 0 HIGH · **2 MEDIUM** · 5 LOW) + **2 missed findings** (reviewer) + **50+ false positives eliminated**. Codebase **rất kỷ luật** về defensive caps — ~40 module-level collections đã có `MAX_*` + eviction. 2 MEDIUM là slow leaks thật trong long-lived Pi host process; 1 trong plan-target file. **Security lens**: tất cả collections chứa structural data (runIds, paths, counters) — không secrets, không injection vector. Pure availability/OOM concern.

### Findings (7 explorer + 2 reviewer-missed)

| # | file:line | Severity | Vấn đề | Fix đề xuất | Plan-target? |
|---|---|---|---|---|---|
| **MEDIUM-1** | `src/state/stores/state-store.ts:89` | MEDIUM | `manifestCacheGeneration` Map keyed by stateRoot, **0 `.delete()`/`.clear()`** (grep-verified). Companion `manifestCache` CÓ TTL+LRU cap, nhưng generation counter không evict. Leak ~1 entry/run. **Reviewer: có thể HIGH theo guide** ("module-level Map keyed by runId không clear") — leader quyết calibration | Coupled eviction: `manifestCacheGeneration.delete(stateRoot)` trong `invalidateRunCache` (:151) + size guard mirror `manifestCache` | ✅ **PLAN-TARGET** (state-store.ts) |
| **MEDIUM-2** | `src/extension/async-notifier.ts:13,136,149-150` | MEDIUM | `seenFinishedRunIds` Set chỉ cần ~20 entries (poll `listRuns().slice(0,20)`), nhưng tích 1 runId/finished run mãi; `stopAsyncRunNotifier` (:182) clear timer nhưng **KHÔNG clear Set** — persists qua stop/start cycles | `state.seenFinishedRunIds.clear()` trong `stopAsyncRunNotifier()` (re-seed từ `listRuns()` khi restart) HOẶC FIFO cap 256 (precedent `STALE_ASYNC_MARKED_MAX` status.ts:30) | Không |
| LOW-1 | `src/worktree/worktree-manager.ts:150,166` | LOW | `_gitRootCache` + `_cleanLeaderCache` có `clearGitRootCache()`/`clearCleanLeaderCache()` exported nhưng **0 production callers** (grep) — "Cleared per-run" doc-comment là aspirational, cleanup chưa được wire | Call tại team-run start (cạnh `clearStablePrefixCache()` team-runner.ts:1035) hoặc `MAX=64` FIFO | Không |
| LOW-2 | `src/worktree/worktree-manager.ts:470` | LOW | `_prunedRepos` Set keyed by repoRoot, dedup per-process, **không clear** (companion `_pruneInFlight` Map CÓ `.delete()` :486) | `MAX_PRUNED_REPOS=64` FIFO hoặc clear cùng 2 cache trên | Không |
| LOW-3 | `src/runtime/model/provider-extensions.ts:45` | LOW | Cache Map không cap; entry chỉ bị xóa khi re-access + mtime đổi. **Reviewer note: deliberate design** — comment :44 "the original has no TTL, and none is needed" — bounded by installed-extension count. **Cùng pattern `workspace-tree.ts:269` `treeCache`** (TTL 30s trên read, stale persist; keys cwd+options) | `MAX=64` FIFO tại insertion (pattern `knowledgeCache` knowledge-injection.ts:393-398) — HOẶC accept deliberate | Không |
| LOW-4 | `src/state/event-log/event-log.ts:454,870-877` | LOW | `asyncQueues` error path set `Promise.resolve()` (:874) thay vì delete — entry persist đến process exit. **Reviewer correction**: "persist until exit" hơi overstated — compare-and-delete (:862-864) xóa trên next successful access; leak thật chỉ cho paths error + không bao giờ re-access | `while (asyncQueues.size > MAX_ASYNC_QUEUES) delete oldest` tại :877 hoặc lazy reset | ✅ **PLAN-TARGET** (event-log.ts) |
| LOW-5 | `src/agents/discover-agents.ts:377,416` | LOW | `warnedForkAgents` Set "warn-once", chỉ `.clear()` trong `__test_resetForkWarnings()` (:379) | `MAX_WARNED=256` FIFO (bounded naturally <50) | Không |
| **MISSED-1** | `src/i18n.ts:123,229` | LOW | `warnedMissing` Set — cùng "warn-once, clear chỉ trong `__test_`" pattern; keyed `${locale}:${key}` (reviewer phát hiện) | Cùng pattern: `MAX` FIFO hoặc accept bounded | Không |
| **MISSED-2** | `src/extension/team-tool/doctor.ts:46,76` | LOW | `commandExistsCache` Map — `.set()` nhưng **0 `.delete()`/`.clear()`** (grep); bounded naturally bởi ~10-20 doctor commands (reviewer phát hiện) | `MAX` FIFO | Không |

**Pattern hệ thống**: "warn-once/memo-once Sets không production cleanup" — 3 instances (warnedForkAgents, warnedMissing, commandExistsCache) → **systematic grep round** gợi ý.

### Reviewer quality note

Reviewer (02, hoàn chỉnh 7888B) xác nhận **mọi 7 findings explorer đều chính xác** (source-verified), spot-check 15+ entries false-positive table đúng. Góp 2 missed + 2 minor characterization (LOW-4 overstated, LOW-3 deliberate design) + 1 severity calibration (MEDIUM-1 có thể HIGH theo guide).

### False positives eliminated (50+)

~40 capped collections (manifestCache TTL+LRU, knowledgeCache 64, configCache, quotaCache, STALE_ASYNC_MARKED 256, securityEventLog 1000, metric-retention 100000, command-trace 12, timings 500...) + finally-block cleanup (lastProgressContentHash team-runner.ts:1041, stableComponentCache :1035, transcriptBatches flush) + connection-lifecycle bounded (broker connections, activeChildProcesses, liveCells) + per-run/per-request instance-scoped + event-bus listeners `.delete()` on unsub + lock registries release + metrics capped (MAX_LABEL_COMBINATIONS 10000) + discovery caches (32) + static constants. Security reviewer bổ sung 15+ FP khác (intercom-bridge dead code, treeCache TTL-30s, activeRunPromises delete-both-paths, pendingAtomicWrites flush, liveAgentModels 5000, per-write-validator 256, checkpoint 100, rpc sliding-window, AnchorManager 1000+TTL, resourceOwners disposeAllOwners...).

### Round metrics

| Metric | Count |
|---|---|
| Real issues | **9** (2 MEDIUM, 7 LOW — 7 explorer + 2 reviewer-missed) |
| CRITICAL / HIGH | 0 / 0 |
| False positive | 50+ eliminated |
| Verdict | **CONTINUE → Round 6** (đã chạy song song) |

### Actionable (cho plan)

- **MEDIUM-1 vào plan Phase 2.5** (state-store.ts split): coupled eviction `manifestCacheGeneration` ↔ `manifestCache` lifecycle — plan file mapping phải account.
- **LOW-4 vào plan Phase 2.4** (event-log.ts split): asyncQueues cap là ứng viên cho module mới.
- **LOW-1**: wire `clearGitRootCache`/`clearCleanLeaderCache` tại team-run start — gắn với Phase 2.6 team-runner split.
- **Suggestion round 7**: systematic grep "exported clear*/cleanup*/evict* functions with zero production callers".


---

## ROUND 6 — Resource Cleanup (Pattern 7, iterative-audit)

> **Round**: 6. **Pattern**: 7 (leaked listeners/timers/watchers/handles). **Methodology**: team `review` — explorer (01) + reviewer (02) + security-reviewer (03) + verifier (04).
> **Run**: `team_20260813060555_d55bd3874b41a35f` (4/4 tasks, model `zai/glm-5.2`).
> **⚠️ Reviewer (02) bị cut sớm** (152B — mới bắt đầu đào `process.on` background-runner). Explorer + security-reviewer đầy đủ → tổng hợp từ 2 nguồn độc lập này.

### Executive summary (merged explorer + security-reviewer)

**3 real findings (2 LOW + 1 LOW defense-in-depth) + 1 dead-code INFO + 30+ false positives eliminated. 0 CRITICAL / 0 HIGH.**

Codebase có **kỷ luật resource cleanup xuất sắc**: extension lifecycle (`runtime-cleanup.ts`) dispose 15+ resources trên 2 cleanup paths; background runner `runCleanup()` trên MỌI exit path; signal handlers có module-level flags; 6+ hardening rounds (BUG 4, W2, F12, OPT-06, RC-01, RC-03) đã đóng các leak pattern nguy hiểm nhất. Phần còn lại là minor omissions trong code paths đã được guard kỹ.

### Findings

#### R6-F1: `child-pi.ts:724` — `cancelHardKill` timer KHÔNG nằm trong `clearChildPiTimeouts()` (LOW) ⚠️ PLAN-TARGET

**File**: `src/runtime/child-pi/child-pi.ts:724-733` (timer local const trong `abort()`, 200ms, unref'd, guard `settled || childExited`).

**Leak**: `/team-cancel` → `abort()` tạo `cancelHardKill`. Nếu child exit bình thường trong 200ms, `settle()` gọi `clearChildPiTimeouts()` (:600-604) clear `noResponseTimer`/`finalDrainTimer`/`hardKillTimer`/`postExitGuardCleanup` — nhưng **KHÔNG clear `cancelHardKill`** (local const, không reachable). Nhiều cancel liên tiếp trên short-lived children → tích dead 200ms timers.

**Security angle** (security-reviewer): SIGKILL callback targets `child.pid` — nếu timer fire sau PID reuse, có thể signal nhầm process khác. Guard `settled || childExited` giảm risk nhưng clear trong settle() loại bỏ hoàn toàn race window.

**Fix**: hoist `cancelHardKillTimer` lên outer scope (cạnh :380), add vào `clearChildPiTimeouts()`.
**Cross-ref**: **Phase 2.3 split child-pi.ts → child-pi-timers.ts PHẢI bao gồm timer này** trong `clearAll()` contract cùng 5 timer kia (noResponse, finalDrain, hardKill, safety, poll).

#### R6-F2 (security-reviewer NEW): anonymous `{once:true}` abort listeners không remove (LOW, defense-in-depth)

**Files**: `src/runtime/team-runner.ts:2423-2426` + `src/extension/team-tool/run-deadline.ts:56-60`.

```typescript
// team-runner.ts:2423-2426 — pattern KHÔNG remove
if (input.signal) {
    if (input.signal.aborted) runController.abort();
    else input.signal.addEventListener("abort", () => runController.abort(), { once: true });
}
```

**Leak**: cả 2 add anonymous `{once:true}` listeners, không bao giờ `removeEventListener`. `finally` (team-runner.ts:2654) drainPendingUnits nhưng không remove; `resolveRunDeadline` return `{controller, timer}` nhưng caller chỉ clear timer (run.ts:735).

**Why LOW (not higher)**: trace signal chain — `ctx.signal` = `controller.signal` từ `team-tool.ts:206` (per-tool-invocation AbortController :174); sau tool execute, finally (:234-238) delete controller → GC-eligible. Listener trên short-lived signal → collected. Theoretical: nếu future refactor làm `ctx.signal` session-scoped → real per-run leak + `MaxListenersExceededWarning`.

**Consistency gap QUAN TRỌNG**: cùng pattern ĐÃ được fix trong `child-executor.ts:493-512` (W2), `run-coalesced-task-group.ts:193-196`, `run.ts:685-737` (RC-03 — comment :697-698 "the {once:true} alone leaks on the success path"). Nhưng team-runner.ts:2426 + run-deadline.ts:58 KHÔNG được fix.

**Fix**: apply W2/RC-03 pattern — store listener ref, `removeEventListener` trong finally.

#### R6-F3: `group-join.ts:201` — initial timeout KHÔNG `.unref()` (INFO — dead code)

**File**: `src/runtime/group-join.ts:201-206` — initial group timeout (30s default) không unref; re-arm timer (:232-233) CÓ unref → inconsistent.

**Zero impact**: `GroupJoinManager` exported nhưng **không bao giờ imported** (grep: chỉ class definition). Dead code — planned future phase. Fix nếu activate: add `.unref()`.

#### Correction (security-reviewer → explorer)

| Claim explorer | Thực tế | Impact |
|---|---|---|
| "crew-vibes: No session_shutdown handler but unref'd timers don't prevent exit" | **crew-vibes CÓ session_shutdown handler** (:368-375) stop cả 4 timers | Kết luận explorer (not a finding) đúng, nhưng lý do sai — handler tồn tại |

### False positives eliminated (30+)

Extension lifecycle (runtime-cleanup.ts dispose 15+ resources), background runner `runCleanup()` all-exit-paths, module-level `process.on` (ESM cached once), signal handlers flag-guarded (crew-cleanup.ts:87-106), zombie reaper (child-pi-kill.ts:33 unref'd singleton), team heartbeat (team-runner.ts:119 deliberate non-unref + cleanup closure), keep-alive (background-runner.ts:637 deliberate non-unref, cleared), watchdog (cleared), pollHandle (child-pi.ts:503 documented intentional non-clear + self-clearing), onParentAbort (child-pi.ts:369-373 removed in settle — BUG 4), abort listener (child-pi.ts:746 removed), delivery-coordinator (dispose clears ttlTimer), handoff-manager (unref'd BG2 + dispose), manifest-cache (dispose closes watchers), live-session (comprehensive finally), broker server/client (idempotent stop/close), subagent-manager (controllerCleanup removeListener fns), OTLP exporter (idempotent start/dispose + SSRF-protected), metric-sink (unref'd dispose), provider-usage (withTimeout finally), observability (dispose clears both timers), foreground-watchdog (stopAllWatchdogs RC-01), run-coalesced-task-group (finally W2), child-executor (finally W2 gold standard), crew-vibes (4 timers unref + session_shutdown), async-notifier (unref'd stop clears), progress timers (unref'd + cleanup closures), result-watcher (stop clears), prompt-runtime (unref'd, child process dies).

### Round metrics

| Metric | Count |
|---|---|
| Real issues | **3** (2 LOW + 1 LOW defense-in-depth) + 1 INFO dead-code |
| CRITICAL / HIGH | 0 / 0 |
| False positive | 30+ eliminated |
| Verdict | **CONTINUE → Round 7** (nhưng gợi ý đổi pattern — Resource Cleanup đang diminishing returns) |

### Actionable (cho plan)

- **R6-F1 vào plan Phase 2.3** (child-pi.ts → child-pi-timers.ts): `cancelHardKill` phải nằm trong `clearAll()` contract của module mới (cùng 5 timer hiện có).
- **R6-F2**: apply W2/RC-03 pattern cho `team-runner.ts:2426` + `run-deadline.ts:58` — consistency với child-executor/run-coalesced/run.ts. Vào plan Phase 2.6 (team-runner split) + Phase 4 (nếu touch run-deadline).
- **R6-F3**: `group-join.ts` dead code — Phase 1 dead-code cleanup candidate (move/remove), hoặc ít nhất `.unref()` nếu giữ.
- **Suggestion round 7**: systematic grep "exported clear*/cleanup*/evict* với 0 production callers" (từ LOW-1 Round 5 + R6-F3) — đây là pattern cuối đáng audit.


---

## ROUND 7 — Dead cleanup functions (Pattern 6, iterative-audit)

> **Round**: 7. **Pattern**: 6 (Code Quality — dead code). **Model**: `deepseek/deepseek-v4-flash` (model parent session). **Methodology**: team `review` 4/4 tasks.
> **Run**: `team_20260813064357_6f077d344970aa60`. **Gate**: verifier `test:critical` 101/101 + `tsc` clean (fresh run, exit 0).
> **Bản chất**: systematic grep `clear*/cleanup*/reset*/evict*/dispose*/purge*/invalidate*/close*/stop*/teardown*` + `*Cache` exported functions, verify production callers (excl. definition/`__test_`/test/bench/scripts). **READ-ONLY** — 0 file modified.

### Executive summary

**14 REAL dead functions** (1 HIGH-adjacent, 7 MEDIUM plan-related, 6 LOW) + **1 dead module cluster** + **~25 false positives eliminated** (registry/cleanup-list wiring, runtime-cleanup, re-export, `beforeExit` postmortem, `*ForTest` hooks). Round 6's gợi ý systematic grep **high-yield**: round này tìm NHIỀU dead cleanup hơn rounds 5+6 cộng lại. Nhiều finding nằm trong **plan Phase 1 (dead code)** scope; 4 file trong **plan Phase 2 target** (event-log, worktree-manager, child-pi) + 2 mâu thuẫn plan data.

### Findings (14 REAL + 3 reviewer additions)

| # | file:line | function | sev | prod callers | plan link |
|---|---|---|---|---|---|
| **R7-1** | `src/state/stores/blob-store.ts:273` | `cleanupOrphanedBlobs` | **MEDIUM→HIGH-adj** | 0 | **blob-store = DEAD MODULE (0 src importers)** — doc :212 falsely promises "periodic cleanupOrphanedBlobs() reclaim" nhưng không có periodic call. **Plan §3.1 stale** (liệt kê blob-store là lock consumer :59 nhưng unreachable) |
| R7-2 | `intercom-bridge.ts:181,169` | `cleanupIntercomQueue`/`getIntercomQueue` | LOW | 0 (module dead) | Phase 1 removal |
| R7-3 | `checkpoint.ts:225,172` | `clearCheckpoint`/`clearCheckpointStores` | **MEDIUM** | 0 | **Refinement (reviewer)**: `FileCheckpointStore` IS wired (status.ts:13,200) — chỉ module-level helpers dead, không cả file. Phase 2 retry-resume preserve store class |
| **R7-4** | `retry-runner.ts` | `RetryRunner`/`createRetryRunner` (cả module) | **MEDIUM** | 0 (cả module) | **⚠️ Plan Phase 2 §5.3 targets retry-runner** — module 0 prod callers! Wired retry primitive thật = `retry-executor.ts`. Plan PHẢI account (revive hoặc mark pre-planned dead) |
| R7-5 | `run-cache.ts:137` | `clearCache` (+`saveRunToCache` :84) | **MEDIUM** | 0 | Module wired read-only (status.ts:16 `getCachedRun`). Phase 2.5 |
| R7-6 | `task-graph-scheduler.ts:54` | `clearTaskGraphIndexCache` | LOW | 0 | self-documented no-op stub (WeakMap no clear) |
| R7-7 | `intermediate-store.ts:137` | `cleanupIntermediates` (module 0 importers) | **MEDIUM** | 0 | DWF revival path — comment-only tại dynamic-workflow-context.ts:152. Verify intent trước khi xóa |
| R7-8 | `hook-integrations.ts:46` | `resetHookStats` (cả file dead) | LOW | 0 | **+ Reviewer addition**: `clearHooks` (registry.ts:26, non-scoped) dead — chỉ `clearHooksScoped` wired (runtime-cleanup.ts:22,95,169) |
| R7-9 | `per-write-validator.ts:91` | `resetPerWriteValidatorCache` | LOW | 0 | module wired validate-only path |
| R7-10 | `event-log.ts:601` | `resetEventLogMode` | LOW | 0 (bench+test) | **Phase 2.4 event-log split** — move test helpers, đừng carry vào submodules |
| R7-11 | `file-coalescer.ts:66` | `clearReadCache` | LOW | 0 | module wired read path |
| R7-12 | `process-lifecycle.ts:419,468,485` | `disposeAllOwnedProcesses`/`disposeAllOwners`/`disposeOwner` (cả module dead) | **MEDIUM** | 0 | `spawnOwnedProcess`/`OwnedProcess`/`registerResourceOwner` 0 prod refs; beforeExit postmortem never registers. Phase 1 removal |
| R7-13 | `discover-agents.ts:148` | `clearSecurityEventLog` | LOW | 0 | **Observability gap**: security telemetry written (`logSecurityEvent`) nhưng **never surfaced** (`getSecurityEvents` 0 prod readers) |
| R7-14 | `task-name-generator.ts:335` | `resetTaskNames` | LOW | 0 | test-only |

**Dead module cluster** (0 src importers — reviewer/security confirm): `blob-store.ts`, `intercom-bridge.ts`, `process-lifecycle.ts`, `intermediate-store.ts`, `overlay-stack.ts`, `conflict-detect.ts` (đã biết plan Phase 1.1), `hook-integrations.ts`. Reviewer thêm `clearHooks` (registry.ts:26) — separate finding.

### False positives eliminated (~25)

`clearGitRootCache`/`clearCleanLeaderCache` (KNOWN R5 LOW-1), `GroupJoinManager` (KNOWN R6-F3), `clearStablePrefixCache` WIRED (team-runner.ts:62,1035 ✓), `cleanupAgentWorktreeAsync` WIRED (:1215), sync twin dead→nit, `invalidateSymlinkSafeCache` test-only nhưng cache self-invalidating TTL 10s (:222) — EXCLUDED, `invalidateConfigCache` WIRED (:1264,:1295), `stopCrewWidget`/`clearPiCrewPowerbar`/`disposePowerbarCoalescer` WIRED (runtime-cleanup + ui.ts), `disposeLiveAgentSession`/`evictStaleLiveAgentHandles`/`stopLiveAgent` WIRED (live-session-runtime:1208), `*ForTest` hooks intentional (child-pi-transcript:124, etc.) — EXCLUDED by rule, `clearHooksScoped` WIRED (runtime-cleanup:95,169), `purgeStaleActiveRunIndex` WIRED (crash-recovery-cache dynamic import), `stopWatchdog`/`stopAllWatchdogs` WIRED (foreground-run-controller + runtime-cleanup:143), `resetTimings` WIRED (register.ts:52), temp-dir cleanup family ALL WIRED (child-pi:626,673; crew-cleanup:152; lifecycle-handlers:324-325; pi-args self-invoke :495), `clearProviderQuotaCache` WIRED (lifecycle-handlers:147), `closeWatcher` WIRED (manifest-cache:372), `clearProjectRootCache` WIRED (runtime-cleanup:102,177), `cleanupRunWorktrees` WIRED (lifecycle-actions:241,653), discovery invalidates WIRED (management.ts:28-30), `stopParentGuard` WIRED (background-runner:203,264), `clearVibesStatus`/`clearProviderUsageCache` WIRED (crew-vibes:249,268), `cleanupOrphanWorkers` WIRED (lifecycle-handlers:341), `invalidateSnapshot` WIRED (team-tool:600), `clearTrackedTaskUsage` WIRED (team-runner:861), `clearSkillInstructionCache` bounded (SKILL_CACHE_MAX_ENTRIES) — EXCLUDED, `clearRpcSecret` part of public secret API on wired module — INFO, `clearHardKillTimer` WIRED (child-pi:820,881), `cleanupOldArtifacts` WIRED (artifact-cleanup:43,47), `clearTranscriptCache` bounded per-path — EXCLUDED INFO, class methods wired (anchor-manager clearAnchor :82, run-watcher closeAll, broker teardownSocket, crew-vibes speed resetSession/stopMessage, sharedScanCache WIRED nhưng invalidateBucket unused→nit, overlay-stack invalidateAll module dead→folded).

### Plan impact flags (dead code trong plan-target files)

| File (plan target) | Finding | Hành động plan |
|---|---|---|
| `event-log.ts` (Phase 2.4 split) | R7-10 `resetEventLogMode` dead | Move vào test helpers khi split; KHÔNG carry vào `event-log/` submodules |
| `worktree-manager.ts` (Phase 2.7 split) | `cleanupAgentWorktree` sync twin dead (:1168) | Drop hoặc alias async khi split |
| `child-pi.ts` (Phase 2.3 split) | `resetTranscriptBatchState` `*ForTest` seam (OK); `clearHardKillTimer` WIRED | No action |
| `retry-runner.ts` (Phase 2 §5.3 retry-resume) | **R7-4 cả module dead** | **Plan PHẢI account** — build on = revive; hoặc mark pre-planned dead. Wired primitive = retry-executor.ts |
| `blob-store.ts` (Phase 3.1 lock consumer) | **R7-1 cả module dead + doc false promise** | **Sửa plan §3.1** (remove blob-store khỏi lock-consumer list — unreachable); wire cleanupOrphanedBlobs vào run-maintenance HOẶC fix comment |

### Reviewer + verifier cross-validation

- Reviewer (02): 14/14 confirmed REAL + 3 refinements: blob-store **fully dead module** (upgrade), checkpoint **partially wired** (FileCheckpointStore live via status.ts), `clearHooks` **separate dead sibling**. Verdict CONTINUE → Round 8.
- Security (03): confirmed 14 real + dead-module cluster (intercom-bridge, process-lifecycle, intermediate-store, overlay-stack, conflict-detect, hook-integrations) + wiring of all claimed.
- Verifier (04): `test:critical` 101/101 + tsc clean (fresh run); 14/14 + 6 dead-module + 25 FP eliminations all match source. **PASS**.
- **Escalation**: `blob-store.ts` dead-module discovery **contradicts plan §3.1 acceptance criteria** — plan data correction bắt buộc trước Phase 3 work.

### Round metrics

| Metric | Count |
|---|---|
| Real issues | **14** (1 HIGH-adj, 7 MEDIUM, 6 LOW) + 3 reviewer additions + 6 dead modules |
| CRITICAL | 0 |
| False positive | ~25 eliminated |
| Verdict | **CONTINUE → Round 8** (MEDIUM findings trong plan-target scope — không phải LOW/INFO-only) |

### Actionable (cho plan author)

1. **R7-4 (retry-runner dead)** → Phase 2 §5.3 scope note: revive hoặc mark pre-planned dead; wired primitive = `retry-executor.ts`.
2. **R7-1 + blob-store dead module** → Phase 1 dead-code removal candidate; **sửa plan §3.1 lock-consumer list** (blob-store unreachable); fix doc false promise (:212) hoặc wire cleanupOrphanedBlobs.
3. **R7-2/R7-12 (intercom-bridge, process-lifecycle dead modules)** → Phase 1 removal candidates.
4. **R7-3 (checkpoint)** → Phase 2 retry-resume context: preserve `FileCheckpointStore` (live via status.ts:13,200), chỉ xóa module-level helpers dead.
5. **R7-7 (intermediate-store)** → verify DWF revival intent tại dynamic-workflow-context.ts:152 trước khi remove.
6. **R7-13 (security telemetry never surfaced)** → observability fix: wire `getSecurityEvents` vào surface (status/doctor) hoặc document.
7. **R7-8 + `clearHooks`** → Phase 1: remove `resetHookStats` (file dead) + `clearHooks` (registry.ts:26).
8. **R7-10** → Phase 2.4: `resetEventLogMode` move test helpers.


---

## ROUND 8 — Dead modules / zero-importers (Pattern 6, iterative-audit)

> **Round**: 8. **Pattern**: 6 (Code Quality — dead modules). **Model**: `deepseek/deepseek-v4-flash`. **Methodology**: team `review` 4/4 tasks — full-module zero-importer sweep trên **486 production `.ts` files**.
> **Run**: `team_20260813074053_a6f113343ed83024`. **Gate**: verifier `test:critical` 101/101 + tsc clean (fresh run).
> **Method**: custom import-graph resolver (NodeNext `.js`/`.ts` specifier, static + dynamic import, no path aliases trong tsconfig → relative-only, grep coverage complete). Reviewer re-ran độc lập → **51 zero-importers khớp chính xác** explorer.

### Executive summary

**45 REAL dead modules** (1 HIGH-adj security, 6 MEDIUM, 30 LOW, 8 INFO) + **6 false positives eliminated**. **Reviewer corrections applied**: (1) **R8-3 `parallel-utils.ts` = LIVE** (`dynamic-workflow-context.ts:41,515,531` dùng `mapConcurrent`) — REMOVED khỏi dead list, KHÔNG phải near-miss; (2) safe-bash test-ref: **5 test files import `safe-bash.ts`** (không phải 0 như explorer) — strengthening finding, không yếu đi. **Security reviewer**: live security controls (env isolation, path containment, ownership, depth guards, `--no-extensions` child isolation, `.crew/knowledge.md` untrusted tags, kill-switch, parent-guard residual) đều SOUND — không bị ảnh hưởng.

### HIGH — security-relevant false promise

#### R8-1: `src/tools/safe-bash.ts` (503 dòng) + `src/tools/safe-bash-extension.ts` — false security promise

- **Prod importers: 0**. Test refs: **5 files import `safe-bash.ts`** (reviewer correction — tested surface là helpers, không phải `safe_bash` tool registration); extension file chỉ comment ref trong tests.
- **Claim**: header hứa `"Enable in config: { tools: { bash: { safeMode: true } } }"` hoặc `PI_CREW_SAFE_BASH=true` — dangerous-command blocking (blacklist + whitelist + fork-bomb/ReDoS-safe scanners).
- **Reality (security-reviewer verify)**:
  - `CrewToolsConfig` (`config/types.ts:173-177`) **KHÔNG có** `safeMode`/`bash` sub-field; `parseToolsConfig` (`config.ts:918-926`) parse chỉ `enableClaudeStyleAliases`/`enableSteer`/`terminateOnForeground`
  - `PI_CREW_SAFE_BASH` env var: **0 reads trong src/** (chỉ doc comments của chính file dead)
  - Tool registration (`tool-registration.ts`): chỉ `team` + subagent tools — **không `safe_bash`**
  - Live bash tool = Pi built-in (`pi-api.ts:40` re-export `createBashTool`) — không wrapper gọi `checkCommand`/`isDangerous`
  - Chỉ mention trong `docs/archive/feature-analysis-subagent4.md` + `benchmark/benchmark-runner.ts:41` comment
- **Impact**: user set `safeMode`/env var tin rằng sudo/`rm -rf /`/`curl|sh`/fork-bombs bị block — **KHÔNG block** (dead code, không enforcement). 4 unit tests tạo illusion guard hoạt động. **`package.json` `files` includes `src/` → dead modules ship trong npm tarball** → false promise present trong published installs.
- **Recommendation**: remove cả 2 files + archived-doc ref, HOẶC wire vào bash tool chain (config schema + env read + registration). **Escalate — ngoài plan scope hiện tại.**
- **Severity**: HIGH (security false guarantee).

### MEDIUM — dead clusters & plan-target overlap

| # | File | Prod importers | Classification | Recommendation |
|---|---|---|---|---|
| R8-2 | `src/runtime/pipeline-runner.ts` (258 dòng) | 0 | REAL dead — **plan Phase 2.6-adjacent** (imports event-log, errors.ts, parallel-utils) | Not trong plan inventory; decide revive-or-remove |
| R8-4 | `src/state/coordination/schedule.ts` (ScheduleStore, detectSchedule, parseInterval, parseRelativeTime, validateCronExpression) | 0 | REAL dead — **plan coordination family**; live `scheduler.ts` (`runtime/scheduling/scheduler.ts:171,214,327-387`) **re-implemented** detectSchedule/parseIntervalMs/parseSchedule/nextRunTime | Duplicate cron utilities → consolidation decision; cron semantics drift risk |
| R8-5 | `src/state/hook-instinct-bridge.ts` → `src/state/stores/instinct-store.ts` → `src/utils/project-detector.ts` | bridge: 0; instinct-store: chỉ bridge (dead); project-detector: chỉ instinct-store (dead) | **Transitive-dead chain 3 modules** — bridge claims "Auto-initializes when imported" nhưng nothing imports; crewHooks subscription never fires | Remove cả 3, hoặc revive bridge. **Đừng conflate** với `skill-effectiveness.ts` (instinct concept khác) |
| R8-6 | `src/state/event-log/jsonl-writer.ts` (JsonlWriteStream, DrainableSource) | 0 | REAL dead — **plan Phase 2.4 event-log family**; live sibling `worker-atomic-writer.ts` là wired writer | Plan §2.4 split nên account |
| R8-7 | `src/runtime/compaction/compaction-summary.ts` (buildCompactionSummary, summaryPathsFor) | 0 | REAL dead — imports event-log.ts, types.ts, atomic-write.ts (dead module pull 3 core files at analysis) | Phase 1 dead-code list |
| R8-12 | `src/runtime/errors/crew-errors.ts` (162 dòng error class hierarchy) | 0 | **Duplicated** bởi live `src/errors.ts` (E001–E013 taxonomy dùng bởi team-runner/event-log/state-store) | Remove entire file + test; drift risk nếu removal misses duplicate |

### LOW — pure dead modules (30)

`agent-search.ts` (R8-8, live twin bm25-search.ts), `resilient-parser.ts` (R8-9, config.ts có own resilient merge), `prometheus-exporter.ts` (R8-10, OTLP-only pipeline), `metric-retention.ts` (R8-11, live metric-sink implements own), `loop-gates.ts` (R8-13), `metric-parser.ts` (R8-14), `phase-tracker.ts` (R8-15), `run-drift.ts` (R8-16), `task-quality.ts` (R8-17, 199 dòng), `run-projection.ts` (R8-18, imports mailbox/task-packet), `post-checks.ts` (R8-19, imports live env-allowlist/env-filter/resolve-shell/safe-paths), `stream-preview.ts` (R8-20, live pi-json-output replaced), `tool-progress.ts` (R8-21, hardcoded trong task-runner/progress.ts), `session-state-map.ts` (R8-22), `observation-store.ts` (R8-23, bench-only import), `tiered-eval.ts` + `types-eval.ts` (R8-24, **transitive-dead pair** mutual-only), `fingerprint.ts` (R8-25), `gh-protocol.ts` (R8-26, 556 dòng, forked oh-my-pi never wired), `sse-parser.ts` (R8-27, broker own ndjson), `cost-estimator.ts` (R8-28), `cat-frames.ts` (R8-29, crew-vibes dùng figures.ts), `result-watcher.ts` (R8-30, live family = manifest-cache + run-watcher-registry), `agent-management-overlay.ts` (R8-31), `crew-footer.ts` (R8-32, live twin crew-vibes/footer.ts), `crew-select-list.ts` (R8-33), `capability-pane.ts` (R8-34), `transcript-entries.ts` (R8-35).

### INFO — spike/barrel/test-only (8)

`scratchpad/index.ts` barrel (R8-36, keep while scratchpad Phase 1 ships), `benchmark-runner.ts` (R8-37, test infra), `feedback-loop.ts` (R8-38), + **5 knowns từ Round 7** (intercom-bridge R7-2, blob-store R7-1, process-lifecycle R7-12, intermediate-store R7-7, hook-integrations R7-8) + overlay-stack + conflict-detect (plan Phase 1.1).

### False positives eliminated (6)

`extension/register.ts` (dynamic import index.ts:116-119, index.bundle.ts:19 — **LIVE**), `runtime/background-runner.ts` (spawn path string async-runner.ts:238 — **LIVE**), `prompt/prompt-runtime.ts` (`--extension` CLI path pi-args.ts:331 — **LIVE**), `types/diff.d.ts` (ambient declare module "diff", render-diff.ts:1 imports package — **LIVE type decl**), `runtime/scratchpad/guest.ts` (spawned subprocess engine.ts:194 — **LIVE**), `ui/loaders.ts` (comment stub 0 exports — not a module).

### Reviewer cross-validation

- **02 (reviewer)**: re-ran import-graph resolver độc lập → **51 zero-importers khớp chính xác**; 6 FP eliminations verified với line evidence; transitive chains confirmed (hook-instinct-bridge→instinct-store→project-detector; tiered-eval↔types-eval; pipeline-runner→parallel-utils edge); duplication confirmed (schedule.ts vs scheduler.ts:171,214,327,351; crew-errors vs errors.ts; jsonl-writer vs worker-atomic-writer). **2 corrections**: parallel-utils LIVE (remove), safe-bash 5 test files (strengthen).
- **03 (security)**: R8-1 confirmed HIGH (false security promise, ships in npm tarball); live security controls verified SOUND (env isolation, cwd containment, safe-paths O_NOFOLLOW, ownership, depth guards, `--no-extensions`, untrusted knowledge tags, kill-switch user-config-only, parent-guard residual documented).
- **04 (verifier)**: `test:critical` 101/101 + tsc clean; every verifiable claim confirmed via source.

### Plan-target flags (12 modules)

`pipeline-runner.ts` (R8-2, Phase 2.6-adjacent), `schedule.ts` (R8-4, coordination family), `jsonl-writer.ts` (R8-6, event-log Phase 2.4), `compaction-summary.ts` (R8-7), `run-projection.ts` (R8-18, task-runner), `stream-preview.ts`/`tool-progress.ts` (R8-20/21, output family), `observation-store.ts` (R8-23), `tiered-eval.ts`+`types-eval.ts` (R8-24), `safe-bash-extension`/`safe-bash` (R8-1, escalate), `crew-errors.ts` (R8-12 duplicate errors.ts). Phase 1.5/2.x dead-code lists nên absorb tất cả.

### Round metrics

| Metric | Count |
|---|---|
| Real dead modules | **45** (1 HIGH-adj, 6 MEDIUM, 30 LOW, 8 INFO) + reviewer correction (parallel-utils LIVE removed) |
| CRITICAL | 0 (1 HIGH-adj security false promise) |
| False positive | 6 eliminated |
| Verdict | **CONTINUE → Round 9** (Round 8 có ≥1 MEDIUM + HIGH-adj — skill stop-condition 2×LOW/INFO-only chưa đạt) |

### Actionable (cho plan author)

1. **R8-1 safe-bash HIGH** → escalate: remove `safe-bash.ts`+`safe-bash-extension.ts` + archive ref, HOẶC wire (config schema + env + registration). **Trước khi bất kỳ user rely**.
2. **R8-2 pipeline-runner dead** → plan Phase 2.6 split inventory thêm revive-or-remove decision.
3. **R8-4 schedule.ts vs scheduler.ts** → consolidation decision trong coordination-family plan work.
4. **R8-5 instinct chain** → remove 3 modules hoặc revive bridge; đừng conflate skill-effectiveness.
5. **R8-12 crew-errors.ts** → remove (duplicate errors.ts) — drift risk.
6. **R8-6 jsonl-writer** → plan Phase 2.4 event-log split account.
7. Tất cả LOW → Phase 1.5 dead-code list absorb.


---

## ROUND 9 — Test Coverage Gaps (Pattern 3, iterative-audit)

> **Round**: 9. **Pattern**: 3 (Test Coverage Gaps). **Model**: `deepseek/deepseek-v4-flash`. **Methodology**: team `review` 4/4 — direct-import grep trên 797 test files (KHÔNG filename match), plan-target Phase 2 split coverage, dead-module test relocation map, security-critical audit, full 486-file zero-test scan.
> **Run**: `team_20260813082137_86526cad492253c6`. **Gate**: verifier `test:critical` 101/101 + tsc clean.

### Executive summary

**14 coverage gaps** (0 HIGH, **5 MEDIUM**, 9 LOW) + ~10 FP eliminated. **Regression net MẠNH cho 6/8 plan-target files** (event-log 47, state-store 127, child-pi 24, config 19, team-runner 14, broker 5, worktree 7). **2 plan-target files là risk thật**: `commands.ts` (1 test, name-only) + team-runner extraction sub-functions (3/9 targets 0 direct tests). **Security-critical: tất cả GREEN** (zombie-scanner, scratchpad engine, safe-paths, env-filter, atomic-write, merge-gate indirect, child-pi-kill harness) — **0 HIGH gaps**.

### Plan-target coverage table (Phase 2 split)

| File (Phase) | Direct tests | Coverage | Plan risk | Rec |
|---|---|---|---|---|
| `state-store.ts` (2.5) | **127** | Strong (state-store + cov + durability + corrupt-recovery) | **LOW** | Safe code-motion |
| `event-log.ts` (2.4) | **47** | Strong (23-file dir: seq-cache, tail-read, rotation, race, locks) | **LOW** | Cursor + seq-cache covered; split safe |
| `child-pi.ts` (2.3) | **24** | Strong behavioral (exit/timeout/hardening/compaction/parse/redaction + 7 integration) | **LOW** | Timers split safe (R6 F1 cancelHardKill phải included) |
| `config.ts` (2.2) | **19** | Good indirect (17-file config dir) | **MEDIUM** | `sanitizeProjectConfig` (:272) + `mergeConfig` (:359) **private** — split PHẢI thêm `__test__` exports |
| `team-runner.ts` (2.6) | **14** | Good at `executeTeamRun` level (12 tests) | **MEDIUM** | ⚠️ 3 extraction targets 0 direct tests (T-2) |
| `crew-broker.ts` | **5** | Strong (11-file broker dir + 2 integration) | **LOW** | Không trong Phase 2 split; adequate |
| `worktree-manager.ts` | **7** | Good (clean/seed/async + integration) | **LOW** | sync twin dead noted; async covered |
| `commands.ts` (2.1) | **1** | **Weak** — 62-line test chỉ assert 38 command-name set; 0 handler-behavior | **MEDIUM-HIGH** | **Test-first** trước split |

### Findings (MEDIUM)

**T-1 — MEDIUM — `commands.ts` handler layer = blind-move zone cho Phase 2.1**
`commands.ts:440-560` (registerCommand ×30) — 0 handler-behavior tests. `command-utils` (`parseRunArgs`, `setNestedConfig`, `pushUnset`, `parseScalar`, `commandText`) 0 direct tests. Handlers delegate `handleTeamTool` (team-tool.ts có 74 tests) nhưng arg-parsing/dispatch wiring untested. **Tests cần thêm**: per-command arg-parse→handleTeamTool mapping, error-path `notifyCommandResult`, command-utils units (parseScalar coercion, pushUnset/setNestedConfig deep-merge).

**T-2 — MEDIUM — team-runner extraction targets 0 direct tests**
`selectDispatchBatch` (:1363), `mergeUnitResult` (:1925), `advanceWorkflowPhases` (:2004) + `requiresPlanApproval` (:662)/`ensurePlanApprovalRequested` (:677) — **0 test mentions** (verified reviewer). Chỉ exercise transitive qua `executeTeamRun` (12 tests). `mergeUnitResult` merge policy partial qua `__test__mergeTaskUpdates` (merge-gate.ts, không qua team-runner path). **Tests cần thêm trước/với Phase 2.6**: batch-selection boundary (max batch, slot release, backpressure), `mergeUnitResult` race, `advanceWorkflowPhases` phase-transition table, `mergeArtifacts` (team-runner-artifacts.ts, 0 tests).

**T-3 — MEDIUM — `config.ts` private sanitize/merge extraction targets không direct tests**
`sanitizeProjectConfig` (:272) + `mergeConfig` (:359) non-exported, 0 direct imports; covered only via `loadConfig`. **Phase 2.2 split PHẢI add `__test__` exports hoặc test seam**. Tests: precedence matrix (user>project>defaults), sensitive-key drop-list, partial-object handling (:302-327).

**T-4/5/6 — LOW**: `run-worker.ts` (transitive only), task-runner helpers (result-utils, scaffold-executor, pre/post-execution, tail-read), `team-runner-artifacts.ts` `mergeArtifacts` (0 tests, Phase 2.6-adjacent move candidate).

### Dead-module test relocation map (13 test files — plan §1.5/1.7 gap)

**10/11 dead modules có live test files phải relocate/delete theo** (plan hiện chỉ list modules, không list test files):

| Dead module | Test files | Plan action |
|---|---|---|
| blob-store (R7-1) | `blob-store.test.ts` | relocate/remove |
| intercom-bridge (R7-2) | `intercom-bridge.test.ts` | relocate/remove |
| process-lifecycle (R7-12) | `process-lifecycle.test.ts` | relocate/remove |
| intermediate-store (R7-7) | `intermediate-store.test.ts` + `intermediate-store-traversal.test.ts` | verify DWF intent trước |
| hook-integrations (R7-8) | `hook-integrations.test.ts` | relocate/remove |
| pipeline-runner (R8-2) | `pipeline-runner.test.ts` | revive-or-remove decision |
| schedule (R8-4) | `schedule-store.test.ts` + `schedule-cov.test.ts` | **tests exercise dead module** — duplicate decision phải account 2 files |
| jsonl-writer (R8-6) | `jsonl-writer.test.ts` + `jsonl-writer-cov.test.ts` | event-log family (Phase 2.4) |
| compaction-summary (R8-7) | `compaction-summary.test.ts` | Phase 1 |
| crew-errors (R8-12) | `crew-errors.test.ts` | relocate/remove |
| agent-search (R8-8) | `agent-search.test.ts` | relocate/remove |
| gh-protocol (R8-26) | `gh-protocol.test.ts` | relocate/remove |
| hook-instinct-bridge (R8-5) | **0 test files** | safe remove; "if revived, tests needed" |

**⚠️ `safe-bash.ts` (R8-1 HIGH) có 5 test files** (`safe-bash.test/ansi/whitelist/extension-cov` + `dangerous-rm-expanded`) — tạo illusion guard; removal PHẢI delete cả 5.

### Security-critical audit (all GREEN — 0 HIGH)

zombie-scanner (2 direct), scratchpad/engine (13), safe-paths (2: nullbyte + traversal), env-filter (3), atomic-write (9), merge-gate (0 direct nhưng `__test__` re-export qua team-runner.ts:395 exercised), child-pi-kill (0 direct nhưng real harness `background-runner-sigint-cleanup.test.ts:79` import module thật).

### Reviewer corrections (2 precision, substance unchanged)

1. `output-handling-l4.test.ts` KHÔNG import `compactString` từ child-pi.ts (chỉ dùng `DEFAULT_CHILD_PI` từ config/defaults.ts) — behavioral tests ở `child-pi-compaction-real.test.ts`/`compact-pipeline-real.test.ts` import từ child-pi.ts re-export (child-pi.ts:209 ← child-pi-transcript.ts:134). Relocation-seam conclusion vẫn đúng (Phase 2.3 phải giữ re-export) nhưng cited test file cần sửa.
2. Zero-test raw count = 66 (explorer ghi 65 — off-by-one, immaterial).

### Round metrics

| Metric | Count |
|---|---|
| Coverage gaps | **14** (0 HIGH, 5 MEDIUM, 9 LOW) |
| FP eliminated | ~10 (type-only, barrel, indirect-via-barrel, dead-module-tests-of-live-twins) |
| Security-critical gaps | **0** |
| Verdict | **CONTINUE → Round 10** (2 plan-critical MEDIUM — stop-condition 2×LOW/INFO không đạt) |

### Actionable (cho plan author)

1. **Test-first Phase 2.1** (commands.ts): handler-level tests (parseRunArgs dispatch, team-config/team-autonomy/team-prune/team-export arg paths, notifyCommandResult error, command-utils units).
2. **Test-augment Phase 2.6**: batch-selection boundary, mergeUnitResult race, advanceWorkflowPhases phase table, mergeArtifacts unit.
3. **Phase 2.2**: `__test__` exports cho sanitizeProjectConfig/mergeConfig + precedence matrix + sensitive-key drop-list.
4. **Phase 1.5/1.7**: fold 13-file dead-module test relocation map vào acceptance criteria (hiện generic).


---

## ROUND 10 — Performance (Pattern 5, final round, iterative-audit)

> **Round**: 10 (FINAL của loop). **Pattern**: 5 (Performance). **Model**: `deepseek/deepseek-v4-flash`. **Methodology**: team `review` 4/4 — focus plan-target hot paths. **Run**: `team_20260813090657_1ee34ead6d11c0db`.
> **⚠️ Note**: 01_explore bị steer dừng sớm sau 1h35m/800 tool calls (over-analysis Pattern 5 — dễ rabbit hole). Verifier `test:critical` 101/101 + tsc clean.

### Executive summary

**9 perf issues** (1 HIGH, 4 MEDIUM, 4 LOW) + ~14 FP eliminated. Focus: plan-target hot paths. **Verified known-perf** (OPT-01 streaming dispatch, OPT-PHASE2 single parse `child-pi-streams.ts:144-155`, F4 coalescing, 3 UI caches) đều WORKING — không re-report. **Verdict: STOP loop** (final round).

### Findings

| # | file:line | sev | hot path | Vấn đề | Plan note |
|---|---|---|---|---|---|
| **R10-1** | `team-runner.ts:2615-2642` + `task-output-context.ts:428` | **HIGH** | per-batch (long-lived multi-batch runs) | Batch closeout: `aggregateTaskOutputs` gọi **2-3×** (batch summary + group-join `:2625` + dependency-context downstream), N+1 coalesced agent writes, 2 durable fsync state writes, `mergeArtifacts` O(artifacts)×3/batch → **O(B²) total** cho B-task run. Long-lived implementation/adaptive runs paid every batch | **⚠️ Phase 2.6**: batch-closeout sequence (2615-2642) trong extraction scope — KHÔNG move `aggregateTaskOutputs`/`deliverGroupJoin`/`writeProgress` I/O vào extracted `mergeUnitResult` không thay đổi; fix R10-1 TRƯỚC hoặc note known-limitation |
| R10-2 | `crew-agent-records.ts:220-224` + `atomic-write.ts:966-980` | MEDIUM | per read (`upsertCrewAgent` :385, snapshot build, 1s tick) | `readCrewAgents()` gọi `flushPendingAtomicWrites()` **process-globally** — flushes MỌI pending coalesced write (mọi run, mọi file). Under multi-run: 1 agent read trigger unrelated runs' writes | Phase 3 perf note: path-scope flush `flushPendingAtomicWrites(path?)` |
| R10-3 | `crew-broker.ts:990-1040` | MEDIUM | per poll tick (200ms × 60s) | `task.waitStatus` poll làm full `loadRunManifestById` (stat+stat+parse manifest+parse tasks) per tick — ~5-10 syscalls × 5 ticks/sec × N concurrent waiters | Phase 3 perf: task-status subscription (event-bus task.*) hoặc stat-mtime-only poll (mirror `parseManifestIfChanged`) |
| R10-4 | `run-snapshot-cache.ts:822-838` | MEDIUM | per sync `build()` (fs.watch run-dir event, refreshIfStale) | Sync `build()` re-reads `tasks.json` qua `readTasks()` mặc dù `loadRunManifestById` ĐÃ return tasks. Async path (:877-893) đúng (`loaded.tasks`). **Inconsistency** — doubles tasks.json I/O per snapshot rebuild | ⚠️ Phase 2 UI-cache: sync/async parity; `tasks = loaded.tasks` |
| R10-5 | `child-executor.ts:576-646` | MEDIUM | per child JSON event + per stdout line | Per event: `appendCrewAgentEvent` (~5 syscalls: existsSync+statSync+appendFileSync+statSync+.seq writeFileSync) + `appendCrewAgentOutput` per line + `persistChildProgress` (500ms throttle → upsertCrewAgent flush+read+N+1 writes) = ~8-10 syscalls/event. Verbose worker (1000s events) = 1000s sync syscalls runner thread | ⚠️ Phase 2.3/2.6 adjacency: `child-executor.ts` event-callback fanout = perf-relevant sibling của 6-timer extraction; batch như `appendTranscript` (50ms `transcriptBatches`) |
| R10-6 | `run-snapshot-cache.ts:166,170,752` | LOW | dead | `outputStamp`/`outputStampAsync`/`sliceSignaturesFor` 0 call sites (comment 1.5 explicitly dropped) | Phase 2 UI-cache cleanup (Round 7 dead pattern) |
| R10-7 | `crew-agent-records.ts:226-243` | LOW | per read (mismatch race) | `readCrewAgents` dedup mismatch → `saveCrewAgents` write-back từ READ path (durable full write + withAgentsLock); self-amplifying under concurrent writers | Return `deduped` không write-back; quarantine ở reconciliation point |
| R10-8 | `crash-recovery.ts:644-656` | LOW | per reconcile pass (5min + before_agent_start) | `reconcileAllStaleRuns` loads manifest **2×** per run (belt-and-suspenders re-read trong withRunLockSync) | Pass `loaded` vào lock; re-read chỉ khi contention |
| R10-9 | `event-log.ts:269-284` | LOW | append-path cold fallback | `scanSequence` full-file parse fallback khi .seq sidecar missing. **ST-12 đã move production append path sang `reserveSequenceUnderLock` (sidecar read)** → không per-append. Bounded 50MB worst-case | ⚠️ Phase 2.4: `sequence-cache.ts` split PHẢI preserve sidecar-first; KHÔNG reintroduce per-append scan |

### False positives eliminated (~14, verified WORKING)

OPT-01 streaming dispatch (`team-runner.ts:2420-2440,2504-2524` — mergeUnitResult race O(C) không O(C×T)); OPT-PHASE2 single parse (`child-pi-streams.ts:144-155,261-268` — emitLine parse once, compactChildPiLine reuse preParsed ✅); F4 coalescing (`atomic-write.ts:854-896` 50ms + saveRunTasksCoalesced + saveCrewAgentsCoalesced 250ms + appendEventBatchInsideLock single append+fsync); 3 UI caches (manifest-cache.ts:46 TTL 500ms + fs.watch, run-snapshot-cache.ts:28 TTL 1500ms + stamp-gated, run-dashboard.ts:117 buildSignature 100ms — all functional); emitFromTeamEvent deferred queueMicrotask (run-event-bus.ts:227-238, channel-filtered); child-pi 200ms quiet-drain + final-drain timers unref'd cleared on settle; heartbeats intentional watchdogs (team-runner 60s deliberate non-unref, heartbeat-watcher 5s→1s unref, background-runner 15s+5s bounded); sleepSync/Atomics.wait only sync lock paths documented v0.9.26 lesson; taskGraphSnapshot O(6N) linear + WeakMap memoized (không O(N²)); deliverGroupJoin full readMailbox per-batch bounded; seenFinishedRunIds/manifestCacheGeneration already Round 5 MEDIUM; worktree git calls per-task bounded + caches; nextAgentEventSeq/sequenceCache/appendCounters FIFO-capped 256/1000 O(1); manifest-cache list() full scan documented tradeoff fs.watch eager.

### Round metrics + LOOP TOTALS (rounds 4-10)

| Round | Pattern | Real | HIGH | MEDIUM | LOW | FP elim |
|---|---|---|---|---|---|---|
| 4 | Soundness+security | 12 | 2 | 4 | 6 | 0 (7/7 cross-checked) |
| 5 | Defensive caps | 9 | 0 | 2 | 7 | 50+ |
| 6 | Resource cleanup | 3 | 0 | 0 | 3 | 30+ |
| 7 | Dead cleanup fns | 14 | 1 adj | 7 | 6 | ~25 |
| 8 | Dead modules | 45 | 1 adj | 6 | 30+8 INFO | 6 |
| 9 | Test coverage | 14 | 0 | 5 | 9 | ~10 |
| 10 | Performance | 9 | 1 | 4 | 4 | ~14 |
| **TOTAL 4-10** | | **106** | **5** | **28** | **65+8 INFO** | **~135+** |

### Verdict: STOP loop (final round)

7 rounds (4-10), **106 issues** total, 0 CRITICAL, 5 HIGH-adjacent. Codebase well-hardened. Remaining work = implementation (Phase 1-5 plan execution), không thêm audit value.

### Actionable (cho plan author)

1. **R10-1 (HIGH)** → Phase 2.6: fix batch-closeout O(B²) artifact re-reads TRƯỚC code-motion, hoặc note known-limitation. Cache result-artifact reads per task within batch; reuse batch summary cho group-join body.
2. **R10-4 + R10-6** → Phase 2 UI-cache consolidation sweep: sync/async tasks.json parity; delete dead outputStamp/sliceSignaturesFor.
3. **R10-5** → Phase 2.3 note: child-executor event-callback fanout batching (mirror appendTranscript 50ms).
4. **R10-9** → Phase 2.4: sequence-cache.ts split preserve sidecar-first seq order.
5. **R10-2 + R10-3** → Phase 3 perf hardening note: path-scope flush + broker waitStatus subscription.

### Round 11 candidates (OUT of planned scope — if loop extended)

delivery-coordinator pending-queue filter eviction; `collectDependencyOutputContext` per-task artifact re-reads across dependents; result-watcher 1s polling fallback (unref'd, fs.watch failure only); run-coalesced-task-group heartbeat 1s; async-notifier listRuns 30s full-scan (debounced 20).


---

## ROUND 11 — Security Hardening (Pattern 4, iterative-audit)

> **Round**: 11. **Pattern**: 4 (Security Hardening — sink-by-sink). **Model**: `deepseek/deepseek-v4-flash`. **Methodology**: team `review` 4/4 — 4 surfaces: command injection, eval/vm, path traversal, subprocess safety. **Run**: `team_20260813110104_c801f85c08b64083`.
> **Efficiency**: guardrail hoạt động — explorer 16 tool calls, reviewer 7, security 17 (dưới 40).
> **Gate**: verifier `test:critical` 101/101 + tsc clean.

### Executive summary

**4 findings (1 MEDIUM, 3 LOW), 0 CRITICAL, 0 HIGH** + ~10 FP eliminated. Codebase **đã hardened mạnh**: no shell injection, no eval sinks, all id-derived paths validated/system-generated, RCE-adjacent features (dynamic workflows, preStepScript, setup hooks) có multi-layer gates. Các findings là defense-in-depth/subprocess-hygiene gaps, không phải exploit reachable hôm nay.

### Findings

| # | file:line | sev | Sink | Input source | Exploit scenario | Fix |
|---|---|---|---|---|---|---|
| R11-1 | `task-runner/retrieval-orchestrator.ts:148` (+:81 version probe) | **MEDIUM** | `spawn("rg", args)` — no timeout/maxBuffer/abort-kill | workspace cwd (semi-trusted) + static globs; `--files` enumerate cả repo | Very large repo → `rg --files` unbounded, accumulate unbounded stdout (OOM risk) | Add timeout 30-60s + SIGKILL + cap stdout ~10MB |
| R11-2 | `background-runner.ts:417,468` | LOW | `path.join(projectCrewRoot, "state/runs", _runId, ...)` — `_runId` từ argv KHÔNG qua `assertSafePathId` | argv từ `manifest.runId` (system-generated, trusted TODAY) | Not reachable now; nhưng là boundary duy nhất untagged — future user-supplied runId (`--resume`) → HIGH path traversal/file write ngoài root | `assertSafePathId("runId", runId)` tại argValue boundary |
| R11-3 | `state/stores/health-store.ts:44` | LOW | `path.join(dir, \`${manifest.runId}.json\`)` không assert | manifest.runId (validated upstream createRunPaths) | Same defense-in-depth | Reuse validated runId hoặc assert boundary |
| R11-4 | `team-runner.ts:175,217` | LOW | `spawn(process.execPath, ...)` sampler/analyze — no timeout/kill-on-run-end | trusted internal scripts, manifest.runId argv | Sampler linger orphan nếu không observe run completion (mitigated dead-worker alerts) | Optional: AbortSignal từ run teardown |

### Positive controls verified (~14 — codebase SOUND)

- **No `shell:true` anywhere** (worktree-manager.ts:304 disable hooks; verification-gates.ts:254 `sh -c` sau validateGateCommand allowlist — documented known)
- `execSync` chỉ static string `"npm root -g"` (pi-spawn.ts:159)
- **No eval sinks** (eval/new Function/vm absent; scratchpad = spawned guest Node engine.ts:194 với S-6 guard role-tools.ts:87-98)
- All spawns execPath/static commands + argv arrays (child-pi.ts:299, async-runner.ts:293, team-runner, worktree-manager:331/351, process-lifecycle:403, goal-achievement:54)
- Path traversal contained: runId (createRunId system-generated + assertSafePathId run-import:105, import-index:20, run-index:34), taskId (createTaskId sanitize + safeAgentTaskId regex), goalId (assertSafePathId goal-state-store:34 §0c C10), branch (sanitizeBranchPart worktree-manager:120-128), seedPaths (normalizeSeedPaths containment+symlink reject :496-526), artifact reads (resolveRealContainedPath task-output-context:189), setupHook (allowlist+realpath+no-shell+sanitizeEnvSecrets; TOCTOU documented), subagent ids (isValidSubagentId regex)
- Dynamic workflow RCE gates: F-01 default-deny project .dwf.ts (PI_CREW_TRUST_PROJECT_DWF=1, dynamic-workflow-runner:154-166), F-02 preStepScript strip (discover-workflows:157-165) + runtime gate (pre-execution.ts) + resolveRealContainedPath

### Reviewer/security cross-validation

- Reviewer (02): 4/4 findings confirmed accurate + severity correct; 0 new CRITICAL/HIGH.
- Security (03): 4/4 confirmed + ~14 positive controls spot-checked; 0 new un-audited input flows.
- Verifier (04): 101/101 + tsc clean; all 4 confirmed at exact file:line.

### Round metrics

| Metric | Count |
|---|---|
| Findings | **4** (1 MEDIUM, 3 LOW) |
| CRITICAL / HIGH | 0 / 0 |
| FP eliminated | ~10 |
| Verdict | Continue round 12 (security track materially complete; recommend apply fixes 1-2 rồi stop security track) |

### Actionable (cho plan)

1. **R11-1 (MEDIUM)** → Phase 2.6-adjacent task-runner: add rg timeout + stdout cap (cheap, isolated fix).
2. **R11-2 (LOW)** → assertSafePathId tại background-runner argv boundary (1 line, match existing pattern run-import:105).
3. **R11-3/R11-4** → defense-in-depth notes.
4. TOCTOU window setupHook symlink swap (worktree-manager.ts:318-324) — accepted, documented.


---

## ROUND 12 — L1 Cleanup (Pattern 1, iterative-audit)

> **Round**: 12. **Pattern**: 1 (L1 Cleanup — console → logInternalError). **Model**: `deepseek/deepseek-v4-flash`. **Methodology**: team `review` 4/4 — scan 67 console matches + 2 stderr.write, filter per skill rules. **Run**: `team_20260813110104_c323a084cb27c076`.
> **Efficiency**: explorer 13 tool calls (guardrail OK).
> **Gate**: verifier `test:critical` 101/101 + tsc clean.

### Executive summary

**23 callsites nên chuyển logInternalError** (21 strong + 2 borderline) — 44 skipped (lý do). Files bị đụng: 11 files, 6 files cần thêm import mới (pi-spawn, merge-gate, stale-reconciler, active-run-registry, discover-workflows, discover-agents).

⚠️ **Correctness caveat (security P1 cho cả round)**: `logInternalError` default severity `"debug"` — gated sau `PI_TEAMS_DEBUG`. MỌI conversion phải truyền explicit `"warn"`/`"error"` hoặc events trở nên **ÍT visible hơn** (insecure-default trap). Impl vẫn gọi console.error — giá trị thật = scope prefix `[pi-crew:scope]`, severity gating, single choke point cho future routing/capture.

### Findings — 23 callsites

**state-store.ts (7 — mixed-pattern rõ nhất, file đã import logInternalError):**
- `:946` `console.error` corrupt manifest.json (STATE-3 quarantine) — silent trong JSON-RPC → corrupt run invisible → cascade failures
- `:1108`/`:1245` corrupt manifest sync/async twins
- `:447` refuse empty tasks over existing (data-loss warning swallowed)
- `:887` tasks.json schemaVersion mismatch
- `:1097`/`:1234` manifest schemaVersion mismatch sync/async

**team-runner.ts (5 — file đã có 9× logInternalError):**
- `:201`/`:224` perf-obs sampler/analyze spawn failed
- `:2105`/`:2130` budget abort/warning threshold — run-termination event, console là operator channel duy nhất
- `:2151` fair-share violation

**stale-reconciler.ts (3 — file CHƯA import):** `:549` skip manifest parse error; `:556`/`:620` skip unreadable runs dir — zombie-run detection degraded silent

**Khác (6 strong):**
- `pi-spawn.ts:243` `console.error` realpathSync error → bin validation fallback (silent fallback khi explicit PI_TEAMS_PI_BIN validation fail = operator's binary pin không honored, không được báo)
- `process-lifecycle.ts:319` process group alive sau SIGKILL
- `merge-gate.ts:126` malformed finishedAt (NaN) — corrupt state merged silently
- `active-run-registry.ts:374` invalid runId ignored
- `orphan-worker-registry.ts:204` readRegistry failed (file đã dùng logInternalError 5×)
- `discover-workflows.ts:158` F-02 strip preStepScript — RCE-prevention policy event phải observable

**Borderline (2):** `mailbox.ts:490` corrupt delivery.json (comment "prominent (ungated)" — convert được với severity "error"); `discover-agents.ts:497` oversized agent skip (SEC-4)

### 🔴 NEW security finding (security-reviewer, NOT in explorer list) — Secret exposure P1

**`discover-workflows.ts:159` logs FULL untrusted `preStepScript` body vào unredacted stderr.** Project workflows là untrusted input (hostile repo clone); script chứa API key → leak ra stderr/logs. Parallel event channel (`hook.pre_step_skipped`) CÓ redaction tại write (event-log.ts:748/962/1094, mailbox.ts:518/589/702) nhưng console/stderr channel KHÔNG, và `logInternalError` cũng không redact. **Fix**: log step id + workflow name + source ONLY, hoặc wrap `redactSecretString()` trước khi interpolate.

### Security re-rank (implementation order theo security value)

1. `pi-spawn.ts:243` (HIGH) — silent fallback binary pin không enforced
2. `discover-workflows.ts:158` (HIGH) — RCE-prevention audit trail + redaction fix :159
3. `state-store.ts:946/1108/1245` (MED-HIGH) — corrupt run state invisible
4. `stale-reconciler.ts:549/556/620` + `orphan-worker-registry.ts:204` (MED) — zombie detection degraded → resource-exhaustion DoS unmonitored
5. `merge-gate.ts:126`, `active-run-registry.ts:374` (MED)
6. `team-runner.ts:2105/2130/2151` (MED)
7. `mailbox.ts:490`, `discover-agents.ts:497` (LOW, optional)

### Skipped (44 — lý do)

internal-error.ts:5 (impl), background-runner.ts ~19 callsites (detached child-process context, run.ts:490 — logInternalError không thêm visibility; line 146 test override), parent-guard.ts:90 (exit-time sync, phải fire đồng bộ), scratchpad/guest.ts:164 (captureWrite instrumentation), timings.ts:27-32 (debug-only PI_TIMING), run.ts:475 (debug-only PI_CREW_DEBUG_BUDGET), crew-hooks.ts + tiered-eval.ts (docstring examples), crew-cleanup.ts:67,76,88 (info lifecycle), run.ts:368 (SECURITY notice user-facing có chủ đích prominent), run-intent.ts:287-302 + team-runner.ts:820-824 (preflight notices user-facing icon), discover-agents.ts:413 (comment "no logger hook here yet; future refactor" — intentional documented)

### Guardrails bắt buộc khi implement (security P1)

- (a) Explicit severity `"error"`/`"warn"` trên MỌI call — không rely default `"debug"`
- (b) Redact/truncate `preStepScript` body tại discover-workflows.ts:159
- (c) `logInternalError` nên eventually accept redaction hook (future — choke point hiện không redact)
- (d) `pi-spawn.ts:243` — logInternalError giữ `.message` only, stack lost — pass error object + details

### Round metrics

| Metric | Count |
|---|---|
| Callsites cần chuyển | **23** (21 strong + 2 borderline) |
| Skipped (có lý do) | 44 |
| NEW security finding | 1 (discover-workflows.ts:159 secret exposure P1) |
| Verdict | Continue round 13 (23 ≫ ngưỡng 3) — nhưng đề xuất: chuyển sang IMPLEMENT mode, áp 23 conversions như Phase 1 work item |

### Actionable (cho plan)

1. **Round 12 → Phase 1 work item**: 23 console→logInternalError conversions (6 files thêm import) với 4 guardrails security. Files: state-store (7), team-runner (5), stale-reconciler (3), pi-spawn, process-lifecycle, merge-gate, active-run-registry, orphan-worker-registry, discover-workflows, mailbox, discover-agents.
2. **Fix secret exposure**: discover-workflows.ts:159 redact preStepScript.
3. Test sau implement: `npm test` + `tsc --noEmit`.


---

## ROUND 13 — Concurrency & Race conditions (iterative-audit)

> **Round**: 13. **Focus**: race conditions (skill note: rounds 4-6 từng tìm HIGH bugs ở race/locks). **Model**: `deepseek/deepseek-v4-flash`. **Methodology**: team `review` 4/4 — triage 8 focus areas, source verification. **Run**: `team_20260813111931_12218f1f5ee98e78`.
> **Efficiency**: explorer 15 bash calls (guardrail OK).
> **Gate**: verifier `test:critical` 101/101 + tsc clean.

### Executive summary

**4 race findings (2 HIGH, 1 MEDIUM, 1 MEDIUM-LOW)** + 8 FP eliminated. **Đây là round giá trị cao nhất**: stale-snapshot read-modify-write trong `handleRetry`/`handleCancel` + 4 api handlers — **pattern đã fix ở `respond.ts:43`/`async-notifier.ts:97` nhưng retry/cancel/task-claims/heartbeat bị miss**. Merge gate KHÔNG bảo vệ tool handlers (chúng write qua `saveRunTasks` trực tiếp, bypass merge-gate).

### 🔴 R13-1 — HIGH (borders CRITICAL) — `cancel.ts:122,136,163,184,189` (handleRetry)

- **Race**: `loaded = loadRunManifestById` (:122, best-effort no lock) → **`await executeHook("before_retry")` (:136, async gap UNBOUNDED)** → `withRunLockSync(loaded.manifest)` (:163) → `saveRunTasks(loaded.manifest, tasks)` (:189) từ **stale `loaded.tasks`** (:184). `withRunLockSync` KHÔNG re-read manifest (locks.ts:596-598 verified).
- **Impact**: task B "completed" trên disk giữa :122 và :189 → retry rewrite B về "running" — **correct on-disk state bị clobber**. Full-array overwrite (state-store.ts:455) — task runner thêm trong gap bị **DROP khỏi disk**, terminal evidence (`finishedAt`, `terminalEvidence`, `error`) bị **DESTROYED** → crash-recovery/zombie re-dispatch → **double execution**. Nếu runner exit trước coalesced write → task stuck non-terminal trong terminal run.
- **Fix (đã có template in-repo)**: `respond.ts:43` re-read `fresh` INSIDE `withRunLockSync`. Apply handleRetry: re-read manifest+tasks trong lock, move terminal short-circuit vào trong.
- **Không được merge-gate bảo vệ** (verified): merge-gate.ts P1/P2/P3 chỉ cover runner parallel-merge path; tool handlers bypass.

### 🔴 R13-2 — HIGH — `cancel.ts:240,259,292-298,345,369-370` (handleCancel)

- **Race**: stale `loaded` (:240) → `await executeHook("before_cancel")` (:259) + `terminateLiveAgentsForRun` + `killProcessPid` widen gap → lock (:292). Terminal short-circuit đọc **stale** `loaded.manifest.status` (:294); `updateRunStatus(loaded.manifest, "cancelled")` (:369-370) **spreads stale manifest + full-overwrite manifest.json** (state-store.ts:646-649).
- **Impact**: run "completed" giữa :240 và :292 → cancel **flips terminal status về "cancelled"** — terminal-state flip (HIGH class). `killProcessPid` chỉ mitigate async-runner writer, không cover concurrent tool actions (retry/cancel khác/status) từ sessions khác.
- **Fix**: same R13-1 — fresh re-read trong lock; derive abortResult + write + updateRunStatus từ fresh manifest.

### R13-3 — MEDIUM — `cancel.ts:155-160` (retryShortCircuitsCompleted)

Pre-lock decision trên best-effort read — retry bị refuse "already completed" trong khi run đã re-queued/failed. Self-healing (user re-invoke). Folded vào R13-1 fix.

### 🆕 R13-S1 (security-reviewer NEW) — MEDIUM (borders HIGH) — `api/task-claims.ts:50,107,171` + `api/heartbeat.ts:33`

- **Cùng class stale-snapshot**: `api.ts:59` load `loaded` lock-free → dispatch sync (:64) → handler `withRunLockSync(loaded.manifest)` write `saveRunTasks` từ **stale array**. Window ms-scale (không unbounded hook gap nhưng lock-acquisition contention mở rộng staleness).
- **Impact**: completed/failed task bị **resurrect về "running"+claimed** (hoặc heartbeat-refreshed); task mới thêm bị drop; `canTransitionTaskStatus` guard validate trên **stale status** → terminal flip ("completed"→"queued") có thể pass guard → **double execution**. `write-heartbeat` fires per-worker timer — frequent collisions.
- **Authz stable** (security lens): `owner` caller-supplied nhưng token-gated release timing-safe; `ownerSessionId` immutable → no authz bypass, chỉ correctness.
- **Fix**: fresh re-read trong lock (plan-approval.ts:42/109 = async example, respond.ts:43 = sync example).

### Verified-clean (8 FP eliminated — guards confirmed)

Lock twins O_EXCL + H-1 async-context re-entrance + ST-3 sync/async exclusion (locks.ts:596-700); withFileLock two-tier + ST-14 + Round 26 BUG 2 (no racy pre-acquisition check); event-log seq `reserveSequenceUnderLock` re-reads `.seq` under cross-process lock every call + max(sidecar, inProcess) (ST-5, B7); event-log stale-lock mtime-based steal + mkdir O_EXCL atomic; mailbox append vs rotate một `.flock` namespace (ST-3, B8) + delivery.json RMW wrapped; **merge-gate monotonic** (P1/P2/P3 + finishedAt compare) — clean CHO runner merge path; merge callers (team-runner.ts:1263,1977) fresh re-read trong lock; stale-reconciler PID TOCTOU pre/post startTime (recycled-PID → not dead); scratchpad flush-vs-kill (dispose snapshots awaits kills); broker observer unregistered before close + fanout skips closed; **respond.ts:43/plan-approval.ts:42,109 = canonical correct pattern**; saveRunTasks ST-4 guard (refuse [] over non-empty — nhưng KHÔNG chặn stale full-array overwrite).

### Round metrics

| Metric | Count |
|---|---|
| Race findings | **4** (2 HIGH + 1 MEDIUM + 1 MEDIUM-LOW) |
| CRITICAL | 0 (2 findings borders-CRITICAL per rubric) |
| FP eliminated | 8 (guards verified) |
| Verdict | **CONTINUE → Round 14** (round có HIGH — stop-condition 2×LOW-only không đạt) |

### Actionable (cho plan — HIGH PRIORITY)

1. **Phase 3 lock-work work item**: codify "mọi tool handler write phải fresh-re-read INSIDE lock" (extend respond.ts pattern). **4 sites concrete**: cancel.ts handleRetry (R13-1), handleCancel (R13-2), task-claims.ts ×3 (R13-S1), heartbeat.ts (R13-S1).
2. **Fix mechanical**: re-read `fresh = loadRunManifestById(...)` inside `withRunLockSync`; derive task/tasks/transition-guard từ fresh (respond.ts:43 template).
3. **Round 14 sweep**: tất cả `withRunLockSync(loaded.manifest, ...)` còn lại không fresh-re-read (mailbox.ts, agent-control.ts, read.ts ctx.loaded consumers) + 3 candidates (broker conn register vs stop snapshot, event-log .gen vs read cursor rotation, handleResume nested re-entrance).


---

## ROUND 14 — Stale-snapshot class completion + candidates (iterative-audit)

> **Round**: 14. **Focus**: hoàn thiện class stale-snapshot (sweep mọi `withRunLockSync(loaded...)`) + 3 candidates Part B. **Model**: `deepseek/deepseek-v4-flash`. **Methodology**: team `review` 4/4 — sweep 10 files `withRunLockSync(` + read-path files. **Run**: `team_20260813121744_e5d7aa0a9fec428b`.
> **Efficiency**: explorer 32 bash calls (slightly over 30 guardrail, trong time budget).
> **Gate**: verifier `test:critical` 101/101 + tsc clean.

### Executive summary

**4 findings (1 HIGH, 2 MEDIUM, 1 LOW)** + 12 sites swept-clean + Part B 3 candidates closed (B1 MINOR, B2/B3 FALSE). Reviewer (02) tìm thêm **R14-4 MEDIUM latent** mà explorer miss (crash-recovery.ts applyRecoveryPlan — "crash-recovery CLEAN" table entry không cover).

### 🔴 R14-1 — HIGH (borders CRITICAL — security strengthens) — `status.ts:50,67,78` (handleStatus)

- **Race**: READ path — `loaded = loadRunManifestById` (:50, NO lock, comment thừa nhận) → dead-async detection → `updateRunStatus(manifest, "failed")` (:67) + `saveRunTasks` (:78) từ **stale snapshot, ZERO `withRunLock` trong file** (verified).
- **Security-strengthen**: `updateRunStatus` (state-store.ts:645) validate transition theo **stale snapshot's own status** (`running→failed` legal), NOT on-disk current → concurrent writer commit `completed`/`cancelled` giữa :50 và :67 **không bị transition guard bắt** → stale overwrite correct disk state (CRITICAL definition; held HIGH vì cần concurrent writer + dead-async edge).
- **Secondary security**: state-mutating side-effect trên read-only path **KHÔNG có ownership gate** — bất kỳ session poll status của foreign run có thể trigger transition (ownerSessionId mismatch không check, khác handleResume R1 team-tool.ts:326-330).
- **Fix**: move side-effect OUT of read path (async-notifier.ts:96 làm đúng — fresh re-read trong lock) HOẶC wrap `withRunLockSync` + fresh re-read (respond.ts:43 pattern) + thêm ownership gate.
- **Phase 3.3**: site duy nhất write-on-read-path trong sweep.

### 🟠 R14-2 — MEDIUM — `background-runner.ts:884-899` (main() catch path)

- **Race**: catch block `withRunLockSync(manifest, () => loadRunManifestById)` (:884 — fresh read trong lock GOOD) → `manifestToUse` (:886) chỉ dùng cho `terminateLiveAgentsForRun` (:890); **`manifest = updateRunStatus(manifest, "failed")` (:898) dùng OUTER stale `manifest` + chạy NGOÀI lock** (lock released khi callback return). Comment claim sai — "prevent race with concurrent writers" nhưng save ignores fresh read.
- **Impact**: failure-status write dựa pre-throw snapshot → concurrent terminal flip bị overwrite hoặc `runtimeResolution`/artifact fields clobbered.
- **Fix**: one-liner `updateRunStatus(manifestToUse, "failed", message)` + derive eventsPath.

### 🟡 R14-3 — LOW — `run.ts:104` (scheduleBackgroundEarlyExitGuard)

Fresh-at-read, transition-guarded, nhưng write `updateRunStatus` no lock. Concurrent non-terminal write (runtime.resolved) có thể bị overwrite. Optional hardening.

### 🆕 R14-4 — MEDIUM (latent) — `crash-recovery.ts:137-190` (applyRecoveryPlan/declineRecoveryPlan) — reviewer NEW

- **Race**: `applyRecoveryPlan` `loadRunManifestById` (:138, no lock) → **`await executeHook("run_recovery")` (:145 — async gap arbitrary duration)** → `saveRunTasks(loaded.manifest, tasks)` (:169 reset-to-queued từ stale) + appendEvent. `declineRecoveryPlan` `loadRunManifestById` (:183) → `updateRunStatus(loaded.manifest, "cancelled")` (:190) no lock.
- **Reachability**: LATENT — hiện chỉ test calls (recovery-hooks.test.ts), no production caller; docs cross-session-leak-audit.md:474 nói chạy chỉ trên dashboard manual-accept. **Exported API có documented dashboard path** → class-completion gap.
- **Fix**: lock + fresh re-read sau hook await.

### Part B verdicts

- **B1 — MINOR (real, bounded)**: crew-broker.ts:104 handleConnection không check `this.stopped` — connection event queued sau stop() lands trong cleared set, linger ≤1s bởi helloTimer (HELLO_DEADLINE_MS=1000 unref'd). Token registry cleared → không auth được → no data-integrity. Optional hardening: early-return khi `this.stopped`.
- **B2 — FALSE (self-healing)**: event-log .gen sidecar vs cursor rotation — cursor đọc stale gen → rotation → đọc file mới từ stale offset → EOF 0 events → next call gen mismatch reset → re-read full. Worst case 1 empty-read call, no wrong-region persist.
- **B3 — FALSE**: handleResume nested re-entrance — `withRunLock` + fresh re-read INSIDE lock (R2 comment :354-357, explicit cover running→queued double-execution); lock released TRƯỚC executeTeamRun; AsyncLocalStorage lockCtx scoped per context; no cross-context bypass.

### Swept-clean table (12 sites)

CLEAN fresh-read ×7: respond.ts:42-43, plan-approval.ts:41-42/108-109, async-notifier.ts:96-98 (canonical), crash-recovery.ts:268/517/572/651, background-runner.ts:502, state-helpers.ts:75 (mtime-CAS + fresh reload on contention). BENIGN ×2: mailbox.ts:120/185 (mailbox-file under immutable runId paths, loaded.tasks chỉ taskId validation). N/A ×3: state-store.ts:613 (write primitive), read/anchor/handle-schedule/explain/inspect/api/chain-executor/lifecycle-actions (read-only/dir-ops), goal-wrap:271/run-import:157 (create-new). R13-reported không re-report: task-claims/heartbeat/cancel.

### Round metrics

| Metric | Count |
|---|---|
| Findings | **4** (1 HIGH, 2 MEDIUM, 1 LOW) |
| Swept-clean | 12 sites |
| Part B | B1 MINOR, B2 FALSE, B3 FALSE |
| Verdict | **CONTINUE → Round 15** (round có HIGH/MEDIUM — stop rule 2×LOW-only chưa đạt) |

### Actionable (cho plan — Phase 3.3 extension)

1. **status.ts (R14-1)**: move dead-async side-effect ra khỏi read path HOẶC wrap lock + fresh re-read + **ownership gate** (ownerSessionId check).
2. **background-runner.ts:898 (R14-2)**: one-liner dùng `manifestToUse`.
3. **crash-recovery.ts (R14-4)**: lock + fresh re-read trong applyRecoveryPlan/declineRecoveryPlan (latent — wire trước khi dashboard manual-accept dùng).
4. **run.ts:104 (R14-3)**: optional hardening.
5. **crew-broker.ts handleConnection (B1)**: optional check `this.stopped`.


---

## ROUND 15 — Write-on-read completion + scheduler/locks depth (iterative-audit)

> **Round**: 15. **Focus**: timer/watchdog write paths completion + scheduler/lock concurrency depth. **Model**: `deepseek/deepseek-v4-flash`. **Methodology**: team `review` 4/4. **Run**: `team_20260813131832_ace4037438349699`.
> **Efficiency**: explorer 10 bash calls, security 9 (guardrail OK).
> **Gate**: verifier `test:critical` 101/101 + tsc clean.

### Executive summary

**4 findings (0 CRITICAL, 2 MEDIUM, 2 LOW)** + 13 sites swept-clean + 1 FP dismissed. Part A (timer/watchdog): async-notifier CLEAN end-to-end (R14 :96 extended), còn lại residual coalesced-group heartbeat (LOW). Part B (scheduler): loop single-async-context internally serialized → loop-iteration/dispatch/budget/re-entrance CLEAN; gap = `finalizeRun` no-disk-recheck terminal write (**MEDIUM borders HIGH**) + root cause `mergeUnitResult` force-running (**MEDIUM latent**).

### 🟠 R15-1 — MEDIUM (borders HIGH) — `finalizeRun` clobber concurrent external terminal write

- **Location**: `team-runner.ts:2189-2330`. Status derived từ **in-memory** `ctx.tasks`/`ctx.manifest` (:2195-2298); terminal-preserve branch (:2278) check in-memory status only (bị mergeUnitResult force "running"); joint save (:2312-2316) `withRunLock` nhưng **không re-read disk**.
- **Race**: cancel (cancel.ts:292 writes disk "cancelled" + abortForegroundRun :359) hoặc reconciler (crash-recovery.ts:667 "failed") land giữa loop-exit và finalizeRun save → `updateRunStatus(manifest, "completed")` **overwrite disk cancelled** → **terminal flip cancelled→completed, user cancel bị revert vĩnh viễn** (loop done, không gì re-cancel).
- **⚠️ Reviewer AMPLIFICATION**: finalizeRun còn `await saveRunManifestAsync(manifest)` tại **:2309-2310 — TRƯỚC và NGOÀI withRunLock** — second unlocked write. Fix phải cover CẢ 2 writes (move sau 1 lock duy nhất + re-read disk).
- **Security**: integrity failure của cancel control (destructive-intent policy đã satisfied nhưng run recorded completed); retry/status/UI/reconciler consume sai terminal state. Status-value only → MEDIUM (no work loss).
- **Security S1 (LOW/note)**: handleCancel/handleRetry ownership pre-check (cancel.ts:243-250, retry.ts:126-130) **ngoài lock trên unlocked snapshot** — bundle vào fix: re-check ownerSessionId trong lock.
- **Fix**: trong finalizeRun's withRunLock, re-read `loadRunManifestById`; nếu disk terminal (cancelled/failed) hoặc signal.aborted → preserve disk terminal, skip completion branch (mirror CANCEL-1).

### 🟠 R15-2 — MEDIUM (latent) — `mergeUnitResult` force-running erases disk-terminal status

- **Location**: `team-runner.ts:1982` `updateRunStatus({...diskManifest, artifacts}, "running")`; loop top (:2450-2478) chỉ check `ctx.input.signal?.aborted` + in-memory tasks.
- **Race**: `cancelled:["running"]`, `failed:["running"]`, `completed:["running"]` đều LEGAL (contracts.ts:25-35) → external cancel/failed write disk **bị legally erased khỏi memory** bởi merge kế tiếp; loop không bao giờ observe (CANCEL-1/CANCEL-2 chỉ catch worker-reported cancelled hoặc signal abort, không phải disk-terminal).
- **Impact**: run tiếp tục dispatch sau user cancel (authorization-lifetime gap — worker tiếp tục tool/process execution sau revoke intent, khi signal-miss path). Directly enables R15-1.
- **Fix**: trong mergeUnitResult, preserve disk terminal status (chỉ force running từ non-terminal) + route cancel-during-exec path; optional top-of-loop disk-status check khi signal không aborted.

### 🟡 R15-3 — LOW — coalesced-group heartbeat full stale array

`run-coalesced-task-group.ts:111-139`: heartbeatTimer → `saveRunTasksAsync(manifest, updatedTasks)` — closure snapshot từ `input.tasks` (:45, dispatch-time), **full array gồm sibling tasks** không trong group; FIND-06 chỉ serialize timer's own writes, không protect stale-vs-merge race. Self-healing qua merge disk-base → transient inconsistency (un-cancelling sibling), no lasting corruption. Fix: chỉ touch group's own tasks (persistHeartbeat) hoặc fresh re-read trong timer.

### 🟡 R15-4 — LOW — `withRunLockSync` throws "locked" vs in-process loop

`locks.ts:332-352` sync acquire `treatOwnPidAsStealable=false` → throw trên own-pid fresh lock × cancel.ts:292. Window = mergeUnitResult's withRunLock awaits. No deadlock (throws not spins), cancel error intermittent (retry succeeds). **Benign side-effect noted**: throw này cũng prevent R13 stale-snapshot clobber trong same-process case — keep in mind khi fix R13. Fix optional: catch "locked" + retry backoff, hoặc cross-tier bypass mirror fileSyncLockHeldByUs.

### Swept-clean (13 sites)

async-notifier markDeadAsyncRunIfNeeded (:78-110 — withRunLockSync + fresh re-read :92 + status re-check, CLEAN end-to-end); markStaleAsync others (chỉ status.ts R14-1, no new); foreground-watchdog (reads + sendUserMessage only); heartbeat-watcher (appendEvent/deadletter ledger only — **FP dismissed**); result-watcher (reads/unlinks result files); delivery-coordinator ttlTimer (in-memory pending only); background-runner other paths (SIGINT events+exitCode, interrupt poll control-file ack, runCleanup R14-verified); extension lifecycle (crew-cleanup child/temp, cleanupRuntime controller.abort only, before_switch generation/coordinator); executeTeamRunCore loop (single async context sequential, merge disk-base CANCEL-1, RT-15 top-of-loop sync); selectDispatchBatch+dispatchBatch (inFlightTaskIds excludes dispatched, hook-awaits re-check, signal propagate → no double-dispatch); enforceRunBudget (read-only unless abort → terminaliseRunWithDrain locked); withRunLock nesting (per-async-context lockCtx H-1, no nested same-lock in loop); finalizeRun vs reconciler (reconciler side locked+fresh :655-667, finalize side = R15-1 FINDING); coalesced-group heartbeat (R15-3 FINDING); dispatch-vs-cancel double execution (CLEAN).

### Round metrics

| Metric | Count |
|---|---|
| Findings | **4** (2 MEDIUM, 2 LOW) |
| Swept-clean | 13 sites |
| FP dismissed | 1 (dead-streak gradient) |
| Verdict | **CONTINUE → Round 16** (round có MEDIUM; rounds 13-15 đều HIGH/MEDIUM — stop rule 2×LOW-only chưa đạt) |

### Actionable (cho plan — Phase 3.4 extension)

1. **finalizeRun (R15-1)**: move cả 2 writes (:2309 unlocked + :2312 locked) sau 1 lock duy nhất + re-read disk + preserve disk terminal + signal.aborted check.
2. **mergeUnitResult (R15-2)**: preserve disk-terminal status (chỉ force running từ non-terminal) — 1 work item chung với R15-1.
3. **Security S1**: re-check ownerSessionId trong lock cho handleCancel/handleRetry.
4. **run-coalesced-task-group (R15-3)**: heartbeat chỉ touch group's own tasks.
5. **locks.ts/cancel (R15-4)**: optional catch "locked" retry backoff — lưu ý side-effect protect R13.


---

## ROUND 16 — Pre-lock snapshot counter-party + event-log/mailbox contention (iterative-audit)

> **Round**: 16. **Focus**: tool handler pre-lock snapshot counter-party sweep + event-log/mailbox/atomic contention depth. **Model**: `deepseek/deepseek-v4-flash`. **Methodology**: team `review` 4/4. **Run**: `team_20260813143244_3513453d27fd46dd`.
> **Efficiency**: trong guardrail.
> **Gate**: verifier `test:critical` 101/101 + tsc clean.

### Executive summary

**1 finding (1 MEDIUM, borders HIGH)** + 15 swept-clean + 2 FP filtered. **Part A: ZERO new findings** — mọi tool handler pre-lock snapshot site đều đã covered bởi R13-1/2, R13-S1, R14-1/3, hoặc dùng fresh-read-in-lock pattern (respond.ts, plan-approval.ts), hoặc create-new. `retry.ts` không tồn tại (action dispatch → cancel.ts handleRetry). **Part B: R16-B1** — event-log dual lock-namespace contention.

### 🟠 R16-B1 — MEDIUM (borders HIGH) — `event-log.ts:109,516` (`.mkdirlock` vs `.alock` dual namespace)

- **Race**: `withEventLogLockSync` tạo `${eventsPath}.mkdirlock` (:109); `withEventLogLockAsync` tạo `${eventsPath}.alock` (:516) — **2 disjoint cross-process lock namespaces trên cùng eventsPath** (intentional split để tránh v0.9.26 sleepSync-vs-async-timer deadlock, comment :479-492). Cả 2 append paths reserve seq qua `reserveSequenceUnderLock` (:412) — trust `.seq` sidecar trực tiếp, **no mutual exclusion, no full-scan guard** (EL-1 `Math.max(stored, fileMax)` guard CHỈ ở nextSequence :306-336, giờ seed/test-only).
- **Effect 1 — Duplicate seq**: parent sync + child async đều đọc sidecar=N → đều reserve N+1 → 2 events share seq; `readEventsCursor` filter `seq > sinceSeq` (:1413) đã consume event đầu → **silently drops event thứ 2**.
- **Effect 2 — Rotation stranding**: `rotateEventLogUnlocked` (rename→archive + "wx" recreate, rotation.ts:424-434) chạy dưới `.alock`; sync append mid-`appendFileSync` giữ fd trên renamed inode → event lands trong **archive**, invisible cho live readers (readEvents/readEventsCursor không đọc archive). EEXIST guard chỉ protect recreate, không protect in-flight-fd stranding.
- **⚠️ Reviewer evidence-strengthen — mitigation "extremely unlikely" CONTRADICTED**: comment :487-491 claim "workers write to own run-scoped events.jsonl, not parent's" — nhưng **14 parent-side sync `appendEvent` sites** write live run's path trong khi child async-appends: cancel.ts:361, status.ts:82/130, agent-control.ts:57/317, plan-approval.ts:66/144, mailbox.ts:132/188/194, task-claims.ts:54/111/175, heartbeat.ts:45. task-claims/heartbeat/mailbox chạy **trong withRunLockSync khi child còn alive** — đúng cancel-while-running window.
- **⚠️ Security amplifier**: status.ts (:50-90) **ZERO withRunLockSync** — mutate run state + sync appendEvent trên pre-lock loaded snapshot → R16-B1 cross-namespace window mở **mỗi dashboard tick/RPC poll** của live run (tần suất cao hơn cancel-while-running). R14-1 cover stale-snapshot clobber; sync appendEvent là interaction mở window.
- **Fix (KHÔNG naively merge .mkdirlock+.alock — reintroduce v0.9.26 deadlock)**, theo thứ tự ưu tiên:
  1. **Common `.seqlock`** cho seq reservation only — wrap reserveSequenceUnderLock's read-compute-write của .seq sidecar trong third tiny lock namespace shared bởi cả 2 append families (mailbox ST-3 single `.flock` pattern mailbox.ts:574-584)
  2. Port EL-1 guard vào reserveSequenceUnderLock (Math.max(stored, scanSequence)) — cost per-append scan, pair ST-12-style caching
  3. Route parent sync appendEvent trên run paths qua async queue khi child runner live
- **Phase note**: Phase 3.4 (state-store/event-log locking unification) — same work item family mailbox ST-3; fold R14-1 status.ts unlocked-write remediation.

### Swept-clean (15 sites)

**Part A (11)**: cancel.ts:189/345/369 (R13-1/2), cancel.ts:195/349 saveCrewAgents (same root), retry.ts không tồn tại, respond.ts:125 (fresh :42-43 canonical), task-claims.ts:53/110/174 (R13-S1), heartbeat.ts:44 (R13-S1), status.ts:67/78 (R14-1), plan-approval.ts:143/151 (fresh :108-109), run.ts:117 (R14-3), run.ts:544/640 + goal.ts:195 + goal-wrap:271 + import-index (create-new), explain/inspect/read/anchor/lifecycle-actions/api:mailbox (read-only/dir-ops).

**Part B (5)**: B1 event-log contention → **FINDING R16-B1**; B2 rotation-vs-append same-namespace CLEAN (cross-namespace folded R16-B1); B3 mailbox append vs delivery read (R12 C3, delivery RMW locked :600/:710/:792/:871); B4 mailbox rotation vs append (B8, rename+recreate trong lock); B5 broker fanout (FP — observer unregistered trước close crew-broker.ts:266-270, queueMicrotask snapshot, durable inbox + msg.id dedup); B6 atomic-write coalesced vs flush (sync flush no tick interleave, generation counter :917 + timer cancel + flushInProgress re-entrancy guard :1040).

### Round metrics

| Metric | Count |
|---|---|
| Findings | **1** (1 MEDIUM borders HIGH) |
| Swept-clean | 15 sites |
| FP filtered | 2 |
| Verdict | **CONTINUE → Round 17** (R16-B1 live MEDIUM; R14-16 đều MEDIUM+ — stop rule 2×LOW-only chưa đạt) |

### Actionable (cho plan — Phase 3.4 extension)

1. **R16-B1**: unify event-log sync/async lock namespace (mailbox ST-3 .flock pattern) HOẶC common `.seqlock` cho reserveSequenceUnderLock. KHÔNG naive merge (v0.9.26 deadlock).
2. **status.ts amplifier**: fix R14-1 (unlocked writes) cùng với R16-B1 — mỗi status poll mở window.
3. **Empirical stress test** (gợi ý round 17): 2 processes append cùng eventsPath, 1 sync 1 async → verify seq collision.


---

## ROUND 17 — Empirical R16-B1 test + error-path robustness (iterative-audit)

> **Round**: 17. **Focus**: (a) empirical stress test R16-B1; (b) error-path/exception robustness sweep. **Model**: `deepseek/deepseek-v4-flash`. **Methodology**: team `review` 4/4. **Run**: `team_20260813150753_491b94e118d2be7a`.
> **Gate**: verifier `test:critical` 101/101 + tsc clean. Scripts `/tmp/eventlog-race-test.mjs` + `-worker.mjs` viết, chạy, **đã xóa** (không vào repo).

### Part A — 🔴 R16-B1 CONFIRMED EMPIRICALLY

**Setup**: minimal-but-faithful repro — 2 child processes append cùng eventsPath: sync path (`.mkdirlock` mkdir O_EXCL) + async path (`.alock`), cả 2 qua `reserveSequenceUnderLock` semantics (read `.seq` sidecar → next = stored+1 → append → persist, read-modify-write NO mutual exclusion giữa 2 lock classes).

**Results (WORK_US=300, 3000 events)**:
```
iter 1: 600 events, 134 dupSeq, 347 dupEvents  iter 4: 600, 103 dupSeq, 487 dupEvents
iter 2: 600, 66 dupSeq, 528 dupEvents            iter 5: 600, 117 dupSeq, 473 dupEvents
iter 3: 600, 107 dupSeq, 425 dupEvents
TOTALS: 3000 events → 527 duplicate seq values, 2260 duplicate events (75%)
```
**Natural rate (WORK_US=0, 4000 events)**: 586 dupSeq, 2985 dupEvents (75%) — collisions KHÔNG "extremely unlikely" kể cả không artificial widening. **Lost events**: 0 seq gaps (sidecar advances) nhưng **duplicate seq → sinceSeq streaming consumer (readEventsCursor :1431/:1477) silently drops event sau với shared seq** — effective loss = dupEvents (75% writes).

**Production exposure (verified)**: team-runner.ts:582/603/611/885 sync `appendEvent` (.mkdirlock) vs extension/team-tool async `appendEventAsync` (respond.ts:138, cancel.ts:204/281, run.ts:118/454...) (.alock) + child-executor.ts:547 threads eventsPath vào worker (child-pi.ts:151 I5) — **separate processes, shared sidecar, split namespaces**.

**Conclusion**: comment event-log.ts:487-490 "extremely unlikely" **SAI** cho mọi eventsPath concurrently written bởi cả 2 lock classes. Mailbox đã nhận fix tương tự (ST-3, mailbox.ts:577-585 collapse 1 .flock); **event-log.ts CHƯA**. Reviewer: mechanism claims + consumer impact verified line-exact; 75% workload-specific nhưng qualitative refutation robust + code-confirmed.

**Fix (empirically justified)**: single lock namespace cho event-log (route sync qua .alock) HOẶC shared `.seqlock` cho reserveSequenceUnderLock+persistSequence. Phase note: P0/P1 hardening item. **Regression test gợi ý**: `bench/b9-eventlog-dual-namespace.bench.ts` assert no duplicate seq (script đã xóa — commit durable test khi fix lands).

### Part B — Error-path robustness (corrected tally: 1 HIGH + 3 LOW + 1 benign + 1 retracted + 1 new)

| # | file:line | sev | Vấn đề | Fix | Note |
|---|---|---|---|---|---|
| **R17-B1** | `crew-agent-records.ts:140-146` | **HIGH** | `removeStaleAgentsLock` outer `catch { return false; }` **nuốt mọi lỗi** (parse/stat/rm) không log → withAgentsLock (:156-172) treat "not stale" → retry → throw generic "Crew agents file is locked" sau 60s — root cause INVISIBLE | `catch (error) { logInternalError("crew-agents.remove-stale-lock", error); return false; }` | Reviewer: borderline HIGH/MEDIUM (failure visible generic) nhưng availability issue trên state write path — HIGH defensible |
| R17-B3 | `pi-spawn.ts:33,52,60,68,84,89,104,118,166` | **LOW** (downgrade từ MEDIUM) | 9 bare `catch { /* ignore */ }` trong spawn discovery — root cause (EACCES) invisible → "cannot find pi" confusing | debug-level log | Reviewer: allowlist-prefix discovery có defined fallbacks → LOW framing đúng |
| R17-B4 | `async-runner.ts:57` | LOW | `resolveJitiRegister` catch fall-through — benign (undefined → fallback) | optional debug log | — |
| R17-B5 | `subagent-manager.ts:188` | LOW | `readPersistedSubagentRecord` catch return undefined — corrupt record silently disappears (safe fallback) | debug log | — |
| R17-B6 | `delivery-coordinator.ts:96/196` (path corrected từ `state/coordination/mailbox/...`) | benign | secondary delivery emit catch — **intentional** commented | none | — |
| **R17-B2** | `event-log.ts:1218-1241` | **RETRACTED (FP)** | Explorer claim "callers hang on unresolved promises" — **SAI**: cap-drop branch splice + reject TỪNG dropped item's promise (:1236-1241) + logInternalError. H3 fix CHÍNH LÀ branch đó (comment :1215-1217 "We now reject with a clear error so callers can fall back") | none | Reviewer + security đều retract |
| **R17-S1 (NEW, security)** | event-log size-limit skip paths (sync+async append) | MEDIUM | **Size-limit skip returns SILENT SUCCESS** — append vượt max trả về như thể thành công, caller không biết event bị drop | trả lỗi hoặc log rõ | Security missed-finding |

### Swept-clean (verified benign)

91 `finally` blocks — **0 throw-in-finally** (reproduced exact); `catch {}` biome-ignore (scratchpad engine.ts:371 dead-pipe, guest.ts:73/506 exit-path); event-log lock internals best-effort (:130/141/149/158); `catch { /* owner dead */ }` lock staleness; heartbeat-watcher:131 PID gate; 25 `void async` sites — **ALL có .catch hoặc internal try/catch** (run-snapshot-cache:1005, child-pi-transcript:61, scratchpad-lifecycle:183, child-executor:348/438); appendEventAsync rejection-safe chain (asyncQueues two-tier event-log.ts:634) + global unhandledRejection handlers (background-runner:300, guest:467); flushOneEventLogBuffer timer callback có .catch logInternalError; atomic-write/worker-atomic-writer 30+ bare catches đều có comment suppression hoặc re-throw; subagent-manager:403 void handled.

### Round metrics

| Metric | Count |
|---|---|
| Part A | **R16-B1 CONFIRMED empirically** (75% dup rate) |
| Part B findings | **1 HIGH + 3 LOW + 1 benign + 1 retracted FP + 1 NEW (security)** |
| Verdict | **CONTINUE → Round 18** (R17 có HIGH — không LOW-only) |

### Actionable (cho plan)

1. **R16-B1 fix = P0/P1** (empirically justified): event-log single lock namespace / shared .seqlock + **commit durable regression bench** (script đã xóa — đừng để fix không provable).
2. **R17-B1 (HIGH)**: logInternalError trong removeStaleAgentsLock catch.
3. **R17-S1 (NEW)**: size-limit skip silent success → trả lỗi hoặc log rõ.


---

## ROUND 18 — Rotation-stranding empirical + size-limit sweep + fix-conflict analysis (iterative-audit)

> **Round**: 18. **Focus**: (a) empirical rotation-stranding (R16-B1 effect 2); (b) R17-S1 verify + size-limit sweep + race re-scan; (c) fix-conflict/lock-ordering (Phase 3.3-3.7). **Model**: `deepseek/deepseek-v4-flash`. **Methodology**: team `review` 4/4. **Run**: `team_20260813163017_ae09310712cec61e`.
> **Gate**: verifier `test:critical` 101/101 + tsc clean. Script `/tmp/r18-rotation-strand.mjs` viết, chạy, xóa.

### Part A — 🔴 Rotation stranding CONFIRMED EMPIRICALLY (R16-B1 effect 2)

**Setup**: minimal repro — process A `appendFileSync` tight loop (đúng event-log.ts:1105 append primitive) vs process B rotation (đúng `rotateEventLogUnlocked` :424-427 renameSync + "wx" recreate).

**Numbers (6s, max contention)**: 3,650 rotations, 340,562 appends, **18,478 stranded (5.43%; 5.06/rotation)**.

**⚠️ Reviewer caveat**: 5.43% là max-contention **zero-lock** minimal-repro rate — KHÔNG quote là production loss rate. Real exposure hẹp hơn (same-process sync/async không interleave mid-append; rotation fires >50MB). Expected production stranded-per-rotation ≈ 0-2. **Qualitative conclusion robust**: race real, events unrecoverable.

**Archive-never-read confirmed (aggravator)**: `readEvents` (:1372) + `readEventsCursor` (:1414) đọc chỉ live file; R-03 generation sidecar (:1417-1423) chỉ reset offset 0, **không re-deliver archive** (comment explicit "those live in the archive, not the (now fresh) current file"); `event-reconstructor.ts` zero archive refs; `sweepOldArchives` (:361-379) unlink archive sau 7 ngày → **stranded events gone forever**. Contrast: mailbox ĐỌC archives (mailbox.ts:325-333) → mailbox stranding mitigated, event-log not.

**Fix (recommend (a))**: (a) event-log readers/reconstructor đọc archive tails (mailbox pattern); (b) post-rotation reconcile stranded tails vào live file; (c) serialize rotation với cả 2 lock classes (heavier).

### 🔴 Part B — R17-S1 CONFIRMED + ESCALATED HIGH (fully silent)

- **Sync path** event-log.ts:1078-1086: `skippedDueToSize=true` → skip `appendFileSync` (:1105) + skip `persistSequence` → `return fullEvent` (:1152) — caller nhận normal TeamEvent với seq, as-if-persisted, **zero indication of drop**.
- **Async path** :732-747 → :846 — identical success-resolve.
- **ESCALATION**: drop log `logInternalError("event-log.size-limit")` pass **NO severity** → default `"debug"` → gated `PI_TEAMS_DEBUG` (internal-error.ts:2-5) → **fully silent in production**. Per rubric (silent drop in state path) = **HIGH** (near-zero reachability nhưng mechanics confirmed).
- **⚠️ Security addition (raises practical reachability)**: drop chain không chỉ concurrent writer — `rotateEventLogUnlocked` return `false` khi fail nhưng **mọi caller ignore return** (:1073, :745), `event-log.rotate` log cũng debug-gated → rotation fail → file stay >50MB → next non-terminal append silently skipped → **events dropped không signal ở bất kỳ step nào**. Remediation phải cover cả chain.
- **⚠️ Reviewer addendum (LOW) — emit-on-skipped**: cả 2 paths gọi `emitFromTeamEvent` **unconditionally** ngoài `!skippedDueToSize` block (:1146 sync, :842 async) → UI bus subscribers nhận events không bao giờ persisted → live-UI vs reconstructed-state divergence. Fix: gate emit trên `!skippedDueToSize`.
- **⚠️ Reviewer fix-design caution**: sync-path callers (cancel.ts:361, status.ts:82/130, task-claims) chạy **trong withRunLockSync** — throw propagates qua run-lock critical section → fail cancel/save. **Prefer log-at-"error" + returned indicator over throwing trên sync path**; reject safe trên async/buffered paths (promise fallbacks exist).
- **Fix**: reject/error trên size-limit skip + severity `"error"` cho `event-log.size-limit` + `event-log.rotate` + check rotation boolean + gate emit trên `!skippedDueToSize`.

### Size-limit sweep (14 paths — còn lại benign/reject)

event-log batch size-limit (:972-978 log+reject), buffer 1000-cap (:1230-1243 reject each — R17-B2 verified), jsonl-writer caps (LOW — **dead module** 0 src importers), transcript caps read-side tail (benign no data loss), run-projection 20/10/15 by design, mailbox rotation+prune (readers walk archives — benign), agentEventSeqCache FIFO 1000, seqCounters FIFO 256, sequenceCache, run-snapshot-cache TTL 1500/24, lastProgressContentHash finally-deleted.

### Race-track re-scan: CLEAN

team-runner (lastProgressContentHash finally :1041, pendingUnits/dispatchedTaskIds run-scoped ctx locals :2418-2443 GC'd per run), cancel.ts (local result arrays bounded), task-claims.ts (no module-level maps — only const Sets RETRYABLE_STATUSES/TRANSIENT_READ_ERRNO_CODES), status.ts (local per-call), crash-recovery.ts (local + manifestCache.list(50) capped), event-log caches capped. **No new unbounded state từ fixes R13-17.**

### Part C — Fix-conflict/lock-ordering: NO deadlock + fix-scope gap MEDIUM

Lock classes: L1 run lock, L2 event-log lock (.mkdirlock/.alock), L3 proposed .seqlock. Mọi fix acquire consistent order **L1→L2→L3** (3.3 cancel : L1→L2 ✓, 3.5 finalizeRun : L1→L2 ✓, 3.6 event-log : L2→L3 ✓, 3.7 seq : L2→L3 ✓). No L3→L2/L2→L1 site. emitFromTeamEvent = run-event-bus pure notification no lock.

**🟠 Fix-scope gap (MEDIUM, design-level)**: `.seqlock` fixes effect 1 (duplicate seq) **ONLY** — KHÔNG close rotation-stranding window (effect 2, appendFileSync-fd-vs-rename race). **Phase 3.6 acceptance "rotation trong khi sync append → không event stranded" KHÔNG được met bởi .seqlock** (nay empirically justified). Minimal correct: (a) archive-tail reads (mailbox pattern) — recommend.

Design cautions: .seqlock phải third namespace pure-sync short critical section (naive merge reintroduce v0.9.26 deadlock); 3.6 option (3) fire-and-forget sau L1 release → change event-vs-state ordering (LOW note); R15-4 throws-not-spins preserve khi implement 3.3.

### Round metrics

| Metric | Count |
|---|---|
| Part A | Rotation stranding CONFIRMED (5.43% max-contention) |
| Part B | R17-S1 **escalated HIGH** (fully silent) + 14-path sweep + race re-scan CLEAN |
| Part C | No deadlock + **fix-scope gap MEDIUM** (.seqlock không fix stranding) |
| Reviewer addenda | 3 LOW (emit-on-skipped, reject-path caution, stale archive-replay comment) |
| Verdict | **CONTINUE → Round 19** (R18 HIGH + MEDIUM — không LOW-only; cần R18+R19 cùng LOW mới stop, R17 HIGH nên R19 LOW alone không đủ) |

### Actionable (cho plan — Phase 3.7 extension)

1. **R17-S1 (HIGH)**: size-limit skip non-silent — severity "error" + returned indicator + **gate emit** + check rotation boolean (cả chain).
2. **Fix-scope gap (MEDIUM)**: thêm archive-tail reads vào event-log readers/reconstructor (mailbox safeReadMailboxFile pattern) — .seqlock alone fail Phase 3.6 acceptance. Fix stale event-log-rotation.ts:344 "snapshot replay" comment (không có snapshot/replay path đọc archives).
3. **Bench mới**: cần durable regression test cho CẢ 2 effects (seq collision + stranding) — script /tmp đã xóa.


---

## ROUND 19 — Config surface + resource definitions audit (iterative-audit)

> **Round**: 19. **Focus**: config surface (schema-vs-parser-vs-usage drift) + builtin resource definitions. **Model**: `deepseek/deepseek-v4-flash`. **Methodology**: team `review` 4/4. **Run**: `team_20260814032511_c365f408259a2c79`.
> **Gate**: verifier `test:critical` 101/101 + tsc clean. Reviewer: **ACCEPT** — all 10 findings verified line-exact, no fabricated findings.

### Executive summary

**10 findings (0 HIGH, 5 MEDIUM, 5 LOW)** + 6 drift items + 6 FP filtered. Core: **schema-vs-parser asymmetry trong config.ts** — 3 config surfaces declared nhưng silently inert (`runtime.modelFallback.*` parser drops; `control.consecutiveFailureThreshold/longRunningMinutes` + `retryPolicy.maxTotalSpawns` read-but-schema-forbidden). Part B: builtin teams/workflows/agents **internally consistent** — mọi team→workflow ref + workflow step→role ref resolve; SEC-001 shadow protection holds (cả 3 resource types). No HIGH (no new sensitive-gap, no broken ref runtime).

### Part A — Config surface findings

| # | file:line | sev | Vấn đề | Fix | Phase note |
|---|---|---|---|---|---|
| **F19-1** | `config.ts` parseRuntimeConfig (~372-430) | **MEDIUM** | `runtime.modelFallback.*` (schema:96, types:89) consumed tại child-executor.ts:157,166 + live-session:290,299 + doctor:243 nhưng **parser không bao giờ emit** → `config.runtime.modelFallback` LUÔN `undefined`. **Documented config inert** — chỉ env PI_CREW_MODEL hoạt động. **Security S19-3**: user set `requireCredentials:true` để constrain subagent routing → **silent unconstrained fallback routing** (có thể tới uncredentialed providers) | Add `modelFallback: parseModelFallbackConfig(obj.modelFallback)` vào parseRuntimeConfig + mergeConfig (nested merge OK) | Phase 5: schema-walk SẼ include (trong schema) nhưng behavior khác — parity fix trong PARSER không phải schema |
| **F19-2** | `config.ts:987` + `team-runner.ts:1683` + `types.ts:212` | **MEDIUM** | `retryPolicy.maxTotalSpawns` parsed+typed+read nhưng `PiTeamsReliabilityConfigSchema.retryPolicy` (addProps:false, :225-235) không declare → spurious additionalProperties warning + **Phase 5 drop-list miss nó** | Add `maxTotalSpawns: Type.Optional(Type.Integer({minimum:0}))` schema | Phase 5: schema-walk phải derive TỪ PARSER không phải reverse |
| **F19-3** | `agent-control.ts:37-38` | **MEDIUM** | `control.consecutiveFailureThreshold`/`longRunningMinutes` read nhưng schema (:121-128) chỉ có enabled+needsAttentionAfterMs + parser (:436-444) drops → **2 knobs inert** (luôn DEFAULT 3/10); user settings emit warnings + silently discarded | Add schema+parser hoặc delete dead reads | Phase 2.2: control.* split candidate |
| **F19-4** | `sanitizeProjectConfig` (~490-560) | **MEDIUM** | **Merge-precedence gaps**: project config vẫn set được execution-control fields: `runtime.completionMutationGuard:"off"` (post-execution:179, default "warn"), `runtime.effectivenessGuard:"off"` (effectiveness.ts:51-54), `reliability.scopeModels:false`/`autoRecover:false`, `limits.maxConcurrentWorkers` ≤1024 + `allowUnboundedConcurrency:true`, `goalWrap.*.verification.commands` | **Security S19-1**: KHÁC R4 S-R5 (policy.* latent default false) — các guards này **ACTIVE by default ("warn")** → project setting **take effect ngay** cho mọi contributor chưa pin field trong user config → **silent loss of guardrails** + resource raise trên mọi clone. **Security S19-2 CORRECTION**: goalWrap.verification.commands KHÔNG arbitrary shell — hard-allowlisted (verification-gates.ts:160-205 blocks metachars, chỉ npm/pnpm test\|run) → không thêm code-execution capability; new surface = **silent auto-wrap + unbounded provider spend** (goalWrap.enabled:true auto-routes builtin workflow vào goal loop, evaluatorModel + budgetUnlimited:true) | Move guard/enforcement fields user-only tier HOẶC "project may only tighten" (drop `"off"`/`false` values, mirror requirePlanApproval===false pattern config.ts:520); goalWrap.* user-only hoặc per-run confirm | Phase 2.2 config split |
| F19-5 | config.ts:1058/1023/1017 | LOW | Parser/schema bound mismatches: otlp.endpoint parser minLength:1 vs schema ^https?://; metricRetentionDays 365 vs 90; dedupWindowMs min 1 vs 1000 | Align parser bounds schema | — |
| F19-6 | defaults.ts:54-63 | LOW | `DEFAULT_CONCURRENCY.workflow` (research 3, impl 4...) vs builtin team maxConcurrency (2/3...) — **2 sources of truth**; resolveBatchConcurrency prefers team → defaults dead cho builtin teams | Reconcile hoặc delete 1 source | — |
| F19-7 | sanitizeProjectConfig | LOW | `broker.*` project-settable (broker.enabled:false repo-wide; env PI_CREW_BROKER vẫn override) — availability-only | Note cho Phase 2.2 tiering | — |
| **S19-5** (security NEW) | config.ts:609 | LOW | sanitize drops `autonomous.{profile,enabled,injectPolicy}` nhưng **giữ `magicKeywords`**; effectiveAutonomousConfig defaults profile "suggested" khi chỉ magicKeywords present → repo set chỉ magicKeywords **flips autonomous mode ON default** cho users chưa enable | Drop magicKeywords project tier hoặc explicit enabled default | Phase 2.2 |

**Sensitive-field coverage**: NO new gap — mọi credential/trust fields đã project-dropped. Gap là *completeness của walk* (F19-2/3) + *guard-tiering* (F19-4/S19-1/2), không phải credential exposure.

### Part B — Resource definitions (all CLEAN)

6 teams × defaultWorkflow đều tồn tại + role lists match; 10 workflows step→role refs resolve + acyclic (distill 17 steps trong implementation team); 11 agents đều có file, no skills refs (inheritSkills:false), model:false → global fallback chain. **Shadowing SEC-001 holds**: agents `[...project, ...projectPi, ...builtin, ...user]` (discover-agents.ts:680), teams :198, workflows :304 — project KHÔNG shadow builtin.

**F19-8 (LOW)**: `cold-verifier` defined nhưng no builtin team/workflow references (intentional, CLI/custom use) — doc note.
**F19-9 (LOW)**: distill.workflow.md nói "run with team='implementation'" nhưng không enforce — chạy với default team (no analyst/critic) fail tại validateWorkflowForTeam với error khó hiểu. Suggest preflight hint.
**F19-10 (LOW)**: defaults.ts 2-sources (F19-6).

### FPs filtered (6)

magicKeywords (schema+parse+read OK), needsAttentionAfterMs (OK), seedPaths (C6 fix landed), heartbeatStaleMs (UI max vs runtime default khác concept), shadowing (protected), env aliases (documented legacy).

### Round metrics

| Metric | Count |
|---|---|
| Findings | **10** (5 MEDIUM, 5 LOW) + 6 drift items |
| HIGH | 0 |
| FP filtered | 6 |
| Verdict | **CONTINUE → Round 20** (R19 5 MEDIUM — không LOW-only; R18 HIGH nên cần R19+R20 cùng LOW mới stop) |

### Actionable (cho plan)

1. **F19-1 (MEDIUM)**: modelFallback parser fix — config-driven trust controls (requireCredentials) hiện inert = silent unconstrained routing.
2. **F19-4/S19-1 (MEDIUM)**: guard-tiering — completionMutationGuard/effectivenessGuard/scopeModels/autoRecover/limits.* user-only hoặc project-tighten-only.
3. **S19-2 (MEDIUM)**: goalWrap.* user-only hoặc per-run confirm (silent auto-wrap + unbounded spend).
4. **F19-2/3 (MEDIUM)**: schema add (maxTotalSpawns, control.*) — Phase 5 walk completeness.
5. **S19-5 (LOW)**: magicKeywords partial-config default-flip edge.
6. **Phase 5 premise update**: schema-walk drop-list phải derive TỪ PARSER surface (F19-1/2 chứng minh schema ≠ parse ≠ read).

