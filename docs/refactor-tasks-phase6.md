# Phase 6 Refactor Plan — Robustness sau test 0.1.27/0.1.29 + nợ kỹ thuật từ source-runtime-refactor-map

> Xuất xứ:
> - Test thực tế run `team_20260428152644_2ae0dce7` (parallel-research, 10/10 completed) trên pi-crew@0.1.27.
> - Re-read source 28/04/2026 sau bump 0.1.28 (responseTimeoutMs 15s→5m) và 0.1.29 (republish).
> - Findings còn lại từ `docs/source-runtime-refactor-map.md` (subagent runtime consolidation, model-routing persistence, adaptive planner repair).
>
> Phase 5 đã hoàn tất (UI/footer/select-list/theme hot-reload). Phase 6 tập trung **runtime hardening + maintainability**, không phá public API.

## Quy ước chung (giữ nguyên từ Phase 5)
- Không phá vỡ public API: tool actions, slash commands, config schema, schema.json.
- Sau mỗi task: `npx tsc --noEmit` + `npm run test:unit` (`test:integration` khi đụng runtime/spawn/state).
- Không thêm runtime dependency mới ngoài stdlib + peer deps đã có (`pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`, `jiti`).
- Mỗi task = 1 commit độc lập, có thể revert riêng. Test name bám sát hành vi (`describe`/`it` đặt theo contract chứ không theo file).
- Default behavior không đổi (backward-compat); cải tiến hành vi đi qua opt-in env/config khi có nguy cơ regression.
- Mỗi task có Acceptance + Verification + Risk/Rollback. Trước khi mở PR phải `npm run ci` (typecheck + test:unit + test:integration + npm pack --dry-run).

## Roadmap tổng quan

| Tier | Workstream | Số task | Ước tính | Ưu tiên |
|---|---|---|---|---|
| **1** | Background runner & async robustness | T60–T62 | 0.5 ngày | P0 — chặn rủi ro silent fail |
| **1** | Concurrency hard cap | T63 | 0.25 ngày | P0 — chặn user override DoS |
| **2** | Resume durability cho synthesize/write | T64–T66 | 1 ngày | P1 — nâng cao reliability |
| **2** | Adaptive planner repair/retry | T67 | 0.5 ngày | P1 — giảm block rate |
| **2** | Model routing persistence | T68–T69 | 0.5 ngày | P1 — observability |
| **3** | register.ts modularization | T70–T72 | 1 ngày | P2 — maintainability |
| **3** | Subagent runtime consolidation | T73–T75 | 1.5 ngày | P2 — debt theo refactor map |
| **3** | Skills builtin + docs self-contained | T76–T78 | 0.5 ngày | P3 — polish |
| **4** | Tests, smoke, CHANGELOG | T79–T81 | 0.5 ngày | P0 (cuối phase) |

Tổng: **22 task / ~6.25 ngày**, có thể ship theo nhiều mini-release (0.1.30, 0.1.31, …).

## Tiến độ triển khai

| Task | Trạng thái | Commit / ghi chú |
|---|---|---|
| T60 | ✅ Done | `bfd9bc8` — jiti loader resolution/fail-fast |
| T61 | ✅ Done | `bfd9bc8` — async early-exit guard |
| T62 | ✅ Done | `bfd9bc8` — async startup marker |
| T63 | ✅ Done | `bfd9bc8` — concurrency hard cap + opt-out |
| T64 | ✅ Done | checkpoint phases + child-stdout-final/artifact-written resume recovery |
| T65 | ✅ Done | async notifier marks quiet dead background runners failed with `async.died` |
| T66 | ✅ Done | `5e495dc` — replay pending mailbox on resume |
| T67 | ✅ Done | adaptive plan repair for malformed JSON, oversized plans, and role aliases |
| T68 | ✅ Done | `1f92b8a` — persisted model routing metadata |
| T69 | ✅ Done | `1f92b8a` — agent records carry routing metadata |
| T70 | ✅ Done | `register.ts` split to ≤200 lines with commands, team tool, subagent tools, artifact cleanup modules |
| T71 | ✅ Done | `team-tool.ts` split to ≤300 lines with status/inspect/lifecycle/cancel/plan modules |
| T72 | ✅ Done | `task-runner.ts` split to ≤300 lines with prompt/progress/state/live/result helper modules |
| T73 | ✅ Done | `src/subagents/*` entrypoints added and runtime call-sites migrated |
| T74 | ✅ Done | live-session APIs routed through `src/subagents/live/*` with dynamic task-runner import |
| T75 | 🟡 Partial | `1004589` — recursive subagent role/depth permission hardening |
| T76 | ✅ Done | `f6ece8e` — built-in coding skills |
| T77 | ✅ Done | `9e54acd` — self-contained architecture docs |
| T78 | ✅ Done | `9e54acd` — runtime flow docs |
| T79 | ✅ Done | multi-shard, no-wrapper spawn, and async restart recovery smokes covered |
| T80 | ✅ Done | package snapshot guards docs/skills/jiti/pi manifest packaging |
| T81 | ✅ Done | changelog release prep notes added; no publish/version bump performed |

---

## Tier 1 — Robustness chặn rủi ro silent fail (P0)

### Task #60 — `background-runner.ts` fail-fast nếu jiti loader không tồn tại

**Lý do (evidence)**: `src/runtime/background-runner.ts` `getBackgroundRunnerCommand()` xây cứng đường dẫn:
```ts
const jitiRegisterPath = path.join(packageRoot, "node_modules", "jiti", "lib", "jiti-register.mjs");
return { args: ["--import", pathToFileURL(jitiRegisterPath).href, runnerPath, ...], loader: "jiti" };
```
Nếu user xóa `node_modules/jiti` (npm prune, monorepo hoisting bất thường, broken install), `spawn(process.execPath, ...)` không fail ở Node parent — child sẽ exit lỗi ngay nhưng parent không capture được vì stdout đã `child.unref()` + đóng `logFd`. Background log chỉ chứa `[pi-crew] background loader=jiti` rồi im lặng. Run sẽ kẹt ở status `running` cho đến khi `process-status.hasStaleAsyncProcess` mark stale (>10 phút).

**Đích**: `src/runtime/background-runner.ts`

**Steps**:
1. Trước khi `spawn`, kiểm tra `fs.existsSync(jitiRegisterPath)`. Nếu thiếu → throw `Error` với message rõ ràng:
   ```
   pi-crew background runner cannot start: jiti loader not found at
   <jitiRegisterPath>. Reinstall pi-crew (`pi install npm:pi-crew`) or
   ensure node_modules/jiti is present.
   ```
2. Caller (`team-tool/run.ts` qua `spawnBackgroundTeamRun`) đã có try/catch — đảm bảo error propagate ra notify cho user.
3. Append error vào `events.jsonl` qua `appendEvent(eventsPath, { type: "async.failed", message })` trước khi throw.
4. Mở rộng: thêm fallback path tìm jiti trong `require.resolve.paths()` của parent module (Windows monorepo hoist) — nếu primary path missing thì thử `path.join(packageRoot, "..", "..", "node_modules", "jiti", "lib", "jiti-register.mjs")` (npm hoisting 2 cấp). Nếu cả hai miss thì mới throw.

**Acceptance**:
- Khi `node_modules/jiti/lib/jiti-register.mjs` thiếu → `spawnBackgroundTeamRun` throw với message hướng dẫn reinstall.
- Khi user dùng monorepo hoisting (jiti ở root workspace) → vẫn resolve được.
- `events.jsonl` có entry `async.failed` trước khi spawn.
- Không regression với case có jiti (path 1 hit).

**Tests**: `test/unit/background-runner.fail-fast.test.ts`
- Stub `fs.existsSync` để giả lập miss → assert throw với pattern `/jiti loader not found/`.
- Stub hoist path tồn tại → assert dùng path thay thế.
- Cleanup không leak global state (`vi`-style spy + restore).

**Verification**:
```bash
npx tsc --noEmit
node --experimental-strip-types --test test/unit/background-runner.fail-fast.test.ts
```

**Risk/Rollback**: Risk thấp — chỉ thêm sanity check trước spawn. Rollback bằng cách revert commit.

**Security/Perf notes**: Không I/O bổ sung trong hot path (chỉ 1 stat khi spawn background). Không log đường dẫn đầy đủ ở mức user message để tránh lộ home directory; dùng `shortenPath()` từ `utils/visual.ts` nếu có.

---

### Task #61 — Capture early-exit của background runner (drain `background.log`)

**Lý do**: Hiện sau `child.unref(); fs.closeSync(logFd);` parent quên child. Nếu background-runner.ts lỗi cú pháp/import (không phải jiti missing nhưng vẫn fail), log chỉ chứa stderr Node. Status tool báo `Async: pid=X alive=false` sau khi process exit, nhưng manifest status vẫn `running`. User phải đợi `hasStaleAsyncProcess` (10 phút) mới detect.

**Đích**: `src/extension/team-tool/run.ts` (caller) và `src/runtime/process-status.ts`

**Steps**:
1. Trong caller, lưu `pid` ngay sau spawn. Schedule một check sau ~3s (`setTimeout` + `unref`) gọi `checkProcessLiveness(pid)`:
   - Nếu `alive=false` AND manifest vẫn `running` AND chưa có event `async.started` → đọc `background.log` (last 4KB), append event `async.failed` với log tail và `updateRunStatus(manifest, "failed", "Background runner exited within 3s; see background.log")`.
2. Cancel `setTimeout` nếu trong khoảng đó status đã chuyển khác `running`.
3. Đảm bảo không double-write status nếu background process đã write `async.failed` từ catch block.

**Acceptance**:
- Background runner exit ngay → run status chuyển `failed` trong ≤4s với reason có tail log.
- Background runner chạy bình thường → không có false positive.

**Tests**: `test/integration/background-early-exit.test.ts`
- Mock `spawnBackgroundTeamRun` với child exit ngay (set `PI_TEAMS_MOCK_CHILD_PI=fail-immediate` + extend mock branch).

**Verification**: `npm run test:integration -- background-early-exit`

**Risk/Rollback**: Cần test kỹ với case async hợp lệ; rollback bằng feature flag `PI_CREW_ASYNC_EARLY_EXIT_GUARD=0`.

---

### Task #62 — `async.started` event timeout & marker file

**Lý do**: Bổ sung `T61`. Background runner ghi `async.started` vào `events.jsonl` ở dòng đầu `main()`. Nếu file `events.jsonl` bị lock (Windows), event không append được. Caller hiện không có cơ chế chờ confirm.

**Đích**: `src/runtime/async-runner.ts` + `src/runtime/background-runner.ts`

**Steps**:
1. Background runner ghi marker file `state/runs/{runId}/async.pid` chứa `{pid, startedAt}` ngay sau khi `appendEvent("async.started")` thành công.
2. Caller (T61) khi healthcheck 3s đọc thêm marker file: nếu marker tồn tại → coi như runner đã start ổn.
3. Bổ sung `process-status.hasAsyncStartMarker(runId)`.

**Acceptance**: Marker tồn tại sau khi async runner startup; healthcheck dùng marker khi events.jsonl không khả dụng (Windows lock fallback).

**Tests**: unit cho `hasAsyncStartMarker` (file exists/missing/parse error).

**Verification**: `npm run test:unit`

---

### Task #63 — Hard cap cho `limits.maxConcurrentWorkers`

**Lý do**: `src/runtime/concurrency.ts.resolveBatchConcurrency()` dùng `limits.maxConcurrentWorkers` user truyền **không cap**. User config `limits.maxConcurrentWorkers=64` → 64 child Pi process spawn song song → DoS local. `parallel-utils.MAX_PARALLEL_CONCURRENCY=4` chỉ áp ở subagent runner cấp thấp, không bảo vệ scheduler.

**Đích**: `src/runtime/concurrency.ts`, `src/config/defaults.ts`, `src/config/config.ts`

**Steps**:
1. Thêm `DEFAULT_CONCURRENCY.hardCap = 8` vào `defaults.ts`.
2. Trong `resolveBatchConcurrency`, sau `requested = limitMax ?? teamMax ?? workflowMax ?? defaultWorkflowConcurrency`:
   ```ts
   const cap = positiveInteger(input.hardCap) ?? DEFAULT_CONCURRENCY.hardCap;
   const effective = Math.min(requested, cap);
   ```
3. Khi `effective < requested`, ghi `reason` thêm `;capped:${cap}` để observability.
4. Cho phép user opt-out qua `config.limits.allowUnboundedConcurrency=true` (gated qua warning event `limits.unbounded` + log dòng đầu run, default false).
5. Cập nhật `schema.json` + `config-schema.ts` cho field mới.

**Acceptance**:
- `limits.maxConcurrentWorkers=64` (default) → effective=8, reason chứa `capped:8`.
- `limits.maxConcurrentWorkers=64, allowUnboundedConcurrency=true` → effective=64, có event warning.
- Không regression cho values hợp lý (≤8).

**Tests**: `test/unit/concurrency.cap.test.ts`
- 4 case: requested=2 (no cap), requested=12 (cap=8), unbounded flag (no cap), workflow=parallel-research workflowMax=4 (no cap).

**Verification**: `npx tsc --noEmit && node --experimental-strip-types --test test/unit/concurrency.cap.test.ts`

**Risk/Rollback**: Có thể vô tình giảm throughput cho user power-user. Mitigate bằng `allowUnboundedConcurrency` flag. Rollback: revert + bump major nếu user đã dựa vào behavior cũ (chưa rõ).

**Security/Perf notes**: Bảo vệ memory/cpu local; mỗi child Pi consume ~200MB RAM. 8 = 1.6GB worst case, hợp lý cho dev machine.

---

## Tier 2 — Reliability nâng cao (P1)

### Task #64 — Resume detection: synthesize/write checkpoint

**Lý do**: `team-runner.executeTeamRun` không biết task synthesize/write đã completed một phần khi crash giữa chừng. Khi resume (`team resume runId`), task `synthesize` re-run từ đầu, gọi LLM lại tốn cost. Risk #5 trong test report.

**Đích**: `src/runtime/task-runner.ts`, `src/state/state-store.ts`, `src/state/types.ts`

**Steps**:
1. Mở rộng `TeamTaskState` thêm `checkpoint?: { phase: "started" | "child-spawned" | "child-stdout-final" | "artifact-written"; updatedAt: string; childPid?: number }`.
2. `runTeamTask` ghi checkpoint qua `saveRunTasks` ở 4 điểm:
   - Trước `runChildPi` (`started`)
   - Sau `child.pid` có (`child-spawned` + pid)
   - Khi nhận `isFinalAssistantEvent` (`child-stdout-final`)
   - Sau `writeArtifact` (`artifact-written`)
3. `team-tool.handleResume` xét checkpoint:
   - Nếu `checkpoint.phase === "artifact-written"` mà status vẫn `running` → mark `completed` (recovery, không re-run).
   - Nếu `checkpoint.phase === "child-stdout-final"` → cố parse output từ `transcripts/{taskId}.jsonl` last lines, nếu có valid `message_end` thì mark `completed` mà không re-spawn.
   - Else → re-queue.

**Acceptance**:
- Crash sau khi artifact ghi xong → resume mark `completed` không re-run LLM.
- Crash giữa stdout streaming → resume cố recover từ transcript; nếu không thành công thì re-run.
- State migration backward-compat (task cũ không có `checkpoint` → resume hoạt động như cũ).

**Tests**: `test/integration/resume-checkpoint.test.ts`
- 3 case: pre-spawn crash, mid-stream crash, post-artifact crash.

**Verification**: `npm run test:integration -- resume-checkpoint`

**Risk/Rollback**: Touch durable state shape. Cần migration: nếu task không có `checkpoint`, treat như chưa start. Rollback: revert + xóa field optional khỏi types.

---

### Task #65 — Resume cho async background run sau parent crash

**Lý do**: Khi parent Pi session crash, background runner vẫn chạy; manifest cập nhật bình thường. Nhưng nếu **background runner crash** (ví dụ jiti corrupted, OOM), không có ai mark run failed cho đến `hasStaleAsyncProcess` 10 phút sau. Status sẽ misleading.

**Đích**: `src/runtime/process-status.ts`, `src/extension/async-notifier.ts`

**Steps**:
1. Mở rộng `async-notifier.ts.startAsyncRunNotifier`: với mỗi run đang `running`, mỗi `notifierIntervalMs` (5s) check `checkProcessLiveness(async.pid)`. Nếu `alive=false` VÀ run status `running` AND không có event nào trong 30s gần nhất → `updateRunStatus(manifest, "failed", "Background runner died unexpectedly; check background.log")`.
2. Bổ sung guard: chỉ thực hiện nếu chưa có event `async.completed`/`async.failed` (avoid double-write).

**Acceptance**: Background runner kill -9 → trong ≤30s status chuyển `failed`, có event `async.died`.

**Tests**: `test/integration/async-died.test.ts` (mock spawn process exit ngẫu nhiên).

**Verification**: `npm run test:integration -- async-died`

**Risk/Rollback**: False positive khi event log chậm flush. Mitigate: chỉ trigger khi không alive AND last event > 30s. Rollback: revert async-notifier hook.

---

### Task #66 — Mailbox replay khi resume

**Lý do**: `state/mailbox` có inbox/outbox JSONL nhưng resume không re-deliver pending messages. Risk #5 mở rộng.

**Đích**: `src/state/mailbox.ts`, `src/extension/team-tool/api.ts`

**Steps**:
1. Khi resume, đọc `mailbox/delivery.json`. Mọi message `direction=inbox` chưa `acked=true` → re-emit trong batch đầu.
2. Add `validate-mailbox repair=true` vào doctor checks để cleanup stale messages > 7 ngày.

**Acceptance**: Resume sau crash giữa khi mailbox có 3 message pending → 3 message được redelivered.

**Tests**: `test/unit/mailbox-replay.test.ts`

**Verification**: `npm run test:unit`

---

### Task #67 — Adaptive planner repair/retry trước khi block

**Lý do**: `team-runner.injectAdaptivePlanIfReady` block ngay khi `__test__parseAdaptivePlan` fail (oversize >12 task / JSON malformed / role không hợp lệ). User phải re-run từ đầu. Refactor map đã ghi nhận: "Add adaptive planner repair/retry for invalid JSON instead of immediate block when safe."

**Đích**: `src/runtime/team-runner.ts`, `agents/planner.md`

**Steps**:
1. Khi parse fail, thay vì return `missingPlan: true` ngay, thử **repair**:
   - Nếu JSON malformed → spawn 1 child Pi tiny (planner role, model rẻ — Haiku/gpt-5-nano) với prompt: `Fix the following JSON to comply with the adaptive plan schema. Return only ADAPTIVE_PLAN_JSON_START ... ADAPTIVE_PLAN_JSON_END.\n<failed_text>`. Cap retry = 1, timeout 60s.
   - Nếu oversize (>12 task) → tự trim phases tail tới ≤12 task, ghi event `adaptive.plan_trimmed`.
   - Nếu role không hợp lệ → map sang role gần nhất (`reviewer`→`code-reviewer` nếu team có) hoặc skip task đó nếu phase không trống.
2. Nếu repair fail → mới block (giữ behavior hiện tại). Ghi event `adaptive.plan_repair_failed`.
3. Persist repair attempt vào `metadata/adaptive-repair.json` để debug.

**Acceptance**:
- Plan JSON malformed nhỏ (thiếu `}`) → repair fix → run tiếp.
- Plan 15 task → trim còn 12, run tiếp với warning.
- Plan với role lạ → map hoặc skip task; nếu không cứu được thì block với explain rõ ràng.

**Tests**: `test/unit/adaptive-repair.test.ts` (3 fixture: malformed, oversize, invalid-role).

**Verification**: `npm run test:unit -- adaptive-repair`

**Risk/Rollback**: Có thể ăn thêm 1 model call. Mitigate: chỉ retry khi cost < 0.001 USD ước tính (Haiku tier). Rollback: env `PI_CREW_ADAPTIVE_REPAIR=0`.

---

### Task #68 — Persist model routing (requested → selected → fallback chain → reason)

**Lý do**: Refactor map: "Move model routing transparency into persisted task/subagent records: requested model, selected model, fallback chain, fallback reason." Hiện task state chỉ có `modelAttempts: ModelAttemptSummary[]` (model + success + error) nhưng không persist `requestedModel` ban đầu user/agent yêu cầu, cũng như reason vì sao chuyển fallback.

**Đích**: `src/runtime/model-fallback.ts`, `src/state/types.ts`, `src/runtime/task-runner.ts`

**Steps**:
1. Mở rộng `TeamTaskState.modelRouting?: { requested?: string; resolved: string; fallbackChain: string[]; reason?: string; usedAttempt: number }`.
2. `buildConfiguredModelCandidates` trả thêm `requestedModel` (model agent.md / step.model trước fallback).
3. `runTeamTask` write `modelRouting` cùng `modelAttempts`.
4. `team-tool.handleStatus` render section `Model routing:` nếu có. Dashboard agent rows hiển thị `model · ≥requested:claude-sonnet-4-5 → openai-codex/gpt-5.5 (rate-limit)`.

**Acceptance**:
- Task chạy thành công lần 1 → `usedAttempt=0`, `fallbackChain` chứa chain config (không cần markFallback).
- Task fallback từ A → B vì rate-limit → `reason: "rate-limit"`, `usedAttempt=1`.
- Status output có dòng `Model routing` cho mỗi task có routing data.

**Tests**: `test/unit/model-routing.test.ts`

**Verification**: `npm run test:unit`

**Risk/Rollback**: Task state shape mở rộng — backward-compat (field optional). Rollback: revert types + hide UI.

---

### Task #69 — Subagent records lưu model routing

**Lý do**: Liên quan T68 nhưng cho `crew-agent-records` (file-backed agent status hiển thị ở dashboard). Hiện chỉ có `model` field (latest selected); cần `requestedModel` + `fallbackChain`.

**Đích**: `src/runtime/crew-agent-records.ts`

**Steps**:
1. Mở rộng `CrewAgentRecord` thêm `routing?: TeamTaskState["modelRouting"]`.
2. `recordFromTask` map từ `task.modelRouting`.
3. `live-run-sidebar` render `routing` ở chỗ model row.

**Tests**: snapshot trong `test/unit/crew-agent-records.test.ts`.

**Verification**: `npm run test:unit`

---

## Tier 3 — Maintainability & debt cleanup (P2)

### Task #70 — Tách `register.ts` thành sub-modules theo lifecycle

**Lý do**: `src/extension/register.ts` ~38KB trộn: lifecycle, RPC, manifest cache, foreground controller, sidebar, widget, mascot, command parsing, subagent manager, viewers. Quy tắc AGENTS.md "Keep `index.ts` minimal; register functionality from `src/extension/register.ts`. Prefer small modules over large orchestrator files." Đã có sub-folders `registration/` + `team-tool/` nhưng register.ts vẫn lớn.

**Đích**: `src/extension/register.ts` → split

**Steps**:
1. Tách thành 5 module:
   - `src/extension/registration/lifecycle.ts` — session_start/session_before_switch/session_shutdown handlers + cleanupRuntime.
   - `src/extension/registration/widget-loop.ts` — widget interval, sidebar lifecycle (`openLiveSidebar`, `liveSidebarTimer`).
   - `src/extension/registration/foreground-runner.ts` — `startForegroundRun` + `foregroundControllers`.
   - `src/extension/registration/subagent-tools.ts` — Agent/get_subagent_result/steer_subagent + crew_* aliases.
   - `src/extension/registration/commands.ts` — đăng ký toàn bộ slash command (`/teams`, `/team-run`, …).
2. `register.ts` còn lại chỉ là wiring (≤200 dòng): tạo state, gọi các module.
3. Giữ public API (export `registerPiTeams`, `__test__subagentSpawnParams`).

**Acceptance**: 
- `register.ts` ≤200 dòng.
- Mỗi module mới ≤300 dòng.
- Tests cũ pass không thay đổi.
- Thêm test snapshot cho commands list (đảm bảo không drop command nào).

**Tests**: `test/unit/registration.commands-coverage.test.ts` (assert 25 commands đăng ký).

**Verification**: `npx tsc --noEmit && npm run test`

**Risk/Rollback**: Refactor lớn — risk regression. Mitigate: tách từng commit nhỏ (1 module / commit). Rollback: revert lần lượt.

---

### Task #71 — Tách `team-tool.ts` actions còn lại

**Lý do**: `src/extension/team-tool.ts` ~32KB. Đã có `team-tool/{api,run,doctor}.ts`. Còn `handleStatus`, `handleEvents`, `handleArtifacts`, `handleWorktrees`, `handleResume`, `handleCancel`, `handleSummary`, `handleCleanup`, `handleForget`, `handlePrune`, `handleExport`, `handleImport`, `handleImports` ở file chính.

**Đích**: `src/extension/team-tool.ts` → split

**Steps**:
1. Tạo `src/extension/team-tool/{status,events,artifacts,resume,lifecycle-actions}.ts`.
2. `team-tool.ts` chỉ giữ router (`handleTeamTool`) + `handleList`/`handleGet` (đã ngắn).

**Acceptance**: `team-tool.ts` ≤300 dòng. Mỗi sub-module ≤300 dòng.

**Tests**: existing pass.

**Verification**: `npm run test`

---

### Task #72 — Tách `task-runner.ts`

**Lý do**: `src/runtime/task-runner.ts` ~28KB chứa: prompt building, child-pi orchestration, artifact writing, verification evidence, transcripts, retry logic, mailbox bridge.

**Đích**: split thành:
- `task-runner/prompt-builder.ts` (renderTaskPrompt + readOnlyRoleInstructions + coordinationBridgeInstructions).
- `task-runner/artifact-writer.ts` (writeTaskInputs/Outputs/Transcripts/Diff).
- `task-runner/retry.ts` (model fallback retry loop).
- `task-runner/index.ts` exports `runTeamTask`.

**Acceptance**: Mỗi module ≤300 dòng. Public function signature không đổi.

**Tests**: existing pass + snapshot prompt cho mỗi role (4 role).

**Verification**: `npm run test:integration -- task-runner`

---

### Task #73 — Consolidate `child-pi` + `async-runner` + `subagent-manager` thành `src/subagents/`

**Lý do**: Refactor map (đã ghi nhận từ Phase 0): "Consolidate subagent runtime into `src/subagents/*` or equivalent durable-first module." Hiện 3 file rải rác:
- `src/runtime/child-pi.ts` (435 dòng) — spawn pi CLI con
- `src/runtime/async-runner.ts` (~50 dòng) — entrypoint background
- `src/runtime/subagent-manager.ts` (~290 dòng) — Agent tool backend

**Đích**: tạo folder `src/subagents/` chứa:
- `src/subagents/spawn.ts` (lift từ child-pi.ts)
- `src/subagents/observer.ts` (ChildPiLineObserver + compactor)
- `src/subagents/manager.ts` (lift từ subagent-manager.ts)
- `src/subagents/async-entry.ts` (lift từ async-runner.ts)
- `src/subagents/index.ts` re-export public API

Để các file `runtime/child-pi.ts` thành thin re-export (deprecated path) cho 1–2 release rồi xóa.

**Acceptance**:
- Import paths cũ vẫn hoạt động (re-export shim).
- Không thay đổi logic; chỉ move + group.
- Tests cũ pass.

**Tests**: existing.

**Verification**: `npm run ci`

**Risk/Rollback**: Nhiều file đổi import. Mitigate: làm bằng IDE rename/move chứ không edit thủ công. Rollback: revert.

---

### Task #74 — Tách live-session runtime khỏi child-process

**Lý do**: `src/runtime/live-session-runtime.ts` (~14KB) gating sau cờ experimental, nhưng vẫn import từ `task-runner` chính. Nếu mai có người bật `PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION`, code path xen lẫn dễ break.

**Đích**: di chuyển `live-session-runtime.ts` + `live-agent-control/manager` + `live-agent-control-realtime.ts` vào `src/subagents/live/` (subdirectory mới của T73).

**Acceptance**: `runtime/runtime-resolver.ts` chỉ phụ thuộc qua `subagents/live`. Default flow (child-process) không import live module.

**Tests**: existing.

---

### Task #75 — Subagent depth/permission hardening

**Lý do**: `pi-args.checkCrewDepth` đã check `PI_CREW_DEPTH` env. Cần test thêm: subagent gọi recursive (Agent tool trong agent) > maxDepth → block + clear message.

**Đích**: `src/subagents/manager.ts`, `src/runtime/pi-args.ts`

**Steps**:
1. Add explicit test cho recursive spawn.
2. Bổ sung `role-permission.ts` để chặn agent có role `read_only` không được gọi tool `Agent`/`crew_agent`.

**Tests**: `test/unit/subagent-depth.test.ts`, `test/unit/role-permission.spawn.test.ts`.

**Verification**: `npm run test:unit`

---

## Tier 3 — Polish (P3)

### Task #76 — Skills builtin: extract từ `Source/awesome-agent-skills` + adapt

**Lý do**: `pi.skills` trong package.json khai báo `./skills` nhưng folder chỉ có `.gitkeep`. Có thể adapt 5–10 skill cốt lõi từ `Source/awesome-agent-skills/README.md`, `Source/oh-my-claudecode/skills/`, `Source/superpowers/`.

**Đích**: `skills/`

**Steps**:
1. Chọn 5 skill phù hợp coding:
   - `safe-bash` (gate dangerous commands)
   - `verify-evidence` (final assistant must include changed files + verification)
   - `git-master` (commit hygiene + Conventional Commits)
   - `read-only-explorer` (forbid edits when role is explorer/analyst)
   - `task-packet` (enforce scope/inputs/outputs section)
2. Mỗi skill là file `.md` trong `skills/{name}/SKILL.md` + optional helper scripts.
3. Adapt mà không copy nguyên văn (giữ MIT compliance + ghi nguồn trong NOTICE.md).
4. Reference từ `agents/*.md` qua `skills: safe-bash, verify-evidence` frontmatter.

**Acceptance**:
- 5 skill files ≤500 dòng mỗi file.
- NOTICE.md cập nhật source attribution.
- Test discovery: `discover-skills.ts` (có chưa? — bổ sung nếu chưa có) trả về 5.

**Tests**: `test/unit/skills.discovery.test.ts`.

**Verification**: `npm run test:unit -- skills.discovery`

**Risk/Rollback**: Có thể inflate package size. Mitigate: skills nhỏ ≤4KB mỗi cái.

---

### Task #77 — `docs/architecture.md` self-contained

**Lý do**: `pi-teams/docs/architecture.md` hiện trỏ ra `../docs/pi-crew-source-review-and-lessons.md`, `../docs/pi-crew-architecture.md`, `../docs/pi-crew-mvp-plan.md` — các file nằm ngoài package, sẽ broken khi npm publish.

**Đích**: `pi-teams/docs/architecture.md`

**Steps**:
1. Inline nội dung kiến trúc cốt lõi (3 layer: extension/runtime/state, lifecycle diagram, durable run state, autonomous routing).
2. Bỏ reference ra file workspace bên ngoài.
3. Thêm sequence diagram ASCII cho run flow (extension → team-runner → task-runner → child-pi → state).
4. Liên kết tới `usage.md`, `resource-formats.md`, `live-mailbox-runtime.md`, `publishing.md` (đều trong package).

**Acceptance**:
- File ≤600 dòng, không link out-of-package.
- `npm pack --dry-run` ship đầy đủ docs/.

**Verification**: manual review + `npm pack --dry-run`.

---

### Task #78 — `docs/runtime-flow.md` (mới) + sequence diagram

**Lý do**: Onboarding contributor cần một biểu đồ/text mô tả full flow. Hiện rải rác giữa architecture.md, source-runtime-refactor-map.md, refactor-tasks.md.

**Đích**: tạo mới `pi-teams/docs/runtime-flow.md`

**Steps**:
1. ASCII sequence diagram: user → handleTeamTool(run) → executeTeamRun → resolveBatchConcurrency → runTeamTask → runChildPi → child stdout → ChildPiLineObserver → onJsonEvent → updateRunStatus → notify.
2. Bảng "trigger → handler" cho mỗi action (`run`, `resume`, `cancel`, ...).
3. Liệt kê env var ảnh hưởng (`PI_TEAMS_*`, `PI_CREW_*`, `PI_CODING_AGENT_DIR`).

**Acceptance**: Document ≤400 dòng, tự đứng được không cần đọc thêm.

---

## Tier 4 — Tests, smoke, release (P0 cuối phase)

### Task #79 — Integration smoke: Windows process visibility + multi-shard fanout

**Lý do**: Refactor map: "Add real integration smoke scripts for Windows process visibility, async restart recovery, and multi-shard fanout." Test report user vừa gửi đã chứng minh fanout chạy được, nhưng cần script lặp lại được.

**Đích**: `test/integration/`

**Steps**:
1. `test/integration/windows-no-blank-console.test.ts`: spawn `pi --version` qua `pi-spawn.getPiSpawnCommand` với `windowsHide:true` → assert process spawned, no console window (heuristic: `child.spawnargs` không chứa `cmd /c start`).
2. `test/integration/multi-shard-fanout.test.ts`: dùng `expandParallelResearchWorkflow` với fixture `Source/pi-*` mock (5 thư mục dummy) → assert 4 shard sinh ra, mỗi shard có ≥1 path, dependency synthesize đúng tất cả shard.
3. `test/integration/async-restart-recovery.test.ts`: spawn background, kill -9, gọi `team status` → mark failed trong ≤30s (T65 dependency).

**Acceptance**: 3 test pass trên Windows runner CI.

**Verification**: `npm run test:integration`

---

### Task #80 — Update `npm pack --dry-run` snapshot + `schema.json`

**Lý do**: Sau khi thêm config field (T63 `allowUnboundedConcurrency`), `schema.json` exported và `config-schema.ts` cần đồng bộ.

**Đích**: `schema.json`, `src/schema/config-schema.ts`

**Steps**:
1. Regenerate `schema.json` từ TypeBox schema (script `scripts/generate-schema.ts` nếu có; nếu không thì update manually + diff review).
2. `npm pack --dry-run` capture file list, snapshot vào test (`test/unit/package-files.test.ts`).

**Acceptance**: schema.json reflect mọi field config; snapshot test verify không drop file ship.

---

### Task #81 — CHANGELOG + release prep

**Lý do**: Theo AGENTS.md global Section 2, mỗi PR cần Files & Rationale + Tests + Risks/Rollback. Phase 6 sẽ ship qua nhiều mini-release.

**Đích**: `CHANGELOG.md`

**Steps**:
1. Thêm sections theo nhóm Tier:
   - `## 0.1.30 — async/concurrency hardening` (T60–T63, T79).
   - `## 0.1.31 — resume durability + adaptive repair` (T64–T67).
   - `## 0.1.32 — model routing observability` (T68–T69).
   - `## 0.2.0 — refactor: subagent runtime + register split` (T70–T75) — minor bump vì internal API thay đổi.
   - `## 0.2.1 — skills + docs` (T76–T78).
2. Mỗi entry follow format: `### Added / Changed / Fixed / Breaking Changes`.

**Acceptance**: CHANGELOG đầy đủ; `npm version` script chạy clean.

---

## Phụ lục A — Acceptance gate cho mỗi mini-release

Trước khi tag/publish:

```bash
# Hard gate
npm run typecheck
npm run test:unit
npm run test:integration
npm pack --dry-run

# Soft gate (manual)
/team-doctor    # in Pi smoke session
/team-validate
/team-autonomy status

# Cross-platform
# Trigger CI ubuntu/windows/macos workflow trước khi tag
```

## Phụ lục B — Bảng phụ thuộc giữa task

```
T60 ──► T61 ──► T62
                ▲
T63 (độc lập) ──┘
T64 ──► T65 ──► T66
T67 (độc lập)
T68 ──► T69
T70 ──► T71 ──► T72
T73 ──► T74 ──► T75 (cần T70 ổn định trước)
T76 (độc lập)
T77 ──► T78
T79 phụ thuộc T63 (concurrency cap), T65 (async-died)
T80 phụ thuộc T63
T81 sau cùng
```

## Phụ lục C — Ánh xạ mỗi task ↔ rủi ro/follow-up đã nêu

| Task | Nguồn yêu cầu |
|---|---|
| T60–T62 | Test report risk #2 + Phase analysis "fail-fast nếu jiti fail" |
| T63 | Test report risk #4 |
| T64–T66 | Test report risk #5 + refactor map "async restart recovery" |
| T67 | refactor-map "adaptive planner repair/retry" |
| T68–T69 | refactor-map "model routing transparency persisted" |
| T70–T72 | AGENTS.md "small modules" + analysis "register.ts/team-tool.ts/task-runner.ts cồng kềnh" |
| T73–T75 | refactor-map "consolidate subagent runtime into src/subagents/*" |
| T76 | analysis "skills/ trống" |
| T77–T78 | analysis "doc kiến trúc trỏ ra ngoài package" + onboarding |
| T79 | refactor-map "real integration smoke scripts" |
| T80–T81 | release hygiene |

## Phụ lục D — "Reply with" template cho mỗi PR

Mỗi PR Phase 6 phải tuân thủ AGENTS.md Section 10:

```
Summary: <1 dòng impact>
Plan:
- <bước 1>
- <bước 2>

Files & Rationale:
- src/.../...: <lý do>

Tests:
- <test name>: <kịch bản>

Verification:
- npx tsc --noEmit → Passed
- npm run test:unit → 0 failed / N passed
- npm run test:integration → 0 failed / N passed
- npm pack --dry-run → file list match snapshot

Risks & Rollback:
- <rủi ro>
- <feature flag / revert plan>

Security & Perf Notes:
- <OWASP / RAM / IO>
```

---

**Khuyến nghị triển khai**:
1. Đi theo thứ tự Tier (P0 → P3); không pha trộn refactor lớn (T70–T75) với hardening (T60–T67).
2. Mỗi Tier ship 1 mini-release để có baseline ổn định trước Tier kế.
3. Trước Tier 3 (T70–T75) chạy full test trên CI Windows + macOS để bắt regression cross-platform.
4. Sau mỗi task: chạy `/team-doctor` trong Pi session để smoke; mở dashboard `/team-dashboard` xác nhận không stale.
