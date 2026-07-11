# pi-crew Performance Audit Report — 2026-07-11

> **Scope**: Multi-agent orchestration runtime (task execution pipeline, memory management, I/O operations, prompt construction, concurrency patterns)
> **Target**: pi-crew v0.9.x runtime (`src/runtime/`, `src/state/`, `src/utils/`)
> **Status**: Analysis complete — 26 findings (6 CRITICAL/HIGH, 13 MEDIUM, 7 LOW); 6 previously-documented issues confirmed fixed; 9 new findings identified
>
> **Update 2026-07-11 (post-bench)**: Phase 1 shipped (NEW-M1, A1-F7, A4-F1) + NEW-C3 correctness fix shipped. **A5-C2 disproven by benchmark** (`test/bench/terminal-persist-blocking.bench.ts`): contentionRatio ≈ 0.93–0.98 across 4 runs proves NO lock contention exists between concurrent task completions (sync critical sections serialize naturally in the single-threaded event loop). The claimed 200–800ms impact does not occur. See §7 — Benchmark Findings.

---

## 1. Executive Summary

### Key Metrics

| Metric | Value | Source |
|--------|-------|--------|
| Total findings | 26 | This audit |
| CRITICAL/HIGH severity | 6 | — |
| MEDIUM severity | 13 | — |
| LOW severity | 7 | — |
| Previously documented (confirmed fixed) | 6 | `docs/perf/performance-review-2026-07.md` |
| New findings (not in prior docs) | 9 | This audit |
| Files analyzed | ~45 | `src/runtime/`, `src/state/`, `src/utils/` |

### Top 5 Impact Findings

| Priority | Finding | Category | Estimated Impact | Risk |
|----------|---------|----------|------------------|------|
| **P0** | `saveRunManifest` write-write race (NEW-C3) | Concurrency | Silent artifact loss | ✅ **FIXED** (commit a03d244) |
| **P1** | `persistSingleTaskUpdate` sync lock blocks event loop (A5-C2) | Concurrency | 200–800ms/4-parallel batch | ❌ **DISPROVEN** — no contention (ratio 0.93–0.98) |
| **P2** | Sync `saveRunManifest` per task completion (A1-F14) | I/O | 100–1000ms total/run | HIGH (open) |
| **P3** | Stable prefix recomputed per parallel task (NEW-M1) | Prompt/I/O | 200–800ms/4-tasks | ✅ **FIXED** (commit 08d1a64) |
| **P4** | Redundant skill compaction on cache hit (A4-F1) | Prompt | ~15% skill rendering waste | ✅ **FIXED** (commit 08d1a64) |

### Findings Fixed Since Prior Review

Cross-referencing against `docs/perf/performance-review-2026-07.md` (F1–F21) and `docs/perf/optimization-plan-2026-07-verified.md`:

| Finding | Status | Evidence |
|---------|--------|----------|
| **F1** — Global generation counter | ✅ FIXED | `state-store.ts:82` — `Map<string, number>` per-stateRoot |
| **F9** — `rawTextEvents` unbounded | ✅ FIXED | `child-pi.ts:615` — `MAX_RAW_TEXT_EVENTS=2`, ring buffer cap |
| **F12** — `finalDrainMs` hard 5000 | ✅ FIXED | `defaults.ts:8,19` — early-exit on silence |
| **F15** — Discovery cache TTL 500ms | ✅ FIXED | `discover-agents.ts:502` — `DISCOVERY_CACHE_TTL_MS=5000` |
| **F16** — `loadConfig()` no cache | ✅ FIXED | `config.ts:70,86–107` — 2s TTL + mtime cache |
| **F17** — `discoverWorkflows` no cache | ✅ FIXED | `discover-workflows.ts:220–280` — TTL cache + dirStamp |

### Still Present (Unfixed)

| Finding | Docs ID | Status |
|---------|---------|--------|
| Worktree `execFileSync` blocks event loop | F8 | Still present |
| Mailbox delivery-state full rewrite + fsync | F6 | Still present |
| Fsync data+dir unconditional (caller migration pending) | F4 | Partial — option exists |
| Fsync per event (buffering incomplete) | F3 | Partial — only `task.progress` uses buffered path |
| `saveRunTasksCoalesced` still has 0 call sites | F4 | Still present |
| `appendEventBuffered` not wired to other event types | F3 | Still present |
| `isSymlinkSafePath` ancestor walk ×2 per write | F5 | Still present |

---

## 2. Methodology and Scope

### Analysis Scope

```
src/runtime/
├── task-runner/
│   ├── task-runner.ts          # Core task execution
│   ├── prompt-builder.ts       # Prompt construction
│   ├── state-helpers.ts        # Task state persistence
│   ├── tail-read.ts            # Transcript reads
│   ├── progress.ts             # Progress tracking
│   └── path-overlap.ts         # Write overlap detection
├── team-runner.ts              # Orchestration loop
├── child-pi.ts                 # Worker spawning
├── skill-instructions.ts       # Skill rendering
├── tool-output-pruner.ts       # Staleness pruning
├── usage-tracker.ts            # Usage tracking
├── task-graph-scheduler.ts     # Task scheduling
└── event-log.ts               # Event append

src/state/
├── state-store.ts              # Manifest persistence
├── locks.ts                   # Run locking
├── atomic-write.ts             # Safe file writes
└── event-log.ts               # Event logging

src/utils/
├── token-counter.ts           # Token estimation
└── incremental-reader.ts      # Efficient reads

src/extension/
└── knowledge-injection.ts     # Knowledge fragment injection
```

### Verification Methods

1. **Source inspection**: All file:line references verified directly against source
2. **Cross-reference**: Compared against `docs/perf/performance-review-2026-07.md`, `docs/perf/optimization-plan-2026-07-verified.md`, `docs/perf/sprint-7-report.md`
3. **Current state verification**: grep/read on key files confirming fix status

### Impact Estimation Methodology

| Impact Level | Criteria |
|--------------|----------|
| **CRITICAL** | Correctness bug (data loss, corruption, race condition) |
| **HIGH** | >100ms per-run impact OR affects all runs |
| **MEDIUM** | 10–100ms per-run impact OR affects most runs |
| **LOW** | <10ms per-run impact OR rare case |

---

## 3. Findings by Category

### 3.1 Concurrency

#### [NEW-C3] — `saveRunManifest` called without run lock (CRITICAL)

**Severity**: CRITICAL  
**Impact**: Silent artifact loss in parallel batches; potential manifest corruption  
**File**: `src/runtime/task-runner.ts:1193`

```typescript
// PROBLEM: Direct call without lock
await writeArtifact(...);  // 15 artifacts written
saveRunManifest(manifest); // ← No withRunLock here!
```

**Root Cause**: Task-runner writes manifest directly after `writeArtifact` calls. The team-runner's merge path at `team-runner.ts:1454` calls `saveRunManifestAsync` inside `withRunLock`. Race condition:

1. Worker A writes manifest with artifact A → Worker B writes manifest with artifact B → team-runner reads disk (stale) → team-runner overwrites both

**Risk Assessment**: HIGH — correctness bug, not just perf. Could cause missing artifacts in parallel batches.

**Recommendation**: 
- Option A: Add `withRunLock` around task-runner's manifest write
- Option B: Skip per-task manifest write entirely, rely on team-runner's batch merge

---

#### [NEW-C6] — Double lock acquisition in post-batch merge path

**Severity**: HIGH  
**Impact**: ~10–50ms per merge × batch count; redundant disk reads  
**File**: `src/runtime/team-runner.ts:1450–1458`

```typescript
// PROBLEM: Async lock + disk read after sync locks already committed
await withRunLock(runId, async () => {
    const manifest = await loadRunManifestById(...); // Redundant read
    // Merge task updates...
});
```

**Root Cause**: `persistSingleTaskUpdate` uses `withRunLockSync` (sync) and commits state. The async merge path re-reads from disk even though workers already persisted.

**Risk Assessment**: MEDIUM — correctness is safe, but performance is wasted.

**Recommendation**: Sequence-number tagging approach — each manifest write carries a monotonic sequence number. Merge skips disk read for workers with higher sequence numbers.

---

#### [A5-C2] — `persistSingleTaskUpdate` sync lock blocks event loop

> **⛔ VERDICT (2026-07-11): DISPROVEN — do not apply.** A dedicated benchmark
> (`test/bench/terminal-persist-blocking.bench.ts`, 4 runs) measured
> **contentionRatio 0.93–0.98** (≈1.0), proving there is **NO lock contention**
> between concurrent task completions. The original impact estimate was based
> on an incorrect concurrency model (see §7). The per-completion cost is a
> single ~30ms sync block, spread over time in real runs — not a concentrated
> 200–800ms block. The async conversion (11+ call sites + `checkpointTask`
> ripple) would relieve contention that does not exist, at real deadlock risk.

**Severity**: ~~HIGH~~ → **WONTFIX (disproven)**  
**Impact**: ~~200–800ms total wait time for 4-way parallel completion~~ → **~30ms p50 per completion, no inter-completion contention**  
**File**: `src/runtime/task-runner/state-helpers.ts:36–112`

```typescript
// PROBLEM: Synchronous lock with event-loop blocking
return withRunLockSync(manifest, () => {
    retryLoop: for (let attempt = 0; attempt < 100; attempt++) {
        const latest = loadRunManifestById(...);  // Full state reload
        // ... 3x statSync mtime checks ...
```

**Root Cause**: `withRunLockSync` uses `sleepSync` (`Atomics.wait`) which blocks the event loop. When 4 tasks complete simultaneously, they serialize on the lock.

**Recommendation**: Convert to async `withRunLock` instead of `withRunLockSync`. The CAS loop can remain (protects against unlocked writers like `async-notifier.ts:54`).

---

#### [A5-C4] — `loadRunManifestById` called inside retry loop without lock

**Severity**: MEDIUM  
**Impact**: Low-probability zombie task during retry  
**File**: `src/runtime/team-runner.ts:1254–1258`

```typescript
// PROBLEM: No lock around manifest read in retry loop
const freshTask = fresh?.tasks[taskId];
if (freshTask.status !== "queued" && freshTask.status !== "running") {
    // Task was cancelled between retry attempts
```

**Recommendation**: Add `withRunLock` around retry loop, or rely on atomic-write rename safety with explicit comment.

---

#### [A5-C8] — `filterReadyByWriteOverlap` greedy algorithm suboptimal

**Severity**: MEDIUM  
**Impact**: Suboptimal task selection when enabled → unused parallelism slot  
**File**: `src/runtime/path-overlap.ts:76–108`

```typescript
// PROBLEM: Greedy first-fit — doesn't optimize for maximum parallelism
const ready = tasks.filter(t => !conflictSet.has(t.id));
return ready[0]; // Always picks first non-conflicting task
```

**Recommendation**: Sort by priority/conflict-count and pick tasks with fewest conflicts first. (Current behavior may be acceptable given `enabled: false` by default.)

---

#### [A5-C12] — `appendEventAsync` promise chain grows unbounded

**Severity**: MEDIUM  
**Impact**: ~150–750ms total serialization across run (150 events × 1–5ms)  
**File**: `src/state/event-log.ts:453–462`

```typescript
// PROBLEM: Promise chain grows to 150+ deep
appendEventAsync(event) {
    return prev.then(() => doAppend(event));
}
```

**Recommendation**: Batch events within a batch — collect and write in single `appendFile` call at batch end.

---

#### [A1-F13] — `backpressureBytes` counter never resets on pause

**Severity**: LOW  
**Impact**: Only affects very chatty workers (rare)  
**File**: `src/runtime/child-pi.ts:1149–1165`

---

### 3.2 I/O Operations

#### [A1-F14] — `saveRunManifest` synchronous call on every task completion

**Severity**: HIGH  
**Impact**: 5–50ms per write × ~20 writes per run = 100–1000ms total  
**File**: `src/runtime/task-runner.ts:1168`

```typescript
// PROBLEM: Sync write after every task
for (const artifact of artifacts) {
    await writeArtifact(artifact.descriptor, artifact.content);
}
saveRunManifest(manifest);  // ← Sync, blocks event loop
```

**Recommendation**: Fix NEW-C3 first, then replace with async or skip entirely (team-runner batch merge is authoritative).

---

#### [NEW-M1] — Prompt stable prefix recomputed per parallel task

**Severity**: MEDIUM  
**Impact**: ~50–200ms per task × 4 parallel = 200–800ms wasted  
**File**: `src/runtime/task-runner/prompt-builder.ts:123–168`

```typescript
// PROBLEM: Stable prefix computed independently for each task
async function renderTaskPrompt(task) {
    const stablePrefix = await computeStablePrefix(task);  // Identical for all 4 parallel tasks
    const dynamicSuffix = buildDynamicSuffix(task);
    return stablePrefix + dynamicSuffix;
}
```

**Root Cause**: In a 4-way parallel batch, all 4 tasks get identical stable prefixes (workspace tree + retrieval + knowledge + skills) computed independently.

**Recommendation**: Pre-compute stable prefix once per (cwd, role, runId) in team-runner batch loop. `renderTaskPrompt` already separates stablePrefix from dynamicSuffix.

---

#### [NEW-M2] — Skill cache stat on every cache hit

**Severity**: MEDIUM  
**Impact**: ~2.5–20ms per task × 4 parallel = 10–80ms total  
**File**: `src/runtime/skill-instructions.ts:128–145`

```typescript
// PROBLEM: fs.statSync on every cache hit
readSkillMarkdown(skillPath: string): CachedSkillMarkdown {
    const cached = skillCache.get(skillPath);
    if (cached) {
        fs.statSync(skillPath);  // ← Redundant stat for freshness
        return cached;
    }
```

**Recommendation**: Use `dirStamp` pattern (like `discover-workflows.ts:222`) — check parent directory mtime instead of each skill file.

---

#### [A1-F5] — `tailReadWithLineSnap` double stat+read per transcript read

**Severity**: MEDIUM  
**Impact**: ~20–80ms per task  
**File**: `src/runtime/task-runner/tail-read.ts:11–12`

```typescript
// PROBLEM: 2–4 syscalls per call
const stats = fs.statSync(path);
const content = stats.size > 0 ? fs.readFileSync(path, "utf-8") : "";
```

**Recommendation**: Use `fs.promises.open` + `fileHandle.stat()` + `fileHandle.read()` to avoid stat+open double-call.

---

#### [A1-F9] — Redundant `fs.mkdirSync` inside model-attempt loop

**Severity**: LOW  
**Impact**: ~0.3ms per task  
**File**: `src/runtime/task-runner.ts:411–413`

**Recommendation**: Hoist `mkdirSync` outside the loop.

---

#### [A1-F12] — Pretty-print JSON in metadata artifacts

**Severity**: LOW  
**Impact**: ~30–50% larger artifact files  
**File**: `src/runtime/task-runner.ts:1126–1165`

**Recommendation**: Use compact JSON for metadata artifacts; keep pretty-print for human-readable manifests only.

---

### 3.3 Prompt Construction

#### [A4-F1] — Redundant skill content compaction on cache hit

**Severity**: HIGH  
**Impact**: ~15% of skill rendering time wasted; ~50ms per task for 5 skills  
**File**: `src/runtime/skill-instructions.ts:216–230`

```typescript
// PROBLEM: Compaction runs even when cache is hit
async function renderSkillInstructions(task) {
    const cached = skillCache.get(skillKey);
    if (cached) {
        const compacted = compactSkillContent(cached.raw);  // ← Redundant!
        return compacted;
    }
```

**Recommendation**: Cache the compacted content in `CachedSkillMarkdown` structure: `{ raw, compacted }`. Use `compacted` on cache hit.

---

#### [A4-F3] — Token estimation inaccuracy for code-heavy content

**Severity**: MEDIUM  
**Impact**: 10–15% error → under/over-truncation → wasted context or missing content  
**File**: `src/utils/token-counter.ts:49–80`

```typescript
// PROBLEM: Underestimates tokens for code
estimateTokens(text: string): number {
    const alpha = text.replace(/[^a-zA-Z]/g, "").length;
    const punct = text.replace(/[a-zA-Z\s]/g, "").length;
    return Math.ceil(alpha / 4) + punct;
}
```

**Recommendation**: Use code-aware estimation — code fences as `length * 0.3`, prose as `word_count * 1.3`. Benchmark against `tiktoken` or actual model tokenizer.

---

#### [A4-F4] — Staleness index rebuilds O(N) per pruning call

**Severity**: MEDIUM  
**Impact**: O(N) where N = tool results count. In runs with 200+ results, rebuilding on every pruning call adds up.  
**File**: `src/runtime/tool-output-pruner.ts:182–220`

```typescript
// PROBLEM: Full rebuild on every call
function pruneToolOutputs(context) {
    const index = buildStalenessIndex(context.results);  // O(N) every time
    // ...
}
```

**Recommendation**: Maintain staleness index incrementally; only rebuild from scratch if index becomes inconsistent.

---

#### [A4-F2] — Knowledge section parsing overhead per query

**Severity**: LOW  
**Impact**: ~2–5ms per worker × N workers  
**File**: `src/extension/knowledge-injection.ts:114–150`

**Recommendation**: Cache parsed sections by (mtimeMs, size).

---

### 3.4 Memory Management

#### [A1-F7] — `collectedJsonEvents` accumulated but unused for child-process workers

**Severity**: MEDIUM  
**Impact**: ~10KB memory waste per task + allocation/trim cycle  
**File**: `src/runtime/task-runner.ts:296, 506–509, 879–882`

```typescript
// PROBLEM: Array built up for 100% of child-process tasks, never read
const collectedJsonEvents: ParsedEvent[] = [];

async function processChildOutput() {
    // ...
    collectedJsonEvents.push(event);  // Accumulates
    if (collectedJsonEvents.length > MAX_COLLECTED) {
        collectedJsonEvents.splice(0, collectedJsonEvents.length - MAX_COLLECTED);
    }
}

// Only consumed when yieldEnabled === true (live-session only)
if (yieldEnabled) {
    yield detection uses collectedJsonEvents;  // Never reached for child-process
}
```

**Recommendation**: Guard `collectedJsonEvents` accumulation behind `yieldEnabled` check. Only allocate when `yieldEnabled === true`.

---

#### [A2-F1] — `taskUsageMap` global Map lacks auto-cleanup

**Severity**: MEDIUM  
**Impact**: Stale entries accumulate over long-running sessions  
**File**: `src/runtime/usage-tracker.ts:38`

```typescript
// PROBLEM: No TTL-based eviction
const taskUsageMap = new Map<string, TaskUsage>();

clearTrackedTaskUsage() {  // Clears ALL, not just stale
    taskUsageMap.clear();
}
```

**Recommendation**: Add TTL-based eviction similar to `activeChildProcesses` cleanup pattern in `child-pi.ts:33–42`.

---

#### [A1-F2] — `compactChildPiEvent` creates new objects per stdout line

**Severity**: LOW  
**Impact**: ~250–500ms per task (GC pressure)  
**File**: `src/runtime/child-pi.ts:522–580, 583–602, 680–705`

```typescript
// PROBLEM: JSON.parse → deep clone → JSON.stringify for every line
for (const line of lines) {
    const parsed = JSON.parse(line);
    const compacted = compactChildPiEvent(parsed);  // Deep clone
    compactedLines.push(JSON.stringify(compacted));
}
```

**Recommendation**: Skip `compactChildPiEvent` for events under 500 bytes — clone+stringify overhead is disproportionate for small events.

---

#### [A1-F11] — Array copies per event in progress tracking

**Severity**: LOW  
**Impact**: ~20ms per task (allocation pressure)  
**File**: `src/runtime/task-runner/progress.ts:107–109`

```typescript
// PROBLEM: Array slice creates copy on every event
recentTools: state.recentTools.slice(-10),
recentOutput: state.recentOutput.slice(-5),
```

**Recommendation**: Use ring buffer instead of array-slice.

---

### 3.5 Algorithm / Task Execution

#### [A1-F3] — `taskGraphSnapshot` multi-pass O(N) → single-pass bucket collection

**Severity**: MEDIUM  
**Impact**: 7 passes (1 map + 6 filters) over task array per scheduling cycle  
**File**: `src/runtime/task-graph-scheduler.ts:130–158`

```typescript
// PROBLEM: 7 separate passes over tasks
const all = taskArray.map(t => categorize(t));           // Pass 1
const ready = all.filter(t => t.status === "pending");   // Pass 2
const blocked = all.filter(t => isBlocked(t));           // Pass 3
const running = all.filter(t => t.status === "running"); // Pass 4
const done = all.filter(t => isTerminal(t) && !t.failed);// Pass 5
const failed = all.filter(t => isTerminal(t) && t.failed);// Pass 6
const cancelled = all.filter(t => t.status === "cancelled"); // Pass 7
```

**Recommendation**: Single O(N) iteration collecting into ready/blocked/running/done/failed/cancelled buckets.

---

#### [A5-C1] — Batch-level serialization: no inter-batch overlap

**Severity**: MEDIUM  
**Impact**: 5–10 minutes per run in DAGs with heterogeneous wave times  
**File**: `src/runtime/team-runner.ts:922–1640`

**Root Cause**: Tasks complete in waves. Wave N+1 doesn't start until ALL Wave N tasks complete, even if Wave N+1 tasks' dependencies were satisfied earlier.

**Recommendation**: Streaming/continuous dispatch — start Wave N+1 tasks as soon as their specific dependencies complete. (Phase 3 per optimization-plan.)

---

#### [A2-F2] — `MAX_TRACKED_STATES=5000` cap behavior

**Severity**: LOW  
**Impact**: Bounded; acceptable  
**File**: `src/runtime/overflow-recovery.ts:34`

---

#### [A1-F15] — `isFinalAssistantEvent` per event check

**Severity**: LOW  
**Impact**: Negligible  
**File**: `src/runtime/child-pi.ts:515`

---

---

## 4. Recommendations — Prioritized by Impact/Risk

### Immediate (Low Risk, High Impact)

| # | Finding | Action | Files | Impact |
|---|---------|--------|-------|--------|
| 1 | **NEW-M1** | Pre-compute stable prefix once per (cwd, role, runId) | `prompt-builder.ts`, `team-runner.ts` | 200–800ms/4-tasks |
| 2 | **A1-F7** | Guard `collectedJsonEvents` behind `yieldEnabled` | `task-runner.ts:296` | ~10KB/task |
| 3 | **A4-F1** | Cache compacted skill content as `{ raw, compacted }` | `skill-instructions.ts` | ~15% skill rendering |
| 4 | **A4-F2** | Verify knowledge section cache covers all callers | `knowledge-injection.ts` | 2–5ms/worker |

### Short-Term (Medium Risk, High Impact)

| # | Finding | Action | Files | Impact |
|---|---------|--------|-------|--------|
| 5 | **NEW-C3** | Add `withRunLock` around task-runner manifest write | `task-runner.ts:1193` | Correctness |
| 6 | **A5-C2** | Convert `persistSingleTaskUpdate` to async lock | `state-helpers.ts:36` | 200–800ms/batch |
| 7 | **A4-F3** | Code-aware token estimation | `token-counter.ts:49` | 10–15% accuracy |

### Medium-Term (Correctness-Sensitive)

| # | Finding | Action | Files | Impact |
|---|---------|--------|-------|--------|
| 8 | **NEW-M2** | Use dirStamp for skill cache freshness | `skill-instructions.ts:128` | 10–80ms/batch |
| 9 | **A1-F5** | Async transcript reads with `fs.promises.open` | `tail-read.ts:11` | ~20ms/task |
| 10 | **A5-C4** | Add lock around retry loop manifest read | `team-runner.ts:1254` | Correctness |

### Long-Term / Architectural (High Risk, High Reward)

| # | Finding | Action | Phase | Impact |
|---|---------|--------|-------|--------|
| 11 | **A5-C1** | Streaming dispatch (inter-batch overlap) | Phase 3 | 5–10 min/run |
| 12 | **A5-C12** | Batched event appends | Phase 2 | 150–750ms/run |

---

## 5. Implementation Roadmap

### Phase 0: Baseline Measurement (Bench-First)

**Before any changes**, establish baselines for the high-impact findings:

```bash
# Run existing benchmarks
npm run bench

# Add new benchmarks for critical paths
npm run bench:persist-single-task  # A5-C2
npm run bench:prompt-stable-prefix # NEW-M1
npm run bench:skill-render         # A4-F1
```

**Target**: Capture p50/p95 before and after each fix. Only proceed if improvement ≥15%.

---

### Phase 1: Quick Wins (1–2 days)

#### 1.1 Fix `collectedJsonEvents` waste (A1-F7)
```typescript
// task-runner.ts
const collectedJsonEvents: ParsedEvent[] | undefined = yieldEnabled ? [] : undefined;

// When accumulating:
if (collectedJsonEvents) {
    collectedJsonEvents.push(event);
    if (collectedJsonEvents.length > MAX_COLLECTED) {
        collectedJsonEvents.splice(0, collectedJsonEvents.length - MAX_COLLECTED);
    }
}
```

#### 1.2 Cache compacted skill content (A4-F1)
```typescript
// skill-instructions.ts
interface CachedSkillMarkdown {
    raw: string;
    compacted: string;  // Add this
    mtimeMs: number;
    size: number;
}
```

#### 1.3 Stable prefix memoization (NEW-M1)
```typescript
// team-runner.ts — batch loop
const stablePrefixCache = new Map<string, string>();

// Before spawning batch
for (const task of batch) {
    const key = `${task.cwd}|${task.agent.role}|${runId}`;
    if (!stablePrefixCache.has(key)) {
        stablePrefixCache.set(key, await computeStablePrefix(task));
    }
    task.stablePrefix = stablePrefixCache.get(key);
}
```

---

### Phase 2: Correctness + Performance (3–5 days)

#### 2.1 Fix `saveRunManifest` lock race (NEW-C3)
```typescript
// task-runner.ts:1193
await withRunLock(runId, () => saveRunManifestAsync(manifest));
```

#### 2.2 Convert `persistSingleTaskUpdate` to async (A5-C2)
```typescript
// state-helpers.ts
export async function persistSingleTaskUpdateAsync(
    manifest: TeamRunManifest,
    taskId: string,
    update: Partial<TeamTaskState>
): Promise<void> {
    await withRunLock(manifest.runId, async () => {
        // Async read + write, single stat on hit
    });
}
```

#### 2.3 Skill cache dirStamp (NEW-M2)
```typescript
// skill-instructions.ts
function dirStamp(skillDir: string): string {
    try { return fs.statSync(skillDir).mtimeMs.toString(); }
    catch { return "0"; }
}
```

---

### Phase 3: Architectural (1–2 weeks)

#### 3.1 Streaming dispatch (A5-C1)
Replace batch loop with continuous dispatch that starts Wave N+1 tasks as soon as their specific dependencies complete.

#### 3.2 Batched event appends (A5-C12)
Collect events during batch, write once at batch end using `appendFile` batch.

---

## 6. Validation Strategy

### Unit Tests

| Finding | Test Coverage |
|---------|---------------|
| NEW-C3 | Test that parallel artifact writes don't lose data |
| A5-C2 | Test async lock doesn't deadlock with sync paths |
| A1-F7 | Test `collectedJsonEvents` is `undefined` for child-process |
| A4-F1 | Test compacted content cached correctly |
| NEW-M1 | Test stable prefix identical across parallel tasks |

### Integration Tests

```bash
# Run full test suite
npm test

# Run with concurrency
npm run test:parallel

# Run benchmarks
npm run bench
npm run bench:check  # Compare against baseline
```

### Benchmark Metrics

| Metric | Tool | Baseline | Target |
|--------|------|----------|--------|
| Task completion latency | `bench:persist-single-task` | TBD | <15% improvement |
| Skill rendering time | `bench:skill-render` | TBD | <15% improvement |
| Stable prefix computation | `bench:prompt-stable-prefix` | TBD | <15% improvement |
| Memory per task | `bench:memory` | TBD | <10KB reduction |
| I/O per task | `bench:io` | TBD | <20% reduction |

### Performance Regression Guards

```bash
# CI: Fail if benchmarks regress >15%
npm run bench:check

# Pre-commit: Run fast unit tests
npm test
```

---

## Appendix A: Findings Summary Table

| ID | Severity | Category | Finding | Impact | Status | File:Line |
|----|----------|----------|---------|--------|--------|-----------|
| NEW-C3 | **CRITICAL** | Concurrency | `saveRunManifest` no lock — write-write race | Silent artifact loss | **NEW** | task-runner.ts:1193 |
| NEW-C6 | **HIGH** | Concurrency | Double lock + redundant disk read in merge | 10–50ms × batches | **NEW** | team-runner.ts:1450 |
| A5-C2 | **HIGH** | Concurrency | `persistSingleTaskUpdate` sync lock blocks event loop | 200–800ms/4-parallel | **NEW** | state-helpers.ts:36 |
| A4-F1 | **HIGH** | Prompt | Redundant skill compaction on cache hit | ~15% waste | **NEW** | skill-instructions.ts:216 |
| A1-F14 | **HIGH** | I/O | Sync `saveRunManifest` on every task completion | 100–1000ms/run | **NEW** | task-runner.ts:1168 |
| NEW-M1 | MEDIUM | I/O/Prompt | Stable prefix recomputed per parallel task | 200–800ms/4-tasks | **NEW** | prompt-builder.ts:123 |
| NEW-M2 | MEDIUM | I/O | Skill cache stat on every cache hit | 10–80ms/4-tasks | **NEW** | skill-instructions.ts:128 |
| A4-F3 | MEDIUM | Prompt | Token estimation 10–15% error for code | Context waste | **NEW** | token-counter.ts:49 |
| A4-F4 | MEDIUM | Algorithm | Staleness index rebuilds O(N) per pruning | O(N) per call | **NEW** | tool-output-pruner.ts:182 |
| A1-F3 | MEDIUM | Algorithm | taskGraphSnapshot 7 passes → 1 pass | 0.1–0.5ms/cycle | **NEW** | task-graph-scheduler.ts:130 |
| A1-F5 | MEDIUM | I/O | tailReadWithLineSnap double stat+read | ~20ms/task | **NEW** | tail-read.ts:11 |
| A1-F7 | MEDIUM | Memory | collectedJsonEvents unused for child-process | 10KB/task waste | **NEW** | task-runner.ts:296 |
| A5-C4 | MEDIUM | Concurrency | loadRunManifestById retry without lock | Low-prob zombie | **NEW** | team-runner.ts:1254 |
| A5-C8 | MEDIUM | Algorithm | Greedy write-overlap filter suboptimal | Unused slot | **NEW** | path-overlap.ts:76 |
| A5-C12 | MEDIUM | I/O | appendEventAsync promise chain unbounded | 150–750ms/run | **NEW** | event-log.ts:453 |
| A2-F1 | MEDIUM | Memory | taskUsageMap no auto-cleanup | Unbounded growth | **NEW** | usage-tracker.ts:38 |
| A5-C1 | MEDIUM | Architecture | Batch serialization — no inter-batch overlap | 5–10 min/run | **NEW** | team-runner.ts:922 |
| A1-F2 | LOW | GC | compactChildPiEvent object churn per line | 250–500ms/task | **NEW** | child-pi.ts:522 |
| A4-F2 | LOW | Prompt | Knowledge section parsing per query | 2–5ms/worker | **NEW** | knowledge-injection.ts:114 |
| A1-F9 | LOW | I/O | Redundant mkdirSync in attempt loop | 0.3ms/task | **NEW** | task-runner.ts:411 |
| A1-F11 | LOW | Memory | Array copies per event in progress | 20ms/task | **NEW** | progress.ts:107 |
| A1-F12 | LOW | I/O | Pretty-print JSON in metadata artifacts | 30–50% size | **NEW** | task-runner.ts:1126 |
| A1-F13 | LOW | Concurrency | backpressureBytes counter never resets | Minor | **NEW** | child-pi.ts:1149 |
| A1-F15 | LOW | CPU | isFinalAssistantEvent per event | Negligible | **NEW** | child-pi.ts:515 |
| A2-F2 | LOW | Memory | MAX_TRACKED_STATES=5000 cap | Bounded | **NEW** | overflow-recovery.ts:34 |

---

## Appendix B: Cross-Reference with Prior Documentation

### vs. `performance-review-2026-07.md`

| Docs Finding | Audit Status | Notes |
|--------------|--------------|-------|
| F1 — Global generation counter | ✅ FIXED | `state-store.ts:82` |
| F2 — persistSingleTaskUpdate sync | ⚠️ PARTIAL | Phase 2 plan exists |
| F3 — fsync per event | ⚠️ PARTIAL | `task.progress` only |
| F4 — tasks.json full rewrite | ⚠️ PARTIAL | Option exists, not migrated |
| F5 — symlink check no cache | ⚠️ PRESENT | No caching yet |
| F6 — mailbox full rewrite | ⚠️ PRESENT | High-risk refactor |
| F8 — execFileSync blocking | ⚠️ PRESENT | All sync worktree ops |
| F9 — rawTextEvents unbounded | ✅ FIXED | Ring buffer cap |
| F12 — finalDrainMs hard | ✅ FIXED | Early-exit on silence |
| F15 — discovery cache TTL | ✅ FIXED | 5000ms |
| F16 — config no cache | ✅ FIXED | 2s TTL + mtime |
| F17 — discoverWorkflows no cache | ✅ FIXED | TTL + dirStamp |

### vs. `optimization-plan-2026-07-verified.md`

| Plan Phase | Item | Audit Status |
|------------|------|--------------|
| Phase 1 | F17 cache discoverWorkflows | ✅ DONE |
| Phase 1 | F15 TTL discovery | ✅ DONE |
| Phase 1 | F4 durability best-effort | ⚠️ PARTIAL |
| Phase 1 | F9 ring buffer | ✅ DONE |
| Phase 2 | F2 stat consolidation | ⚠️ PENDING |
| Phase 2 | F3a fsync terminal only | ⚠️ PENDING |
| Phase 2 | F5 symlink cache | ⚠️ PENDING |
| Phase 2 | F1 generation per-stateRoot | ✅ DONE |
| Phase 3 | F12 early-exit-on-silence | ✅ DONE |
| Phase 3 | F3b buffering deadlock | ⚠️ REVERTED |
| Phase 3 | F6 mailbox append-only | ⚠️ PENDING |
| Phase 3 | In-memory task state | ⚠️ PENDING |

---

*Report generated: 2026-07-11*  
*Source data: adaptive-01 through adaptive-05 exploration artifacts + existing `docs/perf/` documentation*

---

## 7. Benchmark Findings (2026-07-11, post-bench)

A new benchmark `test/bench/terminal-persist-blocking.bench.ts` was added to
empirically answer the A5-C2 question: *does `persistSingleTaskUpdate`'s sync
run lock block the event loop 200–800ms during 4-way parallel completion?*

### Method

Measures the **real persist path** (not just the atomic-write primitive) in
four scenarios, with `monitorEventLoopDelay` capturing true event-loop lag:

1. **serialPersist** — full `persistSingleTaskUpdate` (lock + load + CAS + write), isolated.
2. **saveManifestLarge** — `saveRunManifest` with 60 artifact descriptors (terminal size).
3. **singleTerminalBlock** — ONE full terminal block (saveManifest + persist) = the actual
   per-completion cost. In real runs completions are spread over minutes, so each runs
   exactly one such block.
4. **spacedBurst** — 4 completions spaced by 15ms setTimeout gaps (so the event loop turns
   over between blocks), under `monitorEventLoopDelay`.

### Results (captured in `test/bench/results.json`)

| Metric | p50 | p95 | max |
|--------|-----|-----|-----|
| serialPersist (ms) | 15.17 | 19.28 | 42.96 |
| saveManifestLarge (ms) | 13.99 | 22.18 | 38.94 |
| **singleTerminalBlock (ms)** | **30.28** | **32.83** | **38.92** |
| spacedBurstPerCall (ms) | 28.20 | 34.72 | 68.81 |
| eventLoopDelay (ms) | 1.09 | 29.69 | 210.11 |
| **contentionRatio** | **0.93** | — | — |

**contentionRatio was 0.93 / 0.98 / 0.96 / 0.98 across four independent runs** —
consistently ≈ 1.0.

### Verdict: A5-C2 disproven

- **contentionRatio ≈ 1.0** means a completion's per-call latency under a 4-way
  burst is **statistically identical** to a single isolated block. There is
  **no lock contention** to relieve. The audit's premise ("4 tasks serialize
  on the lock → `sleepSync` blocks 200–800ms") does not hold.

- **Why**: JavaScript is single-threaded. `withRunLockSync`'s critical section
  is fully synchronous, so concurrent `mapConcurrent` completions **cannot
  overlap** — worker A's persist runs atomically to completion, then worker B's
  runs. By the time B runs, A has released the lock (re-entrance map cleared),
  so B acquires fresh via `O_EXCL` on the first try — `sleepSync`/`Atomics.wait`
  **never triggers** for same-process workers. It only triggers under genuine
  *cross-process* contention (a separate OS process holding the lock file),
  which doesn't happen for in-process task completion.

- **Real per-completion cost**: ~30ms p50 (one sync block). Real runs spread
  completions over minutes, so this is ~30ms of event-loop blocking per
  completion — acceptable for a CLI tool (no sub-16ms interactive frame budget
  during that moment). The `eventLoopDelay` max of ~210ms is an occasional
  fsync/GC outlier, **not** lock contention — and is the same fsync-cost issue
  already tracked as F3/F4 in the prior review.

- **Why the async conversion wouldn't help even if applied**: `persistSingleTaskUpdate`'s
  body is fully synchronous I/O (`loadRunManifestById`, `saveRunTasksCoalesced`,
  `statSync`). Converting only the lock to async leaves the body I/O synchronous,
  so event-loop blocking from the I/O persists regardless. Removing it would
  require converting the entire persist path to async I/O — a much larger,
  higher-risk refactor — for ~30ms of infrequent blocking that doesn't matter
  in practice.

### Recommendation

**Do not implement A5-C2 as specified.** The 11+ call-site + `checkpointTask`
ripple (with deadlock risk) buys nothing measurable. If event-loop blocking
from the persist path ever becomes a real problem (e.g. a highly concurrent
interactive TUI), the correct target is **async I/O throughout
`persistSingleTaskUpdate`** + a benchmark proving the win — not the lock
conversion.

### What this benchmark is now good for

`terminal-persist-blocking.bench.ts` is a durable regression guard: any future
change to the persist/lock path can be re-benched to confirm `contentionRatio`
stays ≈1.0 and `singleTerminalBlock` doesn't regress.
