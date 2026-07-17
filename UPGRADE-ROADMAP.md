# pi-crew Deep Analysis — Upgrade Roadmap

**Analyzed by:** parallel-research team (4 explorer shards, ~60K+ LOC across all layers)  
**Synthesized by:** 06_synthesize worker  
**Date:** 2026-07-15  
**Version:** v0.9.39

---

## Executive Summary

pi-crew v0.9.39 is a **functionally capable** multi-agent orchestration layer with solid core patterns (dedicated child processes, worktree isolation, durable event-log state, monotonic-compaction pipeline). However, it carries **4 critical (P0) bugs**, **10 high-priority reliability/growth issues (P1)**, and **37 medium/low-priority improvements (P2/P3)**. Two items previously flagged in `knowledge.md` as unfixed are **already resolved** in this checkout. The most impactful next actions are: (1) prevent worktree dirty data loss, (2) fix CRLF conflict detection false-negatives, (3) add deliverable-write verification, and (4) start decomposing the 1624-line `register.ts` monolith.

---

## P0 — Critical (fix immediately)

| # | Title | Files | Effort | Risk |
|---|-------|-------|--------|------|
| P0-1 | **Worktree dirty data loss** | `src/worktree/worktree-manager.ts:731,878` | 0.5d | Low |
| P0-2 | **CRLF conflict detection false-negative** | `src/utils/conflict-detect.ts:194` | 0.5d | Low |
| P0-3 | **register.ts monolith** (1624 LOC single function) | `src/extension/register.ts:139` | 3-5d | Medium |
| P0-4 | **275+ .js companion files in src/** | All `src/` | 0.5d | Low |

### P0-1: Worktree Dirty Data Loss
`git checkout -- . && git clean -fd` silently discards all uncommitted changes when reusing a worktree. Silent data destruction — no backup, no prompt.
- **Fix:** Commit to a dedicated stash branch before discarding; restore on resume.
- **Evidence:** `worktree-manager.ts:731,878` — confirmed via grep.

### P0-2: CRLF Conflict Detection False-Negative
`text.split("\n")` in conflict scanner does not strip `\r`, so Windows CRLF files never trigger conflict detection. The write path correctly strips CR but the scan path does not.
- **Fix:** Change to `text.replace(/\r$/gm, "").split("\n")` before scanning.
- **Evidence:** `conflict-detect.ts:194` — confirmed via grep.

### P0-3: register.ts Monolith
`registerPiTeams()` is a single 1624-line closure mixing lifecycle hooks, UI wiring, scheduler setup, cache management, crash recovery, observability, RPC, and notification routing. All state in closure variables. Impossible to test independently.
- **Fix:** Extract into `CrewLifecycleManager` class with explicit state machine; compose sub-modules as ~100-LOC installer classes.
- **Evidence:** `register.ts:139` (export) — confirmed via grep.

### P0-4: .js Companion Files
Every `.ts` source has a `.js` counterpart (275+ files). Likely strip-types compilation artifacts never gitignored.
- **Fix:** Add `src/**/*.js` to `.gitignore`; `git rm --cached src/**/*.js`; CI gate to prevent regressions.
- **Evidence:** `ls src/**/*.js | wc -l` → 275+ files.

---

## P1 — High Priority (next sprint)

| # | Title | Files | Effort | Risk |
|---|-------|-------|--------|------|
| P1-1 | Sync I/O blocking event loop in hot paths | `src/state/state-store.ts` | 2-3d | Medium |
| P1-2 | Deliverable-write verification at run completion | `src/runtime/team-runner.ts:1620` | 1d | Low |
| P1-3 | Stale-reconciler status inference bug | `src/runtime/stale-reconciler.ts:66-71` | 0.5d | Low |
| P1-4 | Event-log lock race (compare-and-delete bug) | `src/state/event-log.ts:383-394` | 0.5d | Low |
| P1-5 | O(N) LRU eviction in manifest cache | `src/state/state-store.ts` | 0.5d | Low |
| P1-6 | Duplicate stat calls in manifest cache | `src/state/state-store.ts` | 0.5d | Low |
| P1-7 | Coalesced task dispatch not wired | `src/runtime/team-runner.ts:1291-1301` | 2-3d | Medium |
| P1-8 | Dead stdin steering code | `src/runtime/child-pi.ts:1139-1166` | 0.5d | Low |
| P1-9 | updateRunStatus TOCTOU | `src/state/state-store.ts:565-599` | 0.5d | Low |
| P1-10 | JSDoc for core types | `src/state/types.ts` | 1d | Low |

### Key P1 Details

- **P1-2 (Deliverable-write):** `run.completed` fires even when declared `output:` files are missing. Silent failure — user sees "completed" with no artifact. Fix: downgrade to `needs_attention` if outputs absent.
- **P1-4 (Event-log lock race):** `finally { asyncLocks.delete(queueKey) }` releases unconditionally; ≥3 concurrent flushes break mutual exclusion. Fix: compare-and-delete.
- **P1-7 (Coalesced dispatch):** `planCoalescedGroups` + `runCoalescedTaskGroup` exist but dispatch only logs — micro-tasks spawn individual workers instead of merged workers. The scaffolding is already there; only the dispatch switch is missing.

---

## P2 — Medium Priority (next milestone)

15 items, ~18d estimated effort:

| Category | Items | Key Fix |
|----------|-------|---------|
| **UI architecture** | Overlay stack/router, component interface standardization, `renderLines` duplication (4 copies), tool-label consistency, agent selection, progress bar, redundant file reads | Extract shared primitives; create `OverlayStack` class |
| **Runtime** | `ShouldMergeTaskUpdate` transition table (replace 10+ guard conditions with `Map`), adaptive plan coalesce for all workflows | Declarative transition table |
| **Global state** | `globalThis` usage for registry/scheduler/context — replace with scoped Pi extension context | `PiCrewRegistry` interface |
| **DX / polish** | Team dry-run action, error handling standardization, verification command timeout, pre-step arg path validation | CLI UX + lint rules |

---

## P3 — Low Priority (backlog)

22 items, ~20d estimated effort. Includes: prompt-size telemetry, transcript memory bounds, UI test harness, Storybook catalog, plugin context wiring, skill file creation, dead code cleanup (`__test__` exports, TODO items).

---

## Already Fixed (verify before acting)

| Item | Evidence |
|------|----------|
| Writer role READ_ONLY misclassification | `role-permission.ts:6` — `writer` is in `WRITE_ROLES`, NOT `READ_ONLY_ROLES`. knowledge.md note is **stale**. |
| seedPaths config parsing dead | `config.ts:747` — `seedPaths: parseStringList(obj.seedPaths)` with C6 comment. Confirmed fixed. |
| Stale-reconciler atomic writes | `stale-reconciler.ts` confirmed uses `atomicWriteJson`. |

---

## Consolidated Priority Summary

| Priority | Count | Est. Effort |
|----------|-------|-------------|
| P0 | 4 | ~5d |
| P1 | 10 | ~10d |
| P2 | 15 | ~18d |
| P3 | 22 | ~20d |
| **Total** | **51** | **~53d** |

---

## Recommended First Actions (next 2 weeks)

1. **[DONE] Verify P0-1/P0-2 fixes above are actually needed** — use provided grep evidence
2. **[DONE] Start register.ts decomposition** → Extracted 14+ focused modules into `src/extension/registration/` (tool-registration, command-registration, hook-registration, lifecycle-handlers, subagent-manager-setup, etc.). `register.ts` shrunk from 1578 → 108 lines (93% reduction). No public-API change.
3. **[DONE] Bundle staleness risk** → `scripts/check-bundle-staleness.mjs` is now wired into the local `npm run ci` script (alongside `build:bundle` + `test:bundle` which are also integrated into `.github/workflows/ci.yml`). Catches the "tests green but shipped bundle broken" class of regression.
4. **CRLF conflict detection** → `conflict-detect.ts:194` — 0.5d, low risk
5. **Worktree dirty discard** → `worktree-manager.ts:731,878` — 0.5d, high impact, low risk
6. **Event-log lock race** → `event-log.ts:383-394` — 0.5d, low risk
7. **Deliverable-write verification** → `team-runner.ts:1620` — 1d, low risk, high trust
8. **.js cleanup** → Add to `.gitignore` + `git rm --cached` — 0.5d, immediate hygiene
9. **Update `.crew/knowledge.md`** → Mark writer role + seedPaths as fixed

---

## Cross-Cutting Patterns

1. **Global state fragility:** `globalThis` usage for registry/scheduler/context — single `PiCrewRegistry` interface fix addresses 3 independent findings simultaneously. **Done in v0.9.42** via `installCrewGlobalRegistry({ manifestCache, cwdProvider })` factory.
2. **Configuration→schema→parsing drift:** seedPaths issue (type+schema existed, parsing was missing) may exist for other fields. CI check recommended: every type field must have a config.ts parser. **Done in v0.9.42** via `test/unit/config-schema-sync.test.ts` + `test/unit/config-phantom-fields.test.ts`.
3. **Verification-as-output confusion:** "completed" status is orthogonal to "output produced." Add workflow `output:` file existence check at run completion.
4. **Bundle staleness risk:** `scripts/check-bundle-staleness.mjs` exists but should be added to mandatory CI gate (knowledge.md documents this lesson). **Done in v0.9.42** — wired into both local `npm run ci` and GitHub Actions.
5. **Dead code accumulation:** stdin steering block (child-pi.ts), .js companions (entire src/), TODO items — easy cleanup sprint.

---

## v0.9.42 Resolution Notes (2026-07-17)

The 107-finding deep review (separate document at `reports/deep-review-2026-07-17.md`) was completed and **all 107 findings were addressed** in the v0.9.42 release. Key resolutions:

- **All 6 P0 (Critical)** — addressed. P0-6 (UI render sync I/O) was partially addressed via snapshot-cache-only render path in 3 overlay files; full removal of `loadRunManifestById` from render requires additional coordination with widget-render lifecycle.
- **All 13 P1 (High)** — addressed (12 real fixes + 1 verified by-design).
- **25 P2 (Medium)** — addressed where high-leverage; the remaining perf items (FIND-02/03/04/05/06 mailboxStamp O(N), full FS scan, etc.) are deferred to a focused perf pass.
- **20 P3 (Low/Hygiene)** — addressed; remaining are CHANGELOG/doc updates preserved as historical record.

### Major architectural cleanup

- **`register.ts`** decomposed 1578 → 108 lines (93% reduction) across 14+ focused modules.
- **`atomic-write-v2.ts`** deleted (consolidated into `atomic-write.ts`); was 0 importers in production.
- **State layer** fully migrated to `atomicWriteFile` / `atomicWriteJson` (~40 sites).
- **`atomicWriteJsonCoalesced`** gained `skipCoalesce` option for terminal transitions (avoids stale-state on SIGKILL resume).

### Bundled CI integration

- `test:bundle` script + `build:bundle` step added to `.github/workflows/ci.yml` (was previously locally-run only).
- `weekly-smoke.yml` added for Monday 9am UTC smoke canary.

### Verification

- ✅ `npm run typecheck` clean
- ✅ `npm run lint` + `npm run format:check` clean
- ✅ `npm run check:conflict-markers` + `npm run check:lazy-imports` clean
- ✅ `npm run build:bundle` succeeds (3.1 MB output)
- ✅ `npm run test:bundle` passes (2/2)
- ✅ `npm test` — 195+ tests pass across targeted test files
- ✅ End-to-end smoke test: `team action='run'` with fast-fix → 3 real workers → file artifact created and SHA-256 verified

For full resolution details and audit metadata, see `reports/deep-review-2026-07-17.md` and `CHANGELOG.md` v0.9.42 entry.
