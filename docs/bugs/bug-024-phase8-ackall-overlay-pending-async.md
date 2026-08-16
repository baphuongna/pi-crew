# Bug Report: phase8 smoke test for ackAll overlay is skipped (pending async after handleInput)

**Date:** 2026-08-10
**Severity:** Low–Medium (test-coverage gap for a destructive-operation safety property; no runtime bug observed)
**Status:** Open — root cause documented in the skip comment; fix not yet implemented
**Affects:** `test/integration/phase8-smoke.test.ts:160-166` (skipped test)
**Blocks:** nothing immediately; masks any future regression of "ackAll can be cancelled before destructive dispatch"

---

## Summary

The `phase8 smoke: ackAll can be cancelled before destructive dispatch and confirmed after` test is silently skipped via `test.skip(...)` with an inline comment but no bug ticket. The skip comment names a real production code smell:

> Root cause: MailboxDetailOverlay's `handleInput('X')` triggers `ackAll` but the overlay's internal state machine has pending async work that doesn't complete before the test's `finally{}` cleanup runs. The failure mode on Ubuntu/CI is "Promise resolution is still pending but the event loop has already resolved".

This is the same "documented-but-lost bug" anti-pattern that improvement-plan-2026-08-09 D.1 specifically warns against for bug-023: *"someone un-skipping and getting burned."*

## Affected property

`MailboxDetailOverlay.ackAll` is a **destructive** operation (acks all messages in a mailbox, which can trigger downstream dispatch). The skipped test asserts the safety property: *the user can cancel (X) before the destructive dispatch and the dispatch does not fire*. Without this test, any change that removes the cancel-before-dispatch guard ships silently.

## Suggested fix

Two options (either resolves the bug):

1. **Make the overlay's ackAll return a Promise the test can await.** The overlay's internal state machine currently fires-and-forgets the dispatch; expose a `pendingDispatch: Promise<void> | undefined` field on the overlay instance and await it in the test before asserting.
2. **Gate the test behind a poll-until-settled helper.** Replace the implicit race with an explicit `await waitForOverlaySettled(overlay, { timeoutMs: 1000 })` that polls the overlay's pending-work counter.

Option (1) is preferred — it also improves production debuggability (operators can inspect `pendingDispatch` to see if a dispatch is in flight).

## References

- `test/integration/phase8-smoke.test.ts:160-166` — the skipped test
- `src/ui/overlays/mailbox-detail-overlay.ts` — the overlay (handleInput 'X' → ackAll)
- `improvement-plan-2026-08-09.md` D.1 — the convention this bug file matches
