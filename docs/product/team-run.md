# Team Run

## Behavior

A team run executes a workflow with multiple agents, tracking progress through
durable state on disk.

### Lifecycle

1. User invokes `team action='run'` with a goal
2. Team runner creates a manifest, resolves team/workflow
3. Task graph is built from workflow steps
4. Tasks execute (parallel or sequential per workflow)
5. Results are collected, artifacts written
6. Run completes with final status

### Statuses

| Status | Meaning |
|--------|---------|
| pending | Manifest created, not yet executing |
| running | Tasks executing |
| completed | All tasks finished successfully |
| failed | One or more tasks failed |
| cancelled | User cancelled the run |
| partial | Some tasks completed, others still pending |

### Concurrency

- Tasks without dependencies run in parallel (up to concurrency limit)
- Tasks with `dependsOn` wait for predecessors
- Workflow phases enforce ordering

### Artifacts

- `results/{taskId}.txt` — task output
- `logs/{taskId}.log` — full transcript
- `metadata/` — task metadata files
- `shared/` — inter-agent shared context
