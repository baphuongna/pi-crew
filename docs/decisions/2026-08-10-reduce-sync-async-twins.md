# ADR: Reduce sync/async twin duplication (B.1 worktree, B.2 state-store)

**Date:** 2026-08-10

## Status

Proposed — implementation gated on contract-test-first
**Supersedes:** the B.1 / B.2 items in `docs/improvement-plan-2026-08-09.md`
(which were originally framed as "extract shared helpers" — the framing
turned out to understate the work; see Context).

## Context

Several core modules have a `*Sync` and a `*Async` twin for every public
I/O function (worktree-manager: 7 pairs, state-store: 3 pairs, event-log:
multiple). The improvement plan (Group B) listed these as
"feasible with care" refactors to reduce duplication.

**Investigation during the 2026-08-10 implementation attempt found that
the twins are NOT pure sync/async wrappers around identical logic.** Each
pair carries independent behavioural drift:

- `findGitRoot` (sync, `worktree-manager.ts:132`) does NOT cache. Its
  async twin `findGitRootAsync` (`:157`) caches in `_gitRootCache`.
- `assertCleanLeader` (sync, `:136`) does NOT cache. The async twin
  `assertCleanLeaderAsync` (`:173`) caches in `_cleanLeaderCache`.
- The async paths generally use caches the sync paths lack, because the
  sync paths are called from render-critical code paths where a cache
  lookup is itself considered overhead, or because callers above already
  hold a cached value.

Trivially extracting a "shared helper" would either:
- **Drop the async cache** (perf regression on the hot async path), or
- **Add a cache to sync** (changes behaviour under concurrent callers,
  and may interact with the run lock in ways the sync path does not
  expect).

Both are silent regressions.

## Decision

**Do NOT extract shared helpers as a mechanical refactor.** Instead,
reduce duplication through a disciplined, test-first, phased approach
gated on three prerequisites:

### Prerequisite 1 — Contract test sync≡async (must exist and pass first)

For each twin pair, a test must assert that sync and async produce
*equivalent observable behaviour* (return value, thrown error class,
side-effect on disk). Where the twins intentionally diverge (cache,
timing), the test must document the divergence explicitly with an
assertion + comment.

These tests do not exist today. They are the single most important
deliverable of B.1/B.2 — without them, any refactor is unverifiable.

### Prerequisite 2 — Behavioural unify decision per pair (in this ADR's appendix)

For each pair where the twins diverge, decide and record:
- Keep sync uncached, async cached (status quo) — then shared helper
  takes a `useCache` flag.
- Unify to cached both — sync path must be audited for concurrent-run
  safety against the run lock.
- Unify to uncached both — accept the async perf cost.

The default is "status quo with explicit flag" because the existing
divergence exists for reasons even if undocumented.

### Prerequisite 3 — Phased rollout (one pair per PR)

Each twin pair is extracted in its own PR with:
1. Contract test added (Prerequisite 1) — must pass against current code.
2. Behavioural-unify patch (Prerequisite 2) — contract test still passes.
3. Extraction of shared helper — contract test still passes.
4. Full `npm run test:critical` + relevant unit + integration suites green.

No pair is bundled with another. A regression in one pair must not
mask a regression in another.

## Scope

### B.1 — worktree-manager.ts (7 pairs)

| Pair | Drift | Risk |
|---|---|---|
| `findGitRoot` / `findGitRootAsync` | async caches in `_gitRootCache` | Low — pure return value |
| `assertCleanLeader` / `assertCleanLeaderAsync` | async caches in `_cleanLeaderCache` | Low — side-effect free |
| `captureWorktreeDiff` / `Async` | TBD — read before refactor | Med |
| `captureWorktreeDiffStat` / `Async` | TBD | Med |
| `cleanupAgentWorktree` / `Async` | TBD — touches fs + git | High |
| `prepareAgentWorktree` / `Async` | TBD | High |
| `prepareTaskWorkspace` / `Async` | TBD — the largest twin, ~160 lines each | **Highest** — leave for last |

Order: lowest-risk first (`findGitRoot`, `assertCleanLeader`), highest-risk
last (`prepareTaskWorkspace`). Stop and re-AUDIT if any phase goes red.

### B.2 — state-store.ts (3 pairs)

| Pair | Risk | Note |
|---|---|---|
| `loadRunManifestById` / `Async` | **Critical** | Touches the monotonic-merge read path. Drift here = silent data loss. Contract test must cover the mtime/size/generation cache triple-check. |
| `saveRunManifest` / `Async` | **Critical** | Touches run-lock + cache invalidation. |
| `saveRunTasks` / `Async` | High | Coalescer path; async uses `saveRunTasksCoalesced` |

**B.2 is more dangerous than B.1** because it touches the durability
core. Recommend completing all of B.1 first as a confidence builder
before any B.2 pair lands.

## Alternatives considered

1. **Mechanical extract now, fix drift later.** Rejected — silent
   regressions in the durability core are exactly the class of bug this
   codebase has spent 100+ review rounds eliminating.
2. **Delete the sync paths entirely, force all callers async.** Tentatively
   attractive (eliminates duplication by deleting one twin), but the
   render path needs sync reads and the snapshot cache pre-warm design
   assumes sync availability. Would require a separate audit of every
   `loadRunManifestById` call site. Defer to a follow-up ADR if the
   contract-test work reveals sync is truly unused.
3. **Status quo — leave the drift.** Rejected for the long term: the
   twins will keep drifting further apart with each fix applied to one
   but not the other (the ST-15 duplicated comments already show this
   happening). But accepted as the **short-term** outcome until the
   contract tests land.

## Out of scope for this ADR

- The event-log sync/async twin (`appendEvent` / `appendEventAsync`).
  These use disjoint lock namespaces by design (`.mkdirlock` vs `.alock`
  — see `event-log.ts:490-506`) and the duplication is load-bearing for
  the deadlock-prevention contract. Do NOT touch without a separate ADR.
- The `team-runner.ts` split. That is a separate refactor with its own
  race-condition surface (forward-sync dance). Track independently.

## Success criteria

- All twin pairs have a passing contract test before any extraction.
- Each extraction PR is Green: `typecheck`, `test:critical`, the new
  contract test, and the relevant module's existing unit tests.
- No behaviour change observable to callers — verified by the contract
  tests passing both before and after extraction.
- Long-term: the `ST-15` duplicated-comment pattern (same fix note
  copy-pasted across both twins) disappears, because there is only one
  place to put the comment.

## References

- `docs/improvement-plan-2026-08-09.md` Group B (the original items)
- `src/worktree/worktree-manager.ts` lines 132-182 (the drift examples)
- `src/state/stores/state-store.ts` (the durability-critical twins)
- Historical: ST-15 comments duplicated across twins; Round 29 ST-3-FIX
  cross-tier coordination (locks.ts) — same class of subtle drift
