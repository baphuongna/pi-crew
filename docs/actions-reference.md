# pi-crew — Tool Actions Reference

The `team` tool is the primary tool that pi-crew registers with Pi. All operations go through `action`.

## Quick Reference

| Action | Purpose | When to use |
|--------|---------|-------------|
| `recommend` | Suggest a suitable team/workflow | Starting point when unsure what to pick |
| `run` | Create a run and execute a workflow | Main operation |
| `parallel` | Fan out independent tasks as concurrent runs | When you need N truly concurrent agents |
| `plan` | Preview a workflow without running tasks | Dry-run planning |
| `orchestrate` | Execute from a plan document | Automate a plan |
| `schedule` | Schedule recurring runs | Periodic automation |
| `scheduled` | List scheduled jobs | View schedules |
| `anchor` | Cross-run session anchoring | Persist context across runs |
| `auto-summarize` | Control auto-summarization of long runs | Manage context summarization |
| `auto_boomerang` | Toggle auto-summarize (shorthand) | Quick on/off |
| `status` | Read run status | Track progress |
| `summary` | Read/write run summary artifact | Summarize |
| `cancel` | Cancel queued/running work | Stop a run |
| `resume` | Re-queue failed/cancelled tasks | Resume a run |
| `retry` | Retry specific failed/cancelled task(s) | Retry a task without full resume |
| `wait` | Block until a run finishes (with timeout) | Synchronous wait |
| `steer` | Queue an interrupting message to an active task | Redirect in-flight work |
| `respond` | Reply to a waiting task and re-queue it | Interactive task Q&A |
| `list` | List teams, agents, workflows, runs | Explore resources |
| `get` | Inspect agent/team/workflow | View details |
| `onboard` | Show team onboarding guide | Learn a team's roles/flow |
| `search` | BM25-ranked agent/team discovery | Smart search |
| `events` | Read the event log | Debug/audit |
| `artifacts` | List run artifacts | View outputs |
| `worktrees` | List run worktree metadata | Inspect worktrees |
| `graph` | Load/save/list run graphs | Visualization |
| `explain` | Explain a run or task structure | Understand a run |
| `cache` | Run/skill cache stats or cached-run lookup | Inspect caches |
| `checkpoint` | Read a task's saved checkpoint | Inspect task progress |
| `cleanup` | Delete run worktrees | Cleanup |
| `forget` | Delete run state/artifacts | Remove entirely (requires `confirm`) |
| `prune` | Delete multiple old finished runs | Bulk cleanup |
| `invalidate` | Drop a run's snapshot cache | Force fresh reads |
| `export` | Export a portable run bundle | Share/backup |
| `import` | Import a run bundle | Receive a run from elsewhere |
| `imports` | List imported bundles | View imports |
| `create` | Create an agent/team/workflow | Extend resources |
| `update` | Update an agent/team/workflow | Edit resources |
| `delete` | Delete an agent/team/workflow | Remove resources (requires `confirm`) |
| `validate` | Validate resources | Health check |
| `doctor` | Check readiness | Diagnose environment |
| `health` | Watchdog health monitor across all runs | Diagnose stuck/zombie runs |
| `config` | Show/update config (raw JSON) | Configuration |
| `settings` | View/set config via dotted-path keys | Human-readable settings |
| `init` | Initialize project layout | Initial setup |
| `autonomy` | Manage delegation settings | Adjust automation |
| `api` | Safe interop for state operations | Advanced integration |
| **`goal`** | **v0.9.0** Autonomous goal loop (worker → LLM judge → feedback → iterate) | Autonomous multi-turn |
| **`workflow-create`** | **v0.9.0** Create a `.dwf.ts` (requires `confirm:true`, ACE-gated) | Author dynamic workflow |
| **`workflow-get`** | **v0.9.0** View source + metadata of a dynamic workflow | Inspect `.dwf.ts` |
| **`workflow-list`** | **v0.9.0** List static + dynamic workflows | Discover workflows |
| **`workflow-save`** | **v0.9.0** Overwrite `.dwf.ts` source (requires `confirm:true`) | Update dynamic workflow |
| **`workflow-delete`** | **v0.9.0** Delete a `.dwf.ts` (requires `confirm:true`) | Remove dynamic workflow |
| `help` | Display help text | Help |

---

## Action Details

### `recommend` — Guided suggestions

When you are unsure which team/workflow to use, call `recommend` to get analysis and suggestions:

```json
{
  "action": "recommend",
  "goal": "Refactor auth flow and add tests"
}
```

The response includes:
- The suggested team/workflow
- Fanout hints (how many subagents)
- Whether to use async or worktree mode
- The rationale for the choice

---

### `run` — Execute a workflow

This is the main action. It creates a run manifest, a task graph, and executes it.

#### Basic syntax

```json
{
  "action": "run",
  "team": "default",
  "goal": "Investigate failing tests and propose a fix"
}
```

#### Choose a team

| Team | Purpose |
|------|---------|
| `default` | Balanced, 4 steps: explore → plan → execute → verify |
| `fast-fix` | Small bug fixes: explore → execute → verify |
| `implementation` | Adaptive planner decides fanout on its own |
| `review` | Code review + security review |
| `research` | Research and documentation writing |

#### Run asynchronously (async)

```json
{
  "action": "run",
  "team": "implementation",
  "goal": "Implement user settings screen",
  "async": true
}
```

The run is detached from the session and survives session switches/reloads. pi-crew automatically notifies you when the run completes.

#### Worktree isolation

```json
{
  "action": "run",
  "team": "implementation",
  "goal": "Add API endpoint and tests",
  "workspaceMode": "worktree"
}
```

Each task runs in its own git worktree — safe for the main codebase. Requires a clean repo.

#### Override model

```json
{
  "action": "run",
  "team": "default",
  "goal": "Quick exploration",
  "model": "gpt-4o-mini"
}
```

#### Override config for a run

```json
{
  "action": "run",
  "team": "implementation",
  "goal": "Refactor auth",
  "config": {
    "runtime": { "requirePlanApproval": true },
    "limits": { "maxConcurrentWorkers": 4 }
  }
}
```

#### Plan approval gate

Requires explicit approval after the planner creates the plan, before the executor runs:

```json
{
  "action": "run",
  "team": "implementation",
  "goal": "Major refactor",
  "config": {
    "runtime": { "requirePlanApproval": true }
  }
}
```

Approve:

```json
{
  "action": "api",
  "runId": "team_...",
  "config": { "operation": "approve-plan" }
}
```

Cancel plan:

```json
{
  "action": "api",
  "runId": "team_...",
  "config": { "operation": "cancel-plan" }
}
```

---

### `plan` — Preview a workflow

Like `run` but **does not spawn workers**. Previews the task graph that would be created:

```json
{
  "action": "plan",
  "team": "implementation",
  "goal": "Add authentication module"
}
```

---

### `orchestrate` — Execute from a plan document

Executes a workflow from a plan document that contains tagged sections:

```markdown
# Design Phase
<!-- tag: design -->
Design the authentication system...

# Implementation
<!-- tag: impl -->
Implement the JWT auth...
```

```json
{
  "action": "orchestrate",
  "planPath": "./plan.md"
}
```

TAG→chain mapping:
- `design` → planner, architect
- `impl` → tdd-guide, lang-reviewer
- `security` → security-reviewer, lang-reviewer
- `build` → build-error-resolver
- `test` → test-engineer, verifier
- `review` → reviewer

---

### `schedule` — Schedule recurring runs

Creates a scheduled job using cron, interval, or once:

```json
{
  "action": "schedule",
  "team": "review",
  "goal": "Weekly security review",
  "cron": "0 9 * * MON"
}
```

Params: `cron`, `interval` (ms), `once` (ISO timestamp)

---

### `scheduled` — List scheduled jobs

```json
{
  "action": "scheduled"
}
```

---

### `graph` — Load/save/list run graphs

```json
{
  "action": "graph",
  "runId": "team_..."
}
```

---

### `search` — BM25-ranked discovery

Search agents/teams/workflows with BM25 ranking:

```json
{
  "action": "search",
  "goal": "security audit"
}
```

---

### `status` — Run status

```json
{
  "action": "status",
  "runId": "team_..."
}
```

Output includes: manifest, tasks, agents, timing, usage totals.

---

### `summary` — Run summary

Read summary:

```json
{
  "action": "summary",
  "runId": "team_..."
}
```

Write summary:

```json
{
  "action": "summary",
  "runId": "team_...",
  "message": "Implemented auth with tests. All passing."
}
```

---

### `cancel` — Cancel a run

```json
{
  "action": "cancel",
  "runId": "team_..."
}
```

Cancels all queued/running tasks. Running child processes receive SIGTERM.

---

### `resume` — Resume a run

```json
{
  "action": "resume",
  "runId": "team_..."
}
```

Re-queues failed/cancelled/skipped tasks. Already-completed tasks are unaffected.

---

### `list` — List resources

```json
{
  "action": "list"
}
```

Displays: discovered teams, agents, workflows, and recent runs.

---

### `get` — Inspect resource details

```json
{
  "action": "get",
  "resource": "agent",
  "agent": "executor"
}
```

---

### `events` — Event log

```json
{
  "action": "events",
  "runId": "team_..."
}
```

Append-only JSONL events: task.started, task.completed, run.blocked, etc.

---

### `artifacts` — Run outputs

```json
{
  "action": "artifacts",
  "runId": "team_..."
}
```

---

### `worktrees` — Worktree metadata

```json
{
  "action": "worktrees",
  "runId": "team_..."
}
```

---

### `cleanup` — Delete worktrees

```json
{
  "action": "cleanup",
  "runId": "team_..."
}
```

Dirty worktrees are kept unless `force: true`.

---

### `forget` — Delete a run entirely

```json
{
  "action": "forget",
  "runId": "team_...",
  "confirm": true
}
```

Deletes state + artifacts + worktrees. Requires `confirm: true`.

---

### `prune` — Delete old runs

```json
{
  "action": "prune",
  "confirm": true,
  "keep": 10
}
```

Keeps the `keep` most recent runs and deletes the rest.

---

### `export` / `import` — Share runs

Export:

```json
{
  "action": "export",
  "runId": "team_..."
}
```

Import:

```json
{
  "action": "import",
  "path": "/path/to/run-export.json"
}
```

User-global import:

```json
{
  "action": "import",
  "path": "/path/to/run-export.json",
  "scope": "user"
}
```

List imports:

```json
{
  "action": "imports"
}
```

---

### `create` — Create resources

Create an agent:

```json
{
  "action": "create",
  "resource": "agent",
  "config": {
    "scope": "project",
    "name": "api-reviewer",
    "description": "Reviews backend API changes",
    "systemPrompt": "You review backend API changes for correctness and compatibility.",
    "triggers": ["api", "endpoint", "contract"],
    "useWhen": ["backend API change", "OpenAPI contract update"],
    "avoidWhen": ["documentation-only edits"],
    "cost": "cheap",
    "category": "backend"
  }
}
```

Create a team:

```json
{
  "action": "create",
  "resource": "team",
  "config": {
    "name": "backend-team",
    "description": "Backend implementation team",
    "scope": "project",
    "defaultWorkflow": "default",
    "roles": [
      { "name": "explorer", "agent": "explorer" },
      { "name": "executor", "agent": "executor" },
      { "name": "verifier", "agent": "verifier" }
    ]
  }
}
```

Create a workflow:

```json
{
  "action": "create",
  "resource": "workflow",
  "config": {
    "name": "quick-review",
    "scope": "user",
    "steps": [
      { "id": "review", "role": "reviewer", "prompt": "Review: {goal}" },
      { "id": "verify", "role": "verifier", "dependsOn": "review", "verify": true, "prompt": "Verify the review findings." }
    ]
  }
}
```

---

### `update` — Update resources

```json
{
  "action": "update",
  "resource": "agent",
  "agent": "worker",
  "scope": "project",
  "updateReferences": true,
  "config": { "name": "better-worker", "description": "Improved worker agent" }
}
```

`updateReferences: true` automatically updates all team references pointing to the old name.

---

### `delete` — Delete resources

```json
{
  "action": "delete",
  "resource": "team",
  "team": "backend-team",
  "scope": "project",
  "confirm": true
}
```

Creates a backup automatically before deleting.

---

### `validate` — Validate resources

```json
{
  "action": "validate"
}
```

Checks: agents, teams, workflows, references, model hints.

---

### `doctor` — Diagnose environment

```json
{
  "action": "doctor"
}
```

Checks: cwd, platform, Node.js, Pi version, git, state paths, config, resources, model/provider.

Smoke test child Pi (explicit):

```json
{
  "action": "doctor",
  "config": { "smokeChildPi": true }
}
```

---

### `api` — Advanced state interop

Safe API for run/task/event/heartbeat/claim/mailbox operations:

```text
/team-api <runId> <operation> [key=value]
```

Operations:

| Operation | Description |
|-----------|-------------|
| `read-manifest` | Read the manifest |
| `list-tasks` | List tasks |
| `read-task` | Read a task (requires `taskId=`) |
| `read-events` | Read the event log |
| `read-heartbeat` | Read a heartbeat (requires `taskId=`) |
| `write-heartbeat` | Write a heartbeat (requires `taskId=`, `alive=`) |
| `claim-task` | Claim a task (requires `taskId=`, `owner=`) |
| `release-task-claim` | Release a claim |
| `transition-task-status` | Transition task status |
| `send-message` | Send a mailbox message |
| `read-mailbox` | Read the mailbox |
| `ack-message` | Acknowledge a message |
| `read-delivery` | Read delivery state |
| `validate-mailbox` | Validate/repair mailbox |
| `approve-plan` | Approve a plan (when requirePlanApproval) |
| `cancel-plan` | Cancel a plan |

---

### `config` — Configuration

View current config:

```json
{ "action": "config" }
```

Update user config:

```json
{
  "action": "config",
  "config": { "asyncByDefault": true }
}
```

Unset:

```json
{
  "action": "config",
  "config": { "autonomous.preferAsyncForLongTasks": "unset" }
}
```

---

### `init` — Initialize project

```json
{ "action": "init" }
```

Copy builtins:

```json
{ "action": "init", "config": { "copyBuiltins": true, "overwrite": true } }
```

---

### `autonomy` — Delegation settings

```json
{ "action": "autonomy" }
```

Profiles: `manual`, `suggested`, `assisted`, `aggressive`.

---

## Additional Actions (Run domain)

### `parallel` — Fan out independent tasks

Spawns an array of independent tasks as concurrent background agents. Use this when you need N truly concurrent workers in a single call (e.g. parallel research or review). Max concurrency is 8.

```json
{
  "action": "parallel",
  "config": {
    "tasks": [
      { "goal": "Audit auth module for CVEs", "agent": "explorer" },
      { "goal": "Audit payment module for CVEs", "agent": "explorer" }
    ],
    "concurrency": 4,
    "team": "fast-fix"
  }
}
```

Params:

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `config.tasks` | `Array<{ goal, agent? }>` | — | **Required.** Each entry becomes a concurrent run. |
| `config.concurrency` | `number` | `4` | Clamped to `1..8`. |
| `config.team` | `string` | `fast-fix` | Team whose workflow is used for each task. |

Each task launches its own run; the host agent does not need to emit one
`Agent()` call per turn.

---

### `retry` — Retry specific failed task(s)

Re-queues `failed` / `cancelled` tasks so the scheduler picks them up again.
Unlike `resume` (which re-queues *all* non-terminal tasks), `retry` can target a
single task via `taskId`. Runs the `before_retry` hook before mutating state.

```json
{
  "action": "retry",
  "runId": "team_..."
}
```

Retry a single task:

```json
{
  "action": "retry",
  "runId": "team_...",
  "taskId": "03_execute"
}
```

Params:

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `runId` | `string` | — | **Required.** |
| `taskId` | `string` | — | Retry only this task; omit to retry all failed/cancelled. |
| `force` | `boolean` | `false` | Override cross-session ownership check. |

---

### `wait` — Block until a run finishes

Synchronously waits (polling) until the run reaches a terminal status, then
returns the result. Useful when a foreground caller must block on an async run.

```json
{
  "action": "wait",
  "runId": "team_...",
  "config": { "timeoutMs": 300000, "pollIntervalMs": 2000 }
}
```

Params:

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `runId` | `string` | — | **Required.** |
| `config.timeoutMs` | `number` | `300000` | Clamped to `1000..3_600_000` (1 s – 1 h). |
| `config.pollIntervalMs` | `number` | `2000` | Clamped to `500..60_000`. |

Returns `status: "error"` when the run finished as `failed`.

---

### `steer` — Interrupt an active task

> ⚠️ **Internal / experimental.** Queues a steering message that is delivered to
> a task's worker session on its next turn. The message is appended to
> `pendingSteers` and also written to a live steering file for immediate delivery.
>
> **Note (Phase 1.3, 2026-08-14):** the agent-level tools `steer_subagent` /
> `crew_agent_steer` are **planned, not implemented** — they return a
> `steer.unavailable` stub because the subagent record has no `taskId` linkage
> to the live run's steering file. Use this `team action=steer`
> (`runId` + `taskId` + `message`) for the working run-level steering path.

```json
{
  "action": "steer",
  "runId": "team_...",
  "taskId": "01_explore",
  "message": "Focus only on src/ — ignore docs/"
}
```

Params:

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `runId` | `string` | — | **Required.** |
| `taskId` | `string` | — | **Required.** Must be a non-terminal task. |
| `message` | `string` | — | **Required.** The steering instruction. |

The pending-steers queue is capped at 100 entries (oldest dropped with an
audit event). Terminal tasks cannot be steered.

---

## Additional Actions (Control domain)

### `respond` — Reply to a waiting task

Sends a message to a task in `waiting` status and re-queues it for the durable
scheduler. Used for interactive task Q&A (e.g. a worker that paused to ask a
clarifying question).

```json
{
  "action": "respond",
  "runId": "team_...",
  "taskId": "05_verify",
  "message": "Yes, use the Postgres dialect."
}
```

Params:

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `runId` | `string` | — | **Required.** |
| `taskId` | `string` | — | Target a specific waiting task; omit to respond to all waiting. |
| `message` | `string` | — | The reply body. |
| `force` | `boolean` | `false` | Override cross-session ownership check. |

If no tasks are `waiting`, the response hints at `api operation=follow-up-agent`
(continuation) or `api operation=steer-agent` (interrupt).

---

### `invalidate` — Drop a run's snapshot cache

> ⚠️ **Internal / experimental.** Discards the cached run snapshot for a run so
> subsequent reads rebuild it from disk. Use after external state mutations that
> bypass the normal write path.

```json
{
  "action": "invalidate",
  "runId": "team_..."
}
```

Params:

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `runId` | `string` | — | **Required.** |

Requires the in-process snapshot cache (only available within a live Pi
session that has the cache wired up).

---

## Additional Actions (Status domain)

### `onboard` — Team onboarding guide

Prints a human-readable guide describing a team's roles, workflow, and expected
flow — helpful when adopting a new team.

```json
{ "action": "onboard", "team": "implementation" }
```

Params:

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `team` | `string` | `default` | The team to onboard. |

---

### `explain` — Explain a run or task

Produces a structured explanation of a run (status, duration, task table) or,
when `taskId` is given, a single-task breakdown (role, layer, why it exists,
files touched, connected tasks, complexity).

```json
{ "action": "explain", "runId": "team_..." }
```

Explain one task:

```json
{ "action": "explain", "runId": "team_...", "taskId": "02_plan" }
```

Params:

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `runId` | `string` | — | **Required.** |
| `taskId` | `string` | — | Omit to explain the whole run. |

---

### `cache` — Cache stats or cached-run lookup

> ⚠️ **Internal / experimental.** With a `goal`, looks up a previously cached run
> by goal/team/workflow hash. Without a `goal`, reports run-cache and skill-cache
> statistics (entries, size, hit rate, evictions).

```json
{ "action": "cache" }
```

Lookup a cached run:

```json
{
  "action": "cache",
  "goal": "Investigate failing tests",
  "team": "default",
  "workflow": "default"
}
```

Params:

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `goal` | `string` | — | Omit to show cache stats; provide to look up a cached run. |
| `team` | `string` | `default` | Used in the cache key when `goal` is set. |
| `workflow` | `string` | `default` | Used in the cache key when `goal` is set. |

---

### `checkpoint` — Read a task's saved checkpoint

Loads a previously saved checkpoint for a task (step, progress, saved-at
timestamp). Checkpoints are written during long-running tasks for resume
support.

```json
{
  "action": "checkpoint",
  "runId": "team_...",
  "taskId": "07_build"
}
```

Params:

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `runId` | `string` | — | **Required.** |
| `taskId` | `string` | — | **Required.** |

---

### `health` — Watchdog health monitor

> ⚠️ **Internal / experimental.** Scans all known runs and classifies them by
> status, surfacing stuck tasks (heartbeat stale > 5 min), zombie workspaces,
> ghost processes, orphaned temp dirs, and corrupted state. Returns a counts
> summary (`total`, `running`, `completed`, `failed`, `blocked`, `queued`,
> `planning`, `waiting`, `stuck`, `zombie`, `ghost`, `orphaned`, `corrupted`).

```json
{ "action": "health" }
```

No parameters. This is an auto-monitored watchdog diagnostic — prefer `doctor`
for environment readiness checks.

---

## Additional Actions (Manage domain)

### `settings` — View/set config via dotted-path keys

A richer, human-readable interface to configuration. Unlike `config` (which
returns the raw merged JSON), `settings` supports dotted-path `get`/`set`/`unset`,
a flattened effective-settings listing, a schema reference, config-path
display, and live Pi-UI theme switching.

```json
{ "action": "settings", "config": { "args": "list" } }
```

Set a value:

```json
{
  "action": "settings",
  "config": { "args": "set runtime.mode scaffold", "scope": "project" }
}
```

Commands (passed via `config.args`):

| Command | Description |
|---------|-------------|
| `list` | Show all effective config values (default). |
| `json` | Dump full effective config as JSON. |
| `schema` | List all known config keys (✓ = currently set). |
| `paths` | Show user + project config file paths. |
| `get <key>` | Get a specific dotted-path value. |
| `set <key> <value>` | Set a value (JSON-parsed; scope via `config.scope`). |
| `unset <key>` | Remove a value. |
| `scope [user\|project]` | Show/change the write scope for `set`/`unset`. |
| `themes` | Browse the Pi UI theme gallery. |
| `theme <name>` | Switch the Pi UI theme (applied live). |

> **`settings` vs `config`:** `config` returns/updates the merged JSON object
> directly. `settings` is the dotted-path UI with schema hints, theme
> management, and fuzzy key suggestions — use it for interactive exploration.

---

## Additional Actions (Automate domain)

### `anchor` — Cross-run session anchoring

Persists a named context anchor for the current session so it survives across
runs and compactions. Sub-actions are selected via `config.subAction`.

```json
{ "action": "anchor", "config": { "subAction": "status" } }
```

Set an anchor:

```json
{
  "action": "anchor",
  "config": { "subAction": "set", "context": { "refactor": "auth-split" } }
}
```

Sub-actions:

| `subAction` | Description |
|-------------|-------------|
| `status` (default) | Show current anchors for the session. |
| `set` | Create an anchor (accepts `config.context` object or `config.key`). |
| `clear` | Remove an anchor (by `config.anchorId`, or all if omitted). |
| `accumulate` | Append to an existing anchor's context. |

---

### `auto-summarize` — Auto-summarization control

Controls automatic context summarization for long-running sessions. When
enabled, the worker's context is summarized once the token count or tool-use
count crosses a threshold. Sub-actions via `config.subAction`.

```json
{ "action": "auto-summarize", "config": { "subAction": "status" } }
```

Enable and configure:

```json
{
  "action": "auto-summarize",
  "config": {
    "subAction": "on",
    "threshold": 8000,
    "minToolsUsed": 10,
    "collapseContext": true
  }
}
```

Sub-actions:

| `subAction` | Description |
|-------------|-------------|
| `status` (default) | Show current config + trigger thresholds. |
| `on` | Enable summarization. |
| `off` | Disable summarization. |
| `config` | Update thresholds (`threshold`, `minToolsUsed`, `collapseContext`). |
| `toggle` | Flip enabled state. |

Defaults: `threshold` 5000 tokens, `minToolsUsed` 5, `collapseContext` true.

---

### `auto_boomerang` — Toggle auto-summarize (shorthand)

Shares the same handler as `auto-summarize`; defaults `subAction` to `toggle`
when omitted, providing a quick on/off switch.

```json
{ "action": "auto_boomerang" }
```

Accepts the same `config.subAction` values as `auto-summarize`
(`on`, `off`, `config`, `toggle`, `status`).
