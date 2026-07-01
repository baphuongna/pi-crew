# pi-crew v0.5.9 — Round 14 Audit Fix Plan (2026-06-02)

**Source**: Dogfooding review run by `review` team on 2026-06-02.
**Findings verified**: 22 from review → 19 confirmed (3 false positives).
**Plan**: 5 phases, organized by severity and dependency.

## Verification Summary

| Status | Count |
|--------|-------|
| ✅ CONFIRMED (real issue) | 19 |
| ❌ FALSE POSITIVE (review wrong) | 3 |

### False Positives Identified
- **H5**: Config double-merge — actually correct (project first, user on top)
- **M-2**: `as unknown as T` inconsistency — both lines 236 and 247 use `as TeamEvent`
- (other minor false positives omitted)

## Phases Overview

### Phase 1: Sandbox Security (CRITICAL)
- **C1**: Sandbox `process.env` full leak → use whitelist
- **C2**: `executeAsync` bypasses validation → add validation
- **C3**: Nested `env` not deeply frozen → `Object.freeze` recursively
- **C4 (low)**: Promise/Symbol prototype escape risk

**Files**: `src/runtime/sandbox.ts`

### Phase 2: Event Log Correctness (HIGH)
- **H1**: `asyncQueues` leak on success → delete on `.then`
- **H2/H3**: Buffer queue splice hangs promises → reject dropped items
- **H7**: `readEventsCursor` reads entire file → stream-based fallback

**Files**: `src/state/event-log.ts`

### Phase 3: Lock Robustness (HIGH)
- **Locks async**: `acquireLockWithRetryAsync` missing PID check → add `isLockHolderAlive`

**Files**: `src/state/locks.ts`

### Phase 4: Configuration & Env Hardening (HIGH/MEDIUM)
- **H8**: OTLP endpoint no URL validation → validate `http://`/`https://` + domain allowlist
- **PI_TEAMS_HOME**: env var path not validated → restrict to user home
- **TIMEOUT**: `PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS` unbounded → add min/max bounds

**Files**: `src/config/config.ts`, `src/schema/config-schema.ts`, `src/runtime/child-pi.ts`

### Phase 5: Code Quality (MEDIUM/LOW)
- **tool-render.ts**: Replace 9× `as any` with proper types
- **pi-ui-compat.ts**: Replace `as never` with proper types
- **safe-bash.ts**: Document `allowPatterns` bypass risk
- **gh-protocol.ts**: Replace `execSync` with `execFileSync`
- **atomic-write.ts**: Document Windows fallback non-atomic behavior
- **coalesced writes**: Document 50ms race window

**Files**: `src/ui/tool-render.ts`, `src/ui/pi-ui-compat.ts`, `src/tools/safe-bash.ts`, `src/utils/gh-protocol.ts`, `src/state/atomic-write.ts`

## Implementation Order (by dependency)

1. **Phase 1** (Sandbox Security) — highest impact, unblocks other phases
2. **Phase 2** (Event Log) — correctness issues, can cause data loss
3. **Phase 3** (Locks) — small fix, complements existing sync path
4. **Phase 4** (Config/Env) — security boundaries
5. **Phase 5** (Code Quality) — cleanup, non-functional

## Backlog (deferred)

- `executeUnchecked` public API — risk is low (sandbox still applies), defer
- `Promise`/`Symbol` in sandbox globals — theoretical risk, no exploit path documented
- Test coverage gaps — add incrementally as we fix each phase

## Verification Plan

For each fix:
1. Read the actual source file at the line indicated
2. Confirm the issue exists
3. Apply the fix
4. Run `npm test` (must pass)
5. Run `npm run typecheck` (must pass)
6. Add a test case for the fix (where applicable)
7. Commit and document

## Expected Outcomes

- 19/19 confirmed issues fixed (100% of verified findings)
- Tests: 2282+ tests pass (0 failures)
- TypeScript: 0 errors
- v0.5.9 release with comprehensive changelog
