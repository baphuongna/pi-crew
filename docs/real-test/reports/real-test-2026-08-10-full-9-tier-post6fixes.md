# real-test-pi-crew — Run Report (post-6-fixes final re-verification)

**Date**: 2026-08-10
**Trigger**: user request — "chạy skill real test pi-crew toàn bộ 9 tier" (full re-run AFTER all 6 fixes landed + bundle loaded)
**Repo HEAD**: `919d7a92` (v0.9.65) — working tree contains all 6 fixes (uncommitted)
**Bundle md5 (disk)**: `006ef4fde385d6f4070f1c6e72672823` (6 fixes; byte-identical rebuild)
**Pi version**: 0.84.1 (PID 814003, started 22:30:05 — on the 6-fix bundle)
**Run by**: pi agent (post-6-fix full battery)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 101/101 pass, 0 fail, 0 skipped, 24.0s |
| 2 3-path kill-switch | ✅ | default / `PI_CREW_BROKER=0` / `PI_CREW_BROKER=1` all 101/101 |
| 3 typecheck + bundle | ✅ | tsc exit 0 ("strip-types import ok"); bundle 2872.1 KB rebuilt byte-identical `006ef4fd...` |
| 4 bundle md5 sync | ✅ | disk = consuming-project = session-loaded `006ef4fd...`; session PID 814003 on fix bundle; byte-identical rebuild (no staleness) |
| 5 tmux TUI probe | ✅ | `/teams` reached TUI; dashboard Esc open/close (screen changed). No src/ui/ change (sanity smoke) |
| 6 pty probe | ✅ | `pty_probe.py` spawned fresh pi, rendered startup screen ("Press ctrl+o...") |
| 7 smoke team run | ✅ | runId `team_20260810153729_399ed249d74d83d7`, 3/3 tasks, consistency=1, verifier ~36s actual (257s wall, no hang <300s), 101/101 + tsc clean |
| 8 final md5 sync | ✅ | disk `006ef4fd...` = consuming project `006ef4fd...`; byte-identical; no stray edits |
| 9a read-only battery | ✅ | 10/10 — list / recommend / health / doctor / status / events / summary / get / explain / worktrees. Runs show `observable=3/3, needsAttention=none` + ZERO `task.output_validation` events |
| 9b spawn paths | ✅ | 5/5 — sync (Tier 7), async (`team_20260810154245_12e33fa8424e0d02`, 3/3), chain 2-step (2/2 handoffs), direct Agent (pid 865080), crew_agent bg (pid 865376). All `PI_CREW_KIND=subagent` |
| 9c lifecycle | ✅ | status details=true, cache (71.4% hit), checkpoint ("No checkpoint found"), resume ("Resumed ... completed, Tasks: 3"), retry (FIX 4: "already completed; retry only applies to failed/cancelled runs") |
| 9d destructive | ✅ | state clean: health `stuck=0 zombie=0`, all 15 runs healthy. No destructive action needed |
| 9e admin | ✅ | workflow-list (12), validate (1 pre-existing warning: dwf-smoke), config (FIX B: **"Config unchanged (no effective changes)."**) |
| 9f background | ✅ | auto-summarize, anchor ("No anchor set"), schedule FIX A round-trip: `0 9 * * MON` registered (next **2026-08-17 Monday**) → listed → removed |

## All 6 fixes — re-verified LIVE this run

| Fix | What | Live evidence this run |
|---|---|---|
| **1** cross-project run lookup | `explain`/`worktrees` use `locateRunCwd` | 9a: both resolved a run created in `pi-crew/.crew` from session root (task table / "(none)") |
| **2** output-validator markdown | `ROLE_PATTERN_DEFS` accept markdown | Tier 7 + 9b runs: `observable=3/3, needsAttention=none`, ZERO `task.output_validation` failure events |
| **3** config read non-mutating | `updateConfig` skip-if-unchanged | 9e: config returns **"Config unchanged (no effective changes)."** (no file rewrite) |
| **4** retry clear message | pre-lock `retryShortCircuitsCompleted` | 9c: retry on completed run → "already completed; retry only applies to failed/cancelled runs." |
| **5** cron parser (step + named) | `cronFieldMatches` handles `*/N`, `MON`, `JAN` | 9f: `0 9 * * MON` registered, next **2026-08-17** (Monday); standalone `*/30`, `9-17/2`, `0 0 1 JAN *` all resolve |
| **6** config "unchanged" message | `written` flag → accurate headline | 9e: "Config unchanged (no effective changes)." when skip-write fires |

## Findings (non-blocking)

1. Pre-existing `validate` warning: `workflow:dwf-smoke: Workflow has no steps.` — non-blocking, dynamic-workflow file exists but declares no steps.
2. No new findings. All previously-identified issues (cross-project lookup, output_validation false-positives, config rewrite, retry wording, cron grammar, config message) are now fixed and live-verified.

## What was NOT run + why

- **9d destructive ops**: state already clean (`stuck=0 zombie=0`, all healthy). No stale state to act on; `cleanup`/`prune` handlers proven in earlier runs.
- **9e full workflow-create CRUD round-trip**: requires a `.dwf.ts` source; validation gate proven in earlier runs.
- **9c live mid-run steer/cancel**: spawn probes completed too fast to keep a run alive; `resume`/`checkpoint`/`retry`/`status details` exercised on completed runs (same handlers).

## Restart needed?

- [x] **No** — session on the 6-fix bundle `006ef4fd...` (PID 814003). All 6 fixes live-verified. Nothing pending.

## Verdict

**All 9 tiers pass with evidence. All 6 fixes re-verified LIVE** (cross-project explain/worktrees, output_validation `valid:true`, config no-rewrite + "unchanged" message, retry clear message, cron step+named-DOW support). test:critical 101/101, typecheck exit 0, bundle synced, state clean, no unauthorized edits, no hangs. **pi-crew is healthy and all 6 fixes confirmed working end-to-end. Ready to commit.**
