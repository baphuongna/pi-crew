# Waiting-producer: `ask` tool + park contract (R2)

**Date:** 2026-08-17
**Status:** Accepted — T1 (v0.10.1) of the subagent v2 plan; prerequisite ADR for WP-2
**Relates to:** `src/prompt/prompt-runtime.ts`, `src/runtime/broker/crew-broker.ts`, `src/runtime/broker/crew-broker-tokens.ts`, `src/state/coordination/mailbox.ts`, `src/extension/team-tool/respond.ts`, `src/runtime/stale-reconciler.ts`, `src/runtime/recovery/crash-recovery.ts`, `src/runtime/dispatch-batch.ts`, `src/runtime/child-pi/child-pi-spawn.ts`, `src/config/env-vars.ts`, `docs/design/subagent-v2-design.md` (§3), `docs/design/subagent-v2-implementation-plan.md` (WP-2)

## Context

The `waiting` task status has six consumer surfaces (respond, crash-recovery, events, UI, contract docs, `task.waitStatus`) and **zero producers** — verified by 3 independent greps (audit run `team_20260816163952`, S3/S4; confirmed in design review rounds). Workers cannot ask questions mid-task; the final result text is their only output channel. R2 ships the missing producer.

Plan-review findings shaped this ADR: env-plumbing gap (P0, no `PI_CREW_STATE_ROOT` exists and scratchpad-gated vars exclude read-only roles), respond live-path mechanism (NEW-1 → option (b)), park state that must not break the scheduler (NEW-3), token requirement (NEW-4), mailbox schema (F11), trust boundary (security P1-4), timeout clamp (P2-7).

## Decision

1. **Worker-side `ask` tool** (in `prompt-runtime.ts`, dormant-until-env pattern like scratchpad `scratchpad-lifecycle.ts:642-647`):
   `ask({ question, options?, timeoutSec? = 600 })` with **server-side clamp `timeoutSec ≤ 3600`** (P2-7 — worker-controlled unbounded timeout would pin slots + amplify I/O).
2. **Env plumbing is unconditional** (P0 fix — dead-on-arrival otherwise): `child-pi-spawn.ts` sets `PI_CREW_ASK_ENABLED=1` and `PI_CREW_STATE_ROOT` (stateRoot from the spawn manifest) for **every** role — read-only roles included (design §3.4 requires they can ask). Both keys registered in `config/env-vars.ts` (`check:env-vars` enforces). NOT scratchpad-gated.
3. **Park = `task.waiting` + `manifest.waitState`, NO `manifest.status` flip** (NEW-3): `task.waiting = { questionId, askedAt, deadline, options? }`; `manifest.waitState = { taskId, questionId, askedAt }`; `manifest.status` stays `running` — the run keeps its registry entry, sidebar visibility, and `live-executor.isCurrent()`. New fields are schema additions (listed here; `TeamTaskState`/`TeamRunManifest` have neither today).
4. **Option-(b) delivery** (NEW-1): the ask tool **polls the run mailbox stream** (run-level dir `<stateRoot>/mailbox`, `state/coordination/mailbox.ts:105`, per-task streams) every 500ms for `kind:"response", questionId` and **returns the answer as its tool result**. No steer seam, no turn-boundary dependency, no held RPC (principle 7 durable-over-RPC). Timeout → tool returns `"[ask timed out — continue with best judgment]"`.
5. **Trust boundary** (security P1-4): the mailbox is an **unauthenticated same-uid channel**; ask answers are wrapped in the `<dependency-context>` fence (or source-tagged) when injected into the worker context; `questionId` = `randomUUID` (unguessable).
6. **Token requirement** (NEW-4): `wait.request`/`wait.resolve` broker methods authenticate via **task-scoped (compound-key) tokens ONLY**. `crew-broker-tokens.ts` registry gains a match-kind API (compound vs bare-`runId` fallback); fallback matches are REJECTED for `wait.*` with a migrate hint. Enforce `to === conn.taskId` (the `escalate` unvalidated-`to` pattern at `crew-broker.ts:1170` is the recorded anti-pattern). Add `"waiting"` to `waitStatus.validStatuses` (`crew-broker.ts:1003`).
7. **Capability-gated, fail-closed**: new config `waitMethodsEnabled` (default **false** until WP-2 completes; then true) in `config/defaults.ts` + `schema/config-schema.ts` (`config-schema-sync` update). Disabled → broker rejects `wait.*` with a policy message logged to `events.jsonl` (never silent); negative flag-off test required.
8. **Respond liveness discriminator**: alive (heartbeat last-beat < 60s gradient-`stale` window, or live in-memory handle) → write mailbox response under `withRunLockSync` + fresh reload (the `respond.ts:42-43` discipline — same as plan-review NEW-6 pin), leave task `waiting`; the parked tool picks it up and flips `waiting→running` via its own terminal report. Dead → re-queue AND inject answer into the next dispatch prompt (mailbox history). **Exactly-one-dispatch guard** — never both (no double-dispatch).
9. **Reconciler/crash protection**: `stale-reconciler.ts:45-47` `isPlanApprovalPending` → `isIntentionalWait` (adds `waitState.askedAt` within `waitingTtl`, default 24h); waiting tasks within TTL NOT cancelled (`:243,277-282` change); TTL-expired still cancelled (leak guard). `crash-recovery.ts` preserves `task.waiting` fields through restore (verify field survives; add if dropped).
10. **Timeout owner = scheduler tick** (`dispatch-batch.ts:221` while-loop): checks `task.waiting.deadline` (persisted, survives crash-recovery); expiry → if worker alive surface as in-tool timeout result; if dead re-queue with injected note. Both outcomes append `events.jsonl`. Event kinds `ask.requested`/`ask.answered`/`ask.timedout` added to `TEAM_EVENT_TYPES` (`src/state/contracts.ts`).
11. **MailboxMessage schema** (F11): interface at `mailbox.ts:57-77` has no `questionId` — extend with a dedicated `questionId?: string` field (placement pinned here; `kind:"response"` already exists at :12).

## Consequences

- Workers can pause mid-task for a human answer; long blocked tasks become visible (run stays `running`, UI shows wait).
- Cost bounded: one 500ms poll only while parked; timeout clamp 3600s; TTL leak-guard 24h.
- Back-compat: pre-v2 records ignore the new optional fields; `wait.*` methods disabled-by-default until the train flips them; reconciler change is additive (old plan-approval protection preserved).
- Docs updated: `docs/design/subagent-v2-design.md` §3 already encodes this; plan WP-2 steps encode execution order (env before tool).
