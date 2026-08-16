# Lock families: event-log stays separate; agents-record joins the token-guarded pattern (decision α)

**Date:** 2026-08-15
**Status:** Accepted — decision (α) for Phase 3.1 of the maintainability refactor
**Relates to:** `src/state/coordination/locks.ts` (`withFileLockSync` :390, `withFileLockAsync` :523, `withRunLockSync` :596, `withRunLock` :631, `releaseOwnLock`, `releaseLock`), `src/runtime/crew-agent-records.ts` (`withAgentsLock`, `releaseAgentsLock`, `removeStaleAgentsLock`), `src/state/event-log/event-log.ts` (`withEventLogLockSync` `.mkdirlock`, `withEventLogLockAsync` `.alock`, `withSeqLock` `.seqlock`)

## Context

Phase 3.1 of the maintainability refactor audits the lock families and asks
whether they can be unified into one shared primitive. The audit verdict
(`docs/refactor-plan.review.md` §ROUND 4 P1) was **RISKY (HIGH)** for naive
unification: the families are NOT "the same primitives with the same
parameters and the same on-disk format". The reframed plan (row 3.1) therefore
required an ADR choosing ONE of:

- **(α)** exclude the event-log mkdir lock from unification — subsume only the
  `locks.ts` families + the agents-record lock, accept a format change for the
  agents-record lock (add a token);
- **(β)** unify all three lock families with an accepted on-disk format change.

**This ADR chooses (α).** The event-log lock family is intentionally separate
(split since v0.9.26, re-justified empirically in Phase 3.6), and the only
residual race-relevant gap — the agents-record lock's missing token — is
closed directly by adding a token to that one family, without a shared
abstraction.

### Lock families today (verified 2026-08-15)

| # | Family | Location | Primitive | Payload | staleMs | Re-entrance | Release |
|---|---|---|---|---|---|---|---|
| (a) | file lock | `locks.ts` `withFileLockSync` :390 / `withFileLockAsync` :523 | FILE `.flock` sidecar, `O_EXCL` | `{kind, pid, createdAt, token}` | 30 s (config default) | per-async-context ALS (ST-14) + cross-tier sync↔async maps (ST-3-FIX, Round 29) | token-guarded `releaseLock` + PID-guarded `releaseOwnLock` (LOCK-1) |
| (a) | run lock | `locks.ts` `withRunLockSync` :596 / `withRunLock` :631 | FILE `<stateRoot>/run.lock`, `O_EXCL` | `{kind, pid, createdAt, token}` | 30 s | per-async-context ALS (H-1) | `releaseOwnLock` (PID-guarded, LOCK-1) |
| (b) | agents record | `crew-agent-records.ts` `withAgentsLock` | FILE `<agents.json>.lock`, `O_EXCL` | **`{pid, createdAt}` → now `{pid, createdAt, token}` (this ADR)** | 30 s (`AGENTS_LOCK_STALE_MS`) | none | PID-only → **now token-guarded `releaseAgentsLock` (this ADR)** |
| (c) | event-log family | `event-log.ts` `withEventLogLockSync` `.mkdirlock` / `withEventLogLockAsync` `.alock` | **DIRECTORY** `mkdirSync` (O_EXCL semantics) + `pid` file inside | dir + `pid` text file | 10 s (per-family default) | none | PID-guarded (Round 26 BUG 5); mtime-first stale check (BUG 3/4) |
| (d) | seq reservation | `event-log.ts` `withSeqLock` `.seqlock` (Phase 3.6) | DIRECTORY `mkdirSync` | dir + `pid` text file | 1 s (pure-sync short section) | none | PID-guarded |

(Atomic writes via `atomic-write.ts` use O_EXCL temp+rename — they are NOT a
lock-family consumer and are out of scope.)

## The four divergences (Round 4 P1) and their resolutions

1. **staleMs is non-uniform** — event-log uses 10 s (`event-log.ts`, sync +
   async variants), while `locks.ts` and `withAgentsLock` use 30 s.
   **Resolution (i): keep per-family staleMs defaults — do NOT uniformize.**
   The 10 s event-log default is deliberate: it protects a high-frequency
   append lock so a crashed holder is reclaimed quickly. Unifying to one
   value is a behavior change with no correctness benefit.
2. **Primitive diverges: directory vs file** — event-log is a directory lock
   (`mkdirSync` O_EXCL semantics), `locks.ts`/agents-record are file locks
   (`openSync` O_EXCL). **Resolution (ii): keep the directory lock for the
   event-log family.** A directory cannot be a symlink and `mkdir` atomicity
   is equivalent to O_EXCL on POSIX; more importantly, the sync `.mkdirlock`
   retry loop uses `sleepSync` while the async `.alock` path awaits timers —
   merging the two namespaces into one lock dir reintroduces the v0.9.26
   sleepSync-vs-async-timer deadlock. The family split is intentional and
   stays.
3. **Agents-record lock had no token** — `locks.ts` writes `{kind, pid,
   createdAt, token}` and releases via token matching; `withAgentsLock` wrote
   `{pid, createdAt}` and released by PID only. **Resolution (iii): the
   agents-record lock gains a randomUUID `token` field and a token-guarded
   release** (`releaseAgentsLock`, mirroring `locks.ts` `releaseLock`
   semantics: only remove if the stored token matches; missing/corrupt/symlink
   cases handled safely). This is the format change explicitly accepted by
   decision (α) and the only code change this ADR mandates. The token
   comparison uses direct string equality — the token is an ownership marker,
   not a secret, so `locks.ts`'s `timingSafeEqual` length side-channel guard
   does not apply here.
4. **PID-only release** — both the agents-record lock and the event-log locks
   released by PID; PID recycling (crash → PID reused) could make a stolen
   lock un-stealable until staleMs. **Resolution (iv): token-guarded release
   for the agents-record lock (item 3); symlink guards added on that release
   path** (`releaseAgentsLock` refuses to remove a symlink, matching
   `locks.ts`). The event-log family keeps its PID-guarded release — its
   mtime-first stale detection (Round 26 BUG 3) plus the 1 s `.seqlock`
   staleness backstop bounds the PID-recycling window, and converting it to a
   token scheme would require a second format change for no measured gain.

**Security resolutions already landed or carried:** the lock-file permission
tightening `0o644 → 0o600` was done in Phase 3.0 (S-R1) and remains; symlink
guards are present in `locks.ts` (parent-dir `isSymlinkSafePath` + `lstat`
pre-checks) and now on the agents-record release path; the R17-B1
`logInternalError` in `removeStaleAgentsLock` is kept verbatim.

## Decision

**Choose (α): the event-log lock family (`.mkdirlock` / `.alock` /
`.seqlock`) stays SEPARATE from the `locks.ts` families and the agents-record
lock.** The `.seqlock` (Phase 3.6) already is the shared cross-family
seq-reservation primitive — it closes the duplicate-seq race between the sync
and async event-log families without merging their retry loops, which is
exactly the unification the codebase needs. The agents-record lock is
upgraded in place (token field + token-guarded release) and remains in
`crew-agent-records.ts`.

### What was already done, and how this ADR relates

- **Phase 3.0 (commit `51fe928c`):** `crew-agent-records.ts` lock file mode
  `0o644 → 0o600` (S-R1) — same tightening applied to `event-log-rotation.ts`
  and `active-run-registry.ts`. This ADR's token work builds on that
  hardening; the mode is preserved by the `O_EXCL` create at `0o600`.
- **Phase 3.6 (commits `3a536e29` / `6adc61a1`):** the `.seqlock` third lock
  namespace serializing `.seq` reservation with advance-on-reserve persist
  (R16-B1/R17, empirically justified). This ADR does not add or change any
  event-log lock code; it records that the family split remains the final
  state and that the `.seqlock` is the sanctioned shared primitive.

### Lock-ordering invariant (L1 → L2 → L3)

The lock hierarchy is a fixed invariant, documented in the R16-B1 comment
block in `event-log.ts` (Round 18 Part C) and carried forward by this ADR:

```
L1 (run lock: withRunLock*/state-store) → L2 (event-log family:
   .mkdirlock/.alock) → L3 (.seqlock)
```

Locks are acquired in increasing order and never the reverse; never acquire
L1/L2 while holding L3. The `.seqlock` critical section is pure-sync and
short (sidecar read + counter update + best-effort persist), so the ordering
cannot deadlock. The agents-record lock is not part of this chain — it
protects `agents.json` and is independent of the event-log hierarchy.

### No shared `src/state/file-lock.ts`

The plan allowed creating a shared `src/state/file-lock.ts` only if a pure
move + re-export added value with LOW risk. **It was not created.** Reasons:

- The three families differ in primitive (file vs directory), staleMs
  (30 s vs 10 s vs 1 s), and re-entrance machinery (`locks.ts` carries three
  AsyncLocalStorage instances + two cross-tier process-global structures;
  the other families have none). A shared `FileLock` would either carry
  unused machinery or require replicating the ALS complexity to all callers
  (P1-C/P1-D).
- The residual race-relevant gap — the agents-record lock's missing token —
  was closed directly with a ~30-line token-guarded release inside
  `crew-agent-records.ts`, no abstraction needed.
- Keeping the families separate preserves the documented incident history
  (H-1/ST-14 re-entrance, ST-3 sync↔async, v0.9.26 deadlock, Round 26 BUG
  1–5) in the files that own it.

## Consequences

- **Event-log family**: unchanged behavior, unchanged on-disk format
  (directory + `pid` file). Seq uniqueness across the sync/async families is
  guaranteed by `.seqlock`, not by unification.
- **Agents-record lock**: on-disk format change from `{pid, createdAt}` to
  `{pid, createdAt, token}` — accepted under (α). A stale-steal by another
  process can no longer be released by the wrong owner. Tests asserting the
  old format must be updated to the new shape (handled in Phase 3.1
  Deliverable B).
- **Future lock work**: add token guards per-family where a race exists;
  do not force a shared abstraction. If a genuinely shared need emerges
  later, revisit with a new ADR.
- **Risk register**: the Round 4 P1 entry is closed by this decision +
  the Deliverable B code; the remaining per-family divergence (staleMs,
  primitive) is intentional and documented, not debt.

## References

- Plan: `docs/refactor-plan.md` Phase 3 rows 3.0/3.1 (decision α/β framing),
  Risk register "Round 4 — lock family divergence".
- Review: `docs/refactor-plan.review.md` §ROUND 4 P1 (4 divergences,
  S-R1/S-R2/S-R3), §ROUND 16/17/18 (event-log dual-namespace, empirical
  seq-dup, lock ordering).
- Code: `src/state/coordination/locks.ts`, `src/runtime/crew-agent-records.ts`,
  `src/state/event-log/event-log.ts` (R16-B1 `.seqlock` comment block).
