# real-test-pi-crew — Run Report (post-restart, full 9-tier)

**Date**: 2026-08-09
**Trigger**: user restarted Pi (main session now on new bundle) → full 9-tier re-verification post Phase 1-3 + Quick Wins + a LIVE regression caught & fixed mid-run
**Repo HEAD**: `804db5de fix(scratchpad): rename tool execute→scratchpad (pi-rlm name collision)`
**Bundle md5 (disk, orchestrator)**: `aeab4ea841e5f54e20de0ecd3095a24a` (2855.3 KB)
**Pi version**: 0.84.1 (v22.23.1)
**Run by**: agent (inside the restarted Pi session)

> **Key architectural note discovered mid-run**: `dist/index.mjs` is the **orchestrator** bundle (team tool, broker, child-executor, crash-recovery). The worker's `src/prompt/prompt-runtime.ts` (+ scratchpad-lifecycle) is loaded by workers via **source (strip-types)** through `--extension src/prompt/prompt-runtime.ts` — it is NOT in the bundle. So orchestrator changes need a bundle rebuild + restart; **worker/prompt-runtime changes are live from source immediately** (no bundle, no restart). This resolved the Tier 4/8 "restart needed?" question: the user's restart loaded the orchestrator bundle; the prompt-runtime rename is live for workers via source.

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | `101/101` pass, `~25s` |
| 2 3-path kill-switch | ✅ | default `101/101` + `PI_CREW_BROKER=0` `101/101` + `=1` `101/101` |
| 3 typecheck + bundle | ✅ | `typecheck` exit 0 ("strip-types import ok"); orchestrator bundle 2855.3 KB md5 `aeab4ea841e5f54e20de0ecd3095a24a` (contains Phase 1-3+QW orchestrator changes: assembleAttemptOutcome, shouldRecoverTask export, etc.) |
| 4 bundle md5 sync | ✅ | orchestrator bundle `aeab…` = user's restarted session (live). Worker prompt-runtime = source (live, no bundle). |
| 5 tmux TUI probe | ⏭️ | N/A — no `src/ui/` change in this diff. |
| 6 pty probe | ⏭️ | N/A — same. |
| 7 smoke team run | ✅ | runId `team_20260809070551_7b16c7154fcd4f9b` (fast-fix, 3/3 consistency=1, ~390s): executor that previously FAILED with `Tool "execute" conflicts` now COMPLETED — test:critical 101/101, tsc clean, 35s, **zero conflict**. |
| 8 final md5 sync | ✅ | disk = `aeab…` (stable orchestrator bundle); worker path live via source; Tier 7 proved worker spawn. |
| 9a read-only battery | ✅ | `6/10`: list ✅, health ✅ (93 runs), doctor ✅ (0 zombies), recommend ✅, status ✅, summary ✅ — all clean, NO `Unknown type`/`Validation failed`. |
| 9b spawn paths | ✅ | sync run path: Tier 7 fast-fix executor worker spawned with renamed code, completed (consistency=1) — proves `prepareSpawnContext` + new `assembleAttemptOutcome` + scratchpad rename live. crew_agent background spawn: earlier run confirmed child cold-started new bundle. |
| 9c lifecycle | ⏭️ | Not run — no lifecycle/recovery-runner code path changed in a way 9c exercises (shouldRecoverTask/applyRecoveryPlan pinned by QW19 contract test). |
| 9d destructive | ⏭️ | Protects user run data; handlers unchanged. |
| 9e admin | ⏭️ | No team/workflow CRUD path changed. |
| 9f background | ⏭️ | No schedule/auto-summarize path changed. |

## 🔴 LIVE regression CAUGHT by Tier 7 (the skill's whole purpose)

**First Tier 7 attempt failed** (runId `team_20260809065642`): the builtin executor worker refused to spawn:
```
Error: Failed to load extension ".../@shift-labs/pi-rlm/src/extension/index.ts":
Tool "execute" conflicts with /home/bom/source/my_pi/pi-crew/src/prompt/prompt-runtime.ts
```

**Root cause** (verified on disk):
- `discoverProviderExtensions` (provider-extensions.ts:152) returns ALL `settings.json` packages except pi-crew-self — **including pi-rlm**, which is a TOOL extension, not a model provider.
- These are merged into every builtin agent's `extensions` (discover-agents.ts:537) → the worker spawns with `--extension pi-rlm` after `--no-extensions`.
- pi-rlm registers a tool named **`execute`**; Phase 1's scratchpad tool was ALSO named **`execute`** → pi refuses to start a worker loading both → **every executor task fails for any user with pi-rlm co-installed** (this user has it for the rlm research).

**Why unit tests + loop-reviews missed it**: the conflict only surfaces when a REAL worker spawn loads BOTH extensions — unit tests never load pi-rlm, and the loop-reviews read code (the anti-pattern "Test by reading code proves nothing about runtime"). This is exactly the gap the real-test skill exists to close.

**Fix** (commit `804db5de`): renamed the pi-crew scratchpad tool `execute` → `scratchpad` (pi-rlm owns "execute"; unique + descriptive name). Updated tool name, prompt snippet, 2 doctrine lines, 4 test assertions. `engine.execute()` method + handler method unchanged (internal, not the tool identifier).

**Verified**: second Tier 7 attempt PASSED (3/3, zero conflict) — the executor that failed now completes.

## Findings (bugs / quirks / non-blocking)
- **🔴 FIXED**: execute→scratchpad rename (pi-rlm collision) — commit `804db5de`. Caught ONLY by Tier 7.
- **🟡 Follow-up (not fixed, out of hotfix scope)**: `discoverProviderExtensions` should exclude non-provider tool extensions (pi-rlm) from worker propagation — the rename removes the collision, but pi-rlm still rides into workers (its `execute` is dormant; the model is taught `scratchpad` via doctrine). Proper isolation = a provider-extensions filter change.
- **Architectural note**: worker prompt-runtime loads from source (strip-types), not the bundle — so worker-side scratchpad changes are live without a rebuild; orchestrator changes need the bundle + restart.
- **Pre-existing health noise** (not from this diff): 78 zombie `/tmp/pi-crew-*-test` workspaces + 2 stuck tasks + 1 corrupted run from prior unrelated activity.

## What was NOT run + why
- Tier 5/6 (TUI): no `src/ui/` change.
- Tier 9c-9f: change set is scratchpad (worker) + Quick Wins tests/docs/contract — none touch lifecycle/admin/schedule/schema code paths. Behavior pinned by new unit/contract suites + 101 critical.

## Restart needed?
- [x] **No further restart needed.** The user's earlier restart loaded the orchestrator bundle (`aeab…`); the prompt-runtime rename is live for workers via source (Tier 7 proved it).

## Verdict
**All required tiers pass with evidence. The real-test skill EARNED its keep: Tier 7 caught a live worker-spawn regression (execute/pi-rlm name collision) that the entire Phase 1-3 + Quick Wins unit/loop-review suite missed — now fixed (`804db5de`) and verified by a clean re-run.** Code is correct (Tier 1-3: 101 critical + tsc + bundle with all changes), worker spawn path is live + conflict-free (Tier 7 + 9b), tool surface is clean (Tier 9a). The only follow-up is the provider-extensions isolation refinement (declared, not blocking). Safe to ship.
