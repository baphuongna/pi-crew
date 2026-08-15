# Live Mailbox Runtime Direction

`pi-crew` currently uses workflow child-process orchestration: a run materializes tasks, executes them through the scheduler, writes artifacts/events, and optionally launches child Pi workers.

A full live mailbox runtime is intentionally out of scope for the current stable surface. Current foundational mailbox files are intentionally simple and local:

```text
{stateRoot}/mailbox/inbox.jsonl
{stateRoot}/mailbox/outbox.jsonl
{stateRoot}/mailbox/delivery.json
{stateRoot}/mailbox/tasks/{taskId}/inbox.jsonl
{stateRoot}/mailbox/tasks/{taskId}/outbox.jsonl
```

They are exposed through safe API operations (`read-mailbox`, `send-message`, `ack-message`, `read-delivery`, `validate-mailbox`) but do not yet imply always-on long-lived workers. If a full runtime is added later, it should build on the foundations already present:

- `src/state/contracts.ts` for status/event contracts
- `src/state/task-claims.ts` for claim/lease safety
- `src/runtime/worker-heartbeat.ts` for liveness
- `src/state/locks.ts` for run-level mutation safety
- `action: "api"` for safe interop boundaries

## Proposed phases

1. **Read-only interop** — already started with `api` operations.
2. **Heartbeat writers** — allow workers to update heartbeat/progress safely.
3. **Claim-safe task lifecycle** — expose claim/release/transition operations with tokens.
4. **Mailbox** — add worker inbox/leader inbox files and delivery state.
5. **Live workers** — only after the above contracts are stable.

## Non-goals for now

- No always-on background worker pool.
- No automatic destructive cleanup of dirty worktrees.
- No recursive team spawning by workers.
- No mailbox mutation without locks and schema validation.

---

## Live-session runtime path — FROZEN EXPERIMENTAL (Phase 4, decision (a))

> ADR: `docs/decisions/2026-08-15-runtime-convergence.md` (2026-08-15).
> `runtime.mode=live-session` is a **permanently experimental** configuration.
> It is frozen: no new features may be added without revisiting the ADR.

The live-session path (`task-runner/live-executor.ts` →
`live-session-runtime.ts`) delegates to the `@earendil-works/pi-coding-agent`
SDK via `createAgentSession` (in-process). It is intentionally **divergent**
from the supported child-process path (`task-runner/child-executor.ts`); a
convergence attempt was assessed **RISKY (HIGH)** in refactor-plan.review.md
§ROUND 4 P2 and rejected.

### Gap matrix (sweep 3, 2026-08-13; re-confirmed 2026-08-15)

| Concern | Child-process (supported) | Live-session (frozen) |
|---|---|---|
| Fallback execution | explicit multi-attempt loop over candidates | delegates to `createAgentSession`, single `modelFallbackMessage` |
| Worker cap | `withWorkerSlot` global semaphore (`run-worker.ts`) | **bypassed** (zero references) |
| Depth guard | enforced | **absent** (zero `depth` references) |
| Progress persist | `state-helpers.ts` save paths | same `state-helpers.ts` save paths (already shared at executor layer) |
| Tool filtering | restrictive `--tools` allowlist at spawn | permissive SDK `DefaultResourceLoader` (no per-extension allow/deny at handoff) |
| Kill/abort | `killProcessTree` SIGTERM→3s→SIGKILL | `ac.abort()` + `session.abort?.()` |

### Accepted divergences (frozen as-is)

- Unconstrained fallback providers possible with `requireCredentials` set
  (S19-3; F19-1 parser fix in Phase 5 made `modelFallback` effective, but the
  single-message fallback report stays permissive by SDK design).
- No global worker semaphore / depth guard on the live path.
- Permissive tool surface by default.

A warn-once startup notice is emitted on first live-session dispatch
(`live-session.experimental`, severity warn).
