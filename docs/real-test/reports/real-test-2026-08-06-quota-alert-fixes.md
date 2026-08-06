# real-test-pi-crew — Run Report

**Date**: 2026-08-06
**Trigger**: post two fixes — provider-quota attribution (`cb67a506`) + dead-worker alert re-fire (`2f327993`) — after bundle rebuild (`896529f0`) and user Pi restart.
**Repo HEAD**: `2f327993`
**Bundle md5 (disk)**: `896529f09680aa1ae74e1b1dc638a241` (2,915,941 bytes ≈ 2.9 MB)
**Pi version**: `0.83.0` (active binary `…/node/v22.23.1/…/pi-coding-agent/dist/cli.js`)
**Run by**: pi agent (inside the session under test)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | `101/101` pass, 0 fail, 0 skipped, `duration_ms ≈ 13696` (~14–21s) |
| 2 3-path kill-switch | ✅ | default `101/101` + `PI_CREW_BROKER=0` `101/101` + `PI_CREW_BROKER=1` `101/101` — broker precedence intact (touched `lifecycle-handlers.ts` so ran it; the health-loop edit did not affect `effectiveEnabled()`) |
| 3 typecheck + bundle | ✅ | `npm run typecheck` exit 0, prints `strip-types import ok`; `build:bundle` exit 0, bundle md5 `896529f0`, 2915941 bytes |
| 4 bundle md5 sync | ✅ | disk = `896529f0`; session loaded it — **behavioral proof**: all `team` tool calls return clean structured results post-restart (no `Unknown type` / `Validation failed`); the Tier 7 smoke run executed successfully on this bundle |
| 5 tmux TUI probe | ⏭️ | skipped — no `src/ui/` change in these fixes |
| 6 pty probe | ⏭️ | skipped — no `src/ui/` change in these fixes |
| 7 smoke team run | ✅ | runId `team_20260806073832_395809c397569f29`, `3/3` tasks, **consistency=1**, wall-clock **146662 ms (~2.5 min)**; verifier ran `test:critical` + `tsc` (cached), well under the 300s worker limit — no hang |
| 8 final md5 sync | ✅ | disk = session = `896529f0` (per agent-inside-session rule: probe tool calls return clean + smoke run succeeded → session is on the new bundle; user had restarted) |
| 9a read-only battery | ✅ | `6/6` clean: `list`, `health`, `doctor focus=zombies`, `recommend` (correctly routed small-fix→`fast-fix`), `status`, `summary` — loaded extension's team surface healthy |
| 9b spawn paths | ✅(partial) | **sync run** ✅ via Tier 7 (`fast-fix`, 3/3). async / chain / `Agent` / `crew_agent` ⏭️ not separately run — **not required**: no `src/schema/team-tool-schema.ts`, `team-tool.ts`, or `Type.Unsafe` change in these fixes |
| 9c lifecycle | ⏭️ | not run — change does not touch lifecycle/recovery code paths |
| 9d destructive | ⏭️ | not run — data-protection; no destructive action needed for this verification |
| 9e admin | ⏭️ | not run — no team/workflow CRUD change |
| 9f background | ⏭️ | not run — no schedule/auto-summarize change |

Legend: ✅ pass with evidence · ❌ fail (root cause below) · ⏭️ skipped (justify why)

## Findings (bugs / quirks / non-blocking notes)

- **Pre-existing health noise (NOT from these fixes)** — `team action='health'` scan of 50 runs reports: 1 corrupted run (`team_20260805120112_0790f9688cc99afc`, missing-state-or-artifacts), 1 stuck task (`team_20260806041923_b5721633d6e5ace2/01_a`, stale 197 min — a *different* run), 34 zombie `/tmp/pi-crew-*-test-*` workspaces, 7 failed runs. These accumulated before this session; the alert fix targets the *terminal-run false-positive* specifically, not general housekeeping.
- **Alert-fix run is correctly terminal** — `team_20260806063823_bd79010b99ce7d95` (the alert-fix implementation run) shows `status: completed`, all workers `exit=0`, and is **not** in the stuck/dead list → Fix #1 (terminal suppression) behaving as intended.
- **4 live explorer sub-agents are not zombies** — belong to the user's concurrent survey run `team_20260806073143_a7555bfd870d9466` (`/home/bom/source/my-agent`); parents alive. `doctor` correctly says do-not-kill.
- **Consuming-project symlink check** returned "not a symlink at global root" — pi-crew is loaded as a **pi extension** (via `npx pi install .`), not a global npm package; the live-bundle proof is therefore behavioral (clean probes + successful smoke run on `896529f0`), per the skill's agent-inside-session acceptance criterion.

## What was NOT run + why

- **Tiers 5/6 (TUI probes)** — these fixes do not touch `src/ui/`; keystroke dispatch is unaffected.
- **9b async/chain/Agent/crew_agent spawn paths** — these fixes do not touch `team-tool-schema.ts` / `team-tool.ts` / `Type.Unsafe`, so the full spawn battery is not strictly required; the sync run path is proven via Tier 7.
- **9c–9f (lifecycle/destructive/admin/background)** — the change surface (quota attribution handler, health-notification loop, notification router clear-path, live-session runtime guard) does not overlap these action families.
- **`prune`/`cleanup`/`forget`** — destructive; deferred (separate from this verification).

## Restart needed?

- [x] **No** — session is already on the new bundle. User restarted Pi before this run; `896529f0` confirmed live via clean probe responses + successful Tier 7 smoke run.

## Verdict

**All required tiers pass.** Both fixes — provider-quota per-agent attribution (`cb67a506`) and dead-worker alert re-fire suppression/clear (`2f327993`) — verified end-to-end on live bundle `896529f0`: 101/101 critical tests (all 3 broker paths), typecheck + bundle clean, bundle synced into the restarted session, smoke team run 3/3 with no verifier hang, and the read-only feature battery clean. The alert-fix run itself is correctly classified as terminal (no false alert). **Safe to ship.** Publish (version bump + `git add -f dist/` + npm publish + GitHub release) remains gated on explicit user confirmation. Pre-existing housekeeping items (corrupted/stuck runs, zombie `/tmp` workspaces) are tracked separately and are not blockers.
