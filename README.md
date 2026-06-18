# pi-crew

**Coordinate AI agent teams inside [Pi](https://github.com/nicekate/pi-coding-agent).**

pi-crew is a Pi extension that orchestrates autonomous multi-agent workflows — research, implementation, review, testing, and more — with durable state, parallel execution, worktree isolation, and safe defaults.

```text
npm: pi-crew
repo: https://github.com/baphuongna/pi-crew
```

**v0.8.11**: See [CHANGELOG.md](CHANGELOG.md).

### Highlights (v0.6.4 → v0.8.11)

A long arc of **trust, cliff-resilience, and robustness** work. Principle: *build
trust and cliff-resilience, stay lean, delete before adding.*

#### v0.8.x — hardening & reliability (2026-06-17)
- **🛠️ Split-scope install fix (v0.8.11)** — `team` runs no longer crash with
  `Cannot find module '@earendil-works/pi-coding-agent'` when pi-crew and pi
  live in separate node_modules trees (the default for `pi install`). New
  `src/runtime/peer-dep.ts` resolves the ESM-only peer dep across 6 strategies.
- **🔄 Model fallback on transient 5xx (v0.8.11)** — a hard-down provider
  (`500 api_error "unknown error"`) now triggers the configured fallback
  model instead of aborting the run. `isRetryableModelFailure` extended.
- **🧊 Cold-start race eliminated (v0.8.6 → v0.8.10)** — under tsx, concurrent
  subagent spawns raced module instantiation (`existsSync` / `CREW_README` /
  `effectiveRunConfig` / `validateWorkflowForTeam`). Fixed graph-wide: warm at
  registration + gate at spawn boundaries + per-site latches. 6/6 repro clean.
- **🔒 Cross-project leak fixed (v0.8.8)** — ambient status / compaction no
  longer bleed foreign-project runs into the current session. Cwd-scope
  barrier (`isInProjectScope`), version-independent.
- **🩺 Doctor runtime-warmup status (v0.8.7)** — `team doctor` shows whether
  the module-graph warmup fired.
- **🔍 Cold-verifier agent (v0.8.4)** — adversarial cross-check that re-derives
  claims WITHOUT trusting prior analysis, catching confirmation bias.
- **⚡ Per-write validator (v0.8.5)** — zero-cost `JSON.parse` on every
  `write`/`edit`, appends a `🔴` blocker on malformed files.
- **🎨 Terminal status (v0.8.3)** — tab title + Ghostty native progress bar.
- **🧠 Skill confidence revived (v0.8.2)** — `adjustConfidence()` was dead
  code; the effectiveness system now actually learns.
- **🔧 Tool-restriction unification (v0.8.0)** — single `resolveToolPolicy`
  across both spawn paths.
- **🎯 F6/F1 interop granularity (v0.7.9)** — 7 skill roots, `.pi/agents/`
  tier, tool wildcards, `excludeExtensions` denylist.

#### v0.7.0 — Phase 0 + Phase 1 roadmap
- **🛡️ Compaction resilience (O10)** — in-flight runs survive auto-compact.
- **💰 Cost visibility (O1)** — per-role token + cost attribution.
- **✋ Plan-level HITL (O5)** — `requirePlanApproval` gates any workflow.
- **🧠 Cross-run memory (O4)** — `.crew/knowledge.md` injected every run.
- **🎯 Single-agent cliff hedge** — `team plan singleAgent=true`.

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

> **Split-scope install note (v0.8.11+):** pi installs extensions under
> `~/.pi/agent/npm/node_modules/<ext>/`, separate from pi's own
> node_modules tree (nvm / `%APPDATA%\npm` / Volta / fnm). Since v0.8.11
> pi-crew resolves the `@earendil-works/pi-coding-agent` peer dep robustly
> across these layouts — no symlink/NODE_PATH workaround needed. If you ever
> do hit `Cannot find module '@earendil-works/pi-coding-agent'`, set
> `PI_CREW_PEER_DEP_DIR=<path to the pi-coding-agent package dir>` as a
> one-line workaround (or install pi-crew in pi's own scope:
> `npm install -g @earendil-works/pi-crew`).

### Uninstall

`pi uninstall npm:pi-crew` removes the package, but pi doesn't fire an
extension uninstall hook, so two things `team action=init` created are left
behind: the **marker-delimited guidance block in AGENTS.md** and the **`.crew/`
runtime state directory** (run history, artifacts, worktrees). Reverse them
explicitly:

```bash
# 1. (Optional) Preview what would be removed, without writing:
team action=cleanup dryRun=true

# 2. Remove the AGENTS.md guidance block only (.crew/ preserved):
team action=cleanup

# 3. Remove BOTH the guidance block AND the .crew/ state directory (force):
team action=cleanup force=true

# 4. Finally, remove the package itself:
pi uninstall npm:pi-crew
```

The guidance block is wrapped in `<!-- PI-CREW:GUIDANCE:START -->` /
`<!-- PI-CREW:GUIDANCE:END -->` markers, so `team action=cleanup` removes
**only** that block — your own AGENTS.md content is never touched. The
`.crew/` directory is removed **only** with `force=true` (it's irreversible).
The user-scope dir (`~/.pi/agent/extensions/pi-crew/`) is owned by
`pi uninstall` and is never touched by `team action=cleanup`.


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
| User (primary) | `~/.pi/agent/pi-crew.json` |
| User (legacy, still read for migration) | `~/.pi/agent/extensions/pi-crew/config.json` |
| Project (crewRoot) | `.crew/config.json` (or `.pi/teams/config.json` legacy) |
| Project (alt) | `.pi/pi-crew.json` |

### Quick Config

```text
/team-config                           # view all settings
/team-config runtime.mode=scaffold    # set a key (--project for project scope)
/team-config --unset=runtime.mode     # reset a key to default
/team-config --project runtime.mode   # project-scoped view
/team-settings path                   # show config file path
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
| **Observability** | `observability.enabled`, `observability.pollIntervalMs`, `otlp.enabled`/`otlp.endpoint` | opt-in |
| **Worktree** | `worktree.setupHook`, `worktree.linkNodeModules`, `worktree.seedPaths` (mode is set via `workspaceMode: "worktree"` at run time) | disabled by default |

> ⚠️ **Trust boundary**: project config cannot override sensitive execution controls (workers, runtime mode, autonomy, agent overrides). Set those in **user config** only.

📖 Full config reference: [docs/commands-reference.md#team-settings--config-management](docs/commands-reference.md) and [schema.json](schema.json)

---

## Reliability & Trust

### Compaction resilience

pi-crew survives Pi's context compaction. When the context is compacted (auto or manual), in-flight crew runs are detected and a **resume directive** is injected into the post-compaction context, so tasks continue instead of stalling. You'll see a notification like:

```
Context compacted. 1 pi-crew run(s) still in-flight — use team status to continue.
```

### Plan-level human-in-the-loop (HITL)

Set `runtime.requirePlanApproval = true` to gate **any workflow** at the plan→execute boundary. After the read-only (planning) phases complete, the run pauses for explicit approval before mutating tasks run:

```
team api op=approve-plan runId=<runId>   # approve → execute
  team api op=cancel-plan runId=<runId>    # cancel
```

This is plan-level (not per-step) — per-step gates would kill the parallelism that's pi-crew's point.

### Cross-run memory (`.crew/knowledge.md`)

Create `.crew/knowledge.md` in your project root with durable learnings (code style, test commands, common pitfalls, past refactors). It's auto-read (up to 16KB) and injected into **every** agent's system prompt — the main session and each crew worker. pi-crew gets better the longer you use it.

```markdown
# Project Knowledge
- Tests: run with `npm test` (not jest directly)
- Style: tabs, not spaces
- Auth refactor (2026-06): split auth.ts into session.ts + api.ts
```

### Cost visibility

Every `team summary <runId>` includes a per-role cost report:

```
═══ Cost Report ═══
Tokens: 134k (in 112k, out 5.7k, cache-write 16k)
Cost: $0.7700 across 18 turn(s)
By role:
  executor (2 tasks): $0.6100 — 79%, 98k tok, 13 turns
  reviewer (1 task): $0.1100 — 14%, 23k tok, 3 turns
```

### Single-agent mode (cliff hedge)

Any workflow can run single-agent instead of multi-agent — composing all phases into one sequential prompt:

```
team plan team=default workflow=default goal="..." singleAgent=true
```

This is pi-crew's cliff-resilient mode: the workflow definitions, phase structure, and artifact contracts survive even if a single large-context model outperforms multi-agent teams.

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
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common errors, recovery, and error-code reference (E001–E012) |
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
