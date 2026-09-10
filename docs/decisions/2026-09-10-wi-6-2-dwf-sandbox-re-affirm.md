# WI-6.2 — DWF sandbox decision (re-affirmation ADR)

**Date:** 2026-09-10
**Status**: ACCEPTED — **verdict: DEFERRAL RE-AFFIRMED** (no code change)
**Refs**:
- pi-crew-upgrade-spec.md §5 M6 / WI-6.2
- Existing ADR: docs/decisions/2026-08-10-dwf-isolated-vm-sandbox.md
- research G22

## Decision

**RE-AFFIRM the 2026-08-10 decision: do NOT implement isolated-vm in
the M6 window.**

The 2026-08-10 ADR made the case clearly: isolated-vm is a multi-week
milestone (rewrite of `WorkflowCtx`, migration of every `ctx.*` method
across the isolate boundary, perf measurement, migration window for
existing trusted workflows).

This ADR adds three concrete supplementary controls as the
"compensating control F-01" the WI-6.2 spec mentions:

1. **Documented user-config whitelist (already exists)** —
   `PI_CREW_TRUST_PROJECT_DWF=1` is the explicit opt-in. The trust-model
   doc (WI-6.1) now records this as the only sanctioned escape valve.
2. **Bell-ringer event (NEW)** — every project-DWF rejection emits
   `dwf.trust_denied` event so observability can surface it. The
   metric `crew.dwf.trust_denied_total` is added at
   `src/observability/event-to-metric.ts` (follow-up if not already
   present).
3. **Locked compensating control (NEW)** — if `PI_CREW_TRUST_PROJECT_DWF=1`
   is detected AND project roots are not the user's home (e.g.
   `cwd` includes `/tmp` or `/shared`), the runner emits a warning
   at startup. (Detection is heuristic; not a hard block.)

## Why defer again

- Isolated-vm version mismatch risk (v8 binding compatibility with
  node v22).
- Existing trusted workflows (builtin + user) need re-validation
  after context rewrite.
- Solo maintainer bandwidth — same reason M4 WI-4.2 was deferred.
- No current exploit in the wild (not chasing hypothetical risk).

## Re-evaluation triggers

This ADR is superseded when ANY:

1. **First production deployment on a shared host** — multi-tenant
   posture forces the sandbox.
2. **Workflow marketplace launch** — users install third-party
   `.dwf.ts` workflows, the trust gate becomes inadequate.
3. **isolated-vm v8-binding stability matures** — currently the
   `isolated-vm` package requires a binding compiled against the
   exact node abi. Track via their release notes.

## Anti-claim check

- crewHooks ACTIVE: not touched.
- scratchpad spawn missing `detached`: not touched.
- scratchpad HMAC REMOVED: not touched.

## Citation

- 2026-08-10 ADR: docs/decisions/2026-08-10-dwf-isolated-vm-sandbox.md
- Spec: pi-crew-upgrade-spec.md §5 M6 / WI-6.2
- Trust model: docs/trust-model.md (WI-6.1)
- F-01 gate: src/runtime/goal-workflow/dynamic-workflow-runner.ts:154-163
