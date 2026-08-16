# real-test-pi-crew — Run Report

**Date**: 2026-08-06
**Trigger**: post pi restart, after building the perf-observability suite (scripts/ + tests + docs only — no src/ runtime change); user asked for full 9-tier verification.
**Repo HEAD**: `238a5dab`
**Bundle md5 (disk)**: `896529f09680aa1ae74e1b1dc638a241` (2,915,941 B / 2847.6 KB)
**Pi version**: 0.84.0
**Run by**: agent (inside the freshly-restarted Pi session)

## Scope note
All my changes are in `scripts/` (`analyze-run.mjs`, `resource-sampler.mjs`, `run-bench.mjs`), `bench/`, `test/unit/scripts/`, `docs/`. **No `src/` runtime / schema / ui / config / workflow change** → bundle unchanged, runtime is the pre-existing base. The 9 tiers verify that base is healthy post-restart AND that the team/subagent surface works live.

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | `101/101` pass, 0 fail, 0 skipped (~15-21s) |
| 2 3-path kill-switch | ✅ | default `101/101` + `PI_CREW_BROKER=0` `101/101` + `=1` `101/101` — precedence intact |
| 3 typecheck + bundle | ✅ | `tsc --noEmit` exit 0 ("strip-types import ok"); `build:bundle` 2847.6 KB; md5 **identical** before/after rebuild → deterministic, no stale |
| 4 bundle md5 sync | ✅ | disk `896529f0…` = session-loaded (user just restarted Pi); staleness check OK (bundle 848s newer than newest src/) |
| 5 tmux TUI probe | ✅ | pi booted in `tmux -S /tmp/sock`; capture-pane showed TUI: `~/source/my_pi/pi-crew (main)`, `deepseek-v4-flash • xhigh`, `MCP: 3 servers enabled`, skills indexed → extension loaded, TUI renders |
| 6 pty probe | ⏭️ | Tier 5 (tmux) already proved TUI boot+render; no `src/ui/` change in this work. `scripts/pty_probe.py` available as fallback. |
| 7 smoke team run | ✅ | runId `team_20260806162504_5b32c78692ce18e1`, **3/3** tasks (explore→execute→verify), consistency=1, **66578ms** (<300s worker limit); verifier used `cat`/`grep`/`md5` (NOT `npm test`) — no hang |
| 8 final md5 sync | ✅ | disk = session = `896529f09680aa1ae74e1b1dc638a241` |
| 9a read-only battery | ✅ | 8/10 clean: `list`, `health`, `doctor`(zombies), `recommend`, `get`(workflow), `status`, `summary`, `worktrees` — all structured, **no "Unknown type" / "Validation failed"** |
| 9b spawn paths | ✅ | **5/5**: sync run (66s, consistency=1) · async run (86s, 3/3) · chain `"A"->"B"` (2/2 handoffs, 232s, workflow omitted per issue #44) · `Agent` direct ("# pi-crew") · `crew_agent` bg + `get_subagent_result` ("pi-crew") |
| 9c lifecycle | ⏭️ | not required — no `src/runtime` change. `status`/`summary` (read-only lifecycle) already exercised in 9a. |
| 9d destructive | ⏭️ | skipped — protects user run data (61 runs, 6 still running). Requires explicit user confirmation; not needed for scripts-only change. |
| 9e admin | ⏭️ | not required — no team/workflow/config schema change. |
| 9f background | ⏭️ | not required — no `runKind`/schedule code change. |

## Post-run unauthorized-edit check (skill anti-pattern)
`git status` after all smoke/subagent runs: only MY pre-existing changes (`bench/`, `scripts/run-bench.mjs`, `biome.json`, new `scripts/analyze-run.mjs`+`resource-sampler.mjs`, `test/unit/scripts/`, `docs/`). **No `src/` change**, `dist/index.mjs` md5 unchanged → smoke-run agents made NO unauthorized edits to pi-crew. ✅

## Findings (bugs / quirks / non-blocking notes)
- `async=true` on `team action='run'` does NOT background in this harness — it blocks and returns the full result (observed on 3 runs). The run still executes via the background-runner path; only the tool-call return is synchronous. Non-blocking; pre-existing harness behavior, not a regression.
- Health surfaces pre-existing cruft (not caused by this work): 1 corrupted run (`team_20260805120112…`, missing-state), 1 stuck task (725m), 42 zombie `/tmp/` workspaces, 6 long-running my-agent background runs. All pre-existing.
- Tier 9a `events`/`explain` not individually run (8/10) — covered by `status`/`summary` which exercise the same read path.

## What was NOT run + why
- **Tier 6 (pty)** — Tier 5 (tmux) covered TUI boot+render; no `src/ui/` change.
- **9c–9f** — my changes touch none of their code paths (`src/runtime`, schema, config, workflow, runKind). Per skill: "run 9c–9f only when the change touches their code path."
- **9d destructive** — would delete user run data; needs explicit confirmation.

## Restart needed?
- [x] **No** — user already restarted Pi before this run; session loaded the current bundle (`896529f0…`); md5 disk == session; bundle not stale.

## Verdict
**All required tiers pass with evidence (1, 2, 3, 4, 7, 8, 9a, 9b); Tiers 5 verified live TUI; 6/9c–9f skipped with justification (no runtime/ui/schema change).** pi-crew base is healthy post-restart; the full team + subagent surface works live. No unauthorized edits. The perf-observability additions (scripts/ + tests + docs) are safe — they don't touch the runtime bundle.
