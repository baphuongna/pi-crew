# real-test-pi-crew — Run Report (full 9 tiers, live session)

**Date**: 2026-08-26 (UTC)
**Trigger**: User request — "chạy skill real test pi-crew full 9 tiers trên chính live session này"
**Repo HEAD**: `745cf9f1 docs(changelog): mark round-2 residuals resolved by follow-up fixes`
**Bundle md5 (disk, before run)**: `fe460ef4cdc1789226cdd96dde33964c`
**Bundle md5 (disk, after Tier 3 rebuild)**: `2de31d165a465477643a40796b8fb81d` (3183.2 KB)
**Bundle md5 (after Tier 8 final check)**: `2de31d165a465477643a40796b8fb81d` — STABLE
**Pi version**: v0.84.3 (live at `/home/bom/.nvm/versions/node/v22.23.1/bin/pi`, global)
**Node**: v22.23.1
**Run by**: pi agent inside the live session under test (self-test caveat applies)

> ⚠️ Self-test caveat (per SKILL.md "Agent-inside-session caveat"): the agent
> doing the testing cannot restart its own session. Tier 4 / Tier 8 confirm
> md5 on disk; session-load verification uses a fresh tmux/pty pi instance.

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | **102/102 pass** in **16.5s** (test:critical = 14 files, 8 suites) |
| 2 3-path kill-switch | ✅ | default (unset): 102/102 in 18.5s · `PI_CREW_BROKER=0`: 102/102 in 15.5s · `PI_CREW_BROKER=1`: 102/102 in 14.9s |
| 3 typecheck + bundle | ✅ | `tsc --noEmit` exit 0 (7s, "strip-types import ok") · `build:bundle` exit 0 (464ms, 3183.2 KB) · md5 `2de31d16...` |
| 4 bundle md5 sync | ✅ | disk = symlink-resolved = `2de31d165a465477643a40796b8fb81d` · `/home/bom/source/my_pi/node_modules/pi-crew → ../pi-crew` symlink live · global npm path not installed (workspace dev path only) |
| 5 tmux TUI probe | ✅ | fresh tmux pi cold-started on new bundle · `/help` and `/team-help` rendered full pi-crew slash-command list · `\x1b[A`, `\x1bOA`, `q` keystrokes reached handleInput (screen state diff confirmed) |
| 6 pty probe | ✅ | `scripts/pty_probe.py` ran 9 keys (j j k \x1b[A \x1b[B \x1bOA \x1bOB q q) · pi v0.84.3 banner rendered, all keys echoed into pty without crash · no zombie processes left behind |
| 7 smoke team run | ✅ | runId `team_20260826002634_c76db11d778daa64` (fast-fix/fast-fix) · **3/3 tasks, consistency=1, 213s wall** · verifier used cached log + ran `npx tsc --noEmit` fresh (5.07s) · no 300s hang |
| 8 final md5 sync | ✅ | disk = `2de31d16...` · symlink = `2de31d16...` · matches Tier 4 |
| 9a read-only battery | ✅ | **10/10**: list, recommend, health, doctor-zombies, status, events, summary, get-workflow, explain, worktrees · 46 zombie /tmp/ workspaces noted (pre-existing, informational) · no regressions |
| 9b spawn paths | ✅ | **5/5**: sync `team_20260826003100_6844837bc05a9851` (76s) · async `team_20260826003217_cb16d4c79927fa35` (184s, async:true returned immediately) · chain (2/2 success, no `workflow` param) `team_20260826003523_...` + `team_20260826003719_...` (254s total) · Agent direct `agent_mt9d9plk_bb6d279e_1` ("AGENT-DIRECT-OK") · crew_agent background `agent_mt9d9x3c_aa5fd59a_2` ("CREW-AGENT-BG-OK") |
| 9c lifecycle | ✅ partial | status-details ✅ · artifacts ✅ · cache subAction variants return stats ✅ · checkpoint(taskId) → "No checkpoint found" (correct for completed run) ✅ · invalidate ✅ ("Cache invalidated") · resume ✅ ("Resumed run ...") · steer (team + subagent) — negative-path proven: "Task '02_execute' is completed; cannot steer." / "Task '01_01-agent' is completed; cannot steer." |
| 9d destructive | ⏭️ skipped | forget / prune / cleanup require explicit user confirmation per delegation policy; not run |
| 9e admin | ⏭️ skipped | team/workflow CRUD round-trip + init/config/validate/autonomy not run (mutates config — same caution as 9d) |
| 9f background | ✅ partial | auto-summarize ✅ (returns config) · anchor ✅ (no anchor, clean msg) · scheduled list ✅ ("No scheduled jobs") · api ✅ (full structured JSON dump of run state) · `schedule cron="*/30 * * * *"` returned `"No next cron occurrence found within search window"` — minor finding · `schedule once="2026-08-26T01:45:20Z"` returned `"once must be a valid timestamp"` — bug worth filing (ISO format rejected) |

Legend: ✅ pass with evidence · � fail (root cause below) · ⏭️ skipped (justify why) · ✅ partial (subset of paths ran; rest skipped)

## Findings (bugs / quirks / non-blocking notes)

### F1. Schedule action rejects valid ISO timestamps — likely a bug
- **Repro**: `team action='schedule' goal='...' once='2026-08-26T01:45:20Z' jobId='tier9f-once'`
- **Output**: `"once must be a valid timestamp"`
- **Severity**: non-blocking; schedule action still works for ad-hoc runs via `action:'run' async=true`. Worth filing as a follow-up if schedule is supposed to accept ISO timestamps.
- **Workaround**: not found in this run; cron path also returned `"No next cron occurrence found within search window"` so neither input mode currently registers a job.

### F2. Cache subAction variants return the same stats response
- **Repro**: `team action='cache' subAction='list' runId='team_20260826002634_...'` and `subAction='snapshot'` and `subAction='stats'` and `subAction='help'` all return the same body: `"Run cache: 0 entries, 0 bytes\nSkill cache: 0 hits, 28 misses..."`
- **Severity**: minor; subAction dispatch may not be wired (or always returns stats). Worth a follow-up if these were supposed to have distinct behaviors.

### F3. Pre-existing 46 zombie /tmp/ workspaces
- **Source**: `team action='health'` reports `Zombie /tmp/ workspaces: 46` (mostly `pi-crew-planui-*` and `pi-crew-char-*`).
- **Severity**: informational only — these are from prior sessions (Aug 25 and earlier), not introduced by this run.
- **Action**: would benefit from `team action='cleanup'` (9d, skipped) or manual sweep.

### F4. No regression in `effectiveEnabled()` chain under 3 env paths
- All three paths (unset / `PI_CREW_BROKER=0` / `PI_CREW_BROKER=1`) returned 102/102 in Tier 2, confirming `DEFAULT_BROKER.enabled=true` (default-on since Phase 4, commit `612e18b`) plus env override layer are both intact.

### F5. No unauthorized agent edits
- After every team run + subagent spawn, `git status` was inspected. Only modifications are `dist/index.mjs`, `dist/index.mjs.map`, `dist/build-meta.json` (from our explicit `npm run build:bundle` in Tier 3) and the new `docs/real-test/reports/real-test-2026-08-25-full-9tier-live.md`. **No `src/` or `workflows/` changes were made by any team worker or subagent** — anti-pattern from SKILL.md ("Trusting a team-run agent not to edit the repo under test") is not triggered.

## What was NOT run + why

- **9d (destructive)**: `forget`, `prune`, `cleanup`, `kill <PID>` (the follow-up to `doctor focus='zombies'`). These are destructive against user run data and explicitly require user confirmation per delegation policy — user did not pre-authorize.
- **9e (admin/mutation)**: `create/update/delete` on teams/agents/workflows, `init/config/validate/autonomy/settings`, `workflow-create/save/delete/get/list`, `import/imports/export`, `parallel`. These mutate config or workflow files — same caution as 9d; user did not pre-authorize scope.
- **9c live mid-run steer / 9c retry / 9c respond**: needs a long-running async run + careful timing; not proven end-to-end in this run. The negative-path (already-completed task → "cannot steer") is proven.
- **9f schedule register+remove**: cron and once paths both rejected inputs (see F1) — schedule registration is not currently exercisable on this version.
- **9f auto-summarize / anchor**: ran cleanly with "Enabled: No" / "No anchor set" defaults — configuration surface verified; runtime activation not exercised.
- **macOS / Windows**: not applicable — Linux x86_64 only.

## Restart needed?
- [x] Yes — user (or this session on next cold-start) must `/quit` + reopen Pi to load the new bundle.
- md5: `fe460ef4cdc1789226cdd96dde33964c` (old, in this session's memory) → `2de31d165a465477643a40796b8fb81d` (new, on disk).
- Disk + symlink both report the new md5; once the session reloads it will be on the same code Tier 5/6/7/9 ran against.

## Verdict

**All required tiers pass** (Tiers 1, 2, 3, 4, 5, 6, 7, 8, 9a, 9b, 9c partial, 9f partial).
**9d and 9e were intentionally skipped** (destructive / mutation — not pre-authorized).
**Two minor follow-ups** worth filing:
1. `team action='schedule' once='<ISO>'` rejects what looks like a valid ISO timestamp (F1).
2. `team action='cache' subAction='<variant>'` returns the same stats response regardless of subAction (F2).

No regression found. Bundle is ready for commit; user should `/quit` + reopen to pick up the new md5.
