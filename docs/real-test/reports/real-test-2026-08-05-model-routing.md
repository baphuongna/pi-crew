# real-test-pi-crew — Run Report

**Date**: 2026-08-05
**Trigger**: post subagent-model-routing feature merge `4148540e` (5 feature commits + 3-round iterative audit) into main
**Repo HEAD**: `4148540e` (then `12386af2` after the chain-workflow bug doc)
**Bundle md5 (disk)**: `5e72ed97830bdfeeca5d0def97b66be4` (rebuilt during Tier 3; 2844.2 KB)
**Pi version**: 0.83.0
**Run by**: agent (this session)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 101/101 pass, 9765ms |
| 2 3-path kill-switch | ✅ | default + `PI_CREW_BROKER=0` + `=1` all 101/101 (lifecycle-handlers touched by feature → required) |
| 3 typecheck + bundle | ✅ | tsc exit 0 ("strip-types import ok"); `build:bundle` 290ms, md5 `5e72ed...` |
| 4 bundle md5 sync | ⚠️→✅ | disk `5e72ed...` = loaded-by-pi (via `/home/bom/source/my_pi/node_modules/pi-crew` symlink). **Session was on STALE bundle `1b130480...` until user restart** — proved by chain failing 58ms in old bundle but working in tmux session with new bundle. |
| 5 tmux TUI probe | ✅ | fresh pi in tmux loaded new bundle; `/team-help` rendered full pi-crew commands; `[Extensions] pi-crew` listed |
| 6 pty probe | ✅ | `scripts/pty_probe.py` ran; TUI rendered (escape/key hints shown) |
| 7 smoke team run | ✅ | runId `team_20260805083332_ae0a0655767a922b`, 3/3 tasks, consistency=1, verifier **16.87s** (used cached output, no hang, <300s) |
| 8 final md5 sync | ✅ | disk = loaded = `5e72ed...` (after user restart) |
| 9a read-only battery | ✅ | 10/10 — list, recommend, health, doctor, status, events, summary, get, explain, worktrees |
| 9b spawn paths | ✅ | 5/5 — sync (`team_20260805084312`, TIER9-SYNC-OK) · async (`team_20260805084630`, TIER9-ASYNC-OK) · chain (`2/2 success`, 308s, 29k tok — **required omitting `workflow`**, see finding 1) · `Agent` (TIER9-AGENT-OK) · `crew_agent`+`get_subagent_result` (TIER9-CREW-OK) |
| 9c lifecycle | ✅ | status-details · cache(snapshot) · checkpoint(needs taskId) · steer(rejects completed) · retry(rejects non-failed) · resume(re-loads completed) · + live cancel implicitly verified via chain-kill heartbeat-recovery incident (`team_20260805085529`, watcher reconciled `no_pid_heartbeat_stale`) |
| 9d destructive | ✅ | forget (`team_20260805084312` — removed state+artifacts) · cleanup (handler OK, preserves .crew w/o force). **prune skipped** — protects user run data; handler proven via forget. |
| 9e admin | ✅ | team create→get→delete CRUD round-trip (`tier9-test-team`, backup created on delete) |
| 9f background | ✅ | auto-summarize (config+triggers shown) · anchor (no-anchor-for-session) · schedule register→scheduled list→remove (cron, far-future once, cleaned up) |

## Findings (bugs / quirks / non-blocking notes)
1. **Chain `workflow:"chain"` quirk** (Low, issue #44, `docs/bugs/chain-workflow-forward-quirk.md`): passing `workflow:'chain'` to `action:'run' chain=...` forwards it to each step → step runs "chain" workflow via `executeTeamRun` → fails ~58ms silent. Workaround: omit `workflow`.
2. **`test:critical` leaks /tmp fixtures** (test hygiene): each verifier run creates a few `/tmp/pi-crew-{broker-symlink,obs,obs-throw,obs-unsub}-*` dirs that don't self-clean. Cleaned 701 + 8 across the session. Recurring.
3. **Skill conflicts at startup** (cosmetic, pre-existing): `distill-software`/`research`/`security-review`/`distill-persona` collide across discovery dirs; pi resolves via precedence (✓ pick / ✗ skip). `REVIEW-FIXES-APPLIED.md` was a doc misfiled in `skills/` → moved to `~/source/my_pi/`.
4. **Feature verified live**: `doctor` now renders a `Model Routing` section (`session model (live): zai/glm-5.2`, fallback policy, 7-model sample chain) and `status details` shows per-task `modelRouting=zai/glm-5.2->zai/glm-5.2`.

## What was NOT run + why
- **prune** (9d): would delete user's older real runs — data protection; handler correctness proven via `forget`.
- **live mid-run `steer`/`wait` race** (9c): a single `team` tool call with `async:true` blocks until completion, so I couldn't issue steer from a separate call mid-run. Live cancel was implicitly verified by the chain-kill incident (watcher reconciled the killed run correctly).
- **workflow/agent CRUD** (9e): same manage-domain handler pattern as team CRUD (verified); skipped to bound cost.
- **goal-loop** (9f): dispatch path already exercised by every other spawn probe; goal-loop is budget-heavy, skipped.

## Restart needed?
- [x] Yes — session was on stale bundle `1b130480...`; user `/quit` + reopened → loaded `5e72ed...`. Verified post-restart via `doctor` showing the new `Model Routing` section.

## Verdict
All required tiers pass with per-row evidence. Feature subagent-model-routing (commit `4148540e`) is safe and verified live post-restart. **Issue #44** tracks the chain-workflow quirk (Low, workaround documented). The 9-tier report template (`skills/real-test-pi-crew/REPORT-TEMPLATE.md`) is now part of the discipline so future runs are verifiable.
