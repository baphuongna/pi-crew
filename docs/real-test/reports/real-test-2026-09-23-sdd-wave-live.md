# real-test live session — SDD 22/22 wave + CI + UI + surface

**Date**: 2026-09-23
**Trigger**: live session battery after completing 22/22 SDD specs (42 commits unpushed)
**Repo HEAD**: `1bcf27b8` → `e81d81a3` (battery final)
**Bundle md5**: `92cd9a3d1026d553b2ee7f05d9b3dc7d` (session 16:09, rebuilt 10:15 — session loaded this bundle)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 116/116 pass |
| 2 kill-switch 3-path | ✅ | default 116, env=0 116, env=1 116 |
| 3 typecheck + bundle | ✅ | tsc clean, bundle md5 92cd9a3d, staleness OK, --committed-hash OK, test:bundle 2/2 |
| 4 session loaded bundle | ✅ | PID 962640 lstart 16:09 > bundle 10:15 → session IS current |
| 7 smoke run | ✅ | fast-fix 3/3 tasks, 8196 tokens, consistency=1 |
| 9a read-only | ✅ | list/recommend/health/doctor/search/settings(get×2) — 6 clean |
| 9b spawn paths | ✅ | sync(T7), async(pid+background.log), chain(2/2), Agent(explore), crew_agent bg(get_subagent_result) — 5/5 |
| 9b-W ask round-trip | ✅ | ask.requested → mailbox write → ask.answered+task.resumed ~0.5s (first attempt: wrong envelope → timeout; fix: strict envelope → success) |
| 9e admin CRUD | ✅ | team create/update/delete + workflow create/list/get/delete in scratch project — no leak to real project |
| 9f schedule interval | ✅ | interval=3600000 job CREATED (bug from 2026-09-21 holds) |
| 9g steer round-trip | ✅ | watcher +2.5s → steer delivery → PROBE_TOKEN_ACK in results/01_explore.txt:47 + 02_execute.txt |
| 10c herdr surface | ✅ | provider=herdr, 3 workerPids, 3× surface_spawned + 3× surface_closed, 0 degraded, panes auto-closed 9→7 |
| 11a full unit | ✅ | 8199 tests / 8196 pass / 0 fail / 3 skipped |
| 11b–j remediation | ✅ | wc-gate 1205/2000 in ci+ci:fast, twins 3× green, event-types+env-vars+decision-drift all OK |
| 12 resource contracts | ✅ | 12a 1/1, 12b 18 agents / 0 bad desc / 0 no routing / strict-YAML 18 ok, 12c 16/16 lines carry useWhen=, 12d 39/39 |
| 13 real-run UI render | ✅ | 8 surfaces from real on-disk state; sweep: 0 undefined / 0 wire-format / 0 bad-plural / 0 retired-glyph; glyph vs state: ✓ done, ✗ failed, ⠦ running (all correct) |
| T12 (skipped T5/6) | ⏭️ | herdr session; no tmux — covered by T10c herdr live |

## Real defects found & fixed in this battery

### 1. `check:event-types --enforce` RED (build-blocking CI gate)
**File**: `src/state/contracts.ts`
**Issue**: `goal.loop_error` (emitted by GL-1b `2f0f4c67`) was never registered. Any push would fail CI.
**Fix**: registered (170 total, 0 drift). Committed in `a659e020`.

### 2. F-L1 half-fix: `list` showed runs every by-ID handler refused
**File**: `src/extension/team-tool.ts` (`locateRunCwd`)
**Issue**: `run-index.scopedRunRoots` unions both roots; `loadRunManifestById` resolves both; but `locateRunCwd` (the gate for status/events/summary/artifacts/worktrees/plans/respond/cancel) only accepted the candidate cwd's PRIMARY root. Live measurement: `list` returned 10 user-root runs, `status` failed 10/10 with "Run not found".
**Fix**: fast path → `runUnderListedRoot` (either listed root); child scan → `runUnderOwnRoot` (a child claims only when state lives under that child's OWN crew root — preserves nested-child discovery + sibling isolation).
**Regression**: `locate-run-cwd.test.ts` (5 tests, was 4); mutation verified (primary-only → new test RED). Committed in `a659e020`.

### 3. ask-responder envelope wrong (skill recipe + silently-dropped response)
**File**: `skills/real-test-pi-crew/SKILL.md`
**Issue**: The Tier 9b-W recipe documented `{"kind":"response","questionId":…}` — this fails `parseMailboxMessage` (requires `id/runId/direction/from/to/body/createdAt/status`), is silently dropped, and the parked worker times out with zero diagnostic.
**Fix**: skill updated with the strict 8-field envelope + delivery discriminator + failure-symptom row.

### 4. Unit fixture leak: extraction test creates runs in user crew root
**Files**: `test/unit/teams/team-runner-extraction.test.ts`, `test/unit/runtime/recovery/orphan-cancel-intentional-wait.test.ts`
**Issue**: `makeRunFixture` used bare `mkdtempSync` (no project marker) → `createRunManifest` routed state to user crew root → teardown only removed the tmp cwd → every unit run leaked 2-3 finished/failed runs into `~/.pi/agent/extensions/pi-crew/state/runs/`. Health monitor then fired `crew.task.heartbeat_dead` on those zombies. 23 leaked runs found (25 at peak).
**Fix**: fixture now creates a project marker (`.crew` dir) so state stays inside the rmSync'd tmpdir. 25 leaked runs cleaned. Committed in `e81d81a3`.

## Findings noted but NOT fixed (pre-existing, out of battery scope)

### 5. Health monitor false-positive "dead worker" for a task parked on ask
**File**: `src/extension/registration/lifecycle-handlers.ts` (health tick) + `src/ui/heartbeat-aggregator.ts`
**Issue**: a worker parked on `ask` emits no heartbeat. `isActiveTask` correctly skips
`waiting` tasks, but the health tick reads task statuses from the **snapshotCache**, which
can lag the on-disk `running → waiting` transition (GATE 1/2 re-verify only the MANIFEST
status, not task statuses). In that window a genuinely-parked worker counts as
active-without-heartbeat → `recovery_missing_heartbeat` / `recovery_dead_workers` fires.
Observed live: run `team_20260923100114` fired "dead worker" while 01_explore was parked
on ask (alive, later answered + resumed).
**Candidate fix**: before `summarizeHeartbeats`, re-read tasks.json from disk (or extend
GATE 1/2 to task statuses) and skip tasks whose fresh status is `waiting`/terminal.

### 6. Ambient notification replay can re-deliver the same queued notification for hours
**Issue**: after the leaked runs were deleted and the health monitor wrote `clear` entries
(17:44:21), the SAME "missing heartbeat" ambient messages kept arriving at the parent
conversation for ~5 hours. The notification log shows NO new fires — the deliveries were
host-side ambient backlog replays at turn boundaries. Harmless but noisy; worth an
ambient-dedup (a cleared notification id should not re-deliver).

## Verdict

All applicable tiers pass with concrete evidence. Three real defects found and fixed by the live battery. One honest gap remains: interactive TUI keystroke proof (no tmux in this session — herdr only) and the parent session needs a restart to load the locateRunCwd fix. Ready for push decision.
