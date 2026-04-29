# pi-crew Usage

## Config

Optional config path:

```text
~/.pi/agent/extensions/pi-crew/config.json
```

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
  "ui": {
    "widgetPlacement": "aboveEditor",
    "widgetMaxLines": 8,
    "powerbar": true,
    "dashboardPlacement": "right",
    "dashboardWidth": 56,
    "dashboardLiveRefreshMs": 1000,
    "autoOpenDashboard": false,
    "autoOpenDashboardForForegroundRuns": true,
    "showModel": true,
    "showTokens": true,
    "showTools": true
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
