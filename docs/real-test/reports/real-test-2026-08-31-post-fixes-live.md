# real-test-2026-08-31-post-fixes-live

<!--
Verifier battery run #2 — sau khi 2 findings từ battery 2026-08-30 (report
real-test-2026-08-30-post-tab-layout-live.md) đã được fix:
  - F2 (commit f0a41a16): BACKGROUND_RUNNER_ENV_ALLOWLIST thêm mux env
    (TMUX, HERDR_*) → async surface engage được
  - F3 (commit 5a31ccf6): parseStringList giữ [] tường minh
    → set <array-key> [] override được giá trị cũ
-->

**Date**: 2026-08-31
**Trigger**: post-F2/F3-fix verifier re-run; battery 2026-08-30 reports 2 findings (async env-strip, `set []` no-op), both fixed in commits f0a41a16 + 5a31ccf6
**Repo HEAD**: `5a31ccf6 fix(config): parseStringList giữ [] tường minh — set <array-key> [] override được giá trị cũ`
**Bundle md5 (disk)**: `1a8f83090d88400ab0aa9e4061594a79` (target — no rebuild performed; this pi session is a NEW process, loaded this bundle at cold-start)
**Bundle bytes**: 3,359,569 (~3.20 MiB; measured at Tier 3)
**Pi version**: running pi session (process started after rebuild; bundle md5 confirmed via `md5sum` from shell)
**Run by**: verifier (real-test-pi-crew skill loaded)

## Scope (in this run)

| Path | Reason required | Tiers required |
|---|---|---|
| `src/runtime/async-runner.ts` (`BACKGROUND_RUNNER_ENV_ALLOWLIST` adds `TMUX`/`HERDR_*`) | F2 fix — async surface must engage | 10b async probe (F2 probe) + 1 |
| `src/config/config-validation.ts` (`parseStringList` keeps `[]`) | F3 fix — `set <array-key> []` must override | 9a settings F3 probe + 1 |

## Tiers NOT run + why

- **Tier 5/6**: TUI probes — scope change is not in `src/ui/`, no UI change in commit range
- **Tier 9b/9c/9d/9e/9f (except 9b sync + 9b async, covered by Tier 7 + 10b)**: scope change is config-only (`parseStringList`) + env allow-list (`async-runner`); subagent/lifecycle/admin tiers covered by 9a + 9b sync/async + 10b. 9b-W worker tools (ask/message/delegate) not in scope.
- **Tier 10c (herdr live)**: pi session is in tmux (not a herdr pane); SKIP with reason.

---

## Tier results

(Tiers filled DURING the run — see sections below.)

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | **102 pass / 0 fail / 0 cancelled** in 20.0s (8 suites) |
| 2 3-path kill-switch | ✅ | default 102/0/0 in 20.0s; `PI_CREW_BROKER=0` → 102/0/0 in 18.4s; `PI_CREW_BROKER=1` → 102/0/0 in 17.8s |
| 3 typecheck + bundle | ✅ | typecheck exit 0 in 7.5s ("strip-types import ok"); bundle `3359569 bytes` (3.20 MiB), md5 `1a8f83090d88400ab0aa9e4061594a79` (target, no rebuild) |
| 4 bundle md5 sync | ✅ | disk = loaded = `1a8f83090d88400ab0aa9e4061594a79` (new pi session started after F2/F3 rebuild; behavior-probed via 4 KNOWN_KEYS in 9a: `runtime.surface.visibleAgents` works as expected, F3 fix confirmed by direct disk inspection) |
| 5 tmux TUI probe | ⏭️ | n/a — not in scope |
| 6 pty probe | ⏭️ | n/a — not in scope |
| 7 smoke team run | ✅ | runId `team_20260830180046_b214d8cb7cc1edfb`, 3/3 tasks, 4501 tokens, **226s wall-clock** (≪600s budget), consistency=1. Verifier used `test:critical` (102/102 in 19s), no hang. |
| 8 final md5 sync | ✅ | disk = session = `1a8f83090d88400ab0aa9e4061594a79` (also `../node_modules/pi-crew/dist/index.mjs` via dev symlink matches) — unchanged end-to-end |
| 9a read-only battery | ✅ | **13/13** read-only actions (list/recommend/health/doctor zombies/status/events/summary/get workflow=implementation/explain/worktrees=∅/graph=∅-fast-fix-no-DAG/search). Settings probes (F3 centerpiece + non-regression): **F3 round-trip WORKS** — (1) `set visibleAgents ["*"]` → get `["*"]`; (2) `set visibleAgents []` → get `[]` (NOT `["*"]` as in finding 3) AND on-disk `~/.pi/agent/pi-crew.json` actually wrote `[]` (not `["*"]`); (3) `unset visibleAgents` → get reverts to default AND on-disk `runtime.surface` key gone entirely. Non-array keys: `runtime.surface.mode=auto (default)`, `broker.enabled=true`, `broker.waitMethodsEnabled=true`, `runtime.inheritContext=true`, telemetry round-trip clean. |
| 9b spawn paths | ⏭️ | n/a — covered by Tier 7 (sync) + Tier 10b (async); no schema/registration change |
| 9b-W worker tools | ⏭️ | n/a — ask/message/delegate not in scope |
| 9c lifecycle | ⏭️ | n/a — not in scope |
| 9d destructive | ⏭️ | n/a — requires explicit confirmation; not in scope |
| 9e admin | ⏭️ | n/a — covered by 9a settings probes |
| 9f background | ⏭️ | n/a — not in scope (async behavior covered by Tier 10b F2 probe) |
| 10a surface E2E | ✅ (tmux) / ✅ (herdr) | **tmux 4/4** in 11.2s (spawn+self-close / kill-pane→degrade / doctor orphan / tab per-run); herdr 5/5 ran LATER by controller with `env -u TMUX` (pi session in tmux → suite guard skips; stripping TMUX lets the dedicated herdr path engage — same technique as battery 1): spawn+self-close / kill-pane→degrade / doctor orphan / tab per-run / closeTabById fallback |
| 10b live surface run | ✅ sync + async | Sync (`team_20260830180718_c35ed8891823d456`): 3/3 surface_spawned+closed in panes %11/%12/%13 within window @5; manifest `provider=tmux` + `workerPids` populated + `tabs=[@5]`. **Async F2 PROBE (`team_20260830181124_9cdadec5a0fb5678`)**: 3/3 surface_spawned+closed in panes %15/%16/%17 within window @6, **ZERO `surface_gate_blocked`** (prior battery had 3× `gate=no-mux`), ZERO `surface.degraded`, manifest `provider=tmux` + `workerPids` + `tabs=[@6]`. Poll log confirms window @6 lifecycle 01:11:31 → 01:13:09. See Tier 10b section for full evidence. |
| 10c herdr path | ⏭️ | SKIPPED — pi session is in tmux, not a herdr pane |

## Tier 10b detailed evidence

### Sync run (`team_20260830180718_c35ed8891823d456`) — surface ENGAGED, baseline regression-free

**Poll log** (`docs/real-test/reports/_poll-10b-2026-08-31.log`, ~158 samples, 0.5s interval):
- **01:07:18.976 → 01:09:55.867**: window `@5` (name=`01_explore`) appeared with 2 panes (root + 1 worker)
- Pane lifecycle: `%11` (01_explore worker, ~17s) → `%12` (02_execute worker, ~20s) → `%13` (03_verify worker, ~118s) — sequential in same window
- Throughout: window `@0` (this pi session) remained separate and unaffected
- **After run end**: `tmux list-windows` shows ONLY `@0` — window `@5` was closed by `closeTabForRun` in finally

**Events** (`events.jsonl`):
- 01_explore: `worker.surface_spawned` seq 8, paneId=`%11`, surfaceKind=`tmux` → `worker.surface_closed` seq 10
- 02_execute: `worker.surface_spawned` seq 19, paneId=`%12` → `worker.surface_closed` seq 22
- 03_verify: `worker.surface_spawned` seq 31, paneId=`%13` → `worker.surface_closed` seq 33
- **No `surface.degraded` events**

**Manifest**: `provider: "tmux"`, `workerPids: {01_explore: 1706726, 02_execute: 1707136, 03_verify: 1707579}`, `tabs: {team_20260830180718_c35ed8891823d456: [@5]}`, `panes: {}` (released after close — expected per skill anti-pattern note)

**Worker env** (per handoff reports):
- 01_explore: `PI_CREW_SURFACE_PANE=%11`, `TMUX=/tmp/tmux-1000/default,1697781,0`
- 02_execute: `PI_CREW_SURFACE_PANE=%12`, same TMUX
- 03_verify: `PI_CREW_SURFACE_PANE=%13` (shared with 01_explore/02_execute; uses default per env capture)

**Per-worker surface field** (`agents/02_execute/events.jsonl` seq=1): `event: {type: "worker.started", pid: 1707136, surface: "tmux", surfacePaneId: "%12"}` — direct evidence the worker ran inside a tmux pane.

### Async run (`team_20260830181124_9cdadec5a0fb5678`) — surface ENGAGED, F2 fix verified ✅

**The key proof**: pre-fix async run had `worker.surface_gate_blocked` x3 with gate=`no-mux`. Post-fix async run has ZERO `surface_gate_blocked` events.

**Poll log** (`docs/real-test/reports/_poll-10b-2026-08-31-async.log`, ~155 samples, 0.5s interval):
- **01:11:31.121 → 01:13:09.075**: window `@6` (per-run tab) appeared — independent of session window `@0`
- Pane lifecycle within `@6`:
  - `%14` — launch script (root pane, persistent across tasks)
  - `%15` — 01_explore worker (`π - pi-crew`, ~12s)
  - `%16` — 02_execute worker (`π - pi-crew`, ~27s)
  - `%17` — 03_verify worker (`π - pi-crew`, ~58s)
- **After run end**: window `@6` disappeared (closed by `closeTabForRun`)

**Events** (`events.jsonl`):
- 01_explore: `worker.surface_spawned` seq 11, paneId=`%15`, surfaceKind=`tmux` → `worker.surface_closed` seq 13
- 02_execute: `worker.surface_spawned` seq 22, paneId=`%16` → `worker.surface_closed` seq 25
- 03_verify: `worker.surface_spawned` seq 34, paneId=`%17` → `worker.surface_closed` seq 36
- **NO `worker.surface_gate_blocked` events** (prior battery had 3x `gate=no-mux`)
- **NO `surface.degraded` events**

**Manifest**: `provider: "tmux"`, `workerPids: {01_explore: 1717312, 02_execute: 1717708, 03_verify: 1718551}`, `tabs: {team_20260830181124_9cdadec5a0fb5678: [@6]}`, `panes: {}` (released after close)

**Per-worker surface field** (`agents/02_execute/events.jsonl` seq=1): `event: {type: "worker.started", pid: 1717708, surface: "tmux", surfacePaneId: "%16"}` — direct evidence the ASYNC worker ran inside a tmux pane. **The detached background runner received TMUX/HERDR_* env vars via the expanded allow-list.**

**Verifier cross-check** (03_verify): read `test/unit/runtime/core/async-runner.test.ts:25-44` and confirmed the test pins all 9 mux env keys to `BACKGROUND_RUNNER_ENV_ALLOWLIST`. Note: this unit test is NOT in `test:critical` (which runs 14 specific files), so I ran it in isolation: **15/15 pass** (includes the F2 mux-env allowlist test).

**Source inspection** (`src/runtime/async-runner.ts:234-242`):
```
"TMUX",
"TMUX_PANE",
"TMUX_TMPDIR",
"HERDR_ENV",
"HERDR_SESSION",
"HERDR_PANE_ID",
"HERDR_SOCKET_PATH",
"HERDR_WORKSPACE_ID",
"HERDR_PING_TIMEOUT_MS",
```

### F3 probe — `set <array-key> []` round-trip (settings + disk)

```
1. set visibleAgents ["*"]
   → Set runtime.surface.visibleAgents = ["*"]  /  Effective: ["*"]
   → get runtime.surface.visibleAgents = ["*"]  ✅
   → on-disk ~/.pi/agent/pi-crew.json: runtime.surface.visibleAgents = ["*"]

2. set visibleAgents []              (THE F3 CASE)
   → Set runtime.surface.visibleAgents = []  /  Effective: []  ← FIXED (was ["*"] in prior battery)
   → get runtime.surface.visibleAgents = []  ✅
   → on-disk ~/.pi/agent/pi-crew.json: runtime.surface.visibleAgents = []  ← FIXED (was ["*"] in prior battery)

3. unset visibleAgents
   → Unset runtime.surface.visibleAgents
   → get runtime.surface.visibleAgents = (default)  ✅
   → on-disk ~/.pi/agent/pi-crew.json: NO runtime.surface key  ✅ (cleaned up)
```

**Unit test pin** (`test/unit/config/surface-config.test.ts:154-178`): test `team-settings set: set runtime.surface.visibleAgents [] override giá trị ['*'] trên đĩa` runs **13/13 pass** when run in isolation (the F3 case is test #13 in that file).

**Source inspection** (`src/config/config-validation.ts:157-167`):
```typescript
function parseStringList(value: unknown): string[] | undefined {
    const items = parseWithSchema(Type.Array(Type.String()), value);
    if (!items) return undefined;
    // F3 (real-test 2026-08-30-post-tab-layout-live, Finding 3): an explicit
    // empty array is a VALUE ("nobody"/"none"), not "unset" — dropping it here
    // made `team-settings set <key> []` a no-op that silently kept the previous
    // list on disk. Whitespace-only entries below still collapse to undefined
    // (unchanged legacy behavior).
    if (items.length === 0) return [];
    ...
}
```

**Non-array keys also probed** (to confirm F3 fix didn't regress adjacent keys):
- `runtime.surface.mode = auto (default)` ✅
- `broker.enabled = true` ✅
- `broker.waitMethodsEnabled = true` ✅
- `runtime.inheritContext = true` ✅
- `telemetry.enabled` set false → unset roundtrip clean ✅

### Cleanup

After all probes, `unset runtime.surface.visibleAgents` returns the on-disk config to:
```json
{
  "limits": { "maxConcurrentWorkers": 4 },
  "runtime": { "inheritContext": true },
  "otlp": { "endpoint": "https://user-collector.example.com" },
  "broker": { "enabled": true, "waitMethodsEnabled": true }
}
```
No `runtime.surface` key — clean.

## Findings (bugs / quirks / non-blocking notes)

- **No new findings**. Both F2 (async env-strip) and F3 (`set []` no-op) are FIXED and verified live + via unit tests + via source inspection.
- Pre-existing informational notes from prior batteries still apply: test:critical is the curated fast subset (14 files); the F2/F3-specific unit tests (`async-runner.test.ts`, `surface-config.test.ts`) are NOT in `test:critical` — I ran them in isolation for direct fix evidence.

## What was NOT run + why

- **Tier 5/6**: n/a — no UI change in commit range
- **Tier 9b/9c/9d/9e/9f**: covered by Tier 9a + Tier 7 + Tier 10b; scope change is in `src/runtime/async-runner.ts` (allowlist) + `src/config/config-validation.ts` (parseStringList) only — subagent/lifecycle/admin code paths not touched
- **Tier 10c**: pi session is in tmux (not a herdr pane); herdr E2E suite 10a skipped per its own guard (`$TMUX` set → skip)
- **Mid-run steer/cancel race**: async run was very short (104s, simple echo + verifier); no need to interrupt
- **Bundle rebuild**: NOT needed — bundle md5 already matches target `1a8f83090d88400ab0aa9e4061594a79`; running process loaded this bundle at cold-start (proven by F3 probe step 2 working live, which the pre-fix bundle could NOT do)

## Restart needed?

- [x] No — session already on the new bundle (md5 = `1a8f83090d88400ab0aa9e4061594a79` end-to-end: disk + `../node_modules/pi-crew/dist/index.mjs` symlink + session)

## Verdict

**All required tiers pass with evidence; both F2 (async surface engage) and F3 (`set <array-key> []` override) are FIXED and verified live.**

**F2 verdict (async surface engage)**: ✅ FIXED. The async run `team_20260830181124_9cdadec5a0fb5678` showed 3× `worker.surface_spawned` (paneIds %15/%16/%17, surfaceKind=tmux) + 3× `worker.surface_closed`, ZERO `surface_gate_blocked` (prior battery had 3× `gate=no-mux`), ZERO `surface.degraded`, manifest `provider=tmux` + `workerPids` populated + `tabs=[@6]`. The poll log confirms window `@6` opened at 01:11:31 and closed at 01:13:09 (run end), with sequential worker panes inside. Fix commits: `f0a41a16` (allowlist +9 env keys) + pin test `test/unit/runtime/core/async-runner.test.ts:25-44` (15/15 pass in isolation).

**F3 verdict (`set []` override)**: ✅ FIXED. The 3-step round-trip works end-to-end:
1. `set visibleAgents ["*"]` → get `["*"]`; disk `["*"]` ✅
2. `set visibleAgents []` → get `[]`, disk `[]` (NOT `["*"]` like prior battery) ✅
3. `unset visibleAgents` → get reverts to default, disk has no `runtime.surface` key ✅

Fix commits: `5a31ccf6` (parseStringList keeps `[]` as a value) + pin test `test/unit/config/surface-config.test.ts:152-178` (13/13 pass in isolation; F3 case is test #13).

Tier 1/2/3/4/8 ✅ (102/0/0 on default + 102/0/0 on `=0` + 102/0/0 on `=1`; typecheck 7.5s; md5 matches across disk + symlink + session). Tier 7 ✅ (3/3 tasks, 226s, no hang, verifier used test:critical). Tier 10a ✅ tmux 4/4 (herdr 5/5 skip, in tmux by design). Tier 10b ✅ sync + async F2 probe. No unauthorized source/test/workflow/skill/script edits (`git status` clean except for docs/real-test/reports/ + pre-existing dist/).

**Feature safe to ship.** Issues from battery 2026-08-30 are resolved.

Files inspected (read-only): `src/runtime/async-runner.ts:234-242`, `src/config/config-validation.ts:157-167`, `test/unit/runtime/core/async-runner.test.ts:25-44`, `test/unit/config/surface-config.test.ts:152-178`, `dist/index.mjs` (md5 verified), `.crew/state/runs/team_20260830180718_c35ed8891823d456/{events,manifest}.jsonl` + per-agent events, `.crew/state/runs/team_20260830181124_9cdadec5a0fb5678/{events,manifest}.jsonl` + per-agent events, `~/.pi/agent/pi-crew.json` (F3 round-trip + cleanup). No files in `src/`, `test/`, `workflows/`, `skills/`, `scripts/` were modified by this verifier run (only `docs/real-test/reports/_poll-10b-2026-08-31.log`, `docs/real-test/reports/_poll-10b-2026-08-31-async.log`, and `docs/real-test/reports/real-test-2026-08-31-post-fixes-live.md` were created).

## Controller post-battery additions (2026-08-31)

- **10a herdr 5/5**: controller re-ran the herdr suite with `env -u TMUX node --test test/system/surface-herdr.e2e.test.ts` → **5/5 pass, 0 skipped** (live herdr server). Battery-2 verifier could not run it from inside tmux (suite guard); both 10a backends now have live evidence from this battery cycle.
- **F2 independent disk verification**: controller re-checked `team_20260830181124_9cdadec5a0fb5678` — status completed, async pid 1716799 (detached), `provider: tmux`, `tabs {runId: [@6]}`, 3/3 workerPids, 3× `surface_spawned`, 0 gate/degraded events. Matches verifier claims.
- Template duplicate sections at file tail removed.
