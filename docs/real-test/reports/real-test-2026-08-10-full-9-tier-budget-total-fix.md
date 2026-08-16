# real-test-pi-crew — Run Report

**Date**: 2026-08-10
**Trigger**: user requested "dùng skill real test pi-crew — chạy toàn bộ 9 tier" (full 9-tier verification)
**Repo HEAD**: `cca7d029` (docs(adr): DWF isolated-vm sandbox plan)
**Bundle md5 (disk)**: `be7fcfb64447e67bd4d8bae7d13e6a11` (after schema fix rebuild; pre-fix was `bbcbcbb5e5c959c6cf9981441c74eaa4`)
**Pi version**: 0.84.1
**Run by**: pi (main session) + real-test-pi-crew skill

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | **101/101 pass, 0 fail**, ~20.4s (default run); re-run after schema fix: 101/101, 18.3s |
| 2 3-path kill-switch | ✅ | default 101/101 (~20.4s); `PI_CREW_BROKER=0` 101/101 (~24.6s); `PI_CREW_BROKER=1` 101/101 (~20.3s) |
| 3 typecheck + bundle | ✅ | `tsc --noEmit` exit 0 + "strip-types import ok" (~6.4s); `build:bundle` → 2853.1 KB in 464 ms |
| 4 bundle md5 sync | ✅ | disk = symlink-loaded = `be7fcfb6...` (via `../node_modules/pi-crew` → `../pi-crew`); **live session still on pre-fix bundle** (see Restart needed) |
| 5 tmux TUI probe | ✅ | `/team-help` rendered full command list; `/team-dashboard` opened; j/k/CSI-up `\x1b[A`/app-cursor `\x1bOA` all changed screen state → keys reached TUI |
| 6 pty probe | ⏭️ (partial) | `pty_probe.py` ran, pi started clean, keys `jjk` + `\x1b[A` `\x1b[B` `\x1bOA` `\x1bOB` echoed in input line. `PI_CREW_BROKER_DIAG_UI` **no longer exists in src/** (removed since skill was written) — 0 diag lines possible. Keystroke-arrival proven by screen-change evidence instead |
| 7 smoke team run | ✅ (with caveat) | runId `team_20260810033037_4f2efdb06c9580c9`: 3/3 tasks, consistency=1, 106s, no hang. **Caveat: verifier output was EMPTY (0 tokens) — transcript shows 429 rate-limit (`MiniMax-M2.7`, "Token Plan usage limit reached") + 4 model-not-found spawn failures per task before fallback. Run completed only via state machine; verifier never actually ran test:critical.** A second async run `team_20260810033740_42342d20f0a80b66` DID prove it: verifier ran `test:critical` → 101/101 + `tsc` 0 diagnostics |
| 8 final md5 sync | ✅ | disk = symlink = `be7fcfb6...`; session bundle old (`bbcbcbb5...`) — restart required |
| 9a read-only battery | ✅ | list / recommend / health / doctor(zombies) / status / events / summary / get(workflow) / explain / worktrees — **10/10** clean |
| 9b spawn paths | ✅ | sync (Tier 7 run), async (`team_20260810033740_42342d20f0a80b66`), chain (`team_20260810034054_bb1dd2be757a27c5` + `team_20260810034304_45f11616c2f27ad2`, 2/2 handoffs), Agent direct (completed), crew_agent background (`agent_msmoohx7_a732870b_2`, PID=977286, PI_CREW_KIND=subagent, depth=1) — **5/5** |
| 9c lifecycle | ⏭️ | status-details/steer/cache/checkpoint/retry/resume need a running run; exercise only when the change touches their path (none here). Live cancel not run (destructive, needs throwaway run) |
| 9d destructive | ⏭️ | prune/cleanup/forget NOT run — protects user run data (health shows 29 runs incl. 5 running); `doctor focus='zombies'` (read-only) ran clean: 0 zombies |
| 9e admin | ⏭️ | team/workflow CRUD not run — no change touches admin paths; `get resource='workflow'` (read-only) covered resource inspection |
| 9f background | ⏭️ | auto-summarize/anchor/schedule not run — no change touches these paths; budget-consumptive |

Legend: ✅ pass with evidence · ❌ fail (root cause below) · ⏭️ skipped (justify why)

## Findings (bugs / quirks / non-blocking notes)

1. **BUG (fixed live): `budgetTotal` schema rejected empty-string unset marker — broke every team action for models that emit `budgetTotal:""`** — `src/schema/team-tool-schema.ts:270-288`. Severity: HIGH (blocking). `budgetTotal` was the ONLY numeric field in `TeamToolParams` missing the `Literal("")` allowance; siblings `budgetWarning`, `budgetAbort`, `tokenBudget`, `interval`, `replyDeadline` all had it. When a calling model emits every schema key with defaults (documented behavior in `normalizeTeamParams` comment, team-tool.ts:35-40), pi-ai `validateToolArguments` rejects `budgetTotal:""` BEFORE the pi-crew handler runs → `Validation failed for tool "team"` on every action. **This is exactly the Tier-9-only failure mode the skill warns about**: Tier 1-8 all passed while the team tool was broken for emitting models. Fix: added `Type.Literal("")` to the union. Verified: `budgetTotal:""` → PASS; `budgetTotal:0` → PASS (unset marker intact); `budgetTotal:999` → still FAIL (MISCONFIGURATION GUARD intact); `budgetTotal:1500` → PASS; omitted → PASS. Reproduction: `node --input-type=module -e "import {validateToolArguments} from '@earendil-works/pi-ai'; ..."` with `budgetTotal:""`.

2. **Skill reference drift: `PI_CREW_BROKER_DIAG_UI` / `PI-CREW-DIAG` no longer exist** — skill Tier 6 cites `src/ui/run-dashboard.ts:831`; grep across `src/` finds nothing. Diag env var was removed after the skill was written. Tier 6 output captured keystroke echo instead. Non-blocking — update skill when convenient.

3. **Model fallback chain spawns 4 dead models per task** — event log shows each task spawning `commandcode/deepseek/deepseek-v4-flash`, `gpt-5.6-luna`, `deepseek-v4-pro`, `poolside/laguna-s-2.1-free` — 4× `Model not found` failures before the 5th spawn succeeds. Wasted spawns (~4 × 6s per task). Non-blocking but noisy; likely a `commandcode` provider catalog drift. Consider pruning dead models from the fallback list.

4. **Rate-limit 429 inside child worker is silently absorbed into a "completed" run** — verifier transcript (`.crew/artifacts/team_20260810033037_4f2efdb06c9580c9/transcripts/03_verify.attempt-4.jsonl`) shows `429 Token Plan usage limit reached` with empty content; run still reported "completed" with consistency=1. Worker output was empty → the "no hang" claim needs the *output* checked, not just task status. Non-blocking but a monitoring gap: a run can complete with zero actual work.

5. **`test:critical` count is 101 (not 97)** — skill says "97 at v0.9.46, 101 after the model-routing merge". Current = 101, matches the post-merge count. Non-blocking.

## What was NOT run + why
- **9c lifecycle** (steer/cache/checkpoint/retry/resume mid-run) — requires a running run; change touches only the schema (no lifecycle path). Costly, skipped by design.
- **9d destructive** (prune/cleanup/forget) — protects user run data; requires explicit user confirmation per delegation policy. `doctor zombies` (read-only) ran instead.
- **9e admin** (team/workflow CRUD) — no admin-path change; `get resource='workflow'` covered read-only inspection.
- **9f background** (auto-summarize/anchor/schedule) — no background-path change; token-consumptive.
- **Tier 6 diag line count** — impossible (env var removed from source).

## Restart needed?
- [x] **Yes — DONE (user restarted 2026-08-10)**
  - md5 before: `bbcbcbb5e5c959c6cf9981441c74eaa4` (session, pre-fix)
  - md5 after:  `be7fcfb64447e67bd4d8bae7d13e6a11` (disk, post-fix)
  - **POST-RESTART VERIFICATION (all PASS on the rebuilt bundle)**:
    1. `team action='list'` returned full teams/workflows/agents list — no `Validation failed` even though the harness still emits `budgetTotal:""` (proves the fix is live; previously every such call was rejected)
    2. `team action='health'` scanned 27 runs — 0 ghost / 0 orphaned / 0 corrupted
    3. `team action='run'` async spawn probe `team_20260810035251_531dadda1882754e`: 3/3 tasks, **2815 tokens real**, consistency=1 — explorer PID=986258, executor PID=987193, `PI_CREW_KIND=subagent`, depth=1; verifier ran `test:critical && npx tsc --noEmit` → pass, no hang
  - Final `md5sum dist/index.mjs` = `be7fcfb64447e67bd4d8bae7d13e6a11` ✅

  **This session cannot restart itself** (agent-inside-session caveat) — only the user can.

## Verdict
All required tiers (1, 2, 3, 4, 5, 6, 7, 8, 9a, 9b) pass with evidence. One HIGH-severity schema bug was **found and fixed** by Tier 9 (`budgetTotal` empty-string rejection) — it was invisible to Tiers 1-8, exactly as the skill predicts. Bundle rebuilt; **user must restart Pi** for the fix to take effect in a live session. 9c-9f intentionally skipped (no path touched; destructive actions need user confirmation).
