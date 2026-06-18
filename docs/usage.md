# pi-crew Usage

## Config

Optional config path:

```text
~/.pi/agent/pi-crew.json
```

A **legacy** path `~/.pi/agent/extensions/pi-crew/config.json` is also read for
backward-compatibility migration — values there are merged but the new path
above is preferred. A project-local config may also live at `.pi/pi-crew.json`
in your repo root (project values are merged under the user config).

Create a default config:

```bash
node ./pi-crew/install.mjs
```

Supported fields:

```json
{
  "asyncByDefault": false,
  "executeWorkers": true,
  "notifierIntervalMs": 5000,
  "requireCleanWorktreeLeader": true,
  "autonomous": {
    "profile": "suggested",
    "enabled": true,
    "injectPolicy": true,
    "preferAsyncForLongTasks": false,
    "allowWorktreeSuggestion": true
  },
  "runtime": {
    "mode": "auto",
    "groupJoin": "smart",
    "groupJoinAckTimeoutMs": 300000,
    "completionMutationGuard": "warn",
    "requirePlanApproval": false
  },
  "ui": {
    "widgetPlacement": "aboveEditor",
    "widgetMaxLines": 8,
    "powerbar": true,
    "dashboardPlacement": "center",
    "dashboardWidth": 72,
    "dashboardLiveRefreshMs": 1000,
    "autoOpenDashboard": false,
    "autoOpenDashboardForForegroundRuns": false,
    "showModel": true,
    "showTokens": true,
    "showTools": true
  },
  "limits": {
    "maxConcurrentWorkers": 4
  },
  "reliability": {
    "autoRetry": false,
    "autoRecover": false,
    "deadletterThreshold": 3,
    "retryPolicy": {
      "maxAttempts": 3,
      "backoffMs": 1000,
      "jitterRatio": 0.3,
      "exponentialFactor": 2
    }
  }
}
```

## Local Pi smoke test

```bash
cd pi-crew
npm run smoke:pi
```

Then open Pi and run:

```text
/team-doctor
/team-validate
/team-autonomy status
```

## Default run: real worker execution

By default, `pi-crew` launches each task as a separate child Pi worker process. The parent Pi session orchestrates; workers execute independently and stream output to durable run state.

```json
{
  "action": "run",
  "team": "default",
  "goal": "Implement login with tests"
}
```

## Scaffold / dry run

Use scaffold mode only when you want durable prompts/artifacts without launching child workers.

```json
{
  "action": "run",
  "team": "default",
  "goal": "Plan only",
  "config": {
    "runtime": { "mode": "scaffold" }
  }
}
```

## Async run

```json
{
  "action": "run",
  "team": "implementation",
  "goal": "Refactor auth module",
  "async": true
}
```

Check status:

```json
{
  "action": "status",
  "runId": "team_..."
}
```

Background `Agent`/`crew_agent` subagents wake the parent Pi session when they complete, so the parent can call `get_subagent_result`/`crew_agent_result` and continue without waiting for another user prompt.

## State and API safety

State paths are validated before read/write operations. Run ids, imported bundles, artifact and transcript references, mailbox files, and agent control/log files must stay inside their expected `.crew` roots and symlink escapes are rejected. Read-only mailbox APIs return default state without creating mailbox files when no messages exist.

Group-join result delivery uses the normal outbox mailbox and normal `/team-api ... ack-message`. `runtime.groupJoinAckTimeoutMs` only emits observability (`agent.group_join.ack_timeout`) and does not block run completion.

`runtime.completionMutationGuard` defaults to `warn`. Use `off` to disable or `fail` to fail implementation-style workers that complete without observed mutation tool calls.

## Worktree mode

```json
{
  "action": "run",
  "team": "implementation",
  "goal": "Refactor API layer",
  "workspaceMode": "worktree"
}
```

The leader repository must be clean. Per-task worktrees are created under the project crew root (`.crew/` for new projects, `.pi/teams/` when the repo already has `.pi/`):

```text
<crewRoot>/worktrees/{runId}/{taskId}
```

Cleanup:

```json
{
  "action": "cleanup",
  "runId": "team_..."
}
```

Dirty worktrees are preserved unless `force: true` is provided.

## Slash commands

```text
/teams
/team-run default "Implement login with tests"
/team-run --team=implementation --workflow=implementation --async "Refactor auth"
/team-cancel team_...
/team-run --worktree default "Change API safely"
/team-status team_...
/team-summary team_...
/team-resume team_...
/team-events team_...
/team-artifacts team_...
/team-worktrees team_...
/team-cleanup team_...
/team-forget team_... --confirm
/team-export team_...
/team-import .crew/artifacts/team_.../export/run-export.json   # or .pi/teams/artifacts/... on legacy layout
/team-imports
/team-prune --keep=20 --confirm
/team-manager
/team-dashboard
/team-api team_... read-mailbox direction=outbox
/team-api team_... send-message direction=outbox taskId=task_... to=worker body="hello"
/team-api team_... validate-mailbox repair=true
/team-init
/team-init --copy-builtins
/team-config
/team-config autonomous.profile=assisted autonomous.preferAsyncForLongTasks=true --project
/team-config --unset=autonomous.preferAsyncForLongTasks --project
/team-autonomy status
/team-autonomy on
/team-autonomy off
/team-autonomy manual
/team-autonomy suggested
/team-autonomy assisted
/team-autonomy aggressive
/team-validate
/team-help
/team-doctor
```

## Management

Create resources:

```json
{
  "action": "create",
  "resource": "team",
  "config": {
    "name": "Backend Team",
    "description": "Backend work",
    "scope": "project",
    "defaultWorkflow": "default",
    "roles": [{ "name": "executor", "agent": "executor" }]
  }
}
```

Rename an agent and update team references:

```json
{
  "action": "update",
  "resource": "agent",
  "agent": "worker",
  "scope": "project",
  "updateReferences": true,
  "config": { "name": "better-worker" }
}
```

Delete requires confirmation:

```json
{
  "action": "delete",
  "resource": "team",
  "team": "backend-team",
  "scope": "project",
  "confirm": true
}
```
