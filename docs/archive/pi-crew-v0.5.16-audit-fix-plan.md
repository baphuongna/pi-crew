# Round 22 Audit Fix Plan (Defensive Caps)

## Findings

### Issue 1: `autoRecoveryLast` Map grows unboundedly (MEDIUM, MEMORY)
- **File**: `src/extension/register.ts:484`
- **What**: Module-level `Map<string, number>` keyed by `${kind}_${runId}`. Holds cooldown timestamps for "recovery notifications" (5-minute gate per key).
- **Bug**: Entries are NEVER removed during a session. Each run contributes up to 4 keys (one per `maybeNotifyHealth` kind). Long-running pi sessions that run 1000+ teams accumulate 4000+ entries (~32KB).
- **Severity**: MEDIUM — silent memory growth in long-running process. Not a security issue.
- **Fix**: Add `AUTO_RECOVERY_LAST_MAX_ENTRIES` cap. Evict oldest insertion (matches the 5-min cooldown gate semantics — once the gate has expired, the entry is irrelevant). The eviction loop runs on each `set()` to amortize the cost.

### Issue 2: `agentEventSeqCache` Map grows unboundedly (MEDIUM, MEMORY)
- **File**: `src/runtime/crew-agent-records.ts:265`
- **What**: Module-level `Map<string, { size, mtimeMs, seq }>` keyed by `filePath` (each agent event log). Caches the `.seq` sidecar value.
- **Bug**: Entries are NEVER removed. Each new agent task creates a new event log file, adding a cache entry. A long-running pi-crew process that spawns 1000s of agents accumulates 1000s of entries.
- **Severity**: MEDIUM — silent memory growth. Plus, stale entries mask filesystem changes (mtime/size won't reflect a re-created file).
- **Fix**: Add `AGENT_EVENT_SEQ_CACHE_MAX_ENTRIES` cap. Evict oldest insertion first (mirrors the `asyncAgentReaderCache` pattern at line 134-136 in the same file).

## Plan (2 phases)

### Phase 1: `autoRecoveryLast` defensive cap
- `src/extension/register.ts:484` — add `AUTO_RECOVERY_LAST_MAX_ENTRIES = 1000` constant
- Modify the `set()` site at line 1534 to evict oldest entries before inserting when size > cap
- Add test in `test/unit/auto-recovery-cap.test.ts`

### Phase 2: `agentEventSeqCache` defensive cap
- `src/runtime/crew-agent-records.ts:265` — add `AGENT_EVENT_SEQ_CACHE_MAX_ENTRIES = 1000` constant
- Add helper function `setAgentEventSeqCache()` that wraps the `.set()` and evicts oldest entries
- Add test in `test/unit/crew-agent-records.test.ts` (or new file)

## Expected impact
- 2 new tests, 0 regressions
- Total: 2 MEDIUM memory-leak fixes
- No public API changes
- Pattern: follows existing `NotificationRouter.SEEN_MAP_MAX_SIZE` and `asyncAgentReaderCache` patterns in the codebase
