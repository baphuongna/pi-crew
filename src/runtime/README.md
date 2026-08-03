# src/runtime/ — runtime cluster map

This directory holds the team-run execution machinery. After the v0.9.x reorg, the largest
clusters are extracted into subdirectories; the remaining files stay at the root.

## Extracted subdirectories (navigable clusters)

| Subdir | Cluster | Key files |
|--------|---------|-----------|
| [`child-pi/`](./child-pi/) | child Pi worker spawn/lifecycle/steering/transcript | `child-pi.ts`, `child-pi-spawn.ts`, `child-pi-kill.ts`, `child-pi-constants.ts`, `child-pi-steering.ts`, `child-pi-streams.ts`, `child-pi-transcript.ts`, `child-pi-pool.ts` |
| [`broker/`](./broker/) | crew broker server/client/auth (child-pi ↔ parent IPC) | `crew-broker.ts`, `crew-broker-client.ts`, `crew-broker-child.ts`, `crew-broker-tokens.ts`, `broker-issuer.ts` |
| [`task-runner/`](./task-runner/) | per-task execution (pre-execution, child-executor) | `child-executor.ts`, `pre-execution.ts`, ... |
| [`compact-stages/`](./compact-stages/) | compaction pipeline stages | `truncation-stage.ts`, `tail-capture-stage.ts`, `bounded-tail.ts`, ... |

## Remaining flat clusters at root (candidates for future extraction)

- **team-runner** — `team-runner.ts` (the orchestrator), `run-coalesced-task-group.ts`
- **live-session** — `live-*.ts` (8 files: agent-control/manager, session-runtime, control-realtime, irc, health, extension-bridge) + `intercom-bridge.ts`
- **recovery** — `crash-recovery.ts`, `crash-classification.ts`, `recovery-recipes.ts`, `overflow-recovery.ts`, `retry-executor.ts`, `retry-runner.ts`, `checkpoint.ts`
- **scheduling/concurrency** — `scheduler.ts`, `semaphore.ts`, `concurrency.ts`, `task-graph.ts`, `task-graph-scheduler.ts`, `batch-barrier.ts`, `coalesce-tasks.ts`, `global-worker-cap.ts`, `parallel-research.ts`, `parallel-utils.ts`
- **goal-workflow** — `goal-*.ts`, `dynamic-workflow-*.ts`, `adaptive-*.ts`, `plan-templates.ts`
- **model/runtime-config** — `model-*.ts`, `pi-args.ts`, `runtime-policy.ts`, `runtime-resolver.ts`, `runtime-warmup.ts`, `settings-store.ts`
- **verification** — `verification-*.ts`, `green-contract.ts`, `post-checks.ts`, `completion-guard.ts`
- **output-streaming** — `streaming-output.ts`, `stream-*.ts`, `output-validator.ts`, `pi-json-output.ts`, `tool-progress.ts`, `progress-*.ts`, `result-extractor.ts`, `sidechain-output.ts`
- **process/cancellation** — `cancel*.ts`, `process-lifecycle.ts`, `zombie-scanner.ts`, `post-exit-stdio-guard.ts`
- **foreground/background runners** — `foreground-*.ts`, `async-runner.ts`, `background-runner.ts`
- **heartbeat** — `heartbeat-*.ts`, `worker-heartbeat.ts`, `worker-startup.ts`
- **observability** — `effectiveness.ts`, `agent-observability.ts`, `command-trace.ts`, `runtime-warmup.ts`
- **misc** — `stale-reconciler.ts`, `parent-guard.ts`, `manifest-cache.ts`, `event-stream-bridge.ts`, ...

See `docs/COVERAGE-ASSESSMENT-2026-08-01.md` § "Source reorganization" for the reorg history + remaining-cluster plan.
