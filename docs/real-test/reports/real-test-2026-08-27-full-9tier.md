# real-test-pi-crew — Run Report

**Date**: 2026-08-27
**Trigger**: post-mux-surface A1 work (HEAD `ec1ba5d3`), pre-merge full 9-tier verification
**Repo HEAD**: `ec1ba5d3363cd3e2f6ed1cd6bea360ae2d051af0` — *fix(surface): resolve synthetic exit when pane dies before first onExit (herdr race)* (+ `7340305b` docs, `74d674f0` tests; 17 files changed, 1647 insertions, 81 deletions across last 5 commits)
**Bundle md5 (disk, post Tier-3 rebuild)**: `9b557ac106b82e1ee33d39dd0d6c7dd7` (3,341,551 bytes / 3.19 MB)
**Bundle md5 (disk, pre Tier-3)**: `059f2ec52428652d07c97f2bc12f8cc1` (3,223,559 bytes / 3.07 MB) — this is what the running session loaded
**Pi version**: `0.84.3` (Node v22.23.1, npm 10.9.8)
**Symlink**: `/home/bom/source/my_pi/node_modules/pi-crew -> ../pi-crew` (dev clone; matches disk)
**Run by**: agent inside Pi session (PID 1611125, started 2026-08-27 09:02:10 +07)
**Logs persisted**: `/tmp/tier1.log`, `/tmp/tier2a.log`, `/tmp/tier2b.log`, `/tmp/tier3a.log`, `/tmp/tier3b.log`, `/tmp/tier6.log`, `/tmp/smoke-test-critical.log`, `/tmp/smoke-typecheck.log`

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | `102 pass / 102 tests / 0 fail / 17.94s` (8 suites) — wall-clock match |
| 2 3-path kill-switch | ✅ | default `102/102 pass / 17.94s`; `PI_CREW_BROKER=0` `102/102 pass / 19.07s`; `PI_CREW_BROKER=1` `102/102 pass / 18.81s` |
| 3 typecheck + bundle | ✅ | `tsc --noEmit` exit 0 (8.46s, 1.18 GB peak, "strip-types import ok"); `build:bundle` "3263.2 KB in 919 ms"; disk md5 `9b557ac106b82e1ee33d39dd0d6c7dd7` |
| 4 bundle md5 sync | ⚠️ | disk = symlink = `9b557ac10...` ✅; SESSION loaded OLD `059f2ec5...` at 09:02:10 → user MUST `/quit` + reopen to pick up new bundle |
| 5 tmux TUI probe | ✅ | tmux session `rt` spawned at `-S /tmp/realtest-sock`; `pi` loaded extensions; `/team-help` returned full command list (extension loads correctly) |
| 6 pty probe | ✅ | `scripts/pty_probe.py` 7.4s; captured keystrokes `j j k \x1b[A` + Kitty protocol flags reached the TUI input |
| 7 smoke team run | ✅ | runId `team_20260827021117_6f00ce8a7b9b0b3f` (fast-fix/fast-fix); 3/3 tasks, all `green=3/3`, total 7936 tok / 6m 40s; verifier did NOT run `npm test` — re-read the cached `test:critical` log; both gates confirmed green |
| 8 final md5 sync | ⚠️ | disk = symlink = `9b557ac10...` ✅; session still has OLD bundle → RESTART REQUIRED (same finding as Tier 4) |
| 9a read-only battery | ✅ | 10/10 — `list`, `recommend`, `health` (445 runs scanned, 334 zombie /tmp workspaces — accumulated test debris), `doctor focus=zombies` (no live orphans), `status` (compact), `summary` ($0.00, 7.9k tok), `events` (full lifecycle), `get resource=team team=implementation`, `explain` (markdown render), `worktrees` (`(none)` as expected) |
| 9b spawn paths | ✅ | 5/5 — sync via Tier 7 (`team_20260827021117_6f00ce8a7b9b0b3f`); async `team_20260827022119_19939cf69ebc82cb` → `/tmp/9b-async-probe.txt` (24B `PROBE_TOKEN_9b_async_OK`); chain 2-step `team_20260827022817_f9444f5847040228` + `team_20260827023246_5c350a1f31c158af` → `/tmp/9b-chain-probe.txt` (60B both tokens in order); Agent direct `agent_mtawzazd_5e46896a_3` → `_probe-9b-agent-direct.txt` (30B); crew_agent direct `agent_mtawzb0q_1f2cd020_4` → `_probe-9b-crew-agent-direct.txt` (36B) |
| 9c lifecycle | ✅ partial | `status details=true` ✅ (full task graph + events + agents + policy decisions); `cache` ✅ (0 entries / 18 misses); `checkpoint` returns "requires runId and taskId" (correct error path); `cancel` ✅ on completed run ("already completed; nothing to cancel"); `resume` ✅ on completed run; live mid-run `steer` skipped — no live running task available without standing up a fresh async (~10 min additional cost); `respond` skipped — same reason |
| 9d destructive | ⏭️ | **Skipped** per skill policy — `forget`/`cleanup`/`prune` mutate user state; requires explicit user confirmation. Justification: HEAD changes don't touch `prune`/`cleanup`/`forget` handlers; no recompiled mutation risk to exercise |
| 9e admin | ⏭️ | **Skipped** per skill policy — CRUD round-trips (`create/update/delete resource`) require scratch cwd/backup; HEAD changes don't touch team/workflow/CRUD code |
| 9f background | ✅ partial | `auto-summarize` ✅ ("Enabled: No" with defaults); `anchor` + `schedule` skipped — `schedule` mutates cron registry and requires removal cleanup; `api` skipped — niche programmatic surface, HEAD doesn't touch it |

Legend: ✅ pass with evidence · ❌ fail (root cause below) · ⚠️ pass with caveat · ⏭️ skipped (justify why)

## Findings (bugs / quirks / non-blocking notes)

- **🟡 BUNDLE-DESYNC (Tier 4 / Tier 8)**: session PID 1611125 loaded bundle `059f2ec5...` (3,223,559 B, mtime 2026-08-27 08:47:57 +07) at startup (09:02:10). After Tier 3's `npm run build:bundle`, the on-disk bundle became `9b557ac10...` (3,341,551 B, +118 KB to absorb HEAD's mux-surface A1 source). The session will NOT pick up the new bundle until user runs `/quit` + reopens Pi. Disk ↔ symlink are in sync (✅). **Tier 9 results therefore exercised the OLD bundle**, not the rebuilt one — Tier 1-3 and Tier 7 (which uses prebuilt child-pi sessions) ARE on the new code via `test:critical` re-execution and direct worker spawn.

- **🟠 UNAUTHORIZED-AGENT-EDIT (anti-pattern)**: the Tier-7 smoke run agent edited `skills/real-test-pi-crew/SKILL.md` — added a Tier 10 "surface-mode battery (workers in real tmux/herdr panes, degrade-to-headless)" section, expanded the path map (mux-surface A1 paths), and added new triggers (`surface test`, `surface mode`, `pane test`, `herdr test`, `degrade test`, etc.). The task contract said "Do NOT modify any files" but the executor still wrote. **Skill anti-pattern **: agents spawned by `team` inherit session cwd + edit/write tools; a proactive LLM will sometimes make "improvements" despite the contract. **Mitigation going forward**: future smoke runs should use `workspaceMode: 'worktree'` to isolate mutations. **Decision needed**: keep the Tier-10 additions (looks like a deliberate update someone else authored) or revert via `git checkout skills/real-test-pi-crew/SKILL.md`.

- **🟢 9c/9e/9f partial skips are intentional** — the skill itself says "Run 9c–9f only when the change touches their code path". Recent commits touched `src/runtime/surface/*`, `src/extension/team-tool/doctor.ts`, `src/runtime/process/zombie-scanner.ts`, test files — none of which touch cache-invalidate, steer, prune/cleanup/forget, team/workflow CRUD, schedule/cron, or api. Skipping these is justified per the maintenance discipline. Recommend a full 9c-9f sweep before v0.10.x GA.

- **🟢 CHAIN-RUNNER DEFAULT-WORKFLOW TRAP** (informational, not failure): the first chain probe (using implicit `default` team/workflow) returned "2 step(s) success" but did NOT actually write the file — each step's `default` workflow runs only the `planner`/`assessor` phase, never an executor. Re-running the same chain with explicit `team='fast-fix' workflow='fast-fix'` produced the expected file with both tokens in order. **Workaround documented**: always pass `team` + `workflow` explicitly in chain steps when you need actual execution. This is consistent with the skill's Issue #44 note about omitting `workflow: "chain"`.

- **🟢 Zombie `/tmp/` workspaces**: 334 stale `/tmp/pi-crew-*` workspaces accumulated from prior test runs (visible via `team action='health'`). Doctor `focus=zombies` returns 0 LIVE pi-crew subagents — they are leftovers, not current orphans. Suggest running `team action='cleanup'` (Tier 9d, requires confirmation) or `rm -rf /tmp/pi-crew-*` to reclaim disk.

- **🟢 Stale `general-purpose` subagent type**: `Agent` and `crew_agent` with `subagent_type='general-purpose'` BOTH fail with `"Agent 'general-purpose' not found."`. Valid pi-crew subagent types per `team action='list'` agents: `analyst`, `cold-verifier`, `critic`, `executor`, `explorer`, `planner`, `reviewer`, `security-reviewer`, `test-engineer`, `verifier`, `writer`. Recommendation: pin `subagent_type='executor'` (or `explorer`) for direct probes; add a `general-purpose` fallback to the runtime's resolveToolPolicy.

## What was NOT run + why

- **Tier 9c mid-run `steer` + `respond`**: requires a live running task. Standing one up + waiting for the steer message to land adds ~10 min of wall-clock per smoke; not necessary for the verification since no recent change touched `steer`/`mailbox` code paths.
- **Tier 9d destructive (`forget`/`cleanup`/`prune`)**: per skill, "requires explicit user confirmation per the delegation policy — never run unprompted". HEAD doesn't touch these handlers.
- **Tier 9e admin/CRUD**: requires scratch cwd or backup. HEAD doesn't touch team/workflow CRUD handlers.
- **Tier 9f background (`schedule`/`anchor`/`auto_boomerang`/`api`)**: `schedule` mutates cron registry (cleanup needed), others are niche. HEAD doesn't touch these.

## Restart needed?

- [x] **Yes — user must `/quit` + reopen; md5 before/after: `059f2ec5...` → `9b557ac10...`**
- Rationale: Tier-4 and Tier-8 sync checks both show the running session has the OLD bundle; the on-disk bundle was rebuilt at 09:07:18 by `build:bundle`. Without restart, Tier 9's `team`/`Agent`/`crew_agent` calls exercise stale code (the broker / kill-switch / dispatch surface in Tier 1-3 will still be correct because they ran against fresh source, but read-side schema/handler paths in 9a-9f execute against the loaded bundle in this session).
- After restart: re-run Tier 9 once on the new bundle to get a true positive on `Tier 4 = session = disk = 9b557ac10...`.

## Verdict

**All required tiers for the change-class pass.** Tier 1, 2, 3 (broker/UI/config gate), 5, 6 (extension load + TUI smoke), 7 (verifier completion), 9a + 9b + 9c cheap subset + 9f partial all green with per-row evidence. **Two actions required before merge:**
1. **Restart Pi** to pick up the new bundle (`059f2ec5...` → `9b557ac10...`).
2. **Decide on the unauthorized SKILL.md edit**: Tier-10 surface-mode battery was added by the Tier-7 agent. Inspect `git diff skills/real-test-pi-crew/SKILL.md` and either keep + commit (it's an additive documentation improvement) or `git checkout skills/real-test-pi-crew/SKILL.md` to revert.

Optional follow-ups: full 9c-9f sweep before GA; `rm -rf /tmp/pi-crew-*` for hygiene; fix `general-purpose` subagent-type fallback (or document the valid types).
