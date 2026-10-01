# real-test-pi-crew — Run Report

**Date**: 2026-10-01
**Trigger**: post-SDD-2 (Phase D bump pi 0.99.1 + W-B G2/G3 + remediation, commits `66f37875`→`ef7a8211`, execution record §13 `pi-crew-sdd-2026-09-30-buoi1.md`) — full-tier run per user request
**Repo HEAD**: `ef7a8211`
**Bundle md5 (disk)**: `f28960e32a860d3c544ab87af43b6462` (1579.2 KB)
**Pi version**: 0.99.1 (host); SDK resolved 0.99.2
**Run by**: parent Pi session (OLD bundle — loaded pre-SDD-2) + cold-start `pi -p` battery sessions (NEW bundle) in scratch cwd `/tmp/rt-sdd2` (marker: `.crew` + git)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 116/116 pass, 0 fail 0 cancelled (env-scrubbed PI_CREW_*/PI_TEAMS_*) |
| 2 3-path kill-switch | ✅ | default 116/116 · `PI_CREW_BROKER=0` 116/116 · `=1` 116/116 |
| 3 typecheck + bundle | ✅ | tsc "strip-types import ok" · bundle 1579.2 KB in 409ms · md5 `f28960e3…` · staleness+ARCH-7 path-leak OK · lazy-imports exit 0 · bundle-size 1.54/3.5MB · test:bundle 2/2 |
| 4 bundle md5 sync | ✅* | cold-start sessions load NEW bundle (proven by 4 live `pi -p` runs below). *This parent session still runs the pre-SDD-2 bundle — restart needed (see below) |
| 5 tmux TUI probe | ✅ | `/team-help` rendered full command list in real TUI (tmux -S /tmp/sock, 160x50); app-cursor-mode `\x1bOA` accepted, screen coherent after key |
| 6 pty probe | ⏭️ | T5 green (T5\|T6 either per skill); no multi-key bulk need for this diff |
| 7 smoke team run | ✅ | cold-start `pi -p` → run `team_20261001154816_c583396174977ecc` fast-fix 3/3 completed, correct answer (8 words / alpha×4), ~2min wall, clean shutdown, no hang (<600s/worker) |
| 8 final md5 sync | ✅* | disk `f28960e3…` = what cold-start sessions loaded. Parent session = OLD (expected; loaded at session start pre-SDD-2) |
| 9a read-only battery | ✅ | 13/13 OK via cold-start `pi -p`: list/recommend/health/doctor-zombies/status/events/summary/get-workflow/explain/worktrees/graph/search/settings — no `Unknown type`, no `Validation failed` |
| 9b spawn paths | ✅ 5/6 + 1 timing | sync ✓ (T7) · async ✓ (`team_20261001155931_e2fd26cab523bdba` 3/3, consistency=1, ~134s, background-runner via jiti-from-source) · chain ✓ (2 sequential runs w/ handoff: `…0312_9365f…`→`…0509_0a513…`, workflow param omitted per gotcha) · Agent direct ✓ (`direct-explorer` READY) · crew_agent bg ✓ (`direct-executor` sleep-45 DONE) · **steer ⚠️ not-proven-live** — orchestrator killed by outer bash timeout before steer landed post-worker-exit; unit-pinned (F-L2 suite) |
| 9b-W worker tools | ⏭️ | ask/message/delegate not exercised this run (no prompt-path change in SDD-2; mcp-permission logic unit-pinned 15/15 + phase6 6/6). Full-loadout note: CLI-path workers retain MCP by design (WI-4 defer) |
| 9c lifecycle | ⏭️ | status/events/summary on completed run covered in 9a; live-mid-run steer/checkpoint not run (runs complete in <3min; steer timing issue above) |
| 9d destructive | ⏭️ | not run — protects user run data; skill: only when change touches their path (SDD-2 does not) |
| 9e admin | ⏭️ | not run — no schema/registration change in SDD-2 (skill's own when-required rule); scratch cwd ready if needed |
| 9f background | ⏭️ | not run — no schedule/goal-loop change in SDD-2 |
| 10a surface E2E | ✅ | tmux 4/4 · herdr 5/5 — 0 skipped, both backends engaged real (spawn+self-close, kill-pane→degrade, doctor orphan) |
| 10b live surface run | ⏭️ | parent session runs OLD bundle — surface-from-parent would test stale code; 10a covers pane lifecycle on new code. Re-run post-restart if needed |
| 10c herdr path | ✅ | herdr E2E ran from a real herdr pane context (HERDR_ENV=1, w2:p9B), 5/5 |
| 11 remediation regression | ✅ 9/10 | 11a stores sync (plan-store 3×, ownership-map 3× atomicWriteJson; crash-recovery :228 comment; buffered census 15 files) · 11b wc-gate exit 0 + in ci AND ci:fast · 11c validator severity "removed" ×2 · 11d slow tier 3 files · 11e nightly=comment only / weekly=2 · 11f reject-format 3 sites · 11g widgetPlacement bottom · 11h twins 3× green (4/4 each) · 11i dead-export 0 + MUST_INCLUDE 5 · **11j ❌ exit 1 — dist/index.mjs(+map+meta) NOT committed** (expected: user-gated decision pending; gate correctly red) |
| 12 resource contracts | ✅ | 12a 1/1 · 12b agents 18 / bad desc 0 / no routing 0 / strict-YAML 18 ok 0 fail · 12c 16 rendered lines, 16 with useWhen (budget-trunc by design; orchestrator ✓) · 12d 39/39 |
| 13 real-run UI render | ✅ | runId `team_…77ecc` (real run); CALL/STREAMING/COLLAPSED/EXPANDED@80/DOCK×4/PLAN CARD/SIDEBAR all render; sweeps: undefined 0 · `->` 0 · wire-format 0 · bad-plural 0; spinner ONLY in running/streaming (✓ on done, ⠸ on running, ✗ on failed); hint `↓·enter` survives @50; duration `2m7s` human; usage `3.4k tok`; shortId 8 chars |

## Findings (bugs / quirks / non-blocking notes)

1. **T11j correctly RED** — `dist/index.mjs` + `dist/index.mjs.map` + `dist/build-meta.json` not in HEAD. Committing dist is user-gated (SDD §12 rule). Until committed, the release gate stays red — by design.
2. **24h+ zombie battery process** (PID 2829040, `timeout 850 pi -p BATTERY TEST … action='breakdown'`, etime >1 day) — leftover from yesterday's battery; its `timeout 850` wrapper apparently never fired. Read-only workload, harmless, but `doctor focus='zombies'` should list it. Recommend user confirm + kill.
3. **Worker argv invisible via ps** — worker processes rewrite their visible cmdline to bare `pi` (observed: `ps -p <workerPid>` → `pi`), so the live G3 argv-leak audit through `ps` is structurally impossible post-boot. G3 assurance = red-first unit tests (33/33: argv has no task text, file 0600) + T7 completion + T5/T10 unaffected. Note for future batteries: don't burn time on ps-based argv audits.
4. **Steer probe timing** — worker (sleep 45) finished at +69s while orchestrator turn latency pushed the steer call past exit; no steer event recorded. Use the F-L2 detached-watcher recipe (skill 9g) next time instead of orchestrator-issued steer.
5. Preflight WARN on fast-fix chain ("5.7× slower, 1.9× costlier than 3 raw Agent calls") fired on both sync runs — informational, proceeding was correct.
6. `pi` 0.99.2 update banner in TUI probe — cosmetic, unrelated.

## What was NOT run + why

- 9b-W ask/message/delegate, 9c live-mid-run ops, 9d/9e/9f mutation batteries — SDD-2 touches none of their code paths (skill's when-required rule); scratch cwd `/tmp/rt-sdd2` retained with 6 runs if a follow-up mutation battery is wanted.
- T6 pty bulk-key probe — T5 green suffices (either-or per skill).
- 10b surface-from-parent — parent session on OLD bundle (would test stale code); 10a E2E both backends green on new code.
- 11a item 4 full `test:unit` (~12min) — mandatory only after delayed-write conversion programs; SDD-2 has none (census unchanged at 15 files).

## Restart needed?

- [ ] No — session already on the new bundle
- [x] **Yes → DONE 2026-10-01 (post-restart)**: user `/quit` + reopened; disk md5 `f28960e3…` unchanged; probe `team action='list'` clean (full teams/workflows/agents/runs, no `Unknown type`) → session confirmed on NEW bundle per T8 recipe. T4/T8 closed.

## Verdict

**PASS with 2 pending user actions** — SDD-2 (Phase D 0.99.1 + G2 + G3 + remediation) is live-proven on the new bundle across T1/T2/T3/T5/T7/T9a/T9b(5/6+timing)/T10a/T12/T13; T11j red until dist is committed (user-gated); parent session restart pending (user). Steer round-trip live-proof deferred to F-L2 recipe follow-up.
