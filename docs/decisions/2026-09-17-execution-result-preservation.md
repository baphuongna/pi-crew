# Execution result boundary: forward `surfaceLost` and `rawFinalText`, don't hand-copy

Date: 2026-09-17

## Status

Accepted

## Context

`task-runner.ts` bridges the runtime branches to the finalizer by hand-copying
fields into the `TaskExecutionResult` literal. It copied 11 fields and dropped
`surfaceLost` and `rawFinalText` — both already declared optional on the
interface, produced by `child-executor.ts`, and consumed by
`post-execution.ts`. Optional fields, so `typecheck` stayed green. The
consequence was deterministic (verified stronger than the review): for a
child-process worker that lost its surface, `collectYieldEvents` is false
(→ `noYield` never set), the bug-026 gate requires `resultArtifact?.path` but
the degrade branch returns `undefined` by design (→ `error` never set), so the
status expression resolved to `completed` and emitted `task.completed` — a
phantom completion with no result. Second-order loss:
`planHeadlessRedeplays` only requeues `needs_attention`/`running`, so the
recovery mechanism designed to save this task actively refused it. The existing
test called `finalizeTaskResult` directly with a hand-built result, bypassing
the broken adapter — it could never catch this. Story:
`docs/stories/RR-013/` (F04).

## Decision

- `task-runner.ts` forwards `surfaceLost` and `rawFinalText` from the
  child-process branch result (two locals) into the `TaskExecutionResult`
  literal passed to `finalizeTaskResult`. The live-session and scaffold
  branches leave both `undefined` — their behavior is unchanged.
- The regression test MUST drive the real `runTeamTask` API end-to-end via the
  mock child-pi fixtures (`PI_TEAMS_MOCK_CHILD_PI` + `PI_CREW_ALLOW_MOCK`),
  never the finalizer directly.
- Explicitly NOT done (deferred with rationale):
  - Converting `TaskExecutionResult` to a shared discriminated union — the
    durable fix for the dropped-field class; the hand-maintained field list
    still exists and needs its own ADR.
  - Loosening the bug-026 gate — it would fabricate artifacts (the gate
    requiring `resultArtifact?.path` is intentional).

## Alternatives Considered

1. Fix the bug-026 gate to catch "empty result without artifact" — fabricates
   results or flips to `failed`; inverts the spec (lost worker ≠ empty result).
2. Delete the finalizer's `surfaceLost` branch as dead code — dead-unreachable
   is the bug, not the design; this deletes the recovery feature.
3. Set `surfaceLost` into `ctx` from the child executor — two sources of truth
   for terminal state (breaks CORE-5 layering).
4. Union refactor in this story — blast radius across every runtime branch;
   needs its own ADR.
5. Make the two fields required — API churn on an exported type, not needed.
6. Test via the finalizer directly — the original mistake, repeated.
7. Let `planHeadlessRedeplays` accept `completed` — requeues genuinely
   completed tasks.

## Consequences

Positive:
- A task that loses its surface now deterministically reports
  `needs_attention` (previously: `completed` with no result) and becomes
  eligible for headless requeue exactly once — restoring the intent of the
  mux-surface spec §7 D3 without consuming retry budget.
- `rawFinalText` reaches the footer/spec-evidence union on every child-process
  task, as its docstring promises.

Tradeoffs:
- Observable terminal-state change for surface-lost tasks (`completed` →
  `needs_attention`) — release note required.
- The hand-maintained field list still exists; a future field can still be
  dropped until the union refactor lands (tracked as follow-up).

## References

- Story: `docs/stories/RR-013/`; spec
  `docs/superpowers/specs/2026-08-26-mux-surface-design.md` §7 D3
- Verification: `docs/archive/2026-09-17-pi-crew-review-verification.md` §4 F04
- Code: `src/runtime/task-runner.ts` (bridge),
  `src/runtime/task-runner/child-executor.ts` (producer),
  `src/runtime/task-runner/post-execution.ts` (finalizer/consumer),
  `src/runtime/child-pi/mock-fixtures.ts` (test fixtures)
