# ADR — Live-session graduate-or-freeze decision

**Date**: 2026-09-10
**Status**: ACCEPTED — verdict **FROZEN-EXPERIMENTAL** (Option B + bound-issues)
**Supersedes**: existing `live-session.experimental` warn-once (unchanged)
**Refs**:
- `pi-crew-upgrade-spec.md` §5 M4 / WI-4.4
- `docs/archive/improvement-plan-2026-08-09.md` (precursor plan)
- `docs/perf/performance-audit-2026-07-29.md` P2-29, P2-14
- `docs/TEST_MATRIX.md` (live-session row)

## Context

`src/runtime/live-session/*.ts` is the second-largest live surface in
`src/runtime/` (live-session-runtime.ts = 1267 lines; the next 4 files
under 500 each). The PRD/spec frame the choice as "graduate to stable" or
"keep frozen-experimental with documented bound issues". This ADR records
the decision.

### Open issues (evidence-based, file:line)

1. **P2-29 — unbounded `stdout +=` accumulator** (`live-session-runtime.ts:621, 871`)
   Unlike the child-process path, this accumulator has no cap.
2. **P2-29 — synchronous disk I/O per event** (`live-session-runtime.ts:829-845`)
   `mkdirSync(dirname)` + `redactSecrets` + `appendFileSync` in the
   subscriber hot path (every event). For a 100-event burst this is 100
   file opens + 100 redacts on the event loop.
3. **500 ms `pollControl`** (`live-session-runtime.ts:816-818`) — fixed
   interval regardless of activity.
4. **1500 ms SDK probe** in `resolveCrewRuntime` for the live-session
   resolution path, not memoized across runs in a session.
5. **Bug #21** (`task-runner.ts:725`) — live-session may not produce
   structured output via `submit_result` (intermittent).
6. **TEST_MATRIX row** — only 3 tests for live-session; coverage
   thin relative to feature surface.

### Active mitigations (already on HEAD)

- **Warn-once at startup** (`live-session-runtime.ts:93-96, 565-568`)
  Emits `live-session.experimental` logInternalError at most once per process.
  Documented in code as a deliberate tripwire for solo-maintainer awareness.
- **Runtime convergence ADR** (2026-08-15) — Phase 4 freezes some divergent
  code paths; live-session-core is NOT yet convergence-frozen.

## Decision

**Verdict: FROZEN-EXPERIMENTAL — Option B with bound-issues documented.**

The work needed to graduate to stable is real engineering (P2-29 fix +
verification + bug #21 root-cause + coverage extension), and the solo
maintainer cannot absorb it within the M4 exit window without sacrificing
other M4/M5 deliverables.

### Constraints

1. **No new runtime mode changes** (anti-goal §2).
2. **No new config keys without deprecation path** (anti-goal §2).
3. **Live-session stays opt-in by default false for new runs**;
   `runtime.mode = "auto"` already prefers `child-process` unless
   `preferLiveSession = true` — that gate remains.

### What changes

- **Nothing in code** — `experimentalWarned` + warn-once stays.
- This ADR is the source of truth for the verdict.
- TEST_MATRIX row gets a one-line note: "frozen-experimental; see WI-4.4 ADR".

### What does NOT change (explicit non-goals)

- No new tests added in this window (WI-3.x already has the priority).
- No refactor of live-session-runtime.ts (under 2000-line gate anyway).
- No new feature work on the live-session surface.

## Consequences

### Positive
- Preserves M4/M5 calendar (no live-session regression risk during
  structural decomposition of crew-broker).
- Honest signal to consumers: live-session is NOT stable for prod use.
- Open issues 1-6 are explicit, file:lined, not lurking.

### Negative
- Carries ongoing accuracy debt in TEST_MATRIX (3/3 means "scope-locked",
  not "feature-complete").
- A user wanting live-session retains the warning-once noise on first run.

## Re-evaluation triggers

This ADR is reviewed and superseded when ANY of these complete:

a. **P2-29 fix lands**: unbound `stdout +=` capped or migrated to
   streaming, sync-IO moved off the hot path. Then Option A can be re-elected.
b. **Test coverage extends** to ≥10 live-session tests with documented
   feature-surface coverage (not just smoke).
c. **Bug #21 root cause identified** with regression test.
d. **M5 (config migration) ships** so that a `liveSession.stable = true`
   config flip can be used as the gate (instead of the implicit warn-once).

When (a) is true AND at least one of (b) or (c) lands, a new ADR is
written with verdict GRADUATE.

## Appendix — bound-issues tracking

The 6 open issues above are "bound", not "ignored". Tracking table:

| # | Issue | File:Line | Bound-by | Reopen |
|---|---|---|---|---|
| 1 | Unbounded `stdout +=` | live-session-runtime.ts:621,871 | this ADR §P2-29 | when stream-cap fix lands |
| 2 | Sync disk I/O per event | live-session-runtime.ts:829-845 | this ADR §P2-29 | when batched append lands |
| 3 | 500ms pollControl | live-session-runtime.ts:816-818 | this ADR §perf | when activity-adaptive polling lands |
| 4 | 1500ms SDK probe | runtime-resolver.ts:34 | this ADR §perf | when memoization per session lands |
| 5 | Bug #21 missing submit_result | task-runner.ts:725 | tracking issue | when reproducible |
| 6 | TEST_MATRIX 3 tests | docs/TEST_MATRIX.md | this ADR | when ≥10 tests covering core surfaces |

Closing any of these requires its own PR + ADR superseding this one.
