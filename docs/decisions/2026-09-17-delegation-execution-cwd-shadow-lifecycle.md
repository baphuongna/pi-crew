# Delegate grandchild: execution cwd from the parent task record; broker owns the shadow lifecycle

Date: 2026-09-17

## Status

Accepted

## Context

Two defects in the `delegate.request` handler (story `docs/stories/RR-012/`,
findings F03 + F16; design contract: ADR-5
`docs/decisions/2026-08-17-governed-nesting.md`). **F03:** the broker wrote the
`gc-*` shadow record with `task.cwd` but spawned the grandchild with the
BROKER cwd — in worktree mode (opt-in per correction C3) a delegated executor
ran outside the workspace admission had checked, the overlap check evaluated
the wrong path, and artifacts landed in the leader workspace because
`delegate-spawn.ts` derived its root from `input.cwd` instead of the existing
`grandchildArtifactsRoot()` helper (two formulas, drift waiting to happen).
**F16:** admission requires the parent to be `running`, but the shadow was
created `queued` and nothing ever promoted it (no `onSpawn` passed, no
reconciler touches `gc-*`) — so a depth-2 grandchild delegating to depth 3 was
rejected `parent-not-running` as `bad-params` even when policy allows it.

Adjacent risk (verification §6.1), RESOLVED during implementation: the shadow
record has `dependsOn: []`, no `stepId`, and `agent: "delegate"`, so a real
`selectDispatchBatch` tick could select it and `findStep()` would throw
`ResourceNotFound`, aborting the run. It was PROVEN reachable end-to-end
(a real dispatch tick selected the shadow and threw), not just argued.

## Decision

- **One execution cwd.** The delegate grandchild executes at the parent TASK's
  cwd, read from the locked fresh task snapshot inside admission. The single
  `executionCwd` feeds the overlap check, the shadow record, AND the spawner
  input; the broker cwd (`this.options.cwd`) is used ONLY for manifest lookup.
  `delegate-spawn.ts` uses `grandchildArtifactsRoot()` as the single formula.
- **Broker owns the shadow lifecycle.** The broker passes an `onSpawn` hook to
  the spawner; `promoteShadowToRunning()` (new
  `src/runtime/broker/delegate/shadow-lifecycle.ts`) flips `gc-*`
  queued→running — idempotent (only a record still `queued` is flipped;
  terminal flips and the stale-reconciler always win), run-locked, best-effort
  (failure logs and the terminal flip on settle still closes the record). The
  unconditional terminal flip on settle (ok / !ok / throw) closes every
  outcome, so depth-2 → depth-3 delegation no longer fails
  `parent-not-running`.
- **Shadow tasks stay out of the scheduler.** `selectDispatchBatch` excludes
  delegate shadow tasks from DAG nodes and from `readyBeforeFilter`,
  discriminated by the pre-existing `agent: "delegate"` marker
  (`isDelegateShadowTask`). No `try/catch` around `findStep()` — that would
  mask the symptom.
- `crew-broker.ts` stays at exactly 2000/2000 lines (wc-gate); the promote
  helper lives in its own module.

## Alternatives Considered

1. Reassign `const cwd = this.options.cwd` to `task.cwd` — breaks manifest
   lookup, which needs the broker/root cwd.
2. Add a parallel `cwdOverride` field — two fields, one meaning; future drift.
3. Resolve the worktree inside `delegate-spawn.ts` — state read outside the
   run lock (race with merge-loop); spawner becomes stateful.
4. Loosen admission to accept `queued` parents — weakens a safety gate shared
   by every task to paper over one mislabeled record.
5. Promote inside the admission lock (before spawn) — `running` with no worker;
   violates "running = a worker exists".
6. Watcher/reconciler promoting `gc-*` — polling for a transition whose time is
   known (`onSpawn`); contradicts stale-reconciler's design.
7. Drop the shadow record — breaks ADR-5 S1#1 (unbounded-chain escalation fix).

## Consequences

Positive:
- A delegated executor cannot escape the admitted workspace in worktree mode.
- Depth ≥ 3 nesting works as ADR-5 §3/§4 intended; `team status` shows the
  grandchild as `running` while it runs.
- The scheduler can no longer abort a run on a shadow record.

Tradeoffs:
- One extra `tasks.json` write per delegate (the promote), under the same run
  lock as the terminal flip.
- Observable status change for `gc-*` records (queued → running) — release note.
- Residual (documented): a queued shadow that is the only remaining task can
  still mark a run blocked; the window is shrunk to admission→`onSpawn`.

## References

- Story: `docs/stories/RR-012/`; reachability proof pinned in
  `test/unit/runtime/broker/shadow-task-dag-readiness.test.ts`
- Code: `src/runtime/broker/crew-broker.ts` (delegate handler),
  `src/runtime/broker/delegate/shadow-lifecycle.ts`, `src/runtime/delegate-spawn.ts`,
  `src/runtime/dispatch-batch.ts`
- Contract: `docs/decisions/2026-08-17-governed-nesting.md` (ADR-5 §1/§3/§4/§6)
