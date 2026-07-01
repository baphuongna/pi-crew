# pi-crew v0.5.10 — Round 15 Audit Fix Plan (2026-06-02)

**Source**: Round 15 dogfooding review (partial — explorer completed, reviewer/security-reviewer cancelled due to stale run reconciliation).

**Findings verified from source**: 9 → 5 confirmed real, 4 false positives.

## Verification Summary

| Status | Count |
|--------|-------|
| ✅ CONFIRMED (real issue) | 5 |
| ❌ FALSE POSITIVE | 4 |

### False Positives Identified
- **M2** (`register.ts` autoRepairTimer race): Code already guards with `cleanedUp || !currentCtx` checks
- **M3** (`dynamic-script-runner.ts` walkNode type guard): Only runs on parsed acorn AST (parser guarantees `type: string`)
- **H3** (event-log asyncQueues eviction): Already addressed in Round 14 — entries are deleted on success/error
- **H2** (benchmark validateCommand footgun): Reviewer misread the validation flow

### Real Issues Confirmed (5)

1. **H1**: `Semaphore.#queue` unbounded growth (`src/runtime/semaphore.ts:11`)
2. **L1**: `EventBus.emit` uses `console.error` instead of `logInternalError` (`src/observability/event-bus.ts:47`)
3. **NEW**: `OTLPExporter.convertToOTLP` no size cap on snapshots (`src/observability/exporters/otlp-exporter.ts:33`)
4. **NEW**: `OTLPExporter` `setInterval` can overlap if `push` is slow (no in-flight check)
5. **NEW**: `hooks/registry.ts` Map unbounded; `Object.assign(ctx, result.data)` without validation

## Plan: 3 small fixes

### Phase 1: Semaphore Queue Cap (HIGH)
- **H1**: Add `MAX_QUEUE = 10_000` cap to `Semaphore.#queue`. Reject with error when full.

**Files**: `src/runtime/semaphore.ts`

### Phase 2: Observability Hardening (MEDIUM)
- **L1**: Replace `console.error` with `logInternalError` in `EventBus.emit`
- **OTLP size**: Add snapshots.length cap + in-flight check in `OTLPExporter`
- **Hook registry**: Add `clearHooks` after run, validate `result.data` keys

**Files**: `src/observability/event-bus.ts`, `src/observability/exporters/otlp-exporter.ts`, `src/hooks/registry.ts`

### Phase 3: Test Coverage (LOW)
- Add basic tests for `observability/` (metric-registry, metric-sink, OTLP converter)
- Add tests for `Semaphore` queue cap

**Files**: new test files in `test/unit/`

## Expected Outcomes

- 5/5 confirmed issues fixed
- Tests: 2300+ pass (5+ new tests)
- TypeScript: 0 errors
- v0.5.10 release

## Backlog (deferred)

- `console.log/error` in `background-runner.ts` — debug logging, intentional
- `console.warn` in `discover-agents.ts` — informational
- Full OTLP wire format compliance — out of scope
- Hook `Object.assign` — needs design discussion
