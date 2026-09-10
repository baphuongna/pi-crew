# ADR — Dead-code disposition (WI-5.1)

**Date**: 2026-09-10
**Status**: ACCEPTED
**Refs**: pi-crew-upgrade-spec.md §5 M5 / WI-5.1, research G10-phần-còn-lại

## Scope

WI-5.1 audit of remaining dead-code from research phase:

| Item | File:Line | Status |
|---|---|---|
| `setStatusFallback` (private) | `src/ui/powerbar-publisher.ts:44` | **REMOVE** (this PR) |
| `setStatusFallback` (exported) | `src/ui/pi-ui-compat.ts:74` | **KEEP** (used by test) |
| `host_request` message type | `src/runtime/scratchpad/protocol.ts:48` | **KEEP** (documented reserved) |

## Evidence (grep)

### `powerbar-publisher.ts:setStatusFallback`
```
$ grep -rn "setStatusFallback" src/ test/
src/ui/powerbar-publisher.ts:44:    function setStatusFallback(...)         # declaration
src/ui/powerbar-publisher.ts:443:   // Never call setStatusFallback ...      # comment
test/unit/ui/powerbar-publisher.test.ts:227: // setStatusFallback is intentionally NOT called
```

Three references: declaration, a comment saying "never call it", and a
test comment confirming the deliberate-unused pattern. **0 invocations.**

### `pi-ui-compat.ts:setStatusFallback`
```
$ grep -rn "setStatusFallback" src/ test/
test/unit/pi-ui-compat.test.ts:9:   setStatusFallback,                     # import
test/unit/pi-ui-compat.test.ts:60:  setStatusFallback(ctx, "status", ...) # call
src/ui/pi-ui-compat.ts:74:          export function setStatusFallback(...) # declaration
```

Used by `test/unit/pi-ui-compat.test.ts:60`. **1 test caller.** KEEP.

### `host_request` (scratchpad protocol)
```
$ grep -rn "host_request" src/runtime/scratchpad/
src/runtime/scratchpad/protocol.ts:48:  host_request: { ... type: "host_request" ... }
```

Sole occurrence = a TYPE entry in the protocol message union. The
inline comment documents the intent:
> RESERVED for future host bridge (rlm-deep-review-2026-08-12.md §5.2F /
> J2): guest-side cells would request host services (tools.read,
> tools.grep) so data enters the namespace WITHOUT crossing the
> transcript — pi-rlm's core token-saving value proposition. Declared
> here so the protocol type is stable, but NOT YET WIRED: engine.ts and
> guest.ts have no host_request dispatcher/handler. Blocked on scratchpad
> adoption > 0 (do not add a host execution surface nobody calls).

KEEP — the type is stable surface for a documented future feature.
Removing it would re-add churn when the bridge is wired.

## Action taken in this PR

- **REMOVED** `function setStatusFallback` at `powerbar-publisher.ts:44`.
- Behavior unchanged: zero callers means removal is invisible at runtime.
- The test `test/unit/ui/powerbar-publisher.test.ts:227` is still relevant
  (asserts the design constraint that crew-widget owns the status bar).

## Anti-claim check

The 3 corrected claims per spec §7:
- crewHooks ACTIVE: not touched in this PR (6 call-site / 4 file).
- scratchpad spawn missing `detached`: not touched (out-of-scope).
- scratchpad HMAC REMOVED 2026-08-12: not touched.

## Bench impact

None — removing a no-call function has zero runtime cost.

## Followups

- `setStatusFallback` in `pi-ui-compat.ts` is single-test-only. If
  the test evolves into a smoke that other entry points cover, this
  fn may move to a single integration surface (no-op pending).
- `host_request` will move to a structured-block comment if it remains
  unwired for ≥2 release cycles.
