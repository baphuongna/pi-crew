# pi-crew Improvement Plan — 2026-08-10

> Companion to `docs/improvement-plan-2026-08-09.md`. This batch contains NEW
> findings from a 4-axis parallel audit (performance, quality, test infra,
> contract consistency) performed 2026-08-10 against HEAD `919d7a92` (v0.9.65).
> Items below were verified to NOT overlap with the 2026-08-09 plan (A.1–A.6,
> B.1–B.2, C.1, D.1–D.4, E.1–E.4, F.1–F.3) before being added.
>
> This is a planning artifact, not an accepted spec — see `AGENTS.md`
> source-of-truth order. Status legend matches the 2026-08-09 plan.

## Verification status legend

| Marker | Meaning |
|---|---|
| ✅ VERIFIED | Directly checked (typecheck / grep / read) on 2026-08-10 |
| 🔍 EXPLORE | From a parallel explore subagent; not yet independently verified |
| ⚠️ PARTIAL | Verified with nuance |
| ❌ UNVERIFIED | Claimed but no evidence |

## How this plan is organised

Each item carries a **lane** (tiny / normal / high-risk) per
`docs/FEATURE_INTAKE.md` and an explicit risk classification. Tier 1 items are
executed in this session; Tier 2/3 are ADR candidates presented at the end.

---

## Tier 1 — Executed in this session

All items below are tiny or normal lane with low–medium risk and were
implemented with per-item verification. See the changelog at the bottom for the
exact sequence.

### G1 — `test:changed` references a missing script (BUG) — TINY

- **Status:** ✅ VERIFIED (bug)
- **Files:** `package.json:97`, `scripts/test-changed.mjs` (missing)
- **Evidence (2026-08-10):** `ls scripts/test-changed*` → not found. `npm run
  test:changed` would fail with `Cannot find module`. The 2026-08-09 plan
  flags "verification overhead" as a concern; this missing script is the
  single biggest contributor — contributors have no fast-feedback path.
- **Impact:** High (workflow). Low (runtime).
- **Lane:** tiny (new script, narrow behaviour).
- **Fix:** Create `scripts/test-changed.mjs` that resolves changed test files
  via `git diff` against the merge-base and shells out to the existing
  `test-runner.mjs` wrapper. Falls back to `test:critical` glob if no changes
  are detected.

### G2 — `test:watch` and `test:new` silently match 0 tests in subdirectories (BUG) — TINY

- **Status:** ✅ VERIFIED
- **Files:** `package.json:82,96`
- **Evidence (2026-08-10):** Both scripts invoke `tsx --test 'test/unit/**/*.test.ts'`
  directly. Node v22's `--test` does NOT expand `**` (verified empirically);
  `scripts/test-runner.mjs:33-37` exists specifically to compensate. So
  `test:watch` after editing a file in `test/unit/state/event-log/` reports
  `tests 0` and the developer believes the change is green.
- **Impact:** High (silent test signal loss for every nested dir: state/,
  runtime/, ui/, security/, workflows/, etc.).
- **Lane:** tiny.
- **Fix:** Route both scripts through `scripts/test-runner.mjs`.

### G3 — Scratchpad pure tests not in `npm test` — TINY

- **Status:** ✅ VERIFIED
- **Files:** `test/runtime/scratchpad/{protocol,transform}.test.ts`
- **Evidence (2026-08-10):** Both are pure (no-subprocess) tests of the
  `__rlm` envelope nonce-authentication and cell-transform logic. The
  protocol test header literally says: *"Authentication is load-bearing: a
  wrong (or missing) nonce must decode to null so forged or foreign traffic is
  dropped, never parsed."* They are only matched by `test:spike` (opt-in),
  which is absent from `npm test` and CI.
- **Impact:** High (security-envelope coverage gap).
- **Lane:** tiny.
- **Fix:** Move both files to `test/unit/runtime/scratchpad/` so the
  `test/unit/**/*.test.ts` glob picks them up.

### G4 — `test/platform/` and `test/functional/` orphaned from CI — TINY

- **Status:** ✅ VERIFIED
- **Files:** `test/platform/{posix-tools,windows-rename}.test.ts`,
  `test/functional/pi-crew-functional.test.ts`
- **Evidence (2026-08-10):** `rg "test/functional|test/platform"` in
  `package.json`, `scripts/`, `.github/` → no matches outside `node_modules`.
  The platform tests exist specifically to prevent the HB-002 BSD-vs-GNU grep
  + Windows `EBUSY` incidents from recurring; CI never runs them.
- **Impact:** High (regression of named incidents is invisible).
- **Lane:** tiny.
- **Fix:** Add `test:platform` script and a `test:functional` glob covering
  the mock-LLM functional test. Live-LLM tests stay opt-in via `test/manual/`
  convention (already used elsewhere).

### G5 — README documents 3 dead env vars — TINY

- **Status:** ✅ VERIFIED
- **Files:** `README.md` (env var table)
- **Evidence (2026-08-10):**
  - `PI_CREW_BROKER_DIAG_UI` — 0 hits in `src/` (removed in `e3ee6fe2`)
  - `PI_CREW_USE_BUNDLE` — only in `index.ts` (entrypoint), 0 hits in `src/`
  - `PI_CREW_QUIET_PREFLIGHT` — 0 hits in `src/`
  Users set these and get silently no-op behaviour.
- **Impact:** Medium.
- **Lane:** tiny.
- **Fix:** Remove the three README rows + add a CI lint
  (`scripts/check-readme-env-vars.mjs`) mirroring
  `check-decision-drift.mjs` so the drift cannot recur.

### G6 — Action count drift in docs — TINY

- **Status:** ✅ VERIFIED
- **Files:** `CLAUDE.md:34` ("28 actions"), `README.md:828` ("40+ actions"),
  `src/schema/team-tool-schema.ts:381` (comment: `9+16+7+16+6 = 54 actions`)
- **Evidence (2026-08-10):** The schema defines exactly 54 enum actions
  across 5 domain dispatchers (`RUN_ACTIONS=9`, `STATUS_ACTIONS=16`,
  `CONTROL_ACTIONS=7`, `MANAGE_ACTIONS=16`, `AUTOMATE_ACTIONS=6`).
- **Impact:** Medium (misleads integrators and skill authors).
- **Lane:** tiny.
- **Fix:** Update CLAUDE.md and README to "54 schema actions" + add a sync
  lint asserting `docs/actions-reference.md` row count matches the schema
  sum.

### G7 — `src/types/new-api-types.ts` is a dead file with stale version — TINY

- **Status:** ✅ VERIFIED
- **Files:** `src/types/new-api-types.ts`
- **Evidence (2026-08-10):** `rg "new-api-types"` across `src/`, `test/`,
  `scripts/` → 0 importers. File header says "Type imports from pi v0.77.0"
  but installed `@earendil-works/pi-coding-agent` is 0.83.0. File is not in
  `package.json` `exports`.
- **Impact:** Low.
- **Lane:** tiny.
- **Fix:** Delete the file.

### G8 — `dwf.d.ts:27` stale path comment — TINY

- **Status:** ✅ VERIFIED
- **Files:** `types/dwf.d.ts:27`
- **Evidence (2026-08-10):** Comment references
  `src/runtime/dynamic-workflow-context.ts` which no longer exists; the file
  moved to `src/runtime/goal-workflow/dynamic-workflow-context.ts` (152 refs).
- **Impact:** Low-med (public-facing type doc).
- **Lane:** tiny.
- **Fix:** Update the comment.

### G9 — `globMatch` test inlines a stale copy — TINY

- **Status:** ✅ VERIFIED
- **Files:** `src/extension/team-tool/api.ts:50`, `test/unit/glob-match-redos.test.ts:7-13`
- **Evidence (2026-08-10):** The test header says *"The globMatch function is
  inlined here because importing api.ts pulls in heavy dependencies…
  This copy must be kept in sync with src/extension/team-tool/api.ts."*
  This is a security-critical ReDoS guard whose test does not exercise the
  shipped function.
- **Impact:** Medium (silent security regression risk).
- **Lane:** tiny.
- **Fix:** Extract `globMatch` to `src/utils/glob-match.ts` (zero heavy
  imports); the test imports the real function. `api.ts` re-imports.

### G10 — Dead/test-only exports in core modules — TINY

- **Status:** ✅ VERIFIED
- **Files & evidence (2026-08-10):**
  - `checkSequenceGaps` (`event-log.ts:431`) — **0 callers** anywhere (src + test)
  - `BUILT_AGAINST_PI_VERSION` (`pi-api.ts:56`) — 0 production callers, 1 test
    asserts only that it is a non-empty string; deprecated header promises
    removal.
  - `parseSupervisorContactFromLine` (`supervisor-contact.ts:70`) — 0
    production callers (production uses `supervisorContactFromEvent`); 2 test
    files still exercise the deprecated wrapper.
- **Impact:** Low-med (pollutes public surface; misleads readers).
- **Lane:** tiny.
- **Fix:** Delete `checkSequenceGaps`. Delete `BUILT_AGAINST_PI_VERSION` +
  its trivial test. Delete `parseSupervisorContactFromLine`; migrate
  `supervisor-contact-edge.test.ts` to call `supervisorContactFromEvent`
  directly (the shared validator).

### G11 — Event-type registry drift — 132 silent event types — TINY (CI lint), HIGH-RISK (type flip)

- **Status:** ✅ VERIFIED
- **Files:** `src/state/contracts.ts:34` (`TEAM_EVENT_TYPES`, 65 entries),
  `src/state/event-log/event-log.ts:56` (`TeamEvent.type: string`)
- **Evidence (2026-08-10):** `TeamEvent.type` is typed `string`, not the
  exported `TeamEventType` union. Comparing emitted vs registered literals:
  ~132 unique `type:` strings appear in `appendEvent` calls but are NOT in
  `TEAM_EVENT_TYPES`. Concrete example: `task.attention` is written at
  `attention-events.ts:22` and read back with a strict `===` comparison at
  `:17`; a typo would silently break the dedupe filter and SIEM export.
- **Impact:** High (correctness-masking; same shape as the v0.9.65
  `budgetTotal` empty-string bug).
- **Lane:** tiny for CI lint (this session). High-risk for the actual type
  flip → deferred to Tier 3 with phased ADR.
- **Fix (this session):** Add `scripts/check-event-types-registry.mjs` that
  scans `appendEvent*` call sites and fails if any `type:` literal is not in
  `TEAM_EVENT_TYPES`. Wire into `npm run ci`. Phase 1 = report only
  (warn); Phase 2 (after migrating the 132 strings) = enforce.

### G12 — `gitignore-manager.ts` ignores `.pi/teams/` legacy layout — NORMAL

- **Status:** ✅ VERIFIED
- **Files:** `src/state/gitignore-manager.ts:13-21`, `src/workflows/intermediate-store.ts:36`
- **Evidence (2026-08-10):** `CREW_GITIGNORE_ENTRIES` only writes `/.crew/`
  entries. `projectCrewRoot` (in `utils/paths.ts`) falls back to `.pi/teams/`
  on projects that already have a `.pi/` dir. On such projects, run state,
  artifacts, and the hardcoded `.crew/intermediate` from `intermediate-store.ts`
  leak into git. None of the existing tests cover the legacy layout (all use
  `.crew/`).
- **Impact:** Medium (silent state-directory leak; secrets/logs in git).
- **Lane:** normal (state path; needs tests).
- **Risk flags:** state mutation, backward compat.
- **Fix:** Branch in `updateGitignore` based on which root resolves; make
  `intermediate-store.ts` resolve via `projectCrewRoot`. Add
  `gitignore-manager-pi-teams.test.ts` covering the legacy layout.

### G13 — Two `test.skip` without bug tickets — TINY

- **Status:** ✅ VERIFIED
- **Files:** `test/integration/phase8-smoke.test.ts:160` (ackAll overlay),
  `test/unit/runtime/core/lazy-agent-materialization.test.ts:17`
- **Evidence (2026-08-10):** Both have detailed inline comments describing
  the failure mode but neither links to a bug file. The plan's D.1
  specifically calls out the risk of "someone un-skipping and getting
  burned" for bug-023; same risk applies.
- **Impact:** Low-med (documented-but-lost bugs).
- **Lane:** tiny.
- **Fix:** File `docs/bugs/bug-024-phase8-ackall-overlay-pending-async.md`
  and `docs/bugs/bug-025-lazy-agent-materialization-untestable.md` matching
  the bug-023 convention, linked from the skip comments.

---

## Tier 2 — ADR candidates (not executed this session)

Each item below touches load-bearing invariants, large files, or the
durable-first contract. They need a phased ADR + story packet before any
source change. Listed here so the inventory is stable; the 2026-08-09 plan's
"load-bearing strengths" section applies.

### H1 — `appendEvent` deprecated but 51 production callers (perf + safety)

- **Files:** `src/state/event-log/event-log.ts:96,448` (`@deprecated`), 51 callers across `src/`
- **Concrete hotspot:** `src/extension/team-tool/api.ts` has 11 sync calls
  for informational events (`agent.nudged`, `agent.control.queued`, …).
  `status.ts:56,95` calls sync `appendEvent` inside a mailbox loop → up to
  70ms event-loop block per status query.
- **Recommendation:** Add `appendEvent`/`appendEventFireAndForget` to the
  twin list in `docs/decisions/2026-08-10-reduce-sync-async-twins.md` and
  execute a per-pair migration. Tier 1 first: convert the ~12
  informational-event callers in `team-tool/*` to `appendEventFireAndForget`
  (these are NOT terminal/crash-critical and the file's own deprecation
  note explicitly recommends the async path for them).
- **Lane:** high-risk (state mutation + concurrency).

### H2 — `saveCrewAgents` N+1 fsync amplification

- **Files:** `src/runtime/crew-agent-records.ts:295-306,385-389`
- **Evidence:** Each call = 1 fsync for `agents.json` + N fsyncs for
  per-task `status.json`. A 50-task team pays ~750ms blocking fsync per
  `saveCrewAgents` call; called ≥10× per run in `team-runner.ts`.
- **Recommendation:** Per-task `status.json` should use `durability:
  "best-effort"` (terminal state is already in `events.jsonl`).
- **Lane:** high-risk (crash-recovery contract).

### H3 — `handleApi` 1222-line god function + `runChildPi` 840-line + `handleRun` 713-line

- **Files:** `src/extension/team-tool/api.ts`, `src/runtime/child-pi/child-pi.ts`, `src/extension/team-tool/run.ts`
- **Recommendation:** Phased extraction mirroring phase-5's `merge-gate.ts`
  pattern. `handleApi` is the cleanest first cut (35 `if (operation === …)`
  branches → `api/<operation>.ts` files). Concrete extraction target for
  `dispatchBatch` (Tier 2 of the 2026-08-09 plan, deferred): the `dispatchUnit`
  closure at `team-runner.ts:1610-1837` is self-contained.
- **Lane:** normal per file; phased over multiple sessions.

### H4 — `api` action operations have no schema enum (silent fallthrough)

- **Files:** `src/extension/team-tool/api.ts:102`, `src/schema/team-tool-schema.ts`
- **Evidence:** `cfg.operation: string` accepts any value; unknown ops
  silently fall back to `read-manifest`. Same shape as the v0.9.65
  `budgetTotal` bug. A typo like `"claim_task"` silently runs `read-manifest`.
- **Recommendation:** Phased: warn-on-unknown first, then add `Type.Union`
  enum and reject.
- **Lane:** normal (API contract change).

### H5 — Sync I/O in `handleStatus` read path + `MAX_CAS_ATTEMPTS=100` busy-loop + `mailboxFrom` sync fan-out

- **Files:** `src/extension/team-tool/status.ts:55,56,95` (write side-effect
  in a read handler), `src/runtime/task-runner/state-helpers.ts:44`
  (100-retry CAS), `src/ui/run-snapshot-cache.ts:593-623` (sync readdir fan-out
  on render path — async twin exists at `:625-659` but render uses sync)
- **Recommendation:** Move side-effects out of read paths; lower CAS to ~5
  with explicit error on exhaustion; route render path through the async
  twin.
- **Lane:** normal.

### H6 — Unbounded caches (`seqCounters`, `knowledgeCache`, `sectionCache`)

- **Files:** `src/state/event-log/event-log.ts:359`,
  `src/extension/knowledge-injection.ts:376,383`
- **Recommendation:** Apply the FIFO cap pattern used by sibling caches
  (`agentEventSeqCache` cap, `TEAM_DISCOVERY_MAX_ENTRIES=32`). Low-risk but
  needs an ADR noting the cap value.
- **Lane:** normal.

### H7 — Test-suite timing budget

- **Files:** `test/integration/` (sequential, 5-min per-file timeout)
- **Recommendation:** Split into fast/slow tiers. Move pure-logic
  integration tests (`dwf-setresult`, `operator-experience`,
  `role-tools-integration`, `retrieval-orchestrator` — verified mock/no-spawn)
  to `test/unit/`. Replace hardcoded `setTimeout` sleeps in
  `subagent-tools-integration.test.ts` and the 5 crash-recovery tests with
  event-driven awaits. Estimated recovery: ~40-50s per `npm test`.
- **Lane:** normal.

### H8 — Silent error swallows on trust/recovery boundaries

- **Files:** `src/runtime/child-pi/child-pi.ts:407-411` (broker-issuer
  failure swallowed with no metric), `src/runtime/team-runner.ts:948-969`
  (recovery-save failure swallowed with no log)
- **Recommendation:** Add `logInternalError` + metric counters. Additive
  logging only.
- **Lane:** tiny-to-normal.

### H9 — v0.9.65 missing git tag + release

- **Files:** `package.json:4` (version `0.9.65`), `git tag --list 'v0.9.*'`
  (latest is `v0.9.64`)
- **Recommendation:** Per AGENTS.md pre-commit flow step 6 (`npm publish` +
  GitHub release). T4 (production-mutating) — requires explicit approval.
- **Lane:** high-risk (release).

---

## Execution changelog

(Updated as items complete. Format matches the 2026-08-09 plan.)

- **2026-08-10 (H3 phases 2–4 — handleApi full split + runChildPi mock + handleRun validate):**
  - Final gate state: `npm run typecheck` PASS, `npm run lint` clean (0),
    `npm run format:check` clean, all 4 check scripts clean,
    `npm run test:critical` PASS (101/0). Focused run over every touched
    module's test files: **130/0**.
  - **H3 phase 2 — handleApi fully decomposed (1239 → 77 lines).** The
    remaining 32 operations were split into cohesive group modules under
    `src/extension/team-tool/api/`:
    - `read.ts` (365 lines) — 17 read/inspect ops + 2 pre-runId ops
      (metrics-snapshot, inventory) via a new `ApiPreHandler` type.
    - `plan-approval.ts` (190) — approve-plan, cancel-plan.
    - `agent-control.ts` (365) — nudge, list-live-agents, steer/follow-up/
      stop/resume/interrupt (one shared live-agent-control body).
    - `mailbox.ts` (261) — read/validate/read-delivery/send/ack.
    - `heartbeat.ts` (82) — write-heartbeat.
    - `task-claims.ts` (207) — phase-1 extraction, unchanged.
    - `handler-context.ts` (57) — `ApiHandlerContext` extended with
      `params` + `ctx`; `ApiOperationHandler` made async-capable; new
      `ApiPreHandler` for pre-runId ops.
    - `api.ts` is now: config parse → pre-runId dispatch → runId guard →
      single `API_OPERATIONS` map dispatch → unknown-op error (whose
      "valid operations" list is DERIVED from dispatcher keys — can never
      drift). All 24 api-ops-coverage + claim tests pass unchanged.
  - **H3 phase 3 — runChildPi mock slice extracted.** The ~140-line mock
    fixture branch moved to `src/runtime/child-pi/mock-fixtures.ts`
    (`runMockChildPi`, returns undefined when mock mode is off). Security
    model (PI_CREW_ALLOW_MOCK parent-only) preserved verbatim. child-pi.ts
    dropped `os`/`path`/`atomicWriteFile` imports. All 85 child-pi unit +
    2 mock integration tests pass. The final-drain timer trio and
    result-builder remain in runChildPi — they interleave the spawn
    closure; extraction needs a contract test first (deferred).
  - **H3 phase 4 — handleRun validation phase extracted.** ~215 lines of
    validation (goal → crew-init → worktree precondition → agent/team/
    workflow resolution → analysis → parallel-research expansion → preflight
    → goal-wrap decision → workflow validation → skill override) moved to
    `src/extension/team-tool/run-intent.ts` (`validateRunIntent` →
    `RunIntent | error result`). Chain dispatch stays in handleRun (recursive
    handleRun ref). The exact error-precedence order is preserved (7 run
    tests + 42 dispatch/goal-wrap/workflow tests pass). The execute phase
    (async/foreground/inline branches + deadline/timer dance) stays inline —
    extraction needs its own ADR per the 2026-08-09 plan's dispatch-batch
    precedent.
  - **Net effect:** 3 god-functions substantially reduced (handleApi 1239→77,
    runChildPi −140, handleRun −215) with zero behavior change; every moved
    line has test coverage from the pre-existing suites.

- **2026-08-10 (Tier 2/3 — H1–H8, except H9):** all remaining plan items
  implemented with per-item verification. H9 (v0.9.65 git tag + publish)
  deliberately NOT done — it is T4 production-mutating and requires explicit
  approval per AGENTS.md.
  - Final gate state:
    - `npm run typecheck` — PASS.
    - `npm run lint` — clean (0 diagnostics; fixed 2 pre-existing empty-block
      lint errors in `bench/child-pi-parse.bench.ts` along the way).
    - `npm run format:check` — clean (1315 files).
    - `npm run check:lazy-imports` / `check:decision-drift` /
      `check:conflict-markers` / `check:event-types` — all clean.
    - `npm run test:critical` — PASS, **101/0** (21.5 s).
    - Focused unit run over every test file touching the changed modules —
      **209/0** (30 s).
  - **H1 — appendEvent sync → async (17 call sites converted):** the file's
    own `@deprecated` note (event-log.ts) recommends the async path for
    informational events; sync path costs ~14 ms/event + blocks the event
    loop via `sleepSync`. Converted with two patterns:
    - `await appendEventAsync(...)` in async contexts (api plan-approved/
      cancelled/control-queued, cancel async.kill_requested, team-tool.ts
      resume events ×5, lifecycle-actions ×4, goal.ts ×3, goal-wrap, parallel-dispatch).
    - `void appendEventAsync(...).catch(logInternalError)` inside SYNC
      run-lock callbacks (status.ts stale-async + group-join-ack already
      done in H5; api.ts mailbox.message/acknowledged/group-join-ack/
      worker-heartbeat; cancel task.retried; respond task.resumed;
      team-tool.ts steer_queued).
    - **Kept sync deliberately:** terminal/crash-critical events
      (`task.cancelled` in cancel.ts, `async.died` in async-notifier),
      `appendEvent` passed as a callback (terminateLiveAgentsForRun,
      appendEventFireAndForget callers), and the 3 claim ops in the
      extracted `api/task-claims.ts` (must stay atomic with saveRunTasks
      under `withRunLockSync`).
  - **H2 — saveCrewAgents N+1 fsync fixed:** `saveCrewAgents` previously
    wrote agents.json (index) + N per-task `status.json` files, ALL with
    full durability — a 50-task team paid ~750 ms of blocking fsync per
    call (≥10 calls/run). Now only TERMINAL records keep full durability
    (F4 contract: notifier/dashboard must see final state immediately);
    non-terminal per-task status goes through the existing best-effort
    coalesced path (same as `upsertCrewAgent`'s non-terminal branch). The
    index file `agents.json` remains full-durability; crash recovery is
    covered by agents.json + events.jsonl. All 35 crew-agent + 10
    security-hardening + 15 team-runner tests pass.
  - **H3 — handleApi extraction phase 1 shipped:** created
    `src/extension/team-tool/api/handler-context.ts` (shared
    `ApiHandlerContext` — cfg/loaded/result/paramRequired) +
    `src/extension/team-tool/api/task-claims.ts` (claim-task,
    release-task-claim, transition-task-status + `TASK_CLAIM_OPERATIONS`
    dispatcher map). handleApi now dispatches via the map; behavior is
    byte-identical (24 api-ops-coverage + claim tests pass). Remaining 32
    operations stay inline pending follow-on phases — the dispatcher
    pattern is proven.
  - **H4 — api unknown-operation error hardened (audit corrected):** the
    audit claimed unknown ops "silently run read-manifest" — WRONG: a
    terminal `return result(\`Unknown API operation: ${operation}\`)` at
    line 1314 already existed. The real gap was a generic error with no
    self-correction. Now the error lists all 35 valid operations +
    examples; +2 tests (underscore typo "claim_task", empty-string op).
  - **H5 — read-path sync I/O fixed:** `handleStatus` (a) hoisted 3
    `loadConfig(ctx.cwd)` calls into one `cfg` (was ~24 stat syscalls per
    status poll), (b) made the stale-async side-effect idempotent via a
    bounded FIFO `Set<runId>` (previously re-wrote tasks.json + appended
    on EVERY poll of a dead async run), (c) converted both informational
    events to `void appendEventAsync().catch()`. `persistSingleTaskUpdate`
    CAS retry lowered 100 → 10 (each retry = flush + reload + stat,
    ~5 ms; worst-case blocking 500 ms → 50 ms).
  - **H6 — unbounded caches capped:** `seqCounters` in event-log.ts got a
    FIFO cap of 256 (mirrors appendCounters/agentEventSeqCache);
    `knowledgeCache`/`sectionCache` in knowledge-injection.ts got a FIFO
    cap of 64 (mirrors discover-* caches). All eviction-safe: the next
    read re-seeds from disk.
  - **H7 — test-suite timing:** moved 4 pure-logic integration tests
    (`dwf-setresult`, `operator-experience`, `role-tools-integration`,
    `retrieval-orchestrator` — all verified subprocess-free, mock-based)
    to `test/unit/` where they run 4× parallel. Audit's claim about "20 s
    of crash-recovery sleeps" was WRONG — those `setTimeout(2000)` calls
    are exit-event GUARDS (`child.once("exit")` resolves in <10 ms on
    healthy CI), not scan waits. Left unchanged.
  - **H8 — silent error swallows surfaced:** broker-issuer failure in
    `child-pi.ts:407` now logs `child-pi.broker-issuer-failed` (was fully
    silent — the child spawned without broker credentials and the run just
    looked "slow"); team-runner recovery-save failure now logs
    `team-runner.recovery-save-failed` (was silent — manifest could stay
    "running" with no signal). Additive logging only; durable-first
    invariant untouched.
- **2026-08-10 (Tier 1 complete):** all 13 Tier-1 items (G1–G13) implemented
  with per-item verification. Final gate state:
  - `npm run typecheck` — PASS (`tsc --noEmit` clean + `strip-types import ok`).
  - `npm run check:lazy-imports` — clean.
  - `npm run check:decision-drift` — clean.
  - `npm run check:conflict-markers` — clean (1394 files scanned).
  - `npm run check:event-types` — REPORT mode, exit 0. Detected 72 unregistered
    event types (existing backlog, now visible — see H1).
  - `npm run test:critical` — PASS, **101/0** (15.2 s).
  - Per-file unit run for touched files — **56/0** (crew-init +10 tests,
    glob-match-redos, supervisor-contact × 2, scratchpad protocol/transform).
  - Net code delta:
    - +3 scripts (`test-changed.mjs`, `check-event-types-registry.mjs`,
      extended `test-runner.mjs` with `--watch` support).
    - +4 npm scripts (`test:functional`, `test:platform`, `check:event-types`
      in `ci` chain; `test:watch`/`test:new`/`test:changed` now route through
      the wrapper so `**` globs actually expand).
    - +2 src modules (`src/utils/glob-match.ts` extracted from api.ts;
      `src/state/gitignore-manager.ts` rewritten to detect `.pi/teams/`).
    - +4 test cases for `.pi/teams/` gitignore layout (G12).
    - +2 docs/bugs files (bug-024, bug-025) linked from previously-orphan
      `test.skip` comments.
    - −4 dead modules/exports: `src/types/new-api-types.ts` (file),
      `checkSequenceGaps`, `BUILT_AGAINST_PI_VERSION` + its test,
      `parseSupervisorContactFromLine` (migrated edge tests to the shared
      validator `supervisorContactFromEvent`).
    - −2 dead env vars from README (`PI_CREW_BROKER_DIAG_UI`,
      `PI_CREW_QUIET_PREFLIGHT`). `PI_CREW_USE_BUNDLE` KEPT — verified live
      in `index.ts` (the audit's "0 hits in src/" was overly strict; the
      env var is read in the entrypoint which ships in the package).
    - Doc fixes: CLAUDE.md action count (28 → 54), README (40+ → 54),
      `types/dwf.d.ts` stale path comment.
  - Notable corrections from the audit during execution:
    - **G5 nuance:** the contract audit flagged 3 dead env vars; only 2 are
      truly dead. `PI_CREW_USE_BUNDLE` is live in `index.ts` (entrypoint,
      outside `src/`). Plan updated; README row kept.
    - **G6 nuance (action count):** initial node count said 48 — that regex
      missed hyphenated actions (`workflow-create`, `auto-summarize`). Manual
      recount from the schema source confirms **54** (`9+16+7+16+6`), matching
      the existing schema comment. The 54 figure is now in CLAUDE.md + README.
    - **G12 nuance:** `intermediate-store.ts` has **0 production callers**
      (only a comment mention at `dynamic-workflow-context.ts:152`). So the
      "hardcoded `.crew/intermediate` path" half of G12 is a dead-code issue,
      not a live path bug. Only `gitignore-manager.ts` was fixed; the
      intermediate-store path is noted for the H3 dead-export sweep.
    - **G11 implementation:** the initial `git grep` approach failed because
      emit sites use multiline object literals (`type:` on a separate line
      from `appendEvent(`). Rewrote as a JS source walk with a 15-line
      lookahead window. Detects 108 emitted literal types vs 65 registered
      (72 drift), matching the audit's order of magnitude.
    - **Comment-parsing gotcha (process):** the first `test-changed.mjs`
      draft used a JSDoc block containing the glob `test/unit/**/bar.test.ts`
      — the substring `*/` inside `**/` prematurely closed the block comment.
      Switched to `//` line comments for any file header that mentions glob
      patterns. Documented here so future scripts avoid the same trap.
- **2026-08-10 (initial draft):** baseline `npm run typecheck` PASS, `npm
  run test:critical` PASS (101/0, 16.8s). Per-item execution begins.
