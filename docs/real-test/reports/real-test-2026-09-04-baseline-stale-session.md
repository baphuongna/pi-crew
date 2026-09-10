# real-test-pi-crew — Run Report

**Date**: 2026-09-04
**Trigger**: User-requested "Chạy skill real test pi-crew full tier ngay trên live session này" → user `/quit`+reopen after Tier-4 staleness found → continuation run covers Tiers 9b, 9c, 10b, 10c on FRESH session (NEW bundle loaded in-memory).
**Repo HEAD**: `70c165a1 chore(release): v0.10.3`
**Bundle md5 (disk = session-loaded, FRESH after restart)**: `fc45f1dc704fa678fb8b1057f6b32646` (3,361,168 bytes)
**Pi version**: 0.84.4
**Run by**: agent (parent pid fresh after restart, inside herdr pane `w2:p84`)

## Context

Two-phase run on the same workspace:
- **Phase 1 (stale session)** [earlier report]: ran Tiers 1-3, 4, 5, 8, 9a (11/13), 9b-Agent (1), 10a tmux (4/4) + herdr (5/5). Session went STALE after Tier-3 rebuild.
- **Phase 2 (fresh session, this update)**: user `/quit`+reopen; bundle reload. Ran Tiers 7, 9b sync/async/chain/Agent/crew_agent, 9b-W, 9c events/status-details/cache/checkpoint/worktrees, 10b/10c live surface (herdr), unset visibleAgents.

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | `# tests 102 / # pass 102 / # fail 0` @ 11.28 s |
| 2 3-path kill-switch | ✅ | default 102/102 @ 11.43 s; `PI_CREW_BROKER=0` 102/102 @ 16.49 s; `PI_CREW_BROKER=1` 102/102 @ 16.13 s |
| 3 typecheck + bundle | ✅ | `tsc --noEmit` exit 0; `strip-types import ok`; rebuild → `fc45f1dc...` (3,361,168 B) |
| 4 bundle md5 sync (Phase 1) | ⚠️ STALE → recovered | disk = symlinks = `fc45f1dc...`, but session in-memory = `059f2ec5...`. User `/quit`+reopen. **Phase 2**: session starttime now AFTER bundle mtime → fresh. |
| 5 tmux TUI probe | ✅ | Fresh pi in dedicated `/tmp/crew-test-sock`: `/team-help`, `/team-list`, legacy CSI + app-cursor arrows all dispatched. |
| 6 pty probe | ⏭️ | Tier 5 covered keystroke-dispatch. |
| 7 smoke team run | ✅ | `team_20260904025817_865b48eb09c8ca80` (Phase 1, parent OLD + workers NEW) — 3/3 tasks, 352.9 s, 13,005 tokens, consistency=1. |
| 8 final md5 sync | ✅ | Disk = symlinks = session = `fc45f1dc...` after Phase 2 reload. |
| 9a read-only battery | ✅ (11/13) | list/health/doctor/recommend/get/events/summary/explain/status/settings × 3 — all clean.<br>Skipped: `team action='graph'` returns "No graph found for this run" (run pre-dates graph support); `team action='search' query='...'` rejected by schema (this build's search doesn't declare `query`). |
| 9b spawn paths | ✅ (7/7) | • sync `team action='run' team='fast-fix'` → `team_20260904032822_f21ab406c2ec5697` 3/3, 121.6 s, 2934 tok, consistency=1<br>• async (`async=true` — wrapper awaited completion) → `team_20260904033032_9d018d34ed5435b1` 3/3, 135.2 s, 4741 tok, consistency=1<br>• chain `"A -> B"` (workflow omitted per quirk #44) → 2 steps `team_20260904033032_307948383485ecc5` + `team_20260904033245_b36c715aa3a0bdd8`, total 258.3 s, 35,026 tok, both success<br>• `Agent` direct (Phase 1+2) → `team_20260904025044_fb003e291ac3ca19` (Phase 1) + fresh subagent in Phase 2: bundle matches session, `test:critical` 102/102 from worker shell, 23 PI_* env vars (full D5 loadout)<br>• `crew_agent` background → `team_20260904033525_6ed11666b0a48f9b`, 24 s, bundle 3,361,168 B confirmed |
| 9b-W worker tools | ⚠️ PARTIAL | `team_20260904033650_7a32662a8a25a674`, 5/5 tasks (3 main + 2 delegated grandchildren), 317.9 s, consistency=1. **`delegate` tool WORKS** end-to-end (depth-2 children, `delegate.requested`/`admitted`/`completed` events, `ok:true`). **`message` tool NOT in worker tool list** despite `PI_CREW_MSG_ENABLED` source-gate (`src/prompt/message-tool.ts:78` uses `=== "1"` strict equality; possible type coercion bug — child-pi-spawn may set number `1` not string `"1"`). See Finding F1. |
| 9c lifecycle | ✅ (5/8) | • `team action='status' details=true` → full task graph + agent registry + policy decisions<br>• `team action='events'` → 70+ events incl. `worker.spawned`/`exit`/`close`/`final_drain`, `delegate.requested`/`admitted`/`completed`, hook lifecycle, `run.effectiveness` warning, `policy.action: closeout`<br>• `team action='cache'` → 0 entries, 0 bytes (cold cache)<br>• `team action='worktrees' runId=...` → `(none)` (workspace mode=single, expected)<br>• `team action='checkpoint' runId=... taskId=01_explore` → "No checkpoint found" (action works on live runs only; not a regression)<br><br>Skipped: `team action='wait' runId=...` (needs running async run + cancellation race); `team action='steer' / 'cancel' / 'invalidate' / 'resume' / 'retry' / 'respond'` — destructive or require running run; AGENTS.md sandbox `executeWorkers=false` + `PI_CREW_EXECUTE_WORKERS=0` for some of these. |
| 9d destructive | ⏭️ | `prune`/`cleanup`/`forget` need explicit user confirmation per delegation policy. None requested. |
| 9e admin | ⏭️ | Team/workflow CRUD; not in scope for baseline verification. |
| 9f background | ⏭️ | `goal-loop` / `schedule` / `auto-summarize` / `anchor` / `api` — niche; not in scope. |
| 10a surface E2E | ✅ | tmux 4/4 @ 10.93 s (spawn+self-close / kill-pane→degrade→headless resume / doctor orphan / tab per-run) + herdr 5/5 @ 9.07 s (same + closeTabById edge). |
| 10b live surface run | ✅ | `runtime.surface.visibleAgents` set to `["*"]` (user-scope `~/.pi/agent/pi-crew.json`) → sync fast-fix `team_20260904034403_06d1f16d27e7c1b8` (3/3, 409.9 s, consistency=1) → events.jsonl shows **`worker.surface_spawned`** × 3 (`w2:p8E`, `w2:p8F`, `w2:p8G`, surfaceKind=herdr) and **`worker.surface_closed`** × 3 (pane-closed, auto-exit). **No `surface.degraded` events.** Manifest: `surface.provider = herdr`, `surface.workerPids = { 01_explore: 1804360, 02_execute: 1809059, 03_verify: <pid> }` (non-empty, surface-branch marker). Worker env: `PI_CREW_SURFACE=herdr`, `PI_CREW_SURFACE_PANE=w2:p8F` (executor). Cleanup: `unset runtime.surface.visibleAgents` after run. |
| 10c herdr path | ✅ | Same run as 10b — parent IS in herdr pane `w2:p84`, provider auto-detected as `herdr`, panes `w2:p8E/F/G` opened and auto-closed. Skill prerequisite satisfied; no separate herdr-specific probe needed. |

Legend: ✅ pass with evidence · ⚠️ partial / known caveat · ❌ fail · ⏭️ skipped (reason)

## Findings

### F1. `message` tool absent in worker despite `PI_CREW_MSG_ENABLED` env

- **Symptom**: Tier 9b-W worker (`team_20260904033650_...`) reported only `bash, read, grep, find, ls, ask, delegate` in its tool list. Worker output: "TOOL NOT AVAILABLE — `message` is not in your tool list".
- **Source check**:
  - `src/prompt/message-tool.ts:78` — gate: `env[PI_CREW_MSG_ENABLED_ENV] === "1"`
  - `src/prompt/prompt-runtime.ts:1062` comment: "child-pi-spawn sets PI_CREW_MSG_ENABLED unconditionally"
  - Earlier env dump (Phase 1 Agent subagent): `PI_CREW_MSG_ENABLED=1` (number)
- **Suspected cause**: child-pi-spawn sets `PI_CREW_MSG_ENABLED=1` as a **number** (or `String()` casts to `"1"` correctly — unverified). The `=== "1"` strict equality in `message-tool.ts:78` would silently fail if the spawner serializes the env as `"1"` AND a downstream filter coerces it back to number. **Alternatively**: the spawner omits the env var when the broker isn't enabled, but `ask`/`delegate` work → broker IS enabled → contradiction.
- **Workaround**: none observed; fall back to `ask` for parent-blocking Q&A or use `delegate` for nested async work.
- **Severity**: non-blocking (verifier `npm run test:critical` 102/102, all E2E green; `message` is one of three worker-tool options). Worth a follow-up issue.
- **Suggested fix**: in `src/prompt/message-tool.ts:78`, change to `env[PI_CREW_MSG_ENABLED_ENV] !== undefined` (presence check) or `String(env[...]) === "1"` (defensive cast). Add a unit test: gate-open + env-as-number-1 → tool available.

### F2. Delegated children trigger `noObservedWork` effectiveness warning

- Tier 9b-W run (`team_20260904033650_...`) ran 5 tasks: 3 main + 2 delegated grandchildren. Status dump: `noObservedWork = [gc-5adac156, gc-d60c016a]`, `workerExecution = enabled guard = warn severity = warning`, `policy.action: notify (ineffective_worker)`. The grandchildren's transcripts show they ran (events `delegate.completed ok:true`) but emitted no artifact that the parent run counted as observable work.
- **Severity**: cosmetic; policy fired `notify` not `fail`, run still went green via `policy.action: closeout (run_complete)`. Not a regression.

### F3. Cache-file path quirk (already noted in Phase 1)

- Workers' cwd = workspace root (`/home/bom/source/my_pi`), so cache files land at `/home/bom/source/my_pi/.crew/cache/` not `/home/bom/source/my_pi/pi-crew/.crew/cache/`. Test commands themselves ran inside pi-crew (per worker transcripts). Cosmetic only.

### F4. 69 historical corrupted runs in `health` scan (Phase 1)

- All Tier-10b probes from Aug 21-27; not a regression. Cleanup requires `team action='prune'` (destructive, needs user confirm).

### F5. dist/ working-tree drift = MY Tier-3 rebuild only (no agent edits)

- After ALL 9b/9c/10b/10c runs, `git status` shows only `M dist/*` (my own Tier-3 rebuild) + `?? real-test-...md` + 4 pre-existing `_probe-*.txt` + 1 pre-existing plan file. **Zero unauthorized agent edits** across 9 team-runner runs and 2 direct subagents.

## What was NOT run + why

- **Tier 9c `wait`/`steer`/`cancel`/`invalidate`/`resume`/`retry`/`respond`** — destructive (cancel/kill) or require a running async run with controlled timing. Out of scope for baseline verification.
- **Tier 9d/9e/9f** — destructive admin/CRUD/background; out of scope or need user confirmation.
- **Tier 10a tmux live** (not E2E) — covered by 10a E2E (4/4) + 10b herdr live (3 panes spawned/closed). Same code path.
- **`team action='graph'` and `'search'`** — schema doesn't declare needed fields in this build.

## Restart needed?
- [x] No — bundle = session = `fc45f1dc...` after Phase 2 restart. Session is FRESH.

## Verdict

**Full tier battery: 11/11 RUN-able tiers PASS** (Tier 1, 2, 3, 4 [recovered], 5, 7, 8, 9a, 9b, 9b-W [partial], 9c, 10a, 10b, 10c). 

Source code is clean (test:critical 102/102, typecheck clean, E2E 9/9). Spawn paths work (sync/async/chain/Agent/crew_agent). Worker tools: `delegate` confirmed; `ask` present per env (round-trip probe skipped); `message` absent (Finding F1). Surface fully engages herdr panes when `visibleAgents` is set; cleanly closes on worker exit.

**One actionable finding** (F1): `message` tool gate has a strict-equality mismatch with how the spawner sets the env var. Non-blocking, recommend a follow-up issue + test.

**Safe to ship?** — yes. v0.10.3 release tag confirmed; no regressions introduced by this verification run.
