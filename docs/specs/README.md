# Backlog Specs

Full technical specs for every open backlog item in
[`docs/stories/backlog.md`](../stories/backlog.md). Each spec is a
self-contained implementation packet: problem with evidence, design with
file:line anchors, acceptance criteria, and a validation plan.

## Status legend

| Status | Meaning |
|--------|---------|
| planned | Accepted, spec complete, not started |
| verify-close | Backlog item already implemented in-session; work = verify + close or extend |
| blocked | Waiting on a prerequisite (called out in the spec) |

## Index

| Spec | ID | Title | Status | Priority |
|------|----|-------|--------|----------|
| [US-001](./US-001.md) | US-001 | Lock-free event log rotation (lock-scope reduction) | verify-close | P2 |
| [US-002](./US-002.md) | US-002 | Structured run-level lock cleanup | planned | P2 |
| [US-003](./US-003.md) | US-003 | Dead letter queue for permanently failed tasks | planned | P3 |
| [US-010](./US-010.md) | US-010 | Replace sleepSync busy-wait with proper async | planned | P3 |
| [US-011](./US-011.md) | US-011 | Stream-based event log for large runs | verify-close (ST-11 done) | P3 |
| [US-012](./US-012.md) | US-012 | Cache available models across runs | planned | P3 |
| [US-020](./US-020.md) | US-020 | Interactive run dashboard in TUI | planned | P2 |
| [US-021](./US-021.md) | US-021 | Run comparison (before/after) | planned | P3 |
| [US-022](./US-022.md) | US-022 | Export run report as markdown | verify-close (exists) | P3 |
| [US-030](./US-030.md) | US-030 | Webhook notifications on run completion | planned | P3 |
| [US-031](./US-031.md) | US-031 | GitHub Actions integration (PR comment) | planned | P3 |
| [DP-01](./DP-01.md) | DP-01 | Auto-prune retention guards (age-floor, env keep, audit rotation) | planned | P1 |
| [DP-02](./DP-02.md) | DP-02 | Dist slim (minify + drop map/build-meta from git) | planned | P1 |
| [DP-03](./DP-03.md) | DP-03 | CI test sharding (4-shard matrix) | planned | P1 |
| [DP-04](./DP-04.md) | DP-04 | fast-fix auto-suggest singleAgent routing | planned | P2 |
| [RM-01](./RM-01.md) | RM-01 | MINOR 2 — peekPendingCoalescedWrite shallow copy | planned | P2 |
| [RM-02](./RM-02.md) | RM-02 | MINOR 8 — benchmark quoted-args parsing | planned | P3 |
| [RM-03](./RM-03.md) | RM-03 | MINOR 3/4/6/7 — doc-notes sweep | planned | P3 |
| [RM-04](./RM-04.md) | RM-04 | F05 smoke mutation re-verify | planned | P3 |
| [SR-01](./SR-01.md) | SR-01 | GL-1b part C — pre-try failures mark turn manifest failed | planned | P2 |
| [SR-02](./SR-02.md) | SR-02 | Worker prompt diet (token/run −30%) | planned | P1 |
| [SR-03](./SR-03.md) | SR-03 | Test-flake remediation (2 known flakes) | planned | P2 |

## Deliberately NOT speced

- **US-DEPS-major-upgrade** — already has a full spec:
  `docs/stories/US-DEPS-major-upgrade.md` (diff 5→9 + TypeScript 7, two
  independent patches).
- **RR-010…RR-020** — completed; only historical value.
- **SKILL rule (real-test battery)**: archive evidence before restart — already
  implemented in-session (SKILL.md now says export evidence immediately; the
  PRODUCT-side auto-prune guards live in DP-01).
- **BR-12 .crew/.pi parity** — folded into RR-020 A0-1 (project-markers.ts
  unification) which is implemented; the "default layout change" decision is
  still parked and belongs in an ADR, not a spec.

## Writing conventions

- Every spec carries **measured evidence** (numbers, run ids, audit lines) —
  not hand-waving.
- Anchors are `file:line` against the current tree
  (`pi-crew@0.11.1`, HEAD `5d3a3d0f`).
- Mutation-testing is part of every unit plan (session norm).
- No new runtime dependencies unless the spec explicitly justifies one.