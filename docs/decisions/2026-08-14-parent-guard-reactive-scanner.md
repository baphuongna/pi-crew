# Parent-guard: reactive-scanner-only model (intentional)

**Date:** 2026-08-14
**Status:** Accepted — reactive model documented as intentional (Phase 1.2 of the maintainability refactor)
**Relates to:** `src/runtime/child-pi/child-pi-spawn.ts`, `src/runtime/parent-guard.ts`, `src/runtime/process/zombie-scanner.ts`, `src/runtime/background-runner.ts`, `src/prompt/scratchpad-lifecycle.ts`

## Context

`PI_CREW_PARENT_PID` is set into every child-pi worker env (`child-pi-spawn.ts`)
so a spawned worker *could* run a direct parent-guard
(`process.kill(parentPid, 0)` liveness probe + self-terminate). The external
`pi` binary (`@earendil-works/pi-coding-agent`) does NOT read this var or call
`startParentGuard` (grep of the pi dist = 0 matches), so child-pi workers
cannot self-terminate on leader death. The stale comment at
`child-pi-spawn.ts:74`/`:144-145` called the var "UNUSED" — misleading: it IS
consumed by pi-crew's own reactive machinery.

## Consumers (verified 2026-08-14)

1. `zombie-scanner.ts:185` — reads `PI_CREW_PARENT_PID` from
   `/proc/<pid>/environ` (`readProcEnviron`) to detect orphaned/zombie workers
   whose leader died, then reaps them.
2. `background-runner.ts:615` — `startParentGuard(parentPid)` self-terminates
   the orchestrator process when its own parent dies.
3. `scratchpad-lifecycle.ts:50,166` — propagates the leader pid into scratchpad
   guest env for guest-zombie detection.

## Decision

**Do NOT wire `startParentGuard` into the pi worker entry point.** pi-crew does
not control the external `pi` binary. Orphan mitigation stays **reactive**:

- RT-2 SIGINT fix in `background-runner.ts` (abort + exitCode pattern lets the
  `finally`/runCleanup block terminate child-pi processes);
- the reactive `zombie-scanner.ts` sweep (finds workers whose
  `PI_CREW_PARENT_PID` points at a dead PID).

## Consequences

- `PI_CREW_PARENT_PID` is **kept** (do not remove — reactive consumers depend
  on it).
- If the pi binary ever gains a parent-guard entry point, the env var is
  already in place; wiring would be a pi-side change, not pi-crew.
- The `child-pi-spawn.ts` comments now name the actual consumers.
