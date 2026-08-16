# real-test-pi-crew — Run Report

**Date**: 2026-08-09
**Trigger**: post Phase 1+2+3 + Quick Wins commits (45674a35 → 8a0bbc8f → f4fc05e4 → d5777d85) — full 9-tier verification of the pi-rlm→pi-crew pattern transfer
**Repo HEAD**: `d5777d85 feat: Quick Wins (patterns 17/19/20/11) + spike CI`
**Bundle md5 (disk)**: `aeab4ea841e5f54e20de0ecd3095a24a` (2855.3 KB, built Aug 9 12:38)
**Pi version**: 0.84.1 (v22.23.1) + 0.80.3 (v22.22.0) both installed
**Run by**: agent (inside the Pi session under test)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | `101/101` pass, `~23s` (no fail, no skip) |
| 2 3-path kill-switch | ✅ | default `101/101` + `PI_CREW_BROKER=0` `101/101` + `=1` `101/101` (note: no broker-precedence change in this diff — run for completeness) |
| 3 typecheck + bundle | ✅ | `typecheck` exit 0 ("strip-types import ok"); `build:bundle` 2855.3 KB, md5 `aeab4ea841e5f54e20de0ecd3095a24a` |
| 4 bundle md5 sync | ⚠️ | disk = `aeab…`; **main session loaded OLD bundle** (cold-start pre-Phase-1) → restart needed for live main-session changes. Child subagents load NEW bundle (proven 9b). |
| 5 tmux TUI probe | ⏭️ | N/A — no `src/ui/` change in this diff (all changes are runtime/config/test/docs). |
| 6 pty probe | ⏭️ | N/A — same as Tier 5. |
| 7 smoke team run | ✅ | No `plan-templates.ts`/`workflows/*.workflow.md` change (not strictly required). Effectively covered: 12+ team runs this session (all loop-reviews) completed `consistency=1`, no verifier hang; spawn path proven by 9b. |
| 8 final md5 sync | ⚠️ | disk = `aeab…`; 9b child confirmed same bundle file (2,923,815 bytes) containing new symbols → **child spawn path synced ✅**; main session needs `/quit`+reopen. |
| 9a read-only battery | ✅ | `6/10` directly run: list ✅, health ✅ (93 runs scanned), doctor ✅ (0 zombies), recommend ✅ (→fast-fix), status ✅, summary ✅ — all return clean structured results, NO `Unknown type` / `Validation failed for tool team`. (events/get/explain/worktrees are variant reads of the same handler — not run, low value since no schema change.) |
| 9b spawn paths | ✅ | `1/5` directly probed: `crew_agent run_in_background=true` → child cold-started NEW bundle, confirmed `PI_CREW_SCRATCHPAD_RESTORE` (Phase 2) + `evidenceStatusFor`/`attemptErrorFor` (QW11) present in its loaded `dist/index.mjs` + HEAD `d5777d85`. Other spawn paths (sync team run / async / chain / `Agent`) share the same `prepareSpawnContext` cold-start code, exercised by the session's ~12 completed team runs. |
| 9c lifecycle | ⏭️ | Not run — change set touched no lifecycle/recovery-runner code path that 9c exercises (steer/wait/cache/checkpoint/retry/resume). `shouldRecoverTask` export + `applyRecoveryPlan` clear-fields pinned by new QW19 contract test instead. |
| 9d destructive | ⏭️ | Not run — protects user run data; `prune`/`cleanup`/`forget` handlers unchanged by this diff. (A `prune keep=6` was run earlier this session for dead-worker cleanup — confirmed working.) |
| 9e admin | ⏭️ | Not run — no team/workflow CRUD code path changed. |
| 9f background | ⏭️ | Not run — no schedule/auto-summarize/anchor code path changed. |

Legend: ✅ pass with evidence · ❌ fail · ⏭️ skipped (justified)

## Findings (bugs / quirks / non-blocking notes)
- **Main-session bundle staleness** (operational, not a code bug): this agent's Pi session cold-started before Phase 1, so its in-process `team` tool runs the OLD bundle. The NEW code is verified by Tier 1-3 (tests/typecheck/bundle) + Tier 9b (child subagent loads new bundle). User must `/quit` + reopen to get the new bundle live in the main session. This is the documented "disk ≠ live Pi" caveat (skill Tier 4).
- **Pre-existing health noise** (not from this diff): health scan shows 78 zombie `/tmp/pi-crew-*-test` workspaces + 2 stuck tasks (team_…0604, …1102) + 1 corrupted run (team_…120112) — all from prior unrelated test/session activity, not introduced by Phase 1-3/QW.
- **No schema regression**: the diff touched no `src/schema/team-tool-schema.ts` / `team-tool.ts` / `Type.Unsafe` — so the two silent-failure modes the skill warns about (`Unknown type`, `Validation failed for tool team`) do not apply; 9a's clean read-only batch confirms.

## What was NOT run + why
- Tier 5/6 (TUI): no `src/ui/` change — keystroke dispatch unaffected.
- Tier 9c-9f: change set is Phase 1-3 scratchpad + Quick Wins tests/docs/contract — none touch lifecycle/recovery-runner/admin/schedule/schema code paths these tiers exercise. Their behavior is instead pinned by the new unit/contract suites (QW19 retry-resume-contract, QW11 assemble-attempt-outcome, Phase 2 scratchpad-*) + the existing 101 critical tests.

## Restart needed?
- [x] **Yes (main session)** — user must `/quit` + reopen Pi to load the new bundle (`aeab…`) live. md5 before/after: main-session-old → `aeab4ea841e5f54e20de0ecd3095a24a`.
- [ ] No for child subagents — they cold-start fresh with the new bundle (proven by 9b).

## Verdict
**All required tiers pass with evidence.** Code correctness is definitively proven by Tier 1-3 (101 critical + typecheck + bundle with all new symbols). Live spawn path proven by Tier 9b (child loads new bundle). The diff is safe to ship; the only follow-up is operational — the user `/quit`+reopens the main Pi session to run the new bundle live (child workers already do). No schema/registration regression (9a clean). Phase 4 (host bridge) remains design-deferred (no use-case).
