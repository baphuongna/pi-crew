# src/runtime/ — runtime cluster map

This directory holds the team-run execution machinery. After the v0.9.x reorg, the largest
clusters are extracted into subdirectories; the remaining files stay at the root.

## Extracted subdirectories (navigable clusters)

| Subdir | Phase | Cluster | Key files |
|--------|-------|---------|-----------|
| [`child-pi/`](./child-pi/) | B-1 | child Pi worker spawn/lifecycle/steering/transcript | `child-pi.ts`, `child-pi-spawn.ts`, `child-pi-kill.ts`, `child-pi-constants.ts`, `child-pi-steering.ts`, `child-pi-streams.ts`, `child-pi-transcript.ts` |
| [`broker/`](./broker/) | B-2 | crew broker server/client/auth (child-pi ↔ parent IPC) | `crew-broker.ts`, `crew-broker-client.ts`, `crew-broker-child.ts`, `crew-broker-tokens.ts`, `broker-issuer.ts` |
| [`task-runner/`](./task-runner/) | (pre-existing) | per-task execution (pre-execution, child-executor) | `child-executor.ts`, `pre-execution.ts`, ... |
| [`live-session/`](./live-session/) | 3 | live agent control/manager, session runtime, IRC, health, extension bridge | `live-session-runtime.ts`, `live-agent-manager.ts`, `live-agent-control.ts`, `live-control-realtime.ts`, `live-irc.ts`, `live-session-health.ts`, `live-extension-bridge.ts`, `intercom-bridge.ts` |
| [`recovery/`](./recovery/) | 4 | crash recovery, retry, checkpoint | `crash-recovery.ts`, `crash-classification.ts`, `recovery-recipes.ts`, `overflow-recovery.ts`, `retry-executor.ts`, `retry-runner.ts`, `checkpoint.ts` |
| [`scheduling/`](./scheduling/) | 5 | scheduler, concurrency, task-graph, batch-barrier, parallel utils | `scheduler.ts`, `semaphore.ts`, `concurrency.ts`, `task-graph.ts`, `task-graph-scheduler.ts`, `batch-barrier.ts`, `coalesce-tasks.ts`, `run-coalesced-task-group.ts`, `global-worker-cap.ts`, `parallel-research.ts`, `parallel-utils.ts` |
| [`verification/`](./verification/) | 6a | verification gates, green-contract, post-checks, completion-guard | `verification-gates.ts`, `verification-integrity.ts`, `verification-worktree.ts`, `green-contract.ts`, `post-checks.ts`, `completion-guard.ts` |
| [`model/`](./model/) | 6b | model fallback/resolver/scope, pi-args, runtime policy/resolver/warmup | `model-fallback.ts`, `model-resolver.ts`, `model-scope.ts`, `pi-args.ts`, `runtime-policy.ts`, `runtime-resolver.ts`, `runtime-warmup.ts` |
| [`output/`](./output/) | 6c | streaming output, progress tracking, sidechain, result extraction | `streaming-output.ts`, `stream-preview.ts`, `output-validator.ts`, `pi-json-output.ts`, `tool-progress.ts`, `progress-event-coalescer.ts`, `progress-tracker.ts`, `result-extractor.ts`, `sidechain-output.ts` |
| [`heartbeat/`](./heartbeat/) | 6d | heartbeat gradient/watcher, worker heartbeat/startup | `heartbeat-gradient.ts`, `heartbeat-watcher.ts`, `worker-heartbeat.ts`, `worker-startup.ts` |
| [`process/`](./process/) | 6e | cancellation, process lifecycle, zombie scanner, stdio guard | `cancellation-token.ts`, `cancellation.ts`, `process-lifecycle.ts`, `zombie-scanner.ts`, `post-exit-stdio-guard.ts` |
| [`goal-workflow/`](./goal-workflow/) | 6f | goal achievement/evaluation/loop, dynamic-workflow, adaptive plan | `goal-achievement.ts`, `goal-evaluator.ts`, `goal-loop-runner.ts`, `goal-state-store.ts`, `dynamic-workflow-context.ts`, `dynamic-workflow-runner.ts`, `adaptive-plan.ts`, `plan-templates.ts` |
| [`compaction/`](./compaction/) | 6g | compaction pipeline, tool-output-pruner, important-line-classifier, compact-stages | `compact-pipeline.ts`, `compaction-summary.ts`, `tool-output-pruner.ts`, `important-line-classifier.ts`, [`compact-stages/`](./compaction/compact-stages/) |
| [`custom-tools/`](./custom-tools/) | (pre-existing) | custom tool definitions | `irc-tool.ts`, `submit-result-tool.ts`, ... |
| [`errors/`](./errors/) | (pre-existing) | error types | ... |

## Remaining flat files at root (~77)

- **team-runner** — `team-runner.ts` (the orchestrator) + `run-worker.ts`, `run-tracker.ts`
- **chain/pipeline runners** — `chain-parser.ts`, `chain-runner.ts`, `pipeline-runner.ts`, `direct-run.ts`
- **foreground/background runners** — `foreground-control.ts`, `foreground-watchdog.ts`, `async-runner.ts`, `background-runner.ts`
- **crew agent** — `crew-agent-records.ts`, `crew-agent-runtime.ts`, `crew-hooks.ts`, `single-agent-compose.ts`
- **observability** — `effectiveness.ts`, `agent-observability.ts`, `command-trace.ts`, `metric-parser.ts`
- **misc** — `stale-reconciler.ts`, `parent-guard.ts`, `manifest-cache.ts`, `event-stream-bridge.ts`, `policy-engine.ts`, `role-permission.ts`, `workspace-lock.ts`, `workspace-tree.ts`, `session-*.ts`, ...

See `docs/COVERAGE-ASSESSMENT-2026-08-01.md` § "Source reorganization" for the reorg history + remaining-cluster plan.
