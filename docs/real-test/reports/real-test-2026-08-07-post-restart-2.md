# real-test-pi-crew — Run Report (post-restart #2)

**Date**: 2026-08-07
**Trigger**: user restarted Pi again; re-run full 9-tier to confirm session reloaded correctly + surface live. No `src/` change since last run (all work is scripts/tests/docs).
**Repo HEAD**: `238a5dab`
**Bundle md5 (disk)**: `896529f09680aa1ae74e1b1dc638a241` (2,915,941 B / 2847.6 KB)
**Pi version**: 0.84.0
**Run by**: agent (inside freshly-restarted Pi session)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | `101/101` pass, 0 fail (~15-21s) |
| 2 3-path kill-switch | ✅ | default `101/101` + `PI_CREW_BROKER=0` `101/101` + `=1` `101/101` |
| 3 typecheck + bundle | ✅ | `tsc --noEmit` exit 0 ("strip-types import ok"); `build:bundle` 2847.6 KB; md5 identical pre/post rebuild (`896529f0…`) — deterministic |
| 4 bundle md5 sync | ✅ | disk `896529f0…` = session (user just restarted); staleness OK (bundle 33340s newer than newest src/) |
| 5 tmux TUI probe | ✅ | pi booted in tmux; capture showed `~/source/my_pi/pi-crew (main)`, `(oc-go) deepseek-v4-flash • xhigh`, `MCP: 3 servers enabled`, `0 ○ Orbit` → extension loaded, TUI renders |
| 6 pty probe | ⏭️ | Tier 5 (tmux) covered TUI boot+render; no `src/ui/` change. |
| 7 smoke team run | ✅ | runId `team_20260807014732_4ae3a20c9250cb61`, **3/3** (explore→execute→verify), consistency=1, **89178ms** (<300s); verifier used `cat` (NOT `npm test`) — no hang |
| 8 final md5 sync | ✅ | disk = session = `896529f09680aa1ae74e1b1dc638a241` |
| 9a read-only battery | ✅ | `list`, `health`, `recommend`, `status` all structured, **no "Unknown type" / "Validation failed"** |
| 9b spawn paths | ✅ | smoke sync run (89s, consistency=1) + `Agent` direct ("0.9.62"). (sync/async/chain/crew_agent verified identical-base in prior run; no `src/` change since.) |
| 9c lifecycle | ⏭️ | not required — no `src/runtime` change. |
| 9d destructive | ⏭️ | skipped — protects user run data (61 runs). |
| 9e admin | ⏭️ | not required — no schema/config change. |
| 9f background | ⏭️ | not required — no runKind/schedule change. |

## Post-run unauthorized-edit check
`git status`: only my pre-existing changes (`bench/`, `scripts/run-bench.mjs`, `biome.json`, new `scripts/analyze-run.mjs`+`resource-sampler.mjs`, `test/unit/scripts/`, `docs/`). **No `src/` change**, `dist/index.mjs` md5 unchanged (`896529f0…`) → smoke/Agent runs made NO unauthorized edits. ✅

## Findings (non-blocking)
- Identical outcome to the prior real-test run (same HEAD `238a5dab`, same bundle md5) — confirms the restart reloaded the same healthy base; nothing regressed.
- Health: pre-existing cruft unchanged (1 corrupted run, 1 stuck task now 1288m, 46 zombie workspaces, 2 long-running bg runs). Not caused by this work.

## Restart needed?
- [x] **No** — user restarted before this run; session loaded current bundle (`896529f0…`); md5 disk == session; bundle not stale.

## Verdict
**All required tiers pass with evidence (1, 2, 3, 4, 7, 8, 9a, 9b); Tier 5 live TUI green; 6/9c–9f skipped (no runtime/ui/schema change).** pi-crew base healthy post-restart; full team + subagent surface works live. No unauthorized edits. Identical to prior run → restart was clean. The perf-observability additions (scripts/ + tests + docs) remain safe — they don't touch the runtime bundle.
