# real-test FULL battery re-run — every tier, no skips

**Date**: 2026-09-23 (evening, post-restart)
**Trigger**: user challenge "chạy full luôn không né cái nào hết" — every tier runnable in this environment, including the ones skipped in the morning pass (T5/T6/T9c/T9d/T10a/T10b)
**Repo HEAD**: `6e764036` → `b811e1c0` (finding 7 fix landed mid-battery)
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

## Honest notes

- T9g first attempt steered into the worker's drain window (queued after its final turn, never delivered) — probe timing, not product; second attempt mid-task delivered with transcript-level proof. The skill's steer recipe could add "steer within the task's first ~30s or verify the task is still multi-turn".
- `resume` after `retry` on a dead-owner run works (retry re-queues, resume revives via background runner) — coherent pair semantics, documented here for the first time live.
- health report shows 96 stale `running` manifests in the user root (old crashed sessions' runs) + 128 zombie `/tmp` workspaces from unit tests — pre-existing hygiene debt, none affects this battery.
- The parent session runs bundle `7b275370`; finding 7 lives in `8fd99b7c` and goes live at next restart (child runners already use fresh source via strip-types).

## Verdict

**Full battery, zero skips**: every tier of the skill's decision table executed with real evidence, including all previously environment-blocked tiers (T5/T6/T10a/T10b scaffolded via own tmux server + detached probes). One new real defect (finding 7, cancel/retry race) found by T9d and fixed with regression + mutation proof inside the battery.
