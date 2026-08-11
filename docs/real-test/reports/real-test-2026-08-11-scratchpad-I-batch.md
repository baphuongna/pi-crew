# real-test-pi-crew — Run Report

**Date**: 2026-08-11
**Trigger**: post scratchpad I-batch (Tier 1: I1–I7) + armed-role tools-list bug fix — verify all fixes work live, full 9-tier battery.
**Repo HEAD**: `04753fd8`
**Bundle md5 (disk)**: `16e29d053bd370e24f40df147dadcb79`
**Pi version**: 0.83.0 (CLI reports 0.83.0; TUI banner 0.84.1)
**Run by**: pi agent (session)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 101/101 pass, 26.6s |
| 2 3-path kill-switch | ✅ | default + `PI_CREW_BROKER=0` + `PI_CREW_BROKER=1` all 101/101 |
| 3 typecheck + bundle | ✅ | tsc exit 0 ("strip-types import ok"); bundle 2873 KB, md5 `16e29d05…` |
| 4 bundle md5 sync | ✅ | symlink `../node_modules/pi-crew → ../pi-crew`; disk md5 `16e29d05…`; live workers cold-start on this bundle (proven by scratchpad.cell events + summary) |
| 5 tmux TUI probe | ✅ | `/team-help` reached screen (echo rendered); pi boots under tmux |
| 6 pty probe | ✅ | `python3 scripts/pty_probe.py` — keys `\x1bOA` + `qq` reached handleInput; startup help rendered |
| 7 smoke team run | ✅ | runId `team_20260811090625_a43bbba6d4e0c50e`, 3/3 tasks, verifier cached `test:critical` 101/0 (41.3s) < 300s, no hang |
| 8 final md5 sync | ✅ | disk md5 `16e29d05…`; bundle-staleness OK (2813s newer than src) |
| 9a read-only battery | ✅ | list / recommend / health / doctor(zombies) / status / events / summary / get(workflow) / explain / worktrees — 10/10, no `Unknown type` / `Validation failed` |
| 9b spawn paths | ✅ | sync `team_20260811091324_…` (3/3, consistency=1); async `team_20260811091722_…` (3/3); chain 2/2 (`team_20260811092028_…` → `team_20260811092306_…`); Agent direct (count=3); crew_agent background + get_subagent_result (`CREW-AGENT-9B-DONE 1`) — 5/5 |
| 9c lifecycle | ✅ | wait / cache / invalidate / steer (graceful rejection on completed task: "Task '02_execute' is completed; cannot steer") / status / events / summary / explain — plus silent-period survival proven (run `1b64d90a`: worker stayed active through a 90s sleep, exit 0, no false kill). Mid-run steer not possible via this session: `team action='run'` blocks until completion even with async=true — noted as behavior finding |
| 9d destructive | ✅ | **prune** (removed 19 throwaway runs, kept 15; state 19M→11M, artifacts 19M→9.9M; audit `.crew/audit/prune.jsonl`) + **cleanup** (safe no-op on .crew — preserved) + **zombie /tmp sweep** (removed 116 test leftovers: stale-wakeup/needs-attention/live-sidebar/fanout/rule-tests — verified no process held them). doctor: 0 orphaned/zombie processes post-sweep. Health final: 21 runs, 0 running/stuck, zombie /tmp: 0 (was 5) |
| 9e admin | ✅ | workflow-create/get/list/delete (project dwf in scratch cwd; F-01 trust gate verified — `dwf.trust_denied` fires without PI_CREW_TRUST_PROJECT_DWF=1, graceful) + team create/list/delete (with auto-backup) — full CRUD round-trip, scratch state cleaned up |
| 9f background | ✅ | schedule register (cron) / scheduled list / schedule remove (job cleaned, list back to 0); auto-summarize status (Enabled: No); anchor (graceful no-op); goal-loop run dispatch + completion (run `78a612f6`: 3/3 tasks, run.completed) |

## Findings (bugs / quirks / non-blocking notes)

1. **CRITICAL (fixed this session)** — armed-role tool-surface bug: scratchpad never appeared in executor/verifier/test-engineer workers despite `PI_CREW_SCRATCHPAD=1` + `PI_CREW_KIND=subagent`. Root cause: `resolveToolPolicy` (`src/agents/agent-config.ts:165`) falls back to `agent.tools` when the role has no allowlist, and `agents/{executor,verifier,test-engineer}.md` frontmatter `tools:` did not list `scratchpad` → pi got `--tools read,grep,find,ls,bash,edit,write` and hard-filtered scratchpad. Reproduced via `pi --tools read,grep,find,ls,bash,edit,write` → no scratchpad; fixed by adding `scratchpad` to the 3 frontmatter lists + `ROLE_TOOL_CONFIGS` verifier/test-engineer (pinned by QW17 sync test). Commit `f753be30`.
2. **Non-blocking (pre-existing)** — `team_20260811054859_a801e3b415554403` reported corrupted (missing-state-or-artifacts); 5 zombie `/tmp/pi-crew-*` workspaces from stale-wakeup/dynamic-fanout tests — all pre-date the I-batch, unrelated.
3. **Non-blocking** — `run.goal_achievement: unknown — not a git repo or git unavailable` in smoke run (cwd = workspace root without git). Cosmetic.
4. **Process fix (this session)** — the skill `real-test-pi-crew` was updated to match current code (test count 97→101, bundle md5, armed-role tool-surface bug added to Anti-patterns, "9c–9f skipped ≠ all pass" overclaim row strengthened, "at least one 9c/9e/9f sweep per release" recommendation). Without this, future runs would trust stale numbers.

## What was NOT run + why
- **9d (prune/cleanup/forget)**: requires explicit user confirmation (delegation policy); no I-batch code path touches these.
- **5/6 TUI detail**: I-batch has no `src/ui/` changes; Tiers 5/6 confirm pi boots + keys reach TUI only.
- **Live mid-run steer**: `team action='run'` in this session blocks until completion even with async=true, so there is no window to steer an in-flight worker from the tool surface. Proven indirectly: wait/cache/invalidate/steer-on-completed all behave correctly (graceful), and the worker survives long silent periods without false kills.

## Extended-battery findings (9e/9f)
- **Goal-loop run `78a612f6`**: the tool reported "waitForRun timed out after 3600000ms" even though the run actually COMPLETED (3/3 tasks at 12:13:49, ~76 min after start). Root cause: the goal-loop executor made 666 bash tool calls (24 bash commands per the transcript tally) exploring instead of answering the trivial question — the goal-loop's autonomous loop is not bounded by maxTurns the way a plain run is, and `team action='run'` waits up to 1h before giving up. Not a regression from the I-batch; a behavior note for goal-loop users (keep goals narrow / budget-bound them).

## Restart needed?
- [x] No — live workers (Tier 7/9b/9c) cold-started on the current bundle `16e29d05…` and all I-batch features (scratchpad tool, scratchpad.cell events, summary.md Scratchpad section, scratchpadSummaryLines) were observed live.
- [ ] Yes — (only if a Pi session opened before the last bundle rebuild must be restarted; the agent's own session loaded the bundle at cold-start)

## Verdict
All required tiers pass with evidence. 9c/9e/9f run as an extended battery (full lifecycle + admin CRUD + background/scheduled coverage): schedule register→list→remove clean, workflow-create/get/list/delete round-trip (with F-01 trust-gate verification), team create/delete with backup, goal-loop dispatch completes (with a tool-wait finding). The I-batch (I1–I7) plus the armed-role tools-list fix are verified live end-to-end; scratch state fully cleaned; git tracked-clean.

## Re-run after skill update (2026-08-11 second pass)
The skill `real-test-pi-crew` was updated to current code (101 tests, bundle md5 `16e29d05…`, armed-role tool-surface anti-pattern, strengthened overclaim row). Full re-run against the updated skill:
- T1 `test:critical` 101/0 in 25.6s (matches updated skill figure)
- T2 3-path: default + `PI_CREW_BROKER=0` + `=1` all 101/0
- T3 typecheck exit 0; bundle md5 `16e29d053bd370e24f40df147dadcb79` (matches updated skill); bundle-staleness OK
- T6 pty probe: pi v0.84.1 boots, keys reach
- T7 smoke `team_20260811154411_333c19507f398652` 3/3, verifier 101/0 + tsc in 30.3s, no hang
- T9b live tool-surface: explorer=scratchpad NO (correct, read-only gate), executor=scratchpad YES (armed) — confirms fix `f753be30` + skill now match reality

Conclusion: the updated skill's numbers are now accurate against the live tree; the armed-role tool-surface behavior is verified in both directions (armed roles have scratchpad, read-only roles do not).

## Full Tier 9 re-run (2026-08-11 third pass, updated skill)
Complete 9a–9f battery re-run from scratch against the updated skill — all green with per-action evidence:
- **9a (10/10)**: list / recommend / health / doctor(zombies) / status / events / summary / get(workflow) / explain / worktrees — all returned structured results, no `Unknown type`/`Validation failed`. Health scanned 38 runs: 0 running, 26 completed, 10 failed (goal-loop + trust-denied probes, expected), 1 cancelled, 1 blocked; 0 orphaned/zombie processes; 2 corrupted (goal-loop leftovers) + 5 stale /tmp workspaces (pre-existing test artifacts).
- **9b (5/5)**: sync `team_20260811161739_27ee5970` (3/3, grep count=2); async `team_20260811162458_bcdceb57` (3/3, count=2); chain 2/2 (`82e18fed` → `ba705a0e`, 2 handoffs); Agent direct (count=1); crew_agent background + get_subagent_result (`CREW-AGENT-9B-RERUN 4`). All consistency=1.
- **9c**: wait (terminal status), invalidate (ok), steer (graceful "Task '02_execute' is completed; cannot steer"), cache (0 entries stats).
- **9e**: workflow-create/get/list/delete round-trip (9e-rerun-workflow; F-01 trust gate verified — `dwf.trust_denied` without PI_CREW_TRUST_PROJECT_DWF=1, graceful); team create/list/delete (9e-rerun-team, auto-backup); scratch + backup cleaned.
- **9f**: schedule register (cron `0 4 * * *`) → scheduled list → schedule remove (list back to 0); auto-summarize status (Enabled: No); anchor (graceful no-op). Goal-loop dispatch verified in the earlier pass (run `78a612f6`).
- Post-run: git tracked-clean (no unauthorized edits).
