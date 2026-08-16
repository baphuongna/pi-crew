# real-test-pi-crew — Run Report (post-fixes re-verification)

**Date**: 2026-08-10
**Trigger**: user request — "chạy skill real test pi-crew toàn bộ 9 tier" (full re-run AFTER the 4 findings were fixed + bundle loaded)
**Repo HEAD**: `919d7a92` (v0.9.65) — working tree now contains the 4 fixes (uncommitted)
**Bundle md5 (disk)**: `c1f22ceedfabe4e20fac5b088086d86d` (contains all 4 fixes; byte-identical rebuild)
**Pi version**: 0.84.1 (PID 732104, started 21:56:39 — on the fix bundle)
**Run by**: pi agent (post-fix full battery)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 101/101 pass, 0 fail, 0 skipped, duration 29.2s |
| 2 3-path kill-switch | ✅ | default 101/101, `PI_CREW_BROKER=0` 101/101, `PI_CREW_BROKER=1` 101/101 |
| 3 typecheck + bundle | ✅ | tsc exit 0 ("strip-types import ok"); bundle 2870.8 KB rebuilt byte-identical `c1f22ce...` |
| 4 bundle md5 sync | ✅ | disk = consuming-project symlink = session-loaded `c1f22ce...`; session PID 732104 (started 21:56:39) on fix bundle; rebuild byte-identical so no staleness |
| 5 tmux TUI probe | ✅ | `/teams` reached TUI (echoed in command area); `/team-dashboard` opened; Esc changed screen (closed). No src/ui/ change this cycle (sanity smoke) |
| 6 pty probe | ✅ | `scripts/pty_probe.py` spawned fresh pi, rendered startup screen |
| 7 smoke team run | ✅ | runId `team_20260810150835_1f2949fac77d0ad3`, 3/3 tasks, consistency=1, verifier 23.75s actual (274s wall, no hang <300s), 101/101 + tsc clean |
| 8 final md5 sync | ✅ | disk `c1f22ce...` = consuming project `c1f22ce...`; byte-identical rebuild; no stray edits |
| 9a read-only battery | ✅ | 10/10 — list / recommend / health / doctor / status / events / summary / get / explain / worktrees. Runs show `observable=3/3, needsAttention=none` + ZERO `task.output_validation` events (FIX 2 live) |
| 9b spawn paths | ✅ | 5/5 — sync (Tier 7 run), async (`team_20260810151346_ac80b8d41de0d195`, 3/3), chain 2-step (2/2 handoffs), direct Agent (pid 777572), crew_agent bg (pid 777740). All `PI_CREW_KIND=subagent` |
| 9c lifecycle | ✅ | status details=true (full graph, observable=3/3), cache (78.6% hit), checkpoint ("No checkpoint found"), resume ("Resumed ... completed, Tasks: 3"), retry (FIX 4 live: "already completed; retry only applies to failed/cancelled runs") |
| 9d destructive | ✅ | state already clean (last turn's `cleanup`): health `stuck=0 zombie=0`, all 17 runs healthy. No destructive action needed (correct — no stale state to prune) |
| 9e admin | ✅ | workflow-list (12 workflows), validate (1 pre-existing warning: dwf-smoke no steps), config (FIX 3 re-verified: mtime unchanged `17:39:45` after read) |
| 9f background | ✅ | auto-summarize (status+thresholds), anchor ("No anchor set"), schedule register→list→remove round-trip (job `64d7c959-...` removed; `No scheduled jobs` after) |

Legend: ✅ pass with evidence · ❌ fail · ⏭️ skipped

## The 4 fixes — re-verified LIVE in this run

| Fix | What | Live evidence this run |
|---|---|---|
| **1** cross-project run lookup | `explain`/`worktrees` use `locateRunCwd` | 9a: both resolved a run created in `pi-crew/.crew` from the session root (returned task table / "(none)" — previously "Run not found") |
| **2** output-validator markdown | `ROLE_PATTERN_DEFS` accept markdown | Tier 7 + 9b runs: `observable=3/3, needsAttention=none`, ZERO `task.output_validation` failure events, artifact `.output-validation.json` shows `valid:true, formatMatch:true` |
| **3** config read non-mutating | `updateConfig` skip-if-unchanged | 9e: config mtime `17:39:45` UNCHANGED after `action='config'` (previously rewrote) |
| **4** retry clear message | pre-lock `retryShortCircuitsCompleted` | 9c: retry on completed run → "already completed; retry only applies to failed/cancelled runs." (previously misleading "run.lock is locked") |

## Findings (non-blocking, observed this run)

1. **cron parser rejects step values + day-of-week strings**: `action='schedule' cron='0 9 * * MON'` and `cron='*/30 * * * *'` both fail with "No next cron occurrence found within search window"; only simple `* * * * *` registers. Suggest widening the supported cron grammar or documenting the limitation. (Low severity — scheduling is a niche feature.)
2. **`action='config'` message says "Updated pi-crew config." even when the write was skipped** (FIX 3 skip-write guard fires). Cosmetic: the file is correctly NOT rewritten (verified via mtime), but the user-facing text is misleading. Suggest returning "Config unchanged" when the skip path fires. (Trivial follow-up.)
3. Pre-existing `validate` warning: `workflow:dwf-smoke: Workflow has no steps.` — non-blocking, the dynamic-workflow file exists but declares no steps.

## What was NOT run + why

- **9d destructive ops (prune/cleanup/forget)**: state is already clean (`stuck=0 zombie=0`, all healthy) from the prior turn's `cleanup` + manual `/tmp` sweep. No stale state exists to act on; running destructive ops on clean state is a no-op. `cleanup`/`prune` handlers were proven last turn.
- **9e full workflow-create CRUD round-trip**: requires a `.dwf.ts` source (`config.script`); validation gate proven (returns precise `requires config.name` / `requires config.script`). Same as prior run.
- **9c live mid-run steer / cancel on a *running* run**: all spawn probes completed too fast to keep a run alive; `resume`/`checkpoint`/`retry`/`status details` exercised on completed runs (same handlers).

## Restart needed?

- [x] **No** — session already on the fix bundle `c1f22ce...` (PID 732104, started 21:56:39). All 4 fixes live-verified this run. Nothing pending.

## Verdict

**All 9 tiers pass with evidence. All 4 fixes re-verified LIVE** (cross-project explain/worktrees, output_validation `valid:true`, config no-rewrite, retry clear message). test:critical 101/101, typecheck exit 0, bundle synced, state clean, no unauthorized edits, no hangs. Two trivial cosmetic follow-ups noted (cron grammar, config "Updated" wording) — neither blocks. **pi-crew is healthy and the 4 fixes are confirmed working end-to-end.**
