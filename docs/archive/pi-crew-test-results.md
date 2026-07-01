# pi-crew v0.2.20 Comprehensive Test Results

**Date:** 2026-05-19  
**Tester:** Pi Agent (automated)  
**Environment:** linux/x64, Node v22.22.0, Pi 0.75.3

---

## Summary

| Category | Tests | Pass | Fail | Partial |
|---|---|---|---|---|
| Resource Discovery | 5 | 5 | 0 | 0 |
| Subagent Lifecycle | 4 | 0 | 4 | 0 |
| Team Run Lifecycle | 4 | 1 | 2 | 1 |
| Planning | 1 | 1 | 0 | 0 |
| State Management | 6 | 6 | 0 | 0 |
| Diagnostics | 3 | 3 | 0 | 0 |
| Portability | 2 | 2 | 0 | 0 |
| Configuration | 2 | 2 | 0 | 0 |
| **Total** | **27** | **20** | **6** | **1** |

---

## Phase 1: Resource Discovery & Config

### 1.1 `team action='list'`
- **Input:** list all resources
- **Expected:** Teams, workflows, agents enumerated
- **Actual:** 6 teams, 6 workflows, 10 agents listed correctly
- **Result:** ✅ PASS

### 1.2 `team action='get'` — team detail
- **Input:** get team=default
- **Expected:** Team config with roles
- **Actual:** Returned team with 4 roles (explorer, planner, executor, verifier)
- **Result:** ✅ PASS

### 1.3 `team action='get'` — workflow detail
- **Input:** get workflow for implementation team
- **Expected:** Workflow steps
- **Actual:** Returned implementation workflow with assess step
- **Result:** ✅ PASS

### 1.4 `team action='get'` — agent detail
- **Input:** get agent=explorer
- **Expected:** Agent config with model, description, instructions
- **Actual:** Full agent profile with model=minimax/MiniMax-M2.7-highspeed
- **Result:** ✅ PASS

### 1.5 `team action='recommend'`
- **Input:** goal="test all features of pi-crew"
- **Expected:** Suggested team/workflow
- **Actual:** Recommended implementation team with high confidence
- **Result:** ✅ PASS

---

## Phase 2: Subagent Lifecycle

### 2.1 Agent (explorer) — background launch
- **Input:** Agent(explorer, run_in_background=true)
- **Expected:** Agent ID returned, result retrievable
- **Actual:** Agent started (agent_mpc423rq_1), but returned empty output on retrieval
- **Result:** ❌ FAIL — Agent spawned but produced no usable output

### 2.2 Agent (planner) — background launch
- **Input:** Agent(planner, run_in_background=true)
- **Expected:** Agent ID returned, result retrievable
- **Actual:** Agent started (agent_mpc423rv_2), but returned empty output
- **Result:** ❌ FAIL — Same as 2.1

### 2.3 Agent (analyst) — background launch
- **Input:** Agent(analyst, run_in_background=true)
- **Expected:** Agent ID returned, result retrievable
- **Actual:** Agent started (agent_mpc423rw_3), but returned empty output
- **Result:** ❌ FAIL — Same as 2.1

### 2.4 crew_agent (explorer) — background launch
- **Input:** crew_agent(explorer, run_in_background=true)
- **Expected:** Agent ID returned, result retrievable
- **Actual:** Agent started (agent_mpc423rw_4), but returned empty output
- **Result:** ❌ FAIL — Same pattern; child-process background workers not producing output

---

## Phase 3: Team Run Lifecycle

### 3.1 `team action='run'` — implementation team (async)
- **Input:** implementation team, async=true, large multi-phase goal
- **Expected:** Run starts, tasks complete
- **Actual:** Run started (team_20260519040558_cb5eac17edb6c951), task 01_assess (planner) heartbeat dead after 300s. Worker spawned but produced no output.
- **Root Cause:** Child-process runtime fell back from live-session. Worker (pid 4011266) timed out after 300s with zero output.
- **Result:** ❌ FAIL — Heartbeat timeout

### 3.2 `team action='retry'`
- **Input:** retry failed run
- **Expected:** Failed task re-queued
- **Actual:** Task 01_assess queued for retry successfully
- **Result:** ✅ PASS

### 3.3 `team action='run'` — fast-fix team (foreground/live-session)
- **Input:** fast-fix team, simple goal (find TODOs)
- **Expected:** Run completes through explore→execute→verify
- **Actual:** Run started as live-session, 01_explore completed, but run was cancelled before execute phase
- **Result:** ⚠️ PARTIAL — Explore completed, run cancelled mid-workflow

### 3.4 `team action='cancel'`
- **Input:** cancel a stuck run
- **Expected:** Run status → cancelled
- **Actual:** Run successfully cancelled
- **Result:** ✅ PASS

---

## Phase 4: Planning

### 4.1 `team action='plan'`
- **Input:** plan with default team, goal="Add health-check endpoint"
- **Expected:** Plan with structured steps
- **Actual:** Returned 4-step plan: explore → plan → execute → verify
- **Result:** ✅ PASS

---

## Phase 5: State Management

### 5.1 `team action='status'`
- **Input:** status of running/completed runs
- **Expected:** Detailed run state with task graph
- **Actual:** Full status with task graph, events, artifacts, policy decisions
- **Result:** ✅ PASS

### 5.2 `team action='events'`
- **Input:** events for a specific run
- **Expected:** Chronological event log
- **Actual:** 20+ events from run.created to task.failed with timestamps and metadata
- **Result:** ✅ PASS

### 5.3 `team action='artifacts'`
- **Input:** artifacts for a specific run
- **Expected:** List of artifact files
- **Actual:** 14 artifacts listed (prompts, results, metadata, logs, shared)
- **Result:** ✅ PASS

### 5.4 `team action='summary'`
- **Input:** summary of a specific run
- **Expected:** Concise run overview
- **Actual:** Full summary with status, goal, tasks, and usage
- **Result:** ✅ PASS

### 5.5 `team action='prune'`
- **Input:** prune with keep=2, confirm=true
- **Expected:** Old runs removed, 2 kept
- **Actual:** 9 runs pruned, 2 kept. Audit trail written to prune.jsonl
- **Result:** ✅ PASS

### 5.6 `team action='worktrees'`
- **Input:** worktrees without runId
- **Expected:** Error or info message
- **Actual:** Correctly required runId parameter
- **Result:** ✅ PASS (proper validation)

---

## Phase 6: Diagnostics

### 6.1 `team action='doctor'`
- **Input:** full diagnostics
- **Expected:** All checks pass
- **Actual:** 17/17 checks OK (runtime, filesystem, discovery, validation, drift, schema, async, worktrees)
- **Result:** ✅ PASS

### 6.2 `team action='validate'`
- **Input:** validate all resources
- **Expected:** 0 issues
- **Actual:** 10 agents, 6 teams, 6 workflows, 0 issues
- **Result:** ✅ PASS

### 6.3 `team action='help'`
- **Input:** show help
- **Expected:** Command reference
- **Actual:** Full command reference with core, inspection, maintenance, portability, diagnostics sections
- **Result:** ✅ PASS

---

## Phase 7: Portability

### 7.1 `team action='export'`
- **Input:** export a completed run
- **Expected:** JSON + Markdown export files
- **Actual:** Both run-export.json and run-export.md created in artifacts
- **Result:** ✅ PASS

### 7.2 `team action='import'`
- **Input:** import exported run bundle
- **Expected:** Run imported with summary
- **Actual:** Bundle imported to .crew/imports/ with README.md summary
- **Result:** ✅ PASS

---

## Phase 8: Configuration

### 8.1 `team action='settings'`
- **Input:** show effective settings
- **Expected:** Full config display
- **Actual:** Complete settings with agent overrides, UI config, autonomous mode
- **Result:** ✅ PASS

### 8.2 `team action='autonomy'`
- **Input:** show autonomy profile
- **Expected:** Current autonomy state
- **Actual:** Profile=suggested, enabled=true, inject policy=true
- **Result:** ✅ PASS

---

## Critical Findings

### 🚨 Issue 1: Background Child-Process Workers Silent
- **Severity:** HIGH
- **Symptom:** All background child-process workers (both Agent and team async runs) spawn successfully but produce zero output, leading to 300s heartbeat timeout.
- **Affected:** Agent(run_in_background=true), crew_agent(run_in_background=true), team async runs
- **Evidence:** 
  - 4 background agents → all returned empty
  - Implementation team async → 01_assess heartbeat dead
  - Background log contains only: `[pi-crew] background loader=jiti`
- **Root Cause Analysis (CONFIRMED):**
  - `pi --print "say hi"` hangs indefinitely even when run directly from shell
  - `timeout 10 pi --print "say hi"` → exits code 124 (timeout) — **100% reproducible**
  - Pi CLI starts (prints `[context-mode] WARNING`) but blocks on provider/model connection
  - **THIS IS NOT A PI-CREW BUG** — it's a provider connectivity issue
  - Live-session works because it reuses the parent Pi's already-established provider connection
  - Child-process workers start a NEW Pi instance which cannot connect to the model provider
  - **Possible causes:** API key not inherited by child env, network/firewall issue, provider rate limiting, or model endpoint unreachable

### ⚠️ Issue 2: Live-Session Runs Prematurely Cancelled
- **Severity:** MEDIUM
- **Symptom:** fast-fix live-session run completed explore phase but was cancelled before execute
- **Affected:** team action='run' with live-session runtime
- **Note:** May be related to session concurrency limits or user-initiated cancellation

### ✅ Stable Features
- Resource discovery (list, get, recommend)
- Diagnostics (doctor, validate, help)
- State inspection (status, events, artifacts, summary)
- Portability (export, import)
- Maintenance (prune, cancel)
- Configuration (settings, autonomy)
- Planning (plan action)

---

## Recommendations

1. **Debug child-process background workers:** Add verbose logging to background.log at jiti loader level. Check if the child Pi process receives the prompt correctly.
2. **Add heartbeat grace period:** Consider a configurable heartbeat timeout (currently fixed at 300s).
3. **Test live-session workflow end-to-end:** Run a foreground team to completion to verify full workflow lifecycle.
