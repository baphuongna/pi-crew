# Decision: Phase 4 — Do not flip broker.enabled default to true

**Date:** 2026-07-21
**Status:** ⛔ SUPERSEDED on 2026-07-22 by `2026-07-22-broker-phase4-gated-on.md` (default flipped ON).
**Original status:** accepted (broker stays off-by-default)
**Scope:** Inter-pi broker default-off kill switch (broker.enabled, PI_CREW_BROKER env)
**Context:** Plan §7 Phase 4 + §Security invariant #11

> **Superseded by** [`2026-07-22-broker-phase4-gated-on.md`](2026-07-22-broker-phase4-gated-on.md).
> The Phase 4 default-on flip has shipped. This doc is preserved as the
> historical record of the conditions that gated the flip and the
> rationale for keeping default-off at v0.9.46.

## Context

The inter-pi broker is feature-complete as of v0.9.46 (Phase 0 + 1 + 2 + 3):

- **Phase 0** — foundation (broker, client, deps, tokens), root-only gate, feature flag, default OFF.
- **Phase 1.1–1.2** — `msg.send` / `msg.inbox` (durable mailbox writes + paginated read).
- **Phase 1.3** — post-append mailbox observer (live fanout for connected recipients).
- **Phase 1.4** — disconnect fallback (already in client.ts via onClose / close()).
- **Phase 1.5** — `events.since` (durable event log replay, seq-deduped).
- **Phase 1.6** — E2E integration test (5 tests, all pass 3/3 runs).
- **Phase 1.7** — bench baseline recorded.
- **Phase 1.8** — bundle rebuilt.
- **Phase 2** — `events.subscribe` (live event stream via runEventBus.onWithReplay).
- **Phase 2** — `task.waitStatus` (bounded poll, properly recursive).
- **Phase 3** — `steer.push` (durable write to target task's mailbox, kind=steer, priority=urgent).
- **Phase 3** — `escalate` (durable write to sender's taskId, kind=follow-up).

Tests: 62 broker unit + 8 phase 2-3 integration + 5 msg integration = 75 tests, all pass 3/3 runs under `--test-force-exit` and `PI_CREW_BROKER=0`. Typecheck clean. Bundle rebuilt. The broker is correct, secure, and proven.

## Decision

**Keep `broker.enabled: false` as the default.** Do not flip to `true` in this release.

The opt-in path remains:
- `broker.enabled: true` in `~/.pi/agent/extensions/pi-crew/config.json` or `pi-crew.json`
- `PI_CREW_BROKER=1` env override (beats config=false)

The opt-out path remains:
- `PI_CREW_BROKER=0` env override (beats config=true)
- `broker.enabled: false` in config

## Rationale

1. **Soak testing requires multi-OS CI + extended runtime.** Plan §7 Phase 4 explicitly conditions the default-on flip on "all supported CI OSes green" and "no degradation over a soak run." We have:
   - Local Linux dev environment: passing.
   - No macOS or Windows CI run.
   - No 24-hour+ soak run.
   The flip is premature without these signals.

2. **Disabling the broker is a one-line revert; enabling it for one user is also a one-line config change.** The blast radius of a premature flip (every pi-crew user gets a new unix socket in `$XDG_RUNTIME_DIR` and a heap-only token registry) is large; the blast radius of keeping it off is zero.

3. **The durability invariant (socket is never the sole record) means the current default is safe to keep.** Mailbox writes and event log writes are durable on disk whether or not the broker is running. The broker is a latency accelerator for cross-process messaging. Existing file-based pathways (`delivery.json` polling, `PI_CREW_STEERING_FILE` polling) remain authoritative.

4. **Security review confirmed: flag-off path is leak-free.** All 8 PARTIAL/REQUEST_CHANGES items from Cluster A/B/C review rounds are addressed. Disabled-path tests (60 unit tests) pass with `PI_CREW_BROKER=0`. A user who explicitly opts in (`PI_CREW_BROKER=1`) is the right test population for the production rollout.

## Conditions for re-opening this decision

Re-evaluate the default-on flip when ALL of the following are green:

- [ ] CI runs green on Linux + macOS + Windows for at least one release cycle.
- [ ] A 24-hour+ soak run shows no degradation (memory, connection count, token registry, socket files).
- [ ] At least 3 users have explicitly opted in (`PI_CREW_BROKER=1`) and reported no issues.
- [ ] The Windows residual risk (decision doc `2026-07-21-broker-windows-perms.md`) is acknowledged as accepted or mitigated.
- [ ] Bundle size impact of enabling the broker in the default config has been measured (current bundle: 2.78 MB; the broker code is ~80 KB but is already in the bundle).

Until then, the default stays `enabled: false`. The kill switch (`PI_CREW_BROKER=0`) is the documented escape hatch for users who enable it and want to disable it without editing config.

## References

- Plan: `reports/inter-pi-broker-impl-plan-2026-07-21.md` §7 Phase 4 + §Security #11.
- Spec: `reports/inter-pi-broker-spec-2026-07-21.md` §3.3 (kill switch contract).
- Review rounds: Cluster A/B/C reports (see `.crew/artifacts/team_20260721*`).
- Test count: 75 tests, 3/3 runs, `--test-force-exit` and `PI_CREW_BROKER=0` (disabled-path proof).
- Bundle: `dist/index.mjs` 2.78 MB (built 2026-07-21).