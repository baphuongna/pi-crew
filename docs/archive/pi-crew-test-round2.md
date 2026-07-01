# pi-crew v0.2.20 — Integration Test Round 2 (Post-Restart)

**Date:** 2026-05-19 (Round 2)  
**Context:** Pi restarted, async notifier fix applied  

---

## Summary

| Category | Tests | Pass | Fail | Notes |
|---|---|---|---|---|
| Discovery & Diagnostics | 5 | ✅ 5 | 0 | doctor, validate, list, settings, recommend |
| Planning | 1 | ✅ 1 | 0 | plan action |
| State Management | 4 | ✅ 4 | 0 | events, artifacts, export, summary |
| Portability | 2 | ✅ 2 | 0 | import, imports |
| Configuration | 2 | ✅ 2 | 0 | autonomy, help |
| Foreground Team (fast-fix) | 1 | ⚠️ 0 | 0 | Bug #6 reproducible: cancelled after explore |
| Background Subagents | 2 | 0 | ❌ 2 | pid_dead after 72s |
| Async Team Run | 1 | ✅ 1 | 0 | Research team: 2 parallel tasks spawned, alive! |
| Cancel + Retry | 2 | ✅ 2 | 0 | cancel + retry work |
| Prune | 1 | ✅ 1 | 0 | 6 runs pruned |
| **Total** | **21** | **18** | **2** | **1 partial** |

---

## Detailed Results

### ✅ Phase 1: Discovery & Diagnostics — 5/5 PASS

| Test | Result | Notes |
|---|---|---|
| `team doctor` | ✅ PASS | 17/17 checks OK |
| `team validate` | ✅ PASS | 10 agents, 6 teams, 6 workflows, 0 issues |
| `team list` | ✅ PASS | All resources enumerated |
| `team settings` | ✅ PASS | Full config displayed |
| `team recommend` | ✅ PASS | Correctly suggested implementation for "implement health check" |

### ✅ Phase 2: Planning — 1/1 PASS

| Test | Result | Notes |
|---|---|---|
| `team plan` (default) | ✅ PASS | 4 steps: explore→plan→execute→verify |

### ⚠️ Phase 3: Foreground Team (fast-fix) — Bug #6 Reproduced

| Test | Result | Notes |
|---|---|---|
| fast-fix live-session | ⚠️ PARTIAL | explore ✅ completed, then run cancelled with "caller_cancelled" |

**Bug #6 confirmed reproducible:**
- Explore task completed successfully (32s)
- Run immediately cancelled: `"reason":{"code":"caller_cancelled","message":"This operation was aborted"}`
- Execute and verify tasks never started
- Same pattern as Round 1

### ❌ Phase 4: Background Subagents — 2/2 FAIL

| Test | Result | Notes |
|---|---|---|
| Agent(explorer) background | ❌ FAIL | "Stale run reconciled: PID does not exist; pid_dead" after 72s |
| crew_agent(analyst) background | ❌ FAIL | Same: pid_dead after 72s |

Different error from Round 1 (305s heartbeat). Now fails faster (72s) with pid_dead — child Pi process crashes.

### ✅ Phase 5: Async Team Run — PASS

| Test | Result | Notes |
|---|---|---|
| research team (async) | ✅ PASS | pid=71195 alive=true, 2 parallel tasks running (explorer + analyst) |

**Key finding:** Async team runs DO work now! Background process spawned successfully and ran parallel tasks.

### ✅ Phase 6: Cancel + Retry — 2/2 PASS

| Test | Result | Notes |
|---|---|---|
| `team cancel` | ✅ PASS | Run cancelled, background runner detected interrupt |
| `team retry` | ✅ PASS | 3 tasks re-queued for retry |

### ✅ Phase 7: State + Portability — 4/4 PASS

| Test | Result | Notes |
|---|---|---|
| `team events` | ✅ PASS | Full event log with timestamps |
| `team artifacts` | ✅ PASS | 14 artifacts listed |
| `team export` | ✅ PASS | JSON + Markdown exported |
| `team import` | ✅ PASS | Bundle imported with README.md |

### ✅ Phase 8: Config + Cleanup — 2/2 PASS

| Test | Result | Notes |
|---|---|---|
| `team autonomy` | ✅ PASS | Profile=suggested, enabled |
| `team prune` | ✅ PASS | 6 runs removed, 3 kept |

---

## Bugs Found

### Bug #6: Foreground team run cancelled after first task — REPRODUCED

**Pattern:** Fast-fix live-session: explore completes → run immediately cancelled with "caller_cancelled"

Evidence:
```
07:40:55.273Z live-session.prompt_done 01_explore (elapsedMs=32119)
07:40:55.276Z live_agent.terminated 01_explore status=cancelled
07:40:55.300Z workflow.phase_completed: explore completed
07:40:55.304Z run.cancelled: "This operation was aborted"
         reason: {"code":"caller_cancelled","message":"This operation was aborted"}
```

This happened twice (Round 1 and Round 2) — **100% reproducible** with fast-fix team.

**Hypothesis:** The live-session runtime detects something after explore completes and aborts the run. Possibly:
1. Agent output length is 0 (`"outputLength":0`) despite task completing → triggers "no output" abort
2. Pi's session lifecycle cancels the continuation after the first live-agent terminates
3. `foregroundControllers` or session cleanup aborts the next phase

### Background subagent failures — Different from Round 1

Round 1: 305s timeout (429 rate limit)
Round 2: 72s pid_dead (process crash)

Rate limit seems resolved, but child Pi process now **crashes** instead of hanging. Need to check child Pi stderr for crash details.

---

## Improvement from Round 1

| Aspect | Round 1 | Round 2 | Change |
|---|---|---|---|
| Async team runs | ❌ heartbeat dead (300s) | ✅ alive, parallel tasks running | **Fixed** |
| Background agents | ❌ heartbeat dead (305s) | ❌ pid_dead (72s) | Faster failure, different cause |
| Foreground teams | ⚠️ cancelled | ⚠️ cancelled (same pattern) | No change |
| Async notifier | ❌ dies on stale ctx | (not tested yet) | Fix applied |
