# src/state/ — Cluster Map

Persistent state layer for pi-crew runs. Organized into subdirectories by
responsibility (Phase 7 reorg).

## Root (shared infrastructure)

| File | Responsibility |
|------|---------------|
| `types.ts` | Core state types (`TeamRunManifest`, `TeamTaskState`, schema versions) |
| `types-eval.ts` | Evaluation-related types |
| `contracts.ts` | Status transitions, task-status enums |
| `tiered-eval.ts` | Tiered evaluation logic |
| `crew-init.ts` | Crew initialization / bootstrap |
| `decision-ledger.ts` | Decision recording |
| `gitignore-manager.ts` | `.gitignore` management for crew dirs |
| `hook-instinct-bridge.ts` | Bridge between hooks and instinct store |
| `hook-integrations.ts` | Hook integration points |
| `session-state-map.ts` | Session → state mapping |
| `usage.ts` | Token/cost usage tracking |
| `atomic-write.ts` | Atomic file writes (widely used — kept at root) |

## `event-log/` — Event journaling

Event append/read, rotation/compaction, JSONL writing, and worker-thread
atomic writes.

- `event-log.ts`, `event-log-rotation.ts`, `event-reconstructor.ts`,
  `jsonl-writer.ts`, `worker-atomic-writer.ts`

## `stores/` — Persisted data stores

Manifest, artifact, blob, observation, health, instinct, run-graph/metrics
stores, and the active-run registry.

- `state-store.ts`, `run-cache.ts`, `artifact-store.ts`, `blob-store.ts`,
  `observation-store.ts`, `health-store.ts`, `instinct-store.ts`,
  `active-run-registry.ts`, `run-graph.ts`, `run-metrics.ts`

## `coordination/` — Concurrency & IPC

File locks, mailbox messaging, task scheduling, and task claims.

- `locks.ts`, `mailbox.ts`, `schedule.ts`, `task-claims.ts`
