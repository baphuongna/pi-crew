# Project Knowledge

## Code Style
- Use TABS for indentation (not spaces)
- Tests run via `npm test` (the node:test runner)

## Architecture
- Dead code was removed in v0.7.0 (BudgetTracker, MemoryStore)
- pi-api.ts centralizes the Pi coupling surface (8 symbols)

## Testing Convention
- This file (.crew/knowledge.md) is auto-injected into every agent prompt
- If an agent references this knowledge, memory injection is working

## Release discipline — NEVER publish when CI is not 100% green (learned 2026-07-13)
- CI runs 3 OSes (Ubuntu, macOS, Windows). ALL must pass before `npm publish`.
- A flake on one OS IS a real bug — investigate, don't dismiss. The
  `parallel-research-dynamic.test.ts` flake turned out to be a genuine
  EEXIST race in `renameWithLinkAsync` exposed by OPT-02 async saves.
- **Async I/O races are real**: converting sync `unlinkSync`+`linkSync`
  to `await unlink()`+`await link()` creates interleaving windows that
  sync code didn't have. Always add error codes for races to retry sets:
  `RETRYABLE_LINK_CODES` needed EEXIST added.
- **Always rebuild bundle before publish**: `npm run build:bundle` then
  `git add -f dist/` (dist is gitignored but tracked historically).
- **Publishing flow**: CI green → `npm publish` → `gh release create`.

## Process Safety — NEVER kill a main `pi` session (learned the hard way)
- A user's interactive **main `pi` session** is indistinguishable from a
  sub-agent child-pi by naive heuristics (uptime, RSS, orphaned ppid).
  Killing it destroys live work and cannot be undone.
- **Authoritative marker**: every pi-crew sub-agent carries the
  `PI_CREW_KIND=subagent` ENV var, set by `buildPiWorkerArgs` in
  `src/runtime/pi-args.ts`. A main session does NOT. (We deliberately do
  NOT use an argv flag — pi's strict option parser rejects unknown flags
  and exits non-zero, which would break every agent call.)
- **Before killing ANY `pi` process**: check `/proc/<pid>/environ` for
  `PI_CREW_KIND=subagent`. If absent → it is a main session → DO NOT TOUCH.
- **To find real zombies safely**: `team action='doctor' focus='zombies'`
  (read-only). It only matches processes with `PI_CREW_KIND=subagent` AND
  whose `PI_CREW_PARENT_PID` is dead. It never lists main sessions.
- **Rule**: "check" / "diagnose" / "investigate" means READ-ONLY. Never
  kill/delete/terminate anything without explicit user confirmation first.
  See `src/runtime/zombie-scanner.ts` for the safe scanner implementation.

## Crash taxonomy + OwnedProcess abstraction (2026-06-25, NOT committed/published)
- P0 #1: `src/runtime/crash-classification.ts` — pure `classifyProcessCrash()`
  with 9-class `CrashClass` union. Precedence: timeout > cancelled > spawn_error
  > native_panic > signal_exit > clean_exit > non_zero_exit > protocol_exit.
  Native-panic detection is conservative (only on abnormal exit, case-insensitive
  stderr signatures: SIGSEGV/segfault/segmentation fault/SIGABRT/abort()/fatal
  error/panic:/thread '/illegal instruction/double free).
- Wired into `WorkerExitStatus.crashClass` (types.ts) and child-pi.ts exit/settle
  paths (both the `close` handler AND the `error` handler settle calls).
- P0 #3: `src/runtime/process-lifecycle.ts` — `OwnedProcess` class (escalating
  SIGTERM→grace→SIGKILL, idempotent dispose, group-aware), `spawnOwnedProcess()`,
  `registerResourceOwner()`/`disposeAllOwners()`/`disposeOwner()`.
- INCREMENTAL adoption only: child-pi.ts's kill logic (killProcessTree,
  post-exit-stdio-guard, hard-kill timer) and async-runner.ts's detached/setsid
  background spawns are INTENTIONALLY NOT migrated — they have their own
  battle-tested escalation and intentional lifecycle semantics.
- Gotcha: OwnedProcess polling timers must be REF'd (NOT unref'd) — gajae-code
  uses unref, but that causes node:test's event loop to empty mid-dispose,
  reporting "Promise resolution still pending". Ref'd timers ensure dispose()
  completes before process exit, which is the desired correctness property.
