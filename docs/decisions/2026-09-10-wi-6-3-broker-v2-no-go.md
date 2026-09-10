# WI-6.3 — Broker protocol v2 (NO-GO decision)

**Date:** 2026-09-10
**Status**: ACCEPTED — **verdict: NO-GO**
**Refs**:
- pi-crew-upgrade-spec.md §5 M6 / WI-6.3
- research G26
- broker protocol v1: src/runtime/broker/crew-broker.ts
- BROKER_PROTOCOL = 1 at src/runtime/broker/protocol/request-parsers.ts:14

## Context

The broker currently speaks protocol v1 (`BROKER_PROTOCOL = 1`).
WI-6.3 asks: is there evidence of need for a v2 protocol (multi-version,
breaking change)?

## Evidence (this window)

### Search for evidence of multi-version need

```bash
$ grep -rn "BROKER_PROTOCOL\|broker.*v2\|protocol.*v2\|brokerVersion" \
      src/ test/ docs/decisions/ | head -10
```

The only hits are:
- `src/runtime/broker/protocol/request-parsers.ts:14` — `export const BROKER_PROTOCOL = 1;`
- `src/runtime/broker/crew-broker.ts:744` — hello negotiation enforces exact match.
- `src/state/contracts.ts` — no v2 entry.
- `docs/decisions/*.md` — no v2 mention.

### Search for open issues that a v2 would resolve

```bash
$ grep -rn "wire-incompat\|breaking.*change\|multi-version" docs/ src/
```

Zero hits related to broker protocol. All committed issues are
addressable within v1's frame/wire format:
- Frame cap (256 KiB) is configurable (`maxFrameBytes?`).
- Method dispatch is in-flat (additive).
- Auth is keyed on token secrets (no version dimension).

### Compatibility with v1 clients

The v1 protocol is stable since v0.9.21 (broker Phase 0). All
existing clients (child-pi workers, inbox/mailbox observers, dashboard)
read v1. A v2 would require rolling every consumer AND maintaining a
dual-version server during migration — non-trivial with the solo
maintainer.

## Decision

**NO-GO for v2.** No concrete user-facing need identified. Current v1
encompasses all observed use cases within its existing extension
surface (additive methods, configurable caps).

## What "NO-GO" means here

- No v2 spec work in this window.
- No "v2-ready" abstraction retrofitted into v1 (would be premature).
- The protocol remains v1; `BROKER_PROTOCOL` stays at 1.

## Re-evaluation triggers

This NO-GO is revisited when ANY:

1. A second consumer introduces a fundamentally different auth scheme
   (e.g., token-bound mTLS, oauth-style auth) that v1 cannot carry.
2. A wire-format change (e.g., binary frame support for high-throughput
   event stream) becomes productively useful.
3. The 256 KiB frame cap is a documented blocker for a real consumer
   (currently 1000 events @ <256 bytes per event comfortably fits).
4. A multi-version deployment pattern (production + staging behind the
   same broker) is requested.

None of these fires today. Recording triggers so future audits don't
re-litigate.

## Anti-claim check

- crewHooks ACTIVE: not touched.
- scratchpad spawn missing `detached`: not touched.
- scratchpad HMAC REMOVED: not touched.

## Citation

- Spec: pi-crew-upgrade-spec.md §5 M6 / WI-6.3
- v1 constant: src/runtime/broker/protocol/request-parsers.ts:14
- v1 negotiation: src/runtime/broker/crew-broker.ts:744
- v1 hello frame: src/runtime/broker/protocol/connection-state.ts (re-export)
