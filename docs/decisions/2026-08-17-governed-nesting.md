# ADR-5 — Governed nesting: `delegate` tool, spawn policy, credential containment

- **Status:** proposed (T3 / WP-5)
- **Date:** 2026-08-17 (pinned) · written 2026-08-19
- **Implements:** subagent-v2 design §7 (H1, P1) rev 2.1 incl. NEW-6 pins; implementation-plan ADR-5 + WP-5
- **Depends on:** ADR-0 (ask/park mailbox contract), ADR-4 (Plan object — task records)
- **Gates:** CI 3-OS + **B3 nesting battery (security-weighted: security-reviewer + cold-verifier sign-off required)**

## Context

Workers load only the prompt runtime (`model/pi-args.ts:306-331`) — no delegation seam. Spawning grandchildren naively hits four scattered gates (global semaphore → deadlock shape recorded in-repo at `scheduling/global-worker-cap.ts:14-19` MAJ#3; env-derived `PI_CREW_DEPTH` wrong for root-spawned grandchildren `child-pi/child-pi.ts:253-257`; `issueForChild` mints creds without a depth check `registration/lifecycle-handlers.ts:1024-1036`; extension deny-list is basename-equality `model/pi-args.ts:303-305`). Rev-1 design (synchronous RPC delegate, global-sem ride-along) was rejected in design review (P0-1 deadlock, P0-2 depth, P1-6/7/10/11/12/14/15) — see design §7 revision notes.

## Decision

### 1. Worker-side surface: `delegate` (prompt-runtime, role-gated)

```
delegate({ description, prompt, role?: "explorer"|"analyst"|"executor",
           model?, maxTurns?, budgetTokens?, timeoutSec? = 900 })
  → returns IMMEDIATELY { grandchildTaskRef }
```

- Registered only for **executor-class roles** at depth 1; read-only roles rejected with a policy message.
- **Delivery is durable, never synchronous RPC** (principle 7): the grandchild's terminal state + fenced result text land in the **parent task's mailbox + task record**; the `delegate` tool **self-polls the parent task's mailbox stream** (same option-(b) pattern as `ask`, §3) and returns the grandchild's fenced result as its tool result.
- Parent task stays `running` (NOT parked/waiting) while the delegate is in flight. `timeoutSec` (mandatory, default 900) expiry → tool returns `"[delegate timed out]"`, worker continues, grandchild is **soft-cancelled by the spawn-policy owner** (dead reason `delegate-timeout`).

### 2. Spawn path & anti-deadlock (pin i)

- Grandchildren are spawned by the **root-side delegate handler** via a **direct `runChildPi` call-site** with `cap:false`-style global-semaphore bypass (generalizes the MAJ#3 judge precedent) — a waiting parent worker keeps its own global slot without self-starvation.
- Separate **nested-slot budget**: default `max(1, floor(globalSem/2))`, cap-configurable (`nesting.maxSlots`). **Fail-fast, never queue:** budget exhausted → `delegate` rejects immediately with `"nested spawn budget exhausted; N/M in flight"`. Negative AC — no silent queueing.

### 3. Depth (pin for depthOverride)

- Spawn-policy computes the grandchild's depth from the **parent task's record in run state** (`task.depth` — schema addition §6), never from the requesting worker's env or self-report; sets `PI_CREW_DEPTH` explicitly on the grandchild spawn; clamps against `PI_CREW_MAX_DEPTH` (default **2**, config-raisable). Depth-3 is blocked by default with a policy message.
- The existing env-derived `checkCrewDepth` remains as a **backstop** for worker-initiated spawns (bash-escape path); the authoritative check is spawn-policy's.

### 4. Broker credential containment (pins ii & iii)

- **Issuer depth gate:** `issueForChild` mints task-scoped tokens **only for depth ≤ 1** (gate at the lifecycle-handlers call-site). Depth-2 grandchildren receive `PI_CREW_KIND=subagent`, steering file, and mailbox — but **no `PI_CREW_BROKER_SOCKET` / `PI_CREW_BROKER_TOKEN`** (they cannot `delegate` further at default maxDepth=2; identity-routing `BROKER_RUN_ID`/`BROKER_TASK_ID` stay — design §7 erratum D-2). **AC: depth-2 env contains no `PI_CREW_BROKER_*`.**
- **Task-scoped tokens are mandatory for the `delegate` broker method** — legacy/global tokens are rejected; cross-task `to` targeting rejected (auth matrix in `delegate-broker.test.ts`).

### 5. Budget attribution (pin iv — schema)

- New schema field `allocation { tokensGranted, tokensSpent }` on `TeamTaskState` (schema addition, NEW-5/NEW-6).
- The delegate handler **reserves** `budgetTokens` from the parent task's remaining allocation at admission (fail-fast rejection if insufficient) and **rolls up** grandchild usage events to the parent task record as they arrive (single writer, run lock). Global budget enforcement keeps reading totals; fair-share detection sees grandchild usage through the parent. **AC: grandchild usage visible in the parent task's usage in `team status`.**

### 6. Grandchild lifecycle

- The delegate handler registers a **heartbeat observer + deadletter path** per grandchild (gradient 30/60/300s; dead reasons extended with `delegate-timeout`). Zombie scanner backstop (`PI_CREW_KIND`/`PARENT_PID`) unchanged.
- Artifacts are namespaced: `artifacts/<runId>/<parentTaskId>/nested/<subId>/`.

### 7. Model validation at admission

- `delegate({model})` values are validated against the **resolved model catalog** at spawn-policy admission. The unvalidated `provider/model` pass-through (`model-fallback.ts:282`, the 429-cascade root) must not be reachable through the new surface. (P2 R8 keeps the warning for all OTHER surfaces.)

### 8. Extension containment

- At depth > 0 the extension list becomes an **allowlist**: only `PROMPT_RUNTIME_EXTENSION_PATH`, regardless of source — including user-sourced agent declarations (SEC-1's project-only strip is insufficient; this closes the audit's untested hole; basename deny-list is dead).
- **Accepted risk, documented:** bash-escape spawning stays depth-unaccounted; zombie scanner is the backstop. Revisit with worker self-reporting (P2).

### 9. Workspace interaction (pin v)

- Default: executor-class `delegate` on a shared-workspace run **auto-enables `serializeOnPathOverlap`** for the parent+grandchild pair. The spawn-policy rejects a delegate whose parent task `cwd` overlaps another in-flight executor's only if serialization cannot be established. Worktree mode remains opt-in as today.

### 10. Config & rollout

- New config key `nestingEnabled` (config schema + defaults; `config-schema-sync` gate updated). **Ships default `false`**; the WP-5 completion gate (B3 + security sign-off) flips the default to `true`. Disabled → spawn-policy returns a structured policy rejection + `events.jsonl` log entry (negative flag-off tests required).
- `nesting.maxSlots` overrides the nested-slot default; `PI_CREW_MAX_DEPTH`/config raises are covered by `spawn-policy.test.ts` (maxDepth raise → depth-3 works).

### 11. Alternatives considered (pin vi)

- **Full pi-crew extension inside workers** — rejected: broker root-gate, run-lock contention, state-root conflicts, and the 54-action team tool inside a worker are blast-radius multipliers. A 1-action `delegate` gives most of the value at a fraction of the surface. **Revisit conditions:** workers demonstrably need richer orchestration surface → propose an explicitly-scoped, allowlisted tool subset as a NEW mini-ADR; do NOT silently widen.
- **Synchronous RPC result delivery** (design rev 1) — rejected: dies on broker socket close; replaced by durable mailbox + self-poll (§1).
- **Queueing on nested-budget exhaustion** — rejected: fail-fast preserves the anti-deadlock invariant and gives the worker an actionable message (it can finish and retry).

### 12. Security considerations (pin vii + WP-5 gate)

- **Worker-token TTL/rotation** (design §11 P2-20): task-scoped tokens minted by the delegate path inherit the existing token lifetime semantics; **accepted-risk entry**: no independent TTL/rotation for worker-issued tokens in v0.10.x — revisit date pinned to the v0.11 planning cycle (tracked in the implementation-plan follow-up backlog). NOT silently dropped.
- WP-5 PR merge requires **security-reviewer sign-off + cold-verifier** (team `review` with security role) in addition to CI; B3 is the security-weighted battery.

## Consequences

- `TeamTaskState` grows `depth?: number` and `allocation?: { tokensGranted: number; tokensSpent: number }` (additive; dual-read tolerates pre-v2 records — see ADR-4 §9 pattern).
- New runtime modules: `src/runtime/spawn-policy.ts`, `src/runtime/scheduling/nested-slots.ts`; broker `delegate` handler in `crew-broker.ts`; `delegate` tool in `prompt-runtime.ts`; allowlist in `model/pi-args.ts`.
- Events: `delegate.*` kinds registered in `TEAM_EVENT_TYPES` (requested/admitted/rejected/rolled-up/timed-out).
- Gate-test updates anticipated: `config-schema-sync` (new keys), `child-pi-env-spread` (grandchild env shape), event-registry check.

## Appendix — B3 battery case list (security-weighted)

1. **(a) Flag-off:** `nestingEnabled=false` → `delegate` returns structured rejection + `events.jsonl` entry; no spawn. Negative test.
2. **(b) Happy path E2E:** depth-1 executor delegates → depth-2 grandchild: namespaced artifacts (`…/<parentTaskId>/nested/<subId>/`), result returns in-tool via mailbox self-poll, parent task stays `running` throughout.
3. **(c) Env containment (AC §4):** depth-2 grandchild env has **no `PI_CREW_BROKER_SOCKET`/`PI_CREW_BROKER_TOKEN`**; `BROKER_RUN_ID`/`BROKER_TASK_ID` present; `PI_CREW_DEPTH=2`.
4. **(d) Depth gate:** depth-3 blocked by default with policy message; `PI_CREW_MAX_DEPTH` raise → depth-3 spawns work (unit, `spawn-policy.test.ts`).
5. **(e) Anti-deadlock:** 4-core/sem-2 box, 2 concurrent delegates complete; nested-budget exhaustion → immediate `"budget exhausted; N/M in flight"` rejection, never queue (`nested-slots-deadlock.test.ts`).
6. **(f) Broker auth matrix:** task-scoped token ✓; legacy/global ✗; cross-task `to` ✗ (`delegate-broker.test.ts`).
7. **(g) Budget:** admission reserves `budgetTokens` (insufficient → fail-fast); grandchild usage rolls up to parent record; visible in `team status`.
8. **(h) Timeout:** `timeoutSec` expiry → `"[delegate timed out]"` in-tool, worker continues, grandchild soft-cancelled (dead reason `delegate-timeout`), heartbeat/deadletter registered.
9. **(i) Model validation:** invalid `provider/model` rejected at admission (`model-validation.test.ts`).
10. **(j) Resilience:** kill broker socket mid-grandchild → parent still receives result via durable mailbox; worker without broker creds (broker-gated spawn logs-and-continues) → `delegate` returns structured notice, no hang.
11. **(k) Role/extension containment:** read-only roles' `delegate` rejected; depth>0 extension list = allowlist (`PROMPT_RUNTIME_EXTENSION_PATH` only, user-sourced declarations included).
12. **(l) Workspace:** shared-workspace executor delegate auto-serializes on path overlap; worktree opt-in unchanged.
13. **(m) Security sign-off:** security-reviewer + cold-verifier verdicts recorded on the WP-5 PR.

## References

- Design: `docs/design/subagent-v2-design.md` §7 (+ §3 ask/park contract, §9 supporting upgrades, §11 P2-20)
- Plan: `docs/design/subagent-v2-implementation-plan.md` ADR-5 + WP-5 (steps 1–10), tests, ACs, security gate
- Precedents: `scheduling/global-worker-cap.ts:14-19` (MAJ#3 judge bypass), ADR-4 §9 (dual-read additive schema)
