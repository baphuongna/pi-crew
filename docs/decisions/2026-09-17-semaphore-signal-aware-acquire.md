# Semaphore.acquire(signal): aborted waiters leave the queue eagerly; capacity never leaks

Date: 2026-09-17

## Status

Accepted

## Context

`Semaphore.acquire()` took no `AbortSignal` (probe:
`acquire.prototype.length === 0`), so a cancelled waiter queued behind the
global worker cap stayed pending until the slot holder released — and then
"received" a slot it could never use (probe: `acquire()` resolved at +303 ms
with `signal.aborted === true`). Damage bound (correction C5): child-pi's
pre-spawn abort guard means no process is ever forked for an aborted caller —
the cost was delay (e.g. `drainPendingUnits` awaiting the doomed promise),
not extra processes. The queue stored bare resolve functions, so a specific
waiter had no identity and could not be removed. Story:
`docs/stories/RR-014/` (F15).

## Decision

- `acquire(signal?: AbortSignal)` — queued waiters are `Waiter` records with
  identity and an idempotent `settle("granted" | "aborted")` that detaches the
  abort listener on every settle path.
- An aborted waiter is EAGERLY spliced from the queue (synchronously inside
  the abort listener) and rejects with the new `SemaphoreAbortedError`; it
  never consumes a slot (`#current` untouched). An already-aborted signal at
  entry rejects immediately (fail-closed). A settle never bare-resolves.
- `release()` has a defensive skip-loop: a settled entry can never burn a
  slot; the freed slot reaches the first ALIVE waiter (FIFO preserved).
- The signal threads `runWorker` → `withWorkerSlot` → `acquireWorkerSlot` →
  `acquire`, so cancellation reaches the WAIT itself. No-signal callers keep
  byte-for-byte previous semantics; no call site was forced to change.
- Race safety: all queue/`#current` mutations are synchronous (no await
  between them) and Node's abort dispatch is synchronous, so abort-first →
  splice+reject (current untouched) vs release-first → settle+detach-listener
  — exactly one runs. A 200-round test asserts `current <= max` and capacity
  restored in both interleavings.

## Alternatives Considered

1. `Promise.race([acquire(), abortPromise])` at call sites — the original
   `acquire()` still resolves later and burns a slot nobody holds: a capacity
   leak, exactly the risk flagged for this fix.
2. Thread the signal to `withWorkerSlot` but keep `acquire()` signal-less —
   fixes nothing; the wait is inside `acquire()`.
3. Lazy-skip aborted entries in `release()` (no removal) — the aborted waiter
   stays pending until the next release; that is the defect being fixed.
4. Abort one waiter → reject the whole queue — breaks FIFO and hurts live
   waiters for someone else's cancel.
5. Intrinsic `timeoutMs` — disrespects caller cancel semantics; any constant
   is wrong.
6. Replace with a queue library — new dependency on the central spawn
   primitive.
7. Raise `MAX_QUEUE`/capacity — unrelated to waiter latency.

## Consequences

Positive:
- A cancelled waiter settles immediately; `drainPendingUnits` no longer hangs
  for the holder's full slot duration.
- Slot accounting is invariant (`current <= max`, handoff never decrements,
  one release per grant) even under the abort↔handoff race.
- Damage bound intact: the pre-spawn guard in child-pi still means no fork.

Tradeoffs:
- The queue entry shape changed from bare resolvers to records — every
  reader/writer of `#queue` must change together (single file, single class).
- The abort-after-grant window remains (unavoidable with a promise API): the
  caller observes `signal.aborted`, `runChildPi` returns `kind: "aborted"`
  without spawning, and `withWorkerSlot`'s `finally` releases the slot within
  a microtask of the grant.

## References

- Story: `docs/stories/RR-014/`; verification §3 C5, §4 F15 in
  `docs/archive/2026-09-17-pi-crew-review-verification.md`
- Code: `src/runtime/scheduling/semaphore.ts` (`Semaphore.acquire`,
  `SemaphoreAbortedError`, `Waiter`), `src/runtime/scheduling/global-worker-cap.ts`,
  `src/runtime/run-worker.ts`, `src/runtime/child-pi/child-pi-spawn.ts` (pre-spawn guard)
