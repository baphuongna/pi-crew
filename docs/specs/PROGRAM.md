# PROGRAM — Spec execution plan (SDD)

Execution program for the 22 specs in [`docs/specs/`](./README.md). Specs are
the implementation packets; this file is the milestone/wave plan with
dependency ordering, conflict groups, gates, and cost tracking.

## Gates (per spec, in order)

`pipeline_verify` equivalent — the pi-pipeline tool is not loaded in this
session, so the repo's own gates stand in:

| Gate | Command | Expected |
|------|---------|----------|
| G1 typecheck | `npm run typecheck` | exit 0 |
| G2 critical | `npm run test:critical` | 116/116 |
| G3 unit (touched dirs) | `node --experimental-strip-types --no-warnings --test <file>` | 0 fail |
| G4 biome | `npx biome check <changed files>` | clean |
| G5 mutation | revert the fix → the new test must go RED → restore | RED then GREEN |
| G6 full unit (wave close) | `npm run test:unit` | 0 real fail (known flakes excepted) |
| G7 bundle (if src/) | `npm run build:bundle` + `npm run test:bundle` | 2/2 |
| G8 live (if src/ui, src/prompt, src/runtime/broker|child-pi|surface, schema) | real-test skill tier per its decision table | pass |

Every spec lands as its own commit with: code + test + evidence (commands,
observed output) recorded in `docs/TEST_MATRIX.md`.

## Conflict groups (never run two members concurrently)

| Group | Files | Specs |
|-------|-------|-------|
| A — atomic-write | `src/state/atomic-write.ts`, `crew-agent-records.ts` | RM-01, RM-03 |
| B — event-log | `src/state/event-log/*` | US-001, US-011 |
| C — locks | `src/state/coordination/locks.ts` | US-002, US-010 |
| D — run-export | `src/extension/run-export.ts` | US-021, US-022 |
| E — CI workflows | `.github/workflows/*` | DP-02, DP-03 |
| F — state-store | `src/state/stores/state-store.ts` | RM-03 (comments) only |
| G — goal loop | `src/runtime/goal-workflow/*` | SR-01 |
| H — prompt | `src/prompt/*`, `src/runtime/task-runner/prompt-builder.ts` | SR-02 |

## Waves

### Wave 0 — verify-close (no risky code, evidence only)

| Spec | Deliverable |
|------|-------------|
| US-011 | Audit for whole-file event readers; close or list residual |
| US-022 | Decision on `exportedAt` determinism; extend markdown or close |
| RM-04 | Reproduce F05 mutation; record RED→GREEN |

### Wave 1 — tiny isolated (parallel-safe: disjoint files)

| Spec | Files | Priority |
|------|-------|----------|
| RM-01 | atomic-write.ts, crew-agent-records.ts | P2 |
| RM-02 | benchmark-runner.ts | P3 |
| DP-02 | build-bundle.mjs, .gitignore, workflows (E: alone) | P1 |
| RM-03 | comments only (A + F) | P3 |

### Wave 2 — P1 value

| Spec | Why P1 |
|------|--------|
| DP-01 | retention: 3 data-loss incidents in one session |
| DP-03 | CI budget about to be breached (E: after DP-02) |
| SR-02 | token/run is the dominant operating cost (H: alone) |
| DP-04 | small-goal routing: direct token win |

### Wave 3 — correctness/perf

SR-01 (G) · US-001 (B, after US-011 audit) · US-002 (C) · US-010 (C, after
US-002) · US-012 · US-003 (after DP-01) · SR-03

### Wave 4 — features

US-021 (D) · US-022 (D, after US-021 if code) · US-020 (needs live tier) ·
US-030 (security review) · US-031

## Cost tracking

| Item | Model/tokens | Notes |
|------|--------------|-------|
| (filled per completed spec) | | |

## Progress log

| Date | Spec | Status | Gates | Commit | Evidence |
|------|------|--------|-------|--------|----------|
| 2026-09-22 | specs written (22) | done | n/a (docs) | `65236508` | link check: 0 missing |
| 2026-09-22 | RM-01 peek deep copy | done | G1-G5 ✓ | `787eeda8` | mutation 3/3 red; critical 116/116 |
| 2026-09-22 | RM-02 benchmark quoting | done | G1-G5 ✓ | `af65b95e` | mutation 2/2 red; critical 116/116 |
| 2026-09-22 | US-022 export determinism + md sections | done | G1-G5 ✓ | `5e40d64e` | mutation red; export suites 6/6 |
| 2026-09-22 | US-011 bounded-heap guard (AC-3) | done | G1-G5 ✓ | `22709f63` | mutation red @24.6MB vs 8MB ceiling |
| 2026-09-22 | Wave 0 audits (US-011/US-022) | done | n/a | explorer run | residual lists recorded in specs |
| 2026-09-22 | DP-02 dist slim (minify, drop map/meta) | done | G1,G2,G4,G7 ✓ | `de7b486c` | −52% (3.44MB→1.65MB); bundle 4/4; committed-hash MATCH |
| 2026-09-22 | RM-03 single-writer invariant (partial) | done | G1,G2,G4 ✓ | `9dd9d4d4` | 3/4 anchors not reproducible → recorded |
| 2026-09-22 | RM-04 F05 mutation re-verified | done | G1,G2 ✓ | `8b72ffe5` | mutation → 6/13 RED incl. AC-1 e2e wrapper |
| 2026-09-22 | **Wave 0+1 CLOSED (7 specs)** | done | — | — | RM-01..04, US-011, US-022, DP-02 |
| 2026-09-22 | DP-01 auto-prune retention guards | done | G1-G6,G8 ✓ | `e01ee7d7` | 3 mutations red; live probe 12/12 young protected |
| 2026-09-22 | DP-04 small-goal routing hint | done | G1,G2,G4,G5 ✓ | (this) | mutation red; plan suites 38/38 |
| 2026-09-22 | SR-01 GL-1b part C (pre-try turn marking) | done | G1,G2,G4,G5 ✓ | `dad41423` | mutation red; smoke 5/5 |
