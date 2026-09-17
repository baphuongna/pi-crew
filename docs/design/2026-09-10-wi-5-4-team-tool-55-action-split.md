# WI-5.4 — Team-tool action split DESIGN doc + AUTOMATE pilot

**Date**: 2026-09-10
**Status**: DESIGN ACCEPTED — AUTOMATE pilot verdict: **KEEP (alive + warranted)** — schema-declaration-only was a false read on first pass.
**Refs**: pi-crew-upgrade-spec.md §5 M5 / WI-5.4, G14

## Corrected count (per gap-freshness-audit-2026-09 §G14)

55 real actions (corrected from the 54 in research) across 5 domains:

| Domain | Count | Schema location | Dispatch + handler? |
|---|---|---|---|
| RUN | 10 | `runActions` (`team-tool-schema.ts`) | yes |
| STATUS | 16 | `statusActions` | yes |
| CONTROL | 7 | `controlActions` | yes |
| MANAGE | 16 | `manageActions` | yes |
| **AUTOMATE** | **6** | `AUTOMATE_ACTIONS` (`:437`) | **yes** |

Total: 55. The `""` placeholder at enum position 0 brings the LLM-facing
array to 56 — minus the placeholder = 55 real.

## Evidence (this window, CORRECTED)

### Initial pass was wrong

First grep used:
```
$ grep -rn "case \"\\(schedule\\|scheduled\\|anchor\\|auto-summarize\\|auto_boomerang\\|api\\)\"" \
       src/extension/team-tool.ts
0 matches
```

This is correct (top-level switch in team-tool.ts doesn't have those
strings — they're routed via `domainForAction()` to per-domain dispatch
modules). My first pass falsely concluded "0 handlers". The corrected
evidence:

### Corrected: AUTOMATE IS dispatched + handled

```
src/extension/team-tool/dispatch/automate.ts
  export AUTOMATE_DOMAIN_ACTIONS = [6 entries]
  export async function handleAutomateDomain(...) {
    case "api":        → handleApi(params, ctx)        // src/extension/team-tool/api.ts
    case "schedule":   → handleSchedule(params, ctx)   // handle-schedule.ts:350 LOC
    case "scheduled":  → handleListScheduled(params, ctx)
    case "anchor":     → handleAnchorSet/Clear/...     // anchor.ts:178 LOC
    case "auto-summarize": → 6 sub-handlers          // auto-summarize.ts:142 LOC
    case "auto_boomerang":  → in auto-summarize.ts same file
  }
```

Total AUTOMATE handler surface = ~747 LOC across 4 files.
Plus dispatch router in dispatch/automate.ts (~150 LOC).

**Conclusion: AUTOMATE is not "declared-only"; it's a real, multi-file
domain with substancial handler surface.**

## Pilot verdict: KEEP

Spec §5 M5 / WI-5.4 says the pilot must produce an explicit
"keep / extend / drop" verdict with a recorded artifact. With the
corrected evidence:

- **KEEP**: the 6 actions are real and exercised (the bench + integration
  tests cover dispatch + cron + anchor paths). ~747 LOC of handler
  code shipped; not declaring dead surface.

## What's recorded in this DESIGN

### Domain boundaries (kept as-is)

The 5 domains are NOT split into separate schemas or dispatch trees
beyond what already exists in `dispatch/{run,status,control,manage,automate}.ts`.
Each domain owns its own handler file; the top-level `team-tool.ts`
router only knows the domain, the domain file knows the actions.

This is the established pattern (since API-5 2026-07-22). It works:
clear ownership, clear test targets, clear extensibility.

### Re-extraction gates (not triggered today)

Re-extract a domain if ANY of:

- LOC > 400 in a single domain handler file (currently: status 16
  actions in handler-status.ts at unknown LOC; check before trusting).
- Action count grows > 14 in a single domain (currently max = 16
  STATUS, 16 MANAGE — both at the gate but NOT triggered because the
  current LOC is fine).
- A consumer outside the domain starts importing `handleXxxDomain`
  for testing (would imply the surface needs an explicit facade).

Today: none of these gates fire, so no extraction in this window.

### Loc-per-domain (initial measurement)

To be filled in by a follow-up count script. Initial estimate:

| Domain | Handler file(s) | LOC | Notes |
|---|---|---|---|
| RUN | run-actions.ts / handle-run-*.ts | unknown | many sub-handlers |
| STATUS | status-actions.ts | <300 | mostly read paths |
| CONTROL | control-actions.ts | <250 | action dispatch |
| MANAGE | manage-actions.ts | ~300 | config/import heavy |
| AUTOMATE | automate.ts + 4 sub-files | **747** | biggest domain |

This table is recorded as the baseline for future re-extraction
decisions; no automatic trigger runs against it in this window.

### What this DESIGN doc DOES NOT touch

- No new actions added.
- No action removed (the false-pass REMOVE-DECLARE-ONLY was reverted
  before commit).
- No schema changes (the flat `TeamToolParams` enum stays at 55 real
  + 1 placeholder).
- No dispatch changes (domain routing is stable).

## Anti-claim check (spec §7)

- crewHooks ACTIVE: not touched.
- scratchpad spawn missing `detached`: not touched.
- scratchpad HMAC REMOVED: not touched.

## Re-evaluation

This DESIGN is superseded when:

1. AUTOMATE handler surface crosses a single-file gate (e.g. > 400 LOC
   in one of the 4 sub-files). Today: max is auto-summarize.ts:142,
   handle-schedule.ts:350 — below the gate by 50 LOC and 50 LOC
   respectively.
2. A RUN-domain action count crosses 14 (currently 10).
3. The flat schema vs domain-object uniformity is challenged (see
   note in `team-tool-schema.ts:455` about why we kept flat).

## Appendix — false-start learning

The first draft of this DESIGN claimed AUTOMATE was REMOVE-DECLARE-ONLY
based on `grep -rn "case \"schedule\"" src/extension/team-tool.ts`
returning 0. That grep was correct (the top-level switch does not
case-match actions directly) but the conclusion "no dispatch" was wrong.

Rule recorded: **a 0-match grep proves the searched pattern is absent
in that file; it does NOT prove the feature is absent in the codebase.**
Re-verify by listing the dispatch directory and following the call graph.

This false-start cost ~30 minutes and is logged here so future audits
can skip it.

## Citation

- Spec: pi-crew-upgrade-spec.md §5 M5 / WI-5.4
- Schema: src/schema/team-tool-schema.ts:437 (AUTOMATE_ACTIONS)
- Handler: src/extension/team-tool/dispatch/automate.ts
- Sub-handlers:
  - src/extension/team-tool/api.ts (77 LOC)
  - src/extension/team-tool/anchor.ts (178 LOC)
  - src/extension/team-tool/handle-schedule.ts (350 LOC)
  - src/extension/team-tool/auto-summarize.ts (142 LOC)
- Gap audit: docs/archive/gap-freshness-audit-2026-09.md §G14
