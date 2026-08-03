# pi-crew v0.9.51 — Báo cáo đánh giá toàn diện

**Ngày:** 2026-07-27
**Phương pháp:** 6 luồng review song song (quality gates, runtime, state/durability, security, UI, extension/DX)
**Quy mô:** ~108K LOC src, 478 file TS, 710 file test, 54 action trong tool `team`

---

## Tổng quan sức khỏe

| Gate | Kết quả | Ghi chú |
|------|---------|---------|
| Typecheck | PASS | 0 errors, TS 7.0.2, 6s |
| Lint | PASS nhưng mù | 29 warning bị ẩn bởi `--diagnostic-level=error`, 18 rule tắt |
| Tests | FAIL (1 flaky) | 6304/6308 pass, `subagent-tools-integration:916` flaky dưới concurrency |
| Security | 1 Critical + 2 High | Project DWF RCE, preStepScript RCE, PEM ReDoS |
| State | Critical | atomic-write broken trên POSIX, multi-process append không lock |
| Packaging | Warning | double-load source+bundle, tarball 15.7MB |
| Peer deps | Stale | `@earendil-works/*` 0.77 vs published 0.82.1 (5 minor) |

---

## P0 — Critical: nên sửa ngay (12 mục, ~7-10 ngày)

### Security

#### F-01: Project `.dwf.ts` = RCE từ hostile repo
- **File:** `src/runtime/dynamic-workflow-runner.ts:88-137`
- **Vấn đề:** `*.dwf.ts` từ project dir được load qua jiti và chạy như Node code đầy đủ. Clone hostile repo -> arbitrary code execution. Comment tại `:10-18` thừa nhận "NOT a sandbox".
- **Attacker:** Hostile repo / repo contributor. LLM chọn workflow name từ discovery list, prompt injection trong repo content là đủ.
- **Fix:** Default-deny project workflows, require explicit per-file user trust (SHA-256 allowlist hoặc `PI_CREW_TRUST_PROJECT_DWF=1`). Emit interactive confirmation trên first use.
- **Effort:** M

#### F-02: `preStepScript` từ project config = RCE
- **File:** `src/runtime/task-runner.ts:253-278`
- **Vấn đề:** `execFileSync(preStepScript)` từ project workflow config. Containment to `cwd` không phải boundary vì script nằm trong `cwd`.
- **Fix:** Strip `preStepScript` khi `workflow.source === "project"` (giống `worktree.setupHook` đã strip ở `config.ts:307-311`).
- **Effort:** S

#### F-05: PEM redaction regex ReDoS
- **File:** `src/utils/redaction.ts:7`
- **Vấn đề:** Regex `[\s\S]+?` không có bound -> O(k*n). Benchmark: 252KB markers = 671ms block event loop. Chạy trên mọi artifact write + event append.
- **Fix:** Restore `[\s\S]{0,65536}?` + length short-circuit. Thêm regression test với 1MB markers.
- **Effort:** S

### State / Durability

#### D-01: atomic-write dùng unlink+link thay vì rename
- **File:** `src/state/atomic-write.ts:355-366`
- **Vấn đề:** POSIX path dùng `unlinkSync(filePath)` rồi `linkSync(temp,filePath)` -> cửa sổ ENOENT + "file exists in neither state" crash window. POSIX `rename(2)` không follow symlink đích.
- **Fix:** Đổi `unlink+link` thành `fs.renameSync(temp,dest)`. Giữ pre-rename `isSymlinkSafeDirCached` guard.
- **Effort:** S

#### R-01: crash-recovery xóa toàn bộ run khi manifest parse fail
- **File:** `src/runtime/crash-recovery.ts` (purge step 3)
- **Vấn đề:** Một byte unparseable trong `manifest.json` -> `tryRemoveRunDirectories` xóa toàn bộ `stateRoot` incl. `events.jsonl`.
- **Fix:** Quarantine (`manifest.json.corrupt-<ts>`), mark run `failed`, chỉ unregister. Require 2 independent signals (missing file + missing cwd) trước khi `rmSync`.
- **Effort:** S

#### C-01: `appendEventAsync` không có cross-process lock
- **File:** `src/state/event-log.ts:473`
- **Vấn đề:** Serialize chỉ qua in-process `asyncQueues` map. Sequence numbers từ process-local `seqCounters`. 2 process append concurrently -> torn JSONL + duplicate seq.
- **Fix:** Take mkdir lock (hoặc `flock`) inside `appendEventAsync`, allocate seq under lock.
- **Effort:** M

#### C-02: mailbox lock mechanism collision
- **File:** `src/state/event-log.ts:88` (mkdir lock) vs `src/state/locks.ts:382` (file lock)
- **Vấn đề:** Hai mechanism collision trên cùng path `${file}.lock`. Stale reclaim `fs.rmSync(lockDir,{recursive:true})` có thể delete lock file của mechanism kia.
- **Fix:** Dùng distinct suffixes (`.mkdirlock/` vs `.flock`) hoặc convert tất cả mailbox caller sang 1 primitive.
- **Effort:** S

### Runtime

#### CORE-1: pendingUnits bị bỏ rơi trên early return
- **File:** `src/runtime/team-runner.ts:1012` (loop) + 8 early-return points: `:1049, :1093, :1236, :1242, :1735, :1810, :1819, :1835`
- **Vấn đề:** Early return không drain/abort `pendingUnits` -> zombie children + lost results.
- **Fix:** Add run-scoped `AbortController` child-linked to `input.signal`. Mỗi early return: `controller.abort(); await Promise.allSettled([...pendingUnits.values()])`. Extract as `drainPendingUnits(pendingUnits, controller)`.
- **Effort:** M

#### CORE-2: global worker cap không áp dụng trên main spawn path
- **File:** `src/runtime/global-worker-cap.ts:20-22`
- **Vấn đề:** `withWorkerSlot` chỉ dùng ở `dynamic-workflow-context.ts:395` và `goal-loop-runner.ts:660`. Main path `task-runner.ts:523` và `run-coalesced-task-group.ts:141` spawn uncapped -> fork storm.
- **Fix:** Wrap `runChildPi` trong `withWorkerSlot` ở `task-runner.ts` + `run-coalesced-task-group.ts`.
- **Effort:** S

### API / Packaging / Config

#### VAL-1: Không có runtime validation trước dispatch
- **File:** `src/extension/registration/team-tool.ts:146`
- **Vấn đề:** `params as TeamToolParamsValue` cast không validate. Schema cast `as never` tại `:144`.
- **Fix:** Add `Value.Check(TeamToolParams, params)` + `Value.Errors` reporting trước dispatch.
- **Effort:** M

#### PKG-1: index.ts double-load source + bundle
- **File:** `index.ts:35-36` (static import) + `:50-54` (dynamic import)
- **Vấn đề:** Khi bundle present (default), cả source tree và bundle đều load -> double module evaluation, double caches, wasted work.
- **Fix:** Make static imports lazy/dynamic, chỉ load 1 path.
- **Effort:** M

#### CFG-1: schema.json thiếu 3 key, `additionalProperties: false`
- **File:** `schema.json` vs `src/schema/config-schema.ts`
- **Vấn đề:** Missing `ignoreMethod`, `goalWrap`, `broker`. Config chứa các key này sẽ fail validation against schema.json.
- **Fix:** Add 3 key vào schema.json. Add test asserting schema.json keys == TypeBox keys.
- **Effort:** S

---

## P1 — High: sprint tiếp theo (20 mục, ~15-20 ngày)

### Runtime

| ID | Vấn đề | File:line | Fix | Effort |
|----|--------|-----------|-----|--------|
| CORE-3 | retry x model-fallback = (maxRetries+1) x 3 x candidates spawn uncapped | `retry-executor.ts:44-46`, `task-runner.ts:459` | Per-task spawn budget, `retryableErrors` non-empty default | M |
| CORE-4 | God module `team-runner.ts` 1993 LOC, `executeTeamRunCore` 1063 dòng | `team-runner.ts:931-1993` | Tách thành `scheduler/` module | L |
| CORE-5 | God module `task-runner.ts` 1420 LOC, `runTeamTask` 1192 dòng | `task-runner.ts:145-1337` | Tách theo runtime branch | L |
| CORE-6 | 12 site hand-roll "cancel non-terminal" thay vì dùng `contracts.ts` | `team-runner.ts:1022,1523,1791` + 9 site khác | `cancelNonTerminalTasks()` thống nhất | M |
| CORE-8 | 3 timeout policy inconsistent; foreground run không abort khi wait timeout | `run.ts:649,963,1011` | `resolveRunDeadline()` + abort controller chung | S |
| CORE-13 | 4 bản duplicate worker-spawn logic | `task-runner.ts:523`, `run-coalesced-task-group.ts:141`, `dynamic-workflow-context.ts:395`, `goal-evaluator.ts:199` | Extract `runWorker()` | M |
| CORE-17 | 271 catch block trong `src/runtime/`, 16 empty `catch {}` | Multiple | Route qua `logInternalError`, lint rule ban bare `catch {}` | M |
| CORE-7 | `background-runner.ts:148-156` comment sai, `process.exit(130)` skip finally -> stale orphan registry | `background-runner.ts:157` | Replace `process.exit` với `abortController.abort()` + let finally run | S |
| CORE-10 | Verification gates spawn `sh -c` không detached, SIGKILL chỉ kill `sh` | `verification-gates.ts:254,273` | Spawn detached, kill process group | S |
| CORE-11 | Live-session `promptWithTimeout` abandon promise không cancel | `live-session-runtime.ts:471-490` | Pass AbortSignal vào `session.prompt` | S |

### State

| ID | Vấn đề | File:line | Fix | Effort |
|----|--------|-----------|-----|--------|
| A-01 | Async atomic-write thiếu dir fsync | `atomic-write.ts:661-710` | Add `open(dir,"r") -> fsync -> close` sau rename | S |
| A-02 | `atomicWriteFile` không `closeSync(fd)` trên error -> fd leak | `atomic-write.ts:571,648-657` | Wrap `try/finally { closeSync(fd) }` | S |
| R-03 | Event-log rotation: reader giữ pre-rotation offset -> mất event | `event-log-rotation.ts:222-223` | Add generation/inode id vào cursor | M |
| P-01 | Compaction full-read 50MB while holding event-log lock | `event-log-rotation.ts:103,136` | Tail-based compaction | M |
| P-02 | `decision-ledger.ts` O(n^2) I/O, không size cap | `decision-ledger.ts:115-137` | Append-only + bounded tail | S |
| S-01 | `schemaVersion` là literal `1`, không check trên read, no migration | `types.ts:180`, `state-store.ts:269` | Validate trên load, refuse > CURRENT | M |
| C-03 | Mailbox sync vs async không mutual exclusion | `mailbox.ts:562,677` | Route cả 2 qua cùng cross-process lock | S |

### Security

| ID | Vấn đề | File:line | Fix | Effort |
|----|--------|-----------|-----|--------|
| F-06 | Broker per-run shared token; no peer credential check; any worker can steer siblings | `crew-broker-tokens.ts:36-52`, `crew-broker.ts:243-252` | Per-task token + SO_PEERCRED + orchestrator-only steer | M |
| F-09 | `PI_CREW_BROKER_TOKEN` lọt qua `PI_CREW_*` glob allowlist vào hook scripts | `env-filter.ts:100-102`, `iteration-hooks.ts:167` | Explicit deny-set cho `*_TOKEN` | S |
| F-04 | `socket-path.ts:53-88` chmod `/tmp` -> 0700, strip sticky bit (root context) | `socket-path.ts:75-88` | Per-user 0700 subdir | S |
| F-08 | `resolveContainedPath()` return non-canonical path, callers follow symlinks | `safe-paths.ts:13-30` | Return `resolvedNorm` | S |

### UI

| ID | Vấn đề | File:line | Fix | Effort |
|----|--------|-----------|-----|--------|
| F-26 | `refreshIfStale` 10+ sync fs read trên render path | `run-snapshot-cache.ts:987-1001` | 50ms stamp-check TTL + async rebuild | M |
| F-9 | 3 overlay dùng raw `\u001b[A` thay vì `keyOf()` | `agent-picker-overlay.ts:52,56`, `mailbox-detail-overlay.ts:124,128`, `crew-select-list.ts:58,62` | Đổi sang `keyOf(data) === "up"` | S |
| F-1 | SIGWINCH listener leak, không remove trong `dispose()` | `widget/index.ts:100-102,219` | Store ref, `process.off()` trong dispose | S |
| F-2 | TEMP DIAGNOSTIC `process.stderr.write` trên mỗi dashboard open | `run-dashboard.ts:437-439` | Gate behind `PI_CREW_BROKER_DIAG_UI` | S |
| F-21 | `tool-render.ts` 454 LOC @deprecated vẫn trong build | `tool-render.ts:2` | Extract 3 utility function, delete file | S |

### API / Config / CI / Deps

| ID | Vấn đề | File:line | Fix | Effort |
|----|--------|-----------|-----|--------|
| API-5 | 54-action mega-tool, 20 undocumented, 2 zero-test, freeform config | `team-tool.ts:664` | Tách thành 5 domain tool | L |
| API-1 | 20 action thiếu doc trong actions-reference.md | `docs/actions-reference.md:9-47` | Add missing action sections | S |
| API-2 | 3 action thiếu trong TS interface `TeamToolParamsValue` | `team-tool-schema.ts:226-280` | Add `anchor`, `auto-summarize`, `auto_boomerang` | S |
| API-4 | `checkpoint`, `orchestrate` có 0 test | grep test/ | Add unit tests | M |
| CFG-2 | Không có schema.json <-> TypeBox sync test | `config-schema-sync.test.ts:21-41` | Add test | S |
| CFG-3 | CLAUDE.md sai về config precedence (project wins) | root `CLAUDE.md` vs `config.ts:1178-1181` | Fix doc: `builtin < project < user` | S |
| CFG-5 | 7/10 config key undocumented trong README | spot-check | Add config reference table | M |
| ERR-1 | Không có error code taxonomy | `tool-result.ts:8` | Add `errorCode` + stable codes | M |
| CI-1 | Lint mù: `--diagnostic-level=error` + 18 rule tắt | `package.json:31`, `biome.json:11-35` | Re-enable rules, remove diagnostic filter | M |
| CI-2 | 1 flaky test làm CI đỏ | `subagent-tools-integration.test.ts:916` | Fix or quarantine | M |
| CI-4 | Không có bundle size budget | `dist/index.mjs` 2.7MB | Add size check | S |
| CI-5 | Không có tarball install+load smoke test | ci.yml | Add pack + install + load test | M |
| DOC-1 | README sai về bundle default | `README.md:661` vs `index.ts:29-32` | Fix | S |
| DOC-3 | Root CLAUDE.md sai về config precedence | root `CLAUDE.md` | Fix | S |
| PKG-2 | 478 src + bundle cùng ship | `package.json:19,23` | Ship chỉ `dist/` | S |
| PKG-3 | 6MB sourcemap trong tarball | `dist/index.mjs.map` | Exclude from `files` | S |
| PKG-5 | 132 docs file incl stale reports ship trong tarball | `npm pack` output | Whitelist ~10 reference docs | S |
| DEP | peer `@earendil-works/*` 0.77 vs 0.82.1 (5 minor stale) | `package.json` peerDeps | Bump range + test against 0.82.x | M |

---

## P2 — Medium: milestone tiếp theo (15 mục chọn lọc)

| ID | Vấn đề | Fix |
|----|--------|-----|
| CORE-19 | Dead code: `mapWithFailFast`, `setsid` no-op, coalesce path unreachable, `writeProgress` cache never hit | Delete hoặc wire + test |
| CORE-20 | `lastProgressContentHash` luôn false do timestamp trong content | Remove cache hoặc key trên runId |
| CORE-21 | `killProcessTree` log full stack trace mỗi lần kill | Gate behind `PI_CREW_DEBUG_KILL` |
| CORE-25 | background-runner 250ms sync fs poll (`existsSync`+`readFileSync`+`JSON.parse`) | Replace với `fs.watch` |
| CORE-15 | 6 reaper subsystem overlap | Consolidate vào `liveness/` module |
| F-8 | Mascot interval tick ngay cả khi hidden | Pause interval trong `setVisible(false)` |
| F-24 | crew-vibes capacity/provider timer chạy liên tục cả khi idle | Gate trên run activity |
| PKG-6 | `test-integration-check.ts` trong production tarball | Remove `*.ts` from `files` |
| PKG-8 | `bin` trỏ vào `install.mjs` không phải CLI | Remove `bin` hoặc tạo real CLI |
| PKG-10 | Root-level planning/audit md files pollute repo | Move to `.archive/` |
| DOC-5 | ~80 stale docs ship trong tarball | Whitelist 10-15 reference docs |
| DOC-2 | CLAUDE.md says 28 actions, actual 54 | Update |
| 290 stale `.js` companion trong src/ | Add `rimraf 'src/**/*.js'` to pretest |
| 11 dead `eslint-disable` directives (no eslint installed) | Remove |
| `biome.json` `$schema` pins 2.4.15 vs installed 2.5.3 | Update |

---

## Top 5 refactor cao leverage nhất

### 1. `runWorker()` thống nhất (fix CORE-2 + CORE-3 + CORE-13)
Một function owning `withWorkerSlot` + per-task spawn budget + `runChildPi` + `parsePiJsonOutput` + usage accounting + terminal evidence. 4 call site migrate: `task-runner.ts:523`, `run-coalesced-task-group.ts:141`, `dynamic-workflow-context.ts:395`, `goal-evaluator.ts:199`.

### 2. `state/contracts.ts` làm nguồn duy nhất (fix CORE-6)
Reimplement `shouldMergeTaskUpdate` (`team-runner.ts:253-330`) trên `canTransitionTaskStatus` + extract `cancelNonTerminalTasks(tasks, reason, opts)` thay 12 bản hand-roll.

### 3. `buildExecuteTeamRunInput()` + `resolveRunDeadline()` (fix CORE-8 + CORE-14)
4 site construction drift -> 1 helper. 3 timeout policy -> 1. Inline path gets controller registration.

### 4. Tách `executeTeamRunCore` thành `scheduler/` (fix CORE-1 + CORE-4)
8 function riêng biệt, testable độc lập:
- `cancelRunFromSignal()` ← `:1013-1049`
- `handleFailedTask()` ← `:1051-1093`
- `selectDispatchBatch()` ← `:1096-1256`
- `dispatchUnit()` ← `:1338-1558`
- `drainPendingUnits()` ← new
- `mergeUnitResult()` ← `:1594-1643`
- `advanceWorkflowPhases()` ← `:1645-1698`
- `enforceRunBudget()` ← `:1700-1778`
- `finalizeRun()` ← `:1838-1993`

### 5. One cross-process append lock (fix C-01 + C-02 + C-03 + P-05)
Một primitive `withAppendLock(path, fn)` cho event-log + mailbox, kết hợp với seq allocation crash-safe dưới lock.

---

## Đề xuất roadmap

| Giai đoạn | Thời gian | Nội dung |
|-----------|-----------|----------|
| **Sprint 1** | 1 tuần | 6 P0 security + state (F-01/02/05, D-01, R-01, C-01/02) |
| **Sprint 2** | 1 tuần | 6 P0 runtime + API (CORE-1/2, VAL-1, PKG-1, CFG-1) |
| **Sprint 3** | 2 tuần | P1 runtime refactor (runWorker, contracts, scheduler split) |
| **Sprint 4** | 1 tuần | P1 state durability (fsync, rotation, schema version) + security hardening (broker) |
| **Sprint 5** | 1 tuần | P1 UI (sync I/O, keyOf) + CI (lint, flaky, coverage, size) + dep bump |
| **Sprint 6** | 1 tuần | P2 cleanup (dead code, packaging slim, docs fix) |

**Tổng effort:** ~7-8 tuần cho 1 người, hoặc 3-4 tuần nếu 2-3 người song song.

---

## Đếm số findings theo khu vực

| Khu vực | P0 | P1 | P2 | Tổng |
|---------|----|----|----|----|
| Security | 3 | 4 | 2 | 9 |
| Runtime | 2 | 11 | 5 | 18 |
| State/Durability | 4 | 7 | 0 | 11 |
| UI | 0 | 5 | 3 | 8 |
| API/Config/DX | 3 | 8 | 4 | 15 |
| Quality Gates/CI | 0 | 4 | 1 | 5 |
| **Tổng** | **12** | **39** | **15** | **66** |

---

## Chi tiết kỹ thuật bổ sung

### Tech debt inventory (src/)

| Marker | Count |
|--------|-------|
| `TODO` | 2 |
| `FIXME` | 0 |
| `@deprecated` | 5 |
| `as any` | 1 (real) |
| `: any` annotations | 7 |
| `eslint-disable` (dead, no eslint) | 11 |
| Empty `catch {}` | 16 |
| `@ts-expect-error` / `@ts-ignore` | 0 |

### Lint rules tắt trong biome.json (18)

`noNonNullAssertion`, `useTemplate`, `noUselessSwitchCase`, `noUselessTernary`, `noUselessEscapeInRegex`, `noUnusedFunctionParameters`, `noUnusedVariables`, `noVoidTypeReturn`, `noUnsafeFinally`, `noExplicitAny`, `noImplicitAnyLet`, `noConfusingVoidType`, `useIterableCallbackReturn`, `noControlCharactersInRegex`, `noAssignInExpressions`, `noNonNullAssertedOptionalChain`, `noShadowRestrictedNames`, `noDuplicateElseIf`

### Test skip inventory

| Pattern | Count |
|---------|-------|
| Hard skip | 0 |
| Conditional skip | 20 |
| `.skip` unconditional | 2 (dead tests) |
| Platform-conditional | 8 files |
| `process.platform` references | 44 |

### Timers inventory (UI)

| Timer | File | Interval | Unref'd | Stopped on idle? |
|-------|------|----------|---------|-----------------|
| RenderScheduler fallback | `render-scheduler.ts:89` | 750ms | Yes | Yes (R1 idle-stop) |
| RenderScheduler debounce | `render-scheduler.ts:165` | 75ms | Yes | Yes |
| Theme poll fallback | `theme-adapter.ts:291` | 1000ms | Yes | Yes (last unsub) |
| Mascot tick | `mascot.ts:122` | 180ms | Yes | No (keeps ticking when hidden) |
| Live-conversation poll | `live-conversation-overlay.ts:59` | 200ms | Yes | No (while open) |
| Crew-vibes capacity | `crew-vibes/index.ts:201` | 250ms+ | Yes | No (session lifetime) |
| Crew-vibes provider | `crew-vibes/index.ts:230` | 10000ms | Yes | No (session lifetime) |

Worst case: ~14-16 active timers (all unref'd).

### Tarball analysis

- 775 entries, 4.09 MB compressed, 15.7 MB unpacked
- Top entries: `dist/index.mjs.map` (6MB), `dist/index.mjs` (2.7MB), `CHANGELOG.md` (488KB), `dist/build-meta.json` (457KB)

### Proposed `team` tool API shape

Thay 54-action mega-tool bằng 5 domain tool:

```
team.run     -> run, plan, orchestrate, parallel, resume, retry, goal, chain
team.status  -> status, wait, list, get, search, events, artifacts, worktrees,
                graph, summary, explain, cache, checkpoint, health, onboard
team.control -> cancel, steer, respond, invalidate, prune, forget, cleanup,
                export, import, imports
team.manage  -> create, update, delete, init, validate, doctor, config,
                autonomy, settings, workflow-create/get/list/save/delete
team.automate-> schedule, scheduled, anchor, auto-summarize, api, recommend, help
```

Mỗi tool: discriminated union trên `subAction`, `Value.Check()` validation, stable error codes, ~50-word description.

### Missing test scenarios (state layer)

1. Multi-process append (2+ processes, 1000 events each, assert unique seq)
2. Concurrent-reader atomicity (reader loop during 10K writes)
3. Lock-mechanism collision (mkdir vs file lock on same path)
4. Corrupt manifest must not delete state
5. Rotation with live cursor
6. Truncated last line recovery
7. SIGKILL inside coalesce window
8. Archive growth bound
9. Schema-version rejection
10. fd-leak regression
11. Coalescer permanent-failure path
12. Orphaned claim recovery
