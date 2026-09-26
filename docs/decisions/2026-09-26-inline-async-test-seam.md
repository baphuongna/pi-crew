# 2026-09-26 — In-process async test seam (double-gated), shared execution core, entry-guarded runner

**Status**: Accepted

## Context

Two chronic test-infrastructure failure modes traced to the same design: async
test runs execute by spawning a **detached** `background-runner` process
(decision 0002 — correct for production, hostile inside test deadlines):

1. **Windows Defender first-spawn stall** (CI ground truth, run 36093514388
   attempt 3): the runner spawn stalled >300s with the task left `queued`, event
   loop healthy (maxPollGap ~969ms). Per-file-hash AV caching — a machine-level
   property we cannot fix from the repo; a warm-up hack mitigated but did not
   eliminate it (still flaked 2026-09-26).
2. **Orphan-tmpdir leak**: a detached runner survives the test's `rmSync` and
   keeps writing run state into a deleted tree. Compounded by ~320 test files
   using `mkdtemp("pi-crew-*")`, this produced ~3.4k debris dirs and a frozen
   reconciler (see `2026-09-26-temp-workspace-hygiene`).

## Decision

1. **Extract the execution core.** `background-runner.ts` main() is split:
   `executeBackgroundRun({manifest, tasks}, opts)` carries the runKind switch
   (goal-loop / dynamic-workflow / team-run) with **zero process-level side
   effects** (no console redirect, signal handlers, watchdog, keepalive,
   parent-guard, exit codes). `main()` keeps process duties and calls the core
   with its abort signal.
2. **In-process seam, double-gated.** With BOTH
   `PI_CREW_TEST_ASYNC_INLINE=1` AND `PI_CREW_ALLOW_MOCK=1` (the existing
   test-fixture gate — production never sets either), `spawnBackgroundTeamRun`
   runs the core **in the caller's process**, fire-and-forget with a
   never-rejecting catch-all. Same code path as the detached runner — no
   behavioral drift between test and production execution.
3. **Entry-guard the runner.** `main()` now runs only when the process was
   actually invoked as the runner: the spawn stamps
   `PI_CREW_BACKGROUND_RUNNER_ENTRY=1` (allowlisted) OR the classic argv[1]
   entry-point check (keeps direct CLI spawns in integration tests working —
   belt and braces, because a silently-skipped main() would look exactly like
   the Defender stall).

## Consequences

- Heavy async test files (e.g. `subagent-tools-integration.test.ts`) run the
  real run logic without any second process: 14/14 in 37s where 5+min stalls
  were observed; the module-load Defender warm-up was deleted.
- In-process runs die with the test process — nothing detached survives the
  test's cleanup to write orphan state.
- The inline host must NOT set `PI_CREW_BACKGROUND_MODE=1` (guarded by
  `markBackgroundMode`) — it would re-route the host's own event writes.
- Broker creds need no stdin handshake inline (same heap as the issuer
  registry); the detached path keeps the F4 pipe handshake.
- The seam is a test affordance, not a production mode: the double gate is
  deliberate defense-in-depth; do not "simplify" it to a single env var.
- Regression contract: `test/unit/runtime/async-runner-inline-seam.test.ts`
  (gate combos + e2e probe asserting `pid === process.pid`), mutation-checked
  (pinned-off gate spawns a real child → pid assertion red).
