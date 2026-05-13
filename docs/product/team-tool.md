# Team Tool API

## Behavior

The `team` tool is the primary interface for users to interact with pi-crew.

### Actions

| Action | Description |
|--------|-------------|
| `run` | Start a team run |
| `plan` | Create a plan without executing |
| `status` | Check run/task status |
| `list` | List teams, agents, workflows |
| `get` | Get resource details |
| `cancel` | Cancel a running task/run |
| `resume` | Resume a paused run |
| `respond` | Respond to a waiting task |
| `recommend` | Get team/workflow recommendations |
| `create/update/delete` | Manage resources |
| `doctor` | Diagnose configuration issues |

### Parameters

- `action` (required): The action to perform
- `team`: Team name for run operations
- `goal`: High-level objective
- `runId`: Run ID for status/cancel/resume
- `taskId`: Task ID for respond operations
- `confirm: true`: Required for destructive actions

### Safety Rules

- Delete operations require `confirm: true`
- Referenced resources blocked unless `force: true`
- Cancel requires explicit run ID
- Respond requires task ID + message
