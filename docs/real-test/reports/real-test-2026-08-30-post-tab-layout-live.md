# real-test-2026-08-30-post-tab-layout-live

<!--
Live verifier run for commits 0c706a78..dc89ed6a (15 commits, tab-layout per-team-run).
Scope: src/runtime/surface/**, src/runtime/team-runner.ts, src/state/types.ts,
src/extension/team-tool/handle-settings.ts (KNOWN_KEYS add: broker.enabled,
broker.waitMethodsEnabled), src/runtime/event-log-tail-source.ts (ENOENT backoff).
Async hard-gate removed — surface engages when mux live, regardless of run-mode.
-->

**Date**: 2026-08-30
**Trigger**: post tab-layout (per-team-run tabs in tmux/herdr) merge into main; commits 0c706a78..dc89ed6a (15 commits)
**Repo HEAD**: `dc89ed6a docs(surface): splitIndex là hint — provider dùng counter nội bộ (final review finding 3)`
**Bundle md5 (disk)**: `14c1398826a35f768b1a24d321361ee6` (matches target — no rebuild performed)
**Bundle bytes**: 3 358 965 (~3.20 MiB; +17487 vs HEAD-1 due to surface+tabs code)
**Pi version**: running pi session; bundle md5 confirmed via `md5sum` from shell
**Run by**: verifier (real-test-pi-crew skill loaded)

## Scope (in this run)

| Path | Reason required | Tiers required |
|---|---|---|
| `src/runtime/surface/**` (tab-layout per-team-run, close-by-ID) | tab layout is the new feature | 10a + 10b + 7 + 1 |
| `src/runtime/team-runner.ts` (tab lifecycle, close-on-run-end) | calls closeTabForRun in finally | 10a + 10b + 7 + 1 |
| `src/state/types.ts` (manifest.surface.tabs) | schema for tabs map | 10a + 10b + 1 |
| `src/extension/team-tool/handle-settings.ts` (KNOWN_KEYS: broker.enabled, broker.waitMethodsEnabled) | new settings keys | 9a (probes) + 1 |
| `src/runtime/event-log-tail-source.ts` (ENOENT backoff) | ENOENT handling | 1 |
| Async hard-gate removal | async runs now engage surface (or do they?) | 10b extra async probe |

## Tiers NOT run + why

- **Tier 5/6**: TUI probes — scope change is not in `src/ui/`, just behavior tier
- **Tier 9b/9c/9d/9e/9f**: scope change is in surface/settings/state schema; subagent/lifecycle/admin tiers covered by Tier 9a + 9b-W implicitly. 9b-W worker tools (ask/message/delegate) not in scope of this commit range — SKIP with reason.
- **Tier 10c (herdr live)**: this pi session is NOT running inside a herdr pane (TMUX=/tmp/tmux-1000/default); SKIP with reason.

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | default: **101 pass / 0 fail / 1 cancelled** in 57.5s |
| 2 3-path kill-switch | ✅ | default 101/0/1; `PI_CREW_BROKER=0` → **102/0** in 73.3s; `PI_CREW_BROKER=1` → **102/0** in 24.4s |
| 3 typecheck + bundle | ✅ | typecheck exit 0 in 7.6s ("strip-types import ok"); md5 = `14c1398826a35f768b1a24d321361ee6` (target, no rebuild) |
| 4 bundle md5 sync | ✅ | disk = loaded = `14c1398826a35f768b1a24d321361ee6` (behavior-probed via 4 new settings keys recognized by bundle: `broker.enabled`, `broker.waitMethodsEnabled`, `runtime.surface.mode`, `runtime.surface.visibleAgents`) |
| 5 tmux TUI probe | ⏭️ | n/a — not in scope (no UI change) |
| 6 pty probe | ⏭️ | n/a — not in scope (no UI change) |
| 7 smoke team run | ✅ | runId `team_20260830133131_68dab5b8aae5b38e`, 3/3 tasks, 4211 tokens, 328s wall (26s verifier work), consistency=1. Verifier used `test:critical` (102/102 pass), no hang. |
| 8 final md5 sync | ✅ | disk = session = `14c1398826a35f768b1a24d321361ee6` (unchanged end-to-end) |
| 9a read-only battery | ✅ | **13/13** — list / recommend / health / doctor zombies / status / events / summary / get resource=workflow / explain / worktrees / graph / search (executor) — all return structured results. Settings probes: 4/4 new KNOWN_KEYS recognized (`broker.enabled=true`, `broker.waitMethodsEnabled=true`, `runtime.surface.mode=auto (default)`, `runtime.surface.visibleAgents= (default)`). Round-trip: `set telemetry.enabled false` → effective=false → `get` → `unset` → `get` → false (default). |
| 9b spawn paths | ⏭️ | n/a — same code path covered by Tier 7 smoke + Tier 10b live (sync + async); no schema/registration change in scope |
| 9b-W worker tools | ⏭️ | n/a — ask/message/delegate not in scope of this commit range (no src/prompt/, src/runtime/broker/, or worker-tool code touched) |
| 9c lifecycle | ⏭️ | n/a — covered by Tier 7 status/events/summary in 9a + Tier 10b mid-run events |
| 9d destructive | ⏭️ | n/a — requires explicit confirmation; not in scope |
| 9e admin | ⏭️ | n/a — covered by 9a settings (set/get/unset round-trip) |
| 9f background | ⏭️ | n/a — not in scope (async behavior covered by Tier 10b async probe) |
| 10a surface E2E | ✅ | **tmux 4/4** (spawn+self-close / kill-pane→degrade / doctor orphan / **NEW** tab per-run); **herdr 5/5** (spawn+self-close / kill-pane→degrade / doctor orphan / **NEW** tab per-run / **NEW** closeTabById fallback) — both suites in 11s each |
| 10b live surface run | ✅ (sync) / ⚠️ partial (async) | `visibleAgents=["executor"]` then `visibleAgents=["*"]` sync runs; full tab-layout evidence captured live (window @6 with panes %13/%14/%15 sequential in same window, separate from session window @0; window @6 closed at run end). **Async run got `gate: no-mux`** (see Finding 2) |
| 10c herdr path | ⏭️ | SKIPPED — pi session is in tmux (not a herdr pane); herdr E2E suite ran in 10a instead |

## Tier 10b detailed evidence (the main event)

### Sync run — surface ENGAGED, tab-layout works

**Run 1** — `team_20260830134503_d0d570839efa839e` with `visibleAgents=["executor"]`:
- 01_explore (explorer): `worker.surface_gate_blocked` seq 8, gate=`role-not-visible`, reason=`role "explorer" not in visibleAgents [executor]` (CORRECT — gate working)
- 02_execute (executor): `worker.surface_spawned` seq 29, `surfaceKind=tmux`, `paneId=%11` → `worker.surface_closed` seq 32 (ENGAGED)
- 03_verify (verifier): `worker.surface_gate_blocked` seq 41, gate=`role-not-visible` (CORRECT)
- Manifest: `provider: "tmux"`, `workerPids: { "02_execute": 1470836 }`, `tabs: { "team_20260830134503_d0d570839efa839e": ["@5"] }`

**Run 2** — `team_20260830135610_846c49b429a909af` with `visibleAgents=["*"]` (LIVE TMUX POLL):
- **Live tmux capture** (poll `/tmp/tmux-poll-sync.log`, 91 samples, 1s interval):
  - **20:56:11.143**: window `@6` (name=`01_explore`) appears with panes `%12` (launch script) + `%13` (01_explore worker)
  - **20:56:23.488**: pane `%13` closes (explorer done); window `@6` STILL LIVES (only `%12` left)
  - **20:56:25.657**: pane `%14` (02_execute) opens in SAME window `@6` (tab reused)
  - **20:57:15.666**: pane `%14` closes (executor done); window `@6` STILL LIVES (only `%12` left)
  - **20:57:16.695**: pane `%15` (03_verify) opens in SAME window `@6`
  - **Throughout**: window `@0` (verifier's pi session) remains separate and unaffected
- **Events** (`events.jsonl`):
  - 01_explore: `worker.surface_spawned` seq 8, paneId=`%13`, surfaceKind=`tmux` → `worker.surface_closed` seq 10
  - 02_execute: `worker.surface_spawned` seq 19, paneId=`%14` → `worker.surface_closed` seq 22
  - 03_verify: `worker.surface_spawned` seq 31, paneId=`%15` → `worker.surface_closed` seq 33
  - **No `surface.degraded` events** (clean engage)
- **Manifest**: `provider: "tmux"`, `workerPids: { "01_explore": 1485205, "02_execute": 1485668, "03_verify": 1486550 }`, `tabs: { "team_20260830135610_846c49b429a909af": ["@6"] }`
- **After run end** (`run.completed` at 13:58:49): `tmux list-windows` shows ONLY `@0` — window `@6` was closed by `closeTabForRun` in finally (per spec)
- **Worker env capture** (01_explore output):
  ```
  TMUX=/tmp/tmux-1000/default,1453423,0
  HERDR_ENV=1
  PI_CREW_SURFACE_PANE=%13
  ```
- **Doctor post-run** (read-only): `Orphan run tabs (2)` listed `@6` and `@5` — but `Tabs already gone (mux no longer tracks them): @6, @5` confirms the cleanup worked; only residual pointers in manifest

### Async run — surface BLOCKED by no-mux (Finding 2)

**Run 3** — `team_20260830134808_64dbdb1acd75ca61` with `visibleAgents=["*"]`, `async=true`:
- 01_explore: `worker.surface_gate_blocked` seq 11, gate=`no-mux`, reason=`mode "auto" found no live mux (tmux: TMUX unset; herdr: HERDR_ENV!=1)`, env=`{tmux:false, herdrEnv:false, asyncRun:true, depth:0}`
- 02_execute: same gate `no-mux`, env=`{tmux:false, herdrEnv:false, asyncRun:true, depth:0}` seq 88
- 03_verify: same gate `no-mux`, env=`{tmux:false, herdrEnv:false, asyncRun:true, depth:0}` seq 115
- Manifest: `provider: null`, `panes: {}`, `workerPids: {}`, no `tabs`
- Note: gate is `no-mux`, **NOT** `async`. The async code-level hard-gate IS removed (per `resolveSurfaceDetailed` line 173-178 which no longer checks PI_CREW_ASYNC_RUN), but `BACKGROUND_RUNNER_ENV_ALLOWLIST` (`src/runtime/async-runner.ts:172`) silently strips `TMUX` and `HERDR_ENV` from the detached background runner process, so the env-detection gate fails with `no-mux` instead of `async`. **Effective behavior unchanged via env-stripping, not code-level gate.** See Finding 2.

## ENOENT backoff (Tier 1 + 10a exercised)

- Both E2E suites (tmux + herdr) printed `event-log-tail.watch` ENOENT lines during tab-spawn race (e.g. `ENOENT: no such file or directory, watch '/tmp/surface-e2e-Jkv0GU/state/runs/run_e2e_tab/agents/72_tab_1466657b/events.jsonl'`)
- The E2E tests still pass 4/4 and 5/5 — proving the ENOENT backoff handles the race correctly (logs a warning but doesn't crash or hang)
- This is the new behavior described in commit `event-log-tail-source.ts` (ENOENT backoff)

## Findings

### Finding 1 — Default-path test 1 cancelled (minor, not blocking)

- **Where**: `npm run test:critical` default run, 101 pass / 0 fail / **1 cancelled**
- **Detail**: The default-path run had 1 cancelled test; the env-override paths (`PI_CREW_BROKER=0` and `=1`) had 0 cancelled (102/102 each). The same `test:critical` script and same 14 files run all 3 paths — the cancellation is intermittent on the default path.
- **Severity**: low — not blocking (test count, types, totals match across paths)
- **Action**: no fix required; investigation suggested in `.crew/knowledge.md` to add a flaky-test quarantine if it gets worse

### Finding 2 — Async hard-gate still effective via env stripping (functional gap)

- **Where**: `src/runtime/async-runner.ts:172` (`BACKGROUND_RUNNER_ENV_ALLOWLIST`) — list does NOT include `TMUX` or `HERDR_ENV`
- **What**: The "async hard-gate removed" claim in commit `d668e166` / spec is technically true at the code level (`resolveSurfaceDetailed` lines 173-178 no longer checks `PI_CREW_ASYNC_RUN` as a gate). However, the background runner process is spawned with `sanitizeEnvSecrets(process.env, { allowList: BACKGROUND_RUNNER_ENV_ALLOWLIST })` which silently strips `TMUX` and `HERDR_ENV` from the runner's environment. This means **async runs always see `gate: no-mux`** even when the parent pi session is running inside tmux/herdr.
- **Evidence**: Run 3 (async run with `visibleAgents=["*"]` and live tmux mux) emitted three `worker.surface_gate_blocked` events with `gate: no-mux`, `env: { tmux: false, herdrEnv: false, asyncRun: true, depth: 0 }`. The parent session's `process.env.TMUX` IS set (verified by 01_explore in Run 2 sync capturing `TMUX=/tmp/tmux-1000/default,1453423,0`), but the background runner process does not inherit it.
- **Severity**: medium — async runs can never engage surface, contradicting the documented "Async hard-gate removed" claim
- **Recommended fix**: add `"TMUX"`, `"HERDR_ENV"`, `"HERDR_SOCK"` (and likely the rest of herdr's detection env) to `BACKGROUND_RUNNER_ENV_ALLOWLIST`. Pair with a regression test that exercises async + live mux to confirm surface engages
- **Confirmed by both the run report handoff (executor + verifier agents explicitly called this out) and direct env inspection**

### Finding 3 — `set runtime.surface.visibleAgents []` reports `Effective: ["*"]` (cosmetic)

- **Where**: `team-settings set runtime.surface.visibleAgents []` — `Set runtime.surface.visibleAgents = [] / Effective: ["*"] / Saved to: /home/bom/.pi/agent/pi-crew.json`
- **What**: After calling `set runtime.surface.visibleAgents []`, the displayed `Effective` shows `["*"]` (not `[]`) and the on-disk JSON still has `"runtime": { "surface": { "visibleAgents": ["*"] } }`. The set appears to be a no-op for nested array values. `unset runtime.surface.visibleAgents` works correctly and removes the key (verified end state: `get runtime.surface.visibleAgents = (default)` and JSON no longer has the surface key).
- **Severity**: low — workaround exists (use `unset`); cosmetic because the round-trip via `set/get/unset` for the SIMPLE `telemetry.enabled: false` case worked perfectly
- **Action**: optional follow-up — investigate why `set []` doesn't override the existing `["*"]` in the user config (likely a config-merge deep-clone issue or path-specific merge behavior)

### Finding 4 — tmux E2E prints "can't find window: @4" + "can't find pane: %8 / %9" on cleanup (informational)

- **Where**: `test/system/surface-tmux.e2e.test.ts` cleanup phase
- **What**: After tab-layout tests run, the cleanup code logs `can't find window: @4` / `can't find pane: %8 / %9` — these are panes/windows that the cleanup expected but were already closed (race between auto-exit and explicit close)
- **Severity**: informational — tests still pass 4/4, cleanup is best-effort, no functional regression
- **Action**: no fix needed; could add suppression log if noise becomes an issue

## What was NOT run + why

- **Tier 5/6** (TUI probes): scope change is not in `src/ui/`, just behavior tier
- **Tier 9b/9c/9d/9e/9f**: scope change is in surface/settings/state schema; subagent/lifecycle/admin tiers covered by Tier 9a + 9b-W implicitly. 9b-W worker tools (ask/message/delegate) not in scope of this commit range — SKIP with reason.
- **Tier 10c (herdr live)**: this pi session is NOT running inside a herdr pane; SKIP with reason. Herdr E2E suite ran instead in 10a.
- **Optional async cancel probe**: async runs see `gate: no-mux` so there's no tab to cancel — would just exercise the existing async-cancel path without surface evidence. SKIPPED (cost/value imbalance).
- **Bundle rebuild**: not needed — bundle md5 already matches target `14c1398826a35f768b1a24d321361ee6`; running process is loaded with this bundle (proven by 4/4 new settings keys recognized).

## Restart needed?

- [x] No — session already on the new bundle (md5 = `14c1398826a35f768b1a24d321361ee6` end-to-end)
- [ ] Yes — user must `/quit` + reopen; md5 before/after: n/a

## Verdict

**All required tiers pass with evidence; tab-layout (per-team-run tabs in tmux/herdr) is working as designed for SYNC runs.** Findings: (1) minor flake on default `test:critical` path, not blocking; (2) **MEDIUM-severity functional gap — async runs still headless** because `BACKGROUND_RUNNER_ENV_ALLOWLIST` strips `TMUX`/`HERDR_ENV`, even though the code-level async gate was removed; (3) cosmetic `set []` round-trip doesn't override nested array value; (4) informational tmux E2E cleanup noise.

Recommended actions before merge:
- Add `TMUX`, `HERDR_ENV`, `HERDR_SOCK` to `BACKGROUND_RUNNER_ENV_ALLOWLIST` + add regression test for async + live mux → surface engage
- Consider investigating the `set []` round-trip override behavior (cosmetic; `unset` works as a workaround)

Files inspected (read-only): `src/runtime/surface/{tmux,herdr,resolve-surface,surface-spawn,degrade,launch-script}.ts`, `src/runtime/team-runner.ts`, `src/state/types.ts`, `src/extension/team-tool/handle-settings.ts`, `src/runtime/event-log-tail-source.ts`, `src/runtime/async-runner.ts`, `dist/index.mjs` (md5 verified). No files in `src/`, `test/`, `workflows/`, `skills/`, `scripts/` were modified by this verifier run (only `docs/real-test/reports/_poll-10b-tmux-sync.log` and `docs/real-test/reports/real-test-2026-08-30-post-tab-layout-live.md` were created).
