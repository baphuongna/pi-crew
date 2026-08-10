# Hook reference

pi-crew has **three distinct hook/event subsystems** with complementary
scopes. They are not redundant — each serves a different timing and
side-effect contract. This document is the canonical reference for
contributors deciding which one to use.

## At a glance

| Subsystem | Module | Timing | Async? | Blocking? | Use for |
|---|---|---|---|---|---|
| Structured registry | `src/hooks/` | Around run/task/tool lifecycle | both modes | yes (when `mode:"blocking"`) | Decisions that must gate execution (block / allow / modify) |
| `crewHooks` bus | `src/runtime/crew-hooks.ts` | After task/run lifecycle transitions | fire-and-forget | no | Async side-effects: instinct learning, telemetry, skill effectiveness |
| Pi lifecycle hooks | `src/extension/registration/hook-registration.ts` | `tool_call` / `tool_result` / `resources_discover` | sync | depends on Pi | Inter-position filtering and tool-result inspection |

## 1. Structured registry — `src/hooks/`

Canonical blocking/non-blocking lifecycle hook system. Source of truth:
`src/hooks/types.ts` (`HookName`, `HookOutcome`), `src/hooks/registry.ts`
(`registerHook`, `executeHook`).

### Hook names

16 lifecycle events (`src/hooks/types.ts`):

```
before_run_start, after_run_complete,
before_task_start, after_task_complete, task_result,
before_cancel, before_retry,
before_forget, before_cleanup, before_publish,
session_before_switch, session_after_connect, session_after_disconnect,
run_recovery,
before_goal_step, before_goal_abort
```

### Outcomes and modes

- `HookOutcome = "allow" | "block" | "modify" | "diagnostic"`.
- `HookMode = "blocking" | "non_blocking"`.
- A `"blocking"` hook returning `outcome:"block"` **short-circuits** the
  action. A throwing blocking hook also blocks. Non-blocking errors
  accumulate as diagnostics.
- `outcome:"modify"` with `data` is deep-cloned and merged into the hook
  context (EXT-13 fix) — use for context enrichment, not mutation of
  disk state.

### Built-in guarantees

- **Workspace scoping** — global hooks match all contexts;
  workspace-scoped hooks require an exact `workspaceId` match.
- **Prototype-pollution defence** — `POLLUTED_KEYS` (NFKC-normalised) are
  stripped from merge data and from the context before/after each
  handler.
- **Event trail** — every execution appends a `hook.executed` event to
  `events.jsonl` and emits on `runEventBus`.

### When to use

- You need to **prevent** an action (cancel, forget, cleanup) based on
  external policy.
- You need to **modify** the run/task context before it flows downstream.
- You are OK with the handler running synchronously in the orchestrator
  thread.

### Call sites

`team-runner.ts:2499` (`before_run_start`),
`team-runner.ts:1091` (`after_run_complete`),
`task-runner/post-execution.ts:457,471` (`task_result`,
`after_task_complete`),
`recovery/crash-recovery.ts:141` (`run_recovery`),
`extension/lifecycle-actions.ts:114,173,225,633` (`before_publish`,
`before_cleanup`, `before_forget`, `before_cancel`).

## 2. `crewHooks` — async side-effect bus

Singleton fire-and-forget bus. Source of truth:
`src/runtime/crew-hooks.ts` (class `HookRegistry`, exported singleton
`crewHooks`).

### Events

5 events only (`src/runtime/crew-hooks.ts:28`):

```
task_started, task_completed, task_failed, run_completed, run_failed
```

### Contract

- `register(type, handler)` — adds a handler to a `Set` per event.
- `emit({ type, ... })` — synchronously invokes every handler; async
  handlers are `.catch()`-ed and **not awaited**. Sync errors are caught
  and logged.
- Listeners cannot block orchestration. They run best-effort after the
  orchestrator has already moved on.

### When to use

- You want to **observe** a transition that has already happened and
  record derived state.
- You are doing async work that must not slow down the run
  (instinct-store appends, skill-effectiveness scoring, telemetry).
- You do not need to block or modify the action.

### Consumers

- `src/state/hook-instinct-bridge.ts` — writes `prefer`/`avoid` instincts
  on task/run completion.
- `src/state/hook-integrations.ts` — light callbacks for the same events.
- `src/runtime/skill-effectiveness.ts` — adjusts skill scores on
  task_completed / task_failed.

### Emitters

`src/runtime/team-runner.ts:1080,1163` (run_completed, run_failed),
`src/runtime/task-runner/child-executor.ts:484` (task_started),
`src/runtime/task-runner/post-execution.ts:355` (task_completed /
task_failed).

## 3. Pi lifecycle hooks — tool/result interception

These are Pi's own extension hooks, wired by pi-crew in
`src/extension/registration/hook-registration.ts`. They run at the
agent/tool-call boundary, not at the orchestration boundary.

### Positions

- `tool_call` — fires before a tool is dispatched; can short-circuit.
- `tool_result` — fires after a tool returns; can inspect/rewrite.
- `resources_discover` — fires when the resource list is queried.

### When to use

- You need to **filter tool arguments** before the tool runs.
- You need to **inspect or rewrite tool results** before the model sees
  them.
- You are extending the agent surface, not the orchestration surface.

## Choosing between the three

```
Need to BLOCK an action?                          → Structured registry (mode:"blocking")
Need to MODIFY run/task context before dispatch?  → Structured registry (outcome:"modify")
Need to RECORD derived state after a transition?  → crewHooks (async side-effect)
Need to FILTER tool args / results?               → Pi lifecycle hooks (tool_call / tool_result)
```

**Rule of thumb:** if your handler must run synchronously and may
prevent the action, use the structured registry. If it can run later
and must never block, use `crewHooks`. If you are touching a tool call
boundary, use the Pi lifecycle hooks.

## Anti-patterns

- **Subscribing to `crewHooks` for decision logic** — the bus does not
  await handlers and cannot block; decisions made there are racy.
- **Registering a `"blocking"` hook for telemetry** — blocking hooks
  slow the orchestrator and can wedge a run if they throw.
- **Adding a fourth event bus** — three is already at the limit of what
  contributors can keep in their heads. If you need a new event, extend
  one of the existing systems rather than introducing a parallel one.
