# Run lock: live in-process async holders are never stolen — wait instead

Date: 2026-09-17

## Status

Accepted

## Context

`withRunLock`'s async acquire passed `treatOwnPidAsStealable: true` to
`readLockSnapshot` (a 2026-07 CI-flake fix for the microsecond window between a
prior `releaseOwnLock` and the next `O_EXCL` create). But `holderPid ===
process.pid` cannot distinguish (a) a leftover lock file from a finished
acquisition of this process from (b) a lock CURRENTLY HELD by another async
context of the same process that is awaiting inside its critical section
(the production caller is `src/runtime/task-runner/post-execution.ts`, which
holds the lock across two awaits). Probe: two independent async contexts both
entered the critical section (`maxActive = 2`, lost updates), and
`releaseOwnLock` — which compared only PID — let the first finisher delete the
second's lock (ENOENT while still inside). Story: `docs/stories/RR-011/` (F02).

## Decision

- A module-private `runLockHeldTokens: Set<string>` records the token of every
  run-lock acquisition CURRENTLY HELD in this process: added synchronously right
  after acquire (no await in between), deleted in `finally` BEFORE
  `releaseOwnLock`. It answers only "is this holder alive in-process?" — never
  re-entrance (that stays in `lockCtx`; consulting a process-global for bypass
  is the H-1 bug class).
- `readLockSnapshot` reads the existing on-disk `token` field (format unchanged)
  and reports `heldByLiveInProcess`; the own-PID steal branch is suppressed when
  the stored token is in the live set. Token-less legacy files with our pid
  REMAIN stealable — preserving the CI-flake fix the flag was added for.
- A contender seeing a live in-process holder WAITS via `await sleep()` retry —
  never `sleepSync`, which would starve the very holder we wait for on the same
  event loop (v0.9.26 deadlock class) — bounded by the loop deadline
  (`staleMs * 2`) plus the `staleMs` steal backstop. Foreign live holders still
  get the immediate `locked` throw.
- `releaseOwnLock` is token-guarded: same pid but different stored token → no
  delete (the current holder owns the file).

## Alternatives Considered

1. Pass `treatOwnPidAsStealable: false` unconditionally — reintroduces the
   2026-07 CI flake (parallel-research scaffold mode).
2. Compare the stored token to the CURRENT acquisition's token — trap: each
   acquisition mints a fresh `randomUUID`, so a live holder's token ALWAYS
   differs and the predicate would steal anyway.
3. In-process promise-chain mutex alone — no cross-process protection; a second
   source of truth (the file-lock family needed an on-disk tier for this, ST-3).
4. Steal with a longer stale threshold — still corrupts a live holder.
5. `fs.watch`/inotify — platform-dependent, unbounded latency; retry loop
   suffices. Native flock — new dependency; changes primitive (see
   `2026-08-15-lock-family-unification.md`).

## Consequences

Positive:
- At most one async holder per run (`maxActive === 1`); no lost updates.
- A finishing context can no longer delete another holder's lock.
- On-disk lock format unchanged; sync↔sync, sync↔async, and cross-process
  behavior unchanged (non-regression tests pin them).

Tradeoffs:
- A skipped `finally` leaves the token "live" until `staleMs` (fail-closed; a
  leaked entry is inert because future acquisitions mint fresh tokens).
- Same-process contention now waits (bounded) instead of "winning" by stealing;
  callers that relied on the overlap were relying on a data-loss bug.
- The `staleMs` steal backstop can still fire against a LIVE in-process holder
  whose critical section legitimately exceeded `staleMs` (fsync stalls, loaded
  machine) — mutual exclusion is knowingly broken for the remainder of that
  section. Review round (2026-09-17) MAJOR 2: such steals now emit
  `logInternalError("locks.steal-live-holder", …, "warn")` so the window is
  observable and the "critical section < staleMs" invariant can be audited
  from logs. No holder-side heartbeat/mtime refresh was added — the single
  production holder (`post-execution.ts`) runs ms-scale; revisit if the warn
  ever fires in production. Pinned by
  `test/unit/state/coordination/run-lock-steal-live-holder-warn.test.ts`.

## References

- Story: `docs/stories/RR-011/`; verification §3 C2, §4 F02, §7 in
  `docs/archive/2026-09-17-pi-crew-review-verification.md`
- Code: `src/state/coordination/locks.ts` (`runLockHeldTokens`,
  `readLockSnapshot`, `acquireLockWithRetryAsync`, `releaseOwnLock`,
  `withRunLock`/`withRunLockSync`); caller
  `src/runtime/task-runner/post-execution.ts`
- Related ADR: `docs/decisions/2026-08-15-lock-family-unification.md`
