# 0002 Child-Process for Async Runners

Date: 2026-05-12

## Status

Accepted

## Context

pi-crew supports two runtime modes for task execution:
- `live-session`: in-process, reuses current Pi agent session
- `child-process`: spawns a new Node process via `child-pi.ts`

Async runs (background runner, async runner) start from the current session but
continue after the session ends. Live-session mode requires the parent Pi agent
to be alive — it uses the same in-process tools and session context.

## Decision

Async runners MUST use `child-process` mode. The `live-session` mode is only
available for foreground runs within the current Pi agent session.

Runtime policy enforces: `runtimeResolver` overrides any `live-session` request
to `child-process` when the run is async.

## Alternatives Considered

1. Allow live-session for async. Rejected: crashes when parent session ends, resource leaks.
2. Persist and restore live-session. Rejected: in-process state (timers, handles) cannot be serialized.

## Consequences

Positive:
- Async runs survive session shutdown
- No zombie timers or leaked handles from dead sessions
- Clean process isolation

Tradeoffs:
- Child process startup overhead (~2-5s)
- No shared in-process state between parent and child
- Requires all runtime config to be serializable
