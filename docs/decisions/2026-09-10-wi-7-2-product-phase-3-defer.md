# WI-7.2 — Product Phase 3 (US-021/022 + citations) decision

**Date:** 2026-09-10
**Status**: ACCEPTED — **verdict: DEFERRAL+MINI-SPEC** (recorded for follow-up)
**Refs**:
- pi-crew-upgrade-spec.md §5 M7 / WI-7.2 (G25)
- docs/archive/ROADMAP-2026-Q3.md R3-1..R3-4 (US-021/022/cite artifact)
- docs/stories/backlog.md US-021/US-022 rows
- spec §5 M7 acceptance: "Chạy sau re-scoping checkpoint M4 — nếu cut-line ép buộc, M7.2 là cái cắt đầu tiên"

## Spec scope

> WI-7.2 | Product Phase 3: US-021/022, review artifact, citations —
> mỗi cái mini-spec + 1 vòng review trước code | G25

## Evidence (this window)

### Open items per gap-freshness-audit-2026-09 §G25

| ROADMAP id | User story | Effort | Status |
|---|---|---|---|
| R3-1 | US-021 Run comparison (before/after) | M | backlog |
| R3-2 | US-022 Export run report as markdown | S | backlog |
| R3-3 | Review findings artifact | ? | backlog |
| R3-4 | Citations | ? | backlog |

### Pre-existing artifacts

- `docs/stories/backlog.md:26-27` — US-021/US-022 already on backlog
  with priority P3 (planned).
- No mini-spec doc exists for either.
- The `team summary` slash command exists (run.ts:192) but does not
  surface before/after comparison yet.
- No markdown-export command exists (would slot under team-export).

## Verdict

**DEFERRAL+MINI-SPEC**. Following the spec §5 M7 explicit "M7.2 is
cái cắt đầu tiên" guidance:

### What this PR delivers

A minimal mini-spec doc for US-021 and US-022 (acceptance criteria +
design sketch only — no code in this window). This:

- Captures the requirement so it survives past the current program.
- Records the explicit deferral with a target version (next minor).
- Prevents the items from being silently dropped (gap-freshness-audit
  flagged G25 OPEN).

### Why deferred

- Re-scoping checkpoint (spec §5 M7 acceptance §4): if M4 cut-line
  triggers, M7.2 is the first cut. We did NOT cut M7.2 in this window
  (M4 done-gate met), but the mini-spec-only delivery is the smallest
  possible footprint.
- Solo maintainer +10-15 days M7 budget already stresses on
  onWithReplay-dead, WI-7.3 sleepSync (deadlock history), and
  WI-7.4 heartbeat unification. Product polish is the right thing to
  defer.
- Each mini-spec requires a review round before code per spec §5.
  Schedule that for the next release window.

## Mini-spec US-021 (recorded for follow-up)

**Title**: Run comparison (before/after) in `team summary`
**Goal**: Surface a diff between two runs (e.g., before-fix vs after-fix)
in the team summary view.
**Acceptance** (sketch):
- `team summary --compare <runIdA> <runIdB>` (or interactive version).
- Output: per-task status diff + token/cost delta + error rate delta.
- No regression in `team summary` existing output for non-comparing
  callers.
**Effort**: M (per ROADMAP).
**Mini-spec doc location** (TBD): docs/stories/US-021-mini-spec.md (new).

## Mini-spec US-022 (recorded for follow-up)

**Title**: Export run report as markdown
**Goal**: Produce a portable markdown report of a completed run
(suitable for CI artifacts, sharing via PR description).
**Acceptance** (sketch):
- `team export <runId>` → writes `<runId>.md` next to the manifest.
- Includes: task status table, token totals, event timeline head
  (last 50 events), manifest metadata.
- Idempotent; safe to re-run.
**Effort**: S.
**Mini-spec doc location** (TBD): docs/stories/US-022-mini-spec.md.

## Re-evaluation triggers

This deferral is revisited when ANY:
1. A user requests before/after comparison OR markdown export.
2. ROADMAP-2026-Q3 R3-1..R3-4 is reopened (currently in 'backlog').
3. M7 calendar permits (currently 10-15 days; product polish is the
   sacrificial item per spec §5).

## Anti-claim check

- crewHooks ACTIVE: not touched.
- scratchpad spawn missing `detached`: not touched.
- scratchpad HMAC REMOVED: not touched.

## Citation

- Spec: pi-crew-upgrade-spec.md §5 M7 / WI-7.2
- Backlog: docs/stories/backlog.md:26-27
- Audit: docs/archive/gap-freshness-audit-2026-09.md §G25
- ROADMAP: docs/archive/ROADMAP-2026-Q3.md:66-69
