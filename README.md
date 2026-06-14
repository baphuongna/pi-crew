# pi-crew

**Coordinate AI agent teams inside [Pi](https://github.com/nicekate/pi-coding-agent).**

pi-crew is a Pi extension that orchestrates autonomous multi-agent workflows — research, implementation, review, testing, and more — with durable state, parallel execution, worktree isolation, and safe defaults.

```text
npm: pi-crew
repo: https://github.com/baphuongna/pi-crew
```

**v0.6.4**: See [CHANGELOG.md](CHANGELOG.md).

### Highlights (v0.6.3 → v0.6.4)

- **Visually rich tool rendering** — `team` and `Agent` tool calls now render as framed cards in the Pi TUI with box-drawing borders, colored status badges, and structured layouts
- **Merged call+result into ONE connected frame** — the call header and result body now form a single seamless frame instead of two disconnected boxes
- **Animated live progress bar during runs** — real-time `████░░░░ N/M` task progress with elapsed time, rendered DURING the run; indeterminate "starting" phase uses an animated scanning bar
- **Compact completion summary** — collapsed cards show `✓ crew run  3/3 done · 1m2s · 26k tok · $0.068` with expand hint and per-agent briefs
- **Critical crash fix on session resume** — `renderCall` was returning a `string` instead of a `Text` component, causing `TypeError: child.render is not a function` when Pi re-rendered stored tool calls
- **Disabled brief tool overrides** — reverted the experimental brief mode that replaced Pi's superior native renderers (syntax highlighting, diff views, full content)
- **Flaky test fix** — `AnimatedMascot` timing tests made CI-load-robust via polling loops
- **CI green** — 0 failures on Ubuntu, macOS, and Windows

### Highlights (v0.6.2 → v0.6.3)

- **137 commits** since v0.6.1 — 200 files changed (+16,955 / −2,057 lines)
- **4,792 tests**, 506 test files — **0 failures** across the entire suite
- **Cross-platform CI green** — 0 failures on Ubuntu, macOS, and Windows
- **366 source files**, ~70K lines of TypeScript
- **Worktree precondition validation** — friendly errors instead of crashes when cwd is not a git repo or repo is dirty
- **Cross-platform path handling** — `canonicalizePath` with `realpathSync.native` for Windows short-name/long-name aliasing; macOS symlink resolution
- **Scheduled job lifecycle** — spawned runs are tracked, cancelling a job kills its runs
- **Heartbeat false-positive fix** — PID liveness gate prevents dead detection during long LLM responses
- **ENOENT crash fix** — prune/forget race no longer crashes pi when persisting to deleted runs
- **Pipe buffer deadlock fix** — test runner no longer deadlocks when OS pipe buffer fills
- **Plugin registry** — extensible framework context injection for Next.js, Vite, Vitest
- **Health score system** — penalty-based scoring with time-series snapshots
- **CrewError taxonomy** — E001–E006 structured error codes replacing raw throws
- **Atomic write v2** — fsync + rename pattern for crash-safe state persistence
- **Pre-push review**: 56 unpushed commits reviewed, 1 release blocker found and fixed
- **Security**: sandbox constructor escape strengthened; env-filter provider key handling fixed
- **State-store race fix** — manifest/tasks mtime false positive eliminated
- **Orphan worker/temp cleanup** — 4-layer defense with session-scoped tracking

---

## Features

- **One Pi tool** — `team` handles routing, planning, execution, review, and cleanup
- **Autonomous delegation** — policy injection decides when/how to delegate based on task complexity
- **needs_attention status** — tasks that complete without calling `submit_result` get `needs_attention` (terminal) instead of `completed`; allows retry/re-run without blocking downstream phases
- **Real child Pi workers** — each task spawns a separate Pi process by default; scaffold/dry-run opt-out
- **Adaptive planning** — implementation workflow lets a planner agent decide subagent fanout
- **Parallel execution** — tasks in the same phase run concurrently with configurable concurrency
- **Durable state** — manifest, tasks, events, artifacts all persisted to disk
- **Async/background runs** — detached runs survive session switches with completion notifications
- **Worktree isolation** — opt-in git worktrees per task for safe parallel edits
- **Rich UI** — live widget, dashboard, progress tracking, model/token display
- **Observability** — metrics registry, Prometheus/OTLP exporters, heartbeat watching, deadletter queue
- **Resource management** — create/update/delete agents, teams, workflows with validation
- **Import/export** — portable run bundles for sharing and archiving
- **Adaptive plan fanout** — single `assess` step lets a planner pick the smallest effective crew
- **Adaptive workflows** — `implementation`, `review`, `parallel-research`, `research` workflows ship in `workflows/`
- **Hardened secrets** — linear-time detection covers PEM keys, Authorization headers, Bearer tokens, and `key=value` patterns
- **Scheduled runs** — `schedule`/`scheduled` actions with cron, interval, and one-shot support; spawned runs tracked and auto-cancelled on job removal
- **Plugin system** — framework-aware context injection (Next.js, Vite, Vitest) via plugin registry
- **Health scoring** — penalty-based run health with time-series snapshots

---

## Install

```bash
pi install npm:pi-crew
```

Local development:

```bash
pi install ./pi-crew
```

Post-install config bootstrap:

```bash
pi-crew          # after npm install
node ./pi-crew/install.mjs   # from local clone
```

---

## Quick Start

### 1. Initialize project

```text
/team-init
```

### 2. Run a team

```text
/team-run Investigate failing tests and propose a fix
```

Or via tool call:

```json
{
  "action": "run",
  "team": "default",
  "goal": "Investigate failing tests and propose a fix"
}
```

### 3. Check status

```text
/team-status <runId>
/team-dashboard
```

### 4. Get a recommendation

When unsure which team/workflow fits:

```json
{
  "action": "recommend",
  "goal": "Refactor auth flow and add tests"
}
```

---

## Builtin Teams

| Team | Workflow | Purpose |
|------|----------|----------|
| `default` | explore → plan → execute → verify | Balanced, general-purpose |
| `fast-fix` | explore → execute → verify | Quick bug fixes |
| `implementation` | Adaptive planner decides fanout | Multi-file implementation |
| `review` | explore → code-review → security-review → verify | Code review + security audit |
| `research` | explore → analyze → write | Research and documentation |
| `parallel-research` | Parallel shards → synthesize → write | Multi-source research |

## Builtin Agents

```
analyst  ·  critic  ·  executor  ·  explorer  ·  planner  ·  reviewer
security-reviewer  ·  test-engineer  ·  verifier  ·  writer
```

---

## Runtime Modes

pi-crew supports multiple runtime modes for task execution:

| Mode | Description |
|------|-------------|
| `auto` (default) | Uses `child-process` unless overridden by config |
| `child-process` | Spawns real `pi` child processes — each task runs in isolation |
| `scaffold` | Dry-run mode — renders prompts and persists artifacts without executing |
| `live-session` (experimental) | In-process session execution within the parent Pi |

```json
// Use scaffold mode (no real workers, just prompts)
{ "action": "run", "team": "default", "goal": "...", "runtime": { "mode": "scaffold" } }

// Disable workers globally
{ "executeWorkers": false }
```

## Async Runs

Async runs are **detached** from the session — they survive session switches and reloads. Pi-crew notifies when complete.

```json
{ "action": "run", "team": "default", "goal": "...", "async": true }
```

```text
/team-run --async Investigate failing tests
```

Background runs use `node --import jiti-register.mjs` for TypeScript support. See [docs/runtime-flow.md](docs/runtime-flow.md) for details.

## Worktree Isolation

Worktree mode creates an **isolated git worktree per task** — safe for parallel edits to the same branch.

```json
{
  "action": "run",
  "team": "implementation",
  "goal": "Refactor auth",
  "workspaceMode": "worktree"
}
```

```text
/team-run --worktree Refactor auth
```

Requirements:
- Git repository (cwd must be inside a git repo)
- Clean working tree (no uncommitted changes in the leader worktree)
  - Can be disabled via config: `requireCleanWorktreeLeader: false`
- Worktrees auto-cleanup on run completion/cancel

If preconditions are not met, a friendly error message is returned instead of crashing.

---

## Configuration

### Config Paths

| Scope | Path |
|-------|------|
| User | `~/.pi/agent/extensions/pi-crew/config.json` |
| Project (new) | `.crew/config.json` |
| Project (legacy) | `.pi/teams/config.json` |

### Quick Config

```text
/team-config                           # view all settings
/team-config get runtime.mode            # read one key
/team-config set runtime.mode=scaffold  # scaffold mode
/team-config set asyncByDefault=true    # async by default
/team-config unset runtime.mode          # reset to default
/team-config --project                  # project scope
/team-settings path                     # show config file path
```

### Key Settings

| Section | Keys | Default |
|---------|------|---------|
| **Runtime** | `mode`: `auto` \| `child-process` \| `scaffold` \| `live-session` | `auto` |
| | `maxTurns`, `graceTurns`, `groupJoin`, `requirePlanApproval` | various |
| **Concurrency** | `limits.maxConcurrentWorkers` | workflow-dependent |
| | `limits.maxTaskDepth`, `limits.maxChildrenPerTask` | 2, 5 |
| **Async** | `asyncByDefault` | `false` |
| | `runtime.groupJoin`: `off` \| `group` \| `smart` | `smart` |
| **Autonomy** | `profile`: `manual` \| `suggested` \| `assisted` \| `aggressive` | `suggested` |
| | `autonomous.injectPolicy`, `preferAsyncForLongTasks` | true, false |
| **UI** | `widgetPlacement`, `dashboardPlacement` | compact widget |
| | `showModel`, `showTokens` | display controls |
| **Reliability** | `autoRetry`, `autoRecover`, `deadletterThreshold` | opt-in |
| **Observability** | `prometheus.enabled`, `otlp.enabled`, `heartbeatStaleMs` | opt-in |
| **Worktree** | `worktree.enabled` | disabled by default |

> ⚠️ **Trust boundary**: project config cannot override sensitive execution controls (workers, runtime mode, autonomy, agent overrides). Set those in **user config** only.

📖 Full config reference: [docs/commands-reference.md#team-settings--config-management](docs/commands-reference.md) and [schema.json](schema.json)

---

## Tool Actions

```json
// Execute workflow (foreground or async)
{ "action": "run", "team": "default", "goal": "..." }
{ "action": "run", "team": "default", "goal": "...", "async": true }

// Monitor & control
{ "action": "status", "runId": "team_..." }
{ "action": "summary", "runId": "team_..." }
{ "action": "events", "runId": "team_..." }
{ "action": "artifacts", "runId": "team_..." }
{ "action": "cancel", "runId": "team_..." }
{ "action": "resume", "runId": "team_..." }
{ "action": "retry", "runId": "team_..." }
{ "action": "steer", "runId": "team_...", "taskId": "01_explore", "message": "Focus on src/ only" }
{ "action": "respond", "runId": "team_...", "message": "Answer" }
{ "action": "wait", "runId": "team_..." }

// Discovery
{ "action": "list" }
{ "action": "get", "resource": "team", "team": "default" }
{ "action": "get", "resource": "agent", "agent": "explorer" }
{ "action": "get", "resource": "workflow", "workflow": "review" }
{ "action": "recommend", "goal": "Refactor auth flow" }
{ "action": "search", "goal": "heartbeat detection" }

// Resource management
{ "action": "create", "resource": "agent", "config": { "name": "api-reviewer", ... } }
{ "action": "update", "resource": "team", "name": "backend", "config": { ... } }
{ "action": "delete", "resource": "workflow", "name": "quick-review" }
{ "action": "validate" }

// Run maintenance
{ "action": "cleanup", "runId": "team_..." }
{ "action": "forget", "runId": "team_...", "confirm": true }
{ "action": "prune", "olderThanDays": 7, "confirm": true }
{ "action": "export", "runId": "team_..." }
{ "action": "import", "path": "/path/to/bundle.tar.gz" }

// Environment & configuration
{ "action": "doctor", "config": { "smokeChildPi": true } }
{ "action": "config" }
{ "action": "init", "config": { "copyBuiltins": true } }
{ "action": "autonomy", "profile": "assisted" }

// Advanced
{ "action": "api", "runId": "team_...", "config": { "operation": "read-manifest" } }
{ "action": "plan", "team": "default", "goal": "..." }
{ "action": "orchestrate", "planPath": "plan.md", "team": "implementation", "goal": "..." }
{ "action": "parallel", "config": { "tasks": [{"goal": "...", "agent": "explorer"}] } }
{ "action": "worktrees", "runId": "team_..." }
{ "action": "graph", "runId": "team_..." }
{ "action": "explain", "runId": "team_..." }
{ "action": "health" }
{ "action": "doctor" }
{ "action": "cache" }
{ "action": "invalidate", "runId": "team_..." }

// Scheduled runs
{ "action": "schedule", "team": "fast-fix", "goal": "Run tests", "cron": "0 9 * * MON" }
{ "action": "schedule", "team": "default", "goal": "...", "interval": 3600000 }
{ "action": "schedule", "team": "research", "goal": "...", "once": "+10m" }
{ "action": "scheduled" }

// Diagnostics & settings
{ "action": "config" }
{ "action": "settings" }
{ "action": "autonomy" }
{ "action": "anchor" }
{ "action": "onboard" }
{ "action": "auto-summarize" }
```

📖 Full actions reference (40+ actions): [docs/actions-reference.md](docs/actions-reference.md)

---

## Slash Commands

```text
/team-run [--team=X] [--async] [--worktree] <goal>
/team-status <runId>
/team-dashboard
/team-doctor
/team-init [--copy-builtins]
/team-config [key=value]
/team-autonomy [status|on|off|suggested|assisted]
```

📖 Full commands reference: [docs/commands-reference.md](docs/commands-reference.md)

---

## Resource Discovery

Agents, teams, and workflows are discovered from three layers:

```
builtin (package)  <  user (~/.pi/agent/)  <  project (.crew/ or .pi/teams/)
```

Project resources can add new names but **cannot shadow** builtin/user resources.

### Resource Paths

| Type | Builtin | User | Project |
|------|---------|------|---------|
| Agent | `agents/*.md` | `~/.pi/agent/agents/*.md` | `.crew/agents/*.md` |
| Team | `teams/*.team.md` | `~/.pi/agent/teams/*.team.md` | `.crew/teams/*.team.md` |
| Workflow | `workflows/*.workflow.md` | `~/.pi/agent/workflows/*.workflow.md` | `.crew/workflows/*.workflow.md` |

### Custom Resources with Routing Metadata

```yaml
---
name: api-reviewer
description: Reviews API changes
triggers: api, endpoint, contract
useWhen: backend API changes, OpenAPI changes
avoidWhen: docs-only edits
cost: cheap
category: backend
---
Your system prompt here.
```

📖 Full resource formats: [docs/resource-formats.md](docs/resource-formats.md)

---

## State Layout

```
<crewRoot>/                          # .crew/ (new) or .pi/teams/ (legacy)
├── state/runs/{runId}/
│   ├── manifest.json                # run metadata
│   ├── tasks.json                   # task graph + status
│   ├── events.jsonl                 # append-only events
│   └── agents/{taskId}/status.json  # per-agent state
├── artifacts/{runId}/
│   ├── goal.md
│   ├── prompts/{taskId}.md
│   ├── results/{taskId}.txt
│   ├── logs/{taskId}.log
│   └── summary.md
├── worktrees/{runId}/{taskId}/
└── imports/{runId}/run-export.json
```

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `PI_CREW_EXECUTE_WORKERS=0` | Disable child workers (scaffold mode) |
| `PI_TEAMS_EXECUTE_WORKERS=0` | Legacy disable flag |
| `PI_TEAMS_MOCK_CHILD_PI=success` | Mock child worker for testing |
| `PI_TEAMS_PI_BIN=<path>` | Explicit Pi CLI path |
| `PI_TEAMS_HOME=<path>` | Override home for tests |

---

## Development

```bash
cd pi-crew
npm install          # dependencies
npm test             # unit + integration tests (~4,800 tests)
npm run typecheck    # tsc --noEmit
npm run ci           # full CI-equivalent check
npm pack --dry-run   # package verification
```

Stats: **366 source files** (70K lines) · **506 test files** (66K lines) · **4,792 tests, 0 failures** · **CI: Ubuntu ✅ macOS ✅ Windows ✅**

---

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/actions-reference.md](docs/actions-reference.md) | Full tool actions + examples |
| [docs/commands-reference.md](docs/commands-reference.md) | Slash commands + `/team-api` |
| [docs/resource-formats.md](docs/resource-formats.md) | Agent/team/workflow file formats |
| [docs/usage.md](docs/usage.md) | Usage patterns + config examples |
| [docs/architecture.md](docs/architecture.md) | Internal architecture + run flow |
| [docs/runtime-flow.md](docs/runtime-flow.md) | Runtime execution details |
| [docs/live-mailbox-runtime.md](docs/live-mailbox-runtime.md) | Mailbox + live-session runtime |
| [docs/publishing.md](docs/publishing.md) | Release & publish process |
| [docs/next-upgrade-roadmap.md](docs/next-upgrade-roadmap.md) | Future upgrade roadmap |
| [schema.json](schema.json) | Config JSON schema |

Research docs (not in package): [`docs/pi-crew-research/`](https://github.com/baphuongna/pi-crew/tree/main/docs) — audits, deep research, distillation notes.

---

## Acknowledgements

`pi-crew` builds on ideas and selected MIT-licensed implementation patterns from `pi-subagents` and `oh-my-claudecode`, with conceptual inspiration from `oh-my-openagent`.
