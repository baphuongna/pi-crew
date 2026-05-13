# Product Docs

Product documentation for pi-crew. Each file describes a product domain —
what it does, how it behaves, and what contracts it maintains.

## Update Rule

When behavior changes:
1. Update the affected product doc
2. Update or create the story packet
3. Update `docs/TEST_MATRIX.md`
4. Record a decision if it affects architecture, scope, risk, or settled rules

## Domain Index

| File | Domain | Description |
|------|--------|-------------|
| `team-run.md` | Core | Team run lifecycle: start, execute, complete |
| `team-tool.md` | API | Team tool actions: run, status, list, plan |
| `child-process.md` | Runtime | Child Pi process spawning and management |
| `live-session.md` | Runtime | In-process agent execution |
| `async-runner.md` | Runtime | Background/async run execution |
| `state.md` | State | Durable state: manifests, tasks, events |
| `worktree.md` | Isolation | Git worktree isolation for parallel work |
| `group-join.md` | Coordination | Agent result grouping and delivery |
| `model-fallback.md` | Runtime | Model selection and fallback chain |
| `conflict-detect.md` | Utils | Merge conflict detection in file edits |
| `crash-recovery.md` | Reliability | Crash recovery and stale reconciliation |
| `effectiveness.md` | Quality | Effectiveness guard for worker activity |
| `platform.md` | Platform | Cross-platform considerations (Windows) |
| `runtime-safety.md` | Safety | Runtime safety: depth guard, resource limits |
