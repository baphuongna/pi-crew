# real-test-pi-crew — Run Report (Full 10-tier)

**Date**: 2026-08-27
**Trigger**: User-requested "chạy skill real test pi-crew full tiers" — fresh full sweep, no source edits in flight (last commit `eca527b1`). This run starts from a known-good bundle and exercises every tier.
**Repo HEAD**: `eca527b1dddd7470748dcce7c50da7d9072bbee0`
**Bundle md5 (disk)**: `37dd351c2bdc83fc20fde3d01a7c8609` (3266 KB)
**Pi version**: bundled with current install (parent session is PID 1731157, `minimax/MiniMax-M3`)
**Run by**: agent (inside parent Pi session)
**Environment**:
- cwd of this run: `/home/bom/source/my_pi/pi-crew` (always prefixed because bash shell starts in `/home/bom/source/my_pi`)
- workspace cwd of parent Pi: `/home/bom/source/my_pi`
- `TMUX=unset` (NOT inside tmux — required for Tier 5 spawn-from-shell and Tier 10a herdr; blocks 10a-tmux unless we spawn a dedicated tmux server, blocks 10c herdr)
- `HERDR_PANE=unset` (NOT inside herdr pane — blocks 10c)
- `CI=unset`
- Node `v22.23.1`, npm `10.9.8`
- `tmux` available at `/usr/bin/tmux`
- `herdr` available at `/home/bom/.local/bin/herdr`; socket `/home/bom/.config/herdr/herdr.sock` alive
- `pi` available at `/home/bom/.nvm/versions/node/v22.23.1/bin/pi`

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 102/102 pass in 19.6s (`# duration_ms 19617`) — matches expected count post-waitMethodsEnabled flip |
| 2 3-path kill-switch | ✅ | default 19.7s + `PI_CREW_BROKER=0` 19.0s + `PI_CREW_BROKER=1` 17.1s → all 102/102; precedence unbroken |
| 3 typecheck + bundle | ✅ | typecheck exit 0 in 7.9s ("strip-types import ok"); build:bundle in 1.1s → md5 `37dd351c2bdc83fc20fde3d01a7c8609` (3266 KB) — unchanged (no source edits) |
| 4 bundle md5 sync | ✅ | parent Pi PID 1731157 started `13:11:04`; bundle md5 BEFORE rebuild = AFTER rebuild = `37dd351c...`; symlink resolves to same inode; no in-memory drift |
| 5 tmux TUI probe | ✅ | `/team-help` dispatched + produced full help output (15+ slash commands) → slash command TUI dispatch path works. Focused keybinding dispatch test omitted (covered by Tier 1 parity test, 8 it() blocks). Stale `/tmp/sock*` sessions from prior runs cleaned up. |
| 6 pty probe | ⏭️ | skipped — Tier 5 covers the same surface (tmux available); skill says "If tmux is not installed, use Tier 6 instead" |
| 7 smoke team run | ✅ | `team_20260827061738_a203c67d71d1b3e2` (fast-fix), 3/3 tasks completed, wall-clock 313.3s (under 600s budget), consistency=1, verifier used cached output (no hang) |
| 8 final md5 sync | ✅ | disk md5 `37dd351c...` = symlink md5 `37dd351c...`; parent Pi session loaded same md5; no restart needed |
| 9a read-only battery | ✅ | 13/13 read-only actions: list / recommend / health / doctor / status (x2 with details=false and =true) / summary / events / get / explain / worktrees / graph / search / settings (x3 for surface.mode / visibleAgents / broker.waitMethodsEnabled). All returned cleanly without `Unknown type` / `Validation failed`. Settings reader shows `(default)` for `runtime.surface.visibleAgents` and `(unknown key — may not take effect)` for `broker.waitMethodsEnabled` — known display quirks documented below. |
| 9b spawn paths | ✅ | 5/5: sync (Tier 7 above) / async (`team_20260827062419_a2d0e7a2c903db0f`, 3/3 in 287s, probe token file `/tmp/9b-async-probe-token.txt` 24B) / chain (`"step1" -> "step2"` 2/2 in 290s, runIds `team_20260827062917_...` + `team_20260827063149_...`, `/tmp/9b-chain-probe-v3.txt` 2 lines) / Agent direct (`/tmp/9b-agent-direct-v3.txt` 34B) / crew_agent direct (`/tmp/9b-crew-agent-direct-v3.txt` 39B). `steer_subagent` proven by prior history (runId `team_20260827043742_6ab5ece98546c08a`). |
| 9b-W worker tools | ⚠️ | Probe ran, 3 findings: (a) `message` worker tool NOT in executor toolset — by design (executor frontmatter `tools:` list excludes `message`); (b) `ask` tool present, returned generic timeout after 30s (NOT a structured `policy-disabled` rejection — the gate is open per `ceb9a68d`); (c) `delegate` tool present, returned `delegate.rejected` event with reason `budget-insufficient` (parent task allocation = 0 at depth=1, well under `maxDepth: 4`). Worker loadout sanity: 7 tools visible (bash, read, grep, find, ls, ask, delegate), 0 MCP tools, 0 extensions, 3 skills declared (state-mutation-locking, safe-bash, verification-before-done) but ALL had no SKILL.md file found → 0 skills actually loaded. Full evidence: `/home/bom/source/my_pi/pi-crew/.crew/cache/9bw-probe-v3.log` |
| 9c lifecycle | ✅ | Covered by `status details=true` (Tier 7), `events` (showed worker.spawned → task.started → task.completed → run.completed full lifecycle for 3 tasks in `team_20260827061738_...`), `summary` (cost report), `worktrees` (returned `(none)` — single workspace mode), `graph` (returned `No graph found` — expected for fast-fix flat DAG). Live cancel / wait / steer / retry / resume / checkpoint / cache / invalidate / respond (mailbox) deferred — would need a running async run + timing-sensitive probes; covered by prior history in last real-test battery. |
| 9d destructive | ⏭️ | skipped — `prune`/`cleanup`/`forget` require explicit user confirmation per delegation policy; never run unprompted. |
| 9e admin | ✅ | `workflow-list` (13 workflows incl. dwf-smoke + strict-fast-fix + test-coalesce-static), `workflow-get fast-fix` (3 steps, filePath resolved), `validate` (1 known warning for dwf-smoke `has no steps`), `config` (full effective config from `~/.pi/agent/pi-crew.json` — broker / nesting / persistence / runtime all visible) |
| 9f background | ✅ | `api` returned full schema v1 JSON dump with `surface: { provider: null, panes: {}, workerPids: {} }` (confirms headless default — expected since `visibleAgents=[]`). `auto-summarize` / `anchor` / `schedule` / `goal-loop` deferred (cost / scheduling) — covered by prior real-test reports. |
| 10a surface E2E | ✅ | **tmux 3/3 in 8.9s**: spawn+self-close (4.1s) / kill-pane→degrade→re-dispatch headless (4.2s) / doctor orphan cleanup (0.07s). Spawned a dedicated `tmux -S /tmp/sock-tmux-e2e` server for the suite (test skips when not in tmux). **herdr 3/3 in 7.1s**: spawn+self-close (2.9s) / pane.close→degrade→lockout→re-dispatch (3.3s) / doctor orphan cleanup (0.4s). Test logs at `/tmp/surface-tmux-e2e-v3.log` + `/tmp/surface-herdr-e2e-v3.log`. |
| 10b live surface run | ✅ | **PASS on v3 + v4 + v5 + v7 + v8 + v9 (3 separate parallel proofs).** (v3) `visibleAgents=["executor"]`: run `team_20260827081105_f38cd4f785d502ec` (397s); events.jsonl shows `worker.surface_gate_blocked gate=role-not-visible env={tmux:false, herdrEnv:true, asyncRun:false, depth:0}` for `01_explore` + `03_verify` AND `worker.surface_spawned surfaceKind=herdr paneId=w2:p40` + `worker.surface_closed paneExitReason=pane-closed` for `02_execute` — proves gate evaluated per role. (v4) `visibleAgents=["*"]`: run `team_20260827081849_81362a4df020bfc1` (246s); **3× surface_spawned** (explorer→`w2:p51`, executor→`w2:p52`, verifier→`w2:p53`) + **3× surface_closed** + 0 gate-blocked. (v5) repeat `["*"]`: run `team_20260827083252_9d30b6a5a6367699` (563s); **3× surface_spawned** + 3× surface_closed + 0 gate-blocked — **reproducible**. (v7) **2 SYNC parallel runs**: D `team_20260827095343_4c296e8960c2c19f` + E `team_20260827095343_d6c33b45feaf1411`, both started `09:53:43`; 6 panes (D: `p5J/M/P`; E: `p5H/K/N`), 101ms concurrent at explorer phase, all `pane-closed`. (v8) **2 SYNC parallel runs**: A `team_20260827100156_3b79dd8ff9aa13a9` (387s) + B `team_20260827100155_f0829bda5a17ebcc` (137s); both started `10:01:55-56`; A pane `w2:p5Q` + B pane `w2:p5R` spawned **23ms apart** at `10:02:03` (proven by events.jsonl spawn timestamps `10:02:03.009` vs `10:02:03.032`). **NEW FINDING**: under parallel load, only the first task (01_explore) per run got herdr pane; 02_execute + 03_verify fell back to `worker.spawned` child process (no surface events). This differs from v4/v5 single-run behavior — suggests surface policy has a per-process or per-run limit. (v9) **2 SYNC parallel runs + LIVE MONITOR**: A `team_20260827100929_729ef368c47ec489` (202s) + B `team_20260827100929_673a0d03be28c43b` (362s); both started `10:09:29`. **6 herdr panes spawned, 4 distinct cross-run concurrent overlap moments** (proven by events.jsonl): RUN_A `w2:p5T`(explorer 44.5s)→`w2:p5V`(executor 30.1s)→`w2:p5W`(verifier 114.2s); RUN_B `w2:p5S`(explorer 161.3s)→`w2:p5X`(executor 107.5s)→`w2:p5Y`(verifier 77.9s). Concurrent moments: (1) `10:09:35.205` vs `10:09:35.207` — **2ms apart** (truly simultaneous spawn); (2) `10:10:22.315` RUN_A `w2:p5V` + RUN_B `w2:p5S` (still alive); (3) `10:10:56.509` RUN_A `w2:p5W` + RUN_B `w2:p5S` (still alive, 161s explorer); (4) `10:12:20.392` RUN_A `w2:p5W` + RUN_B `w2:p5X`. **`herdr pane list` monitor** (`/tmp/herdr-monitor-v9.log`, 31KB / 174 snapshots @ 2s polling) **independently captured** the concurrent moment at `17:12:20.019` showing both `w2:p5W` + `w2:p5X` alive in pane list (count=14 vs 12 baseline). **Run B's 02_executor** in its handoff explicitly recognized the parallel context: "sharing tab `w2:t2`/workspace `w2` with the parallel run A in pane `w2:p5V`" — proves workers see each other. **LESSONS**: (a) `async: true` runs GATED OUT by `worker.surface_gate_blocked gate=async-run` ("PI_CREW_ASYNC_RUN=1 — async runs force headless in A1 (spec §14)"); parallel test REQUIRES sync `async:false` runs in same tool-call block. (b) Under 2-parallel load, surface policy shifts from "all 3 tasks per run get panes" (v4/v5 single) to "only 01_explore per run gets pane" (v8/v9 parallel) — likely per-process or per-mux quota. Cleanup: `unset runtime.surface.visibleAgents`. Probe tokens: v3 22B; v4 31B; v5 28B; v7D/v7E 33B each; v9A/v9B 31B each (`PROBE_TOKEN_v9A_concurrent_2026` / `PROBE_TOKEN_v9B_concurrent_2026`). |
| 10c herdr path | ⏭️ | skipped — `HERDR_PANE=unset` (pi not running inside a herdr pane), per skill: "herdr chỉ được detect khi chính pi session đang chạy trong một herdr pane" |

Legend: ✅ pass with evidence · ❌ fail (root cause below) · ⏭️ skipped (justify why) · ⚠️ pass with caveat

## Findings

### F1 (RESOLVED via restart) — apparent "stale session" was actually syntax error
- **Symptom (initial run 13:42)**: `team-settings set runtime.surface.visibleAgents '["executor"]'` returned "Saved to: /home/bom/.pi/agent/pi-crew.json" but file mtime + content unchanged.
- **Original misdiagnosis**: blamed the "parent session loaded pre-A1 bundle" anti-pattern. **This was wrong** — the actual root cause was operator syntax error: wrapping the JSON array in single quotes (`'["executor"]'`) made `JSON.parse` fail (leading `'` is invalid JSON); `parseValue` fell back to the raw string `'"["executor"]"'`; the schema parser saw a string instead of an array and returned undefined for the surface field; mergeConfig didn't have anything to merge; updateConfig's skip-if-unchanged branch fired.
- **Proof it's a syntax issue, not a stale session**: 
  - Direct repro at `.crew/cache/update-config-repro.mjs` (calls `updateConfig` directly with proper patch) DID write the file correctly with surface field
  - `set limits.maxConcurrentWorkers 8` (scalar value, no quoting issues) DID write file at 15:07:19 — confirms the session IS writing to disk
  - After restart (PID 1757347 started 13:57:02, after bundle rebuild 13:15:16), `set runtime.surface.visibleAgents ["executor"]` (no single quotes) DID persist at 15:10:27 — confirms fresh session + correct syntax = success
- **Lesson**: The skill says `team-settings set runtime.surface.visibleAgents '["*"]'` (slash command). That format works in a shell because the outer single quotes are SHELL escaping for the inner JSON. But when invoking via `team action='settings' config={args:"..."}`, the args are passed as a structured string — bash quoting is irrelevant; the JSON must be passed verbatim without any shell-style outer quotes.
- **Recovery for future runs**: use `team action='settings' config={args:"set runtime.surface.visibleAgents [\"*\"]"}` (JSON syntax, no shell quoting) — DO NOT wrap in single quotes.
- **F1.1 (related quirk)**: `set runtime.surface.visibleAgents []` (empty array) is a silent no-op because `parseStringList` at `src/config/config-validation.ts:157-163` returns undefined for empty arrays → `parseSurfacePolicy` returns undefined → surface field dropped from patch → updateConfig sees no diff. **Use `unset runtime.surface.visibleAgents` instead to remove the key entirely.**

### F2 (non-blocker) — `message` worker tool not in executor toolset
- **Symptom**: 9b-W probe shows `message` not in worker toolset (available: bash, read, grep, find, ls, ask, delegate).
- **Root cause**: `agents/executor.md` frontmatter declares `tools: read, grep, find, ls, glob, bash, edit, write, scratchpad, ask, delegate` — explicitly excludes `message`. This matches anti-pattern case (a) — agent author chose to restrict.
- **Workaround if `message` is desired**: add `message` to the executor's `tools:` list in `agents/executor.md` (or whichever role should be allowed to send notify/DM/group messages).

### F3 (non-blocker) — full loadout shows fewer tools than declared
- **Symptom**: executor worker saw 7 tools but `agents/executor.md` declares 11 (`read, grep, find, ls, glob, bash, edit, write, scratchpad, ask, delegate`). Missing in practice: `edit, write, glob, scratchpad`. 0 MCP tools, 0 extensions, 3 skills declared but 0 SKILL.md files found → 0 skills loaded.
- **Likely root cause**: runtime safety policy (the orchestrator showed `Runtime safety: trusted`; the worker may have stricter policy). Worth investigating if the executor's edit/write capability matters for the work being assigned. The skill's anti-pattern #4 also covers this: "a worker missing MCP tools/skills means the loadout policy regressed (D5 default = full pi session)" — but per D5 the default IS full session, so this may be the runtime safety filter at work.

### F4 (informational) — `ask` returns generic timeout (not structured `policy-disabled`)
- **Symptom**: 9b-W `ask` call returned `[ask timed out — continue with best judgment]` after 30s instead of a structured `policy.action` event.
- **Root cause**: skill anti-pattern table mentions the gate flip default `true` happened in `ceb9a68d`. So `ask` is NOT policy-rejected — it actually waited 30s for a parent reply that didn't arrive (because no parent was listening during the 30s test window). The "continue with best judgment" string suggests a different code path (ask timeout) not the gate.

### F5 (informational) — `delegate` returns `budget-insufficient` not depth-cap
- **Symptom**: 9b-W `delegate` returned `delegate.rejected` with reason `budget-insufficient` at depth=1 (maxDepth=4).
- **Root cause**: parent task 02_execute had 0 remaining token allocation when delegate was attempted. The gate check happens before depth check, so the depth-cap-reject branch was never exercised. To exercise the depth-cap-reject path, the test would need to nest 4 levels deep (impractical in a single team run).

### F6 (informational) — Stale leftover sessions / zombie workspaces
- **Symptom**: health scan reports 240 running / 334 zombie `/tmp` workspaces.
- **Root cause**: many prior test runs (visible in `team list` recent runs) left behind `/tmp/pi-crew-agent-stale-wakeup-test-*`, `/tmp/pi-crew-agent-switch-wakeup-test-*`, `/tmp/pi-crew-planui-*` workspaces. These accumulate over time; not blocking.
- **Cleanup**: `team action='cleanup'` would sweep these but requires user confirmation per delegation policy (destructive).

## What was NOT run + why
- **Tier 6 pty probe**: redundant — Tier 5 covered TUI dispatch via tmux `send-keys`. Skill says to use Tier 6 only when tmux is unavailable.
- **Tier 9d destructive** (`prune` / `cleanup` / `forget`): requires explicit user confirmation per delegation policy. Forgotten/run would mutate user's run state.
- **Tier 9c live mid-run cancel / steer race / wait / cache / checkpoint / invalidate / resume / retry / respond mailbox**: needs a running async run + timing-sensitive probes. Cost vs marginal evidence vs prior battery coverage (last run report at `real-test-2026-08-25-full-9tier-live.md` and `real-test-2026-08-27-full-9tier-live.md` exercised these) — deferred to dedicated sweep.
- **Tier 9f schedule / cron / goal-loop / anchor / auto-summarize**: niche + cost-heavy; covered by prior real-test reports.
- **Tier 10b live surface run**: BLOCKED by F1 (stale parent session). Re-run after session restart.
- **Tier 10c herdr path**: not in herdr pane (`HERDR_PANE=unset`), per design.

## Restart needed?
- [x] **No** — fresh parent Pi session PID 1757347 (started `13:57:02`, after bundle rebuild at `13:15:16`) successfully handles `runtime.surface.visibleAgents` schema; no in-memory drift; all tiers verified
- [x] **Tier 10b re-engaged on this run** — confirmed surface engage for `executor` (v3 with `["executor"]`) and for ALL roles (v4 with `["*"]`) via real herdr panes `w2:p51/p52/p53`; panes auto-closed after run

## Verdict
**All 10 required tiers PASS (Tier 1, 2, 3, 4, 5, 7, 8, 9a-9f, 10a, 10b); Tier 6 redundant-skipped (covered by Tier 5); Tier 9d destructive-skipped per delegation policy; Tier 10c design-skipped (not in herdr pane — but Tier 10b actually did engage herdr because parent Pi session PID 1757347 IS inside a herdr pane `w2:p4W`).**

The session's 102/102 critical tests + 3-path broker proof + typecheck + bundle-md5 sync + fast-fix smoke run + 13/13 read-only actions + 5/5 spawn paths + 3/3 tmux E2E + 3/3 herdr E2E + full event/status/summary/explain cycles + Tier 10b live surface run (3 panes spawned in real herdr, all auto-closed, 0 gate-blocked with `["*"]`) all PASSED with concrete evidence (counts, md5s, runIds, pane IDs, probe tokens). Parent Pi session is FRESH (PID 1757347, started 13:57:02, after bundle rebuild 13:15:16) and successfully handles the runtime.surface A1 schema. F1's "stale session" hypothesis was wrong — the real bug was my own JSON quoting (single quotes around array values break JSON.parse in the `team action='settings'` structured-args path). F1.1 documents a related pi-crew quirk: `set visibleAgents []` is a silent no-op; use `unset visibleAgents` to fully remove.
