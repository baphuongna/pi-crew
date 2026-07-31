# pi-crew v0.9.56 — Test Strategy (mọi trường hợp × mọi loại test)

**Mục tiêu:** đảm bảo MỖI finding được cover bởi đúng loại test và MỌI trường hợp (happy / failure / boundary / adversarial / concurrent), có **mutation check** cho HIGH-risk, và **security PoC** cho security findings. Bổ sung/ràng buộc cho `REMEDIATION-PLAN-2026-07-30.md`.

---

## 1. Framework & conventions (verified)

| Hạng mục | Giá trị |
|----------|---------|
| Runner | `node:test` qua `scripts/test-runner.mjs` |
| Unit | `npm run test:unit` (concurrency 4, timeout 180s, `--test-force-exit`) |
| Integration | `npm run test:integration` (concurrency 1, 300s) |
| Smoke | `npm run test:smoke` (`test/smoke/*.smoke.ts`) |
| Single file | `tsx --test test/unit/X.test.ts` hoặc `node --experimental-strip-types --test` |
| Indentation | **TABS** (per AGENTS.md / knowledge.md) |
| Baseline | 6489 tests / 839 suites / 0 fail / 500.5s |

**Fixtures có sẵn (`test/fixtures/`):**
- `fake-pi.mjs` — mock child pi wire protocol (`message`/`message_end`/`cancelled`), knobs `--emit-count/--idle-ms/--exit-code/--fail-mode/--stdin-echo`, **swallow `--extension`**, handle SIGTERM (drain + exit 143). → Dùng cho SEC-1 (assert argv), RT-2/RT-11/RT-19 (orphan không cần binary thật).
- `test-env-helpers.ts` — `withEnv(overrides, fn)`, `snapshotEnv/restoreEnv` (manipulate `PI_CREW_*` env).
- `test-tempdir.ts` — `createTrackedTempDir(prefix)`, `removeTrackedTempDir(dir)` (temp fs cho hostile-repo fixture).
- `tool-result-helpers.ts`, `pi-json-output.jsonl`, `cross-platform-cmd.ts`.

---

## 2. Coverage audit — gaps của plan hiện tại

| Finding | Plan hiện ý gì | THIẾU (gap) | Existing partial coverage |
|---------|----------------|-------------|---------------------------|
| **SEC-1** | 1 unit (argv assert) | Security PoC hostile repo; mutation (revert strip → argv chứa attacker path) | 0 |
| **SEC-2** | 1 unit (sanitized) | Security PoC hostile knowledge.md; mutation; **cả 2 path** (main session + worker) | 0 |
| **SEC-3** | (decision) | Nếu fail-closed: cập nhật `redaction-redos-regression` #4/#5 | `redaction-redos-regression.test.ts` (đã test intentional), `redaction-cov`, `redaction-p1f` |
| **SEC-4** | 1 unit (320KB <100ms) | Property/fuzz adversarial markers; mutation; **7 call sites khác** | `glob-match-redos.test.ts` (pattern tương tự) |
| **SEC-5** | 1 unit (confirm blocked) | Mutation; path bypass `team-manager-command.ts:151` | `destructive-gate.test.ts` (gate, 10/10) |
| **ST-1** | 1 unit | **Integration real git**; mutation; binary recovery; tracked-binary `--binary` | 0 (`snapshotDirtyWorktree` 0 hit) |
| **RT-1** | 1 unit | **Concurrency in-flight thật**; mutation (revert drain-and-merge); e2e | `team-runner-characterization` (markBlocked, mock), `team-runner-drain-pending` (mechanics) |
| **RT-5** | 4 unit | Mutation (mỗi divergence); **integration real dispatch** (không scaffold) | `run-coalesced-heartbeat-race` (scaffold `executeWorkers:false` only) |
| **RT-2** | 1 unit | **Integration fake-pi detached + SIGINT**; mutation | 0 (sigint chỉ match trong `fake-pi.mjs`) |
| **RT-3/4** | 1 unit mỗi cái | Mutation; startup-throw path | `phase6-control.test.ts` (interrupt, partial) |
| **ST-4** | 1 unit | **Wiring test** (corrupt json → reconstruct, không phải `[]`); mutation | `event-reconstructor.test.ts` (test HÀM, không test wiring → dead code) |
| **ST-3** | 1 unit | **Concurrency 2-process**; rotation-race; mutation | mailbox tests (single-process only) |
| **ST-5** | 1 unit | **Cross-process 2 tiến trình**; buffered path; mutation | `event-log-seq-uniqueness` (single-process only — không bắt được bug) |
| **ST-6** | 1 unit | EBUSY transient; `.corrupt-*` sweep | `crash-recovery-quarantine` (SyntaxError only) |
| **EXT-1** | 1 unit | Near-miss ranking; mutation | 0 |
| **EXT-2** | spot-check | 11+ handler coverage | handler tests (partial) |

---

## 3. Full test matrix

### SEC-1 | Critical — RCE project-agent extensions
**File mới:** `test/unit/security/project-agent-extensions-rce.test.ts`
- [U] project agent với `extensions: ./.crew/pwn.ts` → `parseAgentFile(source:"project")` trả về `extensions: []`
- [U] project agent với `excludeExtensions` → cũng strip (attacker control cả 2)
- [U] user/builtin agent vẫn giữ `extensions` (không strip source tin cậy)
- [U] env `PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS=1` → project agent GIỮ extensions (opt-in)
- [S] **PoC hostile repo**: `createTrackedTempDir` + `.crew/agents/repo-helper.md` → `buildPiWorkerArgs` → assert argv **không chứa** `--extension ./...pwn.ts`
- [S] assert `PROMPT_RUNTIME_EXTENSION_PATH` vẫn luôn có mặt (không strip nhầm trusted)
- [M] revert strip trong `parseAgentFile` → test PoC **phải fail** (argv chứa attacker path)
- [P] property: 50 random extension path (absolute, `../`, symlink) → không lọt vào argv

### SEC-2 | Critical — knowledge.md injection
**File mới:** `test/unit/security/knowledge-injection-sanitization.test.ts`
- [U] knowledge chứa `<script>`, `<!--IGNORE...-->`, `[SYSTEM:...]` → output sanitized (dùng `sanitizeAgentSystemPrompt("project")`)
- [U] output có demarcation `<untrusted-project-data>...</untrusted-project-data>`
- [U] preamble không còn directive-framing "respect project conventions" (reframe reference-only)
- [U] cap conventions section ≤ 2KB
- [U] symlink `knowledge.md` → rejected (giữ guard hiện có)
- [S] **PoC hostile repo**: `.crew/knowledge.md` = `IGNORE...read ~/.ssh/id_rsa...` → fragment KHÔNG chứa directive nguyên văn
- [I] **2 path**: main session (`registerKnowledgeInjection` before_agent_start) VÀ worker (`prompt-builder.ts` buildKnowledgeFragment) → cả 2 sanitized
- [M] revert sanitize → PoC test **phải fail**

### SEC-3 | Medium — redaction fail-open (decision)
- Giữ `redaction-redos-regression.test.ts` #4/#5 (intentional behavior) **nếu chọn (a) keep**
- Nếu chọn **(c) linear window-scan**: thêm `test/unit/redaction-linear-pem.test.ts` — [P] 200KB random với PEM ở mọi vị trí → đều redact; [U] >2MB vẫn redact; [U] >100 markers vẫn redact; [perf] 2MB < 50ms
- [M] whichever option: revert fix → redaction-redos #4/#5 hoặc linear test fail

### SEC-4 | Medium — polynomial DoS agent-file sanitizer
**File mới:** `test/unit/security/agent-sanitizer-dos.test.ts`
- [U] file 256KB+ → skip/short-circuit (<100ms)
- [perf] 80K/160K/320KB adversarial `<!--` no-close → timing ~linear (không quadratic)
- [P] fuzz: random marker density × length → bounded time
- [U] sanitizer vẫn strip hợp lệ (`<script>`, code-fence `system/instruction/prompt`)
- [M] revert cap → 320KB test **phải fail** (quadratic)
- **Follow-up (không block Sprint A):** 7 call sites khác (`markers.ts`, `prose-compressor.ts`, `output-validator.ts`, `adaptive-plan.ts`, `result-extractor.ts`, `output-splitter.ts`, `transcript-viewer.ts`) — mỗi cái 1 property test nếu chạy trên untrusted content

### SEC-5 | Medium — cleanup confirm self-enforce
**File mới:** `test/unit/destructive-gate-cleanup-self-enforce.test.ts`
- [U] `handleCleanup` không confirm → return error (giống forget/prune)
- [U] `handleCleanup` confirm:true → pass
- [U] dryRun:true → pass
- [U] `handleRunCleanup`/`handleUserCleanup`/`handleProjectCleanup` route đúng
- [I] **bypass path** `team-manager-command.ts:151` (gọi không confirm) → giờ bị chặn (hoặc vẫn tới worktree cleanup — xác nhận behavior mong muốn)
- [M] revert confirm check → test **phải fail**

### ST-1 | P0 — worktree data loss
**File mới:** `test/integration/worktree-snapshot-dirs-binary.test.ts` (integration vì cần real git)
- [I] tạo `packages/newmod/` (12 file) untracked + crash + retry → snapshot có CẢ dir
- [I] `assets/logo.png` untracked binary → snapshot base64, khôi phục không corrupt
- [I] tracked binary change → `git diff HEAD --binary` recover được (`git apply`)
- [U] `git status --porcelain -uall` không collapse dir (unit kiểm argv)
- [U] per-file byte cap → file lớn bị truncate có báo, không OOM
- [M] revert `-uall`/`--binary`/base64 → integration test **phải fail** (dir/binary mất)
- [C] worktree reuse 2 task concurrent → không ghi đè snapshot của nhau

### RT-1 | P1 — in-flight clobber
**File mới:** `test/unit/team-runner-failed-task-while-siblings-inflight.test.ts` + extension
- [C] 3-task batch, A fail khi B in-flight (đã persist `running`) → B **không** thành `skipped`; kết quả B merge
- [C] B chưa persist (window pre-persist) → B cũng không `skipped` mù (cancel có chủ đích, không phải markBlocked)
- [U] `drainPendingUnits` chạy trước `saveRunTasksAsync` trong early-return path
- [U] không double-drain (finally vẫn drain, nhưng idempotent)
- [E2E] `team action='run'` 3-task parallel, fail 1 → `team status` không có task `skipped` của sibling in-flight
- [M] revert drain-and-merge → concurrency test **phải fail** (B = skipped, result mất)

### RT-5 | P1 — coalesced 5 divergences
**File mới:** `test/unit/run-coalesced-*.test.ts` (5 file, mỗi divergence 1 file)
- [U] cancel → status `cancelled` (không `failed`); `handleRetry` distinguish được
- [U] depth-guard exitCode:1 → `failed`; mock scaffold → `completed`; success = `exitCode===0 && !error`
- [U] `runtimeConfig.maxTurns:10` → truyền 10 (không hardcode 5)
- [U] `runtimeConfig.taskTimeoutMs` → arm timeout; worker treo → timeout fires
- [U] `reliability.autoRetry===false` → skip retry; custom policy → dùng custom
- [I] real dispatch (`executeWorkers:true`) cho cancel + timeout (không scaffold)
- [M] mỗi divergence: revert fix → test tương ứng **phải fail**

### RT-2 | P1 — SIGINT orphan
**File mới:** `test/integration/background-runner-sigint-cleanup.test.ts`
- [I] spawn background-runner + `fake-pi.mjs` detached child → gửi SIGINT → assert `runCleanup` chạy (event `async.cleanup`), child `fake-pi` bị terminate (không orphan)
- [I] SIGINT 2 lần → idempotent (không double-abort)
- [U] SIGINT handler set `process.exitCode=130` (không `process.exit`) → finally chạy
- [M] revert (`exit`→`exitCode`) → integration test **phải fail** (child còn sống)
- [E2E] `team action='run'` background + Ctrl-C → `ps` không còn child pi

### RT-3 | P1 — startup silent exit
**File mới:** `test/unit/background-runner-startup-fail.test.ts`
- [U] lock-fail throw → module catch write `async.failed` + exit 1 (không exit 0)
- [U] manifest missing throw → tương tự
- [U] args missing throw → tương tự
- [M] revert catch → test fail (exit 0, no event)

### RT-4 | P1 — interrupt re-fire 4×/s
**File mới:** `test/unit/interrupt-guard-ack.test.ts`
- [U] interrupt detect → write `acknowledged:true` vào foreground-control.json
- [U] module-local `interruptHandled` gate → body chỉ chạy 1 lần
- [perf] 1 giây steady → ≤1 `async.interrupt_detected` event (không 4×/s)
- [M] revert → test fail (4 event/giây)

### ST-4 | P1 — corrupt tasks.json
**File mới:** `test/integration/state-store-corrupt-tasks-recovery.test.ts`
- [I] write malformed JSON tasks.json + events.jsonl hợp lệ → `loadRunManifestById` reconstruct đúng (không `[]`)
- [U] `readJsonFile` SyntaxError → quarantine `.corrupt-*` (không return undefined silent)
- [U] ENOENT → return `[]` hợp lệ (không quarantine)
- [U] non-array JSON (`{}`) → `Array.isArray` guard reject
- [U] refuse persist `[]` over non-empty (guard)
- [M] revert wiring `reconstructTasksFromEvents` → integration test **phải fail** (`[]`)
- [C] 2 process đọc tasks.json corrupt đồng thời → không double-quarantine

### ST-3 | P1 — mailbox locks
**File mới:** `test/integration/mailbox-sync-async-concurrent.test.ts`
- [C] 2 process: 1 sync append + 1 async rewrite → không mất message (1000 vòng)
- [C] rotation window (rename ↔ atomicWrite("")) → append trong window không mất
- [U] collapse 1 lock namespace `.flock` cho cả 3 path
- [U] `withFileLockAsync` có O_EXCL tier cross-process
- [M] revert unification → concurrency test **phải fail** (lost message)

### ST-5 | P1 — cross-process seq
**File mới:** `test/integration/event-log-cross-process-seq.test.ts`
- [C] 2 process append sync đồng thời → không trùng seq
- [C] 2 process buffered path → không trùng
- [C] 1 sync + 1 async → không trùng
- [U] `reserveSequence` dùng body `reserveSequenceUnderLock` (re-read sidecar)
- [U] `sinceSeq` reader không drop event khi seq unique
- [M] revert → cross-process test **phải fail** (dup seq)

### ST-6 | P1 — transient read quarantine
**File mới:** `test/unit/crash-recovery-transient-read.test.ts`
- [U] mock EBUSY readFileSync → retry backoff, KHÔNG quarantine
- [U] mock EACCES → retry, không quarantine
- [U] SyntaxError → quarantine (giữ behavior đúng)
- [U] `.corrupt-*` age sweep trong `pruneFinishedRuns`
- [M] revert SyntaxError-only filter → test fail (healthy manifest bị quarantine)

### EXT-1 | P1 — typo field detection
**File mới:** `test/unit/team-tool-typo-detection.test.ts`
- [U] `{action:"run", goals:"x"}` → "Unrecognized field 'goals' — did you mean 'goal'?"
- [U] ranking near-miss (`findClosestKey`): `goa`→`goal`, `runiD`→`runId`
- [U] field hợp lệ → không false-positive
- [U] nhiều typo → list tất cả
- [M] revert → test fail (generic error, no hint)

### EXT-2 | P1 — error examples
**File mới:** `test/unit/handler-error-examples.test.ts`
- [U] mỗi handler (run/status/cancel/respond/inspect/lifecycle/schedule/parallel/goal/api) → error chứa example shape
- [U] `paramRequired(action, field, example)` helper dùng nhất quán
- [M] revert → test fail (plain message)

### Tier 3 — compact coverage

| ID | Test types | File | Mutation? |
|----|-----------|------|-----------|
| RT-6 | U (config maxAttempts) | `child-executor-spawn-budget-config.test.ts` | yes |
| RT-7 | U (cache hit), perf | extend `team-runner-characterization` | yes |
| RT-8 | U (immutability) | `child-executor-immutability.test.ts` | yes |
| RT-9 | U (overflow split) + [P] fuzz newlines | `child-pi-streams-buffer-overflow.test.ts` | yes |
| RT-10 | U (dead code removed → typecheck) | n/a (typecheck gate) | — |
| RT-11 | [I] fake-pi spawn registration | `child-pi-spawn-registration.test.ts` | yes |
| RT-12 | perf bench | extend existing bench | — |
| RT-13 | U (legal transition) | extend `team-runner-*` | yes |
| RT-14 | U (helper used 10 sites) | `cancel-non-terminal-helper.test.ts` | yes |
| RT-15 | U (compiler-enforce sync) | n/a (TS types) | — |
| RT-16 | U (table-driven merge) | extend `team-runner-*` | yes |
| RT-17 | U (filename length bound) | `batch-summary-filename.test.ts` | yes |
| RT-18 | U (single appendEvent) | extend background-runner tests | — |
| RT-19 | doc-only (typecheck) | n/a | — |
| ST-7 | U (temp cleanup) + [C] rename-fail | `atomic-write-temp-leak.test.ts` | yes |
| ST-8 | [C] rotation append-race | `event-log-rotation-append-race.test.ts` | yes |
| ST-9 | U (version + migration) | `tasks-json-version-migration.test.ts` | yes |
| ST-10 | U (retention enforce) | `artifact-retention-enforcement.test.ts` | yes |
| ST-11 | perf | extend bench | — |
| ST-12 | U (sidecar trust) + perf | extend `event-log-*` | yes |
| ST-13 | U (EOL preserve) | `conflict-detect-mixed-eol.test.ts` | yes |
| ST-14 | [C] async-context re-entrance | `locks-reentrance-async-context.test.ts` | yes |
| ST-15 | [I] prepare twice isolation | `worktree-prepare-twice-isolation.test.ts` | yes |
| EXT-3 | typecheck + grep (dead code gone) | n/a | — |
| EXT-4 | drift test | `action-suggestions-drift.test.ts` | — |
| EXT-5 | typecheck (`assertNever`) | n/a | — |
| EXT-6 | U (shared helper) | extend handler tests | — |
| EXT-7 | U (schema still validates) | extend schema tests | yes |
| EXT-8 | drift test (single source) | `action-list-single-source.test.ts` | — |
| EXT-9 | U (singleton lifecycle) | `singleton-lifecycle.test.ts` | — |
| EXT-10 | typecheck (inlined) | n/a | — |
| EXT-11 | U (no stale benchmark in desc) | `team-tool-description.test.ts` | — |
| EXT-12 | U (i18n team-tool) | `i18n-team-tool.test.ts` | — |
| UI-1/2/5/9 | U + perf | extend UI tests | — |
| UI-3/4 | [I] overlay stack | `ui-overlay-stack.test.ts` | — |
| UI-6/7 | U (no leak) | extend theme/widget tests | — |
| UI-8 | typecheck (removed) | n/a | — |
| UI-10 | U (NO_COLOR) | `widget-formatters-nocolor.test.ts` | — |
| UI-11 | U (event-driven) | extend theme tests | — |
| UI-12/13 | coverage | new tests | — |
| UI-14 | grep (removed/used) | n/a | — |
| QA-1 | CI green | n/a | — |
| QA-2 | `npm pack --dry-run` assert | `tarball-excludes-dev-scripts.test.ts` | — |
| QA-3 | assert numbers match `npm test` | `test-matrix-sync.test.ts` | — |
| QA-4/5 | `npm run lint` 0 error + visible | n/a (lint gate) | — |
| QA-6 | incremental `noExplicitAny` | n/a (lint) | — |
| QA-7 | U (real assertion) | fix existing test | — |
| QA-8 | perf (<10s) | optimize existing | — |
| QA-9 | track skip | n/a | — |
| QA-10 | peer dep bump | n/a | — |
| QA-11 | U (.d.ts preserved) | `npmignore-types.test.ts` | — |
| QA-12 | deterministic (fake timers) | fix existing | — |

---

## 4. Cross-cutting test infrastructure cần thêm

| Fixture/Helper | Signature | Dùng cho |
|----------------|-----------|----------|
| `hostileRepoFixture()` | `(overrides?) => { dir, cleanup }` — tạo temp repo có `.crew/agents/pwn.md`, `.crew/knowledge.md` injection, `.crew/pwn.ts` | SEC-1, SEC-2, SEC-4 |
| `twoProcessFixture()` | `(fnA, fnB) => { seqs, events }` — spawn 2 node process cùng ghi events.jsonl/mailbox, collect | ST-3, ST-5 |
| `corruptJsonFixture()` | `(path, kind: "syntax"\|"enoent"\|"non-array") => void` | ST-4 |
| `fakePiOrphanFixture()` | wrap `fake-pi.mjs` spawn detached + return pid + SIGINT sender + liveness poll | RT-2, RT-11, RT-19 |
| `realGitWorktreeFixture()` | tạo git repo thật + untracked dir/binary + worktree | ST-1, ST-15 |
| `mutationCheck()` | helper runner: revert 1 hunk qua `git`, chạy 1 test, assert fail, restore | mọi HIGH-risk (RT-1/5/2, ST-1/4/3) |
| `assertArgvNotContains()` | `(argv, forbidden)` helper | SEC-1 |

---

## 5. Test-type coverage rollup

| Type \ Sprint | A | B | C | D | E | F | G |
|---------------|---|---|---|---|---|---|---|
| **Unit** | 5 | 10 | 9 | 6 | 5 | 17 | 7 |
| **Integration** | 0 | 2 (RT-2,RT-11) | 4 (ST-1,ST-4,ST-3,ST-5) | 1 (RT-5 real) | 2 (ST-8,ST-14) | 1 (UI-3/4) | 0 |
| **Regression/PoC** | 2 (SEC-1,SEC-2) | 1 (RT-2) | 4 (ST-1,RT-1,ST-4,ST-3) | 1 (RT-5) | 0 | 0 | 0 |
| **Property/fuzz** | 2 (SEC-3,SEC-4) | 0 | 1 (RT-9) | 0 | 0 | 0 | 0 |
| **Concurrency** | 0 | 1 (RT-2) | 4 (ST-1,ST-4,ST-3,ST-5) | 0 | 2 (ST-8,ST-14) | 0 | 0 |
| **Security** | 2 (SEC-1,SEC-2) | 0 | 0 | 0 | 0 | 0 | 0 |
| **Mutation** | 4 (SEC-1,2,4,5) | 4 (RT-2,3,4,11) | 6 (ST-1,RT-1,ST-4,5,7,ST-3) | 5 (RT-5×4,EXT-1) | 5 | 1 (EXT-7) | 4 (RT-7,13,16,17) |
| **E2E/smoke** | 1 (hostile repo) | 1 (Ctrl-C) | 1 (team run RT-1) | 1 (coalesced) | 0 | 0 | 1 (coalesced full) |

**Rule không vi phạm:** mọi HIGH-risk (RT-1, RT-5, ST-1, ST-4, ST-3) có mutation + regression/concurrency; mọi security (SEC-1, SEC-2) có hostile-repo PoC; mọi lock/seq (ST-3, ST-5, ST-14) có cross-process/concurrency.

---

## 6. Top 10 test cases viết TRƯỚC (bug-catching value cao nhất)

1. **[C] RT-1 in-flight clobber** — bắt đúng bug scheduler độc hại nhất (verified vòng 3). Mutation: revert drain-and-merge.
2. **[S] SEC-1 hostile-repo argv** — bắt RCE Critical; argv assert đơn giản, giá trị cao.
3. **[I] ST-1 worktree dir+binary loss** — bắt P0 data-loss; mutation revert `-uall`/base64.
4. **[I] ST-4 corrupt→reconstruct** — kích hoạt dead code; mutation revert wiring.
5. **[C] ST-3 mailbox 2-process** — bắt message loss; single-process test hiện tại không bắt được.
6. **[I] RT-2 SIGINT+fake-pi orphan** — bắt orphan; mutation revert `exit`→`exitCode`.
7. **[C] ST-5 cross-process seq** — bắt dropped event; hiện single-process only.
8. **[U+M] RT-5 cancel→cancelled** — divergence #1 phá `handleRetry`; mutation đơn giản.
9. **[S] SEC-2 knowledge injection 2-path** — bắt prompt injection Critical ở cả main + worker.
10. **[U+M] RT-4 interrupt ack** — bắt syscall churn 4×/s; perf test rõ ràng.

---

## 7. Findings vẫn ZERO coverage sau plan?

**Không.** Mọi finding Tier 1+2 có ≥1 test type + mutation (HIGH-risk) hoặc PoC (security). Tier 3 cleanups (RT-10, RT-15, RT-18, RT-19, EXT-3/5/10, UI-8/14, QA-1/4/5/6/9/10)靠 typecheck/lint gate (không cần test runtime) — đã note rõ.

---

*Strategy bổ sung cho REMEDIATION-PLAN. Mỗi PR trong plan phải reference test case(s) tương ứng ở đây trước khi claim done.*
