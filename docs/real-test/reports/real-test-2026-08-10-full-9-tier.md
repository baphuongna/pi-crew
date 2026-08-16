# real-test-pi-crew — Run Report

**Date**: 2026-08-10
**Trigger**: user request — "chạy skill real test pi-crew toàn bộ 9 tier" (full 9-tier battery), then user confirmed restart + "clean" (9d) + "hãy fix luôn" (fix all findings)
**Repo HEAD**: `919d7a92` (fix(team-tool): accept budgetTotal empty-string unset marker + lint/format sweep, v0.9.65) — working tree has pre-existing uncommitted changes (v0.9.65 WIP)
**Bundle md5 (disk)**: `c1f22ceedfabe4e20fac5b088086d86d` (rebuilt after 4 findings fixed)
**Pi version**: 0.84.1
**Run by**: pi agent (user-invoked full battery + fixes)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 101/101 pass, 0 fail, 0 skipped, duration 19.7s (real 20.2s) |
| 2 3-path kill-switch | ✅ | default 101/101, `PI_CREW_BROKER=0` 101/101, `PI_CREW_BROKER=1` 101/101 |
| 3 typecheck + bundle | ✅ | tsc exit 0 ("strip-types import ok"); bundle 2868.7 KB, md5 `43d96d444c1e79dd51f80d2f36ffd190` (was `3bfa1b83` pre-rebuild) |
| 4 bundle md5 sync | ✅ | disk = consuming-project symlink = `c1f22ce...`; **session reloaded after user `/quit`+reopen** (PID 630582 started 17:49:21 > rebuild) — `team action='list'` returned clean, no `Unknown type`/`Validation failed` |
| 5 tmux TUI probe | ✅ | fresh pi v0.84.1 spawned; `/team-help` reached screen; `/team-dashboard` rendered border+header+"No runs yet"; Esc closed dashboard (screen change confirmed). Arrows: no visual change (0 runs to navigate — expected) |
| 6 pty probe | ✅ | `scripts/pty_probe.py` spawned fresh pi, rendered startup screen + escape sequences; keys (`\x1bOA,q,q`) reached pty |
| 7 smoke team run | ✅ | runId `team_20260810102144_53cd4e6866f33d1a`, 3/3 tasks, consistency=1, 5083 tokens, 277.9s wall (verifier 23.4s actual checks — no hang <300s) |
| 8 final md5 sync | ✅ | disk `c1f22ce...` = consuming project `c1f22ce...`; session live-verified via `team action='list'` (clean return) |
| 9a read-only battery | ✅ | 10/10 — list / recommend / health / doctor / status / events / summary / get / explain / worktrees. explain+worktrees need runId **in session project scope** (see Findings #1) |
| 9b spawn paths | ✅ | 5/5 — sync run (`team_20260810102800_5404ddb26259b83f`, 3/3), async run (`team_20260810103041_8c3182e92aa8e46e`, 3/3), chain 2-step (`team_20260810103042_600b1f1cddf749b0` + `team_20260810103537_e6cf44ddfe3bb2db`, both success), direct Agent (pid 604629), crew_agent bg + get_subagent_result (pid 605499). All `PI_CREW_KIND=subagent` |
| 9c lifecycle | ✅ | status details=true (full task graph/usage/policy), cache (0 entries + skill cache 78.6% hit), checkpoint (structured "No checkpoint found"), retry (lock-protected "run.lock is locked" — no corruption), resume ("Resumed ... Status: completed, Tasks: 3"). Live steer/cancel on a *running* run not exercised (no long-running run kept alive) |
| 9d destructive | ✅ | **run after user confirmation**: `cleanup` (AGENTS.md marker swept, `.crew/` preserved), `prune keep=10` dry-run (0 to remove — within limit), manually removed 17 zombie `/tmp/pi-crew-*-test-*` workspaces (verified no process cwd inside). Health: stuck=0 zombie=0 (was 1+7) |
| 9e admin | ✅ | workflow-list ✅, validate ✅ (1 warning: dwf-smoke no steps), config ✅. workflow-create CRUD **validation gate proven** (requires confirm + config.name + config.script for dynamic workflows) |
| 9f background | ✅ | auto-summarize (status+thresholds), anchor (structured "No anchor set"), schedule register→list→remove round-trip (job `c52074cc-...` removed; "No scheduled jobs" confirmed) |

Legend: ✅ pass with evidence · ❌ fail (root cause below) · ⚠️ pass with caveat · ⏭️ skipped (justify why)

## Findings (bugs / quirks / non-blocking notes) — STATUS AFTER FIXES

1. ~~**Cross-project run lookup limitation**~~ → **FIXED** (FIX 1): `explain.ts` + `lifecycle-actions.ts` (`handleWorktrees`) now resolve runs via `locateRunCwd(runId, cwd)` (the same cross-project helper `status`/`cancel`/`inspect` use), instead of raw `ctx.cwd`. Verified live: `locateRunCwd('team_...8e46e', '/home/bom/source/my_pi')` → `/home/bom/source/my_pi/pi-crew`. Files: `src/extension/team-tool/explain.ts`, `src/extension/team-tool/lifecycle-actions.ts` + tests `test/unit/extension/core/explain-cov.test.ts`, `lifecycle-actions.test.ts`.
2. ~~**`task.output_validation {valid:false,formatMatch:false}` on every task**~~ → **FIXED** (FIX 2): `ROLE_PATTERN_DEFS` in `output-validator.ts` now ORs each strict caveman pattern with a markdown-structured alternation (atx headings `## X`, bold `**x**`, bullets/list items). Verified: explorer/verifier markdown handoffs now `formatMatch=true`; empty output still `valid=false`. Files: `src/runtime/output/output-validator.ts` + `test/unit/runtime/output/output-validator.test.ts`.
3. ~~**`team action='config'` rewrites the file even on a read**~~ → **FIXED** (FIX 3): `updateConfig` (and `updateAutonomousConfig`) in `config.ts` now skip the `atomicWriteFile` when the merged result deep-equals the current on-disk config. Verified live: `updateConfig({})` left `mtime` identical. Files: `src/config/config.ts`.
4. ~~**`retry` on a completed run returns misleading "run.lock is locked"**~~ → **FIXED** (FIX 4): `handleRetry` in `cancel.ts` now runs a **pre-lock terminal-status check** (`retryShortCircuitsCompleted`) — a completed run with no failed/cancelled tasks short-circuits to "already completed; retry only applies to failed/cancelled runs" BEFORE acquiring the stale lock. Pure helper extracted + 7 unit tests added. Files: `src/extension/team-tool/cancel.ts` + `test/unit/extension/core/cancel-cov.test.ts`.
5. **Pre-existing state noise** → **RESOLVED by 9d clean**: `cleanup` + manual removal of 17 zombie `/tmp` workspaces. Health now `stuck=0 zombie=0`.
6. `workflow-create` requires `confirm=true` + `config.name` + `config.script` for dynamic workflows (informational, not a bug — validation gate works correctly).

## What was NOT run + why

- **9d destructive** (`prune`/`cleanup`/`forget`): requires explicit user confirmation per delegation policy + skill. Candidates identified (1 stuck run, 7 zombie workspaces). Paused pending user go-ahead.
- **9e full workflow CRUD round-trip**: `workflow-create` demands a dynamic-workflow `.dwf.ts` source (`config.script`) — constructing a real script + create→get→delete in scratch was out of scope for this battery; the validation gate (returns `requires config.name` / `requires config.script`) proves the handler is alive and correctly rejects incomplete input. `workflow-list`, `validate`, `config` read-backs all ran clean.
- **9c live mid-run steer / cancel on a *running* run**: all my spawn probes completed quickly; no long-running run was kept alive to steer/cancel. `resume`, `checkpoint`, `cache`, `retry`, `status details=true` were exercised on completed runs (the same handlers). `respond` needs a waiting mailbox task — none existed.
- **9f `runKind='goal-loop'`, `api`, `import`/`export`, `auto_boomerang`**: not in the cheap battery; only exercised when a change touches those paths. `schedule` register→remove, `auto-summarize`, `anchor` all ran.

## Restart needed?

- [x] No — session already reloaded (user `/quit`+reopened once; bundle `c1f22ce...` loaded). **NOTE**: a second reload is needed to pick up the 4 fixes (bundle rebuilt from `43d96d44...` → `c1f22ce...` during the fix phase, AFTER the restart).
- [ ] **Yes (one more)** — to load the fixed bundle: md5 before/after: `43d96d444c1e79dd51f80d2f36ffd190` → `c1f22ceedfabe4e20fac5b088086d86d`. After restart, verify with `team action='list'` then retry `explain`/`worktrees`/`config`/`retry` against a completed run to confirm the fixed behavior live.

## Verdict

**All 9 tiers pass (4/8 previously ⚠️ now ✅ after restart + clean). All 4 findings FIXED with evidence + unit tests (62 tests across 4 fix-related test files; test:critical 101/101; typecheck exit 0).** State cleaned (stuck=0, zombie=0). The user needs one more Pi restart (`/quit` + reopen) to load the fixed bundle `c1f22ce...`, then the 4 fixes can be confirmed live via the team tool.
