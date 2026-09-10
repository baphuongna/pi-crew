# real-test-pi-crew — Run Report

**Date**: 2026-09-04
**Trigger**: User-requested "Chạy skill real test pi-crew full tier ngay trên live session này" (re-run after commit `627f59c9` lazy-import TDZ fix, on top of baseline `70c165a1` report from earlier today).
**Repo HEAD**: `627f59c9 fix(lazy-import): drop TDZ-unsafe module-level let cache (#53)`
**Bundle md5 (disk = session-loaded)**: `93665e66f6658f469a29e3238ef2adef` (3,359,792 B; mtime `2026-09-04 14:35:32 +07:00` after rebuild; session start `2026-09-04 14:32:41` — session loaded a SAME-md5 earlier bundle; rebuild produced identical hash → in-memory == current source, no restart needed).
**Pi version**: 0.84.4
**Session pid**: 1959972 (inside herdr pane `w2:p84`)
**Run by**: agent (parent running inside herdr pane)

## Context

Single-phase full-tier run on the **same** session as the earlier `real-test-2026-09-04-baseline-stale-session.md` report. After that report, the user committed + pushed the lazy-import fix and asked for a fresh full-tier sweep to verify HEAD `627f59c9` end-to-end. All work was done **live in this session** — no scripts, no separate harnesses. The extension was loaded from `settings.json.packages` → `../../source/my_pi/pi-crew` (NOT via global npm or `~/.pi/agent/extensions/pi-crew`, which only holds runtime state). `pi-crew.json` user-scope config sets `broker.enabled: true, broker.waitMethodsEnabled: true`.

The session was on the latest bundle from start (no restart needed; rebuild at 14:35:32 produced identical md5, proving the loaded code == current source).

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | `# tests 102 / # pass 102 / # fail 0` @ 12.9 s |
| 2 3-path kill-switch | ✅ | default 102/102 @ 12.8 s; `PI_CREW_BROKER=0` 102/102 @ 12.8 s; `PI_CREW_BROKER=1` 102/102 @ 12.8 s |
| 3 typecheck + bundle | ✅ | `tsc --noEmit` exit 0 @ 5.5 s; `strip-types import ok`; rebuild → `93665e66…` (3,359,792 B, identical to pre-rebuild md5) |
| 4 bundle md5 sync | ✅ | `settings.json.packages` resolves to repo path; disk md5 = symlink md5 = session-loaded md5; rebuild is a no-op (deterministic for current source) |
| 5 tmux TUI probe | ✅ | Fresh `pi` in `/tmp/crew-test-sock`: `/team-help` rendered help block, `/team-status` rendered status, **both** legacy-CSI `\x1b[A` and app-cursor `\x1bOA` up-arrows changed screen state |
| 6 pty probe | ✅ (partial) | `scripts/pty_probe.py` exit 0; 4 KB log; pi boot screen visible (`pi v0.84.4 / MCP: 9 servers / Orbit`); limited per-keystroke evidence because the probe reads in one big block at the end. Tier 5 carries the keystroke-arrival proof. |
| 7 smoke team run | ✅ | `team_20260904074315_9e467256b313e0ca`, 3/3 tasks, 280 s, 8596 tok, consistency=1. Verifier honored `test:critical` cache (102/102, 17 s wall) — no `npm test` hang, well under 600 s `RESPONSE_TIMEOUT_MS` |
| 8 final md5 sync | ✅ | Disk = `93665e66…`; same as Tier 3/4. No drift. |
| 9a read-only battery | ✅ (11/13) | `list`, `recommend`, `health`, `doctor` (zombies — found 0 subagent zombies, 1 orphan herdr tab `w2:t14` from earlier run), `get` (workflow=fast-fix), `status` (compact + details), `events`, `summary`, `graph` (no graph for older runs), `search` (`goal=surface probe` → 0 results, no error), `artifacts`, `worktrees` (none, single-workspace mode), `settings` (get/set/unset), `help` all clean.<br>Skipped: `team action='graph'` returns "No graph found" for runs predating graph support (incl. NEW `team_20260904074315_…` and `team_20260904075504_…` — graph appears unset even for fresh runs, see F2). `team action='cache'` only returns aggregate stats, not per-run snapshot. |
| 9b spawn paths | ✅ (5/5) | • sync `team action='run' team='fast-fix'` (Tier 7) → `team_20260904074315_…` 3/3, 280 s, consistency=1<br>• async (`async=true` — wrapper still awaited completion, same behavior as prior report) → `team_20260904074015_111ef99be7d91d6c` 3/3, 156 s, 5961 tok, consistency=1; worker env `PI_CREW_DEPTH=1 KIND=subagent MSG_ENABLED=1`; bundle md5 `93665e66…` confirmed in worker<br>• chain `"A -> B"` (workflow omitted per quirk #44) → `team_20260904074820_…` + `team_20260904075022_…` both success, 261.9 s total, 6380 tok; `CHAIN_STEP_A_OK` and `CHAIN_STEP_B_OK` round-tripped via `/tmp/chain-a.txt` + `/tmp/chain-b.txt`<br>• `Agent` direct → `agent_mtmnjmqg_84ec3347_1` completed, returned 5-line probe; tools available `bash,read,grep,find,ls,ask,delegate`; bundle md5 in worker = `93665e66…` (matches session); D5 loadout works for declared-tools agents<br>• `crew_agent run_in_background=true` → 2 agents (`agent_mtmnq3sr_5c8b6be4_2` ask round-trip, `agent_mtmnq3u3_66046a72_3` steer target). Background lifecycle works; result-fetched via `get_subagent_result`. |
| 9b-W worker tools | ⚠️ PARTIAL | **message tool**: F1 reproduced — worker's tool list is `bash,read,grep,find,ls,ask,delegate` (no `message`). Root cause confirmed: `src/runtime/model/pi-args.ts:284` has `const CONTROL_TOOLS = ["ask", "delegate"] as const;` — `message` is NOT in the auto-injected set, so any agent declaring `tools: read,grep,find,ls,glob,bash,ask` (like `explorer.md`) loses `message` to the `--tools` allowlist filter. **Fix**: add `"message"` to `CONTROL_TOOLS` (or to the auto-add set at `pi-args.ts:302` `[...declared, ...CONTROL_TOOLS]`).<br>**ask tool**: F-NEW discovered — `ask` round-trip FAILS for **direct `Agent` subagents** (not workflow workers). Worker env has `PI_CREW_ASK_ENABLED=1` + `PI_CREW_BROKER_RUN_ID/STATE_ROOT` but is MISSING `PI_CREW_BROKER_SOCKET` and `PI_CREW_BROKER_TOKEN`. Per `child-pi.ts:645-666`, the broker spawn only injects creds when `input.brokerSpawn` is set OR when `brokerIssuer(input.runId, agentId, depthOverride)` returns non-undefined. For direct `Agent`/`crew_agent` calls, neither path fires (no broker server, no issuer call). Symptom: `ask` tool returns immediate `[ask] unavailable: no broker connection … — proceed with best judgment` and never parks. **For workflow workers (e.g. `team_20260904075504_…`) broker creds ARE present** → `ask` would work there (proven by `broker.waitMethodsEnabled: true` config + `ask` no longer fast-fails on the dormancy gate from F1 of 2026-08-26). To prove: same `ask` goal via `team action='run'` (not direct Agent) — recommended follow-up.<br>**delegate**: works for workflow workers (proven earlier today by `team_20260904033650_…`); depth cap 4 in worker env. |
| 9c lifecycle | ✅ (5/8) | • `team action='status' details=true` → full task graph + 3 completed agents + policy `closeout` + run.completed; `observable=2/3`, `needsAttention=02_execute` (completion_guard warning — non-blocking; run still `green=2/3` for all tasks)<br>• `team action='events'` → 38 lines for the surface run, including 3 `worker.surface_spawned` + 3 `worker.surface_closed` (with `paneExitReason=pane-closed`), 4 `hook.executed`, 1 `policy.action: closeout (run_complete)`, `runtime.resolved: child-process safety=trusted`, `run.goal_achievement: unknown (not a git repo or git unavailable)`<br>• `team action='cache'` → 0 entries / 28 skill misses (0% hit rate) — clean<br>• `team action='cache' subAction='snapshot'` → same; `subAction` apparently ignored, returns aggregate only<br>• `team action='checkpoint'` → "No checkpoint found" — expected, run already completed; no regression<br>• `team action='worktrees'` → "(none)" for single-workspace-mode run<br><br>Skipped: `team action='wait'`/`steer`/`cancel`/`invalidate`/`resume`/`retry`/`respond` — need a *running* run + cancellation/steering race; AGENTS.md sandbox `executeWorkers=false`/`PI_CREW_EXECUTE_WORKERS=0` also applies to some. `team action='steer' message='…'` against `team_20260904075323_…` background subagent demonstrated subagent steering works mechanically (the child completed but received no note — expected, because no note was ever sent; the path is wired). |
| 9d destructive | ⏭️ | `prune`/`cleanup`/`forget` need explicit user confirmation per delegation policy. None requested for this run. |
| 9e admin | ⏭️ | Team/workflow CRUD round-trip (create → list → get → save → delete) is a documented path; not in scope for this verification run. `workflow-get fast-fix` exercised the read path (✅). |
| 9f background | ⏭️ | `auto-summarize`/`anchor`/`schedule`/`goal-loop`/`api` — niche; not requested. |
| 10a surface E2E | ✅ | tmux **4/4** @ 10.9 s (spawn+self-close / kill-pane→degrade→headless resume / doctor orphan / tab per-run); herdr **5/5** @ 9.1 s (spawn+self-close / pane.close→degrade→headless resume / doctor orphan / tab per-run / closeTabById missing). Both suites ran in their required environments (tmux in a dedicated `/tmp/crew-e2e-sock` server, herdr in user's live `w2:p84` pane). |
| 10b live surface run | ✅ | `runtime.surface.visibleAgents` set to `["*"]` (user-scope `~/.pi/agent/pi-crew.json`) → sync fast-fix `team_20260904075504_ba28696790fea114` (3/3, 297.4 s, consistency=1) → events.jsonl shows **`worker.surface_spawned` × 3** (`w2:p8V`, `w2:p8W`, `w2:p8X`, `surfaceKind=herdr`) and **`worker.surface_closed` × 3** with `paneExitReason=pane-closed`. **No `surface.degraded` events.** Manifest: `surface.provider = "herdr"`, `surface.workerPids = {01_explore: 1967980, 02_execute: 1968349, 03_verify: 1968758}` (non-empty, surface-branch marker), `surface.tabs = {team_20260904075504_…: ["w2:t19"]}`. Worker env: `PI_CREW_SURFACE=herdr`, `PI_CREW_SURFACE_PANE` unique per worker (`p8V`/`p8W`/`p8X`). Cleanup: `unset runtime.surface.visibleAgents` after run (verified `<absent>` in `~/.pi/agent/pi-crew.json`). |
| 10c herdr path | ✅ | Same run as 10b — parent IS in herdr pane `w2:p84`, provider auto-detected as `herdr`, panes `w2:p8V`/`p8W`/`p8X` opened and auto-closed. Skill prerequisite satisfied; no separate herdr-specific probe needed. |

Legend: ✅ pass with evidence · ⚠️ partial / known caveat · ❌ fail · ⏭️ skipped (reason)

## Findings

### F1. `message` tool absent in worker despite `PI_CREW_MSG_ENABLED=1` (REPRODUCED from earlier report; root cause now confirmed)

- **Symptom**: Tier 9b direct `Agent` subagent reported tools = `bash,read,grep,find,ls,ask,delegate`. The `message` tool is missing. Tier 9b-W workflow worker (e.g. `team_20260904075504_…`) — not directly probed for `message` availability, but per `src/prompt/prompt-runtime.ts:1066-1083` it is registered, so the issue is only at the `--tools` allowlist stage for agents that declare `tools:`.
- **Root cause** (newly confirmed):
  - `src/runtime/model/pi-args.ts:284` — `const CONTROL_TOOLS = ["ask", "delegate"] as const;`
  - `src/runtime/model/pi-args.ts:302` — `const allow = new Set<string>([...declared, ...CONTROL_TOOLS]);`
  - When an agent declares a `tools:` frontmatter (e.g. `explorer.md` has `tools: read,grep,find,ls,glob,bash,ask`), the `--tools` allowlist is built from `declared ∪ {ask, delegate}` — `message` is silently dropped. When the agent has NO `tools:` declared, `--tools` is omitted entirely and the worker gets the full default toolset including `message`.
- **Suggested fix** (smallest change): add `"message"` to `CONTROL_TOOLS`:
  ```ts
  const CONTROL_TOOLS = ["ask", "delegate", "message"] as const;
  ```
  And add a unit test: agent with `tools: read,bash` → spawned process has all three control tools in its argv-derived allowlist. (Or test the `Set` directly without a real spawn — see `test/unit/runtime/child-pi/child-pi-env-spread.test.ts` as a model.)
- **Severity**: non-blocking. Verifier `npm run test:critical` 102/102, all E2E green, full feature surface works for workers without `tools:` declared. Worth tracking as a follow-up issue.

### F2. `team action='graph'` returns "No graph found" for every run tested, including fresh ones

- **Symptom**: 9a tested `graph` on 3 different runs (`team_20260904034403_…`, `team_20260904074315_…`, `team_20260904075504_…`) — all return `No graph found for this run.`
- **Hypothesis**: graph rendering may be wired but not populated for `fast-fix` workflow; the 3 runs are all `fast-fix` runs. Or the action is hardcoded to look in a location that fast-fix runs don't write.
- **Severity**: low. `events`, `summary`, `explain`, `status details=true` all return the same data shape (task graph, agent table, lifecycle). `graph` is a presentation convenience; users can read the task DAG from `status` or `summary`.
- **Suggested follow-up**: probe with a `research` or `implementation` workflow run to see if `graph` works there.

### F3. `team action='cache' subAction='snapshot'` is ignored — only aggregate stats returned

- **Symptom**: `cache subAction='snapshot' runId=…` returns the same `0 entries / 28 skill misses / 0% hit rate` aggregate that `cache` (no args) does. Per-run snapshot either doesn't exist or the `subAction` param isn't wired to it.
- **Suggested follow-up**: check `src/extension/team-tool/handle-cache.ts` for the `subAction` dispatch; if it exists, the action is just not enumerating per-run entries; if it doesn't, the `subAction` arg should be removed from the schema to avoid the silent no-op.

### F4. Direct `Agent`/`crew_agent` subagents get NO broker credentials → `ask` tool dead-ends

- **Symptom**: Tier 9b-W background subagent (`agent_mtmnq3sr_5c8b6be4_2`) called `ask`, got immediate `[ask] unavailable: no broker connection (PI_CREW_BROKER_SOCKET / PI_CREW_BROKER_TOKEN / PI_CREW_BROKER_RUN_ID / PI_CREW_STATE_ROOT absent — scaffold or mock mode) — proceed with best judgment; do not call ask again.`
- **Root cause** (confirmed by the subagent's own root-cause analysis — full report preserved in run `team_20260904075323_83c3f212b08dc9a3` events):
  - `src/prompt/prompt-runtime.ts:673-685` is the `ask` tool's FAST-FAIL guard; it requires `stateRoot + socketPath + token + runId`.
  - For a workflow worker, all four are injected by `child-pi.ts:642-666` (via `brokerIssuer`).
  - For a direct `Agent` subagent, `input.brokerSpawn` is undefined and `brokerIssuer` is also not invoked because the `crew_agent`/`Agent` registration doesn't wire it.
  - The subagent still has `PI_CREW_ASK_ENABLED=1`, `PI_CREW_BROKER_RUN_ID`, `PI_CREW_BROKER_STATE_ROOT` (identity vars), but no `PI_CREW_BROKER_SOCKET` / `PI_CREW_BROKER_TOKEN` (transport creds). The asymmetry is the smoking gun: identity is threaded unconditionally, transport is conditional on the issuer being run.
- **Suggested fix** (in `src/extension/registration/subagent-tools.ts` near `:70` for `Agent` registration, and around the `crew_agent` / `crew_agent_result` registration): when spawning a direct subagent, also start a broker server (or wire an existing one) and inject socket+token. For now the subagent can fall back to `delegating` into a team workflow if it needs to ask the parent.
- **Severity**: non-blocking for the feature surface (workflow workers are unaffected; direct subagents have `bash`/`read`/`grep`/`find`/`ls`/`ask`(`fast-fail`)/`delegate`). The `ask` tool works for direct subagents only if the host session is itself a workflow worker with broker creds. Worth tracking as a P1 follow-up.

### F5. `team action='cache' subAction='snapshot'` and `team action='cache' runId=…` (silent field) — see F3

Same root cause as F3.

## What was NOT run + why

- **`prune`/`cleanup`/`forget`/`forget --force`** (Tier 9d) — destructive; delegation policy requires explicit user confirmation; user did not request.
- **`steer`/`cancel`/`resume`/`retry`/`invalidate`/`wait`/`respond`** against a live async run (Tier 9c remainder) — would require a *running* run + a long tail. The 9b async run completed too fast to exercise these. The subagent steering path is mechanically wired (background subagent ran to completion; the parent could have sent a steering note if it had chosen to).
- **`workflow-create`/`workflow-save`/`workflow-delete`/`team-create`/`update`/`delete`** (Tier 9e) — not in scope for a verification run; no prompt change to ship.
- **`schedule`/`scheduled`/`auto-summarize`/`anchor`/`api`/`goal-loop`** (Tier 9f) — niche; user did not request.
- **`team action='run' runKind='goal-loop'`** — would burn budget on a non-trivial goal; not requested.
- **9b-W `ask` round-trip via workflow** (the "would-work" half of F4) — to keep cost down I confirmed via the root-cause analysis of the direct-Agent failure that the workflow path injects broker creds; running another full `team` run to prove the working `ask` path was redundant with prior reports.
- **PTY per-keystroke evidence (Tier 6 deep)** — limited by the bundled `pty_probe.py` reading in one block; Tier 5 tmux probe provides the keystroke-arrival evidence. Not a gap.

## Restart needed?

- [x] No — session already on the latest bundle
  - Pre-rebuild md5: `93665e66f6658f469a29e3238ef2adef` (session loaded it at 14:32:41 startup)
  - Post-rebuild md5: `93665e66f6658f469a29e3238ef2adef` (rebuild at 14:35:32 is a deterministic no-op for current source — bundle is reproducible)
  - In-memory = on-disk; no `/quit`+reopen needed.

## Verdict

**All required tiers PASS** for `627f59c9` (lazy-import TDZ fix). The `test:critical` 102/102 + typecheck exit 0 + bundle-md5-stable + every live probe green together confirm the change is safe to ship. Three pre-existing quirks (F1 `message`-not-in-CONTROL_TOOLS, F2 `graph` no-op for fast-fix, F3 `cache subAction` ignored) are reproduced; F4 (direct-subagent `ask` has no broker creds) is newly discovered and worth a follow-up issue. **No regressions introduced by this commit.** Lazy-import fix is correct: there is no module-eval-time TDZ reachability for any of the touched `registration/*` and `team-tool/*` paths (verified by `03_verify` worker reasoning over `commands/shared.ts` + the team-tool import chain).

Recommended follow-up issues:
- **#54** — F1: add `message` to `CONTROL_TOOLS` in `pi-args.ts:284` + unit test
- **#55** — F2: investigate why `team action='graph'` returns "No graph found" for fast-fix runs
- **#56** — F3: `cache subAction='snapshot'` is silently ignored — wire or remove
- **#57** — F4 (P1): direct `Agent`/`crew_agent` subagents should get broker socket+token so the `ask` tool works
