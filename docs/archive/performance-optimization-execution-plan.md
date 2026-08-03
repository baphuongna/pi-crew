# PI-CREW PERFORMANCE OPTIMIZATIONS: DETAILED EXECUTION PLAN

**Created:** 2026-07-13  
**Based on:** Performance review findings and planner output  
**Scope:** 8 performance optimizations across 4 phases

---

## Executive Summary

This plan details the execution of 8 performance optimizations for pi-crew, organized into 4 phases with clear dependency chains, parallelization opportunities, and risk assessment. The optimizations range from quick wins (0.5 day) to major architectural changes (5-8 days), with a total estimated timeline of 4 weeks with 2 developers or 2 weeks with 4 developers.

---

## Phase 1: Quick Wins (Week 1)

**Goal:** Low-risk, high-impact optimizations that can be done in parallel  
**Total Effort:** 3-5 days (parallel)

### OPT-03: Guard collectedJsonEvents (0.5 day)

**Current State:**
- `task-runner.ts:301`: Already guarded with conditional allocation
- `live-session-runtime.ts:597`: Still allocates unconditionally

**Implementation:**
1. Apply same pattern from `task-runner.ts` to `live-session-runtime.ts`
2. Check yield configuration before allocating array
3. Update all usage sites to handle `undefined` case

**Files to Modify:**
- `src/runtime/live-session-runtime.ts` (line 597)
- `src/runtime/task-runner.ts` (verify existing implementation)

**Validation:**
- Unit test: verify no allocation when yield disabled
- Memory profile: compare before/after for 100-task run
- Verify no behavioral changes

### OPT-05: Cache compacted skill content (0.5 day)

**Current State:**
- `skill-instructions.ts:144`: Cache already exists with `SKILL_CACHE_MAX_ENTRIES = 128`
- `skill-instructions.ts:132`: Compacted content already cached

**Implementation:**
1. Verify cache hit rates in production
2. Tune `SKILL_CACHE_MAX_ENTRIES` if needed
3. Consider cross-run cache (like `stableIOCache` in prompt-builder.ts)

**Files to Modify:**
- `src/runtime/skill-instructions.ts` (cache tuning)

**Validation:**
- Add cache hit/miss metrics
- Verify with 10-run session that cache hit rate > 80%
- Benchmark render time with/without cache

### OPT-02: Convert saveRunManifest to async (1-2 days)

**Current State:**
- `state/state-store.ts:332`: Synchronous `saveRunManifest` with sync file I/O
- `state/state-store.ts:373`: Async `saveRunManifestAsync` exists but not widely used
- Multiple callers still use sync version in critical paths

**Implementation:**
1. Audit all `saveRunManifest` call sites
2. Convert critical path callers to use async version
3. Verify no sync-only callers remain
4. Update `task-runner.ts` line 1205 to use async version

**Files to Modify:**
- `src/runtime/team-runner.ts` (lines 640, 748, 776)
- `src/runtime/task-runner.ts` (line 1205)
- `src/runtime/stale-reconciler.ts` (lines 77, 332)
- `src/runtime/adaptive-plan.ts` (line 445)
- `src/runtime/background-runner.ts` (lines 624, 645, 690)
- `src/extension/team-tool.ts` (lines 305, 375)
- `src/extension/team-tool/goal-wrap.ts` (line 271)
- `src/extension/team-tool/api.ts` (lines 172, 247)
- `src/extension/team-tool/goal.ts` (line 194)

**Validation:**
- Grep for all `saveRunManifest` calls, ensure none remain sync
- Unit test: async save with concurrent reads
- Integration test: run with `--trace-warnings` to detect event loop blocking
- Verify no race conditions in concurrent writes

### OPT-06: Optimize transcript reads (1-2 days)

**Current State:**
- `child-pi.ts:413`: Uses sync `writeSync` for transcript writes
- `live-session-runtime.ts:152`: Uses sync `appendFileSync`

**Implementation:**
1. Convert `appendTranscript` to use async `writeFile`
2. Keep fd open per-task instead of open/write/close per line
3. Add path validation caching (like OPT-05 pattern)
4. Ensure transcript writes are best-effort (loss acceptable)

**Files to Modify:**
- `src/runtime/child-pi.ts` (line 413)
- `src/runtime/live-session-runtime.ts` (line 152)
- `src/runtime/task-runner.ts` (line 414)

**Validation:**
- Benchmark: 1000-line transcript write time
- Verify no event loop blocking with `--trace-warnings`
- Test transcript integrity after async writes

---

## Phase 2: Independent Optimizations (Week 2)

**Goal:** Medium-effort optimizations that don't depend on Phase 1  
**Total Effort:** 5-8 days (parallel)

### OPT-04: Code-aware token estimation (2-3 days)

**Current State:**
- `utils/token-counter.ts:46-80`: Uses alpha/4 + punct heuristic
- Already better than naive char/4, but still ~10-15% off for code

**Implementation:**
1. Add language detection (heuristic: look for keywords like `function`, `const`, `=>`)
2. Apply different weighting for code vs prose
3. Benchmark against real tokenizer outputs
4. Update `tool-output-pruner.ts` to use new estimator

**Files to Modify:**
- `src/utils/token-counter.ts` (lines 46-80)
- `src/runtime/tool-output-pruner.ts` (update to use new estimator)

**Validation:**
- Benchmark against tiktoken/actual tokenizer for 100 code samples
- Ensure no regression for existing prose estimation
- Update `tool-output-pruner.ts` to use new estimator
- Add unit tests for code vs prose detection

### OPT-01: Streaming dispatch (3-5 days)

**Current State:**
- `team-runner.ts:1265-1340`: Tasks grouped into `readyBatch`, then dispatched via `mapConcurrent`
- Loop waits for ALL tasks in a batch to complete before checking for new ready tasks
- Creates unnecessary latency when tasks finish at different times

**Implementation:**
1. Refactor main execution loop in `executeTeamRunCore`
2. Implement task completion events to trigger immediate dispatch
3. Maintain correct ordering for dependency graph
4. Handle race conditions in concurrent dispatch + completion callbacks
5. Ensure proper state serialization

**Files to Modify:**
- `src/runtime/team-runner.ts` (main execution loop)
- `src/runtime/task-graph-scheduler.ts` (readiness updates)
- `src/runtime/parallel-utils.ts` (concurrent dispatch)

**Validation:**
- Unit test: DAG scheduler with dynamic readiness updates
- Integration test: 10-task workflow with varying task durations
- Measure: Time from first task ready to all tasks completed
- Stress test: 100 concurrent tasks with complex dependencies

---

## Phase 3: Structural Changes (Week 3-4)

**Goal:** High-effort architectural changes that depend on earlier phases  
**Total Effort:** 8-13 days (parallel)

### OPT-08: In-memory task state (5-8 days)

**Dependencies:** Requires OPT-02 (async saveRunManifest)

**Current State:**
- `state-store.ts`: Every state change reads full manifest + tasks from disk
- `task-runner/state-helpers.ts:29-141`: `persistSingleTaskUpdate` does 100-iteration sync CAS loop
- Performance review F1/F2/F4 all relate to this issue

**Implementation:**
1. Design in-memory state model with write-through
2. Implement CAS (compare-and-swap) for concurrent updates
3. Add crash recovery for in-memory state
4. Migrate all callers to new API
5. Ensure bulletproof crash recovery

**Files to Modify:**
- `src/state/state-store.ts` (in-memory state model)
- `src/runtime/task-runner/state-helpers.ts` (CAS implementation)
- `src/runtime/team-runner.ts` (state persistence)
- `src/runtime/task-runner.ts` (state updates)

**Validation:**
- Stress test: 100 concurrent tasks writing state
- Kill test: random process termination during write
- Verify no data loss after crash recovery
- Benchmark: state update latency before/after

### OPT-07: Live-session migration (3-5 days)

**Dependencies:** Requires OPT-01 (streaming dispatch)

**Current State:**
- `live-session-runtime.ts`: Separate execution path from child-process
- Has its own `collectedJsonEvents` allocation (see OPT-03)
- Different state management than child-process path

**Implementation:**
1. Align live-session with new streaming dispatch architecture
2. Refactor `live-session-runtime.ts` to use shared patterns
3. Ensure behavioral parity with child-process path
4. Extensive integration testing

**Files to Modify:**
- `src/runtime/live-session-runtime.ts` (major refactoring)
- `src/runtime/task-runner/live-executor.ts` (alignment)
- `src/runtime/team-runner.ts` (integration)

**Validation:**
- Full integration test suite for live-session
- Manual testing with real Pi session
- Performance comparison before/after
- Verify no breaking changes

---

## Dependency Graph

```
Phase 1 (Week 1):
  OPT-03 ─┐
  OPT-05 ─┤
  OPT-02 ─┼── (no dependencies)
  OPT-06 ─┘

Phase 2 (Week 2):
  OPT-04 ─── (no dependencies)
  OPT-01 ─── (no dependencies)

Phase 3 (Week 3-4):
  OPT-08 ─── depends on OPT-02
  OPT-07 ─── depends on OPT-01
```

---

## Risk Assessment

| Optimization | Risk Level | Mitigation |
|--------------|------------|------------|
| OPT-01 | MEDIUM | Extensive integration testing, gradual rollout |
| OPT-02 | LOW | Incremental migration, existing async version |
| OPT-03 | VERY LOW | Pattern already proven |
| OPT-04 | LOW | Additive change, benchmark validation |
| OPT-05 | VERY LOW | Already implemented, just tuning |
| OPT-06 | LOW | Best-effort writes, no consistency requirements |
| OPT-07 | HIGH | Extensive testing, manual validation |
| OPT-08 | VERY HIGH | Stress testing, crash recovery validation |

---

## Potential Conflicts

1. **OPT-01 vs OPT-07:** Both affect task dispatch. Ensure streaming dispatch design accommodates live-session runtime.

2. **OPT-02 vs OPT-08:** Both affect state persistence. Ensure async save works with in-memory write-through.

3. **OPT-04 vs existing callers:** Token estimation is used in `tool-output-pruner.ts`. Ensure new estimator doesn't break pruning logic.

4. **Cross-cutting concerns:** All optimizations must maintain cross-platform compatibility (Windows/macOS/Linux).

---

## Parallelization Opportunities

**Maximum Parallelism:**
- Phase 1: 4 developers can work simultaneously
- Phase 2: 2 developers can work simultaneously
- Phase 3: 2 developers can work simultaneously

**Critical Path:** OPT-02 → OPT-08 (8-10 days) or OPT-01 → OPT-07 (6-10 days)

**Total Timeline:** 4 weeks with 2 developers, 2 weeks with 4 developers

---

## Validation Strategy

### Unit Tests
Each optimization should have unit tests for the specific change:
- OPT-03: Test conditional allocation
- OPT-05: Test cache hit/miss metrics
- OPT-02: Test async save with concurrent reads
- OPT-06: Test async transcript writes
- OPT-04: Test code vs prose detection
- OPT-01: Test DAG scheduler with dynamic readiness
- OPT-08: Test CAS operations
- OPT-07: Test live-session integration

### Integration Tests
Full workflow tests before/after each phase:
- Run complete team workflows
- Verify state persistence
- Test error handling and recovery

### Performance Tests
- Micro-benchmarks for individual functions
- End-to-end benchmarks for 10/50/100-task runs
- Event loop blocking detection (`--trace-warnings`)
- Memory usage profiling

### Stress Tests
- OPT-08: Concurrent writes + crash recovery
- OPT-01: High concurrency with complex dependencies
- All optimizations: Long-running sessions

### Manual Testing
- OPT-07: Real Pi session testing
- All optimizations: Cross-platform verification

---

## Success Metrics

1. **Event Loop Blocking:** Reduce from ~50ms/task to <5ms/task
2. **Task Dispatch Latency:** Reduce from batch-complete to task-ready (target: 50% reduction)
3. **Token Estimation Accuracy:** Improve from ±15% to ±5%
4. **Cache Hit Rates:** Skill cache >80%, config cache >90%
5. **Memory Usage:** Stable for long runs (no linear growth)
6. **State Update Latency:** Reduce from disk-read to in-memory (target: 10x improvement)

---

## Recommendations

1. **Start with Phase 1:** Quick wins provide immediate value with minimal risk
2. **Defer OPT-08:** In-memory task state is high-risk; consider as future project
3. **Monitor OPT-07:** Live-session migration is complex; may need to split into sub-tasks
4. **Benchmark everything:** Establish baseline before starting, measure after each phase
5. **Cross-platform testing:** Ensure all changes work on Windows/macOS/Linux
6. **Gradual rollout:** Implement optimizations incrementally, not all at once

---

## Files to Modify (Summary)

### Phase 1:
- `src/runtime/live-session-runtime.ts` (OPT-03)
- `src/runtime/skill-instructions.ts` (OPT-05)
- `src/state/state-store.ts` (OPT-02)
- `src/runtime/team-runner.ts` (OPT-02)
- `src/runtime/task-runner.ts` (OPT-02)
- `src/runtime/stale-reconciler.ts` (OPT-02)
- `src/runtime/adaptive-plan.ts` (OPT-02)
- `src/runtime/background-runner.ts` (OPT-02)
- `src/extension/team-tool.ts` (OPT-02)
- `src/extension/team-tool/goal-wrap.ts` (OPT-02)
- `src/extension/team-tool/api.ts` (OPT-02)
- `src/extension/team-tool/goal.ts` (OPT-02)
- `src/runtime/child-pi.ts` (OPT-06)
- `src/runtime/task-runner.ts` (OPT-06)

### Phase 2:
- `src/utils/token-counter.ts` (OPT-04)
- `src/runtime/tool-output-pruner.ts` (OPT-04)
- `src/runtime/team-runner.ts` (OPT-01)
- `src/runtime/task-graph-scheduler.ts` (OPT-01)
- `src/runtime/parallel-utils.ts` (OPT-01)

### Phase 3:
- `src/state/state-store.ts` (OPT-08)
- `src/runtime/task-runner/state-helpers.ts` (OPT-08)
- `src/runtime/live-session-runtime.ts` (OPT-07)
- `src/runtime/task-runner/live-executor.ts` (OPT-07)
- `src/runtime/team-runner.ts` (OPT-07)

---

## Remaining Risks

1. **OPT-01 complexity:** Streaming dispatch may introduce subtle race conditions
2. **OPT-08 crash recovery:** In-memory state must survive process crashes
3. **OPT-07 behavioral parity:** Live-session must behave identically to child-process
4. **Cross-platform:** Ensure all changes work on Windows/macOS/Linux
5. **Performance regression:** New optimizations must not introduce performance regressions
6. **Breaking changes:** All optimizations must maintain backward compatibility

---

## Next Steps

1. Review this plan with the team
2. Assign owners for each optimization
3. Create detailed design documents for Phase 2 and Phase 3
4. Establish baseline metrics before starting
5. Begin Phase 1 execution
6. Set up performance monitoring and alerting
7. Create rollback procedures for each optimization

---

## Appendix: Detailed Technical Specifications

### OPT-01: Streaming Dispatch Technical Details

**Current Architecture:**
```
while (tasks.some(queued)) {
  readyBatch = getReadyTasks(tasks);
  if (readyBatch.length === 0) break;
  results = await mapConcurrent(readyBatch, ...);
  tasks = mergeResults(tasks, results);
}
```

**Proposed Architecture:**
```
const pendingPromises = new Map();
while (tasks.some(queued) || pendingPromises.size > 0) {
  readyBatch = getReadyTasks(tasks);
  for (task of readyBatch) {
    const promise = runTask(task).then(result => {
      pendingPromises.delete(task.id);
      tasks = mergeResult(tasks, result);
      // Trigger next iteration
    });
    pendingPromises.set(task.id, promise);
  }
  await Promise.race([...pendingPromises.values()]);
}
```

### OPT-02: Async Migration Strategy

**Migration Pattern:**
```typescript
// Before
saveRunManifest(manifest);

// After
await saveRunManifestAsync(manifest);
```

**Critical Path Analysis:**
- `team-runner.ts:640` - Plan approval
- `team-runner.ts:748` - Budget persistence
- `team-runner.ts:776` - Goal achievement
- `task-runner.ts:1205` - Task completion

### OPT-03: Guard Pattern

**Current Implementation:**
```typescript
const collectedJsonEvents: Record<string, unknown>[] = [];
```

**Proposed Implementation:**
```typescript
const collectYieldEvents = runtimeKind !== "child-process" && 
  (input.runtimeConfig?.yield?.enabled ?? DEFAULT_YIELD_CONFIG.enabled);
const collectedJsonEvents: Record<string, unknown>[] | undefined = 
  collectYieldEvents ? [] : undefined;
```

### OPT-04: Code-Aware Estimation

**Heuristic Detection:**
```typescript
function isCodeContent(text: string): boolean {
  const codeIndicators = [
    /function\s*\w*\s*\(/,
    /const\s+\w+\s*=/,
    /=>\s*{/,
    /import\s+.*from\s+['"]/,
    /export\s+(default\s+)?(function|class|const)/,
    /\w+\.\w+\(.*\)/,  // Method calls
    /[{}\[\]();]/,      // Code punctuation
  ];
  
  let score = 0;
  for (const indicator of codeIndicators) {
    if (indicator.test(text)) score++;
  }
  
  return score >= 3;  // Threshold for code detection
}
```

### OPT-08: In-Memory State Model

**Architecture:**
```typescript
class InMemoryTaskState {
  private state: Map<string, TeamTaskState> = new Map();
  private manifest: TeamRunManifest;
  
  async updateTask(taskId: string, update: Partial<TeamTaskState>): Promise<void> {
    const current = this.state.get(taskId);
    if (!current) throw new Error(`Task ${taskId} not found`);
    
    const merged = { ...current, ...update };
    this.state.set(taskId, merged);
    
    // Write-through to disk
    await this.flushToDisk();
  }
  
  private async flushToDisk(): Promise<void> {
    await saveRunManifestAsync(this.manifest);
    await saveRunTasksAsync(this.manifest, Array.from(this.state.values()));
  }
}
```

---

**Document Version:** 1.0  
**Last Updated:** 2026-07-13  
**Author:** Performance Optimization Task Force