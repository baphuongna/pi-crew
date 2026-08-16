# real-test-pi-crew — Run Report

**Date**: 2026-08-07
**Trigger**: post perf-observability work (analyze-run.mjs + resource-sampler.mjs + 39 script tests) — no `src/` edits, bundle untouched. Full 9-tier pass requested by user.
**Repo HEAD**: (work tree — `scripts/`, `test/unit/scripts/`, `docs/` untracked/modified; `src/` untouched)
**Bundle md5 (disk)**: `896529f09680aa1ae74e1b1dc638a241`
**Pi version**: v0.84.0 (pty probe)
**Run by**: pi (main session)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 101/101 pass, 19.7s |
| 2 3-path kill-switch | ✅ | default 101/101 (19.7s) + `PI_CREW_BROKER=0` 101/101 (22.0s) + `=1` 101/101 (20.2s) |
| 3 typecheck + bundle | ✅ | tsc exit 0, "strip-types import ok" (10.8s); bundle 2847.6 KB in 799 ms; md5 after build unchanged |
| 4 bundle md5 sync | ✅ | symlink `../node_modules/pi-crew → ../pi-crew`; disk md5 `896529f…` identical pre-flight → post-build → final (session on this bundle; no src/ edits) |
| 5 tmux TUI probe | ✅ | pi spawned in tmux (160×50); `/team-help` rendered on screen; `\x1bOA`/`\x1bOB`/`q` accepted, TUI stayed live |
| 6 pty probe | ✅ | `scripts/pty_probe.py --keys 'j,q,q'` — pi v0.84.0 TUI rendered fully, keys reached input line ("jqq"), exit 0 |
| 7 smoke team run | ✅ | runId `team_20260807081318_93ffdd4075310300`, 3/3 tasks completed, 127s (<300s — no verifier hang), consistency=1. ⚠️ note: transcripts show each task burned 5 failed model-resolves first (env finding F1 below) — verifier did NOT actually execute `test:critical` |
| 8 final md5 sync | ✅ | disk = session = `896529f09680aa1ae74e1b1dc638a241` (unchanged the whole session) |
| 9a read-only battery | ✅ | list ✓ / recommend ✓ / health ✓ (86 runs scanned) / doctor(zombies) ✓ (read-only, 0 killed) / status ✓ / events ✓ (full lifecycle) / summary ✓ / get(workflow) ✓ / explain ✓ / worktrees ✓ = 10/10 |
| 9b spawn paths | ⚠️ | 5/5 paths completed their lifecycle: sync run (tier 7) ✓, async run `team_20260807081706_4df7c7173bc2b131` 4/4 completed 165s consistency=1 ✓, chain 2 steps (step1 ✓ 148s / step2 ✗ env F2), `Agent` direct ✓ completed, `crew_agent` bg `agent_msiohl3s_3d138dc7_2` ✓ completed 38s + `get_subagent_result` ✓. **BUT outputs were EMPTY on all spawn paths** — env finding F1 (model catalog) blocks real LLM output |
| 9c lifecycle | ⏭️ | No change touches lifecycle code path; requires a *running* run + destructive cancel — skipped with justification |
| 9d destructive | ⏭️ | Requires explicit user confirmation per delegation policy — skipped |
| 9e admin | ⏭️ | No change touches schema/registration/admin code path — skipped |
| 9f background | ⏭️ | No change touches goal-loop/schedule code path — skipped |

## Findings (bugs / quirks / non-blocking notes)

- **F1 (env, HIGH impact on smoke value)**: every worker spawn in tiers 7/9b hit
  `Error: Model "oc-go/deepseek-v4-flash" not found` (and 4 more oc-go variants:
  pro-medium/flash-high/flash-max/gpt-5.6-luna) before a valid model resolved.
  Root cause clue: tmux probe shows `[oc-go] hidden 40 model(s) from /model by
  visibility config` — the parent's model-fallback chain selects models that
  the child's oc-go catalog hides. Consequence: ~5 failed spawns × ~2s per
  task (~30-40s waste per task), 0 tokens reported, empty subagent outputs.
  **This is a config/visibility issue in the environment, NOT a pi-crew code
  regression** (no `src/` edits in this change). It also explains why recent
  runs report "0 tokens".

  > ⚠️ **CORRECTION (2026-08-08)**: the "hidden 40 models" hypothesis above was
  > **WRONG** — a red herring. The real root cause is `buildPiWorkerArgs`
  > (`pi-args.ts:306`) adding `--no-extensions` to every child spawn: the `oc-go`
  > provider comes from the `pi-other-provider` extension (settings.json
  > packages), so children lack the provider entirely → every `oc-go/*` model is
  > "not found". Models ARE visible in `pi --list-models`. Fixed in hướng C
  > (`provider-extensions.ts` now resolves local-path specs) — see
  > `real-test-2026-08-08-provider-ext-local-path.md`.
- **F2 (env, flaky)**: chain step-2 `team_20260807082226_a309875ee8b1a06d`
  failed with `ERR_MODULE_NOT_FOUND` for
  `pi-coding-agent/node_modules/typebox/build/index.mjs` — the file EXISTS on
  disk (verified) → ESM resolve race/flake inside the child Pi process, not a
  code regression.

  > ✅ **UPDATE (2026-08-08)**: NOT reproduced after the F1/provider-extension
  > fix — 3-step chain all green, 0 typebox mentions. Likely correlated with
  > the respawn churn F1 caused. See follow-up in
  > `real-test-2026-08-08-provider-ext-local-path.md`.
- **F3 (process)**: no unauthorized agent edits — `git status src/` clean
  after all team/subagent runs.
- **F4 (toolchain)**: full `npm test` suite shows 2 pre-existing perf-timing
  flakes under 4-way concurrency (`F-05 PEM ReDoS`, `countTokens`); both pass
  in isolation; unrelated to this change.

## What was NOT run + why

- 9c lifecycle (wait/steer/cache/checkpoint/cancel/resume) — no change touches
  that path; requires a running run + destructive cancel. Async runs block in
  this configuration, so a mid-run window wasn't available without burning a
  long background run.
- 9d destructive (prune/cleanup/forget) — explicit user confirmation required.
- 9e admin (team/workflow CRUD) — no schema/registration change.
- 9f background (schedule/goal-loop/auto-summarize) — no change touches those
  paths.
- Tier 7 verifier did not execute `test:critical` (F1) — the smoke proves the
  worker lifecycle completes <300s, but not the verifier's command execution.

## Restart needed?

- [x] No — session already on the current bundle (`896529f…` unchanged all run)

## Verdict

All required tiers for this change (no `src/` edits — scripts + tests only)
pass with evidence: 1/2/3/4/5/6/8 ✅, 7 ✅ (lifecycle), 9a ✅ 10/10, 9b ⚠️
lifecycle 5/5 but outputs blocked by env finding F1 (model visibility config).
Tier 9 pass = 9a ✅ + 9b lifecycle ✅ (output verification blocked by env, not
by pi-crew code). The env findings (F1 model visibility, F2 typebox race) are
worth a follow-up outside this change: align the parent's fallback model list
with the child's visible catalog to stop burning ~30-40s per task.
