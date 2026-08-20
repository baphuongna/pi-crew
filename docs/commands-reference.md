# pi-crew — Slash Commands Reference

Slash commands are manual actions triggered from the Pi chat. Autonomous tool use via the `team` action is the primary path; slash commands are intended for ops and debugging.

## Main Commands

| Command | Description |
|---------|-------|
| `/teams` | List teams, agents, workflows, and recent runs |
| `/team-run [options] <goal>` | Run a team workflow |
| `/team-cancel <runId>` | Cancel a run |
| `/team-status <runId>` | View status |
| `/team-summary <runId>` | View or write a summary |
| `/team-resume <runId>` | Resume a stopped run |
| `/team-retry <runId>` | Retry a failed run |
| `/team-result <runId>` | Show a task result artifact |
| `/team-respond <taskId> <message>` | Respond to a waiting worker task |
| `/team-follow-up [options]` | Manage follow-up notifications |
| `/team-events <runId>` | View the event log |
| `/team-artifacts <runId>` | View artifacts |
| `/team-transcript <runId>` | Open the transcript viewer |
| `/team-worktrees <runId>` | View worktree metadata |
| `/team-cleanup <runId>` | Remove worktrees (interactive menu: `/team-cleanup-menu`) |
| `/team-forget <runId>` | Fully delete a run |
| `/team-prune` | Delete multiple old runs |
| `/team-invalidate [scope]` | Invalidate caches |
| `/team-export <runId>` | Export a run bundle |
| `/team-import <path>` | Import a run bundle |
| `/team-imports` | List imported bundles |
| `/team-api <runId> <op>` | State API interop |
| `/team-metrics [filter]` | View metrics |
| `/team-manager` | Interactive helper |
| `/team-dashboard` | Live dashboard overlay |
| `/team-init [options]` | Initialize the project layout |
| `/team-config [options]` | View or update config |
| `/team-settings <subcmd>` | Manage config keys |
| `/team-autonomy <subcmd>` | Manage delegation |
| `/team-validate` | Validate resources |
| `/team-help` | Help text |
| `/team-doctor` | Diagnose the environment |
| `/team-mascot` | Toggle the mascot overlay |
| **`/team-goal`** | **v0.9.0** Start autonomous goal loop (sub-actions: `start/status/pause/resume/stop/step/clear`) |
| **`/workflows`** | **v0.9.0** List static + dynamic workflows (`.dwf.ts`) |

**Removed (v0.10.1 docs hygiene):** `/team-orchestrate`, `/team-schedule`,
`/team-scheduled`, `/team-search`, `/team-graph` — phantom entries; none of
these slash commands is registered. Their functionality is reachable via the
`team` tool actions (`action: "orchestrate" | "schedule" | "scheduled" |
"search" | "graph"`) instead.

---

## `/team-run` — Details

```text
/team-run <goal>
/team-run --team=implementation <goal>
/team-run --team=default --workflow=default <goal>
/team-run --async <goal>
/team-run --worktree <goal>
```

Options:

| Flag | Description |
|------|-------|
| `--team=<name>` | Select a team (default: `default`) |
| `--workflow=<name>` | Select a workflow (default: the team's defaultWorkflow) |
| `--async` | Run asynchronously |
| `--worktree` | Use worktree isolation |

Examples:

```text
# Run the default team
/team-run Investigate failing tests and propose a fix

# Implementation team, async
/team-run --team=implementation --async Refactor auth module

# Worktree isolation
/team-run --team=implementation --worktree Add API endpoint and tests
```

---

## `/team-forget` — Delete a Run

```text
/team-forget <runId> --confirm        # Delete state + artifacts
/team-forget <runId> --confirm --force # Delete even dirty worktrees
```

⚠️ Requires `--confirm`. Dirty worktrees are kept unless `--force` is also provided.

---

## `/team-prune` — Bulk Cleanup

```text
/team-prune --keep=20 --confirm
```

Keeps the 20 most recent runs and deletes the rest.

---

## `/team-api` — State Operations

```text
/team-api <runId> <operation> [key=value ...]
```

### Read operations

```text
/team-api team_... read-manifest
/team-api team_... list-tasks
/team-api team_... read-task taskId=task_...
/team-api team_... read-events
/team-api team_... read-heartbeat taskId=task_...
/team-api team_... read-mailbox direction=outbox
/team-api team_... read-mailbox taskId=task_... direction=inbox
/team-api team_... read-delivery
```

### Write operations

```text
/team-api team_... write-heartbeat taskId=task_... alive=true
/team-api team_... claim-task taskId=task_... owner=worker-1
/team-api team_... release-task-claim taskId=task_... owner=worker-1 token=...
/team-api team_... transition-task-status taskId=task_... owner=worker-1 token=... status=running
```

### Mailbox operations

```text
/team-api team_... send-message direction=outbox to=worker body="please check this"
/team-api team_... send-message taskId=task_... direction=inbox to=worker body="task scoped"
/team-api team_... ack-message messageId=msg_...
/team-api team_... validate-mailbox repair=true
```

### Plan operations

```text
/team-api team_... approve-plan
/team-api team_... cancel-plan
```

---

## `/team-metrics` — Observability

```text
/team-metrics                          # All metrics
/team-metrics crew.task.*              # Filter by glob pattern
```

---

## `/team-config` — Configuration

```text
/team-config                           # View current config
/team-config asyncByDefault=true       # Update a key
/team-config --unset=key.path          # Unset a key
/team-config ... --project             # Project scope
```

---

## `/team-settings` — Config Management

```text
/team-settings                          # List all keys
/team-settings get limits.maxTurns      # Read a single key
/team-settings set limits.maxTurns 20   # Write a key
/team-settings unset runtime.maxTurns   # Reset to default
/team-settings path                     # Path to the config file
/team-settings scope                    # Current scope (user/project)
```

### Supported Keys

| Key | Type | Default | Description |
|-----|------|---------|-------|
| `asyncByDefault` | boolean | `false` | Run async by default |
| `executeWorkers` | boolean | `true` | Spawn child Pi workers |
| `notifierIntervalMs` | number | `5000` | Polling interval for async notifications |
| `runtime.mode` | string | `"auto"` | Runtime: `auto`, `scaffold`, `child-process`, `live-session` |
| `runtime.maxTurns` | number | — | Max turns per worker |
| `runtime.graceTurns` | number | — | Grace turns after max |
| `runtime.inheritContext` | boolean | — | Workers inherit parent context |
| `runtime.promptMode` | string | — | `replace` or `append` |
| `runtime.groupJoin` | string | `"smart"` | Group join: `off`, `group`, `smart` |
| `runtime.groupJoinAckTimeoutMs` | number | `300000` | Group join ack timeout (ms) |
| `runtime.requirePlanApproval` | boolean | `false` | Require approving the plan before execution |
| `runtime.completionMutationGuard` | string | `"warn"` | `off`, `warn`, `fail` |
| `runtime.modelFallback.maxAutoFallbacks` | number | — | Cap auto-appended fallback models (default: unbounded) |
| `runtime.modelFallback.order` | string | `"parentFirst"` | `parentFirst` (same provider first) or `asIs` (catalogue order) |
| `runtime.modelFallback.requireCredentials` | boolean | `false` | Drop models whose provider has no discoverable credential |
| `runtime.modelFallback.quotaAwareOrdering` | boolean | `true` | Deprioritize providers near rate-limit/quota |
| `runtime.modelFallback.defaultSubagentModel` | string | — | Default model when neither caller nor agent specifies one |
| `limits.maxConcurrentWorkers` | number | `1024` | Max workers running in parallel |
| `limits.maxTaskDepth` | number | `100` | Max task tree depth |
| `limits.maxChildrenPerTask` | number | — | Max children per task |
| `limits.maxRunMinutes` | number | `1440` | Max run duration (minutes) |
| `limits.maxRetriesPerTask` | number | `100` | Max retries per task |
| `limits.maxTasksPerRun` | number | `10000` | Max tasks per run |
| `limits.heartbeatStaleMs` | number | `86400000` | Heartbeat stale threshold |
| `control.enabled` | boolean | — | Enable the agent control-plane |
| `control.needsAttentionAfterMs` | number | — | Attention timeout |
| `autonomous.profile` | string | `"suggested"` | `manual`, `suggested`, `assisted`, `aggressive` |
| `autonomous.injectPolicy` | boolean | `true` | Inject policy into the prompt |
| `autonomous.preferAsyncForLongTasks` | boolean | `false` | Auto-async for long tasks |
| `autonomous.allowWorktreeSuggestion` | boolean | `true` | Suggest worktree mode |
| `tools.enableClaudeStyleAliases` | boolean | `true` | Enable Claude-style aliases |
| `tools.enableSteer` | boolean | `true` | Enable the steer tool |
| `tools.terminateOnForeground` | boolean | `false` | Return terminate from a foreground Agent |
| `agents.disableBuiltins` | boolean | `false` | Disable builtin agents |
| `observability.enabled` | boolean | `false` | Enable metrics collection |
| `observability.pollIntervalMs` | number | — | Metrics poll interval |
| `otlp.enabled` | boolean | `false` | Enable the OTLP exporter |
| `otlp.endpoint` | string | — | OTLP endpoint URL |
| `worktree.setupHook` | string | — | Worktree setup hook command |
| `worktree.linkNodeModules` | boolean | — | Symlink node_modules into the worktree |
| `worktree.seedPaths` | array | — | Extra paths to seed into the worktree |

---

## `/team-autonomy` — Delegation Policy

```text
/team-autonomy status                   # View status
/team-autonomy on                       # Enable autonomous delegation
/team-autonomy off                      # Disable
/team-autonomy manual                   # Profile: manual
/team-autonomy suggested                # Profile: suggested (default)
/team-autonomy assisted                 # Profile: assisted
/team-autonomy aggressive               # Profile: aggressive
```

Options:

```text
/team-autonomy suggested --prefer-async          # Auto-async for long tasks
/team-autonomy suggested --no-worktree-suggest   # Do not suggest worktree
```

### Autonomy Profiles

| Profile | Behavior |
|---------|---------|
| `manual` | No automatic delegation. Runs only when the host agent calls the team tool directly |
| `suggested` | Suggests when appropriate; the host agent decides (default) |
| `assisted` | Proactively delegates most complex tasks |
| `aggressive` | Always delegates, maximizing parallel execution |

---

## `/team-init` — Project Setup

```text
/team-init                             # Initialize the basic layout
/team-init --copy-builtins             # Copy builtin resources into the project
/team-init --copy-builtins --overwrite # Copy and overwrite
```

Creates directories:

```text
# New projects (.crew/ layout)
.crew/agents/
.crew/teams/
.crew/workflows/
.crew/imports/

# Legacy (.pi/ layout, when .pi/ already exists)
.pi/teams/agents/
.pi/teams/teams/
.pi/teams/workflows/
.pi/teams/imports/
```

---

## `/team-dashboard` — Live Dashboard

```text
/team-dashboard
```

### Keyboard Shortcuts

| Key | Action |
|-----|-----------|
| `↑`/`↓` or `j`/`k` | Select a run |
| `r` | Reload the run list |
| `p` | Toggle short/long progress |
| `Enter` or `s` | View status |
| `a` | View artifacts |
| `u` | View summary |
| `i` | API read-manifest |
| `q` or `Esc` | Close |
| `1`–`7` | Pane: agents / progress / mailbox / output / health / metrics / **plan** (v0.10.1, `PI_CREW_PLAN_UI=1`) |
| `A` / `n` | Plan approval approve/deny (progress + plan panes, while pending) |
| `X` | Plan revision diff (plan pane) |

---

## `/team-manager` — Interactive Helper

```text
/team-manager
```

Flows:
- List resources/runs
- Run a team
- View run status
- Cleanup worktrees
- Create/edit agent/team resources
- Doctor check

---

## `/team-validate` — Resource Validation

```text
/team-validate
```

Checks:
- Valid agents, teams, and workflows
- Correct references (the agent exists in team roles)
- Valid model hints
- Properly formatted workflow steps

---

## `/team-doctor` — Environment Check

```text
/team-doctor
```

Checks:
- cwd, platform, architecture
- Node.js version
- `pi --version`
- `git --version`
- State paths are writable
- Config parsing
- Discovery counts (agents, teams, workflows)
- Resource validation
- Current model/provider
- Model/fallback hints

Child Pi smoke test (explicit):

```text
/team-api team_... doctor smokeChildPi=true
```

or via the tool:

```json
{
  "action": "doctor",
  "config": { "smokeChildPi": true }
}
```
