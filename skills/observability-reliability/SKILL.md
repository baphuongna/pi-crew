---
name: observability-reliability
description: >
  Metrics, diagnostics, correlation, retry, deadletter, and recovery evidence workflow.
  When NOT to use: one-off event capture (use event-log-tracing); pure recovery logic (use async-worker-recovery).

origin: pi-crew
triggers:
  - "add metrics"
  - "diagnose failure"
  - "retry logic"
  - "deadletter"
  - "recovery evidence"
---
# observability-reliability

Use this skill for reliability and observability work.

## Source patterns distilled

- `src/observability/*` — metric registry, retention, sinks, exporters, event-to-metric mapping
- `src/runtime/retry-executor.ts`, `deadletter.ts`, `diagnostic-export.ts`, `recovery-recipes.ts`, `overflow-recovery.ts`, `heartbeat-gradient.ts`
- `docs/research-phase9-observability-reliability-plan.md`

## Rules

- Metrics should be per-session/per-registry where possible; avoid hidden global singletons.
- Use low-cardinality labels. Avoid raw task titles, prompts, full file paths, or secrets in metric labels.
- Redact secrets before writing logs, events, diagnostics, agent output, or exported bundles.
- Correlate events with runId/taskId and timestamps; include enough context for postmortem without exposing secrets.
- Retry should record attempts and deadletter on exhaustion; default auto-retry should remain conservative.
- Diagnostics should be safe to share: include state summary, recent events, metrics snapshot when available, and paths to artifacts.
- Heartbeat classification should be threshold-based and should ignore terminal tasks/runs.
- Overflow recovery should track phase progression and terminal states without repeatedly alerting on completed work.

## Enforcement — Observability Reliability Gate

**Before emitting metrics or implementing retry, verify:**

- [ ] Metric labels are low-cardinality (no raw paths, prompts, or secrets)
- [ ] Secrets redacted before writing logs, events, diagnostics, or bundles
- [ ] Retry records attempts and deadletters on exhaustion
- [ ] Diagnostics are safe to share (no secrets, no raw sensitive data)
- [ ] Heartbeat thresholds ignore terminal tasks/runs

If ANY answer is NO → Stop. Fix observability issues before proceeding.

## Anti-patterns

- High-cardinality Prometheus labels.
- Emitting duplicate noisy health notifications every render tick.
- Writing unredacted Authorization/API key/token values into events or artifacts.
- Treating secondary metrics as primary pass/fail unless catastrophic.

## Verification

```bash
cd pi-crew
npx tsc --noEmit
node --experimental-strip-types --test test/unit/metric-registry.test.ts test/unit/event-to-metric.test.ts test/unit/diagnostic-export.test.ts test/unit/retry-executor.test.ts test/unit/deadletter.test.ts
npm test
```
