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
| 9c lifecycle | ⏭️ | run start→complete proven via async runs; live mid-run steer/wait/cancel NOT run (I-batch does not touch lifecycle handlers; would need a long-lived run + tokens). status/events/summary/explain all exercised in 9a against live runs |
| 9d destructive | ⏭️ | not run — requires explicit user confirmation per delegation policy; nothing in I-batch touches prune/cleanup/forget |
| 9e admin | ⏭️ | not run — I-batch does not touch team/workflow CRUD or config schema |
| 9f background | ⏭️ | not run — I-batch does not touch scheduling/goal-loop/auto-summarize |

## Findings (bugs / quirks / non-blocking notes)

1. **CRITICAL (fixed this session)** — armed-role tool-surface bug: scratchpad never appeared in executor/verifier/test-engineer workers despite `PI_CREW_SCRATCHPAD=1` + `PI_CREW_KIND=subagent`. Root cause: `resolveToolPolicy` (`src/agents/agent-config.ts:165`) falls back to `agent.tools` when the role has no allowlist, and `agents/{executor,verifier,test-engineer}.md` frontmatter `tools:` did not list `scratchpad` → pi got `--tools read,grep,find,ls,bash,edit,write` and hard-filtered scratchpad. Reproduced via `pi --tools read,grep,find,ls,bash,edit,write` → no scratchpad; fixed by adding `scratchpad` to the 3 frontmatter lists + `ROLE_TOOL_CONFIGS` verifier/test-engineer (pinned by QW17 sync test). Commit `f753be30`.
2. **Non-blocking (pre-existing)** — `team_20260811054859_a801e3b415554403` reported corrupted (missing-state-or-artifacts); 5 zombie `/tmp/pi-crew-*` workspaces from stale-wakeup/dynamic-fanout tests — all pre-date the I-batch, unrelated.
3. **Non-blocking** — `run.goal_achievement: unknown — not a git repo or git unavailable` in smoke run (cwd = workspace root without git). Cosmetic.

## What was NOT run + why
- **9c full**: live mid-run steer/wait/cancel/checkpoint — I-batch does not change lifecycle/steer handlers; proven indirectly via async runs reaching terminal states. A dedicated steer probe would cost ~5 min + tokens for no code-path coverage gain.
- **9d (prune/cleanup/forget)**: requires explicit user confirmation (delegation policy); no I-batch code path touches these.
- **9e (admin CRUD) / 9f (background/scheduled)**: no I-batch code path (schema/workflow/scheduling untouched).
- **5/6 TUI detail**: I-batch has no `src/ui/` changes; Tiers 5/6 confirm pi boots + keys reach TUI only.

## Restart needed?
- [x] No — live workers (Tier 7/9b/9c) cold-started on the current bundle `16e29d05…` and all I-batch features (scratchpad tool, scratchpad.cell events, summary.md Scratchpad section, scratchpadSummaryLines) were observed live.
- [ ] Yes — (only if a Pi session opened before the last bundle rebuild must be restarted; the agent's own session loaded the bundle at cold-start)

## Verdict
All required tiers (1, 2, 3, 4, 5, 6, 7, 8, 9a, 9b) pass with evidence; 9c–9f skipped with justification (no code-path coverage). The I-batch (I1–I7) plus the armed-role tools-list fix are verified live end-to-end: scratchpad is registered in worker surfaces, cells execute, `scratchpad.cell` events emit, and the run summary reports them. Safe to proceed to the §5 observation window.
