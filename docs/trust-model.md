# pi-crew Trust Model (single source of truth)

**Document version:** 1.0 (WI-6.1 milestone)
**Date:** 2026-09-10
**Owner:** solo maintainer (delegated to upgrade program M6/WI-6.1)
**Supersedes:** trust-model content previously distributed across
`docs/bugs/SECURITY-ISSUES.md` (v3.0, last updated 2026-06-03) and
inline ADR comments.

This file is the authoritative trust-model document for pi-crew.
Other trust-model references should cite this file by path, not
duplicate.

## Trust boundaries

pi-crew operates across 4 distinct trust boundaries:

1. **Root session / orchestrator** — the pi session that owns the
   broker. Trusted: can issue tokens, can steer, can msg.send.
2. **Worker (child pi process)** — spawned by the orchestrator via
   `child-pi`. Trusted: has a valid token; CANNOT spawn its own
   grandchildren without delegate.request (gated).
3. **Guest (scratchpad cell)** — in-process vm.Script in the worker;
   can run user-supplied JS with a namespace.
4. **DWF (project-defined workflow)** — TS file in the project root
   `.dwf.ts`. Trusted only with explicit `PI_CREW_TRUST_PROJECT_DWF`.

Each boundary has a documented FAIL-CLOSED/FAIL-OPEN default and a
known list of accepted risks.

## Open trust-model issues (WI-6.1 acceptance)

### F.1 + F.2 — SHIPPED

- F.1 — `crew.limits.unbounded_total` metric: wired at
  `src/observability/event-to-metric.ts:46`.
- F.2 — cardinality-eviction gauge: wired at
  `src/observability/metrics-primitives.ts:57-67`,
  `crew.metrics.cardinality_evicted`.

### E.2 — `v8.deserialize` unauth (NOT YET ASSIGNED)

| Field | Value |
|---|---|
| File:Line | `src/runtime/scratchpad/guest.ts:33` |
| Severity | HIGH (per docs/bugs/SECURITY-ISSUES.md history) |
| Owner | solo maintainer |
| Target version | v0.12.0 (M7 milestone — gated M1–M4 green) |
| Mitigation pending | guest.ts:439 (deserialize(buffer)) — verify input is from a trusted source. Current code: deserialize is only called on cells returned by the worker via the protocol pipe (FD 3 with nonce). The nonce auth mitigates the unauth concern. |
| Action | Document the mitigation in this trust-model doc (carried). NO code change in M6 window. |

Mitigation detail: the protocol pipe is bound to an end with a 256-bit
nonce. The nonce is set as `NONCE_ENV` in the child env, removed
immediately after the child process forks, and used to authenticate
incoming protocol frames on the FD-3 read loop. `v8.deserialize` is
only ever called on a frame whose first 8 bytes pass the nonce
check (`guest.ts:418` bounce-back path). The unauth concern from
E.2 (research G23) was theoretical; the production wire-up has
nonce-bounded authentication.

**Verdict**: E.2 = ACCEPTED RISK (not a vulnerability in current code
path). Target v0.12.0 in case the nonce auth surface expands.

### SEC-008 — EPERM Lock Stealing (ACCEPTED RISK, formally closed)

| Field | Value |
|---|---|
| File:Line | `src/state/coordination/locks.ts:49-67` (EPERM branch) |
| Severity | LOW (per docs/bugs/SECURITY-ISSUES.md §SEC-008) |
| Owner | solo maintainer |
| Target version | N/A — accepted risk; will not change |
| Mitigation | `ROADMAP-2026-Q3.md` R1-5 documented `limits.strictLockOwnership` opt-in gate. Default OFF; explicitly opt in via config. |

**Verdict**: SEC-008 = ACCEPTED. The deny path treats EPERM as
"not alive" because blocking indefinitely on a different-user holder
is worse than steal-on-EPERM. The opt-in gate exists for users who
want strict semantics; default OFF remains.

## Per-boundary trust summary

| Boundary | Trust baseline | Failure mode | Mitigation |
|---|---|---|---|
| Root session | full | crash → broker shutdown | broker stop() is idempotent |
| Worker | token (compound key) | revoke token | revokeTaskToken() + post-hello re-check on secret-hash |
| Guest | nonce + FD-3 protocol | EPERM/SIGTERM | guest exits 0 on EPIPE, host checks nonce every frame |
| DWF | `PI_CREW_TRUST_PROJECT_DWF=true` | deny | `dwf.trust_denied` event emitted on rejection |

## Cross-references

- `docs/decisions/2026-08-10-scratchpad-snapshot-hmac.md` (HMAC = REMOVED 2026-08-12 — corrected claim §7)
- `docs/bugs/SECURITY-ISSUES.md` (preserved for SEC-001 through SEC-007 history)
- `docs/decisions/2026-08-10-dwf-isolated-vm-sandbox.md` (DWF sandbox spike → M6/WI-6.2)
- `src/observability/event-to-metric.ts:46` (F.1 metric)
- `src/observability/metrics-primitives.ts:57-67` (F.2 gauge)
- `src/runtime/scratchpad/guest.ts:33` (E.2 v8.deserialize, mitigated)
- `src/state/coordination/locks.ts:49-67` (SEC-008 EPERM branch, accepted)
