# pi-crew

**Coordinate AI agent teams inside [Pi](https://github.com/nicekate/pi-coding-agent).**

pi-crew is a Pi extension that orchestrates autonomous multi-agent workflows — research, implementation, review, testing, and more — with durable state, parallel execution, worktree isolation, and safe defaults.

```text
npm: pi-crew
repo: https://github.com/baphuongna/pi-crew
```

**v0.5.7**: See [CHANGELOG.md](CHANGELOG.md).

### Security highlights (v0.5.5)

- **ReDoS-free secret redaction** — linear-time scanning in `redaction.ts`; no catastrophic backtracking
- **v8.deserialize hardened** — `BINARY_MAGIC` header guards on registry binaries prevent untrusted-file RCE
- **Cache lock protection** — `withFileLockSync` and atomic writes across `run-cache.ts` and `state-store.ts`
- **Shell injection prevented** — shell-metacharacter blocking in `benchmark-runner.ts`
- **TOCTOU-free file ops** — atomic `mkdirSync` in `crew-init.ts`; `realpath`-based path validation
- **Memory leaks capped** — `MAX_HANDOFFS_PER_ANCHOR=100`, `MAX_DELIVERY_MESSAGES=10000`, `MAX_RUNS=1000`
- **Inline secret detection** — `token=`, `api_key=`, `password=` patterns redacted at event/mailbox boundaries
- **Subagent log scrubbing** — pre-aborted signal logging no longer dumps unredacted params

See [SECURITY-ISSUES.md](SECURITY-ISSUES.md) for the full list (SEC-001 – SEC-007 all marked fixed).

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

| Team | Workflow | Mục đích |
|------|----------|----------|
| `default` | explore → plan → execute → verify | Cân bằng, đa năng |
| `fast-fix` | explore → execute → verify | Sửa bug nhỏ nhanh |
| `implementation` | Adaptive planner quyết fanout | Multi-file implementation |
| `review` | explore → code-review → security-review → verify | Code review + security audit |
| `research` | explore → analyze → write | Nghiên cứu và viết tài liệu |
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
  "worktree": { "enabled": true }
}
```

```text
/team-run --worktree Refactor auth
```

Requirements:
- Git repository
- Clean working tree (no uncommitted changes in the main worktree)
- Worktrees auto-cleanup on run completion/cancel

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

// Discovery
{ "action": "list" }
{ "action": "get", "resource": "team", "name": "default" }
{ "action": "recommend", "goal": "Refactor auth flow" }

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
{ "action": "api", "runId": "team_...", "operation": "read-manifest" }
{ "action": "plan", "team": "default", "goal": "..." }
{ "action": "worktrees", "runId": "team_..." }
```

📖 Full actions reference (28 actions): [docs/actions-reference.md](docs/actions-reference.md)

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
npm test             # unit + integration tests
npm run typecheck    # tsc --noEmit
npm run ci           # full CI-equivalent check
npm pack --dry-run   # package verification
```

CI runs on: `ubuntu-latest` · `windows-latest` · `macos-latest`

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
