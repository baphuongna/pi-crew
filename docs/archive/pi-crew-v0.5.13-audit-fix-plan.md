# pi-crew v0.5.13 Audit Fix Plan (Round 18)

## Source Verification Findings

I read the following files and identified 4 confirmed real issues:

### Issue 1: `benchmark-runner.ts` uses `execSync` instead of `execFileSync` (HIGH security)
**File**: `src/benchmark/benchmark-runner.ts:4,110,119,128`

```ts
import { execSync } from "child_process";
// ...
output = execSync(judge.command, { ... });
```

`execSync(command, ...)` invokes a shell to parse the command, even when `validateCommand` is run first. The `validateCommand` function only checks for shell metacharacters in the *arguments* (after the first space), but:
- It does not escape/quote arguments safely
- A bug in `validateCommand` or a clever input could bypass
- `cwd: process.cwd()` could be inherited from a parent context
- Best practice: use `execFileSync` with `command.split(' ')[0]` and the rest as args, so no shell is invoked

**Fix**: Switch to `execFileSync` with command split into program + args. Keep `validateCommand` as defense-in-depth but no longer rely on it alone.

### Issue 2: `BM25Search.df()` is O(N) per call and called inside the search loop (MEDIUM performance)
**File**: `src/utils/bm25-search.ts:47-65, 75-104`

The `df()` function is called for every query term in the search loop, and itself iterates over all documents. This means:
- For a query with `Q` terms and `N` documents, `df()` is called `Q * N` times
- Each `df()` call iterates over `N` documents and `field_count` fields
- Total complexity: **O(Q² * N² * field_count)**

This is quadratic when it should be linear. Document frequencies don't change between `search()` calls for the same document set, so they should be cached.

**Fix**: Precompute `df` once in the constructor (or lazily on first search) and cache it as a Map<term, number>. Re-compute only when documents change.

### Issue 3: `SharedScanCache.set()` LRU eviction is by insertion order, not access order (LOW)
**File**: `src/utils/scan-cache.ts:62-69`

The eviction policy evicts the *oldest inserted* entry, not the *least recently accessed*. So if a frequently-updated entry is inserted, then later entries are inserted, the frequently-updated one (which is the *same* Map key) won't be moved to the end of the insertion order — it stays at the head and is the next to be evicted.

This is a minor issue because:
- In practice, scan cache entries are short-lived (TTL=1s by default)
- The eviction only matters when entries hit the `maxEntries` cap

**Fix**: Either document the limitation or implement proper LRU. For now, document it.

### Issue 4: `bm25-search.ts` has no tests (LOW coverage)
**File**: `test/unit/bm25-search.test.ts` — does not exist

BM25Search is a non-trivial search algorithm. Currently zero test coverage. Should add tests for:
- Basic search returns relevant results
- Field weighting affects ranking
- minScore threshold
- limit cap
- Empty query returns empty results
- df() precomputation (after Issue 2 fix)

## Plan (4 phases)

### Phase 1: Switch `benchmark-runner.ts` to `execFileSync`
- Replace `execSync(judge.command, ...)` with `execFileSync(program, args, ...)`
- Keep `validateCommand` as defense-in-depth
- Add new tests for benchmark-runner

### Phase 2: Precompute `df` in BM25Search
- Cache `df` map per corpus
- Invalidate when documents change (or recompute on construction)
- Add tests to verify behavior unchanged

### Phase 3: Add tests for scan-cache, benchmark, bm25-search
- `test/unit/scan-cache.test.ts`
- `test/unit/benchmark.test.ts`
- `test/unit/bm25-search.test.ts`

### Phase 4: Release v0.5.13
