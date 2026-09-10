# WI-4.3 — worktree-manager twins consolidation (PARTIAL)

**Status**: PARTIAL — Prerequisite 1 done; extraction deferred.
**Date**: 2026-09-10
**Refs**: pi-crew-upgrade-spec.md §5 M4 / WI-4.3, ADR 2026-08-10-reduce-sync-async-twins.md

## Spec scope

WI-4.3 (spec §5 M4): "Twins phase 1: gộp 2/7 cặp worktree-manager theo
ADR 2026-08-10 (contract-test-first)".

ADR-2026-08-10 mandates a three-step process for any twin extraction:
1. Contract test sync≡async (must pass before any extraction).
2. Behavioural-unify decision per pair (e.g. shared cache flag).
3. Extraction of shared helper (one pair per PR).

## What this PR delivers

**Prerequisite 1 for the lowest-risk pair**: `findGitRoot` /
`findGitRootAsync`.

- New test `test/unit/worktree/worktree-twins-contract.test.ts` (4 tests):
  - Both resolve same root for repo cwd.
  - Both resolve same root from subdirectory.
  - Both throw on non-git directory (same error class).
  - Async cache (`_gitRootCache`) and sync cache (`syncGitRootCache`) are
    independent — clearing async doesn't affect sync.

Mutation demo implied: clearing the async cache should not flip the sync
result. Asserted in test 4.

## Why extraction is deferred

Extracting a shared helper for `findGitRoot` requires deciding:
- Cache strategy: shared FIFO cache (with size cap 256), per-run cache, or
  no cache.
- Clear semantics: do we keep `clearGitRootCache()` (async-only) or
  generalize to both? The ADR flags this as "highest complexity per pair".

This is a non-trivial decision that needs ~2-3 hours of focused work
(cache strategy + clear semantics + extraction + verify on bench).
The solo maintainer budget for this window did not accommodate it; safer
to land the contract test first as the prerequisite, then extract in a
follow-up PR.

## Verdict

- **Prerequisite 1 done**: contract test exists, passes (4/4 green).
- **Prerequisite 2 status**: NOT STARTED for findGitRoot pair; carry-over.
- **Prerequisite 3 status**: NOT STARTED; gated on Prerequisite 2.
- **Second pair** (`assertCleanLeader` / `assertCleanLeaderAsync`):
  NO PROGRESS; deferred to next PR (the two lowest-risk pairs travel
  together for ADR §Phased rollout spec).

## Re-evaluation

WI-4.3 stays PARTIAL until:
1. Prerequisite 2 decision recorded in this ADR's appendix.
2. Extraction PR lands (single pair per PR per ADR).
3. Bench has rerun (per M1 WI-1.x; b3 jsonl writes test is the relevant
   one for worktree-manager hot path).

A complete WI-4.3 means 2 pairs merged, each with contract test + ADR
delta + extraction + bench delta.

## Bench delta not measured

The M1 bench (b3 = 0.09–0.73ms/jsonl) doesn't directly probe worktree
manager. Adding a bench for findGitRoot hot path is out of scope for
this window; flag for M3 WI-3.0b if M3 measurement work revives.

## Citation

- Contract test: `test/unit/worktree/worktree-twins-contract.test.ts`
- ADR: `docs/decisions/2026-08-10-reduce-sync-async-twins.md`
- Worktree manager: `src/worktree/worktree-manager.ts:155,203`
