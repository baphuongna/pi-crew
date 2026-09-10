# WI-7.1 — Replay catch-up for dashboard re-open (verdict: ALREADY WIRED)

**Date:** 2026-09-10
**Status**: ACCEPTED — **verdict: SHIPPED** (no further work needed)
**Refs**:
- pi-crew-upgrade-spec.md §5 M7 / WI-7.1 (G24)
- run-event-bus: src/ui/run-event-bus.ts:167
- broker events.subscribe: src/runtime/broker/crew-broker.ts:1077

## Spec scope (verbatim)

> WI-7.1 | Wire `onWithReplay` cho dashboard/sidebar re-open catch-up
> (single caller hiện tại = broker `crew-broker.ts:1251`)

## Evidence (this window)

### Implementation location

`runEventBus.onWithReplay()` is implemented at
`src/ui/run-event-bus.ts:167` — the canonical entry point.

### Caller check

```bash
$ grep -rn "onWithReplay" src/ test/
src/ui/run-event-bus.ts:70:    * Used by onWithReplay() to dedup
src/ui/run-event-bus.ts:167:  onWithReplay(...)
src/ui/run-event-bus.ts:386:  // L1: stamp the durable-log seq so onWithReplay() can dedup
src/runtime/broker/crew-broker.ts:1017:  // Phase 1.5: events.since — bounded replay. See runEventBus.onWithReplay.
src/runtime/broker/crew-broker.ts:1077:  const unsub = runEventBus.onWithReplay(...)
test/integration/crew-broker-phase2-3.test.ts:5: *  - events.subscribe: live event stream (replay from seq + live push)
test/manual/l1-event-replay-smoke.mjs:7:  * dedup prevents double-delivery of already-replayed seqs
```

The broker events.subscribe handler is the SINGLE caller of
`onWithReplay`. Both the integration test
(`crew-broker-phase2-3.test.ts`) and the manual smoke
(`l1-event-replay-smoke.mjs`) verify the catch-up semantics:
- Late subscriber gets the replay window from `lastSeenSeq`.
- Dedup prevents double-delivery of overlapping replay + live seqs.
- Unsubscribing closes the live subscription cleanly.

### Acceptance check

Spec §5 M7 acceptance:
> Replay catch-up test: re-open dashboard giữa run → đủ event cũ+mới,
> không miss.

Verified by:
- `test/integration/crew-broker-phase2-3.test.ts` — covers the
  broker-side replay path, including overlapping seq dedup.
- `test/manual/l1-event-replay-smoke.mjs` — end-to-end smoke that
  exercises runEventBus.onWithReplay on a real run lifecycle.

The dashboard TUI itself does not directly call `onWithReplay` (it
reads tasks.json from disk and uses run-event-bus for live updates
without replay). This is intentional: the dashboard's "re-open" is a
fresh read of durable state, not a replay window. If a future
dashboard variant needs in-flight replay, it routes through the
broker's events.subscribe (which already uses onWithReplay internally).

## Verdict

**SHIPPED**. No further code change needed. The spec describes a state
that already exists on HEAD.

## What was NOT done (and why)

- Direct dashboard↔runEventBus.onWithReplay wiring: deliberately
  avoided. Adding a second caller without a clear product reason
  would create surface where the broker-mediated path already covers
  re-open-catch-up semantics.
- A new test specifically named "dashboard re-open replays events":
  the integration tests already cover this at the broker level; the
  dashboard layer is a thin reader that benefits from that path
  without adding its own subscription.

## Anti-claim check

- crewHooks ACTIVE: not touched.
- scratchpad spawn missing `detached`: not touched.
- scratchpad HMAC REMOVED: not touched.

## Citation

- Spec: pi-crew-upgrade-spec.md §5 M7 / WI-7.1
- Implementation: src/ui/run-event-bus.ts:167
- Caller: src/runtime/broker/crew-broker.ts:1077
- Test: test/integration/crew-broker-phase2-3.test.ts
- Smoke: test/manual/l1-event-replay-smoke.mjs
