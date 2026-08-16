# Runtime-path convergence: freeze live-session (decision (a))

**Date:** 2026-08-15
**Status:** Accepted — Phase 4 (step 4.0) of the maintainability refactor
**Relates to:** `src/runtime/live-session/live-session-runtime.ts`, `src/runtime/task-runner/live-executor.ts`, `src/runtime/task-runner/child-executor.ts`, `src/runtime/team-runner.ts`, `docs/live-mailbox-runtime.md`

## Context

pi-crew has two execution paths for agent tasks:

- **Child-process path** (default): `task-runner/child-executor.ts` spawns a
  validated child Pi worker (`child-pi.ts`), runs an explicit multi-attempt
  model-fallback loop over candidates, enforces the global worker semaphore
  (`withWorkerSlot`), applies a restrictive `--tools` allowlist, and kills via
  `killProcessTree` SIGTERM→3s→SIGKILL.
- **Live-session path** (`runtime.mode=live-session`, experimental):
  `task-runner/live-executor.ts` → `live-session-runtime.ts` delegates to the
  `@earendil-works/pi-coding-agent` SDK via `createAgentSession` (in-process),
  reports a single `modelFallbackMessage`, has zero `withWorkerSlot`/`depth`
  references, relies on pi's permissive `DefaultResourceLoader` for tools, and
  aborts via `ac.abort()` + `session.abort?.()`.

Phase 4 of the maintainability plan considered converging the two paths onto a
shared `TaskExecutor` contract. The Round 4 audit verdict (refactor-plan.review.md
§ROUND 4 P2) was **RISKY (HIGH)**: the convergence premise overstates the shared
contract.

## Verified divergence matrix (sweep 3, 2026-08-13; re-confirmed 2026-08-15)

| Concern | Child-process path | Live-session path | Converge-able? |
|---|---|---|---|
| Fallback execution | explicit multi-attempt loop (`child-executor.ts`) | delegates to `createAgentSession`, single `modelFallbackMessage` | **NO** — no loop exists to share |
| Worker cap | `withWorkerSlot` (global semaphore, `run-worker.ts`) | zero references — bypasses semaphore | **NO** — semantically wrong for in-process sessions |
| Depth guard | enforced | zero `depth` references | **NO** |
| Progress persist | `state-helpers.ts` save paths | same `state-helpers.ts` save paths (executor layer) | **YES** (already shared; divergence was at executor layer, sweep 3) |
| Tool filtering | restrictive `--tools` allowlist at spawn | permissive `DefaultResourceLoader` via `createAgentSession` (no per-extension allow/deny at handoff, comment :675-676) | **NO** — SDK lacks the hook |
| Kill/abort | `killProcessTree` SIGTERM→3s→SIGKILL | `ac.abort()` + `session.abort?.()` | **NO** — different trust/process model |

## Decision

**Option (a) — freeze live-session as a permanently-experimental path.**

1. **No convergence attempt.** The two paths are intentionally divergent.
   Round 4's option (b) (extract a shared `TaskExecutor`, move the fallback
   loop / `withWorkerSlot` / progress-persist into shared code) is marked
   **NOT sound**: it would require either abandoning SDK delegation (massive
   behavior change) or building a parallel fallback/concurrency layer for
   live-session (3–5 days for a worse design).
2. **Document the gap matrix** in `docs/live-mailbox-runtime.md` (this is the
   authoritative record; the table above is the summary).
3. **Mark the path experimental permanently** — `runtime.mode=live-session`
   is not a supported configuration. The freeze is a *documentation and
   warning* deliverable; the code paths remain (they are exercised by tests),
   but no new features may be added to live-session without revisiting this
   ADR.
4. **Startup warning**: `runLiveSessionTask` emits a warn-once
   `logInternalError(..., "warn")` on first live-session dispatch, so an
   operator running `runtime.mode=live-session` sees an explicit
   "experimental — diverges from child-process semantics" notice.

### Accepted divergences (frozen as-is)

- Live-session may hit unconstrained providers on fallback when
  `requireCredentials` is set (S19-3) — the F19-1 parser fix (Phase 5) made
  `modelFallback` config effective, but live-session's single-message
  fallback report remains permissive by SDK design. Documented, not fixed.
- Live-session bypasses the global worker semaphore and depth guard.
- Live-session's tool surface is the permissive SDK default.

### Out of scope

- Removing the live-session code paths (tests exercise them; removal is a
  separate decision).
- Progress-persist convergence work (already shared at executor layer — no
  action needed).

## Consequences

- Maintenance surface halved: the child-process path is the supported one;
  live-session is frozen.
- Operators are explicitly warned at runtime.
- Future SDK improvements (e.g. a per-extension tool allowlist API) may
  revisit this ADR, but any re-convergence effort must re-run the Round 4
  risk assessment.
