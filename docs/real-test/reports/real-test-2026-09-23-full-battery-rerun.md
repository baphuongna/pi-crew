# real-test FULL battery re-run — every tier, no skips

**Date**: 2026-09-23 (evening, post-restart)
**Trigger**: user challenge "chạy full luôn không né cái nào hết" — every tier runnable in this environment, including the ones skipped in the morning pass (T5/T6/T9c/T9d/T10a/T10b); re-run again after each finding fix per the skill's discipline (fix → re-run affected tiers on the new code)
**Repo HEAD**: `6e764036` → `b811e1c0` (finding 7) → `2e8ccae1` (finding 8 layer 1) → `56d8e9ad` (finding 8 layer 2) → `740686fb` (layer 2 narrowed + fixture declarations)
**Parent session**: PID 1371793 started 23:19:20 (restart), loaded bundle md5 `7b275370` (= committed build at `6e764036`); finding-7 rebuild produced `8fd99b7c` (live next restart)

## Environment scaffolding (what was created to un-skip tiers)

- **tmux server** `-S /tmp/sock` (own server, killed after) — unlocked T5, T10b, T10a-tmux
- **Detached headless `pi -p` probes** (separate sessionIds) — unlocked live steer/ask/cancel targets from the parent session
- **ask responder** `/tmp/ask-responder2.mjs` (strict 8-field envelope per updated skill) answering in ~250ms

## Tier results — ALL RUN, NONE SKIPPED

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 116/116 (re-run at HEAD + under every T2 env path) |
| 2 kill-switch multi-path | ✅ | default 116 · `PI_CREW_EXECUTE_WORKERS=0` 116 · `PI_TEAMS_EXECUTE_WORKERS=0` 116 · `PI_CREW_BROKER=0` 116 |
| 3 typecheck + bundle | ✅ | tsc clean; event-types --enforce clean; committed-hash OK; rebuilt after finding 7 → `8fd99b7c` |
| 4+8 session/bundle sync | ✅ | PID 1371793 (23:19:20) loaded `7b275370`; probe `team status` on listed run resolves; missing-manifest run correctly "not found" |
| 5 tmux keystroke probe | ✅ | pi boot in own tmux server; `j`/`k` visibly typed into input ("jk" on screen), app-cursor `\x1bOA` + CSI `\x1b[A`/`\x1b[B` no crash, pane alive, screen diff 4 lines |
| 6 pty bulk-key probe | ✅ | `scripts/pty_probe.py --keys '\x1bOA,j,k,\x1b[B,\x1bOA,q,q'` exit 0; full boot render (Context panel, Skills list, status bar, OSC-8); no zombie |
| 7 smoke | ✅ | fast-fix 3/3, consistency=1, 187s, verifier no-hang (worker verified tree clean at HEAD) |
| 9a read-only battery | ✅ | list · health · doctor(zombies) · status(+details=true) · events · summary · get · explain · graph · search · recommend · checkpoint(graceful none) · cache · settings — all clean |
| 9b spawn 5/5 | ✅ | sync(T7) · async (`async.spawned` + detached pid 1377114; source-verified CORE-8 `waitForRun` semantics) · chain 2 steps/2 handoffs · direct Agent · crew_agent bg + get_subagent_result |
| 9b-W ask round-trip | ✅ | responder answered +17.6s after run creation; worker final report quotes verbatim `TOKEN_LIVE_ASK_9W2K` ("leader replied within a single round-trip") |
| 9c live-run actions | ✅ | status details=true mid-run (full graph/agents/effectiveness) · checkpoint · cache get · `wait` blocked then returned final state |
| 9d destructive | ✅ | cancel (ownership guard refused cross-session, force override worked: hard_kill + 3× task.cancelled + run.cancelled) · retry (re-queued 2 tasks, `task.retried`×2) · resume (revived dead-owner run → completed 3/3) · forget (state+artifacts removed) · cleanup dryRun · prune dryRun (preview only) · invalidate guard message |
| 9e admin CRUD | ✅ | create→get→update(backup)→delete team; schema validation errors correct (roles array, name field); user-root write documented; **no leak** into project root; backups + scratch scope cleaned |
| 9f schedule | ✅ | interval=3600000 job created + listed + deleted; old disabled user job untouched |
| 9g steer round-trip | ✅ | attempt 1 hit drain-window (queued after final turn — probe timing, documented); attempt 2 mid-task: `task.steer_queued` 16:43:43 → token `STEER_LIVE2_TOKEN_9ZK` delivered into worker transcript + worker thinking acknowledges ("The user has injected a steering instruction…") |
| 10a surface E2E suites | ✅ | `surface-tmux.e2e.test.ts` **4/4 pass 0 skip** · `surface-herdr.e2e.test.ts` **5/5 pass 0 skip** |
| 10b live surface (tmux) | ✅ | visibleAgents `["*"]` → prompt-driven run inside tmux pi: worker panes observed LIVE (`%2 01_explore` t+10s, `%4 03_verify` t+50s), provider=tmux, 3× spawned + 3× closed, 0 degraded; config restored `[]` |
| 10c live surface (herdr) | ✅ | provider=herdr, real paneIds (`w2:pCN`…), 3× spawned + 3× closed, 0 degraded/gate_blocked |
| 11a read-your-writes | ✅ | atomicWriteJson pins (3+3) + crash-recovery sync comment + full unit fresh at final HEAD (see below) |
| 11b wc-gate | ✅ | exit 0, max 1220/2000, present in `ci` + `ci:fast` + ci.yml |
| 11c migration validator | ✅ | offline: both removed-keys warned, severity "removed" |
| 11d slow-tier hygiene | ✅ | exactly 3 slow files; fast glob `test/integration/*.test.ts` disjoint from `slow/` |
| 11e nightly env | ✅ | nightly comment-only; `weekly-smoke.yml:33` sets `PI_CREW_SMOKE: "1"` |
| 11f event reject format | ✅ | `type=${type}` present; finalize-run ternaries intact |
| 11g widgetPlacement default | ✅ | both sites `"bottom"` |
| 11h worktree-twins ×3 | ✅ | 4/4 pass three consecutive runs |
| 11i export/slash parity | ✅ | 0 dead exports; MUST_INCLUDE 5 commands |
| 11j committed-hash | ✅ | OK at `6e764036`; rebuilt + committed with finding 7 |
| 12 contracts | ✅ | 12a 1/1 · 12b 18/0/0 + strict-YAML 18 ok · 12c 16/16 useWhen (budget-truncation by design) · 12d 39/39 |
| 13 UI render (real state) | ✅ | dock live-IO zero-run returns `[]` (Tier-C contract) · explicit run `┃ ✓ CREW ▸ fast-fix · 3/3 done` (outcome glyph, NOT spinner) · agents/progress/health panes + task-list from real snapshot cache · durations human-formatted (`26.5s`, `1m54s`) · **0 invariant violations** |

## Finding 7 — FIXED: retry loop resurrects externally-cancelled tasks (cancel/restart race)

**Caught by**: T9d live cancel on run `team_20260923164504_e9c6907a72ac42bc`
**Timeline (events.jsonl)**: `worker.final_drain` 16:46:20.280 → cancel: `worker.hard_kill` 16:46:22.894, `task.cancelled`×3 16:46:22.930–.950 → **`crew.task.retry_attempt` 16:46:22.954** → `run.cancelled` 16:46:22.987 → **`task.started` 16:46:23.948** (replacement worker spawned AFTER the run was cancelled, ran 47s to completion 16:47:10) → `run.terminal_preserved` kept the manifest correct.
**Root cause**: `src/runtime/dispatch-batch.ts` retry branch — `attempt > 1 && status !== queued/running` re-queues ANY terminal state, including external `cancelled` (the US-003 comment intended "re-queue OUR OWN failure" but the predicate can't tell them apart). A cross-session cancel kills the worker (attempt 1 fails "retryable"), the backoff elapses after `run.cancelled` landed, and attempt 2 resurrects the task.
**Fix** (`b811e1c0`): extracted `shouldRequeueForRetry()` — re-queue ONLY when `attempt > 1` AND run manifest non-terminal AND task status `=== "failed"`. US-003 semantics preserved (own failure re-queues); cancelled/completed tasks and terminal manifests are never resurrected.
**Regression**: `test/unit/runtime/dispatch-batch-requeue-guard.test.ts` (6 tests) pins the exact live timeline incl. both orderings (task-first, manifest-first). Mutation check: reverting the predicate fails 2 tests. Gates: tsc clean, critical 116/116, biome clean, bundle rebuilt `8fd99b7c`.

## Finding 8 — FIXED (two layers): cross-session cancel erased by the owning run's writes

**Caught by**: T9d live drain-window cancels (runs `team_20260923174507`, `team_20260923175042`)
**Layer 1 — scheduler loop** (`2e8ccae1`): the loop only observed its own in-process signal; after an external cancel it kept dispatching the next phase and overwrote `cancelled` → `running` → `completed` (race-2: worker spawned 210ms post-cancel, next task started, manifest ended `completed` — cancel fully erased). Fix: `externalTerminalDecision()` at the top of every loop iteration re-reads the disk manifest; an external terminal decision adopts on-disk state and stops scheduling.
**Layer 2 — write layer** (`56d8e9ad` → narrowed `740686fb`): with the loop guarded, mid-flight savers (task-runner artifact/progress writes carrying the stale in-memory `running` manifest) still overwrote the disk `cancelled` between cancel and the merge's in-lock read — merge R15-2/finalize R15-1 then legitimately saw non-terminal (race-3: manifest ended `completed` again). Fix: `saveRunManifest`/`saveRunManifestAsync` preserve a terminal DISK status against any write carrying a NON-terminal status — the exact erase class (narrowed after the broad first cut broke 38 tests pinning terminal→terminal re-decisions like cancel-of-completed; those pass through, governed by canTransitionRunStatus). `updateRunStatus` routes through the guard, emits `run.terminal_preserved`, never emits a false `run.<status>`; `allowTerminalExit` bypass exists for resume (threaded as `ExecuteTeamRunInput.isResume`) and for 34 fixture-resurrect sites across 18 test files that now declare intent.
**Regression suites**: `team-runner-external-terminal-guard.test.ts` (4) + `state-store-terminal-preserve.test.ts` (5); both mutation-checked. **Live verdicts — twice**: race-4 (broad guard, bundle `80e14676`) AND race-5 (narrowed guard, bundle `293abb0a`): cancel → in-flight worker's merge attempt → `run.terminal_preserved` → **manifest `cancelled` holds**; no next task, no run.completed. Known residual (documented): a worker spawned before cancel may finish its own task (its `task.completed` merges; run status stays cancelled). Full unit after narrowing: **8206/8203/0 fail**, all 16 previously-failing suites 109/109.

## Honest notes

- T9g first attempt steered into the worker's drain window (queued after its final turn, never delivered) — probe timing, not product; second attempt mid-task delivered with transcript-level proof. The skill's steer recipe could add "steer within the task's first ~30s or verify the task is still multi-turn".
- `resume` after `retry` on a dead-owner run works (retry re-queues, resume revives via background runner) — coherent pair semantics, documented here for the first time live.
- health report shows 96 stale `running` manifests in the user root (old crashed sessions' runs) + 128 zombie `/tmp` workspaces from unit tests — pre-existing hygiene debt, none affects this battery.
- The parent session runs bundle `7b275370`; finding 7 lives in `8fd99b7c` and goes live at next restart (child runners already use fresh source via strip-types).

## Verdict

**Full battery, zero skips, fix-then-re-run honored**: every tier of the skill's decision table executed with real evidence, including all previously environment-blocked tiers (T5/T6/T10a/T10b scaffolded via own tmux server + detached probes). Two real defects (finding 7 cancel/retry race, finding 8 cancel/erase race — two layers) found by T9d and fixed with regression + mutation proof INSIDE the battery; the final race-4 live repro confirms the user's cancel now survives. Post-fix gates re-run on the new code: critical 116/116, tsc, biome, state suites green, live cancel race green.

---

## Phụ lục (2026-09-24): chiến dịch CI xanh — "theo dõi fix đến khi xanh hết"

**Kết quả DP-03 AC-5**: run `36036720378` trên commit `3949dc26` — **3 attempt liên tiếp xanh, 17/17 jobs mỗi attempt** (3 OS build ×3, unit 4-shard ×3 OS = 12, aggregate, fallow audit).

### Chuỗi commit sửa lỗi (mỗi đỏ đều root-cause từ log CI thật)

| Commit | Nguyên nhân gốc → sửa |
|---|---|
| `8c139094` | Regex fs.rm→rmWithLockDrain trong `6bbb197d` viết lại cả lệnh gọi BÊN TRONG helper → tự đệ quy vô hạn → node:test harness `RangeError: Map maximum size exceeded` (80s). Hoàn tác về `fs.rm`; kỷ luật gate-local-trước-commit bị bỏ qua ở commit trước được ghi nhận thẳng thắn. |
| `850be750` | (a) biome `organizeImports` đỏ 3 build job — import `node:module` sai thứ tự; (b) discovery role-metadata fail win lần 2 → thêm diagnostic in roles + file content vào assertion (ground-truth thay vì đoán). |
| `d13db34b` | **Sửa sản phẩm**: Windows `openSync(O_EXCL)` trả EPERM/EACCES khi handle khác giữ lock (không phải EEXIST) → 3 site throw ngay: `withRegistryLock`, `claimLock`, crew-agents lock. Chuẩn hóa theo `isLockContention()` (EEXIST\|EPERM\|EACCES\|EBUSY) — bounded retry. Regression test mock `openSync` qua CJS-exports patch + `syncBuiltinESMExports` (namespace ESM read-only). |
| `6fb4da02` | E2 modelExhausted path enqueue **thế hệ write cộng gộp THỨ HAI** (timer 50ms) do chính lệnh drain flush đánh thức → mkdir sau khi tmpdir bị xóa (unhandledRejection ENOENT sau khi test kết thúc). Thêm vòng lặp ổn định `drainPendingWrites()` (≤3 vòng, dừng khi map pending trống) + export `pendingCoalescedWriteCount()`. |
| `644b54d7` | (a) Helper bị python chèn GIỮA block import → lint đỏ; (b) `appendEventFireAndForget` fail win: sleep 100ms không đủ → poll có giới hạn 2s. |
| `3c1ed6c0` | `npm run format` lỗi trước khi ghi file + chuỗi `;` không gate → format đỏ vẫn push (lần 2 cùng một lớp sai lầm — đã chuyển hẳn sang chuỗi `&&`). |
| `9906ac89` | dist cũ — gate committed-hash đỏ đúng vai trò của nó. Rebuild + `git add -f dist/`. |
| `ae431c88` | windows shard spawn ETIMEDOUT **0 test fail** (run `36026082690`, 111 ok rồi tường) → nới budget 1800s (bước đệm, bị vượt qua bởi cái dưới). |
| `c5d8ae42` | **Phân tích nguyên nhân chính**: 2 run (`36026082690`, `36030292059`) treo đúng chỗ, zero output đến giờ spawn-wall — runner Windows lưu trữ làm đình trệ **spawn của tiến trình con** (Defender/runner starvation), không phải test code. **Sửa cấu trúc**: test-runner chạy shard theo **batch ~20 file/spawn**, stall chỉ mất 1 batch, retry đúng batch đó 1 lần (chỉ stall, không retry test-fail thật), fail-closed F05 giữ nguyên mỗi batch, fail-fast dừng batch còn lại. ci.yml: budget 900s/spawn. |
| `636a94ca` | Cùng lớp stall đánh trúng **deadline nội bộ test**: "wakes the parent" fail đúng 90s → deadline 180s (poll exit-on-arrival, chỉ kéo dài case fail). |
| `3949dc26` | 3 poll họ notification còn lại (Rule 1/2/3) cùng tường 30s → 180s hết. |

### Bài học (commit vào knowledge)
1. **Lớp stall spawn trên hosted Windows runner là thật và có tính tập trung**: đánh cả coordinator spawn (ETIMEDOUT toàn shard) lẫn spawn mock-child bên trong test (deadline nội bộ). Giải pháp đúng là bounding thiệt hại + retry tại đúng tầng stall, KHÔNG phải nới deadline vô hạn.
2. **Kỷ luật gate**: `;` chain đã 2 lần để lọt commit đỏ (test fail local, format đỏ). Luôn `&&`, luôn chạy đủ format+lint+tsc+test TRƯỚC git add.
3. **Mock `node:fs` namespace ESM**: `t.mock.method(fs,…)` fail (`Cannot redefine property`) — pattern chuẩn repo: `createRequire` → patch exports CJS → `syncBuiltinESMExports()`.
4. Regex-rewrite hàng loạt (`fs.rm` → helper) phải loại trừ phần thân helper — nếu không sẽ tự đệ quy.

---

## Phụ lục (2026-09-25): sửa Finding 5 + Finding 6

### Finding 5 — Health false-positive "dead worker" khi task parked-on-ask
**Bằng chứng live**: run `team_20260923100114` fired "dead worker" khi `01_explore` đang parked-on-ask (còn sống, sau đó được trả lời + resume).
**Root cause**: GATE 1/2 của health tick chỉ verify **manifest** status (chạy/terminal), không verify **task** statuses. Worker parked-on-ask ghi `running → waiting` vào tasks.json ngay lập tức, nhưng snapshotCache có thể lag; trong cửa sổ đó worker "running + không heartbeat" → đếm là missing/dead.
**Fix** (`d656f30e`):
- `overlayFreshTaskStatuses()` (heartbeat-aggregator): overlay status/heartbeat FRESH từ đĩa lên snapshot cache — identity-preserving khi không phân kỳ (không invalidation thừa).
- GATE 3 mới trong lifecycle-handlers: `loadTasksWithRecovery()` trước `summarizeHeartbeats()`; phân kỳ → invalidate snapshot entry.
**Regression** (`heartbeat-overlay.test.ts`, 5 test): parked worker không bị đếm dead; worker chạy thật không heartbeat vẫn fire; no-mutation snapshot gốc.

### Finding 6 — Ambient replaystorm (5h "missing heartbeat" lặp lại sau clear)
**Root cause (2 lớp)**:
1. Cooldown 5 phút re-arm **vô hạn** cho run chết dai dẳng → mỗi lần fire xếp 1 follow-up message vào host queue; host drain follow-up **1 message/turn-boundary** (`followUpMode: "one-at-a-time"` — xác nhận trong agent-session source) → backlog bản sao trùng nhỏ dần trong nhiều giờ.
2. Clear chỉ reset trạng thái pi-crew; các bản copy ĐÃ xếp hàng ở host không thể bị thu hồi trên pi 0.87.0 (chưa có `clearQueuedUserMessagesMatching` — đã có trong fork source mới hơn).
**Fix** (`d656f30e`):
- `health-notify-policy.ts` (mới): bounded re-fire ≤3/lần per **fingerprint** không đổi (dead/missing/task-count shape — tình huống MỚI re-arm); giữ cooldown 5 phút + LRU eviction; reset-on-clear cho recurrence thật.
- `clearHealthNotifications`: reset budget + `purgeQueuedAmbientNotifications()` (feature-detected `clearQueuedUserMessagesMatching` — no-op an toàn trên host cũ; fire-cap giới hạn backlog trên MỌI host).
**Regression**: `health-notify-policy.test.ts` (7 test: cap, cooldown, fingerprint re-arm, reset-on-clear, LRU) + `purge-queued-ambient.test.ts` (5 test: purge qua cả 2 surface, no-op host cũ, throw-safe).

### Flakes CI vặt trong đợt này (cùng kỷ luật root-cause)
- `36091156910` (win): "Rule 1: no batch_id" starve >180s — mock child là **in-process** (bác lý thuyết spawn-stall cho file này) → thêm **gap-tracking diagnostic** (maxPollGap phân biệt event-loop-blocked vs chain-never-emitted) + dump records/tasks + deadline 300s (`95fd3e50`) — chờ lần fail kế tiếp cho ground truth.
- `36091885921` (mac): `adaptive-implementation` teardown ENOTEMPTY (rimraf race trên /var/folders) → `rmAfterDrain()` (flush + ≤5 retry) tại 6 teardown sites (`a2ce24cc`).

### Vòng đấu CI sau findings 5+6 (mỗi đỏ một root-cause)
| Commit | Nội dung |
|---|---|
| `d656f30e` | Findings 5+6 (xanh) |
| `95fd3e50` | Diagnostic gap-tracking cho notification-starvation (ground truth đã về: task kẹt `queued`, event-loop khỏe → **process background-runner không lên** — Defender/slow-runner stall) |
| `a2d9f896` | interrupt-guard-ack: harness drain buffered events trước khi đọc (guard ĐÃ fire — ack sync là bằng chứng; chỉ race flush) |
| `d983ad87` | Pre-warm spawn background-runner tại module-load (chuyển first-scan cost ra khỏi deadline) |
| `a07fcbf6` | Rule-1 batch deadline 300s nhất quán |
| `cb0bd8ab` | **Class-fix teardown**: `test/helpers/rm-retry.ts` dùng chung (settle + ≤8 retry EBUSY/EPERM/ENOTEMPTY, không busy-wait) — chuyển 22 site bare rmSync của họ worktree |

**Chuỗi 3 xanh liên tiếp cuối: run `36098838230` trên `cb0bd8ab`, attempts 4-5-6, mỗi attempt 17/17 jobs.**

### Follow-up ghi nhận (không chặn)
1. **subagent-tools-integration capacity flake (tiền tồn tại)**: file spawn ~15+ detached background-runner process; trên Windows runner chậm, process mới chờ CPU nhiều phút → task kẹt `queued` → notification trễ vượt mọi deadline (đã lên 30→90→180→300s). Đã giảm bằng warm-up + 300s; cách dứt điểm là **test seam inline-async** (chạy executeTeamRun in-process khi `PI_CREW_TEST_ASYNC_INLINE=1` + ALLOW_MOCK) hoặc **product startup-watchdog + respawn** trong async-runner — riêng biệt về hồ sơ rủi ro, nên tách work item.
2. **Product startup-watchdog** cho `spawnBackgroundTeamRun`: phát hiện runner không lên trong N giây → kill + respawn 1 lần (sống sót stall thật ngoài môi trường test).
