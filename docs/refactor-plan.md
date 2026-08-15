# pi-crew Refactor Plan — Maintainability & Upgradeability

> Planning artifact, not an accepted spec — see `AGENTS.md` source-of-truth
> order. Produced 2026-08-13 from a full-codebase review of v0.9.68
> (~117K lines TS in `src/`, 797 test files). Lane classification follows
> `docs/FEATURE_INTAKE.md`. Execution must follow the risk lanes: Phase 4 is
> **high-risk** and requires a story folder + human confirmation + ADR before
> implementation.
>
> Status legend: ✅ VERIFIED (checked directly on 2026-08-13 across TWO
> verification sweeps — see Execution log) · 🔍 EXPLORE (re-verify at
> execution time) · ⬜ NOT STARTED · 🔄 IN PROGRESS · ✔️ DONE

## Goal

Make pi-crew easier to maintain and upgrade by reducing file-level complexity,
closing known gaps, and converging duplicated subsystems — **without changing
observable behavior, on-disk state formats, or the public tool API**.

## Non-goals (hard constraints)

| Constraint | Reason |
|---|---|
| No on-disk state format changes (`manifest.json`, `tasks.json`, `events.jsonl`, mailbox JSONL) | Would require a migration plan; out of scope |
| No changes to the 54-action `team` tool schema or slash-command surface | Public API; integrators depend on it |
| No breaking of `// LAZY:` dynamic-import boundaries (40 files) | Cold-start perf (~19% bundle win, `index.ts:7-8` ✅, bench: `scripts/bench-cold-start.mjs`); `check:lazy-imports` gate enforces |
| No merging of sync/async twins (`withRunLock`/`withRunLockSync`, `atomicWriteFile*` pairs) | Deliberate design — see `docs/decisions/2026-08-10-reduce-sync-async-twins.md` |
| No logic changes during code-motion phases | Pure moves only, so the existing test suite is a sufficient regression net |

## Baseline metrics (✅ VERIFIED 2026-08-13)

Largest files (`wc -l`):

| File | Lines | Primary issue |
|---|---|---|
| `src/runtime/team-runner.ts` | 2660 | `executeTeamRunCore` core loop (321 lines, :2339–2660 ✅) + 13-field `SchedulerContext` (:1058 ✅) mutated in-place with caller sync-back (RT-15). CORE-4 comment (:1044-1049) documents ongoing extraction from a ~1075-line god function — this plan continues that trajectory |
| `src/state/event-log/event-log.ts` | 1495 | Sequence cache + cursor staleness logic in one file; rotation + `.gen` sidecar I/O already split into `event-log-rotation.ts` ✅ (:295-332) |
| `src/config/config.ts` | 1298 | Loader + merge + validation + `sanitizeProjectConfig` (:272 ✅) mixed |
| `src/runtime/broker/crew-broker.ts` | 1280 | Socket server + handshake + token registry + fanout |
| `src/worktree/worktree-manager.ts` | 1268 | Creation + dirty protection + cleanup + seed overlay |
| `src/state/stores/state-store.ts` | 1260 | CRUD + manifest I/O (CAS loop lives elsewhere — see 2.5) |
| `src/extension/registration/commands.ts` | 1228 | 30 slash commands in one file (`registerCommand` ×30 ✅); note `command-registration.ts` / `command-utils.ts` already exist alongside |
| `src/runtime/live-session/live-session-runtime.ts` | 1222 | Divergent duplicate of child-process runtime (see Phase 4) |
| `src/ui/run-snapshot-cache.ts` | 1076 | One of 3 UI cache layers with separate TTLs (`RunSnapshotCache` 1500 ms ✅ :28; `ManifestCache` **lives in `src/runtime/manifest-cache.ts:46`, TTL 500 ms** ✅ sweep 3 — not in extension/registration as earlier stated; `buildSignature` 100 ms ✅ `run-dashboard.ts:117`) |
| `src/runtime/child-pi/child-pi.ts` | 959 | 6 timer constructs inside one Promise constructor ✅ |

Other verified numbers:

- Env vars: **146 unique `PI_CREW_*` + 43 `PI_TEAMS_*` mirror aliases = 189
  unique names**; **≥59 dot-notation read sites** (41 `process.env.PI_CREW_`
  + 18 `process.env.PI_TEAMS_` occurrences ✅). No central registry.
- `src/utils/conflict-detect.ts` (721 lines): no production caller in `src/`
  ✅ — but 2 test files DO use it (`test/unit/conflict-detect.test.ts`,
  `conflict-detect-mixed-eol.test.ts` ✅) → relocate, don't delete.
- Tool schema: 54 actions = 9 run + 16 status + 7 control + 16 manage + 6
  automate (`src/schema/team-tool-schema.ts:381-431` ✅).
- Incident-tag comments confirmed present in `src/` (files per tag): H-1 (4),
  ST-7 (4), ST-8 (2), ST-12 (1), ST-14 (1), RT-15 (1), RT-NEW-2 (1), F4 (12),
  F6 (6), F12 (5), S-6 (3), C9 (4), P0-4 (2), Round 26 (2), OPT-01 (1),
  OPT-PHASE2 (1). ✅ These are load-bearing — see working rule 3.
- Test gates: `test:critical` = 14 files (9 broker + keybinding parity +
  pi-tui-dispatch-probe + session-utils-extract + config-schema-sync +
  child-pi-env-spread ✅); `test` = unit + integration; `ci` = typecheck +
  lint + format:check + test + `check:*` (lazy-imports, bundle-staleness,
  bundle-size, conflict-markers, decision-drift, event-types, lockfile-sync).

## Global working rules for every phase

1. One phase = one or more **separate, revertible commits** (conventional
   commits: `refactor:`, `chore:`, `docs:`).
2. After every step: `npm run test:critical && npm run typecheck`.
   After every phase: full `npm run ci` green.
3. **Race-fix comments travel with the code they describe.** Comments tagged
   `H-1`, `ST-7`, `ST-8`, `ST-14`, `RT-15`, `F4`, `F6`, `F12`, `S-6`, `C9`,
   `Round 26 BUG n`, `OPT-01`, `OPT-PHASE2` document real incidents (all
   confirmed present ✅). When moving code, move the comment verbatim. Never
   "simplify" guarded code without reading the referenced incident.
4. Two-step moves for heavily imported modules: (a) create new file +
   re-export from the old path; (b) update import sites in a follow-up commit.
   Keeps diffs reviewable and bisectable.
5. Do not claim validation without running the command (`docs/HARNESS.md`
   validation ladder).

---

## Phase 0 — Baseline (tiny lane, ~0.5 day)

| Step | Action | Acceptance |
|---|---|---|
| 0.1 | Run `npm run ci` on clean HEAD; record test counts, bundle size, and pass status in the Execution log below | Baseline recorded; HEAD green |
| 0.2 | Create branch `refactor/maintainability` in the pi-crew repo | Branch exists; no working-tree changes carried over |

Rollback: delete branch.

---

## Phase 1 — Dead code, stale comments & cleanup hardening (tiny/normal lane, ~1–2 days)

Lowest risk, immediate signal improvement. **Premises re-verified in sweep 2 —
two original items were reframed (1.2, 1.4) after finding existing consumers
and cleanup paths.**

| Step | Action | File mapping | Acceptance |
|---|---|---|---|
| 1.1 | Relocate orphaned `conflict-detect.ts` into the test tree (tests confirmed to use it ✅ — deletion is NOT an option) | `src/utils/conflict-detect.ts` → `test/helpers/conflict-detect.ts`; update imports in `test/unit/conflict-detect.test.ts` + `conflict-detect-mixed-eol.test.ts` | `rg "conflict-detect" src/` → 0 hits; the 2 test files green |
| 1.2 | Reconcile the stale `PI_CREW_PARENT_PID` comment — the var is NOT dead: defined as `PI_CREW_PARENT_PID_ENV` (`src/prompt/scratchpad-lifecycle.ts:50` ✅), wired into scratchpad guest env (:166 ✅), consumed by guest-zombie detection (`test/runtime/scratchpad/guest-zombie.test.ts` ✅). **Production reader confirmed sweep 3**: `src/runtime/process/zombie-scanner.ts:185` reads `environ.PI_CREW_PARENT_PID` via `readProcEnviron` (`/proc/<pid>/environ`, :48-52). **parent-guard IS wired** — `startParentGuard(parentPid)` is called at `src/runtime/background-runner.ts:615` (self-termination when orchestrator's parent dies). What is NOT wired is the *child-pi worker* entry point: the `pi` binary dist does not read this var / call `startParentGuard` (grep of dist = 0 matches, per `parent-guard.ts:13` and `child-pi-spawn.ts:144-145`), so spawned child-pi workers cannot self-terminate on leader death — they rely on the reactive zombie scanner. The `child-pi-spawn.ts:74` "currently UNUSED" comment is therefore misleading (it is unused *by the pi binary*, not unused overall). Do NOT remove the var. | `src/runtime/child-pi/child-pi-spawn.ts:74,144-145`, `src/runtime/async-runner.ts:198`, `src/runtime/background-runner.ts:615`, `src/runtime/process/zombie-scanner.ts:185`, `src/runtime/parent-guard.ts`, `src/prompt/scratchpad-lifecycle.ts` | Fix the `child-pi-spawn.ts:74` comment to name the actual consumer (zombie-scanner + background-runner) and clarify "unused by pi dist specifically"; EITHER upstream a `startParentGuard` call into the pi worker entry point OR document the reactive-scanner-only model as intentional — decision recorded in `docs/decisions/` |
| 1.3 | Resolve `crew_agent_steer` stub (confirmed: returns `t("steer.noted")` + `t("steer.unavailable")` at `subagent-tools.ts:381-382` ✅) — pick ONE: (a) implement real steering through the existing steering-JSONL mechanism (`child-pi/child-pi-steering.ts` ✅ exists), or (b) mark the tool response + docs as "planned, not implemented" | `src/extension/registration/subagent-tools.ts`, `docs/actions-reference.md` | Behavior matches docs; decision recorded |
| 1.4 | **Reframed after sweep 2** — all three maps ALREADY have cleanup: `lastProgressContentHash.delete(runId)` at `team-runner.ts:1041` ✅ (+ `__test__` export :555), `clearStablePrefixCache()` at `prompt-builder.ts:127` ✅ ("called at run end"), `transcriptBatches` flush+clear at `child-pi-transcript.ts:68/:129` ✅. Residual risk = exception path only: a throw between set and cleanup leaks entries in the long-lived Pi host process. Action: guarantee cleanup runs from `finally`/finalize on every exit path | Same 3 files | New unit test: entries gone even when the run throws mid-flight; cleanup invoked from `finally`, not only the happy path |
| 1.5 | **Round 7 dead cleanup functions (14 findings)** — remove or relocate: dead modules `blob-store.ts`, `intercom-bridge.ts`, `process-lifecycle.ts`, `intermediate-store.ts` (verify DWF intent first, dynamic-workflow-context.ts:152), `hook-integrations.ts` + `clearHooks` (registry.ts:26); dead fns `clearCheckpoint`/`clearCheckpointStores` (checkpoint.ts:225,172 — KEEP `FileCheckpointStore`, wired via status.ts:13,200), `clearCache`/`saveRunToCache` (run-cache.ts:137,84 — read path wired), `cleanupIntermediates` (intermediate-store.ts:137), `resetHookStats` (hook-integrations.ts:46), `resetPerWriteValidatorCache` (per-write-validator.ts:91), `resetEventLogMode` (event-log.ts:601 — move to test helpers, Phase 2.4), `clearReadCache` (file-coalescer.ts:66), `disposeAll*` (process-lifecycle.ts:419,468,485), `clearSecurityEventLog` (discover-agents.ts:148 — observability gap, wire or document), `resetTaskNames` (task-name-generator.ts:335), `clearTaskGraphIndexCache` (task-graph-scheduler.ts:54 no-op), `cleanupOrphanedBlobs` (blob-store.ts:273 + fix false doc :212). See `refactor-plan.review.md` §ROUND 7 for full table. | Modules listed + their test files | `rg "(blob-store|intercom-bridge|process-lifecycle|intermediate-store|hook-integrations)" src/` → 0 hits (except dynamic-workflow-context.ts:152 comment if DWF revives intermediate-store); all dead-module test files relocated to `test/helpers/` or removed; `test:critical` green |
| 1.6 | **Round 7 plan-data correction** — `retry-runner.ts` is a DEAD module (0 src callers) but plan Phase 2 §5.3 targets it. Decide: (a) mark retry-resume as building on `retry-executor.ts` (the wired primitive) and drop retry-runner from scope, OR (b) revive retry-runner with a real caller + tests first. Record decision in the Phase 2 §5.3 execution. Also fix `cleanupOrphanedBlobs` false doc-promise (blob-store.ts:212). | `docs/refactor-plan.md` Phase 2 §5.3 note; `src/runtime/recovery/retry-runner.ts`; `src/state/stores/blob-store.ts:212` | Decision recorded; Phase 2 §5.3 references the correct wired module |
| 1.7 | **Round 8 — 45 dead modules sweep** — add to Phase 1 removal scope: HIGH `safe-bash.ts`+`safe-bash-extension.ts` (**false security promise — escalate: remove or wire**; 503+ lines, ships in npm tarball); MEDIUM `pipeline-runner.ts` (decide revive-or-remove before Phase 2.6), `schedule.ts` (duplicate of live scheduler.ts — consolidation decision), `hook-instinct-bridge`→`instinct-store`→`project-detector` (transitive-dead chain, 3 modules), `jsonl-writer.ts` (event-log family — Phase 2.4 account), `compaction-summary.ts`, `crew-errors.ts` (duplicate of errors.ts taxonomy); LOW 30 modules (agent-search, resilient-parser, prometheus-exporter, metric-retention, loop-gates, metric-parser, phase-tracker, run-drift, task-quality, run-projection, post-checks, stream-preview, tool-progress, session-state-map, observation-store, tiered-eval+types-eval pair, fingerprint, gh-protocol, sse-parser, cost-estimator, cat-frames, result-watcher, agent-management-overlay, crew-footer, crew-select-list, capability-pane, transcript-entries). **NOTE: `parallel-utils.ts` is LIVE (dynamic-workflow-context.ts:41,515,531) — NOT dead (reviewer correction)**. See `refactor-plan.review.md` §ROUND 8. | Modules listed + test files | `rg "(safe-bash|pipeline-runner|schedule.ts|hook-instinct-bridge|instinct-store|project-detector|jsonl-writer|compaction-summary|crew-errors|agent-search|gh-protocol)" src/` → 0 production hits (except wired twins); test files relocated to `test/helpers/`; `test:critical` green |
| 1.8 | **Round 9 — dead-module test relocation map (13 test files)** — Phase 1.5/1.7 removals PHẢI relocate/delete kèm test files: `blob-store.test.ts`, `intercom-bridge.test.ts`, `process-lifecycle.test.ts`, `intermediate-store.test.ts`+`-traversal`, `hook-integrations.test.ts`, `pipeline-runner.test.ts`, `schedule-store.test.ts`+`schedule-cov.test.ts` (tests exercise dead module), `jsonl-writer.test.ts`+`-cov`, `compaction-summary.test.ts`, `crew-errors.test.ts`, `agent-search.test.ts`, `gh-protocol.test.ts`. **`safe-bash.ts` có 5 test files** (safe-bash/ansi/whitelist/extension-cov/dangerous-rm-expanded) — PHẢI delete cùng. `hook-instinct-bridge` 0 tests (safe remove). See `refactor-plan.review.md` §ROUND 9. | Test files listed | Mọi dead-module removal kèm test files relocated/removed; `test:critical` green |
| 1.9 | **Round 9 — test coverage gaps (5 MEDIUM)** — test-first gating: (a) **commands.ts (Phase 2.1)** — add handler-level tests trước split (parseRunArgs dispatch, team-config/autonomy/prune/export arg paths, notifyCommandResult error, command-utils units); (b) **team-runner extraction targets (Phase 2.6)** — add tests trước/với code-motion cho `selectDispatchBatch` (:1363), `mergeUnitResult` (:1925), `advanceWorkflowPhases` (:2004), `requiresPlanApproval` (:662), `ensurePlanApprovalRequested` (:677), `mergeArtifacts` (team-runner-artifacts.ts); (c) **config.ts (Phase 2.2)** — add `__test__` exports cho `sanitizeProjectConfig` (:272)/`mergeConfig` (:359) + precedence matrix + sensitive-key drop-list. See `refactor-plan.review.md` §ROUND 9. | Same files | Mỗi file tách có ≥1 direct test mới cho extraction targets; `npm test` green trước khi move code |
| 1.10 | **Round 12 — L1 cleanup (23 callsites console→logInternalError)** — convert theo security re-rank: pi-spawn.ts:243 (silent binary-pin fallback), discover-workflows.ts:158 (+ **redact preStepScript body :159 — NEW secret-exposure P1**), state-store.ts:946/1108/1245/447/887/1097/1234, team-runner.ts:201/224/2105/2130/2151, stale-reconciler.ts:549/556/620, process-lifecycle.ts:319, merge-gate.ts:126, active-run-registry.ts:374, orphan-worker-registry.ts:204, mailbox.ts:490, discover-agents.ts:497. **4 guardrails bắt buộc**: (a) explicit `"error"/"warn"` severity — never default `"debug"` (gated PI_TEAMS_DEBUG); (b) redact preStepScript body; (c) logInternalError future redaction hook; (d) pi-spawn pass error object (stack lost). 6 files thêm import mới. See `refactor-plan.review.md` §ROUND 12. | 11 files (state-store, team-runner, stale-reconciler, pi-spawn, process-lifecycle, merge-gate, active-run-registry, orphan-worker-registry, discover-workflows, mailbox, discover-agents) | `rg 'console\.(error|warn)' src/` → chỉ còn skipped list (background-runner, parent-guard, guest.ts, debug-only, user-facing notices); `npm test` + `tsc --noEmit` green |
| 1.11 | **Round 11 — security hardening (4 findings)** — fix: R11-1 (MEDIUM) retrieval-orchestrator.ts:148 add rg timeout 30-60s + SIGKILL + stdout cap ~10MB; R11-2 (LOW) background-runner.ts:417/468 `assertSafePathId("runId", runId)` tại argValue boundary; R11-3 health-store.ts:44 reuse validated runId; R11-4 team-runner.ts:175/217 optional AbortSignal. See `refactor-plan.review.md` §ROUND 11. | retrieval-orchestrator.ts, background-runner.ts, health-store.ts, team-runner.ts | `test:critical` green; synthetic huge-repo test cho rg timeout (R11-1) |

Phase gate: `npm run ci` green.

---

## Phase 2 — God-file decomposition (normal lane, ~3–5 days)

**Pure code-motion only.** Order is least-risky first so the riskiest file
(`team-runner.ts`) is done last with the most confidence accumulated. All
proposed new filenames were checked against existing trees — no conflicts ✅.

### 2.1 `commands.ts` (1228) — slash commands

| From | To |
|---|---|
| `src/extension/registration/commands.ts` | `commands/index.ts` (registration wiring only), `commands/run.ts`, `commands/status.ts`, `commands/manage.ts`, `commands/dashboard.ts` |

Acceptance: all 30 commands still registered (existing command tests green);
`register.ts` diff is import-only; no collision with existing
`command-registration.ts` / `command-utils.ts` naming.

### 2.2 `config.ts` (1298) — config subsystem

| From | To |
|---|---|
| `src/config/config.ts` | `config.ts` (loader + public re-exports), `config/sanitize-project-config.ts` (`sanitizeProjectConfig`, :272 ✅), `config/config-merge.ts` (precedence merge), `config/config-validation.ts` |

Acceptance: existing sanitize/merge tests pass unchanged; public exports of
`src/config/config.ts` unchanged (re-export shim).

### 2.3 `child-pi.ts` (959) — child process lifecycle

| From | To |
|---|---|
| `src/runtime/child-pi/child-pi.ts` | `child-pi.ts` (spawn + main Promise), `child-pi/child-pi-timers.ts` (6 timer constructs ✅: `noResponseTimer`, `finalDrainTimer`, `hardKillTimer` :331-333, `safetyTimer` :419, `cancelHardKill`, `pollHandle` interval :503) |

Acceptance: `test:critical` green (its 14-file set includes
`child-pi-env-spread` ✅ covering spawn env); timer cleanup paths unchanged
(F12 quiet-window, post-exit stdio guard).

### 2.4 `event-log.ts` (1495) — event log

| From | To |
|---|---|
| `src/state/event-log/event-log.ts` | `event-log.ts` (append/read API), `event-log/sequence-cache.ts` (seq cache + `.seq` sidecar), `event-log/cursor.ts` (byte-offset cursors + generation staleness check, currently :1426 ✅). Rotation + `.gen` sidecar I/O ALREADY split: `event-log/event-log-rotation.ts` ✅ (thresholds 4 MB / 50k events / compact-to-1k at :121-123; `generationPath` :295) |

Acceptance: rotation invariants preserved (4 MB / 50k events, ST-8);
`.seq`/`.gen` sidecar behavior byte-identical; event-log tests green.

### 2.5 `state-store.ts` (1260) — state store

| From | To |
|---|---|
| `src/state/stores/state-store.ts` | `state-store.ts` (CRUD), `stores/manifest-io.ts` (manifest load/retry on mtime instability) |

**Correction from sweep 1:** the CAS loop (`persistSingleTaskUpdate`,
`MAX_CAS_ATTEMPTS = 10` at :52, "failed to converge" at :133) lives in
**`src/runtime/task-runner/state-helpers.ts`**, not in `state-store.ts`.
Either extract it to `stores/cas-loop.ts` as part of this step or leave it in
place — decide at execution; do not silently move it with the state-store
split.

Acceptance: CAS convergence behavior unchanged (10-attempt cap + throw);
lock usage unchanged (`withRunLockSync`); state tests green.

### 2.6 `team-runner.ts` (2660) — scheduler core (riskiest, do last)

All extraction sources confirmed present (sweep 2 ✅):

| From (function, line) | To |
|---|---|
| `executeTeamRunCore` (:2339, 321 lines) | `team-runner.ts` — thin orchestrator, target ≤ 150 lines |
| `SchedulerContext` interface (:1058, 13 fields) + sync helpers | `runtime/scheduler-context.ts` — resolves RT-15 |
| `selectDispatchBatch` (:1363) + `dispatchBatch` (:1539) | `runtime/dispatch-batch.ts` |
| `mergeUnitResult` (:1925) | `runtime/merge-loop.ts` |
| `enforceRunBudget` (:2091) | `runtime/budget-enforcement.ts` |
| `requiresPlanApproval`/`isPlanApprovalPending`/`ensurePlanApprovalRequested`/`cancelPlanTasks` (:662-738) | `runtime/plan-approval.ts` |
| `finalizeRun` (:2189) | `runtime/finalize-run.ts` |
| `cancelRunFromSignal` (:1151), `handleFailedTask` (:1291), `advanceWorkflowPhases` (:2004), `terminaliseRunWithDrain` (:1230) | stay in `team-runner.ts` or move with their closest collaborator — decide per-function at execution |

Acceptance: streaming dispatch semantics unchanged (OPT-01: dispatch on slot
release, not batch completion — :1481-1487 ✅); monotonic merge policies
P1/P2/P3 untouched (`merge-gate.ts` ✅ exists, NOT in scope); adaptive plan
injection (`injectAdaptivePlanIfReady`, `goal-workflow/adaptive-plan.ts:372`
✅) + policy closeout (`evaluateCrewPolicy`, `policy-engine.ts` ✅) behave
identically; full `npm test` green, not just `test:critical`.

Phase gate: `npm run ci` green; `check:lazy-imports` green; bundle rebuilds
and `check:bundle-staleness` passes.

---

## Phase 3 — Locking & env-var registry (normal lane, ~2–3 days)

| Step | Action | File mapping | Acceptance |
|---|---|---|---|
| 3.0 | **Pre-refactor hardening (independent, low risk — Round 4 S-R1)**: tighten `crew-agent-records.ts` lock file permission `0o644`→`0o600` (`:158`). locks.ts already uses `0o600` (`:189`); the agents-record lock file contains `{pid,createdAt}` which is world-readable today on shared multi-user systems. Pure tightening, no behavior change. | `src/runtime/crew-agent-records.ts:158` | Lock tests green; `test:critical` green |
| 3.1 | Audit the lock families. **5 distinct lock families confirmed sweep 3**: (a) `withFileLockSync` (:390) / `withFileLockAsync` (:523) / `withRunLockSync` (:596) / `withRunLock` (:631) in `src/state/coordination/locks.ts`; (b) agents-record locking in `src/runtime/crew-agent-records.ts`; (c) **event-log mkdir lock** at `src/state/event-log/event-log.ts:109` — `${eventsPath}.mkdirlock` dir, `fs.mkdirSync(lockDir)` with O_EXCL semantics (:127), stale detection via `process.kill(pid,0)` TOCTOU (:141-152), async variant `withEventLogLockSync` (:485), documented at :472-485 ✅; (d) atomic-write uses O_EXCL atomic temp+rename (NOT a lock-family consumer). **Round 4 verdict: RISKY (HIGH)** — see `refactor-plan.review.md` §ROUND 4 P1. The unification is feasible but the original claims "same primitives / staleMs 30s uniform / on-disk format unchanged" are NOT fully sound: (i) staleMs is non-uniform — event-log uses 10s (`:117,:519`), locks.ts + agents-record use 30s; (ii) primitives diverge — event-log is a DIRECTORY not a file, agents-record lacks the `token` field locks.ts uses for race-safe release; (iii) re-entrance is per-AsyncLocalStorage (H-1/ST-14 fixes), not a simple `{reentrant}` boolean; (iv) security gaps S-R1/S-R2/S-R3 — permission `0o644`, symlink guards missing, PID-only release. **ADR must decide ONE**: (α) **exclude event-log mkdir lock (c) from unification** — subsume only (a)+(b), accept format change for (b) (add token), document (c) as intentionally separate; OR (β) unify all three with an accepted on-disk format change. Recommend (α). | New: `src/state/file-lock.ts`. **Call sites corrected sweep 3** — `atomic-write.ts` does NOT call any lock (uses O_EXCL atomic rename, not a lock consumer). Actual consumers: `mailbox.ts` (largest, ~10 call sites), `state-store.ts` (`withRunLock` :584/:613), `event-log.ts` (mkdir lock :109/:485), `run-cache.ts` (:62/:119), `config.ts` (:1238/:1272), `decision-ledger.ts`, `instinct-store.ts` (commented). **⚠️ Round 7 correction: `blob-store.ts` is a DEAD MODULE (0 src importers) — its `:59` lock use is unreachable; REMOVE from this list** (see `refactor-plan.review.md` §ROUND 7 R7-1). | ADR in `docs/decisions/` documenting the (α)/(β) choice + the 4 divergences above; all existing lock tests green; symlink guards + token-guarded release carried to every unified family; no regression to H-1/ST-14 re-entrance or 30s/10s stale defaults (kept per-family) |
| 3.2 | Create central env registry: name, default, parser, deprecated `PI_TEAMS_*` alias mapping. Scope: 189 unique names, ≥59 dot-notation read sites ✅. **Bracket/destructure forms quantified sweep 3**: only **2 bracket sites** (`prompt-runtime.ts:228` `[PI_CREW_MAX_OUTPUT_ENV]` + `:260` `[PI_CREW_STEERING_FILE_ENV]`) and **0 destructure forms** in `src/` — the codemod is far smaller than estimated; the dot-notation sites are the bulk of the work | New: `src/config/env-vars.ts`; codemod the 2 bracket sites + all dot-notation sites | New gate `check:env-vars` (patterned on the existing `check-decision-drift.mjs` / `check-lazy-imports.mjs` gates in `scripts/` ✅): fails on raw `process.env.PI_CREW_`/`PI_TEAMS_` reads (and bracket forms) outside the registry; README env table generated or linted from registry |
| 3.3 | **Round 13 stale-snapshot RMW fix (HIGH priority)** — codify "mọi tool handler write phải fresh-re-read INSIDE lock". 4 concrete sites: `cancel.ts` handleRetry (R13-1: :122 best-effort load → await before_retry hook :136 unbounded gap → saveRunTasks từ stale loaded.tasks :189 — completed state clobber, terminal evidence destroyed, double-execution), handleCancel (R13-2: stale manifest write flip terminal status về cancelled); `api/task-claims.ts` ×3 (:50/:107/:171 — claim/heartbeat/transition từ stale array, canTransitionTaskStatus validate stale status); `api/heartbeat.ts:33`. Fix template: `respond.ts:43` re-read `fresh = loadRunManifestById` INSIDE `withRunLockSync`. Also sweep remaining `withRunLockSync(loaded.manifest, ...)` không fresh-re-read (mailbox.ts, agent-control.ts, read.ts ctx.loaded consumers). See `refactor-plan.review.md` §ROUND 13. | `cancel.ts`, `api/task-claims.ts`, `api/heartbeat.ts`, `respond.ts` (template), + sweep results | Mọi tool handler write fresh-re-read trong lock; regression test: concurrent runner persist + tool write → terminal state không bị clobber; `test:critical` + `npm test` green |
| 3.4 | **Round 14 — stale-snapshot class completion (4 sites mới)** — extend 3.3: **status.ts:50,67,78 (R14-1 HIGH)** — write-on-read-path (site duy nhất trong sweep) — move dead-async side-effect ra khỏi read path (async-notifier.ts:96 pattern) HOẶC wrap lock + fresh re-read + **ownership gate (ownerSessionId)** (bất kỳ session poll foreign run có thể trigger transition); **background-runner.ts:898 (R14-2 MEDIUM)** — one-liner dùng `manifestToUse` (fresh read trong lock hiện bị discard, write dùng outer stale var NGOÀI lock); **crash-recovery.ts:137-190 (R14-4 MEDIUM latent)** — applyRecoveryPlan/declineRecoveryPlan await run_recovery hook rồi save từ stale — lock + fresh re-read sau hook (dashboard manual-accept path chưa wire — wire trước khi dùng); **run.ts:104 (R14-3 LOW)** — optional hardening. Part B closed: B1 broker handleConnection check `this.stopped` (MINOR optional), B2/B3 FALSE. See `refactor-plan.review.md` §ROUND 14. | `status.ts`, `background-runner.ts`, `crash-recovery.ts`, `run.ts`, `crew-broker.ts` (B1 optional) | Tất cả write-on-read-path sites fresh-re-read trong lock + ownership-gated; regression test concurrent writer; `test:critical` green |
| 3.5 | **Round 15 — finalizeRun/mergeUnitResult terminal races (2 MEDIUM + 2 LOW)** — **finalizeRun (R15-1)**: move CẢ 2 writes (`saveRunManifestAsync` :2309 UNLOCKED + joint save :2312 locked) sau 1 lock duy nhất re-read disk; preserve disk terminal (cancelled/failed) hoặc `signal.aborted` → skip completion branch (mirror CANCEL-1). **mergeUnitResult (R15-2)**: preserve disk-terminal status khi force "running" (chỉ từ non-terminal) + route cancel-during-exec; optional top-of-loop disk-status check — 1 work item chung với R15-1. **Security S1**: re-check ownerSessionId trong lock (cancel.ts:243-250, retry.ts:126-130 hiện ngoài lock). **run-coalesced-task-group.ts (R15-3)**: heartbeat chỉ touch group's own tasks (persistHeartbeat) hoặc fresh re-read. **locks.ts/cancel (R15-4)**: optional catch "locked" retry backoff — lưu ý side-effect này prevent R13 same-process clobber. See `refactor-plan.review.md` §ROUND 15. | `team-runner.ts`, `cancel.ts`, `retry.ts`, `run-coalesced-task-group.ts`, `locks.ts` | Regression test: cancel giữa loop-exit và finalizeRun → disk status = cancelled (không bị flip completed); merge không erase disk-terminal; `test:critical` + `npm test` green |
| 3.6 | **Round 16 — event-log dual lock-namespace contention (R16-B1 MEDIUM)** — `event-log.ts:109` `.mkdirlock` (sync) vs `:516` `.alock` (async) trên cùng eventsPath → **duplicate seq** (reserveSequenceUnderLock :412 trust sidecar, no mutual exclusion; 2 processes đọc N đều reserve N+1 → readEventsCursor sinceSeq silently drops event 2) + **rotation stranding** (sync append mid-appendFileSync giữ fd trên renamed inode → event lands trong archive, invisible live readers). **14 parent-side sync appendEvent sites** write live-run path (cancel.ts:361, status.ts:82/130, task-claims.ts:54/111/175, heartbeat.ts:45, mailbox.ts:132/188/194, agent-control.ts:57/317, plan-approval.ts:66/144) — contradict mitigation "extremely unlikely". **Fix KHÔNG naive merge (v0.9.26 deadlock)**: (1) common `.seqlock` cho seq reservation only (mailbox ST-3 .flock pattern mailbox.ts:574-584); (2) port EL-1 guard vào reserveSequenceUnderLock; (3) route parent sync appendEvent qua async queue khi child live. **status.ts amplifier**: fix R14-1 unlocked writes cùng lúc (mỗi status poll mở window). See `refactor-plan.review.md` §ROUND 16. | `event-log.ts`, `event-log-rotation.ts`, `status.ts` (R14-1 interplay), `cancel.ts` | Stress test: 2 processes append cùng eventsPath (1 sync 1 async) → không duplicate seq; rotation trong khi sync append → không event stranded; `test:critical` green |
| 3.7 | **Round 17 — R16-B1 CONFIRMED EMPIRICALLY + error-path fixes** — **R16-B1 = P0/P1 (empirically justified)**: stress test 3000 events → **527 duplicate seq, 2260 duplicate events (75%)**; natural rate 4000 events → 75% — comment event-log.ts:487-490 "extremely unlikely" refuted. Fix: single lock namespace / shared `.seqlock` + **commit durable regression bench `bench/b9-eventlog-dual-namespace.bench.ts`** (script /tmp đã xóa — đừng để fix không provable). **R17-B1 HIGH**: `crew-agent-records.ts:140-146` removeStaleAgentsLock catch nuốt mọi lỗi → root cause invisible sau 60s "Crew agents file is locked" — add logInternalError. **R17-S1 NEW (security)**: event-log size-limit skip returns SILENT SUCCESS — trả lỗi hoặc log rõ. **R17-B2 RETRACTED (FP)**: buffer cap-drop đã reject promises (H3 fix). R17-B3/B4/B5 LOW optional debug logs. See `refactor-plan.review.md` §ROUND 17. | `event-log.ts`, `crew-agent-records.ts`, + bench file mới | Regression bench: concurrent sync+async appends → 0 duplicate seq; `test:critical` green |
| 3.8 | **Round 18 — rotation stranding CONFIRMED + R17-S1 ESCALATED HIGH + fix-scope gap** — **(a) Rotation stranding empirical (R16-B1 effect 2)**: 18,478/340,562 (5.43% max-contention) appends stranded vào archive — readers/reconstructor KHÔNG đọc archives, sweepOldArchives unlink sau 7 ngày → **events gone forever**. Fix: archive-tail reads (mailbox safeReadMailboxFile pattern) — recommend (a). **(b) R17-S1 ESCALATED HIGH**: size-limit skip `return fullEvent` as-if-persisted + drop log debug-gated (no severity → PI_TEAMS_DEBUG) → **fully silent**; security: rotation-failure chain also silent (callers ignore rotate boolean, event-log.rotate debug-gated) → cover cả chain (severity "error" + check rotation boolean + **gate emitFromTeamEvent trên !skippedDueToSize** — reviewer addendum: UI nhận events không persisted). Sync-path fix prefer indicator-over-throw (callers trong withRunLockSync). **(c) Fix-scope gap MEDIUM**: `.seqlock` chỉ fix duplicate-seq, KHÔNG fix rotation-stranding → Phase 3.6 acceptance "không event stranded" không met bởi .seqlock — thêm archive-read. Lock ordering L1→L2→L3 consistent — no deadlock. See `refactor-plan.review.md` §ROUND 18. | `event-log.ts`, `event-log-rotation.ts`, `event-reconstructor.ts` | Bench mới cho CẢ 2 effects (seq collision + stranding); readers đọc archive tails; `test:critical` green |

Phase gate: `npm run ci` green including the new gate.

---

## Phase 4 — Runtime-path convergence (HIGH-RISK lane, ~3–5 days)

Verified divergence between child-process and live-session paths:

- **Fallback execution**: BOTH paths resolve fallback chains via
  `model-fallback.ts` (live-session imports it at :19-25, builds
  `fallbackChain` at :720/:1157, reports `autoFallbackCount` :1160 ✅).
  The divergence is in *execution semantics*: `child-executor.ts` runs an
  explicit multi-attempt loop over candidates, while live-session delegates
  to `createAgentSession` and only reports `modelFallbackMessage`. (Earlier
  review claim "live-session has no fallback" was corrected in sweep 1.)
- **Worker cap**: live-session has zero references to
  `withWorkerSlot`/`workerCap` ✅ — it bypasses the global worker semaphore.
- **Depth guard**: zero `depth` references in `live-session-runtime.ts` ✅ —
  no depth guard on the in-process path.
- **Progress persist**: divergence is at the *executor* layer, not the runtime layer — both `task-runner/child-executor.ts` and `task-runner/live-executor.ts` persist (both call into `state-helpers.ts` save paths). `live-session-runtime.ts` itself does NOT call `saveRunTasks*` / `saveRunManifest*` directly (grep = 0). Sweep 3.
- **Tool filtering**: divergent. child-pi passes an explicit restrictive `--tools` list at spawn; live-session relies on pi's `DefaultResourceLoader` via `createAgentSession` (`live-session-runtime.ts:743`) which has "no explicit per-extension allow/deny API at the point we hand off" (comment :675-676) — i.e. live-session is permissive by default. Sweep 3.
- **Kill/abort**: confirmed divergent. child-pi = `killProcessTree` SIGTERM→3s→SIGKILL (`child-pi/child-pi-kill.ts`); live-session = `ac.abort()` (`:522`) + `session.abort?.()` (`:963`/`:1007`). ✅

**Step 4.0 — decision first.** **Round 4 verdict: RISKY (HIGH)** — see `refactor-plan.review.md` §ROUND 4 P2. Convergence premise overstates the shared contract: the live path has NO fallback loop to share (delegates to `createAgentSession` SDK), `withWorkerSlot` is owned by `run-worker.ts` and semantically wrong to apply to in-process sessions, and a shared `TaskExecutor` runs in two different trust tiers (child: validated binary + process isolation; live: in-process SDK — S-R4). Only progress-persist has genuine convergence potential. **Recommend option (a) freeze** unless there is a compelling reason to abandon SDK delegation.

- **(a) Freeze live-session** ◀️ **recommended (Round 4)**: document the gap matrix in
  `docs/live-mailbox-runtime.md`, mark the path experimental permanently,
  add a startup warning. Cost: ~0.5 day. Benefit: halves the maintenance
  surface. No convergence attempt — accept the paths as intentionally
  divergent (progress-persist divergence stays; only documentation work).
- **(b) Converge** (**NOT sound per Round 4**): extract a shared `TaskExecutor`
  contract; move the fallback attempt loop, `withWorkerSlot`, and progress
  persist into shared code. This requires either abandoning SDK delegation
  (massive behavior change) or building a parallel fallback/concurrency
  layer for live-session — a 3–5 day investment producing a worse design.

| Step | Action | Acceptance |
|---|---|---|
| 4.0 | ADR + human confirmation (high-risk lane per FEATURE_INTAKE) | `docs/decisions/2026-XX-XX-runtime-convergence.md` |
| 4.1 (if 4.0=b) | Extract `TaskExecutor` interface + shared fallback/worker-cap/progress code | Integration tests run against BOTH paths; feature-parity matrix doc; `npm test` green |

Rollback: ADR-scoped; convergence commits revert independently because the
interface lands before either adapter is migrated.

---

## Phase 5 — Schema-driven config sanitization (normal lane, ~1 day)

Closes the recurring security gap: `sanitizeProjectConfig` uses a hardcoded
drop-list; forgetting to add a new sensitive field = silent gap.

| Step | Action | File mapping | Acceptance |
|---|---|---|---|
| 5.1 | Add `sensitive: true` metadata convention to the config schema (TypeBox); derive the drop-list by walking the schema. **Round 4 verdict: SOUND (LOW)** — see `refactor-plan.review.md` §ROUND 4 P3. Cross-validated by 2 independent reviewers: **ALL currently-dropped fields exist in the schema (0 GAP)**, no security regression from schema-walk. **Implementation note (sweep 3)**: `config-schema.ts` (340 lines) imports `Type` from `@sinclair/typebox` (^0.34.50) but currently uses **no `TypeRegistry`/custom `Kind`** — to carry `sensitive: true` we must either register a custom Kind via `TypeRegistry.Set(...)` or attach it through the TypeBox `Options` object passed to `Type.Object({...}, { additionalProperties: true })`. TypeBox 0.34 supports both; pick one in the ADR. No blocker. **Round 4 additions**: (1) **`policy.requireIntentForDestructiveActions` + `policy.disabledCapabilities` MUST be marked `sensitive`** (S-R5 — latent gap: not in current drop-list, currently moot due to user-wins merge + `false` default, but defense-in-depth against future default flip). (2) **`runtime.requirePlanApproval` conditional-drop caveat**: currently dropped only when `=== false` (`config.ts:288-291`); a boolean `sensitive` flag can't express this — ADR must pick a predicate form (`sensitive: { when: ... }`), keep it as a hardcoded special-case, OR accept unconditional drop (slight behavior change). (3) Optional defense-in-depth: `worktree.seedPaths` (S-R6, mitigated by `normalizeSeedPaths` runtime validation). **⚠️ Round 19 premise update**: schema-walk drop-list PHẢI derive TỪ PARSER surface, không phải reverse — `schema ≠ parse ≠ read` (F19-1 modelFallback inert trong parser; F19-2/F19-3 maxTotalSpawns + control.* read-but-schema-forbidden). Walk schema KHÔNG đủ; walk phải đối chiếu parser + read-sites. | `src/schema/config-schema.ts` ✅ exists, `src/config/sanitize-project-config.ts` (from Phase 2.2) | All existing sanitize tests pass unchanged (17 files in `test/unit/config/` incl. `config-schema-sync`, `config-patch-pollution`, `config-phantom-fields`, `project-config`) |
| 5.2 | Add drift gate: **critical safety net (S-R7)** — test asserting (i) every `sensitive`-marked field is dropped from project config, (ii) every currently-dropped field is marked, AND (iii) the schema-derived drop-list is a **SUPERSET** of the current hardcoded drop-list (no field regresses), AND (iv) every `sensitive: true` maps to an existing schema key (no orphan metadata). Extend `config-schema-sync.test.ts` to verify `sensitive` metadata parity. | `test/unit/config/` (extend `config-schema-sync.test.ts`) | Test fails when a new sensitive field is added without marking, a marked field isn't dropped, OR the schema-walk would miss a currently-dropped field |

Phase gate: `npm run ci` green.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Race-condition fixes (H-1, ST-7/8/14, RT-15, Round 26 BUG n — all confirmed present ✅) lost during moves | Working rule 3: comments move verbatim; reviewer greps moved hunks for incident tags |
| Sync/async twin merge temptation | Hard constraint: see `docs/decisions/2026-08-10-reduce-sync-async-twins.md` |
| LAZY boundary breakage (40 files ✅) | `check:lazy-imports` in every phase gate; no new static imports of lazy modules |
| CAS convergence regression (10-attempt cap, `task-runner/state-helpers.ts:52` ✅) | Phase 2.5 moves code only; no retry-policy changes in this plan |
| Coalesced-write SIGKILL window (50 ms) | Out of scope (behavior change); documented as known limitation |
| UI multi-layer cache incoherence (`ManifestCache` lives in `src/runtime/manifest-cache.ts:46` TTL 500 ms ✅ sweep 3 — corrected from earlier "extension/registration" claim; `RunSnapshotCache` 1500 ms ✅; `buildSignature` per-class field, 100 ms TTL in `run-dashboard.ts`, invalidate-on-write (C4) in `widget/index.ts`) | Not addressed here; candidate for a follow-up plan |
| Windows EBUSY/EPERM paths | `test:platform` exists ✅; run it in phase gates touching `atomic-write.ts` / locks |
| Bundle staleness after big moves | `check:bundle-staleness` + rebuild before each phase gate |
| Stale comments mischaracterizing live behavior (found twice in sweep 2: `PI_CREW_PARENT_PID`, god-function size) | Treat comments as hypotheses; verify against code before acting on them |
| **Round 4 — lock family divergence** (staleMs 10s vs 30s; event-log = directory not file; agents-record missing token + `0o644` perms) | Phase 3.1 reframed: ADR must choose exclude-(c) (α) vs accept-format-change (β); 3.0 hardening commit first |
| **Round 4 — runtime convergence not sound** (live path has no fallback loop; `withWorkerSlot` semantically wrong for in-process) | Phase 4 reframed: recommend option (a) freeze; option (b) converge marked NOT sound |
| **Round 4 — latent `policy.*` sanitize gap** (S-R5) | Phase 5.1: mark `policy.{requireIntentForDestructiveActions,disabledCapabilities}` `sensitive` (defense-in-depth) |

## Execution log

| Date | Phase | Commit(s) | Gate results |
|---|---|---|---|
| 2026-08-13 | Plan created | — | `npm run typecheck` green |
| 2026-08-13 | Verification sweep 1 (locations, constants, tags) | — | 16/16 incident tags confirmed; 5 claims corrected (executeTeamRunCore :2339/321 lines, selectDispatchBatch :1363, sanitizeProjectConfig :272, CAS-loop location → `task-runner/state-helpers.ts`, Phase 4 fallback premise, gate-script reference) |
| 2026-08-13 | Verification sweep 2 (premise validation) | — | Phase 1.1 reframed (2 test consumers exist → relocate, not delete); Phase 1.2 reframed (var consumed by scratchpad guest-zombie, `scratchpad-lifecycle.ts:50,166` → fix comment, don't remove); Phase 1.4 reframed (all 3 maps already have cleanup → exception-path hardening only); Phase 2.6 extraction sources confirmed (:662-738, :1058, :1151, :1230, :1291, :1363, :1539, :1925, :2004, :2091, :2189, :2339); lock families confirmed (locks.ts :390/:523/:596/:631 + crew-agent-records.ts); env scope corrected (189 names / ≥59 read sites); `.gen` sidecar confirmed in event-log-rotation.ts:295; no new-file name conflicts |
| 2026-08-13 | Verification sweep 3 (large-file baselines, Phase 5 feasibility, UI caches, all 🔍 items) | — | **3 large files CONFIRMED exact** (`crew-broker.ts` 1280 socket+handshake+token+fanout; `worktree-manager.ts` 1268 creation+dirty C9+cleanup+seed overlay; `state-store.ts` 1260 CRUD+manifest-retry, CAS confirmed elsewhere). **6 corrections applied**: (1) `ManifestCache` location → `src/runtime/manifest-cache.ts:46` TTL 500ms, NOT extension/registration; (2) Phase 1.2 parent-guard IS wired at `background-runner.ts:615`, only the pi-binary child-pi entry point is unwired; (3) Phase 3.1 call sites — `atomic-write.ts` is NOT a lock consumer (uses O_EXCL atomic rename); real consumers are mailbox/blob-store/run-cache/config/decision-ledger; (4) event-log mkdir lock resolved → `event-log.ts:109` `.mkdirlock` dir, 5th lock family; (5) Phase 3.2 env forms resolved → only 2 bracket sites, 0 destructure, codemod much smaller than estimated; (6) Phase 5.1 — config-schema uses no TypeRegistry/Kind today, must introduce one for `sensitive` metadata (no blocker). Phase 4 progress-persist divergence reframed to executor layer; tool-filter + kill/abort divergences confirmed. `buildSignature` 100ms TTL confirmed at `run-dashboard.ts:117`. |
| 2026-08-14 | **Phase 3.0 — lock permission hardening** | `51fe928c` | crew-agent-records.ts:158 0o644→0o600 (S-R1) + sweep tìm thêm 2 sites cùng pattern: event-log-rotation.ts:426 (events file) + active-run-registry.ts:72 (pid registry). O_EXCL/"wx" → mode chỉ áp dụng file mới, no format change. Gates green. |
| 2026-08-14 | **Phase 3.3 — stale-snapshot RMW fixes (R13: 2 HIGH + 1 MEDIUM)** (team `team_20260814153431_483304b6591a4692`) | `dcdfca80` | handleRetry (R13-1 HIGH): fresh re-read in-lock, terminal short-circuit + writes từ fresh; R13-3 folded. handleCancel (R13-2 HIGH): fresh re-read, terminal check trên fresh. task-claims ×3 + heartbeat (R13-S1): fresh re-read + isTerminalTaskStatus guard (no resurrect). 6 regression tests. Gates: 101/101 + unit 6542 (0 fail). |
| 2026-08-14 | **Phase 3.4 — stale-snapshot class completion (R14: 1 HIGH + 2 MEDIUM)** (team `team_20260814163139_6d1401eb4a7a5a02`) | `3cac119d` | status.ts (R14-1 HIGH — site duy nhất write-on-read-path): transitionStaleAsyncUnderLock + ownership gate (foreign session poll không trigger; backward-compat non-empty-string), H5 guard verbatim. background-runner:898 (R14-2): write từ manifestToUse trong lock. crash-recovery apply/decline (R14-4 latent): lock + fresh + terminal skip. run.ts guard (R14-3) + crew-broker B1. 6 regression tests. Gates: 101/101 + unit 6548 (0 fail). Pre-existing flaky session-summary-cov vector #11 ghi nhận (pass standalone 100%). |
| 2026-08-14 | **Phase 3.5 — finalizeRun/mergeUnitResult terminal races (R15: 2 MEDIUM + S1 + R15-3)** (team `team_20260814173440_1e9f338e420b5172`) | `df20f4e2` | finalizeRun (R15-1): toàn bộ persistence vào 1 withRunLock re-read disk; disk-terminal/signal.aborted → preserve + run.terminal_preserved event; unlocked write :2303 REMOVED. mergeUnitResult (R15-2): chỉ force running từ non-terminal; loop break khi merge thấy disk-terminal. S1: in-lock ownership re-check (handleRetry; handleCancel đã cover bởi R13-2). R15-3: coalesced heartbeat group-scoped (no sibling un-cancel). **R15-4 declined with rationale** (sync retry starve async holder; bypass = H-1 double-writer). contracts.ts +run.terminal_preserved. 7 regression tests. Gates: 101/101 + unit 6557 (0 fail). Run hết 1h timeout lần đầu nhưng hoàn tất 6/6 khi wait lại. |
| 2026-08-14 | **Phase 1.9–1.11 — test gating + L1 cleanup + security hardening** (implementation teams `team_20260814062720_71774e173f95a33d` + `team_20260814064910_f5184bd4b4061b70` + `team_20260814070708_bea429efd6686165`) | `e59bb1a5`, `7600e94f`, `bde95e47` | **1.9 test-first gating**: 44 new tests (commands-handler 290L via `__test__setHandleTeamTool` seam; team-runner-extraction 527L covering selectDispatchBatch/mergeUnitResult/advanceWorkflowPhases/requiresPlanApproval/ensurePlanApprovalRequested; config-sanitize-merge 288L via `__test__sanitizeProjectConfig`/`__test__mergeConfig` — sensitive drop-list + precedence matrix). **1.10 L1 cleanup**: 23 console→logInternalError sites, 4 guardrails (explicit severity, preStepScript body REDACTED — P1, error object preserved pi-spawn, redact-at-callsite); remaining console.* = skipped list only. **1.11 security**: R11-1 runRipgrep 30s timeout + SIGKILL + 10MB stdout cap (+ 2 fast regression tests); R11-2 assertSafePathId at 2 background-runner argv boundaries; R11-3 skip-with-reason (already reuses validated manifest.runId); R11-4 AbortSignal threaded into perf sampler/analyze spawns. ⚠️ 2 worker crashes (executor/verifier unresponsive) — leader verified + gated directly; 1 pre-existing flaky (session-summary-cov vector #11, passes standalone). **Gate**: `npm run ci` green (unit 6536, integration 192, bundle 2.81 MB). |
| 2026-08-14 | **Phase 1.1–1.8 — dead code sweep** (implementation team `team_20260814050325_65adff36980ce445`) | `51f46915` | **110 files changed, -17,547 lines**. 1.1 conflict-detect → `test/helpers/` (R100, 2 test consumers). 1.2 child-pi-spawn.ts:74 comment corrected (PARENT_PID consumed by zombie-scanner:185 + background-runner:615 + scratchpad-lifecycle:50/166). 1.3 steer stubs = option (b) PLANNED-NOT-IMPLEMENTED (SubagentRecord lacks taskId). 1.4 RT-7b-exc exception-path regression test (finally runs on throw). 1.5 R7 dead fns/modules removed (blob-store, intercom-bridge, process-lifecycle, intermediate-store, hook-integrations + clearHooks→clearHooksScoped, 12 dead fns). 1.6 retry-runner decision (a): scope = retry-executor.ts (wired); decision doc. 1.7 R8 45-module sweep (safe-bash×2 HIGH removed + 5 test files, pipeline-runner, schedule.ts, instinct chain, jsonl-writer, compaction-summary, crew-errors + 30 LOW); **parallel-utils.ts KEPT (LIVE)**. 1.8 test relocation/removal per §ROUND 9. Leader restored lost doc-comment in hooks/registry.ts. **Gates**: typecheck clean; test:critical 101/101; unit 6486 (0 fail); integration 192 (0 fail); `npm run ci` green (bundle 2.81 MB). |
| 2026-08-13 | **Phase 0 — baseline + branch** | `755d3fc9` | **Baseline NOT green at first**: `check:decision-drift` failed pre-existing (scratchpad-snapshot-hmac ADR SUPERSEDED/REVERTED vẫn reference PI_CREW_SIG/HMAC_KEY/HMAC_STRICT, helper đã delete). Fix: script skip superseded/reverted status. **Baseline AFTER fix**: unit 7156 (7153 pass, 0 fail), integration 192 (188 pass), bundle 2.80 MB, typecheck+lint+format+all gates green. Branch `refactor/maintainability` created from clean main. |
| 2026-08-13 | **Round 4 — soundness + security validation** (iterative-audit, team `review`, run `team_20260813053349_f46ef69f08925ef6`) | — | **3 high-risk premises verdict**: P1 unified FileLock = **RISKY (HIGH)**; P2 TaskExecutor convergence = **RISKY (HIGH)**; P3 schema-driven sanitize = **SOUND (LOW)**. 12 real issues (2 HIGH, 4 MEDIUM, 6 LOW), 0 CRITICAL/BLOCKED, 0 false positive (verifier cross-checked 7/7). Gate: `test:critical` 101/101 + `tsc` clean. **Remediations applied to plan**: Phase 3.0 added (0o644→0o600 hardening); Phase 3.1 reframed (ADR choose exclude-event-log (α) vs format-change (β), document 4 divergences); Phase 4 reframed (recommend option (a) freeze, option (b) marked NOT sound); Phase 5.1 added `policy.*` sensitive + `requirePlanApproval` conditional caveat; Phase 5.2 strengthened to superset-parity migration test. Findings in `refactor-plan.review.md` §ROUND 4. |
| 2026-08-13 | **Round 5 — Defensive Caps (Pattern 2)** (iterative-audit, team `review`, run `team_20260813060554_29fbbadf74cd1f50`) | — | **9 real issues** (2 MEDIUM, 7 LOW), 0 CRITICAL/HIGH, 50+ FP eliminated. Codebase well-defended (~40 capped collections). MEDIUM-1 `manifestCacheGeneration` (state-store.ts:89, **plan-target**) never evicted; MEDIUM-2 `seenFinishedRunIds` (async-notifier.ts:13) never cleared. Reviewer bổ sung 2 missed warn-once Sets (i18n.ts warnedMissing, doctor.ts commandExistsCache) + severity calibration (MEDIUM-1 could be HIGH per guide). Security reviewer confirmed 7/7 + 15+ extra FP. All subagents model `zai/glm-5.2`. Findings §ROUND 5 review file. |
| 2026-08-13 | **Round 6 — Resource Cleanup (Pattern 7)** (iterative-audit, team `review`, run `team_20260813060555_d55bd3874b41a35f`) | — | **3 real findings** (2 LOW + 1 LOW defense-in-depth) + 1 INFO dead-code, 0 CRITICAL/HIGH, 30+ FP eliminated. F1 `cancelHardKill` timer (child-pi.ts:724, **plan-target**) không trong `clearChildPiTimeouts()` — Phase 2.3 split PHẢI bao gồm; F2 anonymous `{once:true}` abort listeners không remove (team-runner.ts:2426, run-deadline.ts:58 — inconsistency với W2/RC-03 pattern); F3 GroupJoinManager dead code (group-join.ts:201 no unref). **⚠️ Reviewer (02) bị cut sớm (152B)** — tổng hợp từ explorer + security-reviewer (độc lập, đầy đủ). crew-vibes session_shutdown handler correction. Findings §ROUND 6 review file. |
| 2026-08-13 | **Round 7 — Dead cleanup functions (Pattern 6)** (iterative-audit, team `review`, run `team_20260813064357_6f077d344970aa60`, model `deepseek/deepseek-v4-flash`) | — | **14 REAL dead functions** (1 HIGH-adj, 7 MEDIUM, 6 LOW) + 6 dead modules + ~25 FP eliminated. Highlights: **R7-1 `blob-store.ts` = dead module** (0 src importers; doc :212 false-promises periodic `cleanupOrphanedBlobs`) → **§3.1 lock-consumer list CORRECTED (blob-store removed)**; **R7-4 `retry-runner.ts` = dead module nhưng plan Phase 2 §5.3 targets nó** → PHẢI account (wired primitive = `retry-executor.ts`); R7-12 `process-lifecycle.ts` dead module; R7-13 security telemetry written never surfaced. Reviewer bổ sung `clearHooks` (registry.ts:26) + blob-store fully-dead upgrade + checkpoint partially-wired refinement. Verifier: `test:critical` 101/101 + tsc clean. Findings §ROUND 7 review file. |
| 2026-08-13 | **Round 8 — Dead modules / zero-importers (Pattern 6)** (iterative-audit, team `review`, run `team_20260813074053_a6f113343ed83024`, model `deepseek/deepseek-v4-flash`) | — | **45 REAL dead modules** (1 HIGH-adj security, 6 MEDIUM, 30 LOW, 8 INFO) + 6 FP eliminated. **R8-1 `safe-bash.ts`+`safe-bash-extension.ts` = false security promise (HIGH)** — `PI_CREW_SAFE_BASH`/`safeMode` documented nhưng 0 reads trong src/, no config field, no registration; ships trong npm tarball (package.json `files` includes src/) → **ESCALATE: remove hoặc wire**. R8-4 schedule.ts duplicate của live scheduler.ts; R8-5 instinct chain transitive-dead (3 modules); R8-12 crew-errors.ts duplicate errors.ts; R8-2 pipeline-runner dead (plan Phase 2.6-adjacent). **Reviewer corrections**: parallel-utils.ts LIVE (dynamic-workflow-context.ts:41,515,531 — remove khỏi dead list); safe-bash 5 test files import safe-bash.ts (strengthening). Security reviewer: live security controls SOUND. Verifier: 101/101 + tsc clean. Findings §ROUND 8 review file. |
| 2026-08-13 | **Round 9 — Test Coverage Gaps (Pattern 3)** (iterative-audit, team `review`, run `team_20260813082137_86526cad492253c6`, model `deepseek/deepseek-v4-flash`) | — | **14 coverage gaps** (0 HIGH, 5 MEDIUM, 9 LOW) + ~10 FP eliminated. **Regression net MẠNH 6/8 plan-targets** (state-store 127, event-log 47, child-pi 24, config 19, team-runner 14, broker 5, worktree 7). **2 plan-critical MEDIUM**: `commands.ts` handler layer (1 test name-only — Phase 2.1 blind-move); team-runner extraction targets `selectDispatchBatch`/`mergeUnitResult`/`advanceWorkflowPhases` 0 direct tests (Phase 2.6). T-3 config.ts private sanitize/merge (Phase 2.2 needs `__test__` exports). Security-critical ALL GREEN (0 HIGH). **13-file dead-module test relocation map** (safe-bash 5 tests phải delete). Reviewer: 2 precision corrections (l4-test import, count 66). Verifier: 101/101 + tsc clean. **Applied**: Phase 1.8 (test relocation map) + 1.9 (test-first gating). Findings §ROUND 9 review file. |
| 2026-08-13 | **Round 10 — Performance (Pattern 5, FINAL round)** (iterative-audit, team `review`, run `team_20260813090657_1ee34ead6d11c0db`, model `deepseek/deepseek-v4-flash`) | — | **9 perf issues** (1 HIGH, 4 MEDIUM, 4 LOW) + ~14 FP eliminated. **R10-1 HIGH**: team-runner batch-closeout O(B²) artifact re-reads (aggregateTaskOutputs ×2-3 + N+1 agent writes + 2 fsync/batch) → **Phase 2.6 MUST account**. R10-4 sync/async tasks.json parity inconsistency; R10-5 child-executor per-event fs-op fanout (~8-10 syscalls/event). Verified known-perf WORKING (OPT-01/OPT-PHASE2/F4/3 UI caches). **⚠️ 01_explore steer dừng sớm 1h35m** (over-analysis Pattern 5) — findings đủ. Verifier: 101/101 + tsc clean. **LOOP TOTAL rounds 4-10: 106 issues, 5 HIGH-adj, 28 MEDIUM, ~135 FP eliminated**. Verdict STOP. Findings §ROUND 10 review file. |
| 2026-08-13 | **Round 11 — Security Hardening (Pattern 4)** (iterative-audit, team `review`, run `team_20260813110104_c801f85c08b64083`, model `deepseek/deepseek-v4-flash`) | — | **4 findings** (1 MEDIUM, 3 LOW), 0 CRITICAL/HIGH, ~10 FP eliminated. Codebase hardened mạnh (no shell:true, no eval, all id-paths validated, F-01/F-02 RCE gates, S-6 guard). R11-1 MEDIUM: retrieval-orchestrator rg spawn no timeout/stdout cap (OOM risk huge repo); R11-2 LOW: background-runner argv runId not assertSafePathId (boundary duy nhất untagged). Guardrail OK (16 tool calls). Verifier: 101/101 + tsc clean. Findings §ROUND 11 review file. |
| 2026-08-13 | **Round 12 — L1 Cleanup (Pattern 1)** (iterative-audit, team `review`, run `team_20260813110104_c323a084cb27c076`, model `deepseek/deepseek-v4-flash`) | — | **23 callsites console→logInternalError** (21 strong + 2 borderline, 44 skipped có lý do). **⚠️ NEW secret-exposure P1: `discover-workflows.ts:159` logs full untrusted `preStepScript` body unredacted stderr**. **Insecure-default trap (P1)**: logInternalError default `"debug"` gated PI_TEAMS_DEBUG — conversions PHẢI pass explicit severity. Security re-rank: pi-spawn.ts:243 (silent binary-pin fallback), discover-workflows:158, state-store:946/1108/1245, stale-reconciler:549/556/620. 6 files cần import mới. Verifier: 101/101 + tsc clean. Findings §ROUND 12 review file. |
| 2026-08-13 | **Round 13 — Concurrency & Race conditions** (iterative-audit, team `review`, run `team_20260813111931_12218f1f5ee98e78`, model `deepseek/deepseek-v4-flash`) | — | **🔴 Round giá trị cao nhất: 4 race findings (2 HIGH + 1 MEDIUM + 1 MEDIUM-LOW)**. **R13-1 HIGH**: `cancel.ts:122-189` handleRetry stale-snapshot RMW — `await executeHook("before_retry")` (:136) mở async gap UNBOUNDED → `saveRunTasks` full-array overwrite từ stale `loaded.tasks` → **completed state bị clobber, terminal evidence destroyed, double-execution risk**. **R13-2 HIGH**: handleCancel stale manifest write flip terminal status về "cancelled". **R13-S1 MEDIUM**: task-claims.ts ×3 + heartbeat.ts cùng class (window ms-scale nhưng lock-contention mở rộng). **Merge gate KHÔNG bảo vệ tool handlers** (bypass). Fix template đã có: `respond.ts:43` fresh re-read INSIDE lock. 8 FP eliminated (lock twins, event-seq, merge-gate clean cho runner path). Verifier: 101/101 + tsc clean. **→ Phase 3.3 work item added**. Findings §ROUND 13 review file. |
| 2026-08-13 | **Round 14 — Stale-snapshot class completion** (iterative-audit, team `review`, run `team_20260813121744_e5d7aa0a9fec428b`, model `deepseek/deepseek-v4-flash`) | — | **4 findings (1 HIGH, 2 MEDIUM, 1 LOW)** + 12 sites swept-clean + Part B closed (B1 MINOR, B2/B3 FALSE). **R14-1 HIGH**: `status.ts:50,67,78` write-on-read-path NO lock NO fresh-read — updateRunStatus validate theo stale status (concurrent completed/cancelled bị re-flip failed); security: KHÔNG ownership gate (foreign run poll có thể trigger). **R14-2 MEDIUM**: background-runner.ts:898 fresh read discarded (manifestToUse chỉ cho terminate), write dùng outer stale NGOÀI lock. **R14-4 MEDIUM latent** (reviewer NEW): crash-recovery.ts:137-190 applyRecoveryPlan await hook rồi save stale (dashboard path chưa wire). **R14-3 LOW**: run.ts:104. Verifier: 101/101 + tsc clean. **→ Phase 3.4 added**. Findings §ROUND 14 review file. |
| 2026-08-13 | **Round 15 — Write-on-read completion + scheduler/locks depth** (iterative-audit, team `review`, run `team_20260813131832_ace4037438349699`, model `deepseek/deepseek-v4-flash`) | — | **4 findings (2 MEDIUM, 2 LOW)** + 13 sites swept-clean. **R15-1 MEDIUM (borders HIGH)**: finalizeRun clobber concurrent external terminal write — status từ in-memory, save :2312 withRunLock nhưng không re-read disk; reviewer AMPLIFICATION: `saveRunManifestAsync` :2309 là **second UNLOCKED write** phải move cùng lock; cancel intent bị revert vĩnh viễn (cancelled→completed). **R15-2 MEDIUM latent**: mergeUnitResult force-running (:1982) erase disk-terminal — cancelled/failed/completed→running đều legal (contracts.ts:25-35) → run dispatch tiếp sau cancel (authorization-lifetime gap), enables R15-1. **R15-3 LOW**: coalesced-group heartbeat full stale array. **R15-4 LOW**: withRunLockSync throws "locked" vs in-process loop (benign side-effect prevent R13 clobber). Scheduler loop CLEAN (single async context, CANCEL-1, RT-15). Verifier: 101/101 + tsc clean. **→ Phase 3.5 added**. Findings §ROUND 15 review file. |
| 2026-08-13 | **Round 16 — Pre-lock snapshot counter-party + event-log/mailbox contention** (iterative-audit, team `review`, run `team_20260813143244_3513453d27fd46dd`, model `deepseek/deepseek-v4-flash`) | — | **1 finding (1 MEDIUM borders HIGH) + 15 swept-clean + 2 FP**. Part A ZERO new findings (mọi tool handler pre-lock snapshot covered bởi R13-15; retry.ts không tồn tại). **R16-B1**: event-log `.mkdirlock` (sync :109) vs `.alock` (async :516) **dual lock-namespace trên cùng eventsPath** → duplicate seq (reserveSequenceUnderLock :412 trust sidecar no mutual exclusion → readEventsCursor drops event 2) + rotation stranding (sync append fd trên renamed inode → event trong archive invisible). Reviewer: **14 parent-side sync appendEvent sites** contradict "extremely unlikely" mitigation. Security: status.ts unlocked writes amplifier — R16-B1 window mở mỗi status poll. Fix: common .seqlock (mailbox ST-3 pattern), KHÔNG naive merge (v0.9.26 deadlock). Verifier: 101/101 + tsc clean. **→ Phase 3.6 added**. Findings §ROUND 16 review file. |
| 2026-08-13 | **Round 17 — Empirical R16-B1 + error-path robustness** (iterative-audit, team `review`, run `team_20260813150753_491b94e118d2be7a`, model `deepseek/deepseek-v4-flash`) | — | **🔴 R16-B1 CONFIRMED EMPIRICALLY**: stress test 3000 events → **527 duplicate seq, 2260 duplicate events (75%)**; natural rate 75% — comment "extremely unlikely" (event-log.ts:487-490) REFUTED. Cross-process exposure verified (team-runner sync .mkdirlock vs team-tool async .alock + child-executor:547 worker threading). **Part B: 1 HIGH + 3 LOW + 1 benign + 1 retracted FP + 1 NEW**. R17-B1 HIGH: crew-agent-records.ts:140-146 catch nuốt lỗi → root cause invisible (60s "locked" generic). R17-B2 RETRACTED (FP — buffer cap-drop đã reject promises, H3 fix chính là branch). R17-S1 NEW (security): size-limit skip silent success. 91 finally blocks 0 throw-in-finally; 25 void async all caught. Verifier: 101/101 + tsc clean. **→ Phase 3.7 added (R16-B1 = P0/P1 + regression bench)**. Findings §ROUND 17 review file. |
| 2026-08-13 | **Round 18 — Rotation-stranding empirical + size-limit sweep + fix-conflict** (iterative-audit, team `review`, run `team_20260813163017_ae09310712cec61e`, model `deepseek/deepseek-v4-flash`) | — | **(a) Rotation stranding CONFIRMED empirically**: 18,478/340,562 (5.43% max-contention) stranded vào archive; readers/reconstructor KHÔNG đọc archives + sweepOldArchives unlink 7 ngày → gone forever (mailbox contrast: reads archives). **(b) R17-S1 ESCALATED HIGH**: size-limit skip `return fullEvent` as-if-persisted, drop log debug-gated → FULLY SILENT; security: rotation-failure chain silent (callers ignore rotate boolean) → cover cả chain + gate emitFromTeamEvent. **(c) Fix-scope gap MEDIUM**: .seqlock chỉ fix duplicate-seq không fix stranding → Phase 3.6 acceptance không met. Lock ordering L1→L2→L3 consistent no deadlock. Reviewer addenda 3 LOW (emit-on-skipped, reject-path caution sync, stale archive-replay comment). Race-track re-scan CLEAN. Verifier: 101/101 + tsc clean. **→ Phase 3.8 added**. Findings §ROUND 18 review file. |
| 2026-08-13 | **Round 19 — Config surface + resource definitions** (iterative-audit, team `review`, run `team_20260814032511_c365f408259a2c79`, model `deepseek/deepseek-v4-flash`) | — | **10 findings (5 MEDIUM, 5 LOW)** + 6 drift items + 6 FP. **F19-1 MEDIUM**: `runtime.modelFallback.*` inert — parser không emit, documented config KHÔNG hoạt động (security S19-3: requireCredentials:true silent unconstrained routing). **F19-4 MEDIUM (S19-1)**: project config set được guards ACTIVE-by-default (completionMutationGuard/effectivenessGuard "off", scopeModels/autoRecover false, limits ≤1024) → silent guardrail loss mọi clone — KHÁC policy.* latent. **S19-2 MEDIUM (correction)**: goalWrap.verification.commands KHÔNG arbitrary shell (allowlisted) — new surface = silent auto-wrap + unbounded spend. **F19-2/3 MEDIUM**: maxTotalSpawns + control.* read-but-schema-forbidden → Phase 5 walk gap. **S19-5 LOW**: magicKeywords partial-config default-flip autonomous ON. Part B CLEAN (6 teams/10 workflows/11 agents refs resolve, SEC-001 holds). **Phase 5 premise update**: schema-walk phải derive từ PARSER surface (schema ≠ parse ≠ read). Verifier: 101/101 + tsc clean. Findings §ROUND 19 review file. |
