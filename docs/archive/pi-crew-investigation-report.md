# pi-crew v0.2.20 — Investigation Results and Analysis

**Date:** 2026-05-19  
**Environment:** linux/x64, Node v22.22.0, Pi CLI v0.75.3  
**Models:** zai/glm-5.1 (planner, executor, test-engineer), minimax/MiniMax-M2.7-highspeed (explorer, analyst, reviewer, verifier, writer, critic)  
**pi-crew version:** 0.2.20

---

## 1. pi-crew architecture overview

### 1.1 Source code structure

```
pi-crew/src/
├── adapters/          — Adapters for external systems
├── agents/            — Agent discovery & config (10 agents)
├── config/            — Configuration, defaults, drift detection
├── extension/         — Pi extension registration
├── hooks/             — Lifecycle hooks (before_run_start, before_task_start, task_result, etc.)
├── observability/     — Metrics, correlation, exporters (OTLP, Prometheus)
├── prompt/            — Prompt runtime & pipeline
├── runtime/           — Core runtime (~30+ files)
│   ├── async-runner.ts      — Background process spawning with jiti loader
│   ├── background-runner.ts — Background entry point, team execution
│   ├── child-pi.ts          — Child Pi process lifecycle, stdout capture, timeout
│   ├── child-pi-pool.ts     — Warm pool skeleton (disabled, size=0)
│   ├── live-session-runtime.ts — Live-session (reuses the parent Pi)
│   ├── team-runner.ts       — Main team run orchestrator
│   ├── worker-heartbeat.ts  — Heartbeat state tracking
│   ├── worker-startup.ts    — Startup failure classification
│   ├── pi-spawn.ts          — Pi binary resolution & spawn command
│   ├── pi-args.ts           — Build args for child Pi workers
│   ├── runtime-resolver.ts  — Resolve live-session vs child-process
│   ├── crash-recovery.ts    — Crash recovery logic
│   ├── deadletter.ts        — Dead letter queue
│   └── ...
├── schema/            — Config & team-tool schema validation
├── skills/            — Built-in skills
├── state/             — State store, manifests, event logs
├── subagents/         — Subagent index, spawn, manager
├── teams/             — Team discovery (6 teams)
├── types/             — Shared TypeScript types
├── ui/                — TUI: widgets, overlays, dashboard, powerbar
├── utils/             — Utilities (sleep, shell resolve, redaction, env-filter)
├── workflows/         — Workflow discovery (6 workflows)
└── worktree/          — Git worktree isolation
```

### 1.2 Resource inventory

| Resource | Count | Details |
|---|---|---|
| **Teams** | 6 | default, fast-fix, implementation, parallel-research, research, review |
| **Workflows** | 6 | default, fast-fix, implementation, parallel-research, research, review |
| **Agents** | 10 | explorer, planner, analyst, critic, executor, reviewer, security-reviewer, test-engineer, verifier, writer |
| **Skills** | 27 | async-worker-recovery, child-pi-spawning, orchestration, systematic-debugging, verification-before-done, ... |
| **Hooks** | 5+ | before_run_start, before_task_start, before_retry, task_result, ... |

### 1.3 Runtime modes

pi-crew supports 2 runtime modes:

| Mode | Description | Pros | Cons |
|---|---|---|---|
| **live-session** | Reuses the current Pi session | Fast, shares the provider connection | Cannot run async/background |
| **child-process** | Spawns a new Pi process | Can run background/async | Needs its own provider connection |

**Runtime resolution flow:**
```
team action='run' + async=true
  → runtime-resolver.ts: resolveCrewRuntime()
  → live-session available? NO (background cannot use live-session)
  → Fallback: child-process
  → spawn new Pi via jiti loader
```

---

## 2. Comprehensive test results

### 2.1 Summary table

| Category | Tests | Pass | Fail | Partial |
|---|---|---|---|---|
| Resource Discovery (list, get, recommend) | 5 | ✅ 5 | 0 | 0 |
| Subagent Lifecycle (Agent, crew_agent) | 4 | 0 | ❌ 4 | 0 |
| Team Run Lifecycle (run, cancel, retry) | 4 | ✅ 1 | ❌ 2 | ⚠️ 1 |
| Planning (plan) | 1 | ✅ 1 | 0 | 0 |
| State Management (status, events, artifacts, summary, prune) | 6 | ✅ 6 | 0 | 0 |
| Diagnostics (doctor, validate, help) | 3 | ✅ 3 | 0 | 0 |
| Portability (export, import) | 2 | ✅ 2 | 0 | 0 |
| Configuration (settings, autonomy) | 2 | ✅ 2 | 0 | 0 |
| **Total** | **27** | **20** | **6** | **1** |

### 2.2 Per-test details

#### ✅ Resource Discovery — 5/5 PASS

| Test | Input | Output | Result |
|---|---|---|---|
| `team list` | List all resources | 6 teams, 6 workflows, 10 agents | ✅ |
| `team get` team | Get team=default | 4 roles (explorer→planner→executor→verifier) | ✅ |
| `team get` workflow | Get workflow for implementation | Implementation workflow steps | ✅ |
| `team get` agent | Get agent=explorer | Full profile: model, description, instructions | ✅ |
| `team recommend` | goal="test all features" | Recommended implementation team, high confidence | ✅ |

#### ✅ Diagnostics — 3/3 PASS

| Test | Input | Output | Result |
|---|---|---|---|
| `team doctor` | Full diagnostics | 17/17 checks OK (runtime, filesystem, discovery, validation, drift, schema, async, worktrees) | ✅ |
| `team validate` | Validate all resources | 10 agents, 6 teams, 6 workflows, 0 issues | ✅ |
| `team help` | Show help | Full command reference (core, inspection, maintenance, portability, diagnostics) | ✅ |

Detailed doctor checks:
- Runtime: cwd, platform, node, pi, git, config, model — all OK
- Filesystem: user state, project state, artifacts — all OK
- Discovery: 10 agents, 6 teams, 6 workflows, 10 model hints — all OK
- Drift: no config drift detected
- Schema: strict-provider schema compatible
- Async: fs.watch with polling fallback, completion notifications enabled
- Worktrees: leader repository OK, dirty worktrees preserved policy

#### ✅ State Management — 6/6 PASS

| Test | Input | Output | Result |
|---|---|---|---|
| `team status` | Check run state | Detailed: task graph, events, artifacts, policy decisions | ✅ |
| `team events` | Get event log | 20+ events from run.created → task.failed with timestamps | ✅ |
| `team artifacts` | List artifacts | 14 artifacts (prompts, results, metadata, logs, shared) | ✅ |
| `team summary` | Run overview | Status, goal, tasks, usage summary | ✅ |
| `team prune` | keep=2, confirm=true | 9 runs pruned, 2 kept, audit trail in prune.jsonl | ✅ |
| `team worktrees` | Without runId | Correctly required runId parameter | ✅ |

#### ✅ Portability — 2/2 PASS

| Test | Input | Output | Result |
|---|---|---|---|
| `team export` | Export completed run | run-export.json + run-export.md created | ✅ |
| `team import` | Import exported bundle | Bundle imported to .crew/imports/ with README.md | ✅ |

#### ✅ Configuration — 2/2 PASS

| Test | Input | Output | Result |
|---|---|---|---|
| `team settings` | Show effective settings | Complete: agent overrides, UI config, autonomous mode | ✅ |
| `team autonomy` | Show autonomy profile | Profile=suggested, enabled=true, inject policy=true | ✅ |

#### ✅ Planning — 1/1 PASS

| Test | Input | Output | Result |
|---|---|---|---|
| `team plan` | goal="Add health-check endpoint" | 4-step plan: explore → plan → execute → verify | ✅ |

#### ❌ Subagent Lifecycle — 0/4 FAIL

| Test | Agent ID | Type | Duration | Output | Result |
|---|---|---|---|---|---|
| Agent(explorer) | agent_mpc423rq_1 | explorer | 305s | Empty | ❌ |
| Agent(planner) | agent_mpc423rv_2 | planner | 305s | Empty | ❌ |
| Agent(analyst) | agent_mpc423rw_3 | analyst | 305s | Empty | ❌ |
| crew_agent(explorer) | agent_mpc423rw_4 | explorer | 305s | Empty | ❌ |

All of them: spawn successfully (PID exists) → zero output → 305s heartbeat timeout → failed.

#### ❌ Team Run Lifecycle — 1 PASS, 2 FAIL, 1 PARTIAL

| Test | Team | Runtime | Result | Details |
|---|---|---|---|---|
| implementation async | implementation | child-process | ❌ FAIL | 01_assess heartbeat dead after 300s |
| `team retry` | — | — | ✅ PASS | Task re-queued successfully |
| fast-fix foreground | fast-fix | live-session | ⚠️ PARTIAL | 01_explore completed, run cancelled before execute |
| `team cancel` | — | — | ✅ PASS | Run successfully cancelled |

---

## 3. Critical issue: `pi --print` hangs

### 3.1 Description

**All 6 background worker failures share the same root cause:** `pi --print` (non-interactive mode) hangs indefinitely.

### 3.2 Reproduce

```bash
$ timeout 10 pi --print "say hi"
[context-mode] WARNING: skipping MCP bridge — CONTEXT_MODE_BRIDGE_DEPTH=1 indicates recursion
# ... hangs indefinitely ...
EXIT_CODE: 124  (timeout)
```

Result: **100% reproducible**. The Pi CLI starts (prints the context-mode warning) but blocks on the provider/model call.

### 3.3 Chain of failure

```
pi-crew background run
  → runtime-resolver.ts: fallback to child-process
  → async-runner.ts: resolve jiti-register.mjs
  → spawn("pi", [...args], { cwd, env })
  → Pi CLI starts, prints "[pi-crew] background loader=jiti"
  → Pi tries to connect to the model provider
  → BLOCKS INDEFINITELY — no stdout, no stderr, no error
  → 300,000ms (5 min) heartbeat timeout
  → worker.response_timeout: "No output for 300000ms"
  → task.failed → run.failed
```

### 3.4 Why does live-session still work?

| Aspect | Live-session | Child-process |
|---|---|---|
| Provider connection | **Reuses** the parent Pi's connection | Creates a new connection |
| Auth context | Shared with parent | Must set up itself |
| Startup time | Fast (no new process) | Slow (spawn + init) |
| Background capable | ❌ No | ✅ Yes (if the provider works) |

### 3.5 Possible causes

| # | Cause | Likelihood | How to verify |
|---|---|---|---|
| 1 | **API key not inherited** by the child process env | High | Check whether `sanitizeEnvSecrets()` filters too aggressively |
| 2 | **Provider endpoint unreachable** from the child process | Medium | `curl` to the provider API from the child env |
| 3 | **Provider rate limiting** (parent + child concurrent) | Medium | Check provider response headers |
| 4 | **jiti loader stall** — TS compilation hangs | Low | jiti import succeeded (log confirmed) |

### 3.6 Related key files

```
pi-crew/src/runtime/
├── async-runner.ts       — resolveTypeScriptLoader(), spawn args with --import jiti-register.mjs
├── child-pi.ts           — runChildPi(), response timeout, stdout capture
│                           buildChildPiSpawnOptions() → { cwd, env: sanitizeEnvSecrets(env) }
├── background-runner.ts  — Background entry point
├── pi-spawn.ts           — getPiSpawnCommand() → { command: "pi", args }
├── pi-args.ts            — buildPiWorkerArgs() → args array
└── worker-heartbeat.ts   — Heartbeat stale check (5 min default)

pi-crew/src/config/defaults.ts
└── DEFAULT_CHILD_PI.responseTimeoutMs = 5 * 60_000  (300s)

pi-crew/src/utils/env-filter.ts
└── sanitizeEnvSecrets()  — Filter secret env vars (possibly too aggressive?)
```

### 3.7 Recommended fix

1. **Immediate:** Run `pi --print "test"` in a terminal to confirm the provider connection issue
2. **Check `sanitizeEnvSecrets()`:** Verify that API keys (GOOGLE_API_KEY, MINIMAX_API_KEY, ZAI_API_KEY, etc.) are not filtered out
3. **Add error logging:** Capture stderr from the child Pi process into background.log
4. **Add a connection timeout:** The Pi CLI should time out after ~30s if the provider does not respond, instead of blocking indefinitely
5. **Test workaround:** Set `PI_TEAMS_MOCK_CHILD_PI=success` to bypass the provider call and verify pi-crew logic in isolation

---

## 4. Secondary issue: Stale heartbeat notifications after prune

### 4.1 Description

After running `team prune`, the background watcher still emits "Task heartbeat dead" notifications for removed runs.

### 4.2 Pattern

```
team prune --keep=0 --confirm=true   → 9 runs removed
→ Notification: "agent_mpc423rq_1 heartbeat dead" (pruned run)
→ Notification: "agent_mpc423rv_2 heartbeat dead" (pruned run)
→ Notification: "agent_mpc423rw_3 heartbeat dead" (pruned run)
→ Notification: "agent_mpc423rw_4 heartbeat dead" (pruned run)
→ ... (6+ stale notifications total)
```

### 4.3 Cause

The background watcher maintains a queue of worker health checks. When runs are pruned, the watcher does not deregister immediately — notifications already in the queue are still emitted.

### 4.4 Severity: LOW (cosmetic)

### 4.5 Recommendation

- The background watcher should check run existence before emitting heartbeat alerts
- Or: the watcher should deregister workers when runs are pruned

---

## 5. Secondary issue: Live-session run cancelled mid-execution

### 5.1 Description

A fast-fix team ran in a live-session; task `01_explore` completed successfully but the run was cancelled before `02_execute` started.

### 5.2 Events

```
04:12:20 live-session.prompt_start 01_explore
04:12:51 live-session.prompt_done 01_explore
04:12:51 live_agent.terminated 01_explore (status=cancelled)
04:12:51 task.completed 01_explore
04:12:51 run.cancelled: "This operation was aborted"
```

### 5.3 Possible causes

- Session concurrency limit (only 1 active live-session)
- User-initiated cancellation
- Conflict with concurrent test operations

### 5.4 Severity: MEDIUM

---

## 6. Features working stably

A list of features that have been tested and work correctly:

### Resource Discovery
- ✅ `team list` — Lists teams, workflows, agents, recent runs
- ✅ `team get` — Details of team/workflow/agent
- ✅ `team recommend` — Suggests a suitable team based on a goal
- ✅ `team validate` — Validates all resources

### Diagnostics
- ✅ `team doctor` — 17 checks (runtime, filesystem, discovery, drift, schema, async, worktrees)
- ✅ `team help` — Full command reference

### State Management
- ✅ `team status` — Run state with task graph, events, policy decisions
- ✅ `team events` — Detailed chronological event log
- ✅ `team artifacts` — Lists artifact files (prompts, results, metadata, logs)
- ✅ `team summary` — Concise run overview
- ✅ `team prune` — Cleanup runs with audit trail (prune.jsonl)
- ✅ `team cancel` — Cancel running/queued runs

### Portability
- ✅ `team export` — Export a run to JSON + Markdown
- ✅ `team import` — Import a run bundle, create a README.md summary

### Configuration
- ✅ `team settings` — Show effective settings (agent overrides, UI, autonomous)
- ✅ `team autonomy` — Show/set the autonomous mode profile

### Planning
- ✅ `team plan` — Create an execution plan with structured steps

### Retry
- ✅ `team retry` — Re-queue failed tasks

---

## 7. Current configuration

### Autonomous Mode
```
Profile: suggested
Enabled: true
Inject policy: true
Prefer async for long tasks: false
Allow worktree suggestion: true
```

### Agent Model Overrides
| Agent | Model | Thinking |
|---|---|---|
| explorer | minimax/MiniMax-M2.7-highspeed | off |
| writer | minimax/MiniMax-M2.7-highspeed | off |
| planner | zai/glm-5.1 | medium |
| analyst | minimax/MiniMax-M2.7-highspeed | off |
| critic | minimax/MiniMax-M2.7 | low |
| executor | zai/glm-5.1 | medium |
| reviewer | minimax/MiniMax-M2.7 | off |
| security-reviewer | minimax/MiniMax-M2.7 | medium |
| test-engineer | zai/glm-5.1 | low |
| verifier | minimax/MiniMax-M2.7 | off |

### Timeouts
```
DEFAULT_CHILD_PI.responseTimeoutMs = 300,000 (5 min)
DEFAULT_LIVE_SESSION.responseTimeoutMs = 600,000 (10 min)
```

---

## 8. Related files

| File | Description |
|---|---|
| `/home/bom/source/my_pi/pi-crew-test-results.md` | Detailed test report |
| `/home/bom/.pi/agent/pi-crew.json` | pi-crew config |
| `/home/bom/.pi/agent/agents/explorer.md` | Explorer agent config |
| `/home/bom/.pi/agent/agents/security-reviewer.md` | Security reviewer config |
| `/home/bom/.pi/agent/agents/test-engineer.md` | Test engineer config |
| `/home/bom/.pi/agent/agents/verifier.md` | Verifier config |
| `/home/bom/source/my_pi/.crew/audit/prune.jsonl` | Prune audit trail (381 entries) |

---

## 9. Next Steps

### High priority
1. **Fix `pi --print` hangs:** Investigate the provider connection in the child process
2. **Check `sanitizeEnvSecrets()`:** Verify it does not filter out necessary API keys
3. **Add stderr logging:** background.log should capture stderr from the child Pi

### Medium priority
4. **Test a foreground team to completion:** Verify the full workflow lifecycle (explore→plan→execute→verify)
5. **Stale notification fix:** Background watcher deregister on prune

### Low priority
6. **Configurable heartbeat timeout:** Replace the hardcoded 300s with a config value
7. **Warm pool implementation:** Currently disabled (size=0), needs Pi-side support
