---
name: async-worker-recovery
description: >
  Background worker, heartbeat, stale-run, crash-recovery, and deadletter workflow. Use when debugging stuck/dead workers or changing async run reliability.
  When NOT to use: pure investigation without async context (use read-only-explorer); one-shot fixes that don't need recovery infrastructure.

origin: pi-crew
triggers:
  - "worker crashed"
  - "stale run"
  - "deadletter"
  - "heartbeat stale"
  - "worker stuck"

---
# async-worker-recovery

Use this skill when a pi-crew run is stuck, stale, interrupted, or has dead workers.

## Source patterns distilled

- pi-subagents async patterns: detached runner, status files, result watcher, stale PID reconciler
- pi-crew runtime: `src/runtime/background-runner.ts`, `async-runner.ts`, `heartbeat-watcher.ts`, `worker-heartbeat.ts`, `crash-recovery.ts`, `stale-reconciler.ts`, `deadletter.ts`, `delivery-coordinator.ts`
- UI recovery controls: `src/ui/run-dashboard.ts`, `src/ui/dashboard-panes/health-pane.ts`, `src/ui/run-action-dispatcher.ts`

## Rules

- Distinguish historical dead-heartbeat events from current active failures. Check manifest/task status and event timestamps.
- Heartbeat warnings should only apply to currently running/waiting work, never terminal runs/tasks.
- Stale reconciliation order: result/terminal evidence → PID liveness → stale threshold/active evidence.
- Reconcile state under run lock and re-read inside the lock before repair.
- Deadletter entries are evidence, not automatic proof of permanent failure; inspect attempts and later completion events.
- For background runs, verify PID liveness and background log before declaring stuck.
- Session delivery should queue while inactive and flush only to the current generation/session.
- Do not poll in sleep loops waiting for async completion if the system has a watcher/result notification path.

## Operator checklist

1. Load manifest/tasks and recent events.
2. Check `manifest.async.pid` and process liveness.
3. Check heartbeat `lastSeenAt`, progress `lastActivityAt`, and terminal status.
4. Inspect deadletter and diagnostic report.
5. Choose recovery: resume, retry, kill stale, diagnostic, or no-op historical notification.

## Enforcement — Worker Recovery Gate

**Before taking recovery action, verify:**

- [ ] Run status is not terminal (completed/failed/cancelled)
- [ ] Heartbeat is genuinely stale (not just delayed polling)
- [ ] PID is dead or stale threshold exceeded
- [ ] Recovery action matches run state (resume vs retry vs kill)
- [ ] Session generation matches before state modification

If ANY answer is NO → Stop. Re-check status. Do not apply stale recovery to active runs.

## Verification

```bash
cd pi-crew
npx tsc --noEmit
node --experimental-strip-types --test test/unit/heartbeat-watcher.test.ts test/unit/stale-reconciler.test.ts test/unit/deadletter.test.ts test/integration/async-restart-recovery.test.ts
npm test
```
